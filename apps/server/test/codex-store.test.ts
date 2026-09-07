import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const tmp = mkdtempSync(join(tmpdir(), "cch-codex-store-"));
const codexHome = join(tmp, "codex");
process.env.HUB_DATA_DIR = join(tmp, "data");
process.env.CODEX_HOME = codexHome;
delete process.env.HUB_RESOURCE_DIR;

const THREAD_ID = "01a0aaaa-0000-7000-8000-000000000001";

type Store = typeof import("../src/codex-store.js");
type Delegation = typeof import("../src/delegation-store.js");
type Db = typeof import("../src/db.js");
let store: Store;
let delegation: Delegation;
let db: Db["db"];

before(async () => {
  const now = new Date();
  const day = join(
    codexHome,
    "sessions",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  );
  mkdirSync(day, { recursive: true });
  copyFileSync(join(fixtures, "rollout-sample.jsonl"), join(day, "rollout-sample.jsonl"));
  store = await import("../src/codex-store.js");
  delegation = await import("../src/delegation-store.js");
  ({ db } = await import("../src/db.js"));
});

const findThread = () => store.listCodexSessions().find((session) => session.id === THREAD_ID);

describe("codex thread store", () => {
  it("marks a thread launched by the hub as via-hub and ended when its run finished", () => {
    const task = delegation.createTask({
      title: "codex run",
      prompt: "do it",
      workspace: "pilot",
      repo: null,
      cwd: tmp,
      addDirs: [],
      runner: "codex",
      model: null,
      permissionMode: null,
      sandbox: null,
      createdBy: "test",
      originSessionId: null,
      originClient: null,
    });
    const run = delegation.beginRun({
      taskId: task.id,
      kind: "launch",
      runner: "codex",
      prompt: "do it",
      model: null,
      permissionMode: null,
      sessionId: THREAD_ID,
    });
    delegation.finishRun({
      runId: run.id,
      taskId: task.id,
      status: "completed",
      effectiveModel: null,
      sessionId: THREAD_ID,
      result: "done",
      error: null,
      exitCode: 0,
    });
    assert.deepEqual(
      delegation.listCodexRunLinks(),
      [{ threadId: THREAD_ID, taskId: task.id, latestRunStatus: "completed", taskTitle: "codex run" }],
    );
    const thread = findThread();
    assert.equal(thread?.title, "codex run");
    assert.equal(thread?.origin, "hub");
    assert.equal(thread?.hubTaskId, task.id);
    assert.equal(thread?.status, "ended");
  });

  it("sets and clears a custom title", () => {
    store.setCodexTitle(THREAD_ID, "  My renamed thread  ");
    assert.equal(findThread()?.customTitle, "My renamed thread");
    store.setCodexTitle(THREAD_ID, null);
    assert.equal(findThread()?.customTitle, null);
  });

  it("archives and unarchives without removing the thread from the list", () => {
    store.archiveCodexThread(THREAD_ID);
    assert.equal(typeof findThread()?.archivedAt, "number");
    store.unarchiveCodexThread(THREAD_ID);
    assert.equal(findThread()?.archivedAt, null);
  });

  it("hides a deleted thread from the list", () => {
    store.hideCodexThread(THREAD_ID);
    assert.equal(findThread(), undefined);
  });
});

after(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
