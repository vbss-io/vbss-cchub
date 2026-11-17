import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { s2Sandbox, s2StartHub, s2Until, type S2Hub } from "./helpers/s2-env.js";

const box = s2Sandbox("cch-s2-permissions-", { HUB_DELEGATION: "1" });

const { db, applyHook } = await import("../src/db.js");
const permissions = await import("../src/permissions.js");
const routes = await import("../src/permissions-routes.js");
const store = await import("../src/delegation-store.js");

let hub: S2Hub;

interface Opened {
  id: string | null;
  windowMs: number;
  expiresAt: number | null;
  waitToken?: string;
}

before(async () => {
  hub = await s2StartHub(box);
});

after(async () => {
  await hub.close();
  if (db.open) db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const errorOf = (json: unknown): string => (json as { error: string }).error;

async function open(body: Record<string, unknown>): Promise<Opened> {
  const res = await hub.http("POST", "/api/permissions/request", { agent: "claude", sessionId: "perm-session", toolName: "Bash", toolInput: { command: "ls" }, cwd: box.repoA, ...body });
  assert.equal(res.status, 200, res.text);
  return res.json as Opened;
}

const hook = (sessionId: string, client: string | null) => ({ kind: "session_start" as const, sessionId, cwd: box.repoA, source: null, hostPid: null, shellPid: null, title: "Titled session", message: null, notificationType: null, model: null, tokensIn: null, tokensOut: null, contextTokens: null, agentId: null, agentType: null, client, claudePid: null, transcriptPath: null, agentMessage: null, shareLabel: null });

describe("permission guard", () => {
  it("refuses a request from outside the loopback and one from an untrusted origin", () => {
    const answered: { status: number; body: unknown }[] = [];
    const res = { status: (code: number) => ({ json: (body: unknown) => answered.push({ status: code, body }) }) };
    let nexted = 0;
    const request = (address: string | undefined, origin: string | undefined) => ({ socket: { remoteAddress: address }, header: () => origin }) as never;
    routes.permissionGuard(request("203.0.113.9", undefined), res as never, () => (nexted += 1));
    routes.permissionGuard(request("127.0.0.1", "http://evil.test"), res as never, () => (nexted += 1));
    routes.permissionGuard(request("127.0.0.1", undefined), res as never, () => (nexted += 1));
    assert.equal(nexted, 1);
    assert.deepEqual(answered.map((item) => item.status), [403, 403]);
    assert.match(errorOf(answered[0]?.body), /loopback connections only/);
    assert.match(errorOf(answered[1]?.body), /origin not allowed/);
  });

  it("answers 403 through the router for a foreign origin", async () => {
    const res = await hub.http("GET", "/api/permissions", undefined, { origin: "http://evil.test" });
    assert.equal(res.status, 403);
  });
});

describe("opening requests", () => {
  it("lists pending requests and validates the payload", async () => {
    const empty = await hub.http("GET", "/api/permissions");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, []);
    for (const body of [{}, { agent: "gemini", sessionId: "s", toolName: "t" }, { agent: "claude", sessionId: "", toolName: "t" }, { agent: "claude", sessionId: "s", toolName: "" }]) {
      const res = await hub.http("POST", "/api/permissions/request", body);
      assert.equal(res.status, 400, res.text);
      assert.match(errorOf(res.json), /agent, sessionId and toolName required/);
    }
  });

  it("opens a Claude request with the configured window and the session title", async () => {
    applyHook(hook("perm-titled", null));
    const opened = await open({ sessionId: "perm-titled", agentId: "sub-1", turnId: "turn-1" });
    assert.ok(opened.id);
    assert.ok(opened.waitToken);
    assert.ok(opened.windowMs > 0 && opened.windowMs <= permissions.SUBAGENT_WINDOW_CAP_SEC * 1000);
    const list = (await hub.http("GET", "/api/permissions")).json as { id: string; title: string | null; agentId: string | null }[];
    const listed = list.find((item) => item.id === opened.id);
    assert.equal(listed?.title, "Titled session");
    assert.equal(listed?.agentId, "sub-1");
    await hub.http("POST", `/api/permissions/${opened.id}/release`);
  });

  it("opens a Codex request and treats hub, headless, share and flagged requests as delegated", async () => {
    const codex = await open({ agent: "codex", sessionId: "thread-1", agentId: null });
    assert.ok(codex.id);
    assert.equal(codex.windowMs, store.getSettings().approvals.codexWindowSec * 1000);
    await hub.http("POST", `/api/permissions/${codex.id}/release`);
    for (const client of ["hub", "headless", "share"]) {
      applyHook(hook(`perm-${client}`, client));
      const opened = await open({ sessionId: `perm-${client}` });
      assert.equal(opened.id, null, client);
      assert.equal(opened.windowMs, 0);
    }
    const flagged = await open({ delegated: true, sessionId: "perm-flagged" });
    assert.equal(flagged.id, null);
    const task = store.createTask({ title: "codex task", prompt: "p", workspace: "pilot", repo: null, cwd: box.repoA, addDirs: [], runner: "codex", model: null, permissionMode: null, sandbox: null, createdBy: null, originSessionId: null, originClient: null });
    const run = store.beginRun({ taskId: task.id, kind: "launch", runner: "codex", prompt: "p", model: null, permissionMode: null, sessionId: "thread-delegated", startCommit: null });
    store.finishRun({ runId: run.id, taskId: task.id, status: "completed", effectiveModel: null, sessionId: "thread-delegated", result: "ok", error: null, exitCode: 0 });
    const delegatedCodex = await open({ agent: "codex", sessionId: "thread-delegated" });
    assert.equal(delegatedCodex.id, null);
  });
});

describe("waiting and deciding", () => {
  it("answers a waiting hook with the decision, accepting the token in a header or the query", async () => {
    const opened = await open({ sessionId: "perm-wait" });
    const forbidden = await fetch(`${hub.web.base}/api/permissions/${opened.id}/wait`);
    assert.equal(forbidden.status, 403);
    const wrong = await fetch(`${hub.web.base}/api/permissions/${opened.id}/wait`, { headers: { "x-hub-wait-token": "nope" } });
    assert.equal(wrong.status, 403);
    const waiting = fetch(`${hub.web.base}/api/permissions/${opened.id}/wait?token=${opened.waitToken}`);
    await s2Until(() => (permissions.getPermissionRequest(opened.id as string) ? true : null));
    const decided = await hub.http("POST", `/api/permissions/${opened.id}/decision`, { behavior: "deny", message: "  not now  " });
    assert.equal(decided.status, 200, decided.text);
    assert.equal((decided.json as { ok: boolean }).ok, true);
    const answer = (await (await waiting).json()) as { decision: { behavior: string; message: string } };
    assert.deepEqual(answer.decision, { behavior: "deny", message: "not now" });
    const late = await fetch(`${hub.web.base}/api/permissions/${opened.id}/wait`, { headers: { "x-hub-wait-token": opened.waitToken as string } });
    assert.equal(((await late.json()) as { decision: unknown }).decision !== undefined, true);
    const gone = await hub.http("GET", "/api/permissions/ghost/wait");
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.json, { decision: null });
  });

  it("withdraws a request when the waiting hook disconnects", async () => {
    const opened = await open({ sessionId: "perm-abort" });
    const controller = new AbortController();
    const waiting = fetch(`${hub.web.base}/api/permissions/${opened.id}/wait`, { headers: { "x-hub-wait-token": opened.waitToken as string }, signal: controller.signal }).catch(() => null);
    await s2Until(() => (permissions.getPermissionRequest(opened.id as string) ? true : null));
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await waiting;
    await s2Until(() => (permissions.getPermissionRequest(opened.id as string) === null ? true : null), 10_000);
  });

  it("validates decisions and releases", async () => {
    const bad = await hub.http("POST", "/api/permissions/whatever/decision", { behavior: "maybe" });
    assert.equal(bad.status, 400);
    assert.match(errorOf(bad.json), /behavior must be allow or deny/);
    const unknown = await hub.http("POST", "/api/permissions/whatever/decision", { behavior: "allow" });
    assert.equal(unknown.status, 404);
    assert.match(errorOf(unknown.json), /no pending permission request/);
    assert.equal((await hub.http("POST", "/api/permissions/whatever/release")).status, 404);
    const opened = await open({ sessionId: "perm-release" });
    const released = await hub.http("POST", `/api/permissions/${opened.id}/release`);
    assert.equal(released.status, 200);
    assert.equal((released.json as { ok: boolean }).ok, true);
  });

  it("allows a plain tool and a deny without a message", async () => {
    const allow = await open({ sessionId: "perm-allow" });
    const res = await hub.http("POST", `/api/permissions/${allow.id}/decision`, { behavior: "allow" });
    assert.equal(res.status, 200, res.text);
    const deny = await open({ sessionId: "perm-deny" });
    const denied = await hub.http("POST", `/api/permissions/${deny.id}/decision`, { behavior: "deny", message: 5 });
    assert.equal(denied.status, 200, denied.text);
  });

  it("never allows AskUserQuestion or ExitPlanMode without their input", async () => {
    const question = { questions: [{ question: "Which colour?", options: [{ label: "red" }] }] };
    const ask = await open({ sessionId: "perm-ask", toolName: "AskUserQuestion", toolInput: question });
    const missing = await hub.http("POST", `/api/permissions/${ask.id}/decision`, { behavior: "allow" });
    assert.equal(missing.status, 400);
    assert.match(errorOf(missing.json), /answers required/);
    const wrongKey = await hub.http("POST", `/api/permissions/${ask.id}/decision`, { behavior: "allow", answers: { "Other?": "x" } });
    assert.equal(wrongKey.status, 400);
    const answered = await hub.http("POST", `/api/permissions/${ask.id}/decision`, { behavior: "allow", answers: { "Which colour?": " red " } });
    assert.equal(answered.status, 200, answered.text);
    const decision = (answered.json as { request: unknown }).request;
    assert.ok(decision !== undefined);

    const plan = await open({ sessionId: "perm-plan", toolName: "ExitPlanMode", toolInput: { plan: "do it" } });
    const approved = await hub.http("POST", `/api/permissions/${plan.id}/decision`, { behavior: "allow" });
    assert.equal(approved.status, 200, approved.text);
    const noInput = await open({ sessionId: "perm-plan-empty", toolName: "ExitPlanMode", toolInput: null });
    const refused = await hub.http("POST", `/api/permissions/${noInput.id}/decision`, { behavior: "allow" });
    assert.equal(refused.status, 400);
    assert.match(errorOf(refused.json), /no plan input/);
    const denyPlan = await hub.http("POST", `/api/permissions/${noInput.id}/decision`, { behavior: "deny", message: "no" });
    assert.equal(denyPlan.status, 200, denyPlan.text);
  });
});

