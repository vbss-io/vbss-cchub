import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { BoardProject, BoardTask, DailyYesterday, DailyYesterdayTask, TodayEntry, TodayOutOfSync } from "./delegation";
import {
  backlogGroups,
  backlogPriorityCounts,
  backlogTasks,
  hasCustomBacklogFilters,
  parseBacklogFilters,
  serializeBacklogFilters,
  windowBacklogGroups,
  backlogKeyIntent,
  broughtLines,
  closeYesterdayBody,
  composeStartDay,
  countBacklog,
  DEFAULT_BACKLOG_FILTERS,
  decodeDragTarget,
  describeDay,
  closesDay,
  encodeDragTarget,
  entryTaskIds,
  lineInNote,
  lineMatchesTitle,
  localDay,
  insertAnchorOf,
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
  linkTargetOfTask,
  linkTickInput,
  pickerTasks,
  unmatchedKey,
  noteOnlyLines,
  noteLineItems,
  canAddToFocus,
  addableNoteTasks,
  scheduledElsewhere,
  outOfSyncKey,
  parseDismissedOutOfSync,
  taskOfOutOfSync,
  visibleOutOfSync,
  focusFact,
  recentlyDoneTasks,
  clearedNotice,
  movesInNote,
  subtaskPlanOf,
  subtaskPlansOf,
  type BacklogFilters,
} from "./today-model";

const TODAY = "2026-11-12";
const SHOW_ALL: BacklogFilters = { ...DEFAULT_BACKLOG_FILTERS, hiddenPriorities: [] };

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

  it("closes only the day right before today, across month and year ends", () => {
    assert.equal(closesDay("2026-11-11", TODAY), true);
    assert.equal(closesDay(TODAY, TODAY), false);
    assert.equal(closesDay("2026-11-10", TODAY), false);
    assert.equal(closesDay("2026-11-13", TODAY), false);
    assert.equal(closesDay("2026-11-30", "2026-12-01"), true);
    assert.equal(closesDay("2026-12-31", "2027-01-01"), true);
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

  it("shows only the subtasks the hub lists as visible, and every subtask when the list is absent", () => {
    const parent = task("p", "a", 1, {}, [task("c1", "a", 2), task("c2", "a", 3, {}, [task("g1", "a", 4)]), task("c3", "a", 5)]);
    const [planned] = outlineGroupsOf([{ ...entry(parent, "a", "Alpha"), visibleSubtasks: ["c2", "g1"] }]);
    assert.deepEqual(
      planned?.items[0]?.children.map((child) => [child.id, child.children.map((grand) => grand.id)]),
      [["c2", ["g1"]]],
    );
    const [headOnly] = outlineGroupsOf([{ ...entry(parent, "a", "Alpha"), visibleSubtasks: [] }]);
    assert.deepEqual(headOnly?.items[0]?.children, []);
    const [legacy] = outlineGroupsOf([entry(parent, "a", "Alpha")]);
    assert.deepEqual(
      legacy?.items[0]?.children.map((child) => child.id),
      ["c1", "c2", "c3"],
    );
  });
});

