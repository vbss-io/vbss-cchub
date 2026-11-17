import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { serverDir } from "./helpers.js";
import { startFakeHub, type FakeHub, type FakeRequest } from "./helpers/s2-hooks.js";

let hub: FakeHub;

interface ToolResult {
  content: { type: string; text: string }[];
  isError: boolean;
}

interface Rpc {
  id?: number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Session {
  child: ChildProcess;
  send: (method: string, params?: Record<string, unknown>) => Promise<Rpc>;
  raw: (line: string) => Promise<Rpc>;
  notify: (method: string) => void;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  closeInput: () => Promise<number | null>;
}

const CLEAN = ["CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "HUB_TASK_ID", "HUB_URL"];
const sessions = new Set<ChildProcess>();

function startMcp(env: Record<string, string | undefined> = {}, url?: string): Session {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CLEAN) delete childEnv[key];
  childEnv.HUB_URL = url ?? `http://127.0.0.1:${hub.port}`;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  const child = spawn(process.execPath, ["--import", "tsx", join(serverDir, "src", "mcp.ts")], { cwd: serverDir, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  sessions.add(child);
  let buffer = "";
  let nextId = 1;
  const waiting = new Map<number | null, (value: Rpc) => void>();
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line) as Rpc;
      const key = message.id ?? null;
      waiting.get(key)?.(message);
      waiting.delete(key);
    }
  });
  const send = (method: string, params?: Record<string, unknown>): Promise<Rpc> => {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  return {
    child,
    send,
    raw: (line) =>
      new Promise((resolve) => {
        waiting.set(null, resolve);
        child.stdin?.write(`${line}\n`);
      }),
    notify: (method) => {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    call: async (name, args = {}) => ((await send("tools/call", { name, arguments: args })).result as ToolResult),
    closeInput: () =>
      new Promise((resolve) => {
        child.on("close", (code) => resolve(code));
        child.stdin?.end();
      }),
  };
}

before(async () => {
  hub = await startFakeHub();
});

const closeGracefully = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 10_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin?.end();
  });

after(async () => {
  await Promise.all([...sessions].map(closeGracefully));
  await hub.close();
});

const plugins = (states: unknown): void => {
  hub.routes = (request) => (request.path === "/delegation/plugins" ? { body: states } : undefined);
};

const lastOf = (path: string): FakeRequest | undefined => hub.of(path).pop();

