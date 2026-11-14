import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskStatus } from "./delegation";
import {
  foldTaskRuns,
  needsByGroup,
  needsYouOnTop,
  normalizeOrigin,
  originCounts,
  originIncludes,
  originOptions,
  parseOrigin,
  partitionNeedsYou,
  runsRouteOf,
  taskBucket,
  taskPrimaryAction,
  taskReadyToMerge,
  taskRunStatus,
  taskSummary,
  withNeedsYouOnTop,
  worktreeMergeable,
  type TaskShape,
} from "./runs-model";

const task = (status: TaskStatus, extra: Partial<TaskShape> = {}): TaskShape => ({
  status,
  archivedAt: null,
  isolation: "shared",
  worktreePath: null,
  mergedAt: null,
  ...extra,
});

describe("origin facet", () => {
  it("counts only live entries per origin and sums them into all", () => {
    const counts = originCounts([
      { origin: "claude", live: true },
      { origin: "claude", live: true },
      { origin: "claude", live: false },
      { origin: "codex", live: true },
      { origin: "delegated", live: true },
      { origin: "delegated", live: false },
    ]);
    assert.deepEqual(counts, { all: 4, claude: 2, codex: 1, delegated: 1 });
  });

  it("returns zero counts for an empty list", () => {
    assert.deepEqual(originCounts([]), { all: 0, claude: 0, codex: 0, delegated: 0 });
  });

  it("drops Delegated from the options and the selection when the plugin is off", () => {
    assert.deepEqual(originOptions(true), ["all", "claude", "codex", "delegated"]);
    assert.deepEqual(originOptions(false), ["all", "claude", "codex"]);
    assert.equal(normalizeOrigin("delegated", false), "all");
    assert.equal(normalizeOrigin("delegated", true), "delegated");
    assert.equal(normalizeOrigin("codex", false), "codex");
  });

  it("parses stored values and falls back to all", () => {
    assert.equal(parseOrigin("codex"), "codex");
    assert.equal(parseOrigin("bogus"), "all");
    assert.equal(parseOrigin(null), "all");
  });

  it("all includes every origin, a single origin only itself", () => {
    assert.equal(originIncludes("all", "codex"), true);
    assert.equal(originIncludes("claude", "claude"), true);
    assert.equal(originIncludes("claude", "delegated"), false);
  });
});

describe("task buckets", () => {
  it("maps in-flight tasks to active and attention to waiting", () => {
    assert.equal(taskBucket(task("pending")), "active");
    assert.equal(taskBucket(task("running")), "active");
    assert.equal(taskBucket(task("attention")), "waiting");
  });

  it("keeps failed and interrupted tasks live as idle", () => {
    assert.equal(taskBucket(task("failed")), "idle");
    assert.equal(taskBucket(task("interrupted")), "idle");
  });

  it("keeps a completed worktree waiting for merge live, and ends the rest", () => {
    const ready = task("completed", { isolation: "worktree", worktreePath: "C:/wt" });
    assert.equal(taskReadyToMerge(ready), true);
    assert.equal(taskBucket(ready), "idle");
    assert.equal(taskBucket(task("completed", { isolation: "worktree", worktreePath: "C:/wt", mergedAt: 1 })), "ended");
    assert.equal(taskBucket(task("completed", { isolation: "worktree", worktreePath: null })), "ended");
    assert.equal(taskBucket(task("completed")), "ended");
    assert.equal(taskBucket(task("cancelled")), "ended");
  });

  it("archives win over every status", () => {
    assert.equal(taskBucket(task("running", { archivedAt: 5 })), "archived");
  });

  it("derives a session-like status for sorting", () => {
    assert.equal(taskRunStatus(task("running")), "active");
    assert.equal(taskRunStatus(task("attention")), "waiting");
    assert.equal(taskRunStatus(task("failed")), "idle");
    assert.equal(taskRunStatus(task("cancelled")), "ended");
  });
});

describe("foldTaskRuns", () => {
  it("folds the hub session and the hub Codex thread into their task", () => {
    const fold = foldTaskRuns(
      [
        { id: "t1", sessionId: "s-hub" },
        { id: "t2", sessionId: null },
      ],
      [
        { id: "th-1", hubTaskId: "t2" },
        { id: "th-2", hubTaskId: null },
        { id: "th-3", hubTaskId: "missing" },
      ],
    );
    assert.equal(fold.sessionOf.get("t1"), "s-hub");
    assert.equal(fold.sessionOf.has("t2"), false);
    assert.equal(fold.threadOf.get("t2"), "th-1");
    assert.deepEqual([...fold.foldedSessions], ["s-hub"]);
    assert.deepEqual([...fold.foldedThreads], ["th-1"]);
  });

  it("folds nothing without tasks, so hub sessions stay plain sessions", () => {
    const fold = foldTaskRuns([], [{ id: "th-1", hubTaskId: "t1" }]);
    assert.equal(fold.foldedSessions.size, 0);
    assert.equal(fold.foldedThreads.size, 0);
  });
});

