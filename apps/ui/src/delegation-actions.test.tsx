import { afterEach, expect, test } from "vitest";
import { hubBase } from "./api";
import * as actions from "./delegation-actions";
import type { TaskRecord } from "./delegation";
import { json, stubFetch, type FetchStub } from "./test-support/u5-fetch";

let stub: FetchStub;
const root = `${hubBase}/delegation`;

afterEach(() => {
  stub.restore();
});

const task = (patch: Record<string, unknown> = {}): TaskRecord => ({ id: "t1", ...patch }) as unknown as TaskRecord;

test("archive and unarchive post to the task endpoints and resolve to nothing", async () => {
  stub = stubFetch(() => json({ id: "t/1" }));
  await expect(actions.archiveTask("t/1")).resolves.toBeUndefined();
  expect(stub.last()).toMatchObject({ method: "POST", url: `${root}/tasks/t%2F1/archive` });
  await expect(actions.unarchiveTask("t1")).resolves.toBeUndefined();
  expect(stub.last()).toMatchObject({ method: "POST", url: `${root}/tasks/t1/unarchive` });
});

test("listArchivedTasks asks for archived tasks and drops the ones without an archive date", async () => {
  stub = stubFetch(() => json([task({ id: "a", archivedAt: 5 }), task({ id: "b" }), task({ id: "c", archivedAt: null }), task({ id: "d", archivedAt: 9 })]));
  const result = await actions.listArchivedTasks();
  expect(result.map((entry) => entry.id)).toEqual(["a", "d"]);
  expect(stub.last()).toMatchObject({ method: "GET", url: `${root}/tasks?archived=1&limit=200` });
  await actions.listArchivedTasks(7);
  expect(stub.last().url).toBe(`${root}/tasks?archived=1&limit=7`);
});

test("retryTask continues the task, adding the permission mode and wording only when one is granted", async () => {
  stub = stubFetch(() => json({}));
  await actions.retryTask("t1", null);
  expect(stub.last()).toMatchObject({ method: "POST", url: `${root}/tasks/t1/continue`, body: { prompt: "continue where you stopped" } });
  await actions.retryTask("t1", "acceptEdits");
  expect(stub.last().body).toEqual({ prompt: "continue where you stopped; you now have permission", permissionMode: "acceptEdits" });
});

test("send failures carry the hub message, the listed files, or the status", async () => {
  stub = stubFetch(() => json({ error: "dirty", files: ["a.ts", "b.ts"] }, 409));
  await expect(actions.archiveTask("t1")).rejects.toThrow("dirty: a.ts, b.ts");
  stub.restore();
  stub = stubFetch(() => json({ error: "plain", files: [] }, 409));
  await expect(actions.archiveTask("t1")).rejects.toThrow(/^plain$/);
  stub.restore();
  stub = stubFetch(() => ({ status: 500, text: "oops", contentType: "text/plain" }));
  await expect(actions.archiveTask("t1")).rejects.toThrow("request failed (500)");
});

test("replyCodexThread posts the text and reports ok", async () => {
  stub = stubFetch(() => json({}));
  await expect(actions.replyCodexThread("c/1", "hello")).resolves.toEqual({ ok: true });
  expect(stub.last()).toMatchObject({ method: "POST", url: `${root}/codex/c%2F1/reply`, body: { text: "hello" } });
});

test("replyCodexThread keeps a known reply code only on a 409", async () => {
  stub = stubFetch(() => json({ error: "thread busy", code: "busy" }, 409));
  await expect(actions.replyCodexThread("c1", "x")).resolves.toEqual({ ok: false, code: "busy", message: "thread busy" });
  stub.restore();
  stub = stubFetch(() => json({ error: "nope", code: "not-a-code" }, 409));
  await expect(actions.replyCodexThread("c1", "x")).resolves.toEqual({ ok: false, code: null, message: "nope" });
  stub.restore();
  stub = stubFetch(() => json({ error: "server", code: "busy" }, 500));
  await expect(actions.replyCodexThread("c1", "x")).resolves.toEqual({ ok: false, code: null, message: "server" });
  stub.restore();
  stub = stubFetch(() => ({ status: 502, text: "<html>" }));
  await expect(actions.replyCodexThread("c1", "x")).resolves.toEqual({ ok: false, code: null, message: "request failed (502)" });
  stub.restore();
  stub = stubFetch(() => ({ status: 502, text: "" }));
  await expect(actions.replyCodexThread("c1", "x")).resolves.toEqual({ ok: false, code: null, message: "request failed (502)" });
});

test("taskArchivedAt reads archivedAt and defaults to null", () => {
  expect(actions.taskArchivedAt(task({ archivedAt: 12 }))).toBe(12);
  expect(actions.taskArchivedAt(task())).toBeNull();
});

test("probeArchiveSupport is true when the hub knows the route and false when it is an old hub or unreachable", async () => {
  stub = stubFetch(() => json({ error: "no task" }, 404));
  await expect(actions.probeArchiveSupport()).resolves.toBe(true);
  expect(stub.last()).toMatchObject({ method: "POST", url: `${root}/tasks/__cchub_probe__/archive` });
  stub.restore();
  stub = stubFetch(() => ({ status: 404, text: "Cannot POST", contentType: "text/html" }));
  await expect(actions.probeArchiveSupport()).resolves.toBe(false);
  stub.restore();
  stub = stubFetch(() => ({ status: 409 }));
  await expect(actions.probeArchiveSupport()).resolves.toBe(true);
  stub.restore();
  stub = stubFetch(() => ({ status: 500 }));
  await expect(actions.probeArchiveSupport()).resolves.toBe(false);
  stub.restore();
  stub = stubFetch(() => new Error("offline"));
  await expect(actions.probeArchiveSupport()).resolves.toBe(false);
});

test("worktree helpers call the delegation endpoints", async () => {
  stub = stubFetch(() => json({ branch: "b" }));
  await expect(actions.getTaskWorktree("t1")).resolves.toEqual({ branch: "b" });
  expect(stub.last()).toMatchObject({ method: "GET", url: `${root}/tasks/t1/worktree` });
  await expect(actions.mergeTaskWorktree("t1")).resolves.toBeUndefined();
  expect(stub.last()).toMatchObject({ method: "POST", url: `${root}/tasks/t1/merge` });
  await expect(actions.discardTaskWorktree("t1")).resolves.toBeUndefined();
  expect(stub.last()).toMatchObject({ method: "POST", url: `${root}/tasks/t1/worktree/discard` });
});

test("task accessors expose isolation, branch, worktree path and merge time with safe defaults", () => {
  expect(actions.taskIsolation(task({ isolation: "worktree" }))).toBe("worktree");
  expect(actions.taskIsolation(task({ isolation: "shared" }))).toBe("shared");
  expect(actions.taskIsolation(task())).toBe("shared");
  expect(actions.taskBranch(task({ branch: "feat/x" }))).toBe("feat/x");
  expect(actions.taskBranch(task())).toBeNull();
  expect(actions.taskWorktreePath(task({ worktreePath: "C:/wt" }))).toBe("C:/wt");
  expect(actions.taskWorktreePath(task())).toBeNull();
  expect(actions.taskMergedAt(task({ mergedAt: 4 }))).toBe(4);
  expect(actions.taskMergedAt(task())).toBeNull();
});
