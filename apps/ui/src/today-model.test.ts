import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoardProject, BoardTask, DailyYesterday, DailyYesterdayTask, TodayEntry, TodayOutOfSync } from "./delegation";
import {
  backlogGroups,
  backlogKeyIntent,
  broughtLines,
  closeYesterdayBody,
  composeStartDay,
  countBacklog,
  DEFAULT_BACKLOG_FILTERS,
  decodeDragTarget,
  describeDay,
  encodeDragTarget,
  entryTaskIds,
  lineInNote,
  lineMatchesTitle,
  localDay,
  moveSteps,
  nextDay,
  outlineGroupsOf,
  parentOfTask,
  parseQuickAdd,
  pendingLineKeys,
  planDraftKey,
  planYesterday,
  plainLineText,
  realSiblings,
  rootNodeOf,
  startPanelAuto,
  toggleBacklogStatus,
  trailSummary,
  ambiguityHint,
  keepDismissed,
  noteOnlyLines,
  outOfSyncKey,
  parseDismissedOutOfSync,
  taskOfOutOfSync,
  visibleOutOfSync,
} from "./today-model";

const TODAY = "2026-11-12";

const task = (id: string, projectId: string, line: number, patch: Partial<BoardTask> = {}, subtasks: BoardTask[] = []): BoardTask => ({
  id,
  projectId,
  line,
  raw: `- [ ] ${id}`,
  depth: 0,
  checkbox: "todo",
  prefix: null,
  status: "todo",
  title: id,
  reason: null,
  section: "open",
  doneAt: null,
  group: null,
  priority: null,
  notes: [],
  noteItems: [],
  subtasks,
  ...patch,
});

const project = (id: string, title: string): BoardProject => ({ id, name: id, title, parent: null, depth: 0, path: `/${id}.md`, workspace: null, workspaceSource: null });

const entry = (value: BoardTask, projectId: string, title: string, parentTitle: string | null = null): TodayEntry => ({
  task: value,
  project: { id: projectId, title, name: projectId },
  parentTitle,
});

describe("day helpers", () => {
  it("formats the local day with zero padding", () => {
    assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  });

  it("adds one day across month and year ends", () => {
    assert.equal(nextDay("2026-11-30"), "2026-12-01");
    assert.equal(nextDay("2026-12-31"), "2027-01-01");
  });

  it("describes relative days and falls back to a short date", () => {
    assert.equal(describeDay(TODAY, TODAY), "Today");
    assert.equal(describeDay("2026-11-13", TODAY), "Tomorrow");
    assert.equal(describeDay("2026-11-11", TODAY), "Yesterday");
    assert.equal(describeDay("2026-11-20", TODAY), "Fri, Nov 20");
  });
});

describe("outlineGroupsOf", () => {
  it("groups by project in the received order and keeps tasks of the same project together", () => {
    const entries = [
      entry(task("a1", "a", 3), "a", "Alpha"),
      entry(task("b1", "b", 2), "b", "Bravo"),
      entry(task("a2", "a", 9), "a", "Alpha"),
    ];
    const groups = outlineGroupsOf(entries);
    assert.deepEqual(
      groups.map((group) => [group.project.id, group.items.map((item) => item.id)]),
      [
        ["a", ["a1", "a2"]],
        ["b", ["b1"]],
      ],
    );
  });

  it("maps notes, subtasks, depth, priority and due", () => {
    const parent = task(
      "p",
      "a",
      1,
      { priority: 1, due: "2026-11-20", noteItems: [{ line: 2, raw: "  - n", text: "n" }] },
      [task("c", "a", 3, { status: "done" })],
    );
    const [group] = outlineGroupsOf([entry(parent, "a", "Alpha")]);
    const root = group?.items[0];
    assert.equal(root?.priority, 1);
    assert.equal(root?.due, "2026-11-20");
    assert.deepEqual(root?.notes, [{ line: 2, raw: "  - n", text: "n" }]);
    assert.equal(root?.children[0]?.depth, 1);
    assert.equal(root?.children[0]?.status, "done");
  });

  it("returns no groups for an empty focus", () => {
    assert.deepEqual(outlineGroupsOf([]), []);
  });
});