describe("needs-you band", () => {
  const items = [
    { id: "a", needs: true, group: "ws1" },
    { id: "b", needs: false, group: "ws1" },
    { id: "c", needs: true, group: "ws2" },
    { id: "d", needs: true, group: "ws1" },
  ];

  it("moves needing items to the band without repeating them in the rest", () => {
    const { band, rest } = partitionNeedsYou(items, true);
    assert.deepEqual(band.map((item) => item.id), ["a", "c", "d"]);
    assert.deepEqual(rest.map((item) => item.id), ["b"]);
  });

  it("keeps everything in place when the band is off", () => {
    const { band, rest } = partitionNeedsYou(items, false);
    assert.deepEqual(band, []);
    assert.deepEqual(rest.map((item) => item.id), ["a", "b", "c", "d"]);
  });

  it("counts band items per group", () => {
    const counts = needsByGroup(partitionNeedsYou(items, true).band, (item) => item.group);
    assert.deepEqual([...counts], [["ws1", 2], ["ws2", 1]]);
  });
});

describe("runsRouteOf", () => {
  it("maps #/tasks to Sessions with the Delegated origin", () => {
    assert.deepEqual(runsRouteOf("tasks", null), { origin: "delegated", taskId: null });
  });

  it("maps #/tasks/<id> to that task drawer without changing the origin", () => {
    assert.deepEqual(runsRouteOf("tasks", "abc"), { origin: null, taskId: "abc" });
    assert.deepEqual(runsRouteOf("tasks", "  "), { origin: "delegated", taskId: null });
  });

  it("leaves other routes alone", () => {
    assert.equal(runsRouteOf("sessions", null), null);
    assert.equal(runsRouteOf("flow", "x"), null);
  });
});

describe("needs-you-on-top preference", () => {
  it("defaults to on", () => {
    assert.equal(needsYouOnTop(undefined), true);
    assert.equal(needsYouOnTop({}), true);
    assert.equal(needsYouOnTop({ sessions: { other: 3 } }), true);
  });

  it("reads 0 as off and anything else as on", () => {
    assert.equal(needsYouOnTop({ sessions: { needsYouTop: 0 } }), false);
    assert.equal(needsYouOnTop({ sessions: { needsYouTop: 1 } }), true);
  });

  it("writes the flag without dropping other keys of the screen", () => {
    assert.deepEqual(withNeedsYouOnTop({ sessions: { width: 400 } }, false), { layout: { sessions: { width: 400, needsYouTop: 0 } } });
    assert.deepEqual(withNeedsYouOnTop(undefined, true), { layout: { sessions: { needsYouTop: 1 } } });
  });
});

describe("task drawer primary action", () => {
  it("follows the state of the task", () => {
    assert.equal(taskPrimaryAction({ status: "running", archived: false, mergeable: false }), "cancel");
    assert.equal(taskPrimaryAction({ status: "pending", archived: false, mergeable: true }), "cancel");
    assert.equal(taskPrimaryAction({ status: "attention", archived: false, mergeable: true }), "continue");
    assert.equal(taskPrimaryAction({ status: "failed", archived: false, mergeable: false }), "continue");
    assert.equal(taskPrimaryAction({ status: "completed", archived: false, mergeable: true }), "merge");
    assert.equal(taskPrimaryAction({ status: "completed", archived: false, mergeable: false }), "continue");
    assert.equal(taskPrimaryAction({ status: "completed", archived: true, mergeable: true }), null);
  });

  it("only merges a clean worktree with commits that is not merged or running", () => {
    const clean = { exists: true, dirty: false, commits: [1], mergedAt: null };
    assert.equal(worktreeMergeable(clean, false), true);
    assert.equal(worktreeMergeable(clean, true), false);
    assert.equal(worktreeMergeable({ ...clean, dirty: true }, false), false);
    assert.equal(worktreeMergeable({ ...clean, commits: [] }, false), false);
    assert.equal(worktreeMergeable({ ...clean, mergedAt: 1 }, false), false);
    assert.equal(worktreeMergeable({ ...clean, exists: false }, false), false);
    assert.equal(worktreeMergeable(null, false), false);
  });
});

describe("taskSummary", () => {
  it("counts running, needing, done today and failed, ignoring archived", () => {
    const now = 10 * 24 * 3_600_000;
    const summary = taskSummary(
      [
        { status: "running", updatedAt: now, archivedAt: null },
        { status: "attention", updatedAt: now, archivedAt: null },
        { status: "failed", updatedAt: now, archivedAt: null },
        { status: "completed", updatedAt: now - 1000, archivedAt: null },
        { status: "completed", updatedAt: now - 2 * 24 * 3_600_000, archivedAt: null },
        { status: "running", updatedAt: now, archivedAt: 1 },
      ],
      now,
    );
    assert.deepEqual(summary, { running: 1, needYou: 2, doneToday: 1, failed: 1 });
  });
});
