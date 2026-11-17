import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { s2Git, s2InitRepo, s2Sandbox, s2StartHub, s2Until, type S2Hub } from "./helpers/s2-env.js";

const box = s2Sandbox("cch-s2-tasks-", { HUB_DELEGATION: "1" });

const { db, applyHook } = await import("../src/db.js");
const store = await import("../src/delegation-store.js");
const { rolloutChangedSinceHubRun } = await import("../src/codex-rollout-mark.js");
const { recordCodexHook, clearCodexLive } = await import("../src/codex-live.js");
const { abortActiveRuns } = await import("../src/delegation-launch.js");

let hub: S2Hub;

interface TaskJson {
  id: string;
  status: string;
  title: string;
  sessionId: string | null;
  originSessionId: string | null;
  originClient: string | null;
  isolation: string;
  isolationReason: string | null;
  worktreePath: string | null;
  branch: string | null;
  archivedAt: number | null;
  portEnd: number | null;
  mergedAt: number | null;
}

interface DetailJson {
  task: TaskJson;
  runs: { status: string; startCommit: string | null }[];
  note?: string;
  worktree: { exists: boolean; commits: unknown[]; hint: string } | null;
}

before(async () => {
  s2InitRepo(box.repoA);
  s2InitRepo(box.repoB);
  hub = await s2StartHub(box);
  const settings = await hub.http("PUT", "/delegation/settings", { workspacesRoot: box.root, autonomy: "full" });
  assert.equal(settings.status, 200, settings.text);
});

