import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bulkActionNotice,
  bulkSummary,
  changeFor,
  CONFLICT_REASON,
  LOCKED_REASON,
  MISSING_REASON,
  planBulk,
  REFRESH_FAILED_REASON,
  runBulk,
  selectedRows,
  selectionState,
  skippedMessage,
  toggleSelectAll,
  toggleSelected,
  type BulkAction,
  type BulkIo,
} from "./board-bulk";
import type { BoardChange, BoardStatus, BoardTarget, BoardTask } from "./delegation";

class Conflict extends Error {}

function task(projectId: string, line: number, title: string, status: BoardStatus = "todo", priority: number | null = null): BoardTask {
  return {
    id: `${projectId}#${line}`,
    projectId,
    line,
    raw: `- [ ] ${title}`,
    depth: 0,
    checkbox: "todo",
    prefix: null,
    status,
    title,
    reason: null,
    section: "open",
    doneAt: null,
    group: null,
    priority,
    notes: [],
    noteItems: [],
    subtasks: [],
  };
}

interface Calls {
  patches: { target: BoardTarget; change: BoardChange }[];
  moves: { target: BoardTarget; projectId: string }[];
  reloads: number;
}

function fakeIo(overrides: Partial<BulkIo> = {}): { io: BulkIo; calls: Calls } {
  const calls: Calls = { patches: [], moves: [], reloads: 0 };
  const io: BulkIo = {
    patch: async (target, change) => {
      calls.patches.push({ target, change });
      return { task: task(target.projectId, target.line, "x"), moved: false };
    },
    move: async (target, projectId) => {
      calls.moves.push({ target, projectId });
      return {};
    },
    reload: async () => {
      calls.reloads += 1;
      return [];
    },
    isConflict: (error) => error instanceof Conflict,
    ...overrides,
  };
  return { io, calls };
}

const status = (value: BoardStatus): BulkAction => ({ kind: "status", status: value });

test("changeFor maps status, priority and archive to patch bodies and move to none", () => {
  assert.deepEqual(changeFor(status("doing")), { status: "doing" });
  assert.deepEqual(changeFor({ kind: "priority", priority: 2 }), { priority: 2 });
  assert.deepEqual(changeFor({ kind: "priority", priority: null }), { priority: null });
  assert.deepEqual(changeFor({ kind: "archive" }), { status: "archived" });
  assert.equal(changeFor({ kind: "move", projectId: "b" }), null);
});

test("planBulk separates steps, unchanged tasks and locked occurrences", () => {
  const a = task("p", 1, "a", "todo");
  const b = task("p", 2, "b", "doing");
  const c = task("p", 3, "c", "todo");
  const plan = planBulk([a, b, c], status("doing"), new Set([c.id]));
  assert.deepEqual(plan.steps.map((item) => item.title), ["a"]);
  assert.deepEqual(plan.unchanged.map((item) => item.title), ["b"]);
  assert.deepEqual(plan.skipped.map((item) => [item.task.title, item.reason]), [["c", LOCKED_REASON]]);
});

test("planBulk treats same priority, same project and already archived as unchanged", () => {
  const a = task("p", 1, "a", "todo", 1);
  assert.equal(planBulk([a], { kind: "priority", priority: 1 }, new Set()).unchanged.length, 1);
  assert.equal(planBulk([a], { kind: "priority", priority: null }, new Set()).steps.length, 1);
  assert.equal(planBulk([a], { kind: "move", projectId: "p" }, new Set()).unchanged.length, 1);
  assert.equal(planBulk([a], { kind: "move", projectId: "q" }, new Set()).steps.length, 1);
  assert.equal(planBulk([task("p", 2, "z", "archived")], { kind: "archive" }, new Set()).unchanged.length, 1);
  assert.equal(planBulk([a], { kind: "archive" }, new Set()).steps.length, 1);
});

