import assert from "node:assert/strict";
import { test } from "node:test";
import { addToTasksDefaults, dailyLinkState, syncStatusFor, appendNewItem, carryOverFromYesterday, formatNewItemLine, defaultYesterdayCarry, defaultYesterdayDone, focusPreviewLines, doingFocusItem, hasFocusItem, isDoingBlock, keepPickedDoingItems, mergeTrailIntoSummary, parseMeetings, parseNewItems, shouldPersistWizardDraft } from "./daily-plan";
import type { BoardProject, DailyLinkItem, DailyYesterdayTask } from "./delegation";

test("parseNewItems splits project from text on the first ' - '", () => {
  const items = parseNewItems("Acme - Fix GeoServer prod\nGlobex - Ship export");
  assert.deepEqual(items, [
    { project: "Acme", text: "Fix GeoServer prod" },
    { project: "Globex", text: "Ship export" },
  ]);
});

test("parseNewItems keeps project null when there is no separator", () => {
  const items = parseNewItems("Review PR backlog");
  assert.deepEqual(items, [{ project: null, text: "Review PR backlog" }]);
});

test("parseNewItems drops blank and whitespace-only lines", () => {
  const items = parseNewItems("  \nAcme - Fix\n\n   \n");
  assert.deepEqual(items, [{ project: "Acme", text: "Fix" }]);
});

test("parseNewItems trims extra spaces around project and text", () => {
  const items = parseNewItems("  Acme   -   Fix GeoServer  ");
  assert.deepEqual(items, [{ project: "Acme", text: "Fix GeoServer" }]);
});

test("parseMeetings trims and drops blank lines", () => {
  const meetings = parseMeetings("  09:30 Today (Alex)  \n\n10:00 Dra. Morgan\n   ");
  assert.deepEqual(meetings, ["09:30 Today (Alex)", "10:00 Dra. Morgan"]);
});

test("parseMeetings returns an empty list for blank input", () => {
  assert.deepEqual(parseMeetings("   \n  \n"), []);
});

test("focusPreviewLines links the project only when wikilinks is enabled", () => {
  const items = [
    { project: "Acme", text: "Fix GeoServer" },
    { project: null, text: "Standalone item" },
  ];
  assert.deepEqual(focusPreviewLines(items, true), ["- [ ] [[Acme]] - Fix GeoServer", "- [ ] Standalone item"]);
  assert.deepEqual(focusPreviewLines(items, false), ["- [ ] Acme - Fix GeoServer", "- [ ] Standalone item"]);
});

test("carryOverFromYesterday falls back to !doneStates when a task has no explicit carry state", () => {
  const tasks: DailyYesterdayTask[] = [
    { line: 4, depth: 0, state: "done", checked: true, text: "Done thing", raw: "- [x] Done thing", block: "b1" },
    { line: 5, depth: 0, state: "todo", checked: false, text: "Open thing", raw: "- [ ] Open thing", block: "b2" },
  ];
  const items = carryOverFromYesterday(tasks, {}, {});
  assert.deepEqual(items, [{ project: null, text: "Open thing", block: "b2" }]);
});

test("carryOverFromYesterday excludes a task marked done, regardless of its original checked state", () => {
  const tasks: DailyYesterdayTask[] = [
    { line: 5, depth: 0, state: "todo", checked: false, text: "Reopened then closed again", raw: "- [ ] ...", block: "b1" },
  ];
  const items = carryOverFromYesterday(tasks, { 5: true }, { 5: false });
  assert.deepEqual(items, []);
});

test("carryOverFromYesterday includes a task marked carry, regardless of its done state", () => {
  const tasks: DailyYesterdayTask[] = [
    { line: 6, depth: 0, state: "done", checked: true, text: "Done but pulled back in", raw: "- [x] ...", block: "b2" },
  ];
  const items = carryOverFromYesterday(tasks, { 6: true }, { 6: true });
  assert.deepEqual(items, [{ project: null, text: "Done but pulled back in", block: "b2" }]);
});

