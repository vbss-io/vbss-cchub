import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fixtures } from "./helpers.js";
import { s2Git, s2InitRepo, s2Sandbox, s2StartHub, s2Until, type S2Hub } from "./helpers/s2-env.js";

const box = s2Sandbox("cch-s2-review-", { HUB_DELEGATION: "1" });

const { db, applyHook } = await import("../src/db.js");
const store = await import("../src/delegation-store.js");
const gh = await import("../src/gh.js");
const { abortActiveRuns, isTaskActive } = await import("../src/delegation-launch.js");
const { recordCodexHook, clearCodexLive } = await import("../src/codex-live.js");

let hub: S2Hub;

interface DetailJson {
  task: { id: string; status: string; sessionId: string | null; worktreePath: string | null };
  runs: { id: string; startCommit: string | null; status: string }[];
}

const useFakeGh = (mode: string): void => {
  process.env.HUB_GH_BIN = process.execPath;
  process.env.HUB_GH_ARGS_PREFIX = JSON.stringify([join(fixtures, "fake-gh.mjs")]);
  process.env.FAKE_GH_MODE = mode;
  gh.resetGhCache();
};

before(async () => {
  s2InitRepo(box.repoA, { "a.txt": "one\ntwo\nthree\n" });
  hub = await s2StartHub(box);
  const settings = await hub.http("PUT", "/delegation/settings", { workspacesRoot: box.root, autonomy: "full" });
  assert.equal(settings.status, 200, settings.text);
  useFakeGh("");
});

