import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeStatuses,
  BOARD_STATUS_LABEL,
  comparePriority,
  DEFAULT_PRIORITY_LEVELS,
  nextTableSort,
  priorityFilterLevels,
  priorityLabel,
  priorityLevelList,
  remapExpanded,
  priorityTone,
  sortByPriority,
  sortTableTasks,
  toggleHiddenPriority,
  validateNoteText,
  candidateLabels,
  capDoneSection,
  DONE_SECTION_PAGE,
  doneColumnView,
  newTaskBody,
  orderDoneColumn,
  reasonChange,
  sweepTargets,
  todayAddState,
  todayHint,
  todayIdSet,
  supportsReason,
  validateNewTask,
  validateTaskSettings,
  DEFAULT_BOARD_PREFS,
  allExpanded,
  delegatePromptFor,
  expandableIds,
  filterBoardTasks,
  findBoardTask,
  focusItemFromTask,
  formatList,
  groupByStatus,
  kanbanColumns,
  parseBoardPrefs,
  parseList,
  pickableTasks,
  projectBreadcrumb,
  projectOptions,
  projectScope,
  renderTaskDelegatePrompt,
  replaceBoardTask,
  subtaskProgress,
  taskPromptVars,
  visibleKanbanColumns,
  activeFilterNotes,
  BOARD_STATUSES,
  emptyResultsMessage,
  hasCustomFilters,
  hasDefaultStatuses,
  multiSelectSummary,
  priorityFilterSummary,
  resetFilterPrefs,
  statusFilterSummary,
  todayAvailability,
  todayMissingHint,
  viewSummary,
  findParentTask,
  findTaskAfterRefetch,
  isSubtask,
  moveTargetProjects,
  noteMoveAvailability,
  obsidianUrl,
  orderedChildren,
  organizeFocus,
  parentCandidateLabel,
  parentCandidates,
  remapTaskId,
  taskMoveAvailability,
  type BoardFilters,
  type BoardPrefs,
} from "./board-model";
import type { BoardNoteItem, BoardProject, BoardStatus, BoardTask, BoardToday } from "./delegation";

function project(id: string, parent: string | null, depth: number, extra: Partial<BoardProject> = {}): BoardProject {
  const name = id.split("/").pop() as string;
  return { id, name, title: name.toUpperCase(), parent, depth, path: `/vault/${id}.md`, workspace: null, workspaceSource: null, ...extra };
}

function task(projectId: string, line: number, title: string, status: BoardStatus = "todo", extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id: `${projectId}#${line}`,
    projectId,
    line,
    raw: `- [ ] ${title}`,
    depth: 0,
    checkbox: status === "done" ? "done" : status === "doing" ? "doing" : "todo",
    prefix: null,
    status,
    title,
    reason: null,
    section: "open",
    doneAt: null,
    group: null,
    priority: null,
    notes: [],
    noteItems: [],
    subtasks: [],
    ...extra,
  };
}

const PROJECTS: BoardProject[] = [
  project("acme", null, 0),
  project("acme/globex", "acme", 1),
  project("acme/globex/initech", "acme/globex", 2),
  project("acme/globex/hooli", "acme/globex", 2),
  project("personal", null, 0),
];

const filters = (patch: Partial<BoardFilters> = {}): BoardFilters => ({ ...DEFAULT_BOARD_PREFS.filters, ...patch });

test("projectScope returns the project plus every descendant when subprojects are included", () => {
  const scope = projectScope(PROJECTS, "acme/globex", true);
  assert.deepEqual([...(scope as Set<string>)].sort(), ["acme/globex", "acme/globex/hooli", "acme/globex/initech"]);
});

test("projectScope returns only the project when subprojects are excluded", () => {
  assert.deepEqual([...(projectScope(PROJECTS, "acme/globex", false) as Set<string>)], ["acme/globex"]);
});

test("projectScope is null with no project or an unknown project", () => {
  assert.equal(projectScope(PROJECTS, null, true), null);
  assert.equal(projectScope(PROJECTS, "gone", true), null);
});

test("filterBoardTasks restricts to a project and its descendants", () => {
  const tasks = [task("acme", 1, "root"), task("acme/globex", 2, "globex"), task("acme/globex/hooli", 3, "hooli"), task("personal", 4, "own")];
  const included = filterBoardTasks(tasks, PROJECTS, filters({ projectId: "acme/globex" }));
  assert.deepEqual(included.map((item) => item.title), ["globex", "hooli"]);
  const exact = filterBoardTasks(tasks, PROJECTS, filters({ projectId: "acme/globex", includeSubprojects: false }));
  assert.deepEqual(exact.map((item) => item.title), ["globex"]);
});

test("filterBoardTasks drops archived tasks by default and keeps them when the archived chip is on", () => {
  const tasks = [task("acme", 1, "live"), task("acme", 2, "old", "archived")];
  assert.deepEqual(filterBoardTasks(tasks, PROJECTS, filters()).map((item) => item.title), ["live"]);
  const withArchived = filterBoardTasks(tasks, PROJECTS, filters({ statuses: ["todo", "archived"] }));
  assert.deepEqual(withArchived.map((item) => item.title), ["live", "old"]);
});

test("filterBoardTasks applies the multi-status filter", () => {
  const tasks = [task("acme", 1, "a", "blocked"), task("acme", 2, "b", "doing"), task("acme", 3, "c", "done")];
  const picked = filterBoardTasks(tasks, PROJECTS, filters({ statuses: ["blocked", "done"] }));
  assert.deepEqual(picked.map((item) => item.title), ["a", "c"]);
});

test("filterBoardTasks searches title, group, notes, subtasks and project case-insensitively", () => {
  const tasks = [
    task("acme", 1, "Ship export"),
    task("acme", 2, "Other", "todo", { group: "Billing" }),
    task("acme", 3, "Third", "todo", { notes: ["call the Vendor"] }),
    task("acme", 4, "Fourth", "todo", { subtasks: [task("acme", 5, "write migration")] }),
    task("personal", 6, "Fifth"),
  ];
  const search = (text: string) => filterBoardTasks(tasks, PROJECTS, filters({ search: text })).map((item) => item.title);
  assert.deepEqual(search("EXPORT"), ["Ship export"]);
  assert.deepEqual(search("billing"), ["Other"]);
  assert.deepEqual(search("vendor"), ["Third"]);
  assert.deepEqual(search("migration"), ["Fourth"]);
  assert.deepEqual(search("personal"), ["Fifth"]);
  assert.deepEqual(search("  "), tasks.map((item) => item.title));
});

test("activeStatuses falls back to every non-archived status and keeps canonical order", () => {
  assert.deepEqual(activeStatuses(filters({ statuses: [] })), ["blocked", "hold", "todo", "doing", "done"]);
  assert.deepEqual(activeStatuses(filters({ statuses: ["done", "blocked"] })), ["blocked", "done"]);
});

test("kanbanColumns always lists the five working columns and adds Archived only when filtered on", () => {
  assert.deepEqual(kanbanColumns(filters()), ["blocked", "hold", "todo", "doing", "done"]);
  assert.deepEqual(kanbanColumns(filters({ statuses: ["todo", "archived"] })), ["blocked", "hold", "todo", "doing", "done", "archived"]);
});

