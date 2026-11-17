import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fixtures } from "./helpers.js";
import { s1Listen, s1Request, s1Sandbox, s1Wait, type S1Listening } from "./helpers/s1-env.js";

const box = s1Sandbox("cch-s1-app-", { HUB_DELEGATION: "1" });

const { createApp, jsonErrors, hubOptionsFrom, defaultAppDeps, processRuntime } = await import("../src/app.js");
const { onBroadcast } = await import("../src/sse.js");
const { createDesktopNotifier } = await import("../src/desktop-notify.js");
const { applyHook, listClaims, createClaim, getSession, db } = await import("../src/db.js");
const { updateSettings } = await import("../src/delegation-store.js");

type AppDeps = typeof defaultAppDeps;
type Snapshot = Awaited<ReturnType<AppDeps["runtimeSnapshot"]>>;

const events: { event: string; data: unknown }[] = [];
onBroadcast((event, data) => {
  events.push({ event, data });
});
const eventsOf = (name: string): unknown[] => events.filter((item) => item.event === name).map((item) => item.data);

const SAMPLE_THREAD = "01a0aaaa-0000-7000-8000-000000000001";
const CLI_THREAD = "01a0aaaa-0000-7000-8000-0000000000c1";
const transcript = join(fixtures, "transcript-sample.jsonl");