test("runBulk patches every task in order without reloading when no line moved", async () => {
  const { io, calls } = fakeIo();
  const steps = [task("p", 3, "a"), task("p", 5, "b"), task("q", 2, "c")];
  const report = await runBulk(steps, status("doing"), io);
  assert.equal(report.applied.length, 3);
  assert.equal(report.skipped.length, 0);
  assert.equal(calls.reloads, 0);
  assert.deepEqual(calls.patches.map((item) => item.target.line), [3, 5, 2]);
  assert.deepEqual(calls.patches[0]?.change, { status: "doing" });
});

test("runBulk reloads after a moved line and rebinds the remaining tasks to their new lines", async () => {
  const first = task("p", 3, "a");
  const second = task("p", 5, "b");
  const third = task("p", 8, "c");
  const { io, calls } = fakeIo({
    patch: async (target) => {
      calls.patches.push({ target, change: {} });
      return { task: first, moved: calls.patches.length === 1 };
    },
    reload: async () => {
      calls.reloads += 1;
      return [task("p", 4, "b"), task("p", 7, "c")];
    },
  });
  const report = await runBulk([first, second, third], status("done"), io);
  assert.equal(report.applied.length, 3);
  assert.equal(calls.reloads, 1);
  assert.deepEqual(calls.patches.map((item) => item.target.line), [3, 4, 7]);
});

test("runBulk reports a conflict as skipped, refreshes and keeps going with fresh targets", async () => {
  const steps = [task("p", 1, "a"), task("p", 2, "b"), task("p", 3, "c")];
  const { io, calls } = fakeIo({
    patch: async (target) => {
      calls.patches.push({ target, change: {} });
      if (target.line === 2) throw new Conflict("changed");
      return { task: steps[0] as BoardTask, moved: false };
    },
    reload: async () => {
      calls.reloads += 1;
      return [task("p", 1, "a"), task("p", 2, "b"), task("p", 3, "c")];
    },
  });
  const report = await runBulk(steps, status("doing"), io);
  assert.deepEqual(report.applied.map((item) => item.title), ["a", "c"]);
  assert.deepEqual(report.skipped.map((item) => [item.task.title, item.reason]), [["b", CONFLICT_REASON]]);
  assert.equal(report.conflicts, 1);
  assert.equal(calls.reloads, 1);
});

test("runBulk skips tasks that vanish on reload and all remaining ones when the reload fails", async () => {
  const steps = [task("p", 1, "a"), task("p", 2, "b"), task("p", 3, "c")];
  const vanished = fakeIo({
    patch: async () => ({ task: steps[0] as BoardTask, moved: true }),
    reload: async () => [task("p", 1, "c")],
  });
  const first = await runBulk(steps, status("done"), vanished.io);
  assert.deepEqual(first.applied.map((item) => item.title), ["a", "c"]);
  assert.deepEqual(first.skipped.map((item) => [item.task.title, item.reason]), [["b", MISSING_REASON]]);
  const failed = fakeIo({
    patch: async () => ({ task: steps[0] as BoardTask, moved: true }),
    reload: async () => null,
  });
  const second = await runBulk(steps, status("done"), failed.io);
  assert.deepEqual(second.applied.map((item) => item.title), ["a"]);
  assert.deepEqual(second.skipped.map((item) => [item.task.title, item.reason]), [["b", REFRESH_FAILED_REASON], ["c", REFRESH_FAILED_REASON]]);
});

test("runBulk keeps a non-conflict failure as skipped without refreshing", async () => {
  const { io, calls } = fakeIo({
    patch: async (target) => {
      if (target.line === 1) throw new Error("no prefix configured for archived");
      return { task: task("p", 2, "b"), moved: false };
    },
  });
  const report = await runBulk([task("p", 1, "a"), task("p", 2, "b")], { kind: "archive" }, io);
  assert.deepEqual(report.applied.map((item) => item.title), ["b"]);
  assert.equal(report.skipped[0]?.reason, "no prefix configured for archived");
  assert.equal(report.conflicts, 0);
  assert.equal(calls.reloads, 0);
});

