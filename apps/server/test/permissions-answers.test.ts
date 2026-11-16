import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeSandbox, serverDir, startServer, waitFor, type RunningServer } from "./helpers.js";

const box = makeSandbox("cchub-h1-answers-");
const fakeUser = join(box.tmp, "user");
const claudeDir = join(fakeUser, ".claude");
const notifyHook = join(serverDir, "hooks", "notify.mjs");
let hub: RunningServer;
const running = new Set<ChildProcess>();

const { ANSWER_MAX, questionTexts, updatedInputFor } = await import("../src/permissions.js");

const QUESTIONS = [
  {
    question: "Which database should we use?",
    header: "Database",
    options: [
      { label: "Postgres", description: "Relational" },
      { label: "Mongo", description: "Documents" },
    ],
    multiSelect: false,
  },
  {
    question: "Which checks should run?",
    header: "Checks",
    options: [
      { label: "Lint", description: "eslint" },
      { label: "Tests", description: "unit tests" },
    ],
    multiSelect: true,
  },
];

const askInput = { questions: QUESTIONS };
const planInput = { plan: "# Plan\n\n1. Add the route\n2. Test it", planFilePath: "C:/plans/plan.md" };

describe("updatedInputFor", () => {
  const ask = { agent: "claude" as const, toolName: "AskUserQuestion", toolInput: askInput };

  it("builds questions plus validated answers from the stored input", () => {
    const out = updatedInputFor(ask, "allow", { "Which database should we use?": "Postgres", "Which checks should run?": " Lint, Tests " });
    assert.deepEqual(out, { ok: true, updatedInput: { questions: QUESTIONS, answers: { "Which database should we use?": "Postgres", "Which checks should run?": "Lint, Tests" } } });
  });

  it("refuses an allow without answers, unknown keys, empty or long values and missing questions", () => {
    assert.equal(updatedInputFor(ask, "allow", undefined).ok, false);
    assert.equal(updatedInputFor(ask, "allow", ["Postgres"]).ok, false);
    assert.equal(updatedInputFor(ask, "allow", { "Which database should we use?": "Postgres", "Which checks should run?": "Lint", "Inject?": "x" }).ok, false);
    assert.equal(updatedInputFor(ask, "allow", { "Which database should we use?": "  ", "Which checks should run?": "Lint" }).ok, false);
    assert.equal(updatedInputFor(ask, "allow", { "Which database should we use?": 3, "Which checks should run?": "Lint" }).ok, false);
    assert.equal(updatedInputFor(ask, "allow", { "Which database should we use?": "x".repeat(ANSWER_MAX + 1), "Which checks should run?": "Lint" }).ok, false);
    assert.equal(updatedInputFor(ask, "allow", { "Which database should we use?": "Postgres" }).ok, false);
    assert.equal(updatedInputFor({ ...ask, toolInput: { questions: [] } }, "allow", {}).ok, false);
  });

  it("echoes the ExitPlanMode input and ignores answers everywhere else", () => {
    assert.deepEqual(updatedInputFor({ agent: "claude", toolName: "ExitPlanMode", toolInput: planInput }, "allow", { x: "y" }), { ok: true, updatedInput: planInput });
    assert.deepEqual(updatedInputFor({ agent: "claude", toolName: "Bash", toolInput: { command: "ls" } }, "allow", { x: "y" }), { ok: true, updatedInput: null });
    for (const toolInput of [null, undefined, "plan", 7, ["plan"]]) {
      assert.equal(updatedInputFor({ agent: "claude", toolName: "ExitPlanMode", toolInput }, "allow", undefined).ok, false);
      assert.deepEqual(updatedInputFor({ agent: "claude", toolName: "ExitPlanMode", toolInput }, "deny", undefined), { ok: true, updatedInput: null });
    }
    assert.deepEqual(updatedInputFor({ agent: "codex", toolName: "AskUserQuestion", toolInput: askInput }, "allow", undefined), { ok: true, updatedInput: null });
    assert.deepEqual(updatedInputFor(ask, "deny", undefined), { ok: true, updatedInput: null });
  });

  it("reads the question texts only from a well formed input", () => {
    assert.deepEqual(questionTexts(askInput), ["Which database should we use?", "Which checks should run?"]);
    assert.equal(questionTexts({ questions: [{ header: "x" }] }), null);
    assert.equal(questionTexts(null), null);
  });
});

interface HookRun {
  code: number | null;
  stdout: string;
}

interface Pending {
  id: string;
  sessionId: string;
  toolName: string;
}

