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
  filterForOrigin,
  humanizeDuration,
  runStatusTone,
  runsRouteOf,
  taskBucket,
  taskPrimaryAction,
  taskStatusTone,
  taskTiming,
  withLiveCounts,
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

describe("taskStatusTone", () => {
  it("is cyan while running, yellow when it needs you, red on failure and grey when done", () => {
    assert.equal(taskStatusTone(task("running")), "go");
    assert.equal(taskStatusTone(task("pending")), "go");
    assert.equal(taskStatusTone(task("attention")), "pend");
    assert.equal(taskStatusTone(task("failed")), "hold");
    assert.equal(taskStatusTone(task("interrupted")), "hold");
    assert.equal(taskStatusTone(task("completed")), "muted");
    assert.equal(taskStatusTone(task("cancelled")), "muted");
  });

  it("is violet for a finished worktree waiting to be merged, like an unread session", () => {
    assert.equal(taskStatusTone(task("completed", { isolation: "worktree", worktreePath: "/w" })), "unread");
    assert.equal(taskStatusTone(task("completed", { isolation: "worktree", worktreePath: "/w", mergedAt: 1 })), "muted");
  });

  it("is grey for any archived task", () => {
    assert.equal(taskStatusTone(task("running", { archivedAt: 1 })), "muted");
    assert.equal(taskStatusTone(task("failed", { archivedAt: 1 })), "muted");
    assert.equal(taskStatusTone(task("completed", { isolation: "worktree", worktreePath: "/w", archivedAt: 1 })), "muted");
  });

  it("never uses the brand or amber colours", () => {
    const statuses: TaskStatus[] = ["pending", "running", "attention", "completed", "failed", "interrupted", "cancelled"];
    for (const status of statuses) assert.ok(["go", "pend", "hold", "unread", "muted"].includes(taskStatusTone(task(status))));
  });
});

describe("runStatusTone", () => {
  it("colours a single run by its status alone", () => {
    assert.equal(runStatusTone("running"), "go");
    assert.equal(runStatusTone("attention"), "pend");
    assert.equal(runStatusTone("failed"), "hold");
    assert.equal(runStatusTone("completed"), "muted");
  });
});

describe("originCounts with folded entries", () => {
  it("counts a folded Codex thread under Codex but not under All, where its task already stands for it", () => {
    const counts = originCounts([
      { origin: "codex", live: true },
      { origin: "codex", live: true, folded: true },
      { origin: "delegated", live: true },
    ]);
    assert.deepEqual(counts, { all: 2, claude: 0, codex: 2, delegated: 1 });
  });
});

describe("filterForOrigin", () => {
  it("falls back to All when Favorites is picked on an origin without Claude sessions", () => {
    assert.equal(filterForOrigin("favorites", "codex"), "all");
    assert.equal(filterForOrigin("favorites", "delegated"), "all");
  });

  it("keeps Favorites where Claude sessions show and keeps every other filter", () => {
    assert.equal(filterForOrigin("favorites", "all"), "favorites");
    assert.equal(filterForOrigin("favorites", "claude"), "favorites");
    assert.equal(filterForOrigin("needs-you", "codex"), "needs-you");
    assert.equal(filterForOrigin("archived", "delegated"), "archived");
  });
});

describe("withLiveCounts", () => {
  it("appends the live count to each option that has live items and leaves the rest bare", () => {
    const options = [
      { key: "all", label: "All clients" },
      { key: "hub", label: "Hub runs (headless)" },
      { key: "share", label: "Share forks" },
      { key: "codex", label: "Codex threads" },
    ] as const;
    assert.deepEqual(
      withLiveCounts(options, { hub: 2, share: 0, codex: 5 }).map((item) => item.label),
      ["All clients", "Hub runs (headless) (2)", "Share forks", "Codex threads (5)"],
    );
  });
});

describe("taskTiming", () => {
  const minute = 60_000;
  it("reports when it started, how long it ran and how many runs it took", () => {
    const timing = taskTiming({ status: "completed", createdAt: 0, updatedAt: 90 * minute, runsCount: 2 }, 100 * minute);
    assert.deepEqual(timing, { startedAt: 0, duration: "1h 30m", runs: "2 runs" });
  });

  it("measures a running task up to now and says it is still running", () => {
    const timing = taskTiming({ status: "running", createdAt: 0, updatedAt: minute, runsCount: 1 }, 5 * minute);
    assert.deepEqual(timing, { startedAt: 0, duration: "running 5m", runs: "1 run" });
  });

  it("humanizes short and long spans", () => {
    assert.equal(humanizeDuration(30_000), "under a minute");
    assert.equal(humanizeDuration(2 * 60 * minute), "2h");
    assert.equal(humanizeDuration(3 * 24 * 60 * minute), "3d");
  });
});
