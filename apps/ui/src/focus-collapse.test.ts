import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collapseAllFocus,
  EXPANDED,
  expandAllFocus,
  focusGroupCounts,
  FOCUS_COLLAPSE_LIMIT,
  headerKeyAction,
  hiddenSummary,
  isAllCollapsed,
  isAllExpanded,
  isProjectCollapsed,
  isTaskCollapsed,
  parseFocusCollapse,
  rowCollapseKey,
  serializeFocusCollapse,
  setTaskCollapsed,
  taskCollapseKey,
  toggleProject,
  toggleTask,
  visibleFocusGroups,
} from "./focus-collapse";
import { flattenVisible, nextNode, type OutlineGroup, type OutlineNode } from "./outliner-model";

const node = (id: string, projectId: string, patch: Partial<OutlineNode> = {}, children: OutlineNode[] = [], depth = 0): OutlineNode => ({
  id,
  projectId,
  line: 0,
  raw: `- [ ] ${id}`,
  title: id,
  status: "todo",
  priority: null,
  due: null,
  notes: [],
  children,
  depth,
  ...patch,
});

const groups = (): OutlineGroup[] => [
  {
    project: { id: "alpha", title: "Alpha" },
    items: [
      node("a1", "alpha", {}, [node("a1-1", "alpha", { status: "done" }, [node("a1-1-1", "alpha", {}, [], 2)], 1), node("a1-2", "alpha", {}, [], 1)]),
      node("a2", "alpha", { status: "done", notes: [{ line: 9, raw: "  - note", text: "note" }] }),
      node("a3", "alpha"),
    ],
  },
  { project: { id: "bravo", title: "Bravo" }, items: [node("b1", "bravo")] },
];

describe("focus collapse state", () => {
  it("starts expanded and survives garbage, wrong shapes and non-string items", () => {
    assert.deepEqual(parseFocusCollapse(""), EXPANDED);
    assert.deepEqual(parseFocusCollapse("{nope"), EXPANDED);
    assert.deepEqual(parseFocusCollapse("[1,2]"), EXPANDED);
    assert.deepEqual(parseFocusCollapse('{"projects":["alpha",3,"alpha"],"tasks":"x"}'), { projects: ["alpha"], tasks: [] });
  });

  it("round-trips through storage and caps the remembered keys", () => {
    const state = { projects: ["alpha"], tasks: ["alpha\u0000a1"] };
    assert.deepEqual(parseFocusCollapse(serializeFocusCollapse(state)), state);
    const many = { projects: [], tasks: Array.from({ length: FOCUS_COLLAPSE_LIMIT + 20 }, (_, index) => `t${index}`) };
    const stored = parseFocusCollapse(serializeFocusCollapse(many));
    assert.equal(stored.tasks.length, FOCUS_COLLAPSE_LIMIT);
    assert.equal(stored.tasks[stored.tasks.length - 1], `t${FOCUS_COLLAPSE_LIMIT + 19}`);
  });

  it("keys a task by project and title so a refetch that renumbers ids keeps it collapsed", () => {
    const a1 = groups()[0]?.items[0] as OutlineNode;
    const collapsed = toggleTask(EXPANDED, a1);
    assert.deepEqual(collapsed.tasks, [taskCollapseKey(a1)]);
    assert.equal(isTaskCollapsed(collapsed, { ...a1, id: "alpha#99" }), true);
    assert.deepEqual(toggleTask(collapsed, a1), EXPANDED);
  });

  it("never treats a task without subtasks or notes as collapsed", () => {
    const a3 = groups()[0]?.items[2] as OutlineNode;
    assert.equal(isTaskCollapsed(setTaskCollapsed(EXPANDED, a3, true), a3), false);
  });

  it("toggles a project group without touching the others", () => {
    const state = toggleProject(EXPANDED, "alpha");
    assert.equal(isProjectCollapsed(state, "alpha"), true);
    assert.equal(isProjectCollapsed(state, "bravo"), false);
    assert.deepEqual(toggleProject(state, "alpha"), EXPANDED);
  });
});