after(async () => {
  abortActiveRuns("test over");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await hub.close();
  if (db.open) db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const settled = (id: string, runs = 1): Promise<DetailJson> =>
  s2Until(async () => {
    const detail = (await hub.http("GET", `/delegation/tasks/${id}`)).json as DetailJson;
    return detail.runs.length >= runs && !["pending", "running"].includes(detail.task.status) ? detail : null;
  }, 20_000);

function insertTask(title: string, extra: Partial<Parameters<typeof store.createTask>[0]> = {}) {
  return store.createTask({
    title,
    prompt: `${title} prompt`,
    workspace: "pilot",
    repo: null,
    cwd: box.repoA,
    addDirs: [],
    runner: "claude",
    model: null,
    permissionMode: null,
    sandbox: null,
    createdBy: null,
    originSessionId: null,
    originClient: null,
    ...extra,
  });
}

function finishedTask(title: string, status: "completed" | "failed" = "completed", extra: Partial<Parameters<typeof store.createTask>[0]> = {}) {
  const task = insertTask(title, extra);
  const run = store.beginRun({ taskId: task.id, kind: "launch", runner: task.runner, prompt: "p", model: null, permissionMode: null, sessionId: extra.runner === "codex" ? `thread-${task.id.slice(0, 8)}` : `sess-${task.id.slice(0, 8)}`, startCommit: null });
  store.finishRun({ runId: run.id, taskId: task.id, status, effectiveModel: null, sessionId: run.sessionId, result: "done", error: null, exitCode: 0 });
  return store.getTask(task.id)!;
}

function sessionHook(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "session_start" as const,
    sessionId,
    cwd: box.repoA,
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
    ...extra,
  };
}

describe("task listing", () => {
  it("filters by status, limit, archived flag and origin", async () => {
    const a = finishedTask("list-a");
    const b = finishedTask("list-b", "failed");
    await hub.http("POST", `/delegation/tasks/${b.id}/archive`);
    const all = (await hub.http("GET", "/delegation/tasks")).json as TaskJson[];
    assert.ok(all.some((item) => item.id === a.id));
    assert.ok(!all.some((item) => item.id === b.id));
    const withArchived = (await hub.http("GET", "/delegation/tasks?archived=1")).json as TaskJson[];
    assert.ok(withArchived.some((item) => item.id === b.id));
    const failed = (await hub.http("GET", "/delegation/tasks?status=failed&archived=true&limit=5")).json as TaskJson[];
    assert.ok(failed.length >= 1 && failed.every((item) => item.status === "failed"));
    const limited = (await hub.http("GET", "/delegation/tasks?limit=1")).json as TaskJson[];
    assert.equal(limited.length, 1);
    const bad = await hub.http("GET", "/delegation/tasks?status=nonsense");
    assert.equal(bad.status, 400);
    assert.match((bad.json as { error: string }).error, /status must be one of/);

    applyHook(sessionHook("origin-list"));
    const owned = finishedTask("owned", "completed", { originSessionId: "origin-list", originClient: "claude-code" });
    const byOrigin = (await hub.http("GET", "/delegation/tasks?origin=origin-list&limit=3")).json as TaskJson[];
    assert.deepEqual(byOrigin.map((item) => item.id), [owned.id]);
  });
});

describe("task detail routes", () => {
  it("returns 404 for unknown tasks and resolves an id prefix", async () => {
    assert.equal((await hub.http("GET", "/delegation/tasks/does-not-exist")).status, 404);
    assert.equal((await hub.http("GET", "/delegation/tasks/does-not-exist/worktree")).status, 404);
    assert.equal((await hub.http("GET", "/delegation/tasks/does-not-exist/events")).status, 404);
    assert.equal((await hub.http("POST", "/delegation/tasks/does-not-exist/merge")).status, 404);
    assert.equal((await hub.http("POST", "/delegation/tasks/does-not-exist/worktree/discard")).status, 404);
    assert.equal((await hub.http("POST", "/delegation/tasks/does-not-exist/archive")).status, 404);
    assert.equal((await hub.http("POST", "/delegation/tasks/does-not-exist/unarchive")).status, 404);
    assert.equal((await hub.http("POST", "/delegation/tasks/does-not-exist/continue", { prompt: "x" })).status, 404);
    assert.equal((await hub.http("PATCH", "/delegation/tasks/does-not-exist/origin", { originSessionId: "x" })).status, 404);
    const task = finishedTask("prefix task");
    const byPrefix = await hub.http("GET", `/delegation/tasks/${task.id.slice(0, 8)}`);
    assert.equal(byPrefix.status, 200);
    const detail = byPrefix.json as DetailJson;
    assert.equal(detail.task.id, task.id);
    assert.equal(detail.worktree, null);
    const events = await hub.http("GET", `/delegation/tasks/${task.id}/events`);
    assert.equal(events.status, 200);
    assert.ok(Array.isArray(events.json));
    const noTree = await hub.http("GET", `/delegation/tasks/${task.id}/worktree`);
    assert.equal(noTree.status, 404);
  });
});

describe("creating tasks", () => {
  it("rejects bad input and unknown targets", async () => {
    const noPrompt = await hub.http("POST", "/delegation/tasks", { workspace: "pilot" });
    assert.equal(noPrompt.status, 400);
    const badRunner = await hub.http("POST", "/delegation/tasks", { prompt: "x", workspace: "pilot", runner: "gpt" });
    assert.equal(badRunner.status, 400);
    const noWorkspace = await hub.http("POST", "/delegation/tasks", { prompt: "x", workspace: "ghost" });
    assert.equal(noWorkspace.status, 404);
  });

  it("launches a task, attributes it to the calling Claude session and finishes the run", async () => {
    applyHook(sessionHook("origin-create", { claudePid: 987_001 }));
    const created = await hub.http("POST", "/delegation/tasks", { prompt: "first task", workspace: "pilot", title: "Created", originPid: 987_001 });
    assert.equal(created.status, 201, created.text);
    const detail = created.json as DetailJson;
    assert.equal(detail.task.originSessionId, "origin-create");
    assert.equal(detail.task.originClient, "claude-code");
    assert.ok(detail.task.portEnd !== null);
    const done = await settled(detail.task.id);
    assert.equal(done.task.status, "completed");
  });

  it("takes the origin from the explicit session id, the environment session id or the client hint", async () => {
    applyHook(sessionHook("origin-explicit"));
    const explicit = await hub.http("POST", "/delegation/tasks", { prompt: "explicit", workspace: "pilot", originSessionId: "origin-explicit" });
    assert.equal((explicit.json as DetailJson).task.originSessionId, "origin-explicit");
    applyHook(sessionHook("origin-env", { client: "share" }));
    const env = await hub.http("POST", "/delegation/tasks", { prompt: "env", workspace: "pilot", originEnvSessionId: "origin-env" });
    assert.equal((env.json as DetailJson).task.originClient, "share");
    const badEnvId = await hub.http("POST", "/delegation/tasks", { prompt: "bad env", workspace: "pilot", originEnvSessionId: "not valid!", originClient: "codex" });
    assert.equal((badEnvId.json as DetailJson).task.originClient, "codex");
    const unknownPid = await hub.http("POST", "/delegation/tasks", { prompt: "pid", workspace: "pilot", originPid: 987_654 });
    assert.equal((unknownPid.json as DetailJson).task.originClient, null);
    const badHint = await hub.http("POST", "/delegation/tasks", { prompt: "hint", workspace: "pilot", originClient: "nobody" });
    assert.equal(badHint.status, 400);
    for (const created of [explicit, env, badEnvId, unknownPid]) await settled((created.json as DetailJson).task.id);
  });

  it("isolates a second task of a busy repo in a worktree, then merges and discards worktrees", async () => {
    const first = await hub.http("POST", "/delegation/tasks", { prompt: "sleep:30000", workspace: "pilot", repo: "repo-a", isolation: "shared" });
    assert.equal(first.status, 201, first.text);
    const firstId = (first.json as DetailJson).task.id;
    const second = await hub.http("POST", "/delegation/tasks", { prompt: "second", workspace: "pilot", repo: "repo-a" });
    assert.equal(second.status, 201, second.text);
    const body = second.json as DetailJson;
    assert.equal(body.task.isolation, "worktree");
    assert.equal(body.task.isolationReason, "busy-repo");
    assert.match(body.note ?? "", /already has a task running in the shared checkout/);
    await settled(body.task.id);

    const running = await hub.http("POST", `/delegation/tasks/${firstId}/merge`);
    assert.equal(running.status, 409);
    const runningDiscard = await hub.http("POST", `/delegation/tasks/${firstId}/worktree/discard`);
    assert.equal(runningDiscard.status, 409);
    const runningArchive = await hub.http("POST", `/delegation/tasks/${firstId}/archive`);
    assert.equal(runningArchive.status, 409);

    const treePath = store.getTask(body.task.id)!.worktreePath!;
    assert.ok(existsSync(treePath));
    const status = await hub.http("GET", `/delegation/tasks/${body.task.id}/worktree`);
    assert.equal(status.status, 200);
    assert.equal((status.json as { exists: boolean }).exists, true);
    const full = (await hub.http("GET", `/delegation/tasks/${body.task.id}`)).json as DetailJson;
    assert.equal(full.worktree?.exists, true);

    const nothing = await hub.http("POST", `/delegation/tasks/${body.task.id}/merge`);
    assert.equal(nothing.status, 409);
    assert.equal((nothing.json as { error: string }).error, "nothing to merge");

    writeFileSync(join(treePath, "feature.txt"), "from the task\n");
    s2Git(treePath, "add", "-A");
    s2Git(treePath, "commit", "-q", "-m", "task work");
    const merged = await hub.http("POST", `/delegation/tasks/${body.task.id}/merge`);
    assert.equal(merged.status, 200, merged.text);
    assert.ok((merged.json as TaskJson).mergedAt !== null);
    assert.equal(s2Git(box.repoA, "show", "HEAD:feature.txt"), "from the task");

    const discarded = await hub.http("POST", `/delegation/tasks/${body.task.id}/worktree/discard`);
    assert.equal(discarded.status, 200, discarded.text);
    assert.equal((discarded.json as TaskJson).worktreePath, null);

    const cancelled = await hub.http("POST", `/delegation/tasks/${firstId}/cancel`);
    assert.equal(cancelled.status, 202);
    await settled(firstId);
    const again = await hub.http("POST", `/delegation/tasks/${firstId}/cancel`);
    assert.equal(again.status, 409);
  });

  it("reports a worktree error when the requested repo is not a git checkout", async () => {
    const plain = join(box.tmp, "plain-repo");
    mkdirSync(plain, { recursive: true });
    const noRepo = await hub.http("POST", "/delegation/tasks", { prompt: "x", workspace: "pilot", isolation: "worktree" });
    assert.equal(noRepo.status, 400);
    assert.match((noRepo.json as { error: string }).error, /requires a repo/);
  });
});

describe("continuing tasks", () => {
  it("validates the request before starting a run", async () => {
    const task = finishedTask("continue me");
    assert.equal((await hub.http("POST", `/delegation/tasks/${task.id}/continue`, {})).status, 400);
    const badMode = await hub.http("POST", `/delegation/tasks/${task.id}/continue`, { prompt: "more", permissionMode: "chaos" });
    assert.equal(badMode.status, 400);
    const gone = finishedTask("gone dir", "completed", { cwd: join(box.tmp, "vanished") });
    const missing = await hub.http("POST", `/delegation/tasks/${gone.id}/continue`, { prompt: "more" });
    assert.equal(missing.status, 400);
    assert.match((missing.json as { error: string }).error, /working directory no longer exists/);
  });

  it("continues a finished task, then refuses a second run while one is active", async () => {
    const task = finishedTask("continue ok");
    const started = await hub.http("POST", `/delegation/tasks/${task.id}/continue`, { prompt: "sleep:600", model: "fake-model" });
    assert.equal(started.status, 201, started.text);
    const busy = await hub.http("POST", `/delegation/tasks/${task.id}/continue`, { prompt: "again" });
    assert.equal(busy.status, 409);
    assert.equal((busy.json as { error: string }).error, "task already running");
    await hub.http("POST", `/delegation/tasks/${task.id}/cancel`);
    await settled(task.id, 2);
  });

  it("launches a fresh run when the task never got a session", async () => {
    const task = insertTask("never started");
    const started = await hub.http("POST", `/delegation/tasks/${task.id}/continue`, { prompt: "start now" });
    assert.equal(started.status, 201, started.text);
    const done = await settled(task.id);
    assert.equal(done.task.status, "completed");
  });
});

describe("origin and archive", () => {
  it("links a task to a known session and archives and restores it", async () => {
    const task = finishedTask("origin target");
    const noSession = await hub.http("PATCH", `/delegation/tasks/${task.id}/origin`, { originSessionId: "unknown-session" });
    assert.equal(noSession.status, 400);
    applyHook(sessionHook("origin-patch"));
    const linked = await hub.http("PATCH", `/delegation/tasks/${task.id}/origin`, { originSessionId: "origin-patch" });
    assert.equal(linked.status, 200);
    assert.equal((linked.json as TaskJson).originSessionId, "origin-patch");
    assert.equal((linked.json as TaskJson).originClient, "claude-code");
    const archived = await hub.http("POST", `/delegation/tasks/${task.id}/archive`);
    assert.ok((archived.json as TaskJson).archivedAt !== null);
    const restored = await hub.http("POST", `/delegation/tasks/${task.id}/unarchive`);
    assert.equal((restored.json as TaskJson).archivedAt, null);
  });
});

describe("codex replies", () => {
  it("explains why a thread cannot take a reply", async () => {
    clearCodexLive();
    const unknown = await hub.http("POST", "/delegation/codex/thread-unknown/reply", { text: "hi" });
    assert.equal((unknown.json as { code: string }).code, "not-hub-thread");

    const task = finishedTask("codex task", "completed", { runner: "codex" });
    const threadId = `thread-${task.id.slice(0, 8)}`;
    const noText = await hub.http("POST", `/delegation/codex/${threadId}/reply`, {});
    assert.equal(noText.status, 400);
    assert.equal((noText.json as { error: string }).error, "text required");

    recordCodexHook({ event: "UserPromptSubmit", sessionId: threadId, cwd: box.repoA, transcriptPath: null, model: null, toolName: null, toolInput: null, lastAssistantMessage: null, delegated: false });
    const open = await hub.http("POST", `/delegation/codex/${threadId}/reply`, { text: "hi" });
    assert.equal((open.json as { code: string }).code, "open-elsewhere");
    clearCodexLive();

    const gone = finishedTask("codex gone", "completed", { runner: "codex", cwd: join(box.tmp, "vanished-codex") });
    const goneThread = `thread-${gone.id.slice(0, 8)}`;
    const missing = await hub.http("POST", `/delegation/codex/${goneThread}/reply`, { text: "hi" });
    assert.equal(missing.status, 400);
    assert.match((missing.json as { error: string }).error, /working directory no longer exists/);
    assert.equal(rolloutChangedSinceHubRun(goneThread), false);
  });

  it("refuses a thread that is no longer the task's current thread and accepts the current one", async () => {
    const task = finishedTask("codex current", "completed", { runner: "codex" });
    const run = store.beginRun({ taskId: task.id, kind: "continue", runner: "codex", prompt: "p", model: null, permissionMode: null, sessionId: "thread-newer", startCommit: null });
    store.finishRun({ runId: run.id, taskId: task.id, status: "completed", effectiveModel: null, sessionId: "thread-newer", result: "ok", error: null, exitCode: 0 });
    const stale = await hub.http("POST", `/delegation/codex/thread-${task.id.slice(0, 8)}/reply`, { text: "hi" });
    assert.equal((stale.json as { code: string }).code, "not-current-thread");
  });
});