test("carryOverFromYesterday excludes a task that is neither done nor carried", () => {
  const tasks: DailyYesterdayTask[] = [
    { line: 7, depth: 0, state: "todo", checked: false, text: "Left in limbo", raw: "- [ ] ...", block: "b3" },
  ];
  const items = carryOverFromYesterday(tasks, { 7: false }, { 7: false });
  assert.deepEqual(items, []);
});

test("carryOverFromYesterday returns an empty list when everything is done", () => {
  const tasks: DailyYesterdayTask[] = [
    { line: 1, depth: 0, state: "done", checked: true, text: "Done thing", raw: "- [x] Done thing", block: "b1" },
  ];
  assert.deepEqual(carryOverFromYesterday(tasks, {}, {}), []);
});

test("carryOverFromYesterday carries a doing task by default and keeps its block", () => {
  const tasks: DailyYesterdayTask[] = [
    { line: 2, depth: 0, state: "doing", checked: false, text: "Started thing", raw: "- [-] Started thing", block: "- [-] Started thing" },
  ];
  assert.deepEqual(carryOverFromYesterday(tasks, {}, {}), [{ project: null, text: "Started thing", block: "- [-] Started thing" }]);
});

test("carryOverFromYesterday drops a doing task marked done and not carried", () => {
  const tasks: DailyYesterdayTask[] = [
    { line: 2, depth: 0, state: "doing", checked: false, text: "Started thing", raw: "- [-] Started thing", block: "b" },
  ];
  assert.deepEqual(carryOverFromYesterday(tasks, { 2: true }, { 2: false }), []);
  assert.deepEqual(carryOverFromYesterday(tasks, { 2: true }, {}), []);
});

test("default done and carry: doing is not done and is carried, todo carries, done does not", () => {
  const base = { line: 1, depth: 0, text: "t", raw: "r" };
  assert.equal(defaultYesterdayDone({ ...base, state: "doing", checked: false }), false);
  assert.equal(defaultYesterdayCarry({ ...base, state: "doing", checked: false }), true);
  assert.equal(defaultYesterdayDone({ ...base, state: "todo", checked: false }), false);
  assert.equal(defaultYesterdayCarry({ ...base, state: "todo", checked: false }), true);
  assert.equal(defaultYesterdayDone({ ...base, state: "done", checked: true }), true);
  assert.equal(defaultYesterdayCarry({ ...base, state: "done", checked: true }), false);
});

test("shouldPersistWizardDraft is true only for the wizard's own date once hydrated", () => {
  assert.equal(shouldPersistWizardDraft("2026-09-15", "2026-09-15", true), true);
});

test("shouldPersistWizardDraft is false right after the date picker moves to a different day", () => {
  assert.equal(shouldPersistWizardDraft("2026-09-15", "2026-09-16", true), false);
});

test("shouldPersistWizardDraft is false before hydration completes", () => {
  assert.equal(shouldPersistWizardDraft("2026-09-15", "2026-09-15", false), false);
});

test("shouldPersistWizardDraft is false when no wizard date is set", () => {
  assert.equal(shouldPersistWizardDraft(null, "2026-09-15", true), false);
  assert.equal(shouldPersistWizardDraft(null, null, true), false);
});

test("mergeTrailIntoSummary fills an empty summary with the first bullets", () => {
  assert.equal(mergeTrailIntoSummary("", ["a", "b"]), "a\nb");
});

test("mergeTrailIntoSummary appends after a newline when text exists", () => {
  assert.equal(mergeTrailIntoSummary("Shipped export", ["a", "b"]), "Shipped export\na\nb");
});

test("mergeTrailIntoSummary respects max", () => {
  assert.equal(mergeTrailIntoSummary("", ["a", "b", "c", "d"]), "a\nb\nc");
  assert.equal(mergeTrailIntoSummary("", ["a", "b", "c", "d"], 2), "a\nb");
});

