import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeFakeHome, notifyScript, parseStdout, removeDir, runScript, seedPidCache, seedSession, sleep, startFakeHub, type FakeHub, type HookOptions, type HookRun } from "./helpers/s2-hooks.js";

const home = makeFakeHome();
const transcriptPath = join(home, "transcript.jsonl");
const win = process.platform === "win32";
let hub: FakeHub;

const line = (value: unknown): string => JSON.stringify(value);

before(async () => {
  hub = await startFakeHub();
  writeFileSync(
    transcriptPath,
    [
      line({ type: "user", message: { content: "hi" } }),
      line({ type: "ai-title", aiTitle: "Auto title" }),
      "{ broken json with \"assistant\" inside",
      line({ type: "assistant", message: { model: "claude-opus-5", usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 } } }),
      line({ type: "assistant", message: { model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 2 } } }),
      line({ type: "assistant", message: { content: "no usage here" } }),
      line({ type: "assistant" }),
      line({ type: "custom-title", customTitle: "Custom title" }),
      line({ type: "ai-title", aiTitle: 5 }),
    ].join("\n"),
  );
});

after(async () => {
  await hub.close();
  removeDir(home);
});

const base = { session_id: "s2-notify", cwd: "C:/work" };

function inline(input: Record<string, unknown> | string | null, extra: HookOptions = {}): Promise<HookRun> {
  return runScript(notifyScript, { home, hub, input, ...extra, env: { HUB_HOOK_INLINE: "1", ...(extra.env ?? {}) } });
}

async function bodyOf(run: Promise<HookRun>, session: string): Promise<Record<string, unknown>> {
  const result = await run;
  assert.equal(result.code, 0, result.stderr);
  const found = hub.of("/hook").filter((item) => item.body?.sessionId === session).pop();
  assert.ok(found?.body, `a /hook body for ${session}`);
  return found.body;
}