describe("protocol", () => {
  it("negotiates versions, lists tools per protocol and answers the housekeeping methods", async () => {
    plugins([]);
    const mcp = startMcp();
    const unsupported = (await mcp.send("initialize", { protocolVersion: "1999-01-01" })).result as { protocolVersion: string; instructions: string };
    assert.equal(unsupported.protocolVersion, "2025-11-25");
    assert.match(unsupported.instructions, /hub_delegate.*hub_report/);
    const full = (await mcp.send("tools/list")).result as { tools: { name: string; title?: string; annotations?: unknown }[] };
    assert.ok(full.tools.length >= 24);
    assert.ok(full.tools.every((tool) => typeof tool.title === "string" && tool.annotations !== undefined));
    const oldest = (await mcp.send("initialize", { protocolVersion: "2024-11-05" })).result as { protocolVersion: string };
    assert.equal(oldest.protocolVersion, "2024-11-05");
    const bare = (await mcp.send("tools/list")).result as { tools: { title?: string; annotations?: unknown }[] };
    assert.ok(bare.tools.every((tool) => tool.title === undefined && tool.annotations === undefined));
    await mcp.send("initialize", { protocolVersion: "2025-03-26" });
    const middle = (await mcp.send("tools/list")).result as { tools: { title?: string; annotations?: unknown }[] };
    assert.ok(middle.tools.every((tool) => tool.title === undefined && tool.annotations !== undefined));
    assert.deepEqual((await mcp.send("ping")).result, {});
    assert.deepEqual((await mcp.send("resources/list")).result, { resources: [] });
    assert.deepEqual((await mcp.send("prompts/list")).result, { prompts: [] });
    const unknown = await mcp.send("sampling/create");
    assert.equal(unknown.error?.code, -32601);
    assert.match(unknown.error?.message ?? "", /method not found: sampling\/create/);
    const parse = await mcp.raw("{ not json");
    assert.equal(parse.error?.code, -32700);
    mcp.notify("notifications/initialized");
    mcp.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 99 })}
`);
    assert.deepEqual((await mcp.send("ping")).result, {});
  });

  it("drains in-flight work and exits when its input closes, also for a last line without a newline", async () => {
    plugins([]);
    const mcp = startMcp();
    mcp.child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }));
    const code = await mcp.closeInput();
    assert.equal(code, 0);
  });
});

describe("plugin awareness", () => {
  it("describes only the tools of enabled plugins", async () => {
    const state = (id: string, name: string, enabled: boolean, tools: string[]) => ({ id, name, enabled, tools });
    plugins([state("delegated", "Delegated", false, ["hub_delegate", "hub_task", "hub_continue"]), state("reports", "Reports", true, ["hub_report", "hub_reports"])]);
    const reportsOnly = startMcp();
    const first = (await reportsOnly.send("initialize", {})).result as { instructions: string };
    assert.match(first.instructions, /^CC Hub is the machine-local hub/);
    assert.match(first.instructions, /Leave a trail with hub_report/);
    assert.doesNotMatch(first.instructions, /hub_delegate/);
    const listed = ((await reportsOnly.send("tools/list")).result as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    assert.ok(!listed.includes("hub_delegate"));
    assert.ok(listed.includes("hub_report"));
    const refused = await reportsOnly.call("hub_delegate", { workspace: "w", prompt: "p" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]?.text ?? "", /The Delegated plugin is off in CC Hub/);

    plugins([state("reports", "Reports", false, ["hub_report"])]);
    const delegateOnly = startMcp();
    const second = (await delegateOnly.send("initialize", {})).result as { instructions: string };
    assert.match(second.instructions, /Delegate long work with hub_delegate \(workspace \+ prompt\), follow it with hub_task and steer it with hub_continue\.$/);

    plugins([state("both", "Both", false, ["hub_delegate", "hub_report"])]);
    const neither = startMcp();
    const third = (await neither.send("initialize", {})).result as { instructions: string };
    assert.doesNotMatch(third.instructions, /Delegate|Leave a trail/);
  });

  it("keeps every tool when the plugin list is unusable", async () => {
    for (const answer of [{ status: 500 }, { body: { not: "a list" } }, { body: [{ id: 1 }] }, { raw: "garbage" }, { destroy: true }, { body: [{ id: "a", name: "A", enabled: true, tools: "x" }] }, { body: [null] }]) {
      hub.routes = (request) => (request.path === "/delegation/plugins" ? answer : undefined);
      const mcp = startMcp();
      const listed = (await mcp.send("tools/list")).result as { tools: unknown[] };
      assert.ok(listed.tools.length >= 24, JSON.stringify(answer));
      await closeGracefully(mcp.child);
    }
  });
});

describe("tool calls", () => {
  const exercised: [string, Record<string, unknown>, string, string][] = [
    ["hub_overview", {}, "GET", "/delegation/overview"],
    ["hub_workspaces", {}, "GET", "/delegation/workspaces"],
    ["hub_delegate", { workspace: "w", prompt: "p", runner: "codex" }, "POST", "/delegation/tasks"],
    ["hub_task", { taskId: "abc12345" }, "GET", "/delegation/tasks/abc12345"],
    ["hub_tasks", { status: "running", limit: 5 }, "GET", "/delegation/tasks"],
    ["hub_tasks", {}, "GET", "/delegation/tasks"],
    ["hub_continue", { taskId: "abc12345", prompt: "more", model: "m" }, "POST", "/delegation/tasks/abc12345/continue"],
    ["hub_cancel", { taskId: "abc12345" }, "POST", "/delegation/tasks/abc12345/cancel"],
    ["hub_task_archive", { taskId: "abc12345" }, "POST", "/delegation/tasks/abc12345/archive"],
    ["hub_task_archive", { taskId: "abc12345", unarchive: true }, "POST", "/delegation/tasks/abc12345/unarchive"],
    ["hub_task_merge", { taskId: "abc12345" }, "POST", "/delegation/tasks/abc12345/merge"],
    ["hub_task_merge", { taskId: "abc12345", discard: true }, "POST", "/delegation/tasks/abc12345/worktree/discard"],
    ["hub_report", { text: "done", kind: "result", taskId: "abc12345" }, "POST", "/delegation/reports"],
    ["hub_reports", { taskId: "abc12345", limit: 3 }, "GET", "/delegation/reports"],
    ["hub_open_workspace", { workspace: "my ws" }, "POST", "/delegation/workspaces/my%20ws/open"],
    ["hub_create_workspace", { name: "new", repos: ["C:/r"] }, "POST", "/delegation/workspaces"],
    ["hub_session_live", { sessionId: "s1", limit: 10 }, "GET", "/api/sessions/s1/live"],
    ["hub_task_events", { taskId: "abc12345" }, "GET", "/delegation/tasks/abc12345/events"],
    ["hub_delete_workspace", { workspace: "old", deleteContext: true }, "DELETE", "/delegation/workspaces/old"],
    ["hub_delete_workspace", { workspace: "old" }, "DELETE", "/delegation/workspaces/old"],
    ["hub_brain_today", {}, "GET", "/delegation/brain/today"],
    ["hub_shares", {}, "GET", "/delegation/shares"],
    ["hub_share_create", { workspace: "w", expiresInHours: 0 }, "POST", "/delegation/shares"],
    ["hub_share_create", { workspace: "w", expiresInHours: 4 }, "POST", "/delegation/shares"],
    ["hub_share_update", { shareId: "sh 1", paused: true }, "PATCH", "/delegation/shares/sh%201"],
    ["hub_share_activity", { limit: 7 }, "GET", "/delegation/shares/activity"],
    ["hub_claim", { workspace: "w", repo: "r", paths: ["a.ts"] }, "POST", "/api/claims"],
    ["hub_claim", { release: true, claimId: "c1" }, "DELETE", "/api/claims/c1"],
    ["hub_tunnel", {}, "GET", "/delegation/tunnel"],
    ["hub_tunnel", { action: "start" }, "POST", "/delegation/tunnel/start"],
    ["hub_tunnel", { action: "stop" }, "POST", "/delegation/tunnel/stop"],
  ];

  it("forwards every tool to the matching hub route", async () => {
    plugins([]);
    hub.routes = (request) => (request.path === "/delegation/plugins" ? { body: [] } : { body: { ok: true, echoed: request.path } });
    const mcp = startMcp();
    for (const [name, args, method, path] of exercised) {
      const before = hub.requests.length;
      const result = await mcp.call(name, args);
      assert.equal(result.isError, false, `${name}: ${result.content[0]?.text}`);
      const sent = hub.requests.slice(before).find((request) => request.path === path);
      assert.ok(sent, `${name} reached ${path}`);
      assert.equal(sent.method, method, name);
    }
    const sessions = await mcp.call("hub_sessions");
    assert.equal(sessions.isError, false);
    assert.deepEqual(Object.keys(JSON.parse(sessions.content[0]?.text ?? "{}")), ["claudeCode", "codex"]);
    const focus = await mcp.call("hub_focus", { sessionId: "s 2" });
    assert.equal(focus.isError, false);
    assert.equal(lastOf("/api/sessions/s%202/focus")?.method, "POST");
    assert.equal(lastOf("/delegation/tasks")?.query.get("status"), null);
    const tasks = hub.of("/delegation/tasks").filter((request) => request.method === "GET");
    assert.equal(tasks[0]?.query.get("status"), "running");
    assert.equal(tasks[0]?.query.get("limit"), "5");
    const created = hub.of("/delegation/shares").filter((request) => request.method === "POST");
    assert.equal(created[0]?.body?.expiresInHours, null);
    assert.equal(created[1]?.body?.expiresInHours, 4);
    assert.equal(hub.of("/delegation/workspaces/old")[0]?.query.get("context"), "1");
    assert.equal(hub.of("/delegation/workspaces/old")[1]?.query.get("context"), null);
  });

  it("explains missing arguments and unknown tools", async () => {
    hub.routes = (request) => (request.path === "/delegation/plugins" ? { body: [] } : { body: {} });
    const mcp = startMcp();
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["hub_task", {}, /taskId is required/],
      ["hub_focus", {}, /sessionId is required/],
      ["hub_open_workspace", {}, /workspace is required/],
      ["hub_session_live", {}, /sessionId is required/],
      ["hub_delete_workspace", {}, /workspace is required/],
      ["hub_claim", { release: true }, /claimId is required to release a claim/],
    ];
    for (const [name, args, message] of cases) {
      const result = await mcp.call(name, args);
      assert.equal(result.isError, true, name);
      assert.match(result.content[0]?.text ?? "", message);
    }
    const unknown = await mcp.send("tools/call", { name: "hub_nope", arguments: {} });
    assert.equal(unknown.error?.code, -32602);
    assert.match(unknown.error?.message ?? "", /unknown tool: hub_nope/);
    const nameless = await mcp.send("tools/call", {});
    assert.match(nameless.error?.message ?? "", /unknown tool: \(none\)/);
    const noArgs = await mcp.send("tools/call", { name: "hub_overview", arguments: "bad" });
    assert.equal((noArgs.result as ToolResult).isError, false);
  });

  it("reports hub failures as tool errors", async () => {
    const mcp = startMcp();
    hub.routes = (request) => (request.path === "/delegation/plugins" ? { body: [] } : { status: 409, body: { error: "already running" } });
    const conflict = await mcp.call("hub_cancel", { taskId: "t" });
    assert.equal(conflict.isError, true);
    assert.equal(conflict.content[0]?.text, "already running");
    hub.routes = (request) => (request.path === "/delegation/plugins" ? { body: [] } : { status: 502, body: null });
    const bare = await mcp.call("hub_cancel", { taskId: "t" });
    assert.equal(bare.content[0]?.text, "HTTP 502");
    hub.routes = (request) => (request.path === "/delegation/plugins" ? { body: [] } : { raw: "" });
    const empty = await mcp.call("hub_overview");
    assert.equal(empty.content[0]?.text, "null");
    hub.routes = (request) => (request.path === "/delegation/plugins" ? { body: [] } : { raw: "<html>" });
    const html = await mcp.call("hub_overview");
    assert.equal(html.isError, true);
    hub.routes = (request) => (request.path === "/delegation/plugins" ? { body: [] } : { body: "x".repeat(100_000) });
    const big = await mcp.call("hub_overview");
    assert.equal(big.isError, false);
    assert.ok(big.content[0]?.text.endsWith("…(truncated)"));
    assert.ok((big.content[0]?.text.length ?? 0) < 90_000);
  });

  it("says so when the hub cannot be reached", async () => {
    const dead = startMcp({}, "http://127.0.0.1:1/");
    const result = await dead.call("hub_overview");
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /hub unreachable at http:\/\/127\.0\.0\.1:1: /);
  });
});

describe("origin of delegated work", () => {
  it("tags a Claude Code caller with its session and a Codex caller with its sandbox", async () => {
    hub.routes = (request) => (request.path === "/delegation/plugins" ? { body: [] } : { body: {} });
    const claude = startMcp({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "claude-session-1", HUB_TASK_ID: "task-from-env" });
    await claude.call("hub_delegate", { workspace: "w", prompt: "p" });
    const fromClaude = hub.of("/delegation/tasks").filter((request) => request.method === "POST").pop()?.body;
    assert.equal(fromClaude?.originClient, "claude-code");
    assert.equal(fromClaude?.originEnvSessionId, "claude-session-1");
    assert.equal(fromClaude?.source, "mcp");
    assert.ok(typeof fromClaude?.originPid === "number");
    await claude.call("hub_report", { text: "from env task" });
    assert.equal(lastOf("/delegation/reports")?.body?.taskId, "task-from-env");
    await claude.call("hub_report", { text: "explicit", taskId: "explicit-task" });
    assert.equal(lastOf("/delegation/reports")?.body?.taskId, "explicit-task");

    const entry = startMcp({ CLAUDE_CODE_ENTRYPOINT: "cli" });
    await entry.call("hub_continue", { taskId: "t1", prompt: "p" });
    const fromEntry = lastOf("/delegation/tasks/t1/continue")?.body;
    assert.equal(fromEntry?.originClient, "claude-code");
    assert.equal(fromEntry?.originEnvSessionId, undefined);

    const codex = startMcp({ CODEX_SANDBOX: "seatbelt", CLAUDE_CODE_SESSION_ID: "ignored" });
    await codex.call("hub_delegate", { workspace: "w", prompt: "p" });
    const fromCodex = hub.of("/delegation/tasks").filter((request) => request.method === "POST").pop()?.body;
    assert.equal(fromCodex?.originClient, "codex");
    assert.equal(fromCodex?.originEnvSessionId, undefined);

    const codexNetwork = startMcp({ CODEX_SANDBOX_NETWORK_DISABLED: "1" });
    await codexNetwork.call("hub_claim", { workspace: "w", repo: "r", paths: ["a"] });
    assert.equal(lastOf("/api/claims")?.body?.originClient, "codex");

    const plain = startMcp();
    await plain.call("hub_delegate", { workspace: "w", prompt: "p" });
    const fromPlain = hub.of("/delegation/tasks").filter((request) => request.method === "POST").pop()?.body;
    assert.equal(fromPlain?.originClient, undefined);
  });
});