test("groupByStatus buckets tasks per status and keeps order", () => {
  const tasks = [task("acme", 1, "a", "doing"), task("acme", 2, "b", "todo"), task("acme", 3, "c", "doing")];
  const groups = groupByStatus(tasks);
  assert.deepEqual(groups.doing.map((item) => item.title), ["a", "c"]);
  assert.deepEqual(groups.todo.map((item) => item.title), ["b"]);
  assert.deepEqual(groups.archived, []);
  assert.deepEqual(Object.keys(groups), ["blocked", "hold", "todo", "doing", "done", "archived"]);
});

test("BOARD_STATUS_LABEL names every column", () => {
  assert.equal(BOARD_STATUS_LABEL.todo, "To-Do");
  assert.equal(BOARD_STATUS_LABEL.blocked, "Blocked");
  assert.equal(BOARD_STATUS_LABEL.archived, "Archived");
});

test("projectBreadcrumb lists ancestor titles from the root down to the project", () => {
  assert.deepEqual(projectBreadcrumb(PROJECTS, "acme/globex/initech"), ["ACME", "GLOBEX", "INITECH"]);
  assert.deepEqual(projectBreadcrumb(PROJECTS, "personal"), ["PERSONAL"]);
  assert.deepEqual(projectBreadcrumb(PROJECTS, "missing"), []);
});

test("projectBreadcrumb survives a parent cycle", () => {
  const cyclic = [project("a", "b", 1), project("b", "a", 1)];
  assert.deepEqual(projectBreadcrumb(cyclic, "a"), ["B", "A"]);
});

test("projectOptions indents labels by depth", () => {
  const options = projectOptions(PROJECTS);
  assert.equal(options.length, 5);
  assert.equal(options[0]?.label, "ACME");
  assert.equal(options[2]?.label, `${String.fromCharCode(160).repeat(4)}INITECH`);
  assert.equal(options[2]?.id, "acme/globex/initech");
});

test("subtaskProgress counts every nested subtask and the done ones", () => {
  const nested = task("acme", 1, "parent", "todo", {
    subtasks: [
      task("acme", 2, "one", "done"),
      task("acme", 3, "two", "todo", { subtasks: [task("acme", 4, "deep", "done"), task("acme", 5, "deeper", "doing")] }),
    ],
  });
  assert.deepEqual(subtaskProgress(nested), { done: 2, total: 4 });
  assert.deepEqual(subtaskProgress(task("acme", 9, "leaf")), { done: 0, total: 0 });
});

test("taskPromptVars mirrors the server variables", () => {
  const target = task("acme", 1, "Fix login", "doing", {
    notes: ["see ticket 4"],
    subtasks: [task("acme", 2, "write test", "done", { checkbox: "done" }), task("acme", 3, "patch", "blocked", { prefix: "BLOCK", subtasks: [task("acme", 4, "ask ops", "doing", { checkbox: "doing" })] })],
  });
  const vars = taskPromptVars(project("acme", null, 0, { title: "Acme Corp" }), target);
  assert.deepEqual(vars, {
    project: "Acme Corp",
    projectPath: "/vault/acme.md",
    task: "Fix login",
    subtasks: "- [x] write test\n- [ ] BLOCK - patch\n  - [-] ask ops",
    notes: "- see ticket 4",
    status: "doing",
    reason: "none",
    priority: "none",
  });
});

test("taskPromptVars uses 'none' for empty subtasks and notes", () => {
  const vars = taskPromptVars(PROJECTS[0] as BoardProject, task("acme", 1, "x"));
  assert.equal(vars.subtasks, "none");
  assert.equal(vars.notes, "none");
});

test("renderTaskDelegatePrompt replaces every placeholder, including repeated ones", () => {
  const rendered = renderTaskDelegatePrompt("{{project}}|{{projectPath}}|{{task}}|{{task}}|{{subtasks}}|{{notes}}|{{status}}|{{unknown}}|{{priority}}", {
    project: "P",
    projectPath: "/p.md",
    task: "T",
    subtasks: "none",
    notes: "none",
    status: "todo",
    reason: "none",
    priority: "P1",
  });
  assert.equal(rendered, "P|/p.md|T|T|none|none|todo|{{unknown}}|P1");
});

test("delegatePromptFor renders a template for a project and task", () => {
  const text = delegatePromptFor("Do {{task}} in {{project}}", project("acme", null, 0, { title: "Acme" }), task("acme", 1, "the thing"));
  assert.equal(text, "Do the thing in Acme");
});

test("replaceBoardTask swaps a nested task by id without touching the rest", () => {
  const child = task("acme", 2, "child");
  const tasks = [task("acme", 1, "parent", "todo", { subtasks: [child] }), task("personal", 7, "other")];
  const next = replaceBoardTask(tasks, { ...child, status: "done", title: "child!" });
  assert.equal(next[0]?.subtasks[0]?.title, "child!");
  assert.equal(next[0]?.subtasks[0]?.status, "done");
  assert.equal(next[1], tasks[1]);
  assert.equal(tasks[0]?.subtasks[0]?.title, "child");
});

test("findBoardTask locates nested tasks", () => {
  const tasks = [task("acme", 1, "parent", "todo", { subtasks: [task("acme", 2, "child")] })];
  assert.equal(findBoardTask(tasks, "acme#2")?.title, "child");
  assert.equal(findBoardTask(tasks, "acme#9"), null);
});

test("pickableTasks lists only todo and doing top-level tasks, honouring the project filter", () => {
  const tasks = [
    task("acme", 1, "todo one"),
    task("acme", 2, "doing one", "doing"),
    task("acme", 3, "done one", "done"),
    task("acme", 4, "blocked one", "blocked"),
    task("acme/globex", 5, "globex todo"),
    task("personal", 6, "own todo"),
  ];
  assert.deepEqual(pickableTasks(tasks, PROJECTS, null).map((item) => item.title), ["todo one", "doing one", "globex todo", "own todo"]);
  assert.deepEqual(pickableTasks(tasks, PROJECTS, "acme").map((item) => item.title), ["todo one", "doing one", "globex todo"]);
  assert.deepEqual(pickableTasks(tasks, PROJECTS, "acme/globex").map((item) => item.title), ["globex todo"]);
});

test("focusItemFromTask uses the project name and the task title", () => {
  assert.deepEqual(focusItemFromTask(project("acme/globex", "acme", 1), task("acme/globex", 1, "Ship export")), {
    project: "globex",
    text: "Ship export",
  });
});

test("parseBoardPrefs returns defaults for missing or broken storage", () => {
  assert.deepEqual(parseBoardPrefs(null), DEFAULT_BOARD_PREFS);
  assert.deepEqual(parseBoardPrefs("{nope"), DEFAULT_BOARD_PREFS);
  assert.deepEqual(parseBoardPrefs("42"), DEFAULT_BOARD_PREFS);
});

test("parseBoardPrefs keeps valid fields and discards invalid ones", () => {
  const stored = JSON.stringify({ view: "table", filters: { projectId: "acme", includeSubprojects: false, statuses: ["todo", "bogus", "archived"], search: "abc", todayOnly: true } });
  assert.deepEqual(parseBoardPrefs(stored), {
    view: "table",
    hideEmptyColumns: true,
    tableSort: { key: "priority", dir: "asc" },
    filters: { projectId: "acme", includeSubprojects: false, statuses: ["todo", "archived"], search: "abc", todayOnly: true, hiddenPriorities: [] },
  });
  const partial = parseBoardPrefs(JSON.stringify({ view: "grid", filters: { projectId: 3, statuses: "todo" } }));
  assert.deepEqual(partial, DEFAULT_BOARD_PREFS);
});