describe("subtaskPlanOf", () => {
  const parent = task("p", "a", 1, {}, [
    task("c1", "a", 2),
    task("c2", "a", 3, { status: "doing" }),
    task("c3", "a", 4, { status: "done" }),
    task("c4", "a", 5, { status: "archived" }),
    task("c5", "a", 6, { repeat: "every week" }),
  ]);

  it("counts the open subtasks that can be planned and the ones left out of the day", () => {
    assert.deepEqual(subtaskPlanOf(parent, ["c2"]), { open: 2, hidden: 1 });
    assert.deepEqual(subtaskPlanOf(parent, []), { open: 2, hidden: 2 });
    assert.deepEqual(subtaskPlanOf(parent, undefined), { open: 2, hidden: 0 });
    assert.deepEqual(subtaskPlanOf(task("x", "a", 9), []), { open: 0, hidden: 0 });
  });

  it("indexes every task of the focus tree with the visible list of its entry", () => {
    const plans = subtaskPlansOf([{ ...entry(parent, "a", "Alpha"), visibleSubtasks: ["c1"] }]);
    assert.deepEqual(plans.get("p"), { open: 2, hidden: 1 });
    assert.deepEqual(plans.get("c1"), { open: 0, hidden: 0 });
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
    const groups = backlogGroups(tasks, projects, [], new Set(["a1"]), SHOW_ALL);
    const ids = groups.flatMap((group) => group.tasks.map((item) => item.id));
    assert.deepEqual(ids, ["a2", "b1", "c2"]);
  });

  it("orders groups by the project order", () => {
    const groups = backlogGroups(tasks, projects, ["c", "b"], new Set(), SHOW_ALL);
    assert.deepEqual(groups.map((group) => group.project.id), ["c", "b", "a"]);
  });

  it("filters by search across title, reason and project", () => {
    const byReason = backlogGroups(tasks, projects, [], new Set(), { ...SHOW_ALL, search: "legal" });
    assert.deepEqual(byReason.flatMap((group) => group.tasks.map((item) => item.id)), ["b1"]);
    const byProject = backlogGroups(tasks, projects, [], new Set(), { ...SHOW_ALL, search: "charlie docs" });
    assert.deepEqual(byProject.flatMap((group) => group.tasks.map((item) => item.id)), ["c2"]);
  });

  it("filters by project and by status chips", () => {
    const onlyBravo = backlogGroups(tasks, projects, [], new Set(), { ...SHOW_ALL, projectId: "b", statuses: ["hold"] });
    assert.deepEqual(onlyBravo.flatMap((group) => group.tasks.map((item) => item.id)), ["b2"]);
  });

  it("counts tasks and toggles statuses keeping the canonical order", () => {
    const groups = backlogGroups(tasks, projects, [], new Set(), SHOW_ALL);
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

  it("pairs each line in the note with its linked task and falls back to no task on an older hub", () => {
    const linked = task("a", "p", 4, { title: "Alpha" }, [task("a1", "p", 5)]);
    const tasks = [linked, task("b", "p", 6)];
    const data = {
      unlinked: ["- free"],
      inNote: ["- [ ] [[p|P]] - Alpha", "  - [ ] a1", "- free"],
      inNoteLinks: [
        { line: "- [ ] [[p|P]] - Alpha", taskId: "a" },
        { line: "  - [ ] a1", taskId: null },
        { line: "- free", taskId: null },
      ],
    };
    assert.deepEqual(
      noteLineItems(data, tasks).map((item) => [item.line, item.task?.id ?? null]),
      [["- [ ] [[p|P]] - Alpha", "a"], ["  - [ ] a1", null], ["- free", null]],
    );
    assert.deepEqual(noteLineItems({ ...data, inNoteLinks: [{ line: "- gone", taskId: "zzz" }] }, tasks), [{ line: "- gone", task: null }]);
    assert.deepEqual(noteLineItems({ unlinked: ["- free"], inNote: ["- x"] }, tasks), [{ line: "- x", task: null }]);
  });

  it("adds to focus only open tasks without a scheduled date, once each", () => {
    assert.equal(canAddToFocus(task("t", "p", 1)), true);
    assert.equal(canAddToFocus(task("t", "p", 1, { status: "blocked" })), true);
    assert.equal(canAddToFocus(task("t", "p", 1, { status: "doing" })), true);
    assert.equal(canAddToFocus(task("t", "p", 1, { status: "blocked", scheduled: "2026-11-20" })), false);
    assert.equal(canAddToFocus(task("t", "p", 1, { scheduled: TODAY })), false);
    assert.equal(canAddToFocus(task("t", "p", 1, { status: "archived" })), false);
    assert.equal(canAddToFocus(task("t", "p", 1, { status: "done", doneAt: "2026-11-01" })), false);
    assert.equal(canAddToFocus(task("t", "p", 1, { status: "done", doneAt: TODAY })), false);
    assert.equal(canAddToFocus(task("t", "p", 1, { status: "done", doneAt: null })), false);
    const a = task("a", "p", 1);
    const done = task("d", "p", 2, { status: "done", doneAt: "2026-11-01" });
    const planned = task("s", "p", 3, { status: "blocked", scheduled: "2026-11-20" });
    const items = [{ line: "- a", task: a }, { line: "- a again", task: a }, { line: "- d", task: done }, { line: "- s", task: planned }, { line: "- free", task: null }];
    assert.deepEqual(addableNoteTasks(items).map((item) => item.id), ["a"]);
  });

  it("names the other day a note line's task is scheduled for", () => {
    assert.equal(scheduledElsewhere(task("t", "p", 1, { scheduled: "2026-11-20" }), TODAY), "Scheduled 2026-11-20");
    assert.equal(scheduledElsewhere(task("t", "p", 1, { scheduled: TODAY }), TODAY), null);
    assert.equal(scheduledElsewhere(task("t", "p", 1), TODAY), null);
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

describe("ticked in the note, no task", () => {
  const unmatched = { line: "- [x] Pay the invoice", lineIndex: 7 };

  it("keys an item by its line index and text", () => {
    assert.notEqual(unmatchedKey(unmatched), unmatchedKey({ ...unmatched, lineIndex: 8 }));
    assert.notEqual(unmatchedKey(unmatched), unmatchedKey({ ...unmatched, line: "- [x] Other" }));
  });

  it("builds the apply and dismiss bodies", () => {
    const target = linkTargetOfTask(task("t1", "alpha", 12, { raw: "- [ ] Pay invoice" }));
    assert.deepEqual(target, { projectId: "alpha", line: 12, raw: "- [ ] Pay invoice" });
    assert.deepEqual(linkTickInput(unmatched, target), { lineIndex: 7, raw: "- [x] Pay the invoice", target, action: "apply" });
    assert.deepEqual(linkTickInput(unmatched, null), { lineIndex: 7, raw: "- [x] Pay the invoice", target: null, action: "dismiss" });
  });

  it("searches open tasks, subtasks included, by title and project and caps the list", () => {
    const nested = task("t3", "beta", 3, { title: "Pay supplier" });
    const tasks = [
      task("t1", "alpha", 1, { title: "Pay invoice" }, [nested]),
      task("t2", "beta", 2, { title: "Done thing", status: "done", checkbox: "done" }),
      task("t4", "beta", 4, { title: "Archive me", section: "done" }),
      task("t5", "beta", 5, { title: "Write report" }),
    ];
    const projects = [project("alpha", "Alpha"), project("beta", "Bravo")];
    assert.deepEqual(
      pickerTasks(tasks, projects, "").items.map((item) => item.task.id),
      ["t1", "t3", "t5"],
    );
    assert.deepEqual(
      pickerTasks(tasks, projects, "pay bravo").items.map((item) => [item.task.id, item.projectTitle]),
      [["t3", "Bravo"]],
    );
    assert.deepEqual(pickerTasks(tasks, projects, "nothing here"), { items: [], total: 0 });
    assert.deepEqual(pickerTasks(tasks, projects, "", 2), { items: pickerTasks(tasks, projects, "").items.slice(0, 2), total: 3 });
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

  it("closes yesterday by sending no task states, so no task line is rewritten", () => {
    const yesterday = yesterdayNote([yesterdayLine(1, "A", "done"), yesterdayLine(2, "B", "doing"), yesterdayLine(3, "C")]);
    assert.deepEqual(closeYesterdayBody(yesterday), { yesterday: "2026-11-11", tasks: [] });
    assert.deepEqual(closeYesterdayBody(yesterdayNote([])), { yesterday: "2026-11-11", tasks: [] });
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

describe("recentlyDoneTasks", () => {
  const projects = [project("acme", "Acme"), project("bravo", "Bravo")];
  const done = (id: string, projectId: string, line: number, doneAt: string | null, patch: Partial<BoardTask> = {}): BoardTask =>
    task(id, projectId, line, { status: "done", checkbox: "done", section: "done", doneAt, ...patch });

  it("lists done tasks stamped within the last 7 days, newest first, and drops older and undated ones", () => {
    const tasks = [
      done("old", "acme", 10, "2026-11-04"),
      done("edge", "acme", 11, "2026-11-05"),
      done("yesterday", "bravo", 12, "2026-11-11"),
      done("undated", "acme", 13, null),
      done("today", "acme", 14, "2026-11-12"),
      task("open", "acme", 1),
    ];
    assert.deepEqual(
      recentlyDoneTasks(tasks, projects, "", TODAY).items.map((item) => item.task.id),
      ["today", "yesterday", "edge"],
    );
  });

  it("includes a done task that still sits in the open section and done subtasks", () => {
    const tasks = [task("parent", "acme", 1, {}, [done("child", "acme", 2, "2026-11-10", { section: "open" })]), done("stale", "acme", 3, "2026-10-01", { section: "open" }), done("kept", "bravo", 4, "2026-11-09", { section: "open" })];
    assert.deepEqual(
      recentlyDoneTasks(tasks, projects, "", TODAY).items.map((item) => item.task.id),
      ["child", "kept"],
    );
  });

  it("filters by title and project words, reports the project title and honours the limit", () => {
    const tasks = [done("pay-invoice", "acme", 1, "2026-11-11"), done("pay-rent", "bravo", 2, "2026-11-11"), done("ship", "bravo", 3, "2026-11-10")];
    assert.deepEqual(
      recentlyDoneTasks(tasks, projects, "pay bravo", TODAY).items.map((item) => [item.task.id, item.projectTitle]),
      [["pay-rent", "Bravo"]],
    );
    assert.deepEqual(recentlyDoneTasks(tasks, projects, "nothing here", TODAY), { items: [], total: 0 });
    assert.deepEqual(recentlyDoneTasks(tasks, projects, "", TODAY, 2).total, 3);
    assert.equal(recentlyDoneTasks(tasks, projects, "", TODAY, 2).items.length, 2);
  });

  it("uses the date at the start of the month window across a month boundary", () => {
    const tasks = [done("a", "acme", 1, "2026-10-29"), done("b", "acme", 2, "2026-10-28")];
    assert.deepEqual(
      recentlyDoneTasks(tasks, projects, "", "2026-11-05").items.map((item) => item.task.id),
      ["a"],
    );
  });
});

describe("focusFact", () => {
  it("says the task is in today's focus when scheduled for today", () => {
    assert.equal(focusFact("2026-11-12", TODAY), "In today's focus");
  });

  it("names another scheduled date", () => {
    assert.equal(focusFact("2026-11-17", TODAY), "Scheduled 2026-11-17");
  });

  it("says nothing without a scheduled date", () => {
    assert.equal(focusFact(null, TODAY), null);
    assert.equal(focusFact(undefined, TODAY), null);
    assert.equal(focusFact("", TODAY), null);
  });
});

describe("insertAnchorOf", () => {
  it("anchors a top-level task of the open section by its line and raw text", () => {
    const tasks = [task("a", "acme", 5), task("b", "acme", 6)];
    assert.deepEqual(insertAnchorOf(tasks, "b"), { line: 6, raw: tasks[1]?.raw });
  });

  it("anchors a nested subtask", () => {
    const kid = task("kid", "acme", 2);
    const tasks = [task("parent", "acme", 1, {}, [kid])];
    assert.deepEqual(insertAnchorOf(tasks, "kid"), { line: 2, raw: kid.raw });
  });

  it("gives no anchor for a task in the done section or an unknown one", () => {
    const tasks = [task("finished", "acme", 30, { section: "done" })];
    assert.equal(insertAnchorOf(tasks, "finished"), null);
    assert.equal(insertAnchorOf(tasks, "missing"), null);
  });

  it("gives no anchor inside a finished occurrence of a recurring task", () => {
    const kid = task("kid", "acme", 4);
    const tasks = [task("weekly", "acme", 3, { repeat: "every week", doneAt: "2026-11-13" }, [kid]), task("live", "acme", 6, { repeat: "every week" })];
    assert.equal(insertAnchorOf(tasks, "weekly"), null);
    assert.equal(insertAnchorOf(tasks, "kid"), null);
    assert.deepEqual(insertAnchorOf(tasks, "live"), { line: 6, raw: tasks[1]?.raw });
  });
});

describe("backlog priority and in-Today filters", () => {
  const projects = [project("a", "Alpha"), project("b", "Bravo")];
  const tasks = [
    task("a1", "a", 1, { priority: 0 }),
    task("a2", "a", 2, { priority: 2 }),
    task("a3", "a", 3),
    task("b1", "b", 1, { priority: 0 }),
  ];

  it("hides the priorities switched off, no priority included", () => {
    const shown = backlogTasks(tasks, projects, new Set(), { ...DEFAULT_BACKLOG_FILTERS, hiddenPriorities: [0, null] });
    assert.deepEqual(shown.map((item) => item.id), ["a2"]);
  });

  it("starts with the no-priority tasks hidden and P0-P3 shown", () => {
    assert.deepEqual(DEFAULT_BACKLOG_FILTERS.hiddenPriorities, [null]);
    assert.deepEqual(backlogTasks(tasks, projects, new Set(), DEFAULT_BACKLOG_FILTERS).map((item) => item.id), ["a1", "a2", "b1"]);
    assert.deepEqual(backlogTasks(tasks, projects, new Set(), SHOW_ALL).map((item) => item.id), ["a1", "a2", "a3", "b1"]);
  });

  it("keeps a saved choice and only treats the new default as untouched", () => {
    assert.deepEqual(parseBacklogFilters('{"v":2,"statuses":["todo"],"hiddenPriorities":[],"showInToday":true}').hiddenPriorities, []);
    assert.deepEqual(parseBacklogFilters('{"statuses":["todo"],"hiddenPriorities":[3]}').hiddenPriorities, [3]);
    assert.equal(hasCustomBacklogFilters(DEFAULT_BACKLOG_FILTERS), false);
    assert.equal(hasCustomBacklogFilters(SHOW_ALL), true);
    assert.equal(hasCustomBacklogFilters({ ...DEFAULT_BACKLOG_FILTERS, hiddenPriorities: [null, 3] }), true);
  });

  it("migrates an unversioned value that saved the old empty default to hide No priority, keeping the rest, and stores the version", () => {
    const legacy = parseBacklogFilters('{"projectId":"a","statuses":["todo","hold"],"hiddenPriorities":[],"showInToday":false}');
    assert.deepEqual(legacy, { search: "", projectId: "a", statuses: ["todo", "hold"], hiddenPriorities: [null], showInToday: false });
    assert.deepEqual(parseBacklogFilters('{"projectId":null,"statuses":["todo"]}').hiddenPriorities, [null]);
    assert.deepEqual(parseBacklogFilters('{"statuses":["todo"],"hiddenPriorities":[null,2]}').hiddenPriorities, [null, 2]);
    const saved = JSON.parse(serializeBacklogFilters(legacy)) as { v: number; hiddenPriorities: (number | null)[] };
    assert.equal(saved.v, 2);
    assert.deepEqual(saved.hiddenPriorities, [null]);
    const shownAgain = serializeBacklogFilters({ ...legacy, hiddenPriorities: [] });
    assert.deepEqual(parseBacklogFilters(shownAgain).hiddenPriorities, []);
  });

  it("shows the tasks already in Today by default and hides them when the toggle is off, carried ones always out", () => {
    const inToday = new Set(["a1"]);
    assert.deepEqual(backlogTasks(tasks, projects, new Set(["b1"]), SHOW_ALL, inToday).map((item) => item.id), ["a1", "a2", "a3"]);
    assert.deepEqual(backlogTasks(tasks, projects, new Set(["b1"]), { ...SHOW_ALL, showInToday: false }, inToday).map((item) => item.id), ["a2", "a3"]);
  });

  it("remembers project, statuses, priorities and the toggle but never the search", () => {
    const stored = serializeBacklogFilters({ search: "secret", projectId: "a", statuses: ["hold"], hiddenPriorities: [null, 3], showInToday: false });
    assert.deepEqual(parseBacklogFilters(stored), { search: "", projectId: "a", statuses: ["hold"], hiddenPriorities: [null, 3], showInToday: false });
    assert.deepEqual(parseBacklogFilters("nope"), DEFAULT_BACKLOG_FILTERS);
    assert.deepEqual(parseBacklogFilters('{"statuses":[],"hiddenPriorities":["x",1,1,42]}'), { ...DEFAULT_BACKLOG_FILTERS, hiddenPriorities: [1] });
    assert.equal(hasCustomBacklogFilters(DEFAULT_BACKLOG_FILTERS), false);
    assert.equal(hasCustomBacklogFilters({ ...DEFAULT_BACKLOG_FILTERS, hiddenPriorities: [1] }), true);
    assert.equal(hasCustomBacklogFilters({ ...DEFAULT_BACKLOG_FILTERS, showInToday: false }), true);
  });

  it("windows the grouped backlog to the first tasks so a long backlog does not make the page endless", () => {
    const groups = backlogGroups(tasks, projects, [], new Set(), SHOW_ALL);
    assert.deepEqual(windowBacklogGroups(groups, 2).map((group) => [group.project.id, group.tasks.map((item) => item.id)]), [["a", ["a1", "a2"]]]);
    assert.deepEqual(windowBacklogGroups(groups, 4).map((group) => group.tasks.length), [3, 1]);
    assert.deepEqual(windowBacklogGroups(groups, 0), []);
    assert.deepEqual([...backlogPriorityCounts(tasks).entries()], [[0, 2], [2, 1], [null, 1]]);
  });
});

describe("G00c: the focus follows the lines of the note", () => {
  it("moves only a top item through the note and keeps subtasks on the board", () => {
    assert.equal(movesInNote({ depth: 0 }), true);
    assert.equal(movesInNote({ depth: 1 }), false);
  });

  it("describes a clear with its counts and an empty clear plainly", () => {
    assert.equal(clearedNotice({ lines: 3, unscheduled: 2 }, true), "Cleared today: 3 lines out of the note, 2 dates out of the projects");
    assert.equal(clearedNotice({ lines: 1, unscheduled: 1 }, false), "Cleared this day: 1 line out of the note, 1 date out of the projects");
    assert.equal(clearedNotice({ lines: 0, unscheduled: 0 }, true), "Nothing to clear for today");
  });
});
