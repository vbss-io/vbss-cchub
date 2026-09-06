import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeSandbox, sandboxEnv, serverDir, startServer, waitFor, type RunningServer } from "./helpers.js";

const box = makeSandbox("cch-mcp-");
let hub: RunningServer;
let mcp: ChildProcess;
let nextId = 1;
const pending = new Map<number, (value: Record<string, unknown>) => void>();

interface ToolResult {
  content: { type: string; text: string }[];
  isError: boolean;
}

function send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    mcp.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const res = await send("tools/call", { name, arguments: args });
  return res.result as ToolResult;
}

const parseText = <T>(result: ToolResult): T => JSON.parse(result.content[0]?.text ?? "null") as T;

before(async () => {
  hub = await startServer(box, { HUB_DELEGATION: "1" });
  await fetch(`${hub.base}/delegation/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspacesRoot: box.root }),
  });
  mcp = spawn(process.execPath, ["--import", "tsx", join(serverDir, "src", "mcp.ts")], {
    cwd: serverDir,
    env: sandboxEnv(box, { HUB_PORT: String(hub.port) }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  mcp.stdout?.setEncoding("utf8");
  mcp.stdout?.on("data", (chunk: string) => {
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
});

describe("mcp server", () => {
  it("negotiates the protocol and lists the hub tools", async () => {
    const init = await send("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const result = init.result as { protocolVersion: string; serverInfo: { name: string }; instructions: string };
    assert.equal(result.protocolVersion, "2025-03-26");
    assert.equal(result.serverInfo.name, "vbss-cchub");
    assert.match(result.instructions, /hub_overview/);
    mcp.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = await send("tools/list");
    const names = (list.result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    for (const name of ["hub_overview", "hub_workspaces", "hub_delegate", "hub_task", "hub_task_events", "hub_continue", "hub_report", "hub_sessions", "hub_session_live", "hub_delete_workspace", "hub_brain_today"]) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
  });

  it("resolves workspaces and repo paths", async () => {
    const result = await callTool("hub_workspaces");
    assert.equal(result.isError, false);
    const workspaces = parseText<{ name: string; repos: { name: string; path: string }[] }[]>(result);
    assert.equal(workspaces[0]?.name, "pilot");
    assert.deepEqual(workspaces[0]?.repos.map((repo) => repo.name), ["repo-a", "repo-b"]);
  });

  it("delegates into a workspace, follows the task and reads the overview", async () => {
    const created = parseText<{ task: { id: string; cwd: string; addDirs: string[] } }>(
      await callTool("hub_delegate", { workspace: "pilot", repo: "repo-b", prompt: "ping from mcp" }),
    );
    assert.equal(created.task.cwd, box.contextDir);
    assert.equal(created.task.addDirs.length, 2);
    const detail = await waitFor(async () => {
      const value = parseText<{ task: { status: string }; runs: { result: string | null }[] }>(
        await callTool("hub_task", { taskId: created.task.id }),
      );
      return ["pending", "running"].includes(value.task.status) ? null : value;
    }, 15000);
    assert.equal(detail.task.status, "completed");
    assert.equal(detail.runs[0]?.result, "handled: ping from mcp");
    const report = await callTool("hub_report", { text: "mcp says hi", kind: "note", taskId: created.task.id, source: "test" });
    assert.equal(report.isError, false);
    const overview = parseText<{ runtimes: Record<string, unknown>; tasks: { recent: { id: string }[] }; reports: { text: string }[] }>(
      await callTool("hub_overview"),
    );
    assert.ok("claudeCode" in overview.runtimes);
    assert.equal(overview.tasks.recent[0]?.id, created.task.id);
    assert.equal(overview.reports[0]?.text, "mcp says hi");
  });

  it("still answers a request when the client closes stdin right after sending it", async () => {
    const oneShot = spawn(process.execPath, ["--import", "tsx", join(serverDir, "src", "mcp.ts")], {
      cwd: serverDir,
      env: sandboxEnv(box, { HUB_PORT: String(hub.port) }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = await new Promise<string>((resolve) => {
      let out = "";
      oneShot.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
      oneShot.on("close", () => resolve(out));
      oneShot.stdin?.end(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "hub_workspaces", arguments: {} } })}\n`);
    });
    const reply = JSON.parse(output.trim().split("\n")[0] ?? "{}") as { id: number; result: ToolResult };
    assert.equal(reply.id, 7);
    assert.equal(parseText<{ name: string }[]>(reply.result)[0]?.name, "pilot");
  });

  it("surfaces tool errors without breaking the stream", async () => {
    const missing = await callTool("hub_delegate", { workspace: "ghost", prompt: "x" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0]?.text ?? "", /available: pilot/);
    const unknown = await send("tools/call", { name: "hub_nope", arguments: {} });
    assert.equal((unknown.error as { code: number }).code, -32602);
    const method = await send("nope/method");
    assert.equal((method.error as { code: number }).code, -32601);
  });
});

after(async () => {
  mcp.stdin?.end();
  mcp.kill();
  hub.child.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