describe("task tree helpers", () => {
  const tree = [
    task("p1", "a", 1, {}, [task("s1", "a", 2), task("s2", "a", 3, {}, [task("s2a", "a", 4)])]),
    task("p2", "a", 6),
    task("p3", "a", 8, { section: "done", status: "done" }),
    task("q1", "b", 1),
  ];

  it("collects every nested id of the focus entries", () => {
    const ids = entryTaskIds([entry(tree[0] as BoardTask, "a", "Alpha")]);
    assert.deepEqual([...ids].sort(), ["p1", "s1", "s2", "s2a"]);
  });

  it("finds the direct parent at any depth", () => {
    assert.equal(parentOfTask(tree, "s2a")?.id, "s2");
    assert.equal(parentOfTask(tree, "s1")?.id, "p1");
    assert.equal(parentOfTask(tree, "p1"), null);
  });

  it("lists real siblings by line inside the same project and section", () => {
    assert.deepEqual(realSiblings(tree, "p2").map((item) => item.id), ["p1", "p2"]);
    assert.deepEqual(realSiblings(tree, "s1").map((item) => item.id), ["s1", "s2"]);
    assert.deepEqual(realSiblings(tree, "p3").map((item) => item.id), ["p3"]);
  });

  it("counts the moves needed to reach a visible sibling past hidden ones", () => {
    const wide = [task("x1", "a", 1), task("x2", "a", 2), task("x3", "a", 3), task("x4", "a", 4)];
    assert.equal(moveSteps(wide, "x4", "x1"), 3);
    assert.equal(moveSteps(wide, "x1", "x2"), 1);
    assert.equal(moveSteps(wide, "x1", "missing"), 1);
  });

  it("finds the entry root of a nested node", () => {
    const groups = outlineGroupsOf([entry(tree[0] as BoardTask, "a", "Alpha")]);
    const nested = groups[0]?.items[0]?.children[1]?.children[0];
    assert.ok(nested);
    assert.equal(rootNodeOf(groups, nested).id, "p1");
  });
});

describe("parseQuickAdd", () => {
  it("extracts tokens into fields", () => {
    assert.deepEqual(parseQuickAdd("Write report #p1 due:tomorrow", TODAY), { title: "Write report", priority: 1, due: "2026-11-13" });
  });

  it("keeps a plain title untouched", () => {
    assert.deepEqual(parseQuickAdd("  Plain title  ", TODAY), { title: "Plain title" });
  });

  it("refuses an empty title", () => {
    assert.equal(parseQuickAdd("#p1 due:today", TODAY), null);
    assert.equal(parseQuickAdd("   ", TODAY), null);
  });
});

describe("drag payload", () => {
  it("round-trips a target", () => {
    const target = { projectId: "a", line: 4, raw: "- [ ] x" };
    assert.deepEqual(decodeDragTarget(encodeDragTarget(target)), target);
  });

  it("rejects malformed payloads", () => {
    assert.equal(decodeDragTarget("nope"), null);
    assert.equal(decodeDragTarget("null"), null);
    assert.equal(decodeDragTarget(JSON.stringify({ projectId: "a", line: -1, raw: "x" })), null);
    assert.equal(decodeDragTarget(JSON.stringify({ projectId: 3, line: 1, raw: "x" })), null);
  });
});

describe("backlogKeyIntent", () => {
  const key = (value: string, extra: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
    key: value,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...extra,
  });

  it("maps the row shortcuts", () => {
    assert.equal(backlogKeyIntent(key("t")), "today");
    assert.equal(backlogKeyIntent(key("M")), "tomorrow");
    assert.equal(backlogKeyIntent(key("d")), "done");
    assert.equal(backlogKeyIntent(key("s")), "doing");
    assert.equal(backlogKeyIntent(key("Enter")), "open");
    assert.equal(backlogKeyIntent(key("ArrowDown")), "next");
    assert.equal(backlogKeyIntent(key("k")), "prev");
  });

  it("ignores modified keys and unknown keys", () => {
    assert.equal(backlogKeyIntent(key("t", { ctrlKey: true })), null);
    assert.equal(backlogKeyIntent(key("s", { ctrlKey: true })), null);
    assert.equal(backlogKeyIntent(key("Enter", { shiftKey: true })), null);
    assert.equal(backlogKeyIntent(key("x")), null);
  });
});

