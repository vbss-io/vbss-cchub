import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "cch-store-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.HUB_WORKSPACES_ROOT;
delete process.env.HUB_EDITOR;
delete process.env.HUB_SECOND_BRAIN;

type Store = typeof import("../src/delegation-store.js");
type Db = typeof import("../src/db.js");
let store: Store;
let db: Db["db"];

before(async () => {
  store = await import("../src/delegation-store.js");
  ({ db } = await import("../src/db.js"));
});

const newTask = (title: string, runner: "claude" | "codex" = "claude") =>
  store.createTask({
    title,
    prompt: `do ${title}`,
    workspace: "pilot",
    repo: "repo-a",
    cwd: join(dataDir, "pilot"),
    addDirs: [join(dataDir, "repo-a"), join(dataDir, "repo-b")],
    runner,
    model: null,
    permissionMode: null,
    sandbox: null,
    createdBy: "test",
  });

describe("settings", () => {
  it("falls back to environment defaults and persists updates", () => {
    assert.deepEqual(store.getSettings(), { workspacesRoot: null, editorCommand: "code", secondBrainRoot: null, autonomy: "full", ownerName: userInfo().username });
    const updated = store.updateSettings({ workspacesRoot: dataDir, editorCommand: "cursor", secondBrainRoot: dataDir });
    assert.deepEqual(updated, { workspacesRoot: dataDir, editorCommand: "cursor", secondBrainRoot: dataDir, autonomy: "full", ownerName: userInfo().username });
    assert.equal(store.updateSettings({ ownerName: "Vitor" }).ownerName, "Vitor");
    assert.equal(store.updateSettings({ autonomy: "safe" }).autonomy, "safe");
    store.updateSettings({ autonomy: "full" });
    assert.equal(store.updateSettings({ workspacesRoot: null }).workspacesRoot, null);
    assert.equal(store.getSettings().editorCommand, "cursor");
  });
});

describe("tasks and runs", () => {
  it("persists a task with its workspace snapshot and derives status and session from the run", () => {
    const task = newTask("hello");
    assert.equal(task.status, "pending");
    assert.equal(task.sessionId, null);
    assert.deepEqual(task.addDirs, [join(dataDir, "repo-a"), join(dataDir, "repo-b")]);
    assert.equal(task.createdBy, "test");
    const run = store.beginRun({
      taskId: task.id,
      kind: "launch",
      runner: "claude",
      prompt: "do hello",
      model: null,
      permissionMode: "acceptEdits",
      sessionId: "planned-1",
    });
    assert.equal(run.seq, 1);
    assert.equal(run.runner, "claude");
    assert.equal(store.getTask(task.id)?.status, "running");
    assert.equal(store.getTask(task.id)?.sessionId, null);
    store.finishRun({
      runId: run.id,
      taskId: task.id,
      status: "completed",
      effectiveModel: "fake-default-model",
      sessionId: "observed-1",
      result: "done",
      error: null,
      exitCode: 0,
    });
    const detail = store.getTaskDetail(task.id);
    assert.equal(detail?.task.status, "completed");
    assert.equal(detail?.task.sessionId, "observed-1");
    assert.equal(detail?.runs[0]?.result, "done");
    assert.deepEqual(detail?.reports, []);
  });

  it("keeps the task session null when the launch failed before a session was observed", () => {
    const task = newTask("dead");
    const run = store.beginRun({ taskId: task.id, kind: "launch", runner: "claude", prompt: "p", model: null, permissionMode: null, sessionId: "planned" });
    store.finishRun({ runId: run.id, taskId: task.id, status: "failed", effectiveModel: null, sessionId: null, result: null, error: "ENOENT", exitCode: null });
    assert.equal(store.getTask(task.id)?.sessionId, null);
  });

  it("links continuations with increasing seq and refuses a second run in flight", () => {
    const task = newTask("cont", "codex");
    const first = store.beginRun({ taskId: task.id, kind: "launch", runner: "codex", prompt: "one", model: null, permissionMode: null, sessionId: null });
    assert.throws(
      () => store.beginRun({ taskId: task.id, kind: "continue", runner: "codex", prompt: "two", model: null, permissionMode: null, sessionId: null }),
      store.TaskBusyError,
    );
    store.finishRun({ runId: first.id, taskId: task.id, status: "completed", effectiveModel: null, sessionId: "thread-1", result: "1", error: null, exitCode: 0 });
    const second = store.beginRun({ taskId: task.id, kind: "continue", runner: "codex", prompt: "two", model: null, permissionMode: null, sessionId: "thread-1" });
    assert.equal(second.seq, 2);
  });

  it("marks running runs interrupted on restart without relaunching", () => {
    const task = newTask("restart");
    store.beginRun({ taskId: task.id, kind: "launch", runner: "claude", prompt: "p", model: null, permissionMode: null, sessionId: "s" });
    assert.ok(store.markRunningAsInterrupted() >= 1);
    const detail = store.getTaskDetail(task.id);
    assert.equal(detail?.task.status, "interrupted");
    assert.match(detail?.runs[0]?.error ?? "", /restarted/);
  });

  it("filters tasks by status and lists most recent first", () => {
    const interrupted = store.listTasks({ status: "interrupted" });
    assert.ok(interrupted.length >= 1);
    assert.ok(interrupted.every((task) => task.status === "interrupted"));
    const all = store.listTasks();
    for (let index = 1; index < all.length; index += 1) {
      assert.ok((all[index - 1]?.updatedAt ?? 0) >= (all[index]?.updatedAt ?? 0));
    }
  });
});