describe("visible focus groups", () => {
  it("hides the rows of a collapsed project but keeps the group", () => {
    const shown = visibleFocusGroups(groups(), toggleProject(EXPANDED, "alpha"));
    assert.deepEqual(shown.map((group) => [group.project.id, group.items.length]), [["alpha", 0], ["bravo", 1]]);
  });

  it("hides the subtasks and notes of a collapsed task at any depth, and keyboard navigation skips them", () => {
    const all = groups();
    const a1 = all[0]?.items[0] as OutlineNode;
    const a11 = a1.children[0] as OutlineNode;
    const a2 = all[0]?.items[1] as OutlineNode;
    const nested = visibleFocusGroups(all, setTaskCollapsed(EXPANDED, a11, true));
    assert.deepEqual(flattenVisible(nested).map((item) => item.id), ["a1", "a1-1", "a1-2", "a2", "a3", "b1"]);
    const state = setTaskCollapsed(setTaskCollapsed(EXPANDED, a1, true), a2, true);
    const shown = visibleFocusGroups(all, state);
    assert.deepEqual(flattenVisible(shown).map((item) => item.id), ["a1", "a2", "a3", "b1"]);
    assert.deepEqual(shown[0]?.items[1]?.notes, []);
    assert.equal(nextNode(shown, "a1")?.id, "a2");
    assert.equal(all[0]?.items[0]?.children.length, 2);
  });

  it("collapses everything and expands everything again", () => {
    const all = groups();
    const collapsed = collapseAllFocus(EXPANDED, all);
    assert.equal(isAllCollapsed(collapsed, all), true);
    assert.equal(isAllExpanded(collapsed, all), false);
    assert.deepEqual(collapsed.projects, ["alpha", "bravo"]);
    assert.deepEqual(collapsed.tasks, ["alpha\u0000a1", "alpha\u0000a1-1", "alpha\u0000a2"]);
    const expanded = expandAllFocus({ ...collapsed, tasks: [...collapsed.tasks, "other\u0000keep"] }, all);
    assert.equal(isAllExpanded(expanded, all), true);
    assert.deepEqual(expanded, { projects: [], tasks: ["other\u0000keep"] });
  });
});

describe("focus group labels and keys", () => {
  it("counts every task of the group, subtasks included, and the done ones", () => {
    assert.deepEqual(focusGroupCounts(groups()[0] as OutlineGroup), { tasks: 6, done: 2 });
  });

  it("summarises what a collapsed task hides", () => {
    const [a1, a2, a3] = groups()[0]?.items as OutlineNode[];
    assert.equal(hiddenSummary(a1 as OutlineNode), "3 subtasks");
    assert.equal(hiddenSummary(a2 as OutlineNode), "1 note");
    assert.equal(hiddenSummary(a3 as OutlineNode), "");
    assert.equal(hiddenSummary(node("x", "p", { notes: [{ line: 1, raw: "", text: "a" }, { line: 2, raw: "", text: "b" }] }, [node("y", "p", {}, [], 1)])), "1 subtask, 2 notes");
  });

  it("maps the project header keys and the row arrow keys", () => {
    assert.equal(headerKeyAction("Enter"), "toggle");
    assert.equal(headerKeyAction(" "), "toggle");
    assert.equal(headerKeyAction("ArrowLeft"), "collapse");
    assert.equal(headerKeyAction("ArrowRight"), "expand");
    assert.equal(headerKeyAction("ArrowDown"), "first");
    assert.equal(headerKeyAction("a"), null);
    assert.equal(rowCollapseKey("ArrowRight", true, true), "expand");
    assert.equal(rowCollapseKey("ArrowRight", false, true), null);
    assert.equal(rowCollapseKey("ArrowLeft", false, true), "collapse");
    assert.equal(rowCollapseKey("ArrowLeft", false, false), null);
  });
});
