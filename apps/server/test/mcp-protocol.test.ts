import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeSandbox, sandboxEnv, serverDir, startServer, type RunningServer } from "./helpers.js";

const box = makeSandbox("cch-mcp-proto-");
let hub: RunningServer;
const clients: ChildProcess[] = [];

interface ListedTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

interface McpClient {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function startMcp(extra: Record<string, string> = {}): McpClient {
  const child = spawn(process.execPath, ["--import", "tsx", join(serverDir, "src", "mcp.ts")], {
    cwd: serverDir,
    env: sandboxEnv(box, { HUB_PORT: String(hub.port), ...extra }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  clients.push(child);
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  let nextId = 1;
  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id === "number") pending.get(message.id)?.(message as Record<string, unknown>);
    }
  });
  return {
    send: (method, params) => {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
  };
}

async function handshake(client: McpClient, protocolVersion: string): Promise<{ protocolVersion: string; tools: ListedTool[] }> {
  const init = await client.send("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const list = await client.send("tools/list");
  return { protocolVersion: (init.result as { protocolVersion: string }).protocolVersion, tools: (list.result as { tools: ListedTool[] }).tools };
}

before(async () => {
  hub = await startServer(box, { HUB_DELEGATION: "1" });
  await fetch(`${hub.base}/delegation/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspacesRoot: box.root, features: { daily: true, delegated: true, workspaces: true, reports: true, share: true } }),
  });
});

describe("mcp protocol 2025-11-25", () => {
  it("negotiates 2025-11-25 and lists a title and annotations on every tool of the plugin map", async () => {
    const { protocolVersion, tools } = await handshake(startMcp(), "2025-11-25");
    assert.equal(protocolVersion, "2025-11-25");
    const plugins = (await (await fetch(`${hub.base}/delegation/plugins`)).json()) as { id: string; enabled: boolean; tools: string[] }[];
    const mapped = plugins.filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.tools);
    assert.ok(mapped.length >= 20, `only ${mapped.length} mapped tools`);
    for (const name of mapped) {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool, `missing ${name}`);
      assert.equal(typeof tool.title, "string", name);
      assert.equal(tool.annotations?.title, tool.title, name);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", name);
      assert.equal(typeof tool.annotations?.openWorldHint, "boolean", name);
      if (tool.annotations?.readOnlyHint === false) {
        assert.equal(typeof tool.annotations.destructiveHint, "boolean", name);
        assert.equal(typeof tool.annotations.idempotentHint, "boolean", name);
      }
    }
    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations]));
    for (const name of ["hub_overview", "hub_workspaces", "hub_task", "hub_tasks", "hub_reports", "hub_sessions", "hub_session_live", "hub_task_events", "hub_brain_today", "hub_shares", "hub_share_activity"]) {
      assert.equal(byName.get(name)?.readOnlyHint, true, name);
    }
    for (const name of ["hub_cancel", "hub_task_merge", "hub_delete_workspace", "hub_share_update"]) {
      assert.equal(byName.get(name)?.destructiveHint, true, name);
    }
    assert.deepEqual(byName.get("hub_delegate"), { title: "Delegate a task", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  });

  it("keeps the 2024-11-05 listing unchanged and adds only annotations for 2025-03-26", async () => {
    const old = await handshake(startMcp(), "2024-11-05");
    assert.equal(old.protocolVersion, "2024-11-05");
    for (const tool of old.tools) assert.deepEqual(Object.keys(tool).sort(), ["description", "inputSchema", "name"], tool.name);
    const mid = await handshake(startMcp(), "2025-03-26");
    assert.equal(mid.protocolVersion, "2025-03-26");
    for (const tool of mid.tools) assert.deepEqual(Object.keys(tool).sort(), ["annotations", "description", "inputSchema", "name"], tool.name);
    const june = await handshake(startMcp(), "2025-06-18");
    assert.equal(june.protocolVersion, "2025-06-18");
    assert.ok(june.tools.every((tool) => typeof tool.title === "string"));
  });

  it("answers an unknown version with the latest it supports", async () => {
    assert.equal((await handshake(startMcp(), "2099-01-01")).protocolVersion, "2025-11-25");
  });
});

describe("delegation origin from CLAUDE_CODE_SESSION_ID", () => {
  it("prefers the session id from the MCP environment over the PID guess", async () => {
    await fetch(`${hub.base}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "session_start", sessionId: "pid-guess", claudePid: process.pid, client: "terminal", cwd: box.contextDir }),
    });
    const client = startMcp({ CLAUDE_CODE_SESSION_ID: "env-session-1" });
    await client.send("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const call = await client.send("tools/call", { name: "hub_delegate", arguments: { workspace: "pilot", prompt: "origin from env" } });
    const result = call.result as { content: { text: string }[]; isError: boolean };
    assert.equal(result.isError, false, result.content[0]?.text);
    const created = JSON.parse(result.content[0]?.text ?? "null") as { task: { originSessionId: string | null; originClient: string | null } };
    assert.equal(created.task.originSessionId, "env-session-1");
    assert.equal(created.task.originClient, "claude-code");
  });

  const delegate = async (body: Record<string, unknown>): Promise<{ originSessionId: string | null; originClient: string | null }> => {
    const res = await fetch(`${hub.base}/delegation/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: "pilot", source: "mcp", originPid: 2_000_000_000, ...body }),
    });
    const created = (await res.json()) as { task?: { originSessionId: string | null; originClient: string | null }; error?: string };
    assert.ok(created.task, created.error ?? `status ${res.status}`);
    return created.task;
  };

  it("lets a Codex hint win over a CLAUDE_CODE_SESSION_ID inherited from a Claude shell", async () => {
    const task = await delegate({ prompt: "codex under a claude shell", originClient: "codex", originEnvSessionId: "env-session-3" });
    assert.equal(task.originSessionId, null);
    assert.equal(task.originClient, "codex");
  });

  it("uses the environment session id when the hint is claude-code or absent", async () => {
    const hinted = await delegate({ prompt: "claude hinted", originClient: "claude-code", originEnvSessionId: "env-session-4" });
    assert.equal(hinted.originSessionId, "env-session-4");
    assert.equal(hinted.originClient, "claude-code");
    const bare = await delegate({ prompt: "no hint", originEnvSessionId: "env-session-5" });
    assert.equal(bare.originSessionId, "env-session-5");
    assert.equal(bare.originClient, "claude-code");
  });

  it("falls back to the PID guess without the variable", async () => {
    const client = startMcp();
    await client.send("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const call = await client.send("tools/call", { name: "hub_delegate", arguments: { workspace: "pilot", prompt: "origin from pid" } });
    const created = JSON.parse((call.result as { content: { text: string }[] }).content[0]?.text ?? "null") as { task: { originSessionId: string | null } };
    assert.equal(created.task.originSessionId, "pid-guess");
  });
});

after(async () => {
  for (const child of clients) {
    child.stdin?.end();
    child.kill();
  }
  hub.child.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