test("default prefs show the kanban with every working status and subprojects included", () => {
  assert.equal(DEFAULT_BOARD_PREFS.view, "kanban");
  assert.equal(DEFAULT_BOARD_PREFS.filters.includeSubprojects, true);
  assert.equal(DEFAULT_BOARD_PREFS.filters.projectId, null);
  assert.deepEqual(DEFAULT_BOARD_PREFS.filters.statuses, ["blocked", "hold", "todo", "doing", "done"]);
});

test("hideEmptyColumns defaults to true and survives saved prefs without the field", () => {
  assert.equal(DEFAULT_BOARD_PREFS.hideEmptyColumns, true);
  assert.equal(parseBoardPrefs(JSON.stringify({ view: "table", filters: {} })).hideEmptyColumns, true);
  assert.equal(parseBoardPrefs(JSON.stringify({ hideEmptyColumns: "no" })).hideEmptyColumns, true);
  assert.equal(parseBoardPrefs(JSON.stringify({ hideEmptyColumns: false })).hideEmptyColumns, false);
  assert.equal(parseBoardPrefs(JSON.stringify({ hideEmptyColumns: true })).hideEmptyColumns, true);
});

const COUNTS: Record<BoardStatus, number> = { blocked: 0, hold: 2, todo: 0, doing: 1, done: 0, archived: 0 };
const WORKING: BoardStatus[] = ["blocked", "hold", "todo", "doing", "done"];

test("visibleKanbanColumns hides columns without cards when the preference is on", () => {
  assert.deepEqual(visibleKanbanColumns(WORKING, COUNTS, true, false), ["hold", "doing"]);
});

test("visibleKanbanColumns keeps every column when the preference is off", () => {
  assert.deepEqual(visibleKanbanColumns(WORKING, COUNTS, false, false), WORKING);
});

test("visibleKanbanColumns shows every column while a drag is in progress", () => {
  assert.deepEqual(visibleKanbanColumns(WORKING, COUNTS, true, true), WORKING);
});

test("visibleKanbanColumns is empty when every column is empty and no drag is active", () => {
  const empty: Record<BoardStatus, number> = { blocked: 0, hold: 0, todo: 0, doing: 0, done: 0, archived: 0 };
  assert.deepEqual(visibleKanbanColumns(WORKING, empty, true, false), []);
  assert.deepEqual(visibleKanbanColumns(WORKING, empty, true, true), WORKING);
});

const nested = (): BoardTask[] => [
  task("acme", 1, "root", "todo", {
    subtasks: [
      task("acme", 2, "with notes", "todo", { notes: ["a note"] }),
      task("acme", 3, "leaf"),
      task("acme", 4, "with children", "todo", { subtasks: [task("acme", 5, "deep", "todo", { notes: ["deep note"] }), task("acme", 6, "deep leaf")] }),
    ],
  }),
  task("acme", 7, "second"),
];

test("expandableIds lists every top-level task and every nested task so any of them can take a note", () => {
  assert.deepEqual(expandableIds(nested()), ["acme#1", "acme#2", "acme#3", "acme#4", "acme#5", "acme#6", "acme#7"]);
});

test("expandableIds is empty for no tasks", () => {
  assert.deepEqual(expandableIds([]), []);
});

test("allExpanded is true only when every expandable id is expanded", () => {
  const tasks = nested();
  assert.equal(allExpanded(tasks, new Set(expandableIds(tasks))), true);
  assert.equal(allExpanded(tasks, new Set(["acme#1", "acme#7"])), false);
  assert.equal(allExpanded(tasks, new Set()), false);
  assert.equal(allExpanded([], new Set()), false);
});

test("parseList splits comma separated values, trimming and dropping blanks", () => {
  assert.deepEqual(parseList(" BLOCK, BLOCKED ,, HOLD "), ["BLOCK", "BLOCKED", "HOLD"]);
  assert.deepEqual(parseList("   "), []);
  assert.equal(formatList(["_*", "drafts"]), "_*, drafts");
  assert.deepEqual(parseList(formatList(["a", "b"])), ["a", "b"]);
});


const doneTask = (line: number, title: string, section: "open" | "done", doneAt: string | null): BoardTask =>
  task("acme", line, title, "done", { section, doneAt });

const todayBlock = (patch: Partial<BoardToday> = {}): BoardToday => ({ date: "2026-10-23", exists: true, taskIds: [], states: {}, ...patch });

test("supportsReason is true only for blocked, hold and archived", () => {
  assert.deepEqual((["blocked", "hold", "todo", "doing", "done", "archived"] as BoardStatus[]).filter(supportsReason), ["blocked", "hold", "archived"]);
});

test("orderDoneColumn lists open-section tasks first, then done-section tasks by doneAt desc with undated last", () => {
  const ordered = orderDoneColumn([
    doneTask(1, "old", "done", "2026-10-01"),
    doneTask(2, "open-a", "open", null),
    doneTask(3, "undated", "done", null),
    doneTask(4, "new", "done", "2026-10-20"),
    doneTask(5, "open-b", "open", null),
  ]);
  assert.deepEqual(ordered.map((item) => item.title), ["open-a", "open-b", "new", "old", "undated"]);
});

test("orderDoneColumn keeps the input order for equal dates", () => {
  const ordered = orderDoneColumn([doneTask(1, "a", "done", "2026-10-05"), doneTask(2, "b", "done", "2026-10-05")]);
  assert.deepEqual(ordered.map((item) => item.title), ["a", "b"]);
});

test("capDoneSection keeps every open-section task and the newest done-section tasks up to the limit", () => {
  const tasks = [
    doneTask(1, "o1", "open", null),
    doneTask(2, "d-old", "done", "2026-09-01"),
    doneTask(3, "d-new", "done", "2026-10-22"),
    doneTask(4, "d-mid", "done", "2026-10-10"),
    doneTask(5, "o2", "open", null),
  ];
  const capped = capDoneSection(tasks, 2);
  assert.deepEqual(capped.tasks.map((item) => item.title), ["o1", "d-new", "d-mid", "o2"]);
  assert.equal(capped.hidden, 1);
  const all = capDoneSection(tasks, 10);
  assert.equal(all.tasks.length, 5);
  assert.equal(all.hidden, 0);
});

test("doneColumnView orders then caps, defaulting the page size to 20", () => {
  assert.equal(DONE_SECTION_PAGE, 20);
  const many = Array.from({ length: 25 }, (_, index) => doneTask(index + 1, "t" + (index + 1), "done", "2026-10-" + String((index % 28) + 1).padStart(2, "0")));
  const view = doneColumnView([doneTask(99, "open", "open", null), ...many], DONE_SECTION_PAGE);
  assert.equal(view.tasks.length, 21);
  assert.equal(view.tasks[0]?.title, "open");
  assert.equal(view.hidden, 5);
});

test("todayIdSet is null without a today block and a set of task ids with one", () => {
  assert.equal(todayIdSet(null), null);
  assert.deepEqual([...(todayIdSet(todayBlock({ taskIds: ["a#1", "a#2"] })) as ReadonlySet<string>)], ["a#1", "a#2"]);
});

test("todayHint returns the daily checkbox state of a linked task", () => {
  const today = todayBlock({ taskIds: ["acme#1"], states: { "acme#1": "doing" } });
  assert.equal(todayHint(today, "acme#1"), "doing");
  assert.equal(todayHint(today, "acme#2"), null);
  assert.equal(todayHint(null, "acme#1"), null);
});