describe("run events", () => {
  it("coalesces text deltas, keeps tool and status rows in order and caps the log", () => {
    const task = newTask("streamed");
    const run = store.beginRun({ taskId: task.id, kind: "launch", runner: "claude", prompt: "p", model: null, permissionMode: null, sessionId: "s" });
    store.appendRunEvent({ runId: run.id, taskId: task.id, kind: "status", text: "session started" });
    store.appendRunEvent({ runId: run.id, taskId: task.id, kind: "text", text: "hel" });
    store.appendRunEvent({ runId: run.id, taskId: task.id, kind: "text", text: "lo" });
    store.appendRunEvent({ runId: run.id, taskId: task.id, kind: "tool", text: "Bash echo" });
    store.appendRunEvent({ runId: run.id, taskId: task.id, kind: "text", text: "done" });
    const events = store.listRunEvents(run.id);
    assert.deepEqual(events.map((event) => [event.kind, event.text]), [
      ["status", "session started"],
      ["text", "hello"],
      ["tool", "Bash echo"],
      ["text", "done"],
    ]);
    assert.equal(store.listTaskEvents(task.id).length, 4);
    store.finishRun({ runId: run.id, taskId: task.id, status: "failed", effectiveModel: null, sessionId: "s", result: null, error: "boom", exitCode: 1 });
    const failed = store.getTask(task.id);
    assert.equal(failed?.lastError, "boom");
    assert.equal(failed?.runsCount, 1);
  });
});

describe("reports", () => {
  it("stores reports and attaches them to task details", () => {
    const task = newTask("reported");
    const report = store.createReport({ taskId: task.id, sessionId: null, workspace: "pilot", kind: "progress", text: "halfway", source: "test" });
    store.createReport({ taskId: null, sessionId: "sess-9", workspace: null, kind: "note", text: "free note", source: "cli" });
    assert.equal(report.kind, "progress");
    assert.equal(store.getTaskDetail(task.id)?.reports[0]?.text, "halfway");
    const latest = store.listReports({ limit: 5 });
    assert.equal(latest[0]?.text, "free note");
    assert.equal(store.listReports({ taskId: task.id }).length, 1);
  });
});

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