describe("backlog filtering", () => {
  const projects = [project("a", "Alpha"), project("b", "Bravo"), project("c", "Charlie")];
  const tasks = [
    task("a1", "a", 1, { title: "Write docs" }),
    task("a2", "a", 2, { title: "Fix login", status: "doing" }),
    task("a3", "a", 3, { title: "Old thing", status: "done", section: "done" }),
    task("b1", "b", 1, { title: "Ship release", status: "blocked", reason: "waiting on legal" }),
    task("b2", "b", 2, { title: "Parked idea", status: "hold" }),
    task("c1", "c", 1, { title: "Archive me", status: "archived" }),
    task("c2", "c", 2, { title: "Docs for Charlie" }),
  ];

  it("hides done, archived, hold by default and excluded ids", () => {
    const groups = backlogGroups(tasks, projects, [], new Set(["a1"]), DEFAULT_BACKLOG_FILTERS);
    const ids = groups.flatMap((group) => group.tasks.map((item) => item.id));
    assert.deepEqual(ids, ["a2", "b1", "c2"]);
  });

  it("orders groups by the project order", () => {
    const groups = backlogGroups(tasks, projects, ["c", "b"], new Set(), DEFAULT_BACKLOG_FILTERS);
    assert.deepEqual(groups.map((group) => group.project.id), ["c", "b", "a"]);
  });

  it("filters by search across title, reason and project", () => {
    const byReason = backlogGroups(tasks, projects, [], new Set(), { ...DEFAULT_BACKLOG_FILTERS, search: "legal" });
    assert.deepEqual(byReason.flatMap((group) => group.tasks.map((item) => item.id)), ["b1"]);
    const byProject = backlogGroups(tasks, projects, [], new Set(), { ...DEFAULT_BACKLOG_FILTERS, search: "charlie docs" });
    assert.deepEqual(byProject.flatMap((group) => group.tasks.map((item) => item.id)), ["c2"]);
  });

  it("filters by project and by status chips", () => {
    const onlyBravo = backlogGroups(tasks, projects, [], new Set(), { ...DEFAULT_BACKLOG_FILTERS, projectId: "b", statuses: ["hold"] });
    assert.deepEqual(onlyBravo.flatMap((group) => group.tasks.map((item) => item.id)), ["b2"]);
  });

  it("counts tasks and toggles statuses keeping the canonical order", () => {
    const groups = backlogGroups(tasks, projects, [], new Set(), DEFAULT_BACKLOG_FILTERS);
    assert.equal(countBacklog(groups), 4);
    assert.deepEqual(toggleBacklogStatus(["todo", "blocked"], "doing"), ["todo", "doing", "blocked"]);
    assert.deepEqual(toggleBacklogStatus(["todo", "doing"], "todo"), ["doing"]);
  });
});

describe("note lines and ambiguity", () => {
  it("prefers the lines in the note and falls back to the unlinked ones of an older hub", () => {
    assert.deepEqual(noteOnlyLines({ unlinked: ["- free"], inNote: ["- [ ] [[a|A]] - Other day", "- free"] }), ["- [ ] [[a|A]] - Other day", "- free"]);
    assert.deepEqual(noteOnlyLines({ unlinked: ["- free"] }), ["- free"]);
  });

  it("gives a short hint for every reason", () => {
    for (const reason of ["same-title", "unclear-line", "several-lines", "several-tasks", "duplicate-line"] as const) {
      const hint = ambiguityHint({ reason });
      assert.ok(hint.length > 10 && hint.length < 100, reason);
    }
    assert.match(ambiguityHint({ reason: "several-tasks" }), /not synced/);
  });
});