test("mergeTrailIntoSummary trims bullets and current text and skips blanks", () => {
  assert.equal(mergeTrailIntoSummary("  note  \n", ["  a  ", "", "b"]), "note\na\nb");
});

test("mergeTrailIntoSummary leaves current untouched when there are no bullets", () => {
  assert.equal(mergeTrailIntoSummary("keep", []), "keep");
});

test("mergeTrailIntoSummary is idempotent on a second call", () => {
  const once = mergeTrailIntoSummary("", ["a", "b", "c"]);
  assert.equal(mergeTrailIntoSummary(once, ["a", "b", "c"]), once);
});

test("mergeTrailIntoSummary takes the first max bullets not yet present", () => {
  assert.equal(mergeTrailIntoSummary("b", ["a", "b", "c", "d", "e"], 2), "b\na\nc");
  assert.equal(mergeTrailIntoSummary("  a\nb  ", [" a ", "b", "c"]), "a\nb\nc");
});

test("formatNewItemLine writes Project - item and keeps bare items as is", () => {
  assert.equal(formatNewItemLine({ project: "globex", text: "Ship export" }), "globex - Ship export");
  assert.equal(formatNewItemLine({ project: null, text: "Review backlog" }), "Review backlog");
});

test("formatNewItemLine strips a separator-looking sequence out of the project", () => {
  assert.equal(formatNewItemLine({ project: "a - b", text: "Do it" }), "a b - Do it");
});

test("appendNewItem adds a line that parseNewItems reads back as a focus item", () => {
  const text = appendNewItem("Acme - Fix\n", { project: "globex", text: "Ship export - v2" });
  assert.equal(text, "Acme - Fix\nglobex - Ship export - v2\n");
  assert.deepEqual(parseNewItems(text), [
    { project: "Acme", text: "Fix" },
    { project: "globex", text: "Ship export - v2" },
  ]);
});

test("appendNewItem starts from empty text and skips duplicates", () => {
  const once = appendNewItem("", { project: "globex", text: "Ship" });
  assert.equal(once, "globex - Ship\n");
  assert.equal(appendNewItem(once, { project: "globex", text: "Ship" }), once);
});

test("isDoingBlock is true only when the first line of the block is a [-] task", () => {
  assert.equal(isDoingBlock("- [-] started\n  - [ ] sub"), true);
  assert.equal(isDoingBlock("  * [-] indented"), true);
  assert.equal(isDoingBlock("- [ ] todo\n  - [-] nested doing"), false);
  assert.equal(isDoingBlock("- [x] done"), false);
  assert.equal(isDoingBlock(undefined), false);
  assert.equal(isDoingBlock(""), false);
});

test("doingFocusItem builds a [-] block labelled like the diary composer", () => {
  assert.deepEqual(doingFocusItem({ project: "globex", text: "Ship export" }, true), {
    project: null,
    text: "Ship export",
    block: "- [-] [[globex]] - Ship export",
  });
  assert.deepEqual(doingFocusItem({ project: "globex", text: "Ship export" }, false), {
    project: null,
    text: "Ship export",
    block: "- [-] globex - Ship export",
  });
});

test("doingFocusItem keeps a bare title when there is no project", () => {
  assert.equal(doingFocusItem({ project: null, text: "Review" }, true).block, "- [-] Review");
});

test("doingFocusItem agrees with focusPreviewLines apart from the marker", () => {
  const picked = doingFocusItem({ project: "Acme", text: "Fix" }, true);
  const todo = focusPreviewLines([{ project: "Acme", text: "Fix" }], true)[0] ?? "";
  assert.equal(picked.block, todo.replace("[ ]", "[-]"));
});

test("hasFocusItem finds a picked doing item by its block", () => {
  const picked = doingFocusItem({ project: "globex", text: "Ship" }, false);
  assert.equal(hasFocusItem([picked], picked), true);
  assert.equal(hasFocusItem([{ project: null, text: "Ship", block: "- [ ] Ship" }], picked), false);
  assert.equal(hasFocusItem([], picked), false);
});