describe("permission timers", () => {
  const input = { agent: "claude" as const, sessionId: "perm-timers", agentId: null, toolName: "Bash", toolInput: { command: "ls" }, cwd: null, turnId: null, title: null };

  it("expires a request after its window", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const opened = permissions.openPermissionRequest(input, 500, { graceMs: 100_000 });
    assert.ok(opened);
    assert.ok(permissions.getPermissionRequest(opened.record.id));
    t.mock.timers.tick(500);
    assert.equal(permissions.getPermissionRequest(opened.record.id), null);
  });

  it("withdraws a request nobody started waiting for", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const opened = permissions.openPermissionRequest(input, 60_000, { graceMs: 50 });
    assert.ok(opened);
    t.mock.timers.tick(49);
    assert.ok(permissions.getPermissionRequest(opened.record.id));
    t.mock.timers.tick(1);
    assert.equal(permissions.getPermissionRequest(opened.record.id), null);
  });

  it("keeps a request whose waiter attached before the grace period ended", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const opened = permissions.openPermissionRequest(input, 60_000, { graceMs: 50 });
    assert.ok(opened);
    const attached = permissions.waitForDecision(opened.record.id, opened.waitToken, () => undefined);
    assert.equal(attached.status, "waiting");
    t.mock.timers.tick(100);
    assert.ok(permissions.getPermissionRequest(opened.record.id));
    permissions.withdrawPermission(opened.record.id);
  });

  it("forgets an answered decision that no hook came to collect", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const opened = permissions.openPermissionRequest(input, 60_000, { graceMs: 100_000 });
    assert.ok(opened);
    permissions.decidePermission(opened.record.id, { behavior: "allow", message: null });
    const stillThere = permissions.waitForDecision(opened.record.id, "wrong-token", () => undefined);
    assert.equal(stillThere.status, "forbidden");
    t.mock.timers.tick(permissions.LATE_WAITER_MS);
    assert.deepEqual(permissions.waitForDecision(opened.record.id, opened.waitToken, () => undefined), { status: "gone" });
  });
});