function writeCliRollout(): void {
  const now = new Date();
  const day = join(box.codexHome, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  const sample = readFileSync(join(day, "rollout-sample.jsonl"), "utf8");
  const cli = sample.split(SAMPLE_THREAD).join(CLI_THREAD).replace(/"originator":"[^"]+"/g, '"originator":"codex_cli_rs"').replace(/"source":"vscode"/g, '"source":"cli"');
  writeFileSync(join(day, "rollout-cli.jsonl"), cli);
}

function snapshot(pids: number[]): Snapshot {
  const group = { running: pids.length > 0, count: pids.length, pids };
  return {
    claudeCode: { running: false, count: 0, pids: [], headless: 0 },
    claudeDesktop: { running: false, count: 0, pids: [] },
    codexApp: group,
    codexCli: { running: false, count: 0, pids: [] },
    scannedAt: 1,
    error: null,
  };
}

const calls = {
  focus: [] as { hostPid: number | null; cwd: string | null }[],
  opened: [] as string[],
  hooks: [] as string[],
  shown: [] as { title: string; body: string }[],
};
let codexPids: number[] = [];
let focusOk = false;
let notifyOk = true;

const fakeDeps: AppDeps = {
  notifier: {
    status: async (force = false) => ({ supported: true, appId: force ? "forced" : "cached", toastsEnabled: true, appEnabled: true, registered: true, error: null }),
    show: async (title, body) => {
      calls.shown.push({ title, body });
      return notifyOk ? { ok: true, via: "windows-toast", reason: null } : { ok: false, via: null, reason: "toasts off" };
    },
    observe: createDesktopNotifier(async () => "", "linux").observe,
  },
  focusWindow: async (hostPid, cwd) => {
    calls.focus.push({ hostPid, cwd });
    return focusOk ? { ok: true } : { ok: false, reason: "window not found (session closed?)" };
  },
  openUrl: async (url) => {
    calls.opened.push(url);
    return { ok: true, url };
  },
  runtimeSnapshot: async () => snapshot(codexPids),
  windowsHooks: async (action) => {
    calls.hooks.push(`windows:${action}`);
    return { installed: action !== "uninstall", outdated: false };
  },
  wslHooks: async (action) => {
    calls.hooks.push(`wsl:${action}`);
    return [{ distro: "Ubuntu", installed: action !== "uninstall" }];
  },
};

const staticDir = join(box.tmp, "static");
mkdirSync(join(staticDir, "api"), { recursive: true });
writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>hub ui</title>");
writeFileSync(join(staticDir, "api", "health"), "static shadow");
writeFileSync(join(staticDir, "app.js"), "console.log('ui');");

let web: S1Listening;
let preview: S1Listening;
let seeded: S1Listening;

before(async () => {
  mkdirSync(box.dataDir, { recursive: true });
  writeCliRollout();
  web = await s1Listen(createApp({ dataDir: box.dataDir, staticDir, previewMode: false, devSeed: false }, fakeDeps));
  preview = await s1Listen(createApp({ dataDir: box.dataDir, staticDir: join(box.tmp, "missing-static"), previewMode: true, devSeed: false }, fakeDeps));
  seeded = await s1Listen(createApp({ dataDir: box.dataDir, staticDir: null, previewMode: false, devSeed: true }, fakeDeps));
});

after(async () => {
  await Promise.all([web.close(), preview.close(), seeded.close()]);
  db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const http = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => s1Request(web.base, method, path, body, headers);

describe("hubOptionsFrom", () => {
  const source = {
    host: "127.0.0.1",
    port: 4999,
    shareHost: "0.0.0.0",
    sharePort: 4998,
    dataDir: "D:/data",
    staticDir: null,
    previewMode: false,
    delegationEnabled: true,
    emptyTtlMs: 5,
  };

  it("maps the config and reads the dev seed and parent pid from the environment", () => {
    const options = hubOptionsFrom(source, "9.9.9", { HUB_DEV_SEED: "1", HUB_PARENT_PID: "4242" });
    assert.deepEqual(options, { ...source, devSeed: true, parentPid: 4242, appVersion: "9.9.9" });
  });

  it("ignores a missing, negative or fractional parent pid", () => {
    assert.equal(hubOptionsFrom(source, "1", {}).parentPid, null);
    assert.equal(hubOptionsFrom(source, "1", { HUB_PARENT_PID: "-3" }).parentPid, null);
    assert.equal(hubOptionsFrom(source, "1", { HUB_PARENT_PID: "1.5" }).parentPid, null);
    assert.equal(hubOptionsFrom(source, "1", { HUB_DEV_SEED: "0" }).devSeed, false);
  });

  it("probes a live pid without throwing and registers signal handlers on the process", () => {
    assert.doesNotThrow(() => processRuntime.probe(process.pid));
    const handler = (): void => undefined;
    processRuntime.onSignal("SIGTERM", handler);
    assert.ok(process.listeners("SIGTERM").includes(handler));
    process.removeListener("SIGTERM", handler);
  });
});

describe("jsonErrors", () => {
  const capture = () => {
    const out: { status: number; body: unknown } = { status: 0, body: null };
    const res = {
      status(code: number) {
        out.status = code;
        return this;
      },
      json(body: unknown) {
        out.body = body;
        return this;
      },
    };
    return { out, res };
  };

  it("uses the error status and message", () => {
    const { out, res } = capture();
    const err = Object.assign(new Error("too large"), { status: 413 });
    jsonErrors(err, {} as never, res as never, () => undefined);
    assert.deepEqual(out, { status: 413, body: { error: "too large" } });
  });

  it("falls back to 500 and a generic message for non errors", () => {
    const { out, res } = capture();
    jsonErrors("boom", {} as never, res as never, () => undefined);
    assert.deepEqual(out, { status: 500, body: { error: "request failed" } });
  });
});

describe("mount order and middleware", () => {
  it("answers API routes before the static folder and serves the UI after them", async () => {
    const health = await http("GET", "/api/health");
    assert.equal(health.status, 200);
    assert.equal((health.json as { ok: boolean }).ok, true);
    assert.equal(typeof (health.json as { hostname: string }).hostname, "string");
    const index = await http("GET", "/");
    assert.equal(index.status, 200);
    assert.match(index.text, /hub ui/);
    const script = await http("GET", "/app.js");
    assert.match(script.text, /console\.log/);
  });

  it("sends CORS headers and turns malformed JSON into a JSON error", async () => {
    const res = await http("POST", "/api/groups", "{not json", { origin: "http://example.test" });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(typeof (res.json as { error: string }).error, "string");
  });

  it("serves no static files when the static folder is missing", async () => {
    const res = await s1Request(preview.base, "GET", "/app.js");
    assert.equal(res.status, 404);
  });

  it("mounts the plugin routes and the permissions router", async () => {
    const plugins = await http("GET", "/delegation/plugins");
    assert.equal(plugins.status, 200);
    assert.ok((plugins.json as { id: string }[]).some((plugin) => plugin.id === "core"));
    const permissions = await http("GET", "/api/permissions");
    assert.equal(permissions.status, 200);
    assert.ok(Array.isArray(permissions.json));
  });

  it("streams server-sent events with a ready event first", async () => {
    const controller = new AbortController();
    const res = await fetch(`${web.base}/api/events`, { signal: controller.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: ready/);
    const clients = await http("GET", "/api/sse/clients");
    assert.ok((clients.json as { count: number }).count >= 1);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});

describe("POST /hook", () => {
  it("rejects payloads without a known kind or a session id", async () => {
    assert.equal((await http("POST", "/hook", { kind: "nope", sessionId: "x" })).status, 400);
    assert.equal((await http("POST", "/hook", { kind: "session_start" })).status, 400);
  });

  it("records a session from a hook and lists it", async () => {
    const res = await http("POST", "/hook", {
      kind: "session_start",
      sessionId: "s1-hook-a",
      cwd: box.repoA,
      source: "terminal",
      hostPid: 0,
      shellPid: 0,
      title: "first",
      message: "hello",
      model: "opus",
      tokensIn: 3,
      tokensOut: 4,
      contextTokens: 5,
      client: "terminal",
      transcriptPath: transcript,
      updatedAt: 1000,
    });
    assert.equal(res.status, 200);
    const session = res.json as { sessionId: string; updatedAt: number };
    assert.equal(session.sessionId, "s1-hook-a");
    assert.notEqual(session.updatedAt, 1000);
    const list = (await http("GET", "/api/sessions")).json as { sessionId: string }[];
    assert.ok(list.some((item) => item.sessionId === "s1-hook-a"));
    assert.ok(eventsOf("session").some((data) => (data as { sessionId: string }).sessionId === "s1-hook-a"));
  });

  it("uses the seeded timestamp only in dev seed mode", async () => {
    const res = await s1Request(seeded.base, "POST", "/hook", { kind: "session_start", sessionId: "s1-hook-seeded", updatedAt: 1234 });
    assert.equal((res.json as { updatedAt: number }).updatedAt, 1234);
  });

  it("applies meta to a known session and creates an unknown one", async () => {
    const known = await http("POST", "/hook", { kind: "meta", sessionId: "s1-hook-a", title: "renamed by meta" });
    assert.equal((known.json as { sessionId: string }).sessionId, "s1-hook-a");
    const unknown = await http("POST", "/hook", { kind: "meta", sessionId: "s1-hook-meta-new", title: "meta new" });
    assert.equal((unknown.json as { sessionId: string }).sessionId, "s1-hook-meta-new");
  });

  it("answers tool_done with ok for unknown or busy sessions and resumes a waiting one", async () => {
    const unknown = await http("POST", "/hook", { kind: "tool_done", sessionId: "s1-hook-nobody", toolName: "Bash" });
    assert.deepEqual(unknown.json, { ok: true });
    await http("POST", "/hook", { kind: "user_prompt", sessionId: "s1-hook-tool" });
    const busy = await http("POST", "/hook", { kind: "tool_done", sessionId: "s1-hook-tool", toolName: "Bash" });
    assert.equal((busy.json as { status: string }).status, "active");
    await http("POST", "/hook", { kind: "permission_request", sessionId: "s1-hook-tool", message: "allow?" });
    assert.equal(getSession("s1-hook-tool")?.status, "waiting");
    const resumed = await http("POST", "/hook", { kind: "tool_done", sessionId: "s1-hook-tool", toolName: "Bash", toolInput: { command: "ls" } });
    assert.equal((resumed.json as { status: string }).status, "active");
  });

  it("releases the claims of a session that ends", async () => {
    await http("POST", "/hook", { kind: "session_start", sessionId: "s1-hook-end" });
    createClaim({ sessionId: "s1-hook-end", repoPath: box.repoA, paths: ["a.ts"], note: null, ttlMs: null });
    assert.ok(listClaims().some((claim) => claim.sessionId === "s1-hook-end"));
    const before = eventsOf("claims").length;
    await http("POST", "/hook", { kind: "session_end", sessionId: "s1-hook-end", transcriptPath: transcript });
    assert.ok(!listClaims().some((claim) => claim.sessionId === "s1-hook-end"));
    assert.equal(eventsOf("claims").length, before + 1);
    const quiet = eventsOf("claims").length;
    await http("POST", "/hook", { kind: "session_end", sessionId: "s1-hook-end" });
    assert.equal(eventsOf("claims").length, quiet);
  });

  it("skips the trail for a hub run that stops", async () => {
    const res = await http("POST", "/hook", { kind: "stop", sessionId: "s1-hook-hubrun", client: "hub", transcriptPath: transcript });
    assert.equal(res.status, 200);
    const plain = await http("POST", "/hook", { kind: "stop", sessionId: "s1-hook-plain", transcriptPath: transcript });
    assert.equal((plain.json as { status: string }).status, "idle");
  });
});

describe("POST /hook/raw", () => {
  it("rejects unknown events and payloads without a session id", async () => {
    assert.equal((await http("POST", "/hook/raw", { hook_event_name: "Nope", session_id: "x" })).status, 400);
    assert.equal((await http("POST", "/hook/raw", { hook_event_name: "Stop" })).status, 400);
  });

  it("reads the transcript and names the session from it", async () => {
    const res = await http("POST", "/hook/raw", { hook_event_name: "UserPromptSubmit", session_id: "s1-raw-a", cwd: box.repoA, transcript_path: transcript, share_label: "label-a" });
    const session = res.json as { sessionId: string; client: string; title: string | null; transcriptPath: string };
    assert.equal(session.sessionId, "s1-raw-a");
    assert.equal(session.client, "terminal");
    assert.equal(session.transcriptPath, transcript);
  });

  it("maps a WSL source to a UNC transcript path and the wsl client", async () => {
    const res = await http("POST", "/hook/raw?source=wsl-Ubuntu", { hook_event_name: "SessionStart", session_id: "s1-raw-wsl", transcript_path: "/home/me/.claude/projects/x/s1.jsonl" });
    assert.equal((res.json as { client: string }).client, "wsl");
    const plain = await http("POST", "/hook/raw?source=wsl", { hook_event_name: "Notification", session_id: "s1-raw-wsl2", transcript_path: "C:/nowhere/s1.jsonl", message: "note" });
    assert.equal((plain.json as { lastMessage: string }).lastMessage, "note");
  });

  it("builds messages for permission requests and failures", async () => {
    const permission = await http("POST", "/hook/raw", { hook_event_name: "PermissionRequest", session_id: "s1-raw-perm", tool_name: "Bash" });
    assert.equal((permission.json as { lastMessage: string }).lastMessage, "Claude needs your permission to use Bash");
    const anonymous = await http("POST", "/hook/raw", { hook_event_name: "PermissionRequest", session_id: "s1-raw-perm2" });
    assert.equal((anonymous.json as { status: string }).status, "waiting");
    const failure = await http("POST", "/hook/raw", { hook_event_name: "StopFailure", session_id: "s1-raw-fail", error_details: "rate limited" });
    assert.equal((failure.json as { lastMessage: string }).lastMessage, "rate limited");
    const failureError = await http("POST", "/hook/raw", { hook_event_name: "StopFailure", session_id: "s1-raw-fail2", error: "overloaded" });
    assert.equal((failureError.json as { lastMessage: string }).lastMessage, "overloaded");
    const stop = await http("POST", "/hook/raw", { hook_event_name: "Stop", session_id: "s1-raw-fail3", last_assistant_message: "all done", transcript_path: transcript });
    assert.equal((stop.json as { lastMessage: string }).lastMessage, "all done");
  });

  it("tracks subagents and handles tool completion", async () => {
    await http("POST", "/hook/raw", { hook_event_name: "UserPromptSubmit", session_id: "s1-raw-sub" });
    const sub = await http("POST", "/hook/raw", { hook_event_name: "SubagentStart", session_id: "s1-raw-sub", agent_id: "agent-1", agent_type: "Explore", last_assistant_message: "exploring" });
    assert.equal(sub.status, 200);
    const done = await http("POST", "/hook/raw", { hook_event_name: "PostToolUse", session_id: "s1-raw-sub", tool_name: "Read", tool_input: { file_path: "x" } });
    assert.equal((done.json as { sessionId: string }).sessionId, "s1-raw-sub");
    const failedTool = await http("POST", "/hook/raw", { hook_event_name: "PostToolUseFailure", session_id: "s1-raw-none" });
    assert.deepEqual(failedTool.json, { ok: true });
    const agents = (await http("GET", "/api/sessions/s1-raw-sub/agents")).json as { agentId: string }[];
    assert.ok(agents.some((agent) => agent.agentId === "agent-1"));
  });
});

describe("session routes", () => {
  it("lists asks and live data in every mode", async () => {
    const asks = (await http("GET", "/api/sessions/s1-raw-sub/asks?limit=5")).json as { forks: unknown[]; asks: unknown[] };
    assert.deepEqual(asks, { forks: [], asks: [] });
    const full = await http("GET", "/api/sessions/s1-hook-a/live");
    assert.equal((full.json as { session: { sessionId: string } }).session.sessionId, "s1-hook-a");
    const summary = await http("GET", "/api/sessions/s1-raw-sub/live?subagents=summary");
    assert.equal((summary.json as { agentCounts: { total: number } }).agentCounts.total, 1);
    const agent = await http("GET", "/api/sessions/s1-raw-sub/live?subagent=agent-1");
    assert.equal((agent.json as { agent: { agentId: string } }).agent.agentId, "agent-1");
    assert.equal((await http("GET", "/api/sessions/s1-raw-sub/live?subagent=ghost")).status, 404);
    assert.equal((await http("GET", "/api/sessions/nobody/live?subagent=ghost")).status, 404);
    assert.equal((await http("GET", "/api/sessions/nobody/live")).status, 404);
    assert.equal((await http("GET", "/api/sessions/nobody/live?subagents=summary")).status, 404);
  });

  it("renames, marks seen, archives, favorites and deletes sessions", async () => {
    assert.equal((await http("PATCH", "/api/sessions/nobody", { title: "x" })).status, 404);
    const renamed = await http("PATCH", "/api/sessions/s1-hook-a", { title: "custom" });
    assert.equal((renamed.json as { customTitle: string }).customTitle, "custom");
    await http("PATCH", "/api/sessions/s1-hook-a", { title: 5 });
    assert.equal((await http("POST", "/api/sessions/nobody/seen")).status, 404);
    assert.equal(((await http("POST", "/api/sessions/s1-hook-a/seen")).json as { ok: boolean }).ok, true);
    assert.equal((await http("POST", "/api/sessions/nobody/archive")).status, 404);
    assert.notEqual(((await http("POST", "/api/sessions/s1-hook-meta-new/archive")).json as { archivedAt: number | null }).archivedAt, null);
    assert.equal((await http("POST", "/api/sessions/nobody/favorite", { favorite: true })).status, 404);
    assert.notEqual(((await http("POST", "/api/sessions/s1-hook-a/favorite", { favorite: true })).json as { favoriteAt: number | null }).favoriteAt, null);
    assert.deepEqual((await http("DELETE", "/api/sessions/s1-raw-wsl2")).json, { ok: true });
    assert.deepEqual((await http("DELETE", "/api/sessions/s1-raw-wsl2")).json, { ok: false });
    assert.ok(eventsOf("removed").some((data) => (data as { sessionId: string }).sessionId === "s1-raw-wsl2"));
  });

  it("focuses a session window and falls back to the deep link for a VS Code panel", async () => {
    assert.equal((await http("POST", "/api/sessions/nobody/focus")).status, 404);
    await http("POST", "/hook", { kind: "session_start", sessionId: "s1-vscode", client: "vscode", cwd: box.repoA, hostPid: 77 });
    focusOk = false;
    const fallback = await http("POST", "/api/sessions/s1-vscode/focus");
    assert.equal((fallback.json as { method: string }).method, "deep-link");
    assert.ok(calls.opened.includes("vscode://anthropic.claude-code/open?session=s1-vscode"));
    await http("POST", "/hook", { kind: "session_start", sessionId: "s1-shell", client: "terminal", shellPid: 88, hostPid: 66 });
    const terminal = await http("POST", "/api/sessions/s1-shell/focus");
    assert.deepEqual(terminal.json, { ok: false, reason: "window not found (session closed?)" });
    assert.ok(eventsOf("focus-terminal").some((data) => (data as { shellPid: number }).shellPid === 88));
    focusOk = true;
    assert.deepEqual((await http("POST", "/api/sessions/s1-vscode/focus")).json, { ok: true });
    assert.deepEqual(calls.focus.at(-1), { hostPid: 77, cwd: box.repoA });
  });

  it("opens a session by deep link for panels and by focus for terminals", async () => {
    assert.equal((await http("POST", "/api/sessions/nobody/open")).status, 404);
    const panel = await http("POST", "/api/sessions/s1-vscode/open");
    assert.equal((panel.json as { method: string; focused: boolean }).method, "deep-link");
    assert.equal((panel.json as { focused: boolean }).focused, true);
    const terminal = await http("POST", "/api/sessions/s1-shell/open");
    assert.deepEqual(terminal.json, { ok: true, method: "focus" });
    const plain = await http("POST", "/api/sessions/s1-hook-a/open");
    assert.equal((plain.json as { method: string }).method, "focus");
  });
});

describe("ui, toast and notification routes", () => {
  it("broadcasts navigation with a safe hash", async () => {
    assert.equal((await http("POST", "/api/ui/navigate", { hash: "#/tasks" })).status, 204);
    await http("POST", "/api/ui/navigate", { hash: "javascript:alert(1)" });
    assert.deepEqual(eventsOf("ui-navigate").slice(-2), [{ hash: "#/tasks" }, { hash: "#/sessions" }]);
  });

  it("validates and broadcasts toasts", async () => {
    assert.equal((await http("POST", "/api/toast", { kind: "nope", id: "1", title: "t" })).status, 400);
    assert.equal((await http("POST", "/api/toast", { kind: "taskFailed", id: "", title: "t" })).status, 400);
    assert.equal((await http("POST", "/api/toast", { kind: "taskFailed", id: "1", title: "  " })).status, 400);
    assert.equal((await http("POST", "/api/toast", { kind: "taskFailed", id: "t1", title: " Failed ", body: "details" })).status, 204);
    await http("POST", "/api/toast", { kind: "shareAsk", id: "t2", title: "Ask" });
    const toasts = eventsOf("toast") as { kind: string; title: string; body: string }[];
    assert.deepEqual(toasts.slice(-2).map(({ kind, title, body }) => ({ kind, title, body })), [
      { kind: "taskFailed", title: "Failed", body: "details" },
      { kind: "shareAsk", title: "Ask", body: "" },
    ]);
  });

  it("merges ui diagnostics per window", async () => {
    await http("POST", "/api/ui/diag", { window: "main", sse: "open" });
    await http("POST", "/api/ui/diag", { window: "main", view: "board" });
    await http("POST", "/api/ui/diag", { view: "lonely" });
    const diag = (await http("GET", "/api/ui/diag")).json as { windows: Record<string, Record<string, unknown>>; sseClients: number };
    assert.equal(diag.windows.main?.sse, "open");
    assert.equal(diag.windows.main?.view, "board");
    assert.equal(diag.windows.unknown?.view, "lonely");
    assert.equal(typeof diag.sseClients, "number");
  });

  it("reports the notifier status and shows desktop notifications", async () => {
    assert.equal(((await http("GET", "/api/notify/status?force=1")).json as { appId: string }).appId, "forced");
    assert.equal(((await http("GET", "/api/notify/status")).json as { appId: string }).appId, "cached");
    notifyOk = true;
    assert.equal((await http("POST", "/api/notify", { title: " Hello ", body: "world", subject: { kind: "taskFailed", id: "t1" } })).status, 200);
    notifyOk = false;
    assert.equal((await http("POST", "/api/notify", {})).status, 501);
    assert.deepEqual(calls.shown.slice(-2), [
      { title: "Hello", body: "world" },
      { title: "VBSS CCHUB", body: "" },
    ]);
  });

  it("logs ui errors and returns the latest ones", async () => {
    rmSync(join(box.dataDir, "ui-errors.log"), { force: true });
    assert.deepEqual((await http("GET", "/api/ui-errors")).json, []);
    await http("POST", "/api/ui-error", { view: "board", message: "boom", stack: "at x", componentStack: "in Board" });
    await http("POST", "/api/ui-error", {});
    const errors = (await http("GET", "/api/ui-errors?limit=1")).json as { view: string; message: string }[];
    assert.equal(errors.length, 1);
    assert.deepEqual({ view: errors[0]?.view, message: errors[0]?.message }, { view: "unknown", message: "" });
    assert.ok(existsSync(join(box.dataDir, "ui-errors.log")));
  });

  it("returns the runtime snapshot", async () => {
    codexPids = [];
    assert.equal(((await http("GET", "/api/runtimes")).json as { scannedAt: number }).scannedAt, 1);
  });
});

describe("codex routes", () => {
  it("lists codex threads and focuses the Codex app only when it runs", async () => {
    const sessions = (await http("GET", "/api/codex/sessions")).json as { id: string }[];
    assert.ok(sessions.some((thread) => thread.id === SAMPLE_THREAD));
    codexPids = [];
    const missing = await http("POST", "/api/codex/focus");
    assert.equal(missing.status, 409);
    codexPids = [4321];
    focusOk = true;
    const focused = await http("POST", "/api/codex/focus");
    assert.deepEqual(focused.json, { ok: true, method: "focus" });
    assert.deepEqual(calls.focus.at(-1), { hostPid: 4321, cwd: null });
  });

  it("records codex hooks and validates them", async () => {
    assert.equal((await http("POST", "/api/codex/hook", { event: "Nope", sessionId: "c1" })).status, 400);
    assert.equal((await http("POST", "/api/codex/hook", { event: "Stop" })).status, 400);
    const started = await http("POST", "/api/codex/hook", { event: "SessionStart", sessionId: "s1-codex-live", cwd: box.repoB, model: "gpt", delegated: false });
    assert.equal((started.json as { status: string }).status, "idle");
    const tool = await http("POST", "/api/codex/hook", { event: "PostToolUse", sessionId: "s1-codex-live", toolName: "shell", toolInput: { cmd: "ls" } });
    assert.equal((tool.json as { status: string }).status, "active");
    const stopped = await http("POST", "/api/codex/hook", { event: "Stop", sessionId: "s1-codex-live", lastAssistantMessage: "done", transcriptPath: "C:/x.jsonl" });
    assert.equal((stopped.json as { lastMessage: string }).lastMessage, "done");
    assert.ok(eventsOf("codex").length > 0);
    const forbidden = await http("POST", "/api/codex/hook", { event: "Stop", sessionId: "s1-codex-live" }, { origin: "http://evil.test" });
    assert.equal(forbidden.status, 403);
  });

  it("opens an app thread by deep link and a CLI thread by focusing the app", async () => {
    assert.equal((await http("POST", "/api/codex/ghost/open")).status, 404);
    const app = await http("POST", `/api/codex/${SAMPLE_THREAD}/open`);
    assert.equal((app.json as { method: string }).method, "deep-link");
    assert.ok(calls.opened.includes(`codex://threads/${SAMPLE_THREAD}`));
    codexPids = [];
    const cli = await http("POST", `/api/codex/${CLI_THREAD}/open`);
    assert.equal(cli.status, 409);
  });

  it("returns live entries of a rollout", async () => {
    assert.equal((await http("GET", "/api/codex/ghost/live")).status, 404);
    const live = await http("GET", `/api/codex/${SAMPLE_THREAD}/live?limit=2`);
    assert.ok(Array.isArray((live.json as { entries: unknown[] }).entries));
    const clamped = await http("GET", `/api/codex/${SAMPLE_THREAD}/live?limit=abc`);
    assert.equal(clamped.status, 200);
  });

  it("renames, archives, unarchives and hides codex threads", async () => {
    const renamed = await http("PATCH", `/api/codex/${CLI_THREAD}`, { title: "cli thread" });
    assert.equal((renamed.json as { customTitle: string }).customTitle, "cli thread");
    const ghost = await http("PATCH", "/api/codex/ghost-thread", { title: 3 });
    assert.deepEqual(ghost.json, { id: "ghost-thread" });
    const archived = await http("POST", `/api/codex/${CLI_THREAD}/archive`);
    assert.notEqual((archived.json as { archivedAt: number | null }).archivedAt, null);
    assert.deepEqual((await http("POST", "/api/codex/ghost-thread/archive")).json, { id: "ghost-thread" });
    const restored = await http("POST", `/api/codex/${CLI_THREAD}/unarchive`);
    assert.equal((restored.json as { archivedAt: number | null }).archivedAt, null);
    assert.deepEqual((await http("POST", "/api/codex/ghost-thread/unarchive")).json, { id: "ghost-thread" });
    assert.deepEqual((await http("DELETE", `/api/codex/${CLI_THREAD}`)).json, { ok: true });
    const after = (await http("GET", "/api/codex/sessions")).json as { id: string }[];
    assert.ok(!after.some((thread) => thread.id === CLI_THREAD));
  });
});

describe("groups and claims", () => {
  it("creates, updates, reorders and deletes groups", async () => {
    assert.equal((await http("POST", "/api/groups", { name: "  " })).status, 400);
    const first = (await http("POST", "/api/groups", { name: " Alpha ", match: "repo-a" })).json as { id: string; name: string };
    assert.equal(first.name, "Alpha");
    const second = (await http("POST", "/api/groups", { name: "Beta" })).json as { id: string; match: string };
    assert.equal(second.match, "");
    assert.equal((await http("PATCH", "/api/groups/missing", { name: "x" })).status, 404);
    const updated = (await http("PATCH", `/api/groups/${first.id}`, { name: "Alpha 2", match: "a" })).json as { name: string; match: string };
    assert.deepEqual({ name: updated.name, match: updated.match }, { name: "Alpha 2", match: "a" });
    assert.equal((await http("POST", "/api/groups/reorder", { ids: [1] })).status, 400);
    const reordered = (await http("POST", "/api/groups/reorder", { ids: [second.id, first.id] })).json as { id: string }[];
    assert.deepEqual(reordered.map((group) => group.id), [second.id, first.id]);
    assert.deepEqual((await http("GET", "/api/groups")).json, reordered);
    assert.deepEqual((await http("DELETE", `/api/groups/${second.id}`)).json, { ok: true });
    assert.deepEqual((await http("DELETE", `/api/groups/${second.id}`)).json, { ok: false });
  });

  it("validates claims and resolves the repo from a workspace", async () => {
    assert.equal((await http("POST", "/api/claims", { paths: ["a"] })).status, 400);
    assert.equal((await http("POST", "/api/claims", { repoPath: box.repoA, paths: [] })).status, 400);
    const unknown = await http("POST", "/api/claims", { workspace: "ghost", paths: ["a"] });
    assert.equal(unknown.status, 400);
    updateSettings({ workspacesRoot: box.root });
    const viaWorkspace = await http("POST", "/api/claims", { workspace: "pilot", repo: "repo-a", paths: ["src/a.ts", 3], note: "editing", ttlMinutes: 5 });
    assert.equal(viaWorkspace.status, 201);
    const claim = viaWorkspace.json as { id: string; repoPath: string; paths: string[]; expiresAt: number | null };
    assert.deepEqual(claim.paths, ["src/a.ts"]);
    assert.notEqual(claim.expiresAt, null);
    applyHook({ ...hookBase("s1-claim-owner"), claudePid: process.pid });
    const byPid = await http("POST", "/api/claims", { repoPath: box.repoB, paths: ["b.ts"], originPid: process.pid });
    assert.equal((byPid.json as { sessionId: string | null }).sessionId, "s1-claim-owner");
    const orphan = await http("POST", "/api/claims", { repoPath: box.repoB, paths: ["c.ts"], originPid: 999_999_99 });
    assert.equal((orphan.json as { sessionId: string | null }).sessionId, null);
    const filtered = (await http("GET", `/api/claims?repoPath=${encodeURIComponent(box.repoB)}`)).json as { repoPath: string }[];
    assert.ok(filtered.length >= 2 && filtered.every((item) => item.repoPath === box.repoB));
    assert.ok(((await http("GET", "/api/claims")).json as unknown[]).length >= 3);
    assert.equal((await http("DELETE", `/api/claims/${claim.id}`)).status, 204);
    assert.ok(!listClaims().some((item) => item.id === claim.id));
  });
});

describe("hooks routes", () => {
  it("returns the windows status first and broadcasts the merged WSL status", async () => {
    const status = await http("GET", "/api/hooks");
    assert.deepEqual(status.json, { installed: true, outdated: false, wsl: null });
    await s1Wait(20);
    const merged = eventsOf("hooks").at(-1) as { wsl: { distro: string }[]; installed: boolean };
    assert.equal(merged.wsl[0]?.distro, "Ubuntu");
    assert.equal(merged.installed, true);
  });

  it("installs and uninstalls hooks outside preview mode", async () => {
    calls.hooks.length = 0;
    assert.equal((await http("POST", "/api/hooks/install")).status, 200);
    const removed = await http("POST", "/api/hooks/uninstall");
    assert.equal((removed.json as { installed: boolean }).installed, false);
    await s1Wait(20);
    assert.deepEqual(calls.hooks, ["windows:install", "wsl:install", "windows:uninstall", "wsl:uninstall"]);
  });

  it("refuses hook changes in preview mode", async () => {
    calls.hooks.length = 0;
    assert.equal((await s1Request(preview.base, "POST", "/api/hooks/install")).status, 403);
    assert.equal((await s1Request(preview.base, "POST", "/api/hooks/uninstall")).status, 403);
    assert.deepEqual(calls.hooks, []);
  });
});

function hookBase(sessionId: string) {
  return {
    kind: "session_start" as const,
    sessionId,
    cwd: null,
    source: null,
    hostPid: null,
    shellPid: null,
    title: null,
    message: null,
    notificationType: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    contextTokens: null,
    agentId: null,
    agentType: null,
    client: null,
    claudePid: null,
    transcriptPath: null,
    agentMessage: null,
    shareLabel: null,
  };
}