function runHook(input: Record<string, unknown>): Promise<HookRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeUser, USERPROFILE: fakeUser, CLAUDE_CONFIG_DIR: claudeDir, HUB_HOST_TARGET: "127.0.0.1", HUB_PORT: String(hub.port), HUB_SKIP: "0" };
  for (const key of ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "HUB_DELEGATED", "HUB_TRACK_SDK", "HUB_SHARE_LABEL", "HUB_HOOK_INLINE", "CLAUDE_PID"]) delete env[key];
  const child = spawn(process.execPath, [notifyHook], { env, stdio: ["pipe", "pipe", "ignore"] });
  running.add(child);
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const done = new Promise<HookRun>((resolve) => {
    child.on("close", (code) => {
      running.delete(child);
      resolve({ code, stdout });
    });
  });
  child.stdin?.end(JSON.stringify(input));
  return done;
}

async function http(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${hub.base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const pendingFor = (sessionId: string): Promise<Pending> =>
  waitFor(async () => ((await http("GET", "/api/permissions")).json as Pending[]).find((item) => item.sessionId === sessionId) ?? null, 10_000);

const request = (sessionId: string, toolName: string, toolInput: unknown): Record<string, unknown> => ({
  hook_event_name: "PermissionRequest",
  session_id: sessionId,
  cwd: box.repoA,
  tool_name: toolName,
  tool_input: toolInput,
});

before(async () => {
  mkdirSync(claudeDir, { recursive: true });
  hub = await startServer(box, { HOME: fakeUser, USERPROFILE: fakeUser, CLAUDE_CONFIG_DIR: claudeDir, HUB_SHARE_PORT: "0", HUB_DELEGATION: "1" });
  assert.equal((await http("PUT", "/delegation/settings", { approvals: { claudeWindowSec: 30 } })).status, 200);
});

after(() => {
  for (const child of running) child.kill();
  hub.child.kill();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("AskUserQuestion and ExitPlanMode through the hub", () => {
  it("refuses an allow without answers and returns allow plus updatedInput once answered", async () => {
    const hook = runHook(request("h1-ask", "AskUserQuestion", askInput));
    const pending = await pendingFor("h1-ask");
    const bare = await http("POST", `/api/permissions/${pending.id}/decision`, { behavior: "allow" });
    assert.equal(bare.status, 400);
    const forged = await http("POST", `/api/permissions/${pending.id}/decision`, { behavior: "allow", answers: { "Something else?": "yes" } });
    assert.equal(forged.status, 400);
    const answers = { "Which database should we use?": "Mongo", "Which checks should run?": "Lint, Tests" };
    const decided = await http("POST", `/api/permissions/${pending.id}/decision`, { behavior: "allow", answers, updatedInput: { questions: [] } });
    assert.equal(decided.status, 200, JSON.stringify(decided.json));
    const run = await hook;
    assert.equal(run.code, 0);
    assert.deepEqual(JSON.parse(run.stdout), {
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { questions: QUESTIONS, answers } } },
    });
  });

  it("echoes the received ExitPlanMode input on Approve plan and sends the reason on Keep planning", async () => {
    const approve = runHook(request("h1-plan", "ExitPlanMode", planInput));
    const first = await pendingFor("h1-plan");
    assert.equal((await http("POST", `/api/permissions/${first.id}/decision`, { behavior: "allow", updatedInput: { plan: "forged" } })).status, 200);
    assert.deepEqual(JSON.parse((await approve).stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: planInput } } });
    const keep = runHook(request("h1-plan-deny", "ExitPlanMode", planInput));
    const second = await pendingFor("h1-plan-deny");
    assert.equal((await http("POST", `/api/permissions/${second.id}/decision`, { behavior: "deny", message: "split step 2" })).status, 200);
    assert.deepEqual(JSON.parse((await keep).stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "split step 2" } } });
  });

  it("keeps refusing updatedInput for any other tool", async () => {
    const hook = runHook(request("h1-bash", "Bash", { command: "ls" }));
    const pending = await pendingFor("h1-bash");
    await http("POST", `/api/permissions/${pending.id}/decision`, { behavior: "allow", updatedInput: { command: "rm -rf /" }, answers: { "Which database should we use?": "x" } });
    assert.deepEqual(JSON.parse((await hook).stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  });

  it("hands the question back to the session with no output on release", async () => {
    const hook = runHook(request("h1-release", "AskUserQuestion", askInput));
    const pending = await pendingFor("h1-release");
    const released = await http("POST", `/api/permissions/${pending.id}/release`);
    assert.equal(released.status, 200);
    const run = await hook;
    assert.equal(run.code, 0);
    assert.equal(run.stdout, "");
    assert.equal((await http("POST", `/api/permissions/${pending.id}/release`)).status, 404);
  });
});