describe("lines changed in the note", () => {
  const item = (line: string, taskTitle = "Other task"): TodayOutOfSync => ({ line, taskTitle, projectId: "alpha", dailyCheckbox: "done", projectStatus: "todo" });

  it("hides the items the user kept and shows them again once the line changes", () => {
    const first = item("- [x] [[alpha|Alpha]] - Call the bank");
    const kept = [outOfSyncKey(first)];
    assert.deepEqual(visibleOutOfSync([first], kept), []);
    const changed = item("- [x] [[alpha|Alpha]] - Call the bank today");
    assert.deepEqual(visibleOutOfSync([changed], kept), [changed]);
    assert.deepEqual(keepDismissed(kept, [changed]), []);
    assert.deepEqual(keepDismissed(kept, [first, changed]), kept);
    assert.deepEqual(visibleOutOfSync(undefined, kept), []);
  });

  it("reads the stored dismissals defensively", () => {
    assert.deepEqual(parseDismissedOutOfSync('["a", 1, "b"]'), ["a", "b"]);
    assert.deepEqual(parseDismissedOutOfSync("not json"), []);
    assert.deepEqual(parseDismissedOutOfSync('{"a":1}'), []);
    assert.deepEqual(parseDismissedOutOfSync(""), []);
  });

  it("finds the task only when exactly one task of the project has the title", () => {
    const nested = task("t3", "alpha", 3, { title: "Other task" });
    const tasks = [task("t1", "alpha", 1, { title: "Ship" }, [nested]), task("t2", "beta", 2, { title: "Other task" })];
    assert.equal(taskOfOutOfSync(tasks, item("- [x] x"))?.id, "t3");
    assert.equal(taskOfOutOfSync([...tasks, task("t4", "alpha", 4, { title: "Other task" })], item("- [x] x")), null);
    assert.equal(taskOfOutOfSync(tasks, item("- [x] x", "Missing")), null);
  });
});

const yesterdayLine = (line: number, text: string, state: DailyYesterdayTask["state"] = "todo", block?: string): DailyYesterdayTask => ({
  line,
  depth: 0,
  state,
  checked: state === "done",
  text,
  raw: `- [ ] ${text}`,
  ...(block !== undefined ? { block } : {}),
});

const yesterdayNote = (tasks: DailyYesterdayTask[]): DailyYesterday => ({ date: "2026-11-11", path: "/daily/2026-11-11.md", closed: false, tasks });