test("runBulk moves tasks to a project and reloads after each one", async () => {
  let live = [task("p", 1, "a"), task("p", 2, "b")];
  const { io, calls } = fakeIo({
    move: async (target, projectId) => {
      calls.moves.push({ target, projectId });
      live = live.filter((item) => item.line !== target.line).map((item) => ({ ...item, line: 1 }));
      return {};
    },
    reload: async () => {
      calls.reloads += 1;
      return live;
    },
  });
  const report = await runBulk([task("p", 1, "a"), task("p", 2, "b")], { kind: "move", projectId: "q" }, io);
  assert.equal(report.applied.length, 2);
  assert.deepEqual(calls.moves.map((item) => [item.target.line, item.projectId]), [[1, "q"], [1, "q"]]);
  assert.equal(calls.reloads, 1);
});

test("bulkActionNotice words every action and pluralises", () => {
  assert.equal(bulkActionNotice(status("doing"), 3, ""), "Set Doing on 3 tasks");
  assert.equal(bulkActionNotice({ kind: "priority", priority: 1 }, 1, ""), "Set P1 on 1 task");
  assert.equal(bulkActionNotice({ kind: "priority", priority: null }, 2, ""), "Cleared the priority of 2 tasks");
  assert.equal(bulkActionNotice({ kind: "archive" }, 1, ""), "Archived 1 task");
  assert.equal(bulkActionNotice({ kind: "move", projectId: "q" }, 2, "Cedro"), "Moved 2 tasks to Cedro");
});

test("skippedMessage lists up to three names, counts the rest and mentions the refresh", () => {
  assert.equal(skippedMessage([], true), null);
  const four = ["a", "b", "c", "d"].map((title) => ({ task: task("p", 1, title), reason: CONFLICT_REASON }));
  assert.equal(
    skippedMessage(four, true),
    'Skipped 4 tasks: "a" (changed on disk), "b" (changed on disk), "c" (changed on disk) and 1 more. The board was refreshed.',
  );
  assert.equal(skippedMessage(four.slice(0, 1), false), 'Skipped 1 task: "a" (changed on disk).');
});

test("bulkSummary combines the notice with locked and conflicting skips", () => {
  const locked = task("p", 9, "locked");
  const plan = { steps: [], unchanged: [], skipped: [{ task: locked, reason: LOCKED_REASON }] };
  const report = { applied: [task("p", 1, "a")], skipped: [{ task: task("p", 2, "b"), reason: CONFLICT_REASON }], conflicts: 1 };
  const summary = bulkSummary(status("done"), "", plan, report);
  assert.equal(summary.notice, "Set Done on 1 task");
  assert.match(summary.error ?? "", /^Skipped 2 tasks: "locked" \(finished occurrence, edit it in Obsidian\), "b" \(changed on disk\)\. The board was refreshed\.$/);
  const none = bulkSummary(status("done"), "", { steps: [], unchanged: [task("p", 1, "a")], skipped: [] }, { applied: [], skipped: [], conflicts: 0 });
  assert.deepEqual(none, { notice: "Nothing to change on the selected tasks", error: null });
  const onlySkips = bulkSummary(status("done"), "", plan, { applied: [], skipped: [], conflicts: 0 });
  assert.equal(onlySkips.notice, null);
  assert.match(onlySkips.error ?? "", /^Skipped 1 task/);
});

test("selection helpers report none, some and all and toggle rows", () => {
  const rows = [task("p", 1, "a"), task("p", 2, "b"), task("p", 3, "c")];
  assert.equal(selectionState(rows, new Set()), "none");
  assert.equal(selectionState(rows, new Set(["p#1", "gone#1"])), "some");
  assert.equal(selectionState(rows, new Set(["p#1", "p#2", "p#3"])), "all");
  assert.equal(selectionState([], new Set()), "none");
  assert.deepEqual([...toggleSelected(new Set(["p#1"]), "p#2")], ["p#1", "p#2"]);
  assert.deepEqual([...toggleSelected(new Set(["p#1"]), "p#1")], []);
  assert.deepEqual([...toggleSelectAll(rows, new Set(["p#1"]))], ["p#1", "p#2", "p#3"]);
  assert.deepEqual([...toggleSelectAll(rows, new Set(["p#1", "p#2", "p#3"]))], []);
  assert.deepEqual(selectedRows(rows, new Set(["p#3", "p#1"])).map((item) => item.title), ["a", "c"]);
});
