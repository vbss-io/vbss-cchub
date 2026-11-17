import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { BoardProject, BoardTask, TodayData, TodayUnmatched } from "./delegation";
import { canCreateFromNoMatch, canLinkNoMatch, lineCheckbox, lineContent, matchingOpenTasks, noteBlocksOf, noteSections, planFocusAdd, splitNoteLine, titleKey } from "./today-note";

const DAY = "2026-11-15";

const task = (id: string, projectId: string, patch: Partial<BoardTask> = {}, subtasks: BoardTask[] = []): BoardTask => ({
  id,
  projectId,
  line: 1,
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

const project = (id: string, title: string, name = id): BoardProject => ({ id, name, title, parent: null, depth: 0, path: `/${id}.md`, workspace: null, workspaceSource: null });

const PROJECTS = [project("vbss/imaginaria", "Imaginaria", "imaginaria"), project("canteiro", "Canteiro")];

type NoteData = Pick<TodayData, "noteBlocks" | "inNoteLinks" | "inNote" | "unlinked" | "unmatched" | "ambiguous">;

const data = (patch: Partial<NoteData>): NoteData => ({ inNote: [], unlinked: [], ...patch });

describe("note line text", () => {
  it("reads the checkbox and strips bullet and checkbox", () => {
    assert.equal(lineCheckbox("- [ ] a"), "todo");
    assert.equal(lineCheckbox("  - [x] a"), "done");
    assert.equal(lineCheckbox("* [-] a"), "doing");
    assert.equal(lineCheckbox("- a"), null);
    assert.equal(lineCheckbox("plain"), null);
    assert.equal(lineContent("- [ ] **Ship** it"), "**Ship** it");
    assert.equal(lineContent("1. plain"), "plain");
  });

  it("resolves the label of a line to its project and keeps the rest as the task text", () => {
    assert.deepEqual(splitNoteLine("- [ ] [[imaginaria|Imaginaria]] - Write **spec**", PROJECTS), { projectId: "vbss/imaginaria", text: "Write **spec**" });
    assert.deepEqual(splitNoteLine("- [ ] [[projects/vbss/imaginaria.md]] Fix _billing_", PROJECTS), { projectId: "vbss/imaginaria", text: "Fix _billing_" });
    assert.deepEqual(splitNoteLine("- [ ] Canteiro - Pour concrete", PROJECTS), { projectId: "canteiro", text: "Pour concrete" });
    assert.deepEqual(splitNoteLine("- [ ] Someone - Call back", PROJECTS), { projectId: null, text: "Someone - Call back" });
    assert.deepEqual(splitNoteLine("- [ ] [[Random note]] - Read it", PROJECTS), { projectId: null, text: "[[Random note]] - Read it" });
  });
});

describe("note blocks", () => {
  it("uses the server blocks when present", () => {
    const blocks = noteBlocksOf(data({ noteBlocks: [{ line: "- [ ] a", lineIndex: 4, taskId: null, projectId: null, text: "a", children: ["  - n"] }] }));
    assert.deepEqual(blocks, [{ line: "- [ ] a", lineIndex: 4, taskId: null, projectId: null, text: "a", children: ["  - n"] }]);
  });

  it("falls back to the linked lines of an older hub, folding indented lines into the block above", () => {
    const blocks = noteBlocksOf(data({ inNoteLinks: [{ line: "- [ ] a", taskId: "t#1" }, { line: "  - n", taskId: null }, { line: "- [ ] b", taskId: null }] }));
    assert.deepEqual(
      blocks.map((block) => [block.line, block.taskId, block.lineIndex, block.children]),
      [
        ["- [ ] a", "t#1", null, ["  - n"]],
        ["- [ ] b", null, null, []],
      ],
    );
  });
});

describe("note sections", () => {
  const linked = task("vbss/imaginaria#3", "vbss/imaginaria", { title: "Billing page" });
  const tasks = [linked];
  const tick = (line: string, lineIndex: number): TodayUnmatched => ({ line, lineIndex, section: "Focus", checkbox: "done", candidates: [{ projectId: "canteiro", line: 2, raw: "- [ ] x", title: "x" }] });

  it("lists only the blocks linked to a task in Also in the note and the rest once in no matching task", () => {
    const sections = noteSections(
      data({
        noteBlocks: [
          { line: "- [ ] [[imaginaria|Imaginaria]] - Billing page", lineIndex: 10, taskId: linked.id, projectId: "vbss/imaginaria", text: "Billing page", children: ["  - context"] },
          { line: "- [x] [[canteiro|Canteiro]] - Pour concrete", lineIndex: 11, taskId: null, projectId: "canteiro", text: "Pour concrete", children: [] },
          { line: "- [ ] free thought", lineIndex: 12, taskId: null, projectId: null, text: "free thought", children: [] },
        ],
        unmatched: [tick("- [x] [[canteiro|Canteiro]] - Pour concrete", 11), tick("- [x] Elsewhere in the note", 30)],
      }),
      tasks,
      PROJECTS,
    );
    assert.deepEqual(sections.linked.map((item) => [item.task.id, item.block.children]), [[linked.id, ["  - context"]]]);
    assert.deepEqual(
      sections.noMatch.map((item) => [item.line, item.lineIndex, item.projectId, item.text, item.tick !== null, item.candidates.length]),
      [
        ["- [x] [[canteiro|Canteiro]] - Pour concrete", 11, "canteiro", "Pour concrete", true, 1],
        ["- [x] Elsewhere in the note", 30, null, "Elsewhere in the note", true, 1],
        ["- [ ] free thought", 12, null, "free thought", false, 0],
      ],
    );
    const lines = [...sections.linked.map((item) => item.block.line), ...sections.noMatch.map((item) => item.line)];
    assert.equal(new Set(lines).size, lines.length);
  });

  it("treats a block whose linked task is gone as a line with no matching task", () => {
    const sections = noteSections(data({ noteBlocks: [{ line: "- [ ] Gone", lineIndex: 3, taskId: "x#9", projectId: null, text: "Gone", children: [] }] }), tasks, PROJECTS);
    assert.deepEqual(sections.linked, []);
    assert.deepEqual(sections.noMatch.map((item) => item.text), ["Gone"]);
  });

  it("attaches the ambiguity hint to its line instead of listing the line twice", () => {
    const sections = noteSections(
      data({
        noteBlocks: [{ line: "- [ ] Twin", lineIndex: 5, taskId: null, projectId: null, text: "Twin", children: [] }],
        ambiguous: [
          { kind: "line", text: "- [ ] Twin", line: 5, taskId: null, reason: "several-tasks" },
          { kind: "task", text: "Same title", line: null, taskId: "a#1", reason: "same-title" },
        ],
      }),
      tasks,
      PROJECTS,
    );
    assert.equal(sections.noMatch.length, 1);
    assert.match(sections.noMatch[0]?.hint ?? "", /more than one task/);
    assert.deepEqual(sections.ambiguous.map((item) => item.text), ["Same title"]);
  });

  it("offers Link only for checkbox lines with a known index and Create only with text", () => {
    assert.equal(canLinkNoMatch({ lineIndex: 3, checkbox: "todo" }), true);
    assert.equal(canLinkNoMatch({ lineIndex: null, checkbox: "todo" }), false);
    assert.equal(canLinkNoMatch({ lineIndex: 3, checkbox: null }), false);
    assert.equal(canCreateFromNoMatch({ text: "  " }), false);
    assert.equal(canCreateFromNoMatch({ text: "Do it" }), true);
  });
});

describe("add to focus from Today", () => {
  const tasks = [
    task("canteiro#1", "canteiro", { title: "Pour **concrete**" }),
    task("canteiro#2", "canteiro", { title: "Order bricks", scheduled: DAY }),
    task("canteiro#3", "canteiro", { title: "Paint", status: "done", section: "done" }),
    task("canteiro#4", "canteiro", { title: "Parent" }, [task("canteiro#5", "canteiro", { title: "Café com o mestre" })]),
    task("vbss/imaginaria#1", "vbss/imaginaria", { title: "Order bricks" }),
  ];

  it("matches titles ignoring case, accents, spaces and wikilink syntax", () => {
    assert.equal(titleKey("  Café   com o [[mestre]] "), "cafe com o mestre");
    assert.deepEqual(matchingOpenTasks(tasks, "canteiro", "cafe COM o mestre").map((item) => item.id), ["canteiro#5"]);
    assert.deepEqual(matchingOpenTasks(tasks, "canteiro", "paint"), []);
  });

  it("schedules the open task of that project that already has the text instead of creating a duplicate", () => {
    assert.deepEqual(planFocusAdd(tasks, "canteiro", "pour **Concrete**", DAY, DAY, new Set()), { kind: "schedule", task: tasks[0] });
    assert.deepEqual(planFocusAdd(tasks, "canteiro", "Pour concrete", DAY, DAY, new Set()), { kind: "schedule", task: tasks[0] });
    assert.equal(titleKey("keep snake_case and _drop_ marks"), "keep snake_case and drop marks");
  });

  it("reports a task already in the focus without writing", () => {
    assert.deepEqual(planFocusAdd(tasks, "canteiro", "Order bricks", DAY, DAY, new Set()), { kind: "already", task: tasks[1] });
    assert.deepEqual(planFocusAdd(tasks, "vbss/imaginaria", "Order bricks", DAY, DAY, new Set(["vbss/imaginaria#1"])), { kind: "already", task: tasks[4] });
  });

  it("creates the task when nothing open matches, done tasks and other projects included, with inline tokens parsed", () => {
    assert.deepEqual(planFocusAdd(tasks, "canteiro", "Paint #p1 due:2026-11-20", DAY, DAY, new Set()), { kind: "create", projectId: "canteiro", input: { title: "Paint", priority: 1, due: "2026-11-20" } });
    assert.deepEqual(planFocusAdd(tasks, "vbss/imaginaria", "Pour concrete", DAY, DAY, new Set()), { kind: "create", projectId: "vbss/imaginaria", input: { title: "Pour concrete" } });
  });

  it("does nothing without a project or a title", () => {
    assert.equal(planFocusAdd(tasks, "", "x", DAY, DAY, new Set()), null);
    assert.equal(planFocusAdd(tasks, "canteiro", "  #p1 ", DAY, DAY, new Set()), null);
  });
});