describe("start the day: yesterday", () => {
  it("strips wikilinks and matches a line by the end of its title", () => {
    assert.equal(plainLineText("[[acme|Acme Corp]] - Renew  contract"), "Acme Corp - Renew contract");
    assert.equal(plainLineText("[[acme]] - x"), "acme - x");
    assert.equal(lineMatchesTitle("[[acme|Acme Corp]] - Renew contract", "renew contract"), true);
    assert.equal(lineMatchesTitle("Renew contract", "Renew contract"), true);
    assert.equal(lineMatchesTitle("Acme - Renew contract soon", "Renew contract"), false);
    assert.equal(lineMatchesTitle("anything", "  "), false);
  });

  it("lists carried tasks plus note lines no task explains, and keeps the done lines apart", () => {
    const carried = [entry(task("a", "acme", 3, { title: "Renew contract" }), "acme", "Acme Corp")];
    const board = [task("a", "acme", 3, { title: "Renew contract" }), task("g", "globex", 2, { title: "Rollout checklist" })];
    const yesterday = yesterdayNote([
      yesterdayLine(5, "[[acme|Acme Corp]] - Renew contract"),
      yesterdayLine(6, "[[globex|Globex]] - Rollout checklist"),
      yesterdayLine(7, "Call the accountant", "doing"),
      yesterdayLine(8, "Pay the invoice", "done"),
    ]);
    const plan = planYesterday(yesterday, carried, board);
    assert.deepEqual(
      plan.open.map((item) => item.key),
      ["task:a", "line:7"],
    );
    assert.deepEqual(
      plan.done.map((line) => line.line),
      [8],
    );
  });

  it("hides note lines already present in today's note", () => {
    const yesterday = yesterdayNote([yesterdayLine(1, "Book the dentist appointment"), yesterdayLine(2, "Call the accountant")]);
    assert.equal(lineInNote("Book the dentist appointment", ["- [ ] Book the dentist appointment", "- [x] Other"]), true);
    assert.equal(lineInNote("Book the dentist", ["- [ ] Book the dentist appointment"]), false);
    assert.deepEqual(
      planYesterday(yesterday, [], [], ["- [ ] Book the dentist appointment"]).open.map((item) => item.key),
      ["line:2"],
    );
  });

  it("handles a missing previous diary", () => {
    assert.deepEqual(planYesterday(null, [], []), { open: [], done: [] });
  });

  it("tracks which note lines still wait for a choice and which were brought", () => {
    const yesterday = yesterdayNote([yesterdayLine(1, "One", "todo", "- [ ] One"), yesterdayLine(2, "Two"), yesterdayLine(3, "Three")]);
    const { open } = planYesterday(yesterday, [], []);
    assert.deepEqual(pendingLineKeys(open, { "line:1": "bring", "line:2": "drop" }), ["line:3"]);
    assert.deepEqual(
      broughtLines(open, { "line:1": "bring", "line:2": "drop" }).map((line) => line.line),
      [1],
    );
  });
});

describe("start the day: compose", () => {
  const line = yesterdayLine(4, "Call the accountant", "doing", "- [-] Call the accountant");

  it("builds the compose body the wizard sends", () => {
    assert.deepEqual(composeStartDay({ summary: "  Shipped X\nFixed Y ", useSummary: true, meetingsText: "Standup 10:00\n\n  Review 15:00  ", lines: [line] }), {
      focus: [{ project: null, text: "Call the accountant", block: "- [-] Call the accountant" }],
      meetings: ["Standup 10:00", "Review 15:00"],
      briefing: "Shipped X\nFixed Y",
    });
  });

  it("omits the briefing when unchecked or empty and the block when the line has none", () => {
    assert.deepEqual(composeStartDay({ summary: "Shipped X", useSummary: false, meetingsText: "", lines: [yesterdayLine(1, "Plain")] }), {
      focus: [{ project: null, text: "Plain" }],
      meetings: [],
    });
    assert.equal("briefing" in composeStartDay({ summary: "  ", useSummary: true, meetingsText: "", lines: [] }), false);
  });

  it("closes yesterday like the wizard: done lines checked, the rest as they are", () => {
    const yesterday = yesterdayNote([yesterdayLine(1, "A", "done"), yesterdayLine(2, "B", "doing"), yesterdayLine(3, "C")]);
    assert.deepEqual(closeYesterdayBody(yesterday), {
      yesterday: "2026-11-11",
      tasks: [
        { line: 1, checked: true },
        { line: 2, checked: false },
        { line: 3, checked: false },
      ],
    });
  });

  it("merges the trail bullets into the summary", () => {
    assert.equal(trailSummary(null), "");
    assert.equal(trailSummary({ yesterdayTrail: { path: "p", bullets: ["- a", "- b", "- c", "- d"] } }), "- a\n- b\n- c");
    assert.equal(trailSummary({ yesterdayTrail: null }), "");
  });

  it("opens the panel on its own only when the note is missing and the day is not past", () => {
    assert.equal(startPanelAuto("2026-11-13", "2026-11-13", false), true);
    assert.equal(startPanelAuto("2026-11-14", "2026-11-13", false), true);
    assert.equal(startPanelAuto("2026-11-12", "2026-11-13", false), false);
    assert.equal(startPanelAuto("2026-11-13", "2026-11-13", true), false);
    assert.equal(planDraftKey("2026-11-13"), "hub.daily.plan.2026-11-13");
  });
});