test("focusPreviewLines shows a doing block with its [-] marker", () => {
  const picked = doingFocusItem({ project: "globex", text: "Ship" }, true);
  const carriedDoing = { project: null, text: "Old", block: "- [-] Old\n  - [ ] sub" };
  assert.deepEqual(focusPreviewLines([picked, carriedDoing, { project: null, text: "T", block: "- [ ] T" }], true), [
    "- [-] [[globex]] - Ship",
    "- [-] Old",
    "- [ ] T",
  ]);
});

test("keepPickedDoingItems keeps picked doing items that are not from yesterday", () => {
  const yesterdayTasks: DailyYesterdayTask[] = [
    { line: 3, depth: 0, state: "doing", checked: false, text: "Old", raw: "- [-] Old", block: "- [-] Old" },
  ];
  const picked = doingFocusItem({ project: "globex", text: "Ship" }, false);
  const staleYesterday = { project: null, text: "Old", block: "- [-] Old" };
  const computed = [{ project: null, text: "Open", block: "- [ ] Open" }];
  const merged = keepPickedDoingItems(computed, [staleYesterday, picked, { project: null, text: "Typed" }], yesterdayTasks);
  assert.deepEqual(merged, [...computed, picked]);
});

test("keepPickedDoingItems does not duplicate a picked item already present", () => {
  const picked = doingFocusItem({ project: null, text: "Ship" }, false);
  assert.deepEqual(keepPickedDoingItems([picked], [picked], []), [picked]);
});

test("keepPickedDoingItems returns the computed list when nothing was picked", () => {
  const computed = [{ project: null, text: "Open", block: "- [ ] Open" }];
  assert.deepEqual(keepPickedDoingItems(computed, [], []), computed);
});


function linkItem(patch: Partial<DailyLinkItem> = {}): DailyLinkItem {
  return {
    line: 4,
    raw: "- [ ] Acme - Ship export",
    checkbox: "todo",
    label: "Acme",
    projectId: "acme",
    text: "Ship export",
    taskId: null,
    candidates: [],
    taskStatus: null,
    taskPriority: null,
    mismatch: false,
    ...patch,
  };
}

const LINK_PROJECTS: BoardProject[] = [
  { id: "acme", name: "acme", title: "Acme", parent: null, depth: 0, path: "/vault/acme.md", workspace: null, workspaceSource: null },
  { id: "globex", name: "globex", title: "Globex", parent: null, depth: 0, path: "/vault/globex.md", workspace: null, workspaceSource: null },
];

test("dailyLinkState tells linked, ambiguous and missing items apart", () => {
  assert.equal(dailyLinkState(linkItem({ taskId: "acme#3", taskStatus: "todo" })), "linked");
  assert.equal(dailyLinkState(linkItem({ candidates: ["acme#3", "globex#9"] })), "ambiguous");
  assert.equal(dailyLinkState(linkItem()), "missing");
  assert.equal(dailyLinkState(linkItem({ taskId: "acme#3", candidates: ["acme#3"] })), "linked");
});

test("syncStatusFor maps the daily checkbox to the task status", () => {
  assert.equal(syncStatusFor("done"), "done");
  assert.equal(syncStatusFor("doing"), "doing");
  assert.equal(syncStatusFor("todo"), "todo");
});

test("addToTasksDefaults preselects the resolved project and carries the daily state as status", () => {
  assert.deepEqual(addToTasksDefaults(linkItem({ checkbox: "doing" }), LINK_PROJECTS), { projectId: "acme", title: "Ship export", status: "doing" });
  assert.deepEqual(addToTasksDefaults(linkItem({ checkbox: "done" }), LINK_PROJECTS).status, "done");
});

test("addToTasksDefaults leaves the project empty when it is unresolved or unknown", () => {
  assert.equal(addToTasksDefaults(linkItem({ projectId: null, label: null }), LINK_PROJECTS).projectId, "");
  assert.equal(addToTasksDefaults(linkItem({ projectId: "gone" }), LINK_PROJECTS).projectId, "");
});