describe("session moves and bulk clearing", () => {
  const input = (over: Partial<Parameters<typeof permissions.openPermissionRequest>[0]> = {}) => ({ agent: "claude" as const, sessionId: "perm-moves", agentId: null, toolName: "Bash", toolInput: { command: "ls" }, cwd: null, turnId: null, title: null, ...over });
  const open = (over: Partial<Parameters<typeof permissions.openPermissionRequest>[0]> = {}) => {
    const opened = permissions.openPermissionRequest(input(over), 60_000, { graceMs: 60_000 });
    assert.ok(opened);
    return opened.record.id;
  };

  it("derives the move of a Claude hook from its kind", () => {
    const facts = (over: Record<string, unknown>) => ({ kind: "stop", sessionId: "s", agentId: null, notificationType: null, toolName: null, toolInput: undefined, ...over });
    assert.equal(permissions.claudeSessionMove(facts({ kind: "tool_done", toolName: "Bash" }))?.scope, "tool");
    assert.equal(permissions.claudeSessionMove(facts({ kind: "tool_done" })), null);
    assert.equal(permissions.claudeSessionMove(facts({ kind: "subagent_stop", agentId: "a1" }))?.scope, "agent");
    assert.equal(permissions.claudeSessionMove(facts({ kind: "subagent_stop" })), null);
    assert.equal(permissions.claudeSessionMove(facts({ kind: "user_prompt" }))?.scope, "session");
    assert.equal(permissions.claudeSessionMove(facts({ kind: "session_end" }))?.scope, "session");
    assert.equal(permissions.claudeSessionMove(facts({ kind: "stop" }))?.scope, "turn");
    assert.equal(permissions.claudeSessionMove(facts({ kind: "stop_failure" }))?.scope, "turn");
    assert.equal(permissions.claudeSessionMove(facts({ kind: "notification", notificationType: "idle_prompt" }))?.scope, "session");
    assert.equal(permissions.claudeSessionMove(facts({ kind: "notification", notificationType: "auth_success" })), null);
    assert.equal(permissions.claudeSessionMove(facts({ kind: "session_start" })), null);
  });

  it("clears the requests that a move supersedes, by scope", () => {
    permissions.clearAllPermissions();
    const move = (scope: "tool" | "turn" | "agent" | "session", over: Record<string, unknown> = {}) => ({ agent: "claude" as const, sessionId: "perm-moves", agentId: null, scope, toolName: "Bash", toolInput: { command: "ls" }, ...over });
    const turn = open();
    const sub = open({ agentId: "sub-1" });
    const other = open({ sessionId: "someone-else" });
    const codex = open({ agent: "codex" });
    assert.ok(permissions.hasPendingPermission("claude", "perm-moves"));
    assert.equal(permissions.hasPendingPermission("claude", "nobody"), false);
    assert.deepEqual(permissions.clearForSessionMove(move("turn")).map((record) => record.id), [turn]);
    assert.deepEqual(permissions.clearForSessionMove(move("agent", { agentId: "sub-1" })).map((record) => record.id), [sub]);
    const tool = open({ toolInput: { command: "pwd" } });
    const sameTool = open({ toolInput: { command: "whoami" } });
    assert.deepEqual(permissions.clearForSessionMove(move("tool", { toolInput: { command: "nothing like it" } })), []);
    assert.deepEqual(permissions.clearForSessionMove(move("tool", { toolInput: { command: "whoami" } })).map((record) => record.id), [sameTool]);
    assert.deepEqual(permissions.clearForSessionMove(move("tool", { toolInput: undefined })).map((record) => record.id), [tool]);
    assert.ok(permissions.getPermissionRequest(other));
    assert.ok(permissions.getPermissionRequest(codex));
    const a = open();
    const b = open({ agentId: "sub-2" });
    assert.equal(permissions.clearForSessionMove(move("session")).length, 2);
    assert.equal(permissions.getPermissionRequest(a), null);
    assert.equal(permissions.getPermissionRequest(b), null);
    const listed = permissions.listPermissionRequests().map((record) => record.id);
    assert.deepEqual(listed, [other, codex]);
    permissions.clearAllPermissions();
    assert.deepEqual(permissions.listPermissionRequests(), []);
    assert.equal(permissions.decidePermission("ghost", { behavior: "deny", message: "x".repeat(5000) }), null);
    assert.equal(permissions.withdrawPermission("ghost"), null);
  });

  it("truncates a long deny message and carries the updated input of an allow", () => {
    const denied = permissions.openPermissionRequest(input(), 60_000, { graceMs: 60_000 });
    assert.ok(denied);
    const seen: (import("../src/permissions.js").PermissionDecision | null)[] = [];
    permissions.waitForDecision(denied.record.id, denied.waitToken, (decision) => seen.push(decision));
    permissions.decidePermission(denied.record.id, { behavior: "deny", message: "x".repeat(5000) });
    assert.equal(seen[0]?.message?.length, permissions.DECISION_MESSAGE_MAX);
    const allowed = permissions.openPermissionRequest(input(), 60_000, { graceMs: 60_000 });
    assert.ok(allowed);
    permissions.waitForDecision(allowed.record.id, allowed.waitToken, (decision) => seen.push(decision));
    permissions.decidePermission(allowed.record.id, { behavior: "allow", message: "ignored", updatedInput: { plan: "go" } });
    assert.deepEqual(seen[1], { behavior: "allow", message: null, updatedInput: { plan: "go" } });
  });
});