test("todayAddState explains why adding to today is unavailable", () => {
  assert.equal(todayAddState(null).allowed, false);
  assert.equal(todayAddState(null).visible, false);
  assert.equal(todayAddState(todayBlock({ exists: false })).visible, true);
  assert.match(todayAddState(null).hint, /Daily/);
  assert.equal(todayAddState(todayBlock({ exists: false })).allowed, false);
  assert.match(todayAddState(todayBlock({ exists: false })).hint, /Create today's daily/);
  assert.deepEqual(todayAddState(todayBlock()), { visible: true, allowed: true, hint: "Add to today's daily" });
});

test("filterBoardTasks narrows to tasks in today's daily when todayOnly is on, counting linked subtasks", () => {
  const child = task("acme", 3, "child");
  const tasks = [task("acme", 1, "linked"), task("acme", 2, "parent", "todo", { subtasks: [child] }), task("acme", 4, "other")];
  const ids = new Set(["acme#1", child.id]);
  const picked = filterBoardTasks(tasks, PROJECTS, filters({ todayOnly: true }), ids);
  assert.deepEqual(picked.map((item) => item.title), ["linked", "parent"]);
  assert.equal(filterBoardTasks(tasks, PROJECTS, filters({ todayOnly: true }), null).length, 3);
  assert.equal(filterBoardTasks(tasks, PROJECTS, filters(), ids).length, 3);
});

test("parseBoardPrefs defaults todayOnly to false and rejects non-boolean values", () => {
  assert.equal(DEFAULT_BOARD_PREFS.filters.todayOnly, false);
  assert.equal(parseBoardPrefs(JSON.stringify({ filters: { todayOnly: "yes" } })).filters.todayOnly, false);
  assert.equal(parseBoardPrefs(JSON.stringify({ filters: { todayOnly: true } })).filters.todayOnly, true);
  assert.equal(parseBoardPrefs(JSON.stringify({ filters: null })).filters.todayOnly, false);
});

test("sweepTargets lists the filtered project scope, or null for all projects", () => {
  assert.equal(sweepTargets(PROJECTS, filters()), null);
  assert.equal(sweepTargets(PROJECTS, filters({ projectId: "gone" })), null);
  assert.deepEqual(sweepTargets(PROJECTS, filters({ projectId: "acme/globex" })), ["acme/globex", "acme/globex/initech", "acme/globex/hooli"]);
  assert.deepEqual(sweepTargets(PROJECTS, filters({ projectId: "acme/globex", includeSubprojects: false })), ["acme/globex"]);
});

test("reasonChange trims input, clears on empty and reports no change when equal", () => {
  assert.equal(reasonChange("  waiting on Ana ", null), "waiting on Ana");
  assert.equal(reasonChange("", "waiting"), null);
  assert.equal(reasonChange("   ", "waiting"), null);
  assert.equal(reasonChange("waiting", "waiting"), undefined);
  assert.equal(reasonChange(" waiting ", "waiting"), undefined);
  assert.equal(reasonChange("", null), undefined);
});

test("validateNewTask requires a project and a single-line title and reason", () => {
  assert.equal(validateNewTask({ projectId: "acme", title: "  ", status: "todo", reason: "" }), "Give the task a title");
  assert.equal(validateNewTask({ projectId: "acme", title: "a\nb", status: "todo", reason: "" }), "The title must be a single line");
  assert.equal(validateNewTask({ projectId: "", title: "a", status: "todo", reason: "" }), "Pick a project");
  assert.equal(validateNewTask({ projectId: "acme", title: "a", status: "blocked", reason: "x\ny" }), "The reason must be a single line");
  assert.equal(validateNewTask({ projectId: "acme", title: "a", status: "todo", reason: "x\ny" }), null);
  assert.equal(validateNewTask({ projectId: "acme", title: "a", status: "hold", reason: "" }), null);
});

test("newTaskBody trims, drops the reason for statuses without one and attaches the parent", () => {
  assert.deepEqual(newTaskBody({ projectId: "acme", title: " Ship it ", status: "todo", reason: "ignored", priority: null }, null), {
    projectId: "acme",
    title: "Ship it",
    status: "todo",
  });
  assert.deepEqual(newTaskBody({ projectId: "acme", title: "Wait", status: "blocked", reason: " vendor ", priority: null }, null), {
    projectId: "acme",
    title: "Wait",
    status: "blocked",
    reason: "vendor",
  });
  const parent = task("acme", 7, "parent");
  assert.deepEqual(newTaskBody({ projectId: "acme", title: "sub", status: "doing", reason: "", priority: null }, parent), {
    projectId: "acme",
    title: "sub",
    status: "doing",
    parentLine: 7,
    parentRaw: "- [ ] parent",
  });
});

test("validateTaskSettings mirrors the server rules for the reason separator, done section and stamp", () => {
  const ok = { reasonSeparator: " | ", doneSection: "Done loops", doneStamp: " done {{date}}", priorityTag: "p", priorityLevels: "4" };
  assert.deepEqual(validateTaskSettings(ok), { reasonSeparator: null, doneSection: null, doneStamp: null, priorityTag: null, priorityLevels: null });
  assert.match(validateTaskSettings({ ...ok, reasonSeparator: "   " }).reasonSeparator ?? "", /text/);
  assert.match(validateTaskSettings({ ...ok, reasonSeparator: "a\nb" }).reasonSeparator ?? "", /single line/);
  assert.equal(validateTaskSettings({ ...ok, doneSection: "" }).doneSection, null);
  assert.match(validateTaskSettings({ ...ok, doneSection: "a\nb" }).doneSection ?? "", /single line/);
  assert.match(validateTaskSettings({ ...ok, doneStamp: " done" }).doneStamp ?? "", /\{\{date\}\}/);
  assert.match(validateTaskSettings({ ...ok, doneStamp: "{{date}}\n" }).doneStamp ?? "", /single line/);
});

test("candidateLabels names candidate tasks with project and title, falling back to the id", () => {
  const nested = task("acme/globex", 4, "nested");
  const tasks = [task("acme", 1, "first"), task("acme/globex", 3, "parent", "todo", { subtasks: [nested] })];
  assert.deepEqual(candidateLabels(["acme#1", nested.id, "gone#9"], tasks, PROJECTS), ["ACME: first", "GLOBEX: nested", "gone#9"]);
});

test("taskPromptVars appends a subtask reason to its line", () => {
  const target = task("acme", 1, "Parent", "doing", { subtasks: [task("acme", 2, "patch", "blocked", { prefix: "BLOCK", reason: "waiting on Ana" })] });
  assert.equal(taskPromptVars(PROJECTS[0] as BoardProject, target).subtasks, "- [ ] BLOCK - patch - waiting on Ana");
});

test("taskPromptVars carries the reason and renders none when empty", () => {
  const withReason = taskPromptVars(PROJECTS[0] as BoardProject, task("acme", 1, "Wait", "blocked", { reason: "vendor reply" }));
  assert.equal(withReason.reason, "vendor reply");
  const without = taskPromptVars(PROJECTS[0] as BoardProject, task("acme", 2, "Go"));
  assert.equal(without.reason, "none");
  assert.equal(renderTaskDelegatePrompt("Why: {{reason}} / {{task}}", withReason), "Why: vendor reply / Wait");
});

test("priorityLevelList offers P0 to the last level and keeps an out-of-range current value", () => {
  assert.deepEqual(priorityLevelList(4), [0, 1, 2, 3]);
  assert.deepEqual(priorityLevelList(2, 5), [0, 1, 5]);
  assert.deepEqual(priorityLevelList(2, 1), [0, 1]);
  assert.deepEqual(priorityLevelList(undefined), [0, 1, 2, 3]);
  assert.deepEqual(priorityLevelList(0), [0, 1, 2, 3]);
  assert.deepEqual(priorityLevelList(99), [0, 1, 2, 3]);
  assert.equal(DEFAULT_PRIORITY_LEVELS, 4);
});

test("priorityLabel and priorityTone name the level and fade towards the last one", () => {
  assert.equal(priorityLabel(0), "P0");
  assert.equal(priorityLabel(3), "P3");
  assert.deepEqual([0, 1, 2, 3].map((level) => priorityTone(level, 4)), [0, 1, 2, 3]);
  assert.deepEqual([0, 1].map((level) => priorityTone(level, 2)), [0, 3]);
  assert.equal(priorityTone(0, 1), 0);
  assert.equal(priorityTone(5, 10), 2);
  assert.equal(priorityTone(9, 10), 3);
});

test("comparePriority orders by level and puts no priority last", () => {
  assert.ok(comparePriority(0, 1) < 0);
  assert.ok(comparePriority(2, 1) > 0);
  assert.equal(comparePriority(1, 1), 0);
  assert.ok(comparePriority(3, null) < 0);
  assert.ok(comparePriority(null, 0) > 0);
  assert.equal(comparePriority(null, null), 0);
});

test("sortByPriority is stable inside a level and leaves the input untouched", () => {
  const tasks = [
    task("acme", 1, "none a"),
    task("acme", 2, "p2", "todo", { priority: 2 }),
    task("acme", 3, "p0 a", "todo", { priority: 0 }),
    task("acme", 4, "none b"),
    task("acme", 5, "p0 b", "todo", { priority: 0 }),
  ];
  assert.deepEqual(sortByPriority(tasks).map((item) => item.title), ["p0 a", "p0 b", "p2", "none a", "none b"]);
  assert.deepEqual(tasks.map((item) => item.title), ["none a", "p2", "p0 a", "none b", "p0 b"]);
});

test("sortTableTasks defaults to priority and sorts by status, project or title in both directions", () => {
  const tasks = [
    task("personal", 1, "bravo", "doing"),
    task("acme", 2, "Alpha", "todo", { priority: 1 }),
    task("acme/globex", 3, "charlie", "blocked", { priority: 0 }),
    task("acme", 4, "delta", "todo"),
  ];
  const labels = new Map([
    ["acme", "Acme"],
    ["acme/globex", "Acme › Globex"],
    ["personal", "Personal"],
  ]);
  const titles = (key: "priority" | "status" | "project" | "title", dir: "asc" | "desc") => sortTableTasks(tasks, { key, dir }, labels).map((item) => item.title);
  assert.deepEqual(titles("priority", "asc"), ["charlie", "Alpha", "bravo", "delta"]);
  assert.deepEqual(titles("priority", "desc"), ["Alpha", "charlie", "bravo", "delta"]);
  assert.deepEqual(titles("status", "asc"), ["charlie", "Alpha", "delta", "bravo"]);
  assert.deepEqual(titles("status", "desc"), ["bravo", "Alpha", "delta", "charlie"]);
  assert.deepEqual(titles("project", "asc"), ["Alpha", "delta", "charlie", "bravo"]);
  assert.deepEqual(titles("title", "asc"), ["Alpha", "bravo", "charlie", "delta"]);
  assert.deepEqual(titles("title", "desc"), ["delta", "charlie", "bravo", "Alpha"]);
});

test("nextTableSort flips the direction of the active column and starts a new one ascending", () => {
  assert.deepEqual(nextTableSort({ key: "priority", dir: "asc" }, "priority"), { key: "priority", dir: "desc" });
  assert.deepEqual(nextTableSort({ key: "priority", dir: "desc" }, "priority"), { key: "priority", dir: "asc" });
  assert.deepEqual(nextTableSort({ key: "priority", dir: "desc" }, "title"), { key: "title", dir: "asc" });
});

test("filterBoardTasks hides the priority levels switched off, including no priority", () => {
  const tasks = [task("acme", 1, "p0", "todo", { priority: 0 }), task("acme", 2, "p1", "todo", { priority: 1 }), task("acme", 3, "none")];
  const titles = (hidden: (number | null)[]) => filterBoardTasks(tasks, PROJECTS, filters({ hiddenPriorities: hidden })).map((item) => item.title);
  assert.deepEqual(titles([]), ["p0", "p1", "none"]);
  assert.deepEqual(titles([1]), ["p0", "none"]);
  assert.deepEqual(titles([null]), ["p0", "p1"]);
  assert.deepEqual(titles([0, 1, null]), []);
});

test("toggleHiddenPriority adds and removes a level without mutating", () => {
  const start: (number | null)[] = [1];
  assert.deepEqual(toggleHiddenPriority(start, 0), [1, 0]);
  assert.deepEqual(toggleHiddenPriority(start, 1), []);
  assert.deepEqual(toggleHiddenPriority(start, null), [1, null]);
  assert.deepEqual(toggleHiddenPriority([null], null), []);
  assert.deepEqual(start, [1]);
});

test("pickableTasks ignores the priority filter", () => {
  assert.deepEqual(pickableTasks([task("acme", 1, "x", "todo", { priority: 2 })], PROJECTS, null).map((item) => item.title), ["x"]);
});

test("parseBoardPrefs defaults the priority filter and table sort and rejects malformed values", () => {
  assert.deepEqual(DEFAULT_BOARD_PREFS.filters.hiddenPriorities, []);
  assert.deepEqual(DEFAULT_BOARD_PREFS.tableSort, { key: "priority", dir: "asc" });
  const legacy = parseBoardPrefs(JSON.stringify({ view: "table", filters: { todayOnly: true } }));
  assert.deepEqual(legacy.filters.hiddenPriorities, []);
  assert.deepEqual(legacy.tableSort, { key: "priority", dir: "asc" });
  assert.deepEqual(parseBoardPrefs(JSON.stringify({ filters: { hiddenPriorities: [2, null, 2, "x", 1.5, -1, 12, 0] } })).filters.hiddenPriorities, [2, null, 0]);
  assert.deepEqual(parseBoardPrefs(JSON.stringify({ filters: { hiddenPriorities: "p0" } })).filters.hiddenPriorities, []);
  assert.deepEqual(parseBoardPrefs(JSON.stringify({ tableSort: { key: "title", dir: "desc" } })).tableSort, { key: "title", dir: "desc" });
  assert.deepEqual(parseBoardPrefs(JSON.stringify({ tableSort: { key: "nope", dir: "up" } })).tableSort, { key: "priority", dir: "asc" });
  assert.deepEqual(parseBoardPrefs(JSON.stringify({ tableSort: 3 })).tableSort, { key: "priority", dir: "asc" });
});

test("taskPromptVars renders the priority as P<n> or none", () => {
  const first = PROJECTS[0] as BoardProject;
  assert.equal(taskPromptVars(first, task("acme", 1, "x", "todo", { priority: 1 })).priority, "P1");
  assert.equal(taskPromptVars(first, task("acme", 2, "y")).priority, "none");
  assert.equal(renderTaskDelegatePrompt("{{priority}}/{{priority}}", taskPromptVars(first, task("acme", 1, "x", "todo", { priority: 0 }))), "P0/P0");
});

test("newTaskBody carries a chosen priority and omits none", () => {
  assert.deepEqual(newTaskBody({ projectId: "acme", title: "x", status: "todo", reason: "", priority: 0 }, null), {
    projectId: "acme",
    title: "x",
    status: "todo",
    priority: 0,
  });
});

test("validateTaskSettings mirrors the server rules for the priority tag and levels", () => {
  const ok = { reasonSeparator: " - ", doneSection: "", doneStamp: " {{date}}", priorityTag: "p", priorityLevels: "4" };
  const issues = (patch: Partial<typeof ok>) => validateTaskSettings({ ...ok, ...patch });
  assert.equal(issues({ priorityTag: " prio-1_a " }).priorityTag, null);
  assert.match(issues({ priorityTag: "" }).priorityTag ?? "", /letters, digits/);
  assert.match(issues({ priorityTag: "  " }).priorityTag ?? "", /letters, digits/);
  assert.match(issues({ priorityTag: "p!" }).priorityTag ?? "", /letters, digits/);
  assert.match(issues({ priorityTag: "a b" }).priorityTag ?? "", /letters, digits/);
  assert.equal(issues({ priorityLevels: "1" }).priorityLevels, null);
  assert.equal(issues({ priorityLevels: " 10 " }).priorityLevels, null);
  for (const bad of ["", "0", "11", "2.5", "abc", "-1"]) assert.match(issues({ priorityLevels: bad }).priorityLevels ?? "", /1 to 10/);
});

test("validateNoteText mirrors the server note rules", () => {
  assert.equal(validateNoteText("call the vendor"), null);
  assert.equal(validateNoteText("see [1] below"), null);
  assert.match(validateNoteText("   ") ?? "", /Write/);
  assert.match(validateNoteText("a\nb") ?? "", /single line/);
  assert.match(validateNoteText("[ ] sneaky task") ?? "", /task or a code fence/);
  assert.match(validateNoteText("- [x] sneaky task") ?? "", /task or a code fence/);
  assert.match(validateNoteText("```ts") ?? "", /task or a code fence/);
  assert.match(validateNoteText("~~~") ?? "", /task or a code fence/);
});

test("priorityFilterLevels lists the configured levels plus any higher level a task already carries", () => {
  const tasks = [task("acme", 1, "a", "todo", { priority: 6 }), task("acme", 2, "b", "todo", { priority: 5 }), task("acme", 3, "c", "todo", { priority: 6 }), task("acme", 4, "d", "todo", { priority: 1 })];
  assert.deepEqual(priorityFilterLevels(3, tasks), [0, 1, 2, 5, 6]);
  assert.deepEqual(priorityFilterLevels(undefined, []), [0, 1, 2, 3]);
});

test("remapExpanded follows tasks whose line shifted and keeps edited ones in place", () => {
  const before = [task("acme", 1, "first"), task("acme", 5, "second"), task("acme", 9, "same"), task("acme", 12, "same"), task("personal", 5, "other")];
  const after = [task("acme", 1, "first"), task("acme", 6, "second"), task("acme", 10, "same"), task("acme", 13, "same"), task("personal", 5, "other")];
  const remapped = remapExpanded(before, after, new Set(["acme#5", "acme#12", "personal#5"]));
  assert.deepEqual([...remapped].sort(), ["acme#13", "acme#6", "personal#5"]);
});

test("remapExpanded keeps a renamed task open, drops a deleted one and keeps ids it has never seen", () => {
  const before = [task("acme", 1, "old title"), task("acme", 5, "gone")];
  const after = [task("acme", 1, "new title"), task("acme", 8, "fresh")];
  assert.deepEqual([...remapExpanded(before, after, new Set(["acme#1", "acme#5", "acme#8"]))].sort(), ["acme#1", "acme#8"]);
  const empty = new Set<string>();
  assert.equal(remapExpanded(before, after, empty), empty);
});

test("remapExpanded follows subtasks through their parent", () => {
  const before = [task("acme", 1, "parent", "todo", { subtasks: [task("acme", 2, "child")] })];
  const after = [task("acme", 3, "intro"), task("acme", 4, "parent", "todo", { subtasks: [task("acme", 5, "child")] })];
  assert.deepEqual([...remapExpanded(before, after, new Set(["acme#1", "acme#2"]))].sort(), ["acme#4", "acme#5"]);
});

const prefs = (patch: Partial<BoardPrefs> = {}, filterPatch: Partial<BoardFilters> = {}): BoardPrefs => ({
  ...DEFAULT_BOARD_PREFS,
  ...patch,
  filters: { ...DEFAULT_BOARD_PREFS.filters, ...filterPatch },
});

test("todayAvailability tells off, missing and ready apart", () => {
  assert.equal(todayAvailability(null), "off");
  assert.equal(todayAvailability({ date: "2026-10-23", exists: false, taskIds: [], states: {} }), "missing");
  assert.equal(todayAvailability({ date: "2026-10-23", exists: true, taskIds: [], states: {} }), "ready");
});

test("multiSelectSummary reads All, None, names or a count", () => {
  assert.equal(multiSelectSummary("Status", ["a", "b", "c"], 3), "Status: All");
  assert.equal(multiSelectSummary("Status", [], 3), "Status: None");
  assert.equal(multiSelectSummary("Status", ["Hold", "To-Do"], 6), "Status: Hold, To-Do");
  assert.equal(multiSelectSummary("Status", ["a", "b", "c", "d"], 6), "Status: 4 of 6");
  assert.equal(multiSelectSummary("Status", ["Hold"], 6), "Status: Hold");
});

test("statusFilterSummary names the default as all but archived", () => {
  assert.equal(statusFilterSummary(filters()), "Status: All but Archived");
  assert.equal(statusFilterSummary(filters({ statuses: [...BOARD_STATUSES] })), "Status: All");
  assert.equal(statusFilterSummary(filters({ statuses: ["todo", "hold"] })), "Status: Hold, To-Do");
  assert.equal(statusFilterSummary(filters({ statuses: ["todo", "hold", "doing", "done"] })), "Status: 4 of 6");
  assert.equal(statusFilterSummary(filters({ statuses: [] })), "Status: All but Archived");
});

test("hasDefaultStatuses is true only for every status but archived", () => {
  assert.equal(hasDefaultStatuses(filters()), true);
  assert.equal(hasDefaultStatuses(filters({ statuses: [] })), true);
  assert.equal(hasDefaultStatuses(filters({ statuses: [...BOARD_STATUSES] })), false);
  assert.equal(hasDefaultStatuses(filters({ statuses: ["todo"] })), false);
});

test("priorityFilterSummary counts the levels that are not hidden", () => {
  const levels = [0, 1, 2, 3, null];
  assert.equal(priorityFilterSummary(filters(), levels), "Priority: All");
  assert.equal(priorityFilterSummary(filters({ hiddenPriorities: [null] }), levels), "Priority: 4 of 5");
  assert.equal(priorityFilterSummary(filters({ hiddenPriorities: [1, 2, 3, null] }), levels), "Priority: P0");
  assert.equal(priorityFilterSummary(filters({ hiddenPriorities: [2, 3, null] }), levels), "Priority: P0, P1");
  assert.equal(priorityFilterSummary(filters({ hiddenPriorities: levels }), levels), "Priority: None");
});

test("viewSummary counts the enabled view options", () => {
  assert.equal(viewSummary(prefs({ hideEmptyColumns: false }), "ready"), "View");
  assert.equal(viewSummary(prefs(), "ready"), "View: 1 on");
  assert.equal(viewSummary(prefs({}, { todayOnly: true }), "ready"), "View: 2 on");
  assert.equal(viewSummary(prefs({}, { todayOnly: true }), "off"), "View: 1 on");
});

test("hasCustomFilters is false for the defaults and true for any single deviation", () => {
  assert.equal(hasCustomFilters(prefs(), "ready"), false);
  assert.equal(hasCustomFilters(prefs({}, { projectId: "acme" }), "ready"), true);
  assert.equal(hasCustomFilters(prefs({}, { statuses: ["todo"] }), "ready"), true);
  assert.equal(hasCustomFilters(prefs({}, { statuses: [...BOARD_STATUSES] }), "ready"), true);
  assert.equal(hasCustomFilters(prefs({}, { hiddenPriorities: [null] }), "ready"), true);
  assert.equal(hasCustomFilters(prefs({}, { todayOnly: true }), "ready"), true);
  assert.equal(hasCustomFilters(prefs({}, { search: "  x " }), "ready"), true);
  assert.equal(hasCustomFilters(prefs({ hideEmptyColumns: false }), "ready"), true);
});

test("hasCustomFilters ignores options that have no effect", () => {
  assert.equal(hasCustomFilters(prefs({}, { search: "   " }), "ready"), false);
  assert.equal(hasCustomFilters(prefs({}, { includeSubprojects: false }), "ready"), false);
  assert.equal(hasCustomFilters(prefs({}, { includeSubprojects: false, projectId: "acme" }), "ready"), true);
  assert.equal(hasCustomFilters(prefs({}, { todayOnly: true }), "off"), false);
  assert.equal(hasCustomFilters(prefs({}, { statuses: ["done", "doing", "todo", "hold", "blocked"] }), "ready"), false);
});

test("resetFilterPrefs restores filters and view options but keeps the layout and sort", () => {
  const dirty = prefs(
    { view: "table", hideEmptyColumns: false, tableSort: { key: "title", dir: "desc" } },
    { projectId: "acme", includeSubprojects: false, statuses: ["todo"], search: "x", todayOnly: true, hiddenPriorities: [0, null] },
  );
  const reset = resetFilterPrefs(dirty);
  assert.equal(reset.view, "table");
  assert.deepEqual(reset.tableSort, { key: "title", dir: "desc" });
  assert.equal(reset.hideEmptyColumns, true);
  assert.deepEqual(reset.filters, DEFAULT_BOARD_PREFS.filters);
  assert.notEqual(reset.filters.statuses, DEFAULT_BOARD_PREFS.filters.statuses);
  assert.equal(hasCustomFilters(reset, "ready"), false);
});

test("activeFilterNotes lists only the filters that hide tasks", () => {
  assert.deepEqual(activeFilterNotes(filters(), { projectTitle: null, availability: "ready" }), []);
  assert.deepEqual(
    activeFilterNotes(filters({ projectId: "hooli/nucleus", todayOnly: true }), { projectTitle: "Nucleus", availability: "missing" }),
    ["project Nucleus", "In today's daily (today's daily does not exist yet)"],
  );
  assert.deepEqual(activeFilterNotes(filters({ todayOnly: true }), { projectTitle: null, availability: "ready" }), ["In today's daily"]);
  assert.deepEqual(activeFilterNotes(filters({ todayOnly: true }), { projectTitle: null, availability: "off" }), []);
  assert.deepEqual(activeFilterNotes(filters({ statuses: ["todo", "hold"] }), { projectTitle: null, availability: "ready" }), ["status Hold, To-Do"]);
  assert.deepEqual(activeFilterNotes(filters({ hiddenPriorities: [2, null] }), { projectTitle: null, availability: "ready" }), ["priority hidden: P2, No priority"]);
  assert.deepEqual(activeFilterNotes(filters({ search: " roadmap " }), { projectTitle: null, availability: "ready" }), ['search "roadmap"']);
});

test("emptyResultsMessage names the filters or falls back to a plain message", () => {
  assert.equal(emptyResultsMessage(["project Nucleus", "In today's daily"]), "No tasks match: project Nucleus, In today's daily");
  assert.equal(emptyResultsMessage([]), "There are no tasks to show.");
});

test("todayMissingHint only appears when the daily filter is on and the daily does not exist", () => {
  assert.equal(todayMissingHint(filters({ todayOnly: true }), "missing"), "Today's daily does not exist yet, so nothing is linked to it");
  assert.equal(todayMissingHint(filters({ todayOnly: true }), "ready"), null);
  assert.equal(todayMissingHint(filters({ todayOnly: false }), "missing"), null);
  assert.equal(todayMissingHint(filters({ todayOnly: true }), "off"), null);
});

test("parseBoardPrefs keeps a prefs blob that hides every column readable and resettable", () => {
  const raw =
    '{"view":"kanban","hideEmptyColumns":true,"filters":{"projectId":"hooli/nucleus","includeSubprojects":true,"statuses":["hold","todo","doing","done"],"search":"","todayOnly":true,"hiddenPriorities":[]}}';
  const parsed = parseBoardPrefs(raw);
  assert.equal(parsed.filters.todayOnly, true);
  assert.equal(parsed.filters.projectId, "hooli/nucleus");
  assert.equal(hasCustomFilters(parsed, "missing"), true);
  assert.equal(hasCustomFilters(resetFilterPrefs(parsed), "missing"), false);
});

function organized(): BoardTask[] {
  const sub = (line: number, title: string, extra: Partial<BoardTask> = {}): BoardTask => task("acme", line, title, "todo", { depth: 1, ...extra });
  const alpha = task("acme", 2, "Alpha", "todo", {
    group: "Now",
    noteItems: [
      { line: 3, raw: "  - first note", text: "first note" },
      { line: 7, raw: "  - last note", text: "last note" },
    ],
    subtasks: [sub(4, "Alpha one", { subtasks: [sub(5, "Alpha one deep")] }), sub(6, "Alpha two")],
  });
  const beta = task("acme", 10, "Beta", "doing", { group: "Now" });
  const gamma = task("acme", 12, "Gamma", "todo", { group: "Later" });
  const delta = task("acme", 14, "Delta", "todo", { group: "Now" });
  const swept = task("acme", 30, "Swept", "done", { section: "done", doneAt: "2026-10-01" });
  const other = task("personal", 2, "Own");
  return [alpha, beta, gamma, delta, swept, other];
}

test("orderedChildren interleaves notes and subtasks in file order", () => {
  const [alpha] = organized() as [BoardTask];
  assert.deepEqual(
    orderedChildren(alpha).map((item) => `${item.kind}:${item.line}`),
    ["note:3", "task:4", "task:6", "note:7"],
  );
  assert.deepEqual(orderedChildren(task("acme", 1, "bare")), []);
});

test("findParentTask returns the owning task of a nested subtask and null for top-level", () => {
  const tasks = organized();
  assert.equal(findParentTask(tasks, "acme#5")?.title, "Alpha one");
  assert.equal(findParentTask(tasks, "acme#4")?.title, "Alpha");
  assert.equal(findParentTask(tasks, "acme#2"), null);
  assert.equal(findParentTask(tasks, "nope#1"), null);
});

test("isSubtask is true only for nested tasks", () => {
  const tasks = organized();
  assert.equal(isSubtask(tasks, findBoardTask(tasks, "acme#4") as BoardTask), true);
  assert.equal(isSubtask(tasks, findBoardTask(tasks, "acme#2") as BoardTask), false);
});

test("taskMoveAvailability for top-level tasks only looks at the same project, section and group", () => {
  const tasks = organized();
  const at = (id: string) => findBoardTask(tasks, id) as BoardTask;
  assert.deepEqual(taskMoveAvailability(tasks, at("acme#2")), { up: false, down: true });
  assert.deepEqual(taskMoveAvailability(tasks, at("acme#10")), { up: true, down: true });
  assert.deepEqual(taskMoveAvailability(tasks, at("acme#14")), { up: true, down: false });
  assert.deepEqual(taskMoveAvailability(tasks, at("acme#12")), { up: false, down: false });
  assert.deepEqual(taskMoveAvailability(tasks, at("acme#30")), { up: false, down: false });
  assert.deepEqual(taskMoveAvailability(tasks, at("personal#2")), { up: false, down: false });
});

test("taskMoveAvailability for subtasks counts notes among the siblings", () => {
  const tasks = organized();
  const at = (id: string) => findBoardTask(tasks, id) as BoardTask;
  assert.deepEqual(taskMoveAvailability(tasks, at("acme#4")), { up: true, down: true });
  assert.deepEqual(taskMoveAvailability(tasks, at("acme#6")), { up: true, down: true });
  assert.deepEqual(taskMoveAvailability(tasks, at("acme#5")), { up: false, down: false });
});

test("taskMoveAvailability is closed for a task that is not in the tree", () => {
  assert.deepEqual(taskMoveAvailability(organized(), task("acme", 99, "ghost")), { up: false, down: false });
});

test("noteMoveAvailability follows the position among notes and subtasks", () => {
  const [alpha] = organized() as [BoardTask];
  const [first, last] = alpha.noteItems as [BoardNoteItem, BoardNoteItem];
  assert.deepEqual(noteMoveAvailability(alpha, first), { up: false, down: true });
  assert.deepEqual(noteMoveAvailability(alpha, last), { up: true, down: false });
  assert.deepEqual(noteMoveAvailability(alpha, { line: 99, raw: "x", text: "x" }), { up: false, down: false });
});

test("parentCandidates lists the project tree indented and leaves out the task and its descendants", () => {
  const tasks = organized();
  const all = parentCandidates(tasks, "acme");
  assert.deepEqual(
    all.map((item) => `${item.level}:${item.task.title}`),
    ["0:Alpha", "1:Alpha one", "2:Alpha one deep", "1:Alpha two", "0:Beta", "0:Gamma", "0:Delta", "0:Swept"],
  );
  const alphaOne = findBoardTask(tasks, "acme#4") as BoardTask;
  assert.deepEqual(
    parentCandidates(tasks, "acme", alphaOne).map((item) => item.task.title),
    ["Alpha", "Alpha two", "Beta", "Gamma", "Delta", "Swept"],
  );
  const alpha = findBoardTask(tasks, "acme#2") as BoardTask;
  assert.deepEqual(
    parentCandidates(tasks, "acme", alpha).map((item) => item.task.title),
    ["Beta", "Gamma", "Delta", "Swept"],
  );
});

test("parentCandidates for another project ignores other projects", () => {
  const tasks = organized();
  assert.deepEqual(parentCandidates(tasks, "personal").map((item) => item.task.title), ["Own"]);
  assert.deepEqual(parentCandidates(tasks, "acme/globex"), []);
});

test("findTaskAfterRefetch prefers the same id when the title still matches", () => {
  const tasks = organized();
  const found = findTaskAfterRefetch(tasks, { id: "acme#10", projectId: "acme", title: "Beta", line: 10 });
  assert.equal(found?.id, "acme#10");
});

test("findTaskAfterRefetch falls back to project and title, nearest line first", () => {
  const tasks = [task("acme", 3, "Twin"), task("acme", 20, "Twin"), task("acme", 8, "Other")];
  assert.equal(findTaskAfterRefetch(tasks, { id: "acme#9", projectId: "acme", title: "Twin", line: 18 })?.id, "acme#20");
  assert.equal(findTaskAfterRefetch(tasks, { id: "acme#8", projectId: "acme", title: "Twin", line: 2 })?.id, "acme#3");
});

test("findTaskAfterRefetch follows a task into another project and into a subtask position", () => {
  const tasks = [task("personal", 5, "Roaming", "todo", { subtasks: [task("personal", 6, "Deep nest", "todo", { depth: 1 })] })];
  assert.equal(findTaskAfterRefetch(tasks, { id: "acme#4", projectId: "personal", title: "Roaming", line: 4 })?.id, "personal#5");
  assert.equal(findTaskAfterRefetch(tasks, { id: "acme#4", projectId: "personal", title: "Deep nest", line: 4 })?.id, "personal#6");
});

test("findTaskAfterRefetch returns null when the task is gone", () => {
  assert.equal(findTaskAfterRefetch(organized(), { id: "acme#10", projectId: "acme", title: "Renamed away", line: 10 }), null);
  assert.equal(findTaskAfterRefetch(organized(), { id: "acme#10", projectId: "ghost", title: "Beta", line: 10 }), null);
});

test("findTaskAfterRefetch does not trust an id that now points to another task", () => {
  const tasks = [task("acme", 10, "Different"), task("acme", 14, "Beta")];
  assert.equal(findTaskAfterRefetch(tasks, { id: "acme#10", projectId: "acme", title: "Beta", line: 10 })?.id, "acme#14");
});

test("remapTaskId follows a task whose line shifted and drops one that vanished", () => {
  const before = [task("acme", 2, "A"), task("acme", 4, "B")];
  const after = [task("acme", 2, "New one"), task("acme", 3, "A"), task("acme", 5, "B")];
  assert.equal(remapTaskId(before, after, "acme#4"), "acme#5");
  assert.equal(remapTaskId(before, after, "acme#2"), "acme#3");
  assert.equal(remapTaskId(before, [task("acme", 2, "Z")], "acme#4"), null);
});

test("moveTargetProjects excludes the current project and keeps the indented labels", () => {
  const options = moveTargetProjects(PROJECTS, "acme/globex");
  assert.deepEqual(options.map((option) => option.id), ["acme", "acme/globex/initech", "acme/globex/hooli", "personal"]);
  assert.equal(options[1]?.label.endsWith("INITECH"), true);
  assert.equal((options[1]?.label.length ?? 0) > "INITECH".length, true);
  assert.equal(options[0]?.label, "ACME");
});

test("obsidianUrl encodes the absolute path of the project note", () => {
  assert.equal(obsidianUrl("C:\\vault\\acme\\My Notes.md"), "obsidian://open?path=C%3A%5Cvault%5Cacme%5CMy%20Notes.md");
  assert.equal(obsidianUrl("/home/vault/a&b.md"), "obsidian://open?path=%2Fhome%2Fvault%2Fa%26b.md");
});

test("organizeFocus follows the moved task only when the drawer task itself was organized", () => {
  const drawer = task("acme", 2, "Drawer");
  const moved = task("acme", 9, "Drawer");
  const child = task("acme", 3, "Child", "todo", { depth: 1 });
  assert.equal(organizeFocus(drawer, drawer, moved), moved);
  assert.equal(organizeFocus(drawer, child, task("acme", 9, "Child")), drawer);
});

test("parentCandidateLabel indents by level with non-breaking spaces and tags done-section tasks", () => {
  const nbsp = String.fromCharCode(160);
  assert.equal(parentCandidateLabel({ task: task("acme", 1, "Top"), level: 0 }), "Top");
  assert.equal(parentCandidateLabel({ task: task("acme", 2, "Nested"), level: 2 }), `${nbsp.repeat(4)}Nested`);
  assert.equal(parentCandidateLabel({ task: task("acme", 3, "Old", "done", { section: "done" }), level: 1 }), `${nbsp.repeat(2)}Old (done section)`);
});