after(async () => {
  abortActiveRuns("test over");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await hub.close();
  if (db.open) db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const errorOf = (json: unknown): string => (json as { error: string }).error;
const settled = (id: string, runs = 1): Promise<DetailJson> =>
  s2Until(async () => {
    const detail = (await hub.http("GET", `/delegation/tasks/${id}`)).json as DetailJson;
    return detail.runs.length >= runs && !["pending", "running"].includes(detail.task.status) ? detail : null;
  }, 20_000);

function finishedTask(title: string, cwd: string) {
  const task = store.createTask({ title, prompt: "p", workspace: "pilot", repo: null, cwd, addDirs: [], runner: "claude", model: null, permissionMode: null, sandbox: null, createdBy: null, originSessionId: null, originClient: null });
  const run = store.beginRun({ taskId: task.id, kind: "launch", runner: "claude", prompt: "p", model: null, permissionMode: null, sessionId: null, startCommit: null });
  store.finishRun({ runId: run.id, taskId: task.id, status: "completed", effectiveModel: null, sessionId: null, result: "ok", error: null, exitCode: 0 });
  return task;
}

const comment = (file: string, line: number, text: string, side?: string) => ({ file, line, text, ...(side ? { side } : {}) });

async function launchInRepo(prompt: string): Promise<DetailJson> {
  const created = await hub.http("POST", "/delegation/tasks", { prompt, workspace: "pilot", repo: "repo-a", isolation: "shared" });
  assert.equal(created.status, 201, created.text);
  const detail = await settled((created.json as DetailJson).task.id);
  await s2Until(() => (isTaskActive(detail.task.id) ? null : true), 10_000);
  return detail;
}

describe("task cost, diff and gh", () => {
  it("serves the costs of several tasks and one task, or 404", async () => {
    const detail = await launchInRepo("diff me");
    const costs = await hub.http("GET", `/delegation/costs?taskIds=${detail.task.id},,${detail.task.id}`);
    assert.equal(costs.status, 200);
    assert.ok(detail.task.id in (costs.json as { tasks: Record<string, unknown> }).tasks);
    assert.deepEqual((await hub.http("GET", "/delegation/costs")).json, { tasks: {} });
    assert.equal((await hub.http("GET", `/delegation/tasks/${detail.task.id}/cost`)).status, 200);
    assert.equal((await hub.http("GET", "/delegation/tasks/ghost/cost")).status, 404);
    assert.equal((await hub.http("GET", "/delegation/tasks/ghost/diff")).status, 404);
    assert.equal((await hub.http("POST", "/delegation/tasks/ghost/review", { comments: [] })).status, 404);
    assert.equal((await hub.http("GET", "/delegation/tasks/ghost/gh")).status, 404);
  });

  it("diffs a task against its start commit, with and without a file filter", async () => {
    const detail = await launchInRepo("make changes");
    const start = detail.runs[0]?.startCommit;
    assert.ok(start, "the run recorded its start commit");
    writeFileSync(join(box.repoA, "a.txt"), "one\nTWO\nthree\nfour\n");
    writeFileSync(join(box.repoA, "b.txt"), "brand new\n");
    s2Git(box.repoA, "add", "-A");
    s2Git(box.repoA, "commit", "-q", "-m", "task work");
    const diff = await hub.http("GET", `/delegation/tasks/${detail.task.id}/diff`);
    assert.equal(diff.status, 200, diff.text);
    const body = diff.json as { available: boolean; files: { path: string }[] };
    assert.equal(body.available, true);
    assert.deepEqual(body.files.map((file) => file.path).sort(), ["a.txt", "b.txt"]);
    const byFile = await hub.http("GET", `/delegation/tasks/${detail.task.id}/diff?file=a.txt&runId=${detail.runs[0]?.id}`);
    assert.equal(byFile.status, 200, byFile.text);
    const noFile = await hub.http("GET", `/delegation/tasks/${detail.task.id}/diff?file=${"x".repeat(1100)}`);
    assert.equal(noFile.status, 200);
  });

  it("reports gh status for a task, including the failure modes", async () => {
    const detail = await launchInRepo("gh please");
    const ok = await hub.http("GET", `/delegation/tasks/${detail.task.id}/gh`);
    assert.equal(ok.status, 200, ok.text);
    assert.equal((ok.json as { available: boolean }).available, true);
    useFakeGh("unauth");
    const unauth = await hub.http("GET", `/delegation/tasks/${detail.task.id}/gh`);
    assert.equal((unauth.json as { reason: string }).reason, "gh is not logged in");
    useFakeGh("");
  });
});

describe("sending a review", () => {
  it("validates the comments and refuses while the task is running", async () => {
    const detail = await launchInRepo("review target");
    const id = detail.task.id;
    const cases: [unknown, RegExp][] = [
      [undefined, /comments must be a non-empty array/],
      [[], /comments must be a non-empty array/],
      [[5], /each comment must be an object/],
      [[comment("", 1, "x")], /comment.file must be a single-line path/],
      [[comment("a.txt", 0, "x")], /comment.line must be a positive integer/],
      [[comment("a.txt", 1, "x", "middle")], /comment.side must be new or old/],
      [[comment("a.txt", 1, "  ")], /comment.text required/],
    ];
    for (const [comments, message] of cases) {
      const res = await hub.http("POST", `/delegation/tasks/${id}/review`, { comments });
      assert.equal(res.status, 400, res.text);
      assert.match(errorOf(res.json), message);
    }
    const running = await hub.http("POST", "/delegation/tasks", { prompt: "sleep:30000", workspace: "pilot", repo: "repo-b", isolation: "shared" });
    const runningId = (running.json as DetailJson).task.id;
    const busy = await hub.http("POST", `/delegation/tasks/${runningId}/review`, { comments: [comment("a.txt", 1, "later")] });
    assert.equal(busy.status, 409);
    assert.equal((busy.json as { code: string }).code, "busy");
    await hub.http("POST", `/delegation/tasks/${runningId}/cancel`);
    await settled(runningId);
  });

  it("previews, continues the session and starts a follow-up task when the session cannot continue", async () => {
    const detail = await launchInRepo("review me");
    const id = detail.task.id;
    writeFileSync(join(box.repoA, "a.txt"), "one\nTWO\nthree\nfour\nfive\n");
    s2Git(box.repoA, "add", "-A");
    s2Git(box.repoA, "commit", "-q", "-m", "more work");
    const preview = await hub.http("POST", `/delegation/tasks/${id}/review`, { comments: [comment("a.txt", 2, "why upper case?"), comment("a.txt", 3, "old line", "old")], dryRun: true });
    assert.equal(preview.status, 200, preview.text);
    assert.equal((preview.json as { mode: string }).mode, "preview");
    assert.match((preview.json as { text: string }).text, /why upper case\?/);

    const sent = await hub.http("POST", `/delegation/tasks/${id}/review`, { comments: [comment("a.txt", 2, "please revert")] });
    assert.equal(sent.status, 201, sent.text);
    assert.equal((sent.json as { mode: string }).mode, "continue");
    await settled(id, 2);

    const orphan = finishedTask("no session", box.repoA);
    const follow = await hub.http("POST", `/delegation/tasks/${orphan.id}/review`, { comments: [comment("a.txt", 1, "start over")] });
    assert.equal(follow.status, 201, follow.text);
    assert.equal((follow.json as { mode: string }).mode, "new-task");
    const followId = (follow.json as { taskId: string }).taskId;
    assert.notEqual(followId, orphan.id);
    await settled(followId);

    const lost = finishedTask("gone cwd", join(box.tmp, "vanished"));
    const failed = await hub.http("POST", `/delegation/tasks/${lost.id}/review`, { comments: [comment("a.txt", 1, "x")] });
    assert.equal(failed.status, 500);
    assert.match(errorOf(failed.json), /working directory no longer exists/);
  });

  it("reports a diff for an isolated worktree task", async () => {
    const first = await hub.http("POST", "/delegation/tasks", { prompt: "sleep:30000", workspace: "pilot", repo: "repo-a", isolation: "shared" });
    const firstId = (first.json as DetailJson).task.id;
    const second = await hub.http("POST", "/delegation/tasks", { prompt: "in a tree", workspace: "pilot", repo: "repo-a" });
    const treeId = (second.json as DetailJson).task.id;
    const done = await settled(treeId);
    const tree = done.task.worktreePath as string;
    writeFileSync(join(tree, "tree.txt"), "tree file\n");
    const diff = await hub.http("GET", `/delegation/tasks/${treeId}/diff`);
    assert.equal(diff.status, 200, diff.text);
    s2Git(tree, "add", "-A");
    s2Git(tree, "commit", "-q", "-m", "tree work");
    const committed = (await hub.http("GET", `/delegation/tasks/${treeId}/diff`)).json as { files: { path: string }[] };
    assert.ok(committed.files.some((file) => file.path === "tree.txt"));
    const review = await hub.http("POST", `/delegation/tasks/${treeId}/review`, { comments: [comment("tree.txt", 1, "fine")], dryRun: true });
    assert.equal(review.status, 200, review.text);
    await hub.http("POST", `/delegation/tasks/${firstId}/cancel`);
    await settled(firstId);
  });
});

describe("session diff, review and gh", () => {
  const hookFor = (sessionId: string, cwd: string | null) => ({ kind: "session_start" as const, sessionId, cwd, source: null, hostPid: null, shellPid: null, title: "Reviewed", message: null, notificationType: null, model: null, tokensIn: null, tokensOut: null, contextTokens: null, agentId: null, agentType: null, client: null, claudePid: null, transcriptPath: null, agentMessage: null, shareLabel: null });

  it("answers 404 for unknown sessions", async () => {
    for (const [method, path, body] of [["GET", "/delegation/sessions/ghost/diff"], ["POST", "/delegation/sessions/ghost/review", { comments: [] }], ["GET", "/delegation/sessions/ghost/gh"]] as const) {
      const res = await hub.http(method, path, body);
      assert.equal(res.status, 404, `${path}: ${res.text}`);
    }
  });

  it("diffs the working tree of a session against HEAD and composes a copyable review", async () => {
    applyHook(hookFor("review-session", box.repoA));
    writeFileSync(join(box.repoA, "a.txt"), "one\nTWO\nthree\nfour\nfive\nsix\n");
    const diff = await hub.http("GET", "/delegation/sessions/review-session/diff");
    assert.equal(diff.status, 200, diff.text);
    assert.equal((diff.json as { available: boolean }).available, true);
    const filtered = await hub.http("GET", "/delegation/sessions/review-session/diff?file=a.txt");
    assert.equal(filtered.status, 200);
    const bad = await hub.http("POST", "/delegation/sessions/review-session/review", { comments: [] });
    assert.equal(bad.status, 400);
    const review = await hub.http("POST", "/delegation/sessions/review-session/review", { comments: [comment("a.txt", 6, "extra line")] });
    assert.equal(review.status, 200, review.text);
    assert.equal((review.json as { mode: string }).mode, "copy");
    assert.match((review.json as { text: string }).text, /extra line/);
    const gh = await hub.http("GET", "/delegation/sessions/review-session/gh");
    assert.equal(gh.status, 200, gh.text);
    s2Git(box.repoA, "checkout", "-q", "--", "a.txt");
  });

  it("explains a session without a usable folder", async () => {
    applyHook(hookFor("review-nocwd", null));
    const diff = await hub.http("GET", "/delegation/sessions/review-nocwd/diff");
    assert.equal((diff.json as { available: boolean }).available, false);
    assert.match((diff.json as { reason: string }).reason, /working directory/);
    const review = await hub.http("POST", "/delegation/sessions/review-nocwd/review", { comments: [comment("a.txt", 1, "no tree")] });
    assert.equal(review.status, 200);
    assert.match((review.json as { text: string }).text, /no tree/);
    const gh = await hub.http("GET", "/delegation/sessions/review-nocwd/gh");
    assert.equal((gh.json as { available: boolean }).available, false);
    applyHook(hookFor("review-relative", "relative/dir"));
    const unsafe = await hub.http("GET", "/delegation/sessions/review-relative/diff");
    assert.equal((unsafe.json as { available: boolean }).available, false);
    const unsafeGh = await hub.http("GET", "/delegation/sessions/review-relative/gh");
    assert.equal((unsafeGh.json as { available: boolean }).available, false);
  });

  it("finds a Codex thread by id for the session routes", async () => {
    const thread = "01a0aaaa-0000-7000-8000-000000000001";
    const diff = await hub.http("GET", `/delegation/sessions/${thread}/diff`);
    assert.equal(diff.status, 200, diff.text);
    assert.equal(typeof (diff.json as { available: boolean }).available, "boolean");
    const review = await hub.http("POST", `/delegation/sessions/${thread}/review`, { comments: [comment("a.txt", 1, "codex side")] });
    assert.equal(review.status, 200, review.text);
    const status = await hub.http("GET", `/delegation/sessions/${thread}/gh`);
    assert.equal(status.status, 200, status.text);
  });

  it("starts a follow-up task when a Codex thread is open elsewhere", async () => {
    const task = store.createTask({ title: "codex review", prompt: "p", workspace: "pilot", repo: null, cwd: box.repoA, addDirs: [], runner: "codex", model: null, permissionMode: null, sandbox: null, createdBy: null, originSessionId: null, originClient: null });
    const run = store.beginRun({ taskId: task.id, kind: "launch", runner: "codex", prompt: "p", model: null, permissionMode: null, sessionId: "thread-open-elsewhere", startCommit: null });
    store.finishRun({ runId: run.id, taskId: task.id, status: "completed", effectiveModel: null, sessionId: "thread-open-elsewhere", result: "ok", error: null, exitCode: 0 });
    recordCodexHook({ event: "UserPromptSubmit", sessionId: "thread-open-elsewhere", cwd: box.repoA, transcriptPath: null, model: null, toolName: null, toolInput: null, lastAssistantMessage: null, delegated: false });
    const sent = await hub.http("POST", `/delegation/tasks/${task.id}/review`, { comments: [comment("a.txt", 1, "from review")] });
    clearCodexLive();
    assert.equal(sent.status, 201, sent.text);
    assert.equal((sent.json as { mode: string }).mode, "new-task");
    await settled((sent.json as { taskId: string }).taskId);
  });
});

describe("unreadable files in the working tree", () => {
  const hookFor = (sessionId: string, cwd: string) => ({ kind: "session_start" as const, sessionId, cwd, source: null, hostPid: null, shellPid: null, title: "Locked", message: null, notificationType: null, model: null, tokensIn: null, tokensOut: null, contextTokens: null, agentId: null, agentType: null, client: null, claudePid: null, transcriptPath: null, agentMessage: null, shareLabel: null });

  function lock(path: string): () => void {
    if (process.platform === "win32") {
      const who = process.env.USERNAME ?? "";
      execFileSync("icacls", [path, "/deny", `${who}:(R)`], { stdio: "ignore" });
      return () => {
        execFileSync("icacls", [path, "/remove:d", who], { stdio: "ignore" });
      };
    }
    chmodSync(path, 0o000);
    return () => chmodSync(path, 0o644);
  }

  it("answers 500 instead of crashing when a file cannot be read", { skip: process.platform !== "win32" && process.getuid?.() === 0 }, async () => {
    const detail = await launchInRepo("lock me");
    applyHook(hookFor("review-locked", box.repoA));
    const locked = join(box.repoA, "locked.txt");
    writeFileSync(locked, "secret\n");
    const unlock = lock(locked);
    try {
      const sessionDiff = await hub.http("GET", "/delegation/sessions/review-locked/diff");
      assert.equal(sessionDiff.status, 500, sessionDiff.text);
      const taskDiff = await hub.http("GET", `/delegation/tasks/${detail.task.id}/diff`);
      assert.equal(taskDiff.status, 500, taskDiff.text);
      const review = await hub.http("POST", "/delegation/sessions/review-locked/review", { comments: [comment("locked.txt", 1, "peek")] });
      assert.equal(review.status, 500, review.text);
    } finally {
      unlock();
      rmSync(locked, { force: true });
    }
  });
});

describe("gh helper", () => {
  it("allows only read-only commands and refuses an unsafe directory", async () => {
    await assert.rejects(() => gh.runGh(["pr", "merge", "1"]), /not a read-only command/);
    const unsafe = await gh.runGh(["--version"], "relative/dir");
    assert.deepEqual(unsafe, { ok: false, stdout: "", stderr: "", missing: false });
    const ok = await gh.runGh(["--version"]);
    assert.equal(ok.ok, true);
    assert.match(ok.stdout, /gh version/);
  });

  it("explains an absent or broken gh and a bad directory", async () => {
    const plain = join(box.tmp, "plain-dir");
    mkdirSync(plain, { recursive: true });
    assert.deepEqual(await gh.ghStatus(null), { available: false, reason: "no working directory" });
    assert.deepEqual(await gh.ghStatus(join(box.tmp, "missing-dir")), { available: false, reason: "no working directory" });
    assert.equal(((await gh.ghStatus("relative/dir")) as { available: boolean }).available, false);

    process.env.HUB_GH_BIN = join(box.tmp, "no-such-gh");
    process.env.HUB_GH_ARGS_PREFIX = "not json";
    gh.resetGhCache();
    assert.deepEqual(await gh.ghStatus(plain), { available: false, reason: "gh is not installed" });

    process.env.HUB_GH_BIN = process.execPath;
    process.env.HUB_GH_ARGS_PREFIX = JSON.stringify({ not: "an array" });
    gh.resetGhCache();
    assert.deepEqual(await gh.ghStatus(plain), { available: false, reason: "gh is not logged in" });

    process.env.HUB_GH_ARGS_PREFIX = JSON.stringify(["-e", "process.exit(3)", "--"]);
    gh.resetGhCache();
    assert.deepEqual(await gh.ghStatus(plain), { available: false, reason: "gh could not run" });
    useFakeGh("");
  });

  it("reports a missing branch, an unrelated PR failure and cached answers", async () => {
    const detached = join(box.tmp, "detached");
    s2InitRepo(detached);
    s2Git(detached, "checkout", "-q", "--detach");
    assert.deepEqual(await gh.ghStatus(detached), { available: false, reason: "not on a git branch" });
    const plain = join(box.tmp, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    assert.deepEqual(await gh.ghStatus(plain), { available: false, reason: "not on a git branch" });

    useFakeGh("nopr");
    const noPr = await gh.ghStatus(box.repoA, null, 1000);
    assert.equal((noPr as { available: boolean; pr: unknown }).pr, null);
    const cached = await gh.ghStatus(box.repoA, null, 2000);
    assert.equal(cached, noPr);
    useFakeGh("");
  });
});