describe("early exits", () => {
  it("does nothing when HUB_SKIP is 1, for a headless SDK run, and without a session id", async () => {
    const before = hub.requests.length;
    const skipped = await inline({ ...base, hook_event_name: "Stop" }, { env: { HUB_SKIP: "1" } });
    assert.equal(skipped.code, 0);
    const headless = await inline({ ...base, hook_event_name: "Stop" }, { env: { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" } });
    assert.equal(headless.code, 0);
    const anonymous = await inline({ hook_event_name: "Stop" });
    assert.equal(anonymous.code, 0);
    assert.equal(hub.requests.length, before);
  });

  it("reads the hub address defaults without contacting anything when there is no session", async () => {
    const before = hub.requests.length;
    const run = await runScript(notifyScript, { home, hub, input: { hook_event_name: "Stop" }, env: { HUB_HOST_TARGET: undefined, HUB_PORT: undefined, HUB_HOOK_INLINE: "1" } });
    assert.equal(run.code, 0);
    assert.equal(hub.requests.length, before);
  });

  it("falls back to the environment session id and to an empty input", async () => {
    const run = await inline("{ this is not json", { env: { CLAUDE_CODE_SESSION_ID: "s2-env-session" } });
    assert.equal(run.code, 0);
    const body = hub.of("/hook").find((item) => item.body?.sessionId === "s2-env-session")?.body;
    assert.equal(body?.kind, "notification");
    const emptied = await inline(null, { env: { CLAUDE_CODE_SESSION_ID: "s2-env-empty" } });
    assert.equal(emptied.code, 0);
    assert.ok(hub.of("/hook").some((item) => item.body?.sessionId === "s2-env-empty"));
  });
});

describe("event mapping and bodies", () => {
  const mapping: [string, string][] = [
    ["SessionStart", "session_start"],
    ["UserPromptSubmit", "user_prompt"],
    ["Notification", "notification"],
    ["Stop", "stop"],
    ["StopFailure", "stop_failure"],
    ["SubagentStart", "subagent_start"],
    ["SubagentStop", "subagent_stop"],
    ["SessionEnd", "session_end"],
    ["SomethingNew", "notification"],
  ];
  for (const [event, kind] of mapping) {
    it(`maps ${event} to ${kind}`, async () => {
      const session = `s2-map-${event}`;
      const body = await bodyOf(inline({ ...base, session_id: session, hook_event_name: event }), session);
      assert.equal(body.kind, kind);
      assert.equal(body.cwd, "C:/work");
      assert.equal(body.agentId, null);
    });
  }

  it("takes an explicit kind from the command line over the event name", async () => {
    const body = await bodyOf(inline({ ...base, session_id: "s2-explicit", hook_event_name: "Stop" }, { args: ["session_end"] }), "s2-explicit");
    assert.equal(body.kind, "session_end");
  });

  it("carries messages, notification type, subagent data and a source label", async () => {
    const note = await bodyOf(inline({ ...base, session_id: "s2-note", hook_event_name: "Notification", message: "Heads up", notification_type: "idle_prompt" }, { env: { HUB_SOURCE: "laptop" } }), "s2-note");
    assert.equal(note.message, "Heads up");
    assert.equal(note.notificationType, "idle_prompt");
    assert.equal(note.source, "laptop");
    const plain = await bodyOf(inline({ ...base, session_id: "s2-note-plain", hook_event_name: "Notification", notification_type: 7 }), "s2-note-plain");
    assert.equal(plain.notificationType, null);
    assert.equal(plain.message, null);
    const long = await bodyOf(inline({ ...base, session_id: "s2-long", hook_event_name: "Stop", last_assistant_message: "x".repeat(900) }), "s2-long");
    assert.equal((long.message as string).length, 400);
    const sub = await bodyOf(inline({ ...base, session_id: "s2-sub", hook_event_name: "SubagentStop", agent_id: "a-1", agent_type: "reviewer", last_assistant_message: "sub says" }), "s2-sub");
    assert.equal(sub.message, null);
    assert.equal(sub.agentMessage, "sub says");
    assert.equal(sub.agentId, "a-1");
    assert.equal(sub.agentType, "reviewer");
    const noText = await bodyOf(inline({ ...base, session_id: "s2-notext", hook_event_name: "Stop", last_assistant_message: 12 }), "s2-notext");
    assert.equal(noText.message, null);
  });

  it("describes a permission request and a failed stop", async () => {
    const permission = await bodyOf(inline({ ...base, session_id: "s2-perm-msg", hook_event_name: "PermissionRequest", tool_name: "Edit" }, { env: { HUB_DELEGATED: "1" } }), "s2-perm-msg");
    assert.equal(permission.message, "Claude needs your permission to use Edit");
    const unnamed = await bodyOf(inline({ ...base, session_id: "s2-perm-none", hook_event_name: "PermissionRequest" }, { env: { HUB_DELEGATED: "1" } }), "s2-perm-none");
    assert.equal(unnamed.message, null);
    const detail = await bodyOf(inline({ ...base, session_id: "s2-fail-detail", hook_event_name: "StopFailure", error: "overloaded", error_details: "529 busy" }), "s2-fail-detail");
    assert.equal(detail.message, "529 busy");
    const errorOnly = await bodyOf(inline({ ...base, session_id: "s2-fail-error", hook_event_name: "StopFailure", error: "overloaded" }), "s2-fail-error");
    assert.equal(errorOnly.message, "overloaded");
    const neither = await bodyOf(inline({ ...base, session_id: "s2-fail-none", hook_event_name: "StopFailure", error_details: "" }), "s2-fail-none");
    assert.equal(neither.message, null);
  });

  it("labels the client from the share, headless and delegation context", async () => {
    const share = await bodyOf(inline({ ...base, session_id: "s2-share", hook_event_name: "Stop" }, { env: { HUB_SHARE_LABEL: "Will" } }), "s2-share");
    assert.equal(share.client, "share");
    assert.equal(share.shareLabel, "Will");
    const headless = await bodyOf(inline({ ...base, session_id: "s2-headless", hook_event_name: "Stop" }, { env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts", HUB_TRACK_SDK: "1" } }), "s2-headless");
    assert.equal(headless.client, "headless");
    const delegated = await bodyOf(inline({ ...base, session_id: "s2-hubrun", hook_event_name: "Stop" }, { env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts", HUB_TRACK_SDK: "1", HUB_DELEGATED: "1" } }), "s2-hubrun");
    assert.equal(delegated.client, "hub");
    const plain = await bodyOf(inline({ ...base, session_id: "s2-plain-client", hook_event_name: "Stop" }), "s2-plain-client");
    assert.ok(plain.client === null || typeof plain.client === "string");
  });

  it("reports the Claude pid from the environment", async () => {
    const body = await bodyOf(inline({ ...base, session_id: "s2-claudepid", hook_event_name: "Stop" }, { env: { CLAUDE_PID: String(process.pid) } }), "s2-claudepid");
    assert.ok(typeof body.claudePid === "number" && body.claudePid > 0);
    const none = await bodyOf(inline({ ...base, session_id: "s2-claudepid-bad", hook_event_name: "Stop" }, { env: { CLAUDE_PID: "abc", HUB_HOOK_START_PID: "xyz" } }), "s2-claudepid-bad");
    assert.ok(none.claudePid === null || typeof none.claudePid === "number");
  });
});

describe("transcript and session names", () => {
  it("reads title, model and token totals from the transcript, preferring a custom title", async () => {
    const body = await bodyOf(inline({ ...base, session_id: "s2-transcript", hook_event_name: "Stop", transcript_path: transcriptPath }), "s2-transcript");
    assert.equal(body.title, "Custom title");
    assert.equal(body.model, "claude-opus-5");
    assert.equal(body.tokensIn, 10 + 5 + 1);
    assert.equal(body.tokensOut, 22);
    assert.equal(body.contextTokens, 1);
    assert.equal(body.transcriptPath, transcriptPath);
  });

  it("falls back to nulls for a missing transcript and to the auto title without a custom one", async () => {
    const missing = await bodyOf(inline({ ...base, session_id: "s2-no-transcript", hook_event_name: "Stop", transcript_path: join(home, "gone.jsonl") }), "s2-no-transcript");
    assert.equal(missing.title, null);
    assert.equal(missing.model, null);
    assert.equal(missing.tokensIn, null);
    assert.equal(missing.contextTokens, null);
    const auto = join(home, "auto.jsonl");
    writeFileSync(auto, [line({ type: "ai-title", aiTitle: "Only auto" }), line({ type: "assistant", message: { model: "m" } })].join("\n"));
    const body = await bodyOf(inline({ ...base, session_id: "s2-auto", hook_event_name: "Stop", transcript_path: auto }), "s2-auto");
    assert.equal(body.title, "Only auto");
    assert.equal(body.tokensIn, null);
    const sparse = join(home, "sparse.jsonl");
    writeFileSync(sparse, [line({ type: "assistant", message: { model: "m", usage: { output_tokens: 4 } } }), line({ type: "assistant", message: { model: "m", usage: {} } })].join("\n"));
    const partial = await bodyOf(inline({ ...base, session_id: "s2-sparse", hook_event_name: "Stop", transcript_path: sparse }), "s2-sparse");
    assert.equal(partial.tokensIn, 0);
    assert.equal(partial.tokensOut, 4);
    assert.equal(partial.contextTokens, 0);
  });

  it("prefers a name the user gave the session, then the transcript, then a derived name", async () => {
    seedSession(home, "older.json", { sessionId: "s2-named", name: "Old name", nameSource: "user", updatedAt: 1 });
    seedSession(home, "newer.json", { sessionId: "s2-named", name: "New name", nameSource: "user", updatedAt: 5 });
    seedSession(home, "derived.json", { sessionId: "s2-derived", name: "Derived name", nameSource: "derived", updatedAt: 3 });
    seedSession(home, "nodate-a.json", { sessionId: "s2-nodate", name: "First" });
    seedSession(home, "nodate-b.json", { sessionId: "s2-nodate", name: "Second", updatedAt: 2 });
    seedSession(home, "other.json", { sessionId: "someone-else", name: "Not me" });
    seedSession(home, "broken.json", "{ nope");
    seedSession(home, "notes.txt", "ignored");
    const auto = join(home, "auto2.jsonl");
    writeFileSync(auto, line({ type: "ai-title", aiTitle: "Transcript title" }));
    const named = await bodyOf(inline({ ...base, session_id: "s2-named", hook_event_name: "Stop", transcript_path: auto }), "s2-named");
    assert.equal(named.title, "New name");
    const custom = await bodyOf(inline({ ...base, session_id: "s2-named", hook_event_name: "Stop", transcript_path: transcriptPath }), "s2-named");
    assert.equal(custom.title, "Custom title");
    const derivedWithTranscript = await bodyOf(inline({ ...base, session_id: "s2-derived", hook_event_name: "Stop", transcript_path: auto }), "s2-derived");
    assert.equal(derivedWithTranscript.title, "Transcript title");
    const derivedOnly = await bodyOf(inline({ ...base, session_id: "s2-derived", hook_event_name: "Stop", transcript_path: join(home, "none.jsonl") }), "s2-derived");
    assert.equal(derivedOnly.title, "Derived name");
    const nodate = await bodyOf(inline({ ...base, session_id: "s2-nodate", hook_event_name: "Stop", transcript_path: auto }), "s2-nodate");
    assert.equal(nodate.title, "Second");
    const unknown = await bodyOf(inline({ ...base, session_id: "s2-unknown-name", hook_event_name: "Stop", transcript_path: join(home, "none.jsonl") }), "s2-unknown-name");
    assert.equal(unknown.title, null);
  });
});

describe("host detection", { skip: !win }, () => {
  it("uses a cached host window while it is alive", async () => {
    seedPidCache(home, "s2-cache-ok", { hostPid: process.pid, shellPid: process.pid, claudePid: 4242, host: "vscode" });
    const body = await bodyOf(inline({ ...base, session_id: "s2-cache-ok", hook_event_name: "Stop" }), "s2-cache-ok");
    assert.equal(body.hostPid, process.pid);
    assert.equal(body.shellPid, process.pid);
    assert.equal(body.claudePid, 4242);
    assert.equal(body.client, "vscode");
  });

  it("accepts a cached window without a shell or a host kind", async () => {
    seedPidCache(home, "s2-cache-noshell", { hostPid: process.pid });
    const body = await bodyOf(inline({ ...base, session_id: "s2-cache-noshell", hook_event_name: "Stop" }), "s2-cache-noshell");
    assert.equal(body.hostPid, process.pid);
    assert.equal(body.shellPid ?? null, null);
    assert.equal(body.client, null);
  });

  it("asks PowerShell again when the cached window or shell is gone, or the cache is damaged", async () => {
    seedPidCache(home, "s2-cache-dead", { hostPid: 2_147_480_000, shellPid: null, host: "terminal" });
    const dead = await bodyOf(inline({ ...base, session_id: "s2-cache-dead", hook_event_name: "Stop" }, { env: { HUB_HOOK_START_PID: String(process.pid) } }), "s2-cache-dead");
    assert.ok(dead.hostPid === null || typeof dead.hostPid === "number");
    seedPidCache(home, "s2-cache-noshellalive", { hostPid: process.pid, shellPid: 2_147_480_001, host: "vscode" });
    const shell = await bodyOf(inline({ ...base, session_id: "s2-cache-noshellalive", hook_event_name: "Stop" }, { env: { HUB_HOOK_START_PID: String(process.pid) } }), "s2-cache-noshellalive");
    assert.ok(shell.hostPid === null || typeof shell.hostPid === "number");
    seedPidCache(home, "s2-cache-broken", {});
    writeFileSync(join(home, ".vbss-cchub", "pids", "s2-cache-broken.json"), "{ nope");
    seedPidCache(home, "s2-cache-zeroshell", { hostPid: process.pid, shellPid: 0, host: "vscode" });
    const zero = await bodyOf(inline({ ...base, session_id: "s2-cache-zeroshell", hook_event_name: "Stop" }, { env: { HUB_HOOK_START_PID: String(process.pid) } }), "s2-cache-zeroshell");
    assert.ok(zero.hostPid === null || typeof zero.hostPid === "number");
    const broken = await bodyOf(inline({ ...base, session_id: "s2-cache-broken", hook_event_name: "Stop" }, { env: { HUB_HOOK_START_PID: String(process.pid) } }), "s2-cache-broken");
    assert.ok(broken.hostPid === null || typeof broken.hostPid === "number");
  });

  it("resolves the host window with PowerShell and caches it for the next hook", async () => {
    const body = await bodyOf(inline({ ...base, session_id: "s2-ps", hook_event_name: "Stop" }, { env: { HUB_HOOK_START_PID: String(process.pid) } }), "s2-ps");
    assert.ok(body.hostPid === null || typeof body.hostPid === "number");
    assert.ok(body.claudePid === null || typeof body.claudePid === "number");
  });
});

describe("default flow with a detached worker", () => {
  it("posts at once from the cache, then lets the worker refine the session with its transcript", async () => {
    seedPidCache(home, "s2-worker", { hostPid: process.pid, shellPid: null, host: "terminal" });
    const run = await runScript(notifyScript, { home, hub, input: { ...base, session_id: "s2-worker", hook_event_name: "Stop", transcript_path: transcriptPath } });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, "");
    const first = hub.of("/hook").find((item) => item.body?.sessionId === "s2-worker" && item.body.kind === "stop");
    assert.ok(first?.body);
    assert.equal(first.body.title, null);
    assert.equal(first.body.hostPid, win ? process.pid : null);
    const meta = await waitForMeta("s2-worker");
    assert.equal(meta.title, "Custom title");
    assert.equal(meta.message, null);
    await sleep(400);
  });

  it("labels a cached window without a host kind as a terminal and keeps its live shell", async () => {
    seedPidCache(home, "s2-worker-nohost", { hostPid: process.pid, shellPid: process.pid });
    const run = await runScript(notifyScript, { home, hub, input: { ...base, session_id: "s2-worker-nohost", hook_event_name: "Stop" } });
    assert.equal(run.code, 0, run.stderr);
    const first = hub.of("/hook").find((item) => item.body?.sessionId === "s2-worker-nohost" && item.body.kind === "stop");
    assert.equal(first?.body?.client, "terminal");
    assert.equal(first?.body?.shellPid, process.pid);
    await waitForMeta("s2-worker-nohost");
    await sleep(400);
  });

  it("ignores a cached window whose shell is gone or whose cache file is damaged", async () => {
    seedPidCache(home, "s2-worker-deadshell", { hostPid: process.pid, shellPid: 2_147_480_002, host: "vscode" });
    const dead = await runScript(notifyScript, { home, hub, input: { ...base, session_id: "s2-worker-deadshell", hook_event_name: "Stop" }, env: { HUB_HOOK_START_PID: String(process.pid) } });
    assert.equal(dead.code, 0, dead.stderr);
    assert.equal(hub.of("/hook").find((item) => item.body?.sessionId === "s2-worker-deadshell" && item.body.kind === "stop")?.body?.hostPid, null);
    seedPidCache(home, "s2-worker-broken", {});
    writeFileSync(join(home, ".vbss-cchub", "pids", "s2-worker-broken.json"), "{ nope");
    const broken = await runScript(notifyScript, { home, hub, input: { ...base, session_id: "s2-worker-broken", hook_event_name: "Stop" }, env: { HUB_HOOK_START_PID: String(process.pid) } });
    assert.equal(broken.code, 0, broken.stderr);
    assert.equal(hub.of("/hook").find((item) => item.body?.sessionId === "s2-worker-broken" && item.body.kind === "stop")?.body?.hostPid, null);
    await waitForMeta("s2-worker-deadshell");
    await waitForMeta("s2-worker-broken");
    await sleep(400);
  });

  it("posts without host info when nothing is cached and resolves it in the worker", async () => {
    const run = await runScript(notifyScript, { home, hub, input: { ...base, session_id: "s2-worker-cold", hook_event_name: "UserPromptSubmit" }, env: { HUB_HOOK_START_PID: String(process.pid) } });
    assert.equal(run.code, 0, run.stderr);
    const first = hub.of("/hook").find((item) => item.body?.sessionId === "s2-worker-cold" && item.body.kind === "user_prompt");
    assert.ok(first?.body);
    assert.equal(first.body.hostPid, null);
    const meta = await waitForMeta("s2-worker-cold");
    assert.equal(meta.kind, "meta");
    await sleep(400);
  });

  it("exits quietly when the hub is down", async () => {
    const run = await runScript(notifyScript, { home, hub: null, input: { ...base, session_id: "s2-down", hook_event_name: "Stop" } });
    assert.equal(run.code, 0);
    assert.equal(run.stdout, "");
    await sleep(300);
  });
});

async function waitForMeta(session: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const found = hub.of("/hook").find((item) => item.body?.sessionId === session && item.body.kind === "meta");
    if (found?.body) return found.body;
    if (Date.now() > deadline) throw new Error(`no meta post for ${session}`);
    await sleep(50);
  }
}

describe("tool completions", () => {
  it("posts only the tool facts and exits", async () => {
    const run = await runScript(notifyScript, { home, hub, input: { ...base, session_id: "s2-tool", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, agent_id: "ag-1" } });
    assert.equal(run.code, 0, run.stderr);
    const body = hub.of("/hook").find((item) => item.body?.sessionId === "s2-tool")?.body;
    assert.deepEqual(body, { kind: "tool_done", sessionId: "s2-tool", cwd: "C:/work", source: body?.source, agentId: "ag-1", toolName: "Bash", toolInput: { command: "ls" } });
    const failure = await runScript(notifyScript, { home, hub, input: { session_id: "s2-tool-fail", hook_event_name: "PostToolUseFailure" } });
    assert.equal(failure.code, 0);
    const failed = hub.of("/hook").find((item) => item.body?.sessionId === "s2-tool-fail")?.body;
    assert.equal(failed?.kind, "tool_done");
    assert.equal(failed?.toolName, null);
    assert.equal(failed?.toolInput, null);
    assert.equal(failed?.cwd, null);
  });
});

describe("session handoff", () => {
  const start = (session: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}): Promise<HookRun> =>
    inline({ ...base, session_id: session, hook_event_name: "SessionStart", source: "startup", ...extra }, { env });

  it("prints the handoff as additional context, trimmed to the limit", async () => {
    hub.routes = (request) => (request.path === "/delegation/memory/handoff/hook" ? { body: { text: `handoff ${"x".repeat(2000)}` } } : undefined);
    const run = await start("s2-handoff");
    assert.equal(run.code, 0, run.stderr);
    const out = parseStdout(run) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(out.hookSpecificOutput.additionalContext.length, 1500);
    const request = hub.of("/delegation/memory/handoff/hook").pop();
    assert.equal(request?.query.get("cwd"), "C:/work");
    assert.equal(request?.query.get("sessionId"), "s2-handoff");
  });

  it("prints nothing for blank text, a failed lookup or malformed data", async () => {
    for (const answer of [{ body: { text: "   " } }, { body: { text: 5 } }, { body: null }, { status: 500 }, { raw: "not json" }, { destroy: true }]) {
      hub.routes = (request) => (request.path === "/delegation/memory/handoff/hook" ? answer : undefined);
      const run = await start("s2-handoff-empty");
      assert.equal(run.code, 0);
      assert.equal(run.stdout, "", JSON.stringify(answer));
    }
  });

  it("does not ask for a handoff on resume, without a folder or for headless, shared and delegated runs", async () => {
    hub.routes = () => ({ body: { text: "should not appear" } });
    const before = hub.of("/delegation/memory/handoff/hook").length;
    const runs = [
      await start("s2-no-handoff-1", { source: "resume" }),
      await start("s2-no-handoff-2", { cwd: undefined }),
      await start("s2-no-handoff-3", {}, { HUB_SHARE_LABEL: "x" }),
      await start("s2-no-handoff-4", {}, { HUB_DELEGATED: "1" }),
      await start("s2-no-handoff-5", {}, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", HUB_TRACK_SDK: "1" }),
    ];
    for (const run of runs) assert.equal(run.stdout, "");
    assert.equal(hub.of("/delegation/memory/handoff/hook").length, before);
    hub.routes = () => undefined;
  });
});

describe("permission requests", () => {
  const ask = (session: string, input: Record<string, unknown> = {}, extra: HookOptions = {}): Promise<HookRun> =>
    inline({ ...base, session_id: session, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf build" }, ...input }, extra);

  const decide = (decision: unknown, open: Record<string, unknown> | null = { id: "p1", waitToken: "tok", windowMs: 5000 }) => {
    hub.routes = (request) => {
      if (request.path === "/api/permissions/request") return open === null ? { status: 500 } : { body: open };
      if (request.path.endsWith("/wait")) return { body: { decision } };
      return undefined;
    };
  };

  it("prints the official allow decision for a plain tool and sends the wait token", async () => {
    decide({ behavior: "allow" });
    const run = await ask("s2-allow");
    const out = parseStdout(run) as { hookSpecificOutput: { hookEventName: string; decision: unknown } };
    assert.deepEqual(out.hookSpecificOutput, { hookEventName: "PermissionRequest", decision: { behavior: "allow" } });
    const open = hub.of("/api/permissions/request").pop()?.body;
    assert.equal(open?.agent, "claude");
    assert.equal(open?.toolName, "Bash");
    assert.equal(open?.delegated, false);
    const wait = hub.of("/api/permissions/p1/wait").pop();
    assert.equal(wait?.headers["x-hub-wait-token"], "tok");
  });

  it("prints deny with or without a message", async () => {
    decide({ behavior: "deny", message: "not now" });
    assert.deepEqual((parseStdout(await ask("s2-deny")) as { hookSpecificOutput: { decision: unknown } }).hookSpecificOutput.decision, { behavior: "deny", message: "not now" });
    decide({ behavior: "deny", message: "" });
    assert.deepEqual((parseStdout(await ask("s2-deny-empty")) as { hookSpecificOutput: { decision: unknown } }).hookSpecificOutput.decision, { behavior: "deny" });
    decide({ behavior: "deny" });
    assert.deepEqual((parseStdout(await ask("s2-deny-bare")) as { hookSpecificOutput: { decision: unknown } }).hookSpecificOutput.decision, { behavior: "deny" });
  });

  it("prints nothing for an unknown behavior, a missing decision or an unusable handshake", async () => {
    const cases: [string, () => void][] = [
      ["unknown behavior", () => decide({ behavior: "ask" })],
      ["null decision", () => decide(null)],
      ["non-object decision", () => decide("allow")],
      ["handshake rejected", () => decide({ behavior: "allow" }, null)],
      ["no id", () => decide({ behavior: "allow" }, { waitToken: "t", windowMs: 5000 })],
      ["no token", () => decide({ behavior: "allow" }, { id: "p", windowMs: 5000 })],
      ["no window", () => decide({ behavior: "allow" }, { id: "p", waitToken: "t", windowMs: 0 })],
      ["window not a number", () => decide({ behavior: "allow" }, { id: "p", waitToken: "t", windowMs: "soon" })],
      [
        "wait fails",
        () => {
          decide({ behavior: "allow" });
          const inner = hub.routes;
          hub.routes = (request) => (request.path.endsWith("/wait") ? { status: 500 } : inner(request));
        },
      ],
      [
        "wait answers garbage",
        () => {
          decide({ behavior: "allow" });
          const inner = hub.routes;
          hub.routes = (request) => (request.path.endsWith("/wait") ? { raw: "garbage" } : inner(request));
        },
      ],
      [
        "wait answers null",
        () => {
          decide({ behavior: "allow" });
          const inner = hub.routes;
          hub.routes = (request) => (request.path.endsWith("/wait") ? { raw: "null" } : inner(request));
        },
      ],
      [
        "handshake dropped",
        () => {
          hub.routes = (request) => (request.path === "/api/permissions/request" ? { destroy: true } : undefined);
        },
      ],
      [
        "handshake answers null",
        () => {
          hub.routes = (request) => (request.path === "/api/permissions/request" ? { raw: "null" } : undefined);
        },
      ],
    ];
    for (const [name, setup] of cases) {
      setup();
      const run = await ask(`s2-nothing-${name.replace(/\W+/g, "-")}`);
      assert.equal(run.code, 0, name);
      assert.equal(run.stdout, "", name);
    }
  });

  it("does not ask the hub when the hook was not observed", async () => {
    hub.routes = (request) => (request.path === "/hook" ? { status: 500 } : request.path.includes("/api/permissions") ? { body: { id: "p", waitToken: "t", windowMs: 5000 } } : undefined);
    const before = hub.of("/api/permissions/request").length;
    const run = await ask("s2-unobserved");
    assert.equal(run.stdout, "");
    assert.equal(hub.of("/api/permissions/request").length, before);
  });

  it("never decides for delegated, shared or headless sessions", async () => {
    decide({ behavior: "allow" });
    const before = hub.of("/api/permissions/request").length;
    for (const env of [{ HUB_DELEGATED: "1" }, { HUB_SHARE_LABEL: "Will" }, { CLAUDE_CODE_ENTRYPOINT: "sdk-cli", HUB_TRACK_SDK: "1" }]) {
      const run = await ask("s2-undecided", {}, { env });
      assert.equal(run.stdout, "", JSON.stringify(env));
    }
    assert.equal(hub.of("/api/permissions/request").length, before);
  });

  it("keeps the H1 contract: AskUserQuestion and ExitPlanMode never get a bare allow", async () => {
    const questions = { questions: [{ question: "Which?", options: [{ label: "a" }] }] };
    const out = (run: HookRun): { hookSpecificOutput: { decision: Record<string, unknown> } } | null => parseStdout(run) as never;
    decide({ behavior: "allow" });
    assert.equal((await ask("s2-ask-bare", { tool_name: "AskUserQuestion", tool_input: questions })).stdout, "");
    decide({ behavior: "allow", updatedInput: ["not", "an", "object"] });
    assert.equal((await ask("s2-ask-array", { tool_name: "AskUserQuestion", tool_input: questions })).stdout, "");
    decide({ behavior: "allow", updatedInput: { ...questions, answers: "red" } });
    assert.equal((await ask("s2-ask-badanswers", { tool_name: "AskUserQuestion", tool_input: questions })).stdout, "");
    decide({ behavior: "allow", updatedInput: { ...questions, answers: { "Which?": "a" } } });
    const answered = out(await ask("s2-ask-answered", { tool_name: "AskUserQuestion", tool_input: questions }));
    assert.deepEqual(answered?.hookSpecificOutput.decision, { behavior: "allow", updatedInput: { ...questions, answers: { "Which?": "a" } } });

    decide({ behavior: "allow" });
    assert.equal((await ask("s2-plan-bare", { tool_name: "ExitPlanMode", tool_input: { plan: "p" } })).stdout, "");
    decide({ behavior: "allow", updatedInput: { plan: "p" } });
    const approved = out(await ask("s2-plan-approved", { tool_name: "ExitPlanMode", tool_input: { plan: "p" } }));
    assert.deepEqual(approved?.hookSpecificOutput.decision, { behavior: "allow", updatedInput: { plan: "p" } });
    decide({ behavior: "deny", message: "no plan" });
    assert.deepEqual(out(await ask("s2-plan-denied", { tool_name: "ExitPlanMode", tool_input: { plan: "p" } }))?.hookSpecificOutput.decision, { behavior: "deny", message: "no plan" });
  });

  it("sends a null tool when the request carries none", async () => {
    decide({ behavior: "deny" });
    await ask("s2-null-tool", { tool_name: undefined, tool_input: undefined, agent_id: "ag-9", cwd: undefined });
    const open = hub.of("/api/permissions/request").pop()?.body;
    assert.equal(open?.toolName, null);
    assert.equal(open?.toolInput, null);
    assert.equal(open?.agentId, "ag-9");
    assert.equal(open?.cwd, null);
  });
});
