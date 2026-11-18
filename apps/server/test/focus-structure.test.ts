import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-focus-structure-data-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_SECOND_BRAIN;

type Store = typeof import("../src/delegation-store.js");
type Board = typeof import("../src/tasks-board.js");
type Structure = typeof import("../src/focus-structure.js");
type BoardTask = import("../src/tasks-board.js").BoardTask;
type BoardProject = import("../src/tasks-board.js").BoardProject;
type DocLine = import("../src/tasks-board.js").DocLine;
type EngineLink = import("../src/focus-structure.js").EngineLink;
let store: Store;
let board: Board;
let structure: Structure;
let settings: DelegationSettings;

const SCHEDULED = "⏳";
const REPEAT = "\u{1F501}";

function dayOf(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

const TODAY = dayOf(new Date());

before(async () => {
  store = await import("../src/delegation-store.js");
  board = await import("../src/tasks-board.js");
  structure = await import("../src/focus-structure.js");
  store.updateSettings({
    features: { daily: true, tasks: true, trail: false, usage: false, limits: false },
    tasks: { root: "projects", doneSection: "Done loops", priorityTag: "p" },
    daily: { dir: "daily", template: "", wikilinks: true, projectOrder: [], focusSource: "scheduled", headings: { focus: "Focus", meetings: "Meetings", sessions: "Sessions", captures: "" } },
  });
  settings = store.getSettings();
});

after(async () => {
  (await import("../src/db.js")).db.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function projectOf(id: string, title: string): BoardProject {
  return { id, name: id, title, parent: null, depth: 0, path: `${id}.md`, workspace: null, workspaceSource: null };
}

function boardOf(projects: Record<string, string[]>): { projects: BoardProject[]; tasks: BoardTask[] } {
  const list = Object.keys(projects).map((id) => projectOf(id, `${id[0]?.toUpperCase() ?? ""}${id.slice(1)}`));
  const tasks = Object.entries(projects).flatMap(([id, open]) => board.parseBoardTasks([`# ${id}`, "", "## Open loops", "", ...open, "", "## Done loops", "", "-", ""].join("\n"), id, settings.tasks));
  return { projects: list, tasks };
}

function note(focus: string[], other: string[] = []): string {
  return ["# Day", "", "## Focus", "", ...focus, "", "## Meetings", "", ...other, "- 10:00 Standup", ""].join("\n");
}

function run(content: string, data: { projects: BoardProject[]; tasks: BoardTask[] }, known: (doc: import("../src/tasks-board.js").ParsedDoc) => Map<DocLine, EngineLink> = () => new Map()) {
  const doc = board.openDoc(content);
  const result = structure.restructureFocus(settings, TODAY, doc, data, known(doc));
  return { result, text: board.renderDoc(doc) };
}

function find(tasks: BoardTask[], title: string): BoardTask {
  const found = board.flattenTasks(tasks).find((task) => task.title === title);
  assert.ok(found, title);
  return found;
}

describe("restructureFocus", () => {
  it("changes nothing without a focus section or when every line already follows the project", () => {
    const data = boardOf({ alpha: [`- [ ] Release the build ${SCHEDULED} ${TODAY}`, "  - [ ] Write the changelog"] });
    const bare = "# Day\n\n## Meetings\n\n- 10:00\n";
    assert.deepEqual(run(bare, data), { result: structure.noStructure(), text: bare });
    const placed = note(["- [ ] [[alpha|Alpha]] - Release the build", "  - [ ] Write the changelog", "  - free note"]);
    const outcome = run(placed, data);
    assert.equal(outcome.text, placed);
    assert.equal(outcome.result.changed, false);
  });

  it("leaves recurring blocks and indented lines before the first item alone", () => {
    const data = boardOf({ alpha: [`- [ ] Daily standup ${REPEAT} every day ${SCHEDULED} ${TODAY}`, "  - [ ] Ask about the release", `- [ ] Ask about the release window ${SCHEDULED} ${TODAY}`] });
    const content = note(["  - [ ] Ask about the release window", "- [ ] [[alpha|Alpha]] - Daily standup", "  - [ ] Ask about the release window"]);
    const outcome = run(content, data);
    assert.equal(outcome.text, content);
  });

  it("moves a top-level line under its parent's line, drops its label and hands its blank line to the next block", () => {
    const data = boardOf({ alpha: [`- [ ] Release the build ${SCHEDULED} ${TODAY}`, `  - [ ] Write the changelog ${SCHEDULED} ${TODAY}`], beta: [`- [ ] Beta work ${SCHEDULED} ${TODAY}`] });
    const content = note(["- [ ] [[alpha|Alpha]] - Release the build", "", "- [x] [[alpha|Alpha]] - Write the changelog extra words", "", "- [ ] [[beta|Beta]] - Beta work"]);
    const outcome = run(content, data);
    assert.equal(outcome.text, note(["- [ ] [[alpha|Alpha]] - Release the build", "  - [x] Write the changelog extra words", "", "- [ ] [[beta|Beta]] - Beta work"]));
    assert.deepEqual(outcome.result.moved, [find(data.tasks, "Write the changelog").id]);
    assert.deepEqual(outcome.result.divergent.map((item) => item.checkbox), ["done"]);
  });

  it("merges copies into the survivor, re-homing their notes and children, and reports the copy that disagreed", () => {
    const data = boardOf({ alpha: [`- [-] Release the build ${SCHEDULED} ${TODAY}`, `  - [ ] Write the changelog ${SCHEDULED} ${TODAY}`] });
    const content = note(["- [-] [[alpha|Alpha]] - Release the build", "  - first note", "- [x] [[alpha|Alpha]] - Release the build", "  - second note", "  - [ ] Write the changelog"]);
    const outcome = run(content, data);
    assert.equal(outcome.text, note(["- [-] [[alpha|Alpha]] - Release the build", "  - first note", "  - second note", "  - [ ] Write the changelog"]));
    assert.deepEqual(outcome.result.merged, [find(data.tasks, "Release the build").id]);
    assert.deepEqual(outcome.result.divergent.map((item) => [item.line.text, item.checkbox]), [["- [-] [[alpha|Alpha]] - Release the build", "done"]]);
  });

  it("renames a line from the title the engine remembered and keeps the user's suffix", () => {
    const data = boardOf({ alpha: [`- [ ] Ship the new build ${SCHEDULED} ${TODAY}`] });
    const content = note(["- [ ] [[alpha|Alpha]] - Ship release (call Ana)"]);
    const outcome = run(content, data, (doc) => new Map([[doc.lines.find((line) => line.text.includes("Ship release")) as DocLine, { task: find(data.tasks, "Ship the new build"), title: "Ship release" }]]));
    assert.equal(outcome.text, note(["- [ ] [[alpha|Alpha]] - Ship the new build (call Ana)"]));
    assert.equal(outcome.result.renamed.length, 1);
  });

  it("extends a line that is a prefix of a longer project title and writes the status prefix and reason", () => {
    const data = boardOf({ alpha: [`- [ ] Release the build ${SCHEDULED} ${TODAY}`, "  - [ ] BLOCK - Write the changelog for ops - waiting for Bia"] });
    const content = note(["- [ ] [[alpha|Alpha]] - Release the build", "  - [ ] Write the changelog"]);
    const outcome = run(content, data);
    assert.equal(outcome.text, note(["- [ ] [[alpha|Alpha]] - Release the build", "  - [ ] BLOCK - Write the changelog for ops - waiting for Bia"]));
  });

  it("uses tabs under a tab-indented parent and a blank line before a block of another project", () => {
    const data = boardOf({
      alpha: [`- [ ] Release the build ${SCHEDULED} ${TODAY}`, `\t- [ ] Phase one of the release`, `\t\t- [ ] Write the changelog ${SCHEDULED} ${TODAY}`, `- [ ] Loose alpha task ${SCHEDULED} ${TODAY}`],
      beta: [`- [ ] Beta work ${SCHEDULED} ${TODAY}`],
    });
    const content = note(["- [ ] [[alpha|Alpha]] - Release the build", "\t- [ ] Write the changelog", "- [ ] [[beta|Beta]] - Beta work", "  - [ ] Loose alpha task"]);
    const outcome = run(content, data, (doc) => new Map([[doc.lines.find((line) => line.text.includes("Loose alpha")) as DocLine, { task: find(data.tasks, "Loose alpha task"), title: null }]]));
    assert.equal(
      outcome.text,
      note(["- [ ] [[alpha|Alpha]] - Release the build", "\t- [ ] Phase one of the release", "\t\t- [ ] Write the changelog", "- [ ] [[beta|Beta]] - Beta work", "", "- [ ] [[alpha|Alpha]] - Loose alpha task"]),
    );
    assert.deepEqual(outcome.result.created, [find(data.tasks, "Phase one of the release").id]);
  });

  it("leaves a line in place and reports its task when the move would not link, and reports lines that could be two tasks", () => {
    const data = boardOf({
      alpha: [
        `- [ ] Release the build ${SCHEDULED} ${TODAY}`,
        `  - [ ] Write the changelog ${SCHEDULED} ${TODAY}`,
        "  - [ ] Write the changelog",
        `- [ ] Other task of the day ${SCHEDULED} ${TODAY}`,
        "  - [ ] Ask the team",
        `- [ ] Third task ${SCHEDULED} ${TODAY}`,
        `  - [ ] Ask the team ${SCHEDULED} ${TODAY}`,
        `- [ ] Fourth task ${SCHEDULED} ${TODAY}`,
        `  - [ ] Ask the team ${SCHEDULED} ${TODAY}`,
      ],
    });
    const content = note(["- [ ] [[alpha|Alpha]] - Release the build", "  - [ ] Ask the team", "- [ ] [[alpha|Alpha]] - Other task of the day", "  - [ ] Write the changelog", "- [ ] [[alpha|Alpha]] - Fourth task"]);
    const outcome = run(content, data);
    assert.equal(outcome.text, content);
    assert.equal(outcome.result.changed, false);
    assert.deepEqual(outcome.result.unclear.map((task) => task.title).sort(), ["Ask the team", "Ask the team", "Write the changelog"]);
  });
});

describe("restructureFocus removes only exact duplicates of the surviving line", () => {
  const PARENT = `- [ ] Parent job ${SCHEDULED} ${TODAY}`;
  const similar = (result: import("../src/focus-structure.js").StructureResult): string[] => result.similar.map((item) => item.line.text.trim()).sort();

  it("keeps a line that only starts with a task title next to the task line and reports it", () => {
    const data = boardOf({ alpha: [PARENT, `  - [ ] Deploy the server ${SCHEDULED} ${TODAY}`] });
    const content = note(["- [ ] [[alpha|Alpha]] - Parent job", "  - [ ] Deploy the server", "  - [ ] Deploy the server again on staging for Ana"]);
    const outcome = run(content, data);
    assert.equal(outcome.text, content);
    assert.deepEqual(outcome.result.merged, []);
    assert.deepEqual(similar(outcome.result), ["- [ ] Deploy the server again on staging for Ana"]);
  });

  it("never collapses two lines that extend the same title and reports both", () => {
    const data = boardOf({ alpha: [PARENT, "  - [ ] Review the docs"] });
    const content = note(["- [ ] [[alpha|Alpha]] - Parent job", "  - [ ] Review the docs for Ana", "  - [ ] Review the docs for Bob"]);
    const outcome = run(content, data);
    assert.equal(outcome.text, content);
    assert.deepEqual(similar(outcome.result), ["- [ ] Review the docs for Ana", "- [ ] Review the docs for Bob"]);
  });

  it("keeps the tick of a free line that names a sibling title and never links it", () => {
    const data = boardOf({ alpha: [PARENT, "  - [ ] Review the docs"] });
    const content = note(["- [ ] [[alpha|Alpha]] - Parent job", "  - [x] Review the docs and then ping", "  - [ ] Review the docs"]);
    const outcome = run(content, data);
    assert.equal(outcome.text, content);
    assert.deepEqual(outcome.result.divergent, []);
  });

  it("reports a line under a wrong ancestor that only starts with a task title and leaves it in place", () => {
    const data = boardOf({ alpha: [PARENT, "  - [ ] Phase one of the job", `    - [ ] Deploy the server ${SCHEDULED} ${TODAY}`] });
    const content = note(["- [ ] [[alpha|Alpha]] - Parent job", "  - [ ] Deploy the server tomorrow with Ana"]);
    const outcome = run(content, data);
    assert.equal(outcome.text, content);
    assert.deepEqual(outcome.result.similar.map((item) => item.task?.title), ["Deploy the server"]);
  });

  it("carries the suffix of the removed copy onto the survivor", () => {
    const data = boardOf({ alpha: [PARENT, `  - [ ] Deploy the server ${SCHEDULED} ${TODAY}`] });
    const content = note(["- [ ] [[alpha|Alpha]] - Parent job", "  - [ ] Deploy the server", "- [ ] [[alpha|Alpha]] - Deploy the server _Falta Deploy_", "  - note of the copy"]);
    const outcome = run(content, data);
    assert.equal(outcome.text, note(["- [ ] [[alpha|Alpha]] - Parent job", "  - [ ] Deploy the server _Falta Deploy_", "    - note of the copy"]));
    assert.equal(outcome.result.merged.length, 1);
  });

  it("keeps both copies when they carry different suffixes and reports the one left in place", () => {
    const data = boardOf({ alpha: [PARENT, `  - [ ] Deploy the server ${SCHEDULED} ${TODAY}`] });
    const content = note(["- [ ] [[alpha|Alpha]] - Parent job", "  - [ ] Deploy the server _Falta Deploy_", "- [ ] [[alpha|Alpha]] - Deploy the server _Falta Teste_"]);
    const outcome = run(content, data);
    assert.equal(outcome.text, content);
    assert.deepEqual(outcome.result.merged, []);
    assert.deepEqual(similar(outcome.result), ["- [ ] [[alpha|Alpha]] - Deploy the server _Falta Teste_"]);
  });

  it("moves an indented line without a bullet together with its task line", () => {
    const data = boardOf({ alpha: [PARENT, `- [ ] Deploy the server ${SCHEDULED} ${TODAY}`] });
    const content = note(["- [ ] [[alpha|Alpha]] - Parent job", "  - [ ] Deploy the server", "  some free text continuation", "- free note"]);
    const outcome = run(content, data);
    assert.equal(outcome.text, note(["- [ ] [[alpha|Alpha]] - Parent job", "- [ ] [[alpha|Alpha]] - Deploy the server", "  some free text continuation", "- free note"]));
  });

  it("lists every rename with the old and the new text", () => {
    const data = boardOf({ alpha: [PARENT, "  - [ ] Write the changelog - waiting on Bob"] });
    const content = note(["- [ ] [[alpha|Alpha]] - Parent job", "  - [ ] Write the changelog - ask Ana"]);
    const outcome = run(content, data);
    assert.equal(outcome.text, note(["- [ ] [[alpha|Alpha]] - Parent job", "  - [ ] Write the changelog - waiting on Bob"]));
    assert.deepEqual(
      outcome.result.renames.map((item) => [item.from, item.to]),
      [["Write the changelog - ask Ana", "Write the changelog - waiting on Bob"]],
    );
  });
});
