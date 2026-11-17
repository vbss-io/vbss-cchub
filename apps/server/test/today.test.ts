import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fixtures, freePort, makeSandbox, startServer, waitFor, type RunningServer, type Sandbox } from "./helpers.js";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-today-data-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.HUB_WORKSPACES_ROOT;
delete process.env.HUB_EDITOR;
delete process.env.HUB_SECOND_BRAIN;

type Store = typeof import("../src/delegation-store.js");
type Board = typeof import("../src/tasks-board.js");
type Daily = typeof import("../src/daily.js");
type Today = typeof import("../src/today.js");
type Sse = typeof import("../src/sse.js");
type BoardTask = import("../src/tasks-board.js").BoardTask;
let store: Store;
let board: Board;
let daily: Daily;
let today: Today;
let sse: Sse;

const GOLDEN = join(fixtures, "vault-golden");
const SCHEDULED = "⏳";
const DONE = "✅";
const REPEAT = "\u{1F501}";
const roots: string[] = [];

before(async () => {
  store = await import("../src/delegation-store.js");
  board = await import("../src/tasks-board.js");
  daily = await import("../src/daily.js");
  today = await import("../src/today.js");
  sse = await import("../src/sse.js");
  today.installTodayHooks();
  today.setFocusStability({ delayMs: 0 });
});

beforeEach(() => today.forgetTodayState());
afterEach(() => today.forgetTodayState());

after(async () => {
  today.removeTodayHooks();
  daily.stopDailyWatch();
  board.stopTasksBoardWatch();
  (await import("../src/db.js")).db.close();
  for (const dir of [dataDir, ...roots]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const TODAY = ((): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
})();

function shift(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00`);
  at.setDate(at.getDate() + days);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

const YESTERDAY = shift(TODAY, -1);
const TOMORROW = shift(TODAY, 1);
const PAST = "2026-11-10";

const TEMPLATE = ["---", "type: daily", "created: {{date}}", "---", "", "# {{date}}", "", "## Focus", "", "- [ ]", "", "## Meetings", "", "-", "", "## Captures", "", "-", "", "## Sessions", "", "-", ""].join("\n");

function write(root: string, rel: string, content: string | Buffer): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function lab(projects: Record<string, string>, dailies: Record<string, string> = {}, template: string = TEMPLATE): string {
  const root = mkdtempSync(join(tmpdir(), "cch-today-vault-"));
  roots.push(root);
  write(root, "_templates/daily.md", template);
  for (const [name, content] of Object.entries(projects)) write(root, `projects/${name}.md`, content);
  for (const [date, content] of Object.entries(dailies)) write(root, `daily/${date}.md`, content);
  return root;
}

function golden(): string {
  const root = mkdtempSync(join(tmpdir(), "cch-today-golden-"));
  roots.push(root);
  cpSync(GOLDEN, root, { recursive: true });
  return root;
}

function useVault(root: string, focusSource: "scheduled" | "list" = "scheduled"): DelegationSettings {
  store.updateSettings({
    secondBrainRoot: root,
    features: { daily: true, tasks: true, trail: false, usage: false, limits: false },
    tasks: { root: "projects", doneSection: "Done loops" },
    daily: {
      dir: "daily",
      template: "_templates/daily.md",
      wikilinks: true,
      projectOrder: [],
      focusSource,
      headings: { focus: "Focus", meetings: "Meetings", sessions: "Sessions", captures: "" },
    },
  });
  store.setSetting(`today.migrated.${TODAY}`, null);
  return store.getSettings();
}

function dailyWith(date: string, focus: string[], extra: Record<string, string[]> = {}): string {
  const sections = [
    `## Focus\n\n${focus.join("\n")}`,
    `## Meetings\n\n${(extra.meetings ?? ["-"]).join("\n")}`,
    `## Captures\n\n${(extra.captures ?? ["-"]).join("\n")}`,
    `## Sessions\n\n-`,
  ];
  return `---\ntype: daily\ncreated: ${date}\n---\n\n# ${date}\n\n${sections.join("\n\n")}\n`;
}

function sectionOf(content: string, heading: string): string[] {
  const lines = content.split(/\r\n|\n/);
  const start = lines.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, heading);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if ((lines[index] as string).startsWith("## ")) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function digestOf(...files: string[]): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(readFileSync(file));
  return hash.digest("hex");
}

function flatten(tasks: BoardTask[]): BoardTask[] {
  return tasks.flatMap((task) => [task, ...flatten(task.subtasks)]);
}

function taskIn(settings: DelegationSettings, projectId: string, title: string): BoardTask {
  const found = flatten(board.readBoard(settings).tasks).find((task) => task.projectId === projectId && task.title === title);
  assert.ok(found, `${projectId}: ${title}`);
  return found;
}

function scheduleOf(settings: DelegationSettings, projectId: string, title: string, date: string | null): { task: BoardTask } {
  const task = taskIn(settings, projectId, title);
  return today.todayApi.schedule(settings, { projectId, line: task.line, raw: task.raw, date });
}

function labProject(): string {
  return [
    "# Lab Project",
    "",
    "## Open loops",
    "",
    `- [ ] Alpha ${SCHEDULED} ${TODAY}`,
    "  - [ ] Alpha child",
    "- [ ] Beta",
    `  - [ ] Beta child ${SCHEDULED} ${TODAY}`,
    `- [-] Gamma ${SCHEDULED} ${TODAY}`,
    `  - [ ] Gamma child ${SCHEDULED} ${TODAY}`,
    `- [ ] Delta ${SCHEDULED} ${YESTERDAY}`,
    `- [ ] BLOCK - Epsilon - waiting on the vendor ${SCHEDULED} ${TODAY}`,
    `- [ ] ARCHIVED - Zeta - gone ${SCHEDULED} ${TODAY}`,
    `- [ ] Eta ${SCHEDULED} ${TOMORROW}`,
    `- [ ] Theta ${REPEAT} every day ${SCHEDULED} ${TODAY}`,
    "",
    "## Done loops",
    "",
    `- [x] Iota ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`,
    `- [x] Kappa ${SCHEDULED} ${TODAY} ${DONE} ${YESTERDAY}`,
    `- [x] Lambda ${SCHEDULED} ${YESTERDAY} ${DONE} ${TODAY}`,
    "",
  ].join("\n");
}

describe("settings", () => {
  it("keeps the new daily keys out of the settings until they are stored and reads them back", () => {
    const base = store.getSettings();
    assert.equal(base.daily.focusSource, undefined);
    assert.equal("captures" in base.daily.headings, false);
    assert.equal(today.focusSourceOf(base), "scheduled");
    const stored = store.updateSettings({ daily: { focusSource: "list", headings: { captures: "Capturas do dia" } } });
    assert.equal(stored.daily.focusSource, "list");
    assert.equal(stored.daily.headings.captures, "Capturas do dia");
    assert.equal(today.focusSourceOf(stored), "list");
    const cleared = store.updateSettings({ daily: { headings: { captures: "  " } } });
    assert.equal("captures" in cleared.daily.headings, false);
    assert.equal(cleared.daily.focusSource, "list");
    store.updateSettings({ daily: { focusSource: "scheduled" } });
  });
});

describe("focus and carried over", () => {
  it("selects the open tasks scheduled for the date plus the ones finished that day, subtasks inside their parent", () => {
    const root = lab({ lab: labProject() });
    const settings = useVault(root);
    const focus = today.todayApi.focusOf(settings, TODAY);
    assert.deepEqual(
      focus.map((entry) => [entry.task.title, entry.task.status, entry.parentTitle, entry.project.id, entry.project.title, entry.project.name]),
      [
        ["Alpha", "todo", null, "lab", "Lab Project", "lab"],
        ["Beta child", "todo", "Beta", "lab", "Lab Project", "lab"],
        ["Gamma", "doing", null, "lab", "Lab Project", "lab"],
        ["Epsilon", "blocked", null, "lab", "Lab Project", "lab"],
        ["Theta", "todo", null, "lab", "Lab Project", "lab"],
        ["Iota", "done", null, "lab", "Lab Project", "lab"],
        ["Lambda", "done", null, "lab", "Lab Project", "lab"],
      ],
    );
    const gamma = focus.find((entry) => entry.task.title === "Gamma");
    assert.deepEqual(gamma?.task.subtasks.map((task) => task.title), ["Gamma child"]);
    assert.equal(focus.some((entry) => entry.task.title === "Gamma child"), false);
    assert.equal(focus.some((entry) => ["Delta", "Zeta", "Eta", "Kappa"].includes(entry.task.title)), false);
  });

  it("lists the open tasks scheduled before the date, only from today on", () => {
    const root = lab({ lab: labProject() });
    const settings = useVault(root);
    assert.deepEqual(today.todayApi.carriedOver(settings, TODAY).map((entry) => entry.task.title), ["Delta"]);
    assert.deepEqual(
      today.todayApi.carriedOver(settings, TOMORROW).map((entry) => entry.task.title),
      ["Alpha", "Beta child", "Gamma", "Delta", "Epsilon", "Theta"],
    );
    assert.deepEqual(today.todayApi.carriedOver(settings, YESTERDAY), []);
  });

  it("orders the entries by the project order setting, then by file order", () => {
    const root = lab({
      aaa: `# Aaa\n\n## Open loops\n\n- [ ] First ${SCHEDULED} ${TODAY}\n`,
      zzz: `# Zzz\n\n## Open loops\n\n- [ ] Second ${SCHEDULED} ${TODAY}\n- [ ] Third ${SCHEDULED} ${TODAY}\n`,
    });
    useVault(root);
    const ordered = store.updateSettings({ daily: { projectOrder: ["zzz", "aaa"] } });
    assert.deepEqual(today.todayApi.focusOf(ordered, TODAY).map((entry) => entry.task.title), ["Second", "Third", "First"]);
    const natural = store.updateSettings({ daily: { projectOrder: [] } });
    assert.deepEqual(today.todayApi.focusOf(natural, TODAY).map((entry) => entry.task.title), ["First", "Second", "Third"]);
  });

  it("answers the payload with the daily parts: meetings, captures, summary and the unlinked lines", () => {
    const content = [
      "---",
      "type: daily",
      "---",
      "",
      "# Day",
      "",
      "> **Briefing:**",
      ">",
      "> - first point",
      "",
      "> second block",
      "",
      "## Focus",
      "",
      `- [ ] [[lab|Lab Project]] - Alpha`,
      "- [ ] Not a task of any project",
      "",
      "## Meetings",
      "",
      "- 10:00 Standup",
      "-",
      "- 11:00 Review",
      "",
      "## Captures",
      "",
      "- call the bank",
      "- turn this into a task → [[lab]]",
      "",
    ].join("\n");
    const root = lab({ lab: labProject() }, { [TODAY]: content });
    const settings = useVault(root);
    store.updateSettings({ daily: { focusSource: "scheduled" } });
    const payload = today.readToday(store.getSettings(), TODAY);
    assert.equal(payload.date, TODAY);
    assert.equal(payload.focusSource, "scheduled");
    assert.equal(payload.dailyExists, true);
    assert.equal(typeof payload.dailyUpdatedAt, "number");
    assert.deepEqual(payload.meetings, ["10:00 Standup", "11:00 Review"]);
    assert.deepEqual(
      payload.captures.map((capture) => [capture.text, capture.promotedTo]),
      [
        ["call the bank", null],
        ["turn this into a task", "lab"],
      ],
    );
    assert.equal(payload.summary, "**Briefing:**\n\n- first point\n\nsecond block");
    assert.deepEqual(payload.unlinked, ["- [ ] Not a task of any project"]);
    assert.deepEqual(payload.carriedOver.map((entry) => entry.task.title), ["Delta"]);
    assert.equal(settings.daily.focusSource, "scheduled");
  });

  it("G00c: puts a labelled linked line in the focus, lists the other lines as in the note and the ones linked to no task as unlinked, without the empty placeholder", () => {
    const root = lab({ lab: "# Lab\n\n## Open loops\n\n- [ ] Unscheduled task\n" }, { [TODAY]: dailyWith(TODAY, ["- [ ] [[lab|Lab]] - Unscheduled task", "- [ ] free", "-", "  - nested free"]) });
    const settings = useVault(root);
    const file = join(root, "daily", `${TODAY}.md`);
    const before = readFileSync(file);
    store.setSetting(`today.migrated.${TODAY}`, "1");
    const payload = today.readToday(settings, TODAY);
    assert.deepEqual(payload.focus.map((entry) => entry.task.title), ["Unscheduled task"]);
    assert.deepEqual(payload.inNote, ["- [ ] free", "  - nested free"]);
    assert.deepEqual(payload.unlinked, ["- [ ] free", "  - nested free"]);
    assert.deepEqual(payload.ambiguous, []);
    assert.equal(readFileSync(file).equals(before), true);
  });

  it("answers a missing daily with empty daily parts and still lists the focus", () => {
    const root = lab({ lab: labProject() });
    const settings = useVault(root);
    const payload = today.readToday(settings, TODAY);
    assert.equal(payload.dailyExists, false);
    assert.equal(payload.dailyUpdatedAt, null);
    assert.deepEqual([payload.meetings, payload.captures, payload.unlinked, payload.summary], [[], [], [], null]);
    assert.equal(payload.focus.length, 7);
    assert.equal(existsSync(join(root, "daily", `${TODAY}.md`)), false);
  });
});

describe("schedule and unschedule", () => {
  it("changes only the scheduled token of the exact line and gives the bytes back on unschedule", () => {
    const root = lab({
      one: "# One\n\n## Open loops\n\n- [ ] Plain task\n- [ ] Dated task #p1 \u{1F4C5} 2026-12-24\n  - [ ] Nested child\n- [ ] Other\n",
      crlf: "# Crlf\r\n\r\n## Open loops\r\n\r\n- [ ] Windows task #p2 \u{1F4C5} 2026-12-24\r\n- [ ] Other\r\n",
      bom: "\uFEFF# Bom\n\n## Open loops\n\n- [ ] Bom task\n",
    });
    const settings = useVault(root);
    const cases: [string, string, string][] = [
      ["one", "Plain task", `- [ ] Plain task ${SCHEDULED} ${TODAY}`],
      ["one", "Dated task", `- [ ] Dated task #p1 ${SCHEDULED} ${TODAY} \u{1F4C5} 2026-12-24`],
      ["one", "Nested child", `  - [ ] Nested child ${SCHEDULED} ${TODAY}`],
      ["crlf", "Windows task", `- [ ] Windows task #p2 ${SCHEDULED} ${TODAY} \u{1F4C5} 2026-12-24`],
      ["bom", "Bom task", `- [ ] Bom task ${SCHEDULED} ${TODAY}`],
    ];
    for (const [projectId, title, expected] of cases) {
      const file = join(root, "projects", `${projectId}.md`);
      const before = readFileSync(file);
      const task = taskIn(settings, projectId, title);
      const scheduled = today.todayApi.schedule(settings, { projectId, line: task.line, raw: task.raw, date: TODAY });
      assert.equal(scheduled.task.scheduled, TODAY);
      assert.equal(scheduled.task.raw, expected);
      const eol = before.includes("\r\n") ? "\r\n" : "\n";
      const split = (buffer: Buffer): string[] => buffer.toString("utf8").split(eol);
      const changed = split(before).flatMap((line, index) => (line === split(readFileSync(file))[index] ? [] : [index]));
      assert.deepEqual(changed, [task.line], `${projectId} ${title}`);
      const cleared = today.todayApi.schedule(settings, { projectId, line: task.line, raw: scheduled.task.raw, date: null });
      assert.equal(cleared.task.scheduled, null);
      assert.equal(readFileSync(file).equals(before), true, `${projectId} ${title} comes back byte for byte`);
    }
  });

  it("refuses a stale line the way the board does and leaves the file alone", () => {
    const root = lab({ one: "# One\n\n## Open loops\n\n- [ ] Plain task\n" });
    const settings = useVault(root);
    const file = join(root, "projects", "one.md");
    const before = readFileSync(file);
    const task = taskIn(settings, "one", "Plain task");
    assert.throws(() => today.todayApi.schedule(settings, { projectId: "one", line: task.line, raw: `${task.raw} edited`, date: TODAY }), (err: unknown) => err instanceof board.TaskConflictError);
    assert.throws(() => today.todayApi.schedule(settings, { projectId: "one", line: task.line, raw: task.raw, date: "2026-02-31" }), /YYYY-MM-DD/);
    assert.equal(readFileSync(file).equals(before), true);
  });

  it("shows a subtask on its own when only it is scheduled and folds it into its parent when both are", () => {
    const root = lab({ one: "# One\n\n## Open loops\n\n- [ ] Parent\n  - [ ] Child\n  - [ ] Sibling\n" });
    const settings = useVault(root);
    scheduleOf(settings, "one", "Child", TODAY);
    assert.deepEqual(today.todayApi.focusOf(settings, TODAY).map((entry) => [entry.task.title, entry.parentTitle]), [["Child", "Parent"]]);
    scheduleOf(settings, "one", "Parent", TODAY);
    const focus = today.todayApi.focusOf(settings, TODAY);
    assert.deepEqual(focus.map((entry) => [entry.task.title, entry.parentTitle]), [["Parent", null]]);
    assert.deepEqual(focus[0]?.task.subtasks.map((task) => task.title), ["Child", "Sibling"]);
  });
});

describe("mirror", () => {
  const FOCUS_BEFORE = [
    "- [ ] Remember to buy coffee",
    `- [ ] [[lab|Lab Project]] - Alpha`,
    "  - [ ] Alpha child",
    "  - a free note under alpha",
    "- Call the bank about the card",
    `- [x] [[lab|Lab Project]] - Gamma`,
  ];

  it("only inserts the missing focus tasks: subtasks under their parent, the rest after the last line of the section, never moving a line", () => {
    const root = lab({ lab: labProject() }, { [TODAY]: dailyWith(TODAY, FOCUS_BEFORE) });
    const settings = useVault(root);
    const before = read(root, `daily/${TODAY}.md`);
    const result = today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.deepEqual(result, { changed: true, skipped: null, applied: 0 });
    const after = read(root, `daily/${TODAY}.md`);
    assert.deepEqual(sectionOf(after, "Focus"), [
      "",
      "- [ ] Remember to buy coffee",
      "- [ ] [[lab|Lab Project]] - Alpha",
      "  - [ ] Alpha child",
      "  - a free note under alpha",
      "- Call the bank about the card",
      "- [x] [[lab|Lab Project]] - Gamma",
      "  - [ ] Gamma child",
      "- [ ] [[lab|Lab Project]] - Beta child",
      "- [ ] [[lab|Lab Project]] - Epsilon",
      "- [ ] [[lab|Lab Project]] - Theta",
      "- [x] [[lab|Lab Project]] - Iota",
      "- [x] [[lab|Lab Project]] - Lambda",
      "",
    ]);
    const outside = (content: string): string => content.slice(0, content.indexOf("## Focus")) + content.slice(content.indexOf("## Meetings"));
    assert.equal(outside(after), outside(before));
    const unlinked = ["- [ ] Remember to buy coffee", "- Call the bank about the card", "  - a free note under alpha"];
    assert.equal(daily.focusLinesPreserved(unlinked, unlinked.filter((line) => after.split("\n").includes(line)), [], []), true);
    assert.equal(taskIn(settings, "lab", "Gamma").status, "doing");
    const payload = today.readToday(settings, TODAY);
    assert.deepEqual(payload.unlinked, ["- [ ] Remember to buy coffee", "- Call the bank about the card"]);
    assert.deepEqual(payload.inNote, ["- [ ] Remember to buy coffee", "- Call the bank about the card"]);
  });

  it("is idempotent and writes nothing when the content is already right", () => {
    const root = lab({ lab: labProject() }, { [TODAY]: dailyWith(TODAY, FOCUS_BEFORE) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const file = join(root, "daily", `${TODAY}.md`);
    const once = readFileSync(file);
    const events: string[] = [];
    const off = sse.onBroadcast((event) => events.push(event));
    for (let round = 0; round < 3; round += 1) {
      assert.deepEqual(today.todayApi.regenerateFocusMirror(settings, TODAY), { changed: false, skipped: null, applied: 0 });
    }
    off();
    assert.equal(readFileSync(file).equals(once), true);
    assert.deepEqual(events, []);
  });

  it("applies a checkbox ticked in the daily to the project before it regenerates", () => {
    const root = lab({ lab: labProject() }, { [TODAY]: dailyWith(TODAY, ["- [ ]"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const file = join(root, "daily", `${TODAY}.md`);
    const ticked = readFileSync(file, "utf8").replace("- [ ] [[lab|Lab Project]] - Alpha", "- [x] [[lab|Lab Project]] - Alpha");
    assert.notEqual(ticked, readFileSync(file, "utf8"));
    writeFileSync(file, ticked);
    const result = today.todayApi.regenerateFocusMirror(settings, TODAY, { source: "disk" });
    assert.equal(result.applied, 1);
    assert.equal(taskIn(settings, "lab", "Alpha").status, "done");
    assert.ok(read(root, "projects/lab.md").includes(`- [x] Alpha ${SCHEDULED} ${TODAY}`));
    assert.ok(read(root, `daily/${TODAY}.md`).includes("- [x] [[lab|Lab Project]] - Alpha"));
    assert.equal(today.todayApi.regenerateFocusMirror(settings, TODAY).changed, false);
  });

  it("reflects a status written on the board in the daily through the board write hook", () => {
    const root = lab({ lab: labProject() }, { [TODAY]: dailyWith(TODAY, FOCUS_BEFORE) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const gamma = taskIn(settings, "lab", "Gamma");
    const written = board.writeBoardTaskSynced(settings, { projectId: "lab", line: gamma.line, raw: gamma.raw, status: "todo" });
    assert.equal(written.dailySynced, true);
    assert.ok(read(root, `daily/${TODAY}.md`).includes("- [ ] [[lab|Lab Project]] - Gamma"));
    const beforeRename = read(root, `daily/${TODAY}.md`);
    const epsilon = taskIn(settings, "lab", "Epsilon");
    board.writeBoardTask(settings, { projectId: "lab", line: epsilon.line, raw: epsilon.raw, title: "Epsilon renamed" });
    assert.equal(today.flushMirrors(settings), false);
    assert.equal(read(root, `daily/${TODAY}.md`), beforeRename);
    assert.equal(read(root, `daily/${TODAY}.md`).includes("Epsilon renamed"), false);
    assert.ok(today.readToday(settings, TODAY).inNote.includes("- [ ] [[lab|Lab Project]] - Epsilon"));
  });

  it("G00c: takes the block of a task out of the daily when it leaves the day or moves to another date, its scheduled subtasks moving with it", () => {
    const root = lab({ lab: labProject() }, { [TODAY]: dailyWith(TODAY, FOCUS_BEFORE) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const primed = read(root, `daily/${TODAY}.md`);
    scheduleOf(settings, "lab", "Alpha", null);
    const withoutAlpha = primed.replace("- [ ] [[lab|Lab Project]] - Alpha\n  - [ ] Alpha child\n  - a free note under alpha\n", "");
    assert.equal(read(root, `daily/${TODAY}.md`), withoutAlpha);
    scheduleOf(settings, "lab", "Gamma", shift(TODAY, 3));
    assert.equal(read(root, `daily/${TODAY}.md`), withoutAlpha.replace("- [x] [[lab|Lab Project]] - Gamma\n  - [ ] Gamma child\n", ""));
    assert.equal(taskIn(settings, "lab", "Gamma").scheduled, shift(TODAY, 3));
    assert.equal(taskIn(settings, "lab", "Gamma child").scheduled, shift(TODAY, 3));
    store.setSetting(`today.migrated.${TODAY}`, "1");
    const payload = today.readToday(settings, TODAY);
    assert.deepEqual(payload.inNote, ["- [ ] Remember to buy coffee", "- Call the bank about the card"]);
    assert.equal(payload.focus.some((entry) => entry.task.title === "Alpha" || entry.task.title === "Gamma"), false);
  });

  it("keeps a linked line of a task that was never scheduled, the way an added line has always behaved", () => {
    const root = lab({ lab: labProject() }, { [TODAY]: dailyWith(TODAY, ["- [ ] [[lab|Lab Project]] - Beta"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const focus = sectionOf(read(root, `daily/${TODAY}.md`), "Focus");
    assert.equal(focus.includes("- [ ] [[lab|Lab Project]] - Beta"), true);
    assert.equal(focus.includes("- [ ] [[lab|Lab Project]] - Alpha"), true);
  });

  it("keeps the custom text of a linked line, adopts a disagreement it did not see happen and syncs only the checkbox afterwards", () => {
    const project = `# Lab\n\n## Open loops\n\n- [-] Prepare the quarterly report ${SCHEDULED} ${TODAY}\n`;
    const root = lab({ lab: project }, { [TODAY]: dailyWith(TODAY, ["- [x] [[lab|Lab]] - Prepare the quarterly report (draft only)"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.deepEqual(sectionOf(read(root, `daily/${TODAY}.md`), "Focus"), ["", "- [x] [[lab|Lab]] - Prepare the quarterly report (draft only)", ""]);
    assert.equal(taskIn(settings, "lab", "Prepare the quarterly report").status, "doing");
    assert.equal(today.todayApi.regenerateFocusMirror(settings, TODAY).changed, false);
    const task = taskIn(settings, "lab", "Prepare the quarterly report");
    board.writeBoardTask(settings, { projectId: "lab", line: task.line, raw: task.raw, status: "todo" });
    assert.equal(today.todayApi.regenerateFocusMirror(settings, TODAY).changed, true);
    assert.deepEqual(sectionOf(read(root, `daily/${TODAY}.md`), "Focus"), ["", "- [ ] [[lab|Lab]] - Prepare the quarterly report (draft only)", ""]);
    assert.equal(today.todayApi.regenerateFocusMirror(settings, TODAY).changed, false);
  });

  it("G00c: inserts nothing for two tasks that share a title, keeps them out of the focus and reports them as ambiguous", () => {
    const root = lab(
      { lab: `# Lab\n\n## Open loops\n\n- [ ] Same title ${SCHEDULED} ${TODAY}\n- [ ] Same title ${SCHEDULED} ${TODAY}\n` },
      { [TODAY]: dailyWith(TODAY, ["- [ ]"]) },
    );
    const settings = useVault(root);
    const file = join(root, "daily", `${TODAY}.md`);
    const before = readFileSync(file);
    for (let round = 0; round < 3; round += 1) today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(readFileSync(file).equals(before), true);
    store.setSetting(`today.migrated.${TODAY}`, "1");
    const payload = today.readToday(settings, TODAY);
    assert.equal(payload.focus.length, 0);
    assert.deepEqual(
      payload.ambiguous.map((item) => [item.kind, item.text, item.reason]),
      [
        ["task", "Lab - Same title", "same-title"],
        ["task", "Lab - Same title", "same-title"],
      ],
    );
  });

  it("keeps CRLF endings and the BOM of the daily", () => {
    const crlf = `\uFEFF${dailyWith(TODAY, ["- [ ] free line one", "- [ ] free line two"]).replace(/\n/g, "\r\n")}`;
    const root = lab({ lab: labProject() }, { [TODAY]: crlf });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const bytes = readFileSync(join(root, "daily", `${TODAY}.md`));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    assert.equal(text.replace(/\r\n/g, "").includes("\n"), false);
    assert.equal(text.includes("- [ ] [[lab|Lab Project]] - Alpha\r\n"), true);
    assert.equal(text.includes("- [ ] free line two\r\n"), true);
  });

  it("G00c: never adds a focus heading to a daily that has none and leaves a daily without focus tasks alone", () => {
    const bare = "# Day\n\n## Meetings\n\n- 10:00 Standup\n";
    const root = lab({ lab: labProject() }, { [TODAY]: bare });
    const settings = useVault(root);
    assert.deepEqual(today.todayApi.regenerateFocusMirror(settings, TODAY), { changed: false, skipped: "unsettled", applied: 0 });
    assert.equal(read(root, `daily/${TODAY}.md`), bare);
    const quiet = lab({ lab: "# Lab\n\n## Open loops\n\n- [ ] Unscheduled\n" }, { [TODAY]: dailyWith(TODAY, ["- [ ]"]) });
    const quietSettings = useVault(quiet);
    const file = join(quiet, "daily", `${TODAY}.md`);
    const quietBefore = readFileSync(file);
    assert.deepEqual(today.todayApi.regenerateFocusMirror(quietSettings, TODAY), { changed: false, skipped: null, applied: 0 });
    assert.equal(readFileSync(file).equals(quietBefore), true);
  });

  it("keeps a recurring task completed today as one done line and advances the original", () => {
    const project = `# Lab\n\n## Open loops\n\n- [ ] Theta ${REPEAT} every day ${SCHEDULED} ${TODAY}\n\n## Done loops\n\n-\n`;
    const root = lab({ lab: project }, { [TODAY]: dailyWith(TODAY, ["- [ ]"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.deepEqual(sectionOf(read(root, `daily/${TODAY}.md`), "Focus"), ["", "- [ ]", "- [ ] [[lab|Lab]] - Theta", ""]);
    const theta = taskIn(settings, "lab", "Theta");
    const result = board.writeBoardTask(settings, { projectId: "lab", line: theta.line, raw: theta.raw, status: "done" });
    assert.equal(result.recurred, true);
    const projectText = read(root, "projects/lab.md");
    assert.ok(projectText.includes(`- [ ] Theta ${REPEAT} every day ${SCHEDULED} ${TOMORROW}`));
    assert.ok(projectText.includes(`- [x] Theta ${REPEAT} every day ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`));
    const focus = today.todayApi.focusOf(settings, TODAY);
    assert.deepEqual(focus.map((entry) => [entry.task.title, entry.task.status, entry.task.doneAt]), [["Theta", "done", TODAY]]);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const lines = sectionOf(read(root, `daily/${TODAY}.md`), "Focus").filter((line) => line.includes("Theta"));
    assert.deepEqual(lines, ["- [x] [[lab|Lab]] - Theta"]);
    assert.equal(today.todayApi.regenerateFocusMirror(settings, TODAY).changed, false);
    assert.equal(today.todayApi.carriedOver(settings, TOMORROW).length, 0);
  });

  it("never rewrites a past daily and refuses to migrate it", () => {
    const content = dailyWith(PAST, ["- [ ] [[lab|Lab Project]] - Alpha", "- [ ] a line"]);
    const root = lab({ lab: labProject() }, { [PAST]: content });
    const settings = useVault(root);
    const file = join(root, "daily", `${PAST}.md`);
    const before = readFileSync(file);
    assert.deepEqual(today.todayApi.regenerateFocusMirror(settings, PAST), { changed: false, skipped: "past", applied: 0 });
    assert.throws(() => today.todayApi.migrateFocus(settings, PAST), /past dailies/);
    scheduleOf(settings, "lab", "Delta", PAST);
    today.queueDailyDiskChange(PAST);
    assert.equal(today.flushMirrors(settings), false);
    assert.equal(readFileSync(file).equals(before), true);
    assert.equal(today.readToday(settings, PAST).focus.length, 1);
  });
});

describe("migration", () => {
  const PROJECT = [
    "# Lab",
    "",
    "## Open loops",
    "",
    "- [ ] Mig one",
    `- [ ] Mig two ${SCHEDULED} ${TOMORROW}`,
    "- [ ] Mig three",
    "  - [ ] Mig three child",
    "- [ ] Mig four",
    "",
  ].join("\n");
  const DAILY_FOCUS = ["- [ ] [[lab|Lab]] - Mig one", "- [ ] [[lab|Lab]] - Mig two", "- [ ] [[lab|Lab]] - Mig three", "  - [ ] Mig three child", "- [ ] Free line", "- Loose bullet"];

  it("G00c: schedules the linked tasks only, moves an open task of another date to the day of its line and leaves unlinked lines and other tasks alone", () => {
    const root = lab({ lab: PROJECT }, { [TODAY]: dailyWith(TODAY, DAILY_FOCUS) });
    const settings = useVault(root);
    const result = today.todayApi.migrateFocus(settings, TODAY);
    assert.deepEqual([result.scheduled, result.synced, result.failed], [3, 0, []]);
    assert.deepEqual(result.skipped, []);
    const lines = read(root, "projects/lab.md").split("\n");
    assert.equal(lines.includes(`- [ ] Mig one ${SCHEDULED} ${TODAY}`), true);
    assert.equal(lines.includes(`- [ ] Mig two ${SCHEDULED} ${TODAY}`), true);
    assert.equal(lines.includes(`- [ ] Mig three ${SCHEDULED} ${TODAY}`), true);
    assert.equal(lines.includes("  - [ ] Mig three child"), true);
    assert.equal(lines.includes("- [ ] Mig four"), true);
    const focus = sectionOf(read(root, `daily/${TODAY}.md`), "Focus");
    assert.equal(focus.includes("- [ ] Free line"), true);
    assert.equal(focus.includes("- Loose bullet"), true);
    assert.equal(focus.includes("- [ ] [[lab|Lab]] - Mig one"), true);
    assert.equal(focus.includes("  - [ ] Mig three child"), true);
    assert.equal(focus.some((line) => line.includes("Mig four")), false);
  });

  it("is idempotent: a second run changes neither the projects nor the daily", () => {
    const root = lab({ lab: PROJECT }, { [TODAY]: dailyWith(TODAY, DAILY_FOCUS) });
    const settings = useVault(root);
    today.todayApi.migrateFocus(settings, TODAY);
    const files = [join(root, "projects", "lab.md"), join(root, "daily", `${TODAY}.md`)];
    const digest = digestOf(...files);
    const again = today.todayApi.migrateFocus(settings, TODAY);
    assert.equal(again.scheduled, 0);
    assert.equal(digestOf(...files), digest);
  });

  it("adopts the daily as it is: a checkbox that disagrees with the project moves neither side, and the next explicit tick does", () => {
    const project = "# Lab\n\n## Open loops\n\n- [ ] Ticked in the daily\n- [-] Started in the project\n\n## Done loops\n\n-\n";
    const focus = ["- [x] [[lab|Lab]] - Ticked in the daily", "- [ ] [[lab|Lab]] - Started in the project"];
    const root = lab({ lab: project }, { [TODAY]: dailyWith(TODAY, focus) });
    const settings = useVault(root);
    const file = join(root, "daily", `${TODAY}.md`);
    const before = readFileSync(file);
    const result = today.todayApi.migrateFocus(settings, TODAY);
    assert.deepEqual([result.scheduled, result.synced, result.failed, result.ambiguous], [2, 0, [], []]);
    assert.equal(taskIn(settings, "lab", "Ticked in the daily").status, "todo");
    assert.equal(taskIn(settings, "lab", "Started in the project").status, "doing");
    const text = read(root, "projects/lab.md");
    assert.ok(text.includes(`- [ ] Ticked in the daily ${SCHEDULED} ${TODAY}`));
    assert.ok(text.includes(`- [-] Started in the project ${SCHEDULED} ${TODAY}`));
    assert.equal(readFileSync(file).equals(before), true);
    writeFileSync(file, readFileSync(file, "utf8").replace("- [ ] [[lab|Lab]] - Started in the project", "- [x] [[lab|Lab]] - Started in the project"));
    assert.equal(today.todayApi.regenerateFocusMirror(settings, TODAY, { source: "disk" }).applied, 1);
    assert.equal(taskIn(settings, "lab", "Started in the project").status, "done");
    assert.equal(taskIn(settings, "lab", "Ticked in the daily").status, "todo");
  });

  it("G00c: runs on its own the first time the day is read, once per date, and never when the source is list; the focus follows the lines", () => {
    const root = lab({ lab: PROJECT }, { [TODAY]: dailyWith(TODAY, DAILY_FOCUS) });
    const settings = useVault(root);
    const first = today.readToday(settings, TODAY);
    assert.deepEqual(first.focus.map((entry) => entry.task.title), ["Mig one", "Mig two", "Mig three"]);
    assert.equal(taskIn(settings, "lab", "Mig two").scheduled, TODAY);
    assert.equal(store.getSetting(`today.migrated.${TODAY}`), "1");
    const file = join(root, "projects", "lab.md");
    const afterFirst = readFileSync(file);
    write(root, "projects/lab.md", read(root, "projects/lab.md").replace(` ${SCHEDULED} ${TODAY}`, ""));
    today.readToday(settings, TODAY);
    assert.equal(readFileSync(file, "utf8").includes(`Mig one ${SCHEDULED}`), false);
    assert.notEqual(afterFirst.toString("utf8"), readFileSync(file, "utf8"));
    const listRoot = lab({ lab: PROJECT }, { [TODAY]: dailyWith(TODAY, DAILY_FOCUS) });
    const listSettings = useVault(listRoot, "list");
    const payload = today.readToday(listSettings, TODAY);
    assert.equal(payload.focusSource, "list");
    assert.deepEqual(payload.focus.map((entry) => entry.task.title), ["Mig one", "Mig two", "Mig three"]);
    assert.deepEqual(payload.carriedOver, []);
    assert.equal(read(listRoot, "projects/lab.md").includes(SCHEDULED + " " + TODAY), false);
  });
});

describe("captures, meetings and promote", () => {
  it("appends a capture below the existing ones, replaces the empty placeholder and never deletes a line", () => {
    const withCaptures = dailyWith(TODAY, ["- [ ]"], { captures: ["- first idea", "- second idea"] });
    const root = lab({ lab: labProject() }, { [TODAY]: withCaptures, [TOMORROW]: dailyWith(TOMORROW, ["- [ ]"]) });
    const settings = useVault(root);
    const captures = today.todayApi.appendCapture(settings, TODAY, "third idea");
    assert.deepEqual(captures.map((capture) => capture.text), ["first idea", "second idea", "third idea"]);
    assert.deepEqual(sectionOf(read(root, `daily/${TODAY}.md`), "Captures"), ["", "- first idea", "- second idea", "- third idea", ""]);
    const placeholder = today.todayApi.appendCapture(settings, TOMORROW, "only idea");
    assert.deepEqual(placeholder.map((capture) => capture.text), ["only idea"]);
    assert.deepEqual(sectionOf(read(root, `daily/${TOMORROW}.md`), "Captures"), ["", "- only idea", ""]);
    assert.throws(() => today.todayApi.appendCapture(settings, TODAY, "two\nlines"), /single non-empty line/);
    assert.throws(() => today.todayApi.appendCapture(settings, TODAY, "   "), /single non-empty line/);
  });

  it("creates the daily from the template when it is missing, using the heading the template names", () => {
    const template = TEMPLATE.replace("## Captures", "## Capturas do dia");
    const root = lab({ lab: labProject() }, {}, template);
    const settings = useVault(root);
    assert.equal(existsSync(join(root, "daily", `${TOMORROW}.md`)), false);
    const captures = today.todayApi.appendCapture(settings, TOMORROW, "from anywhere");
    assert.deepEqual(captures.map((capture) => capture.text), ["from anywhere"]);
    const created = read(root, `daily/${TOMORROW}.md`);
    assert.ok(created.startsWith(`---\ntype: daily\ncreated: ${TOMORROW}\n---\n\n# ${TOMORROW}\n`));
    assert.deepEqual(sectionOf(created, "Capturas do dia"), ["", "- from anywhere", ""]);
    const named = store.updateSettings({ daily: { headings: { captures: "Inbox" } } });
    today.todayApi.appendCapture(named, TOMORROW, "to the inbox");
    assert.deepEqual(sectionOf(read(root, `daily/${TOMORROW}.md`), "Inbox"), ["- to the inbox", ""]);
    store.updateSettings({ daily: { headings: { captures: "" } } });
  });

  it("appends a meeting like a capture", () => {
    const root = lab({ lab: labProject() }, { [TODAY]: dailyWith(TODAY, ["- [ ]"], { meetings: ["- 09:00 Standup"] }), [TOMORROW]: dailyWith(TOMORROW, ["- [ ]"]) });
    const settings = useVault(root);
    assert.deepEqual(today.todayApi.appendMeeting(settings, TODAY, "15:00 Review"), ["09:00 Standup", "15:00 Review"]);
    assert.deepEqual(today.todayApi.appendMeeting(settings, TOMORROW, "10:00 Kickoff"), ["10:00 Kickoff"]);
    assert.deepEqual(sectionOf(read(root, `daily/${TOMORROW}.md`), "Meetings"), ["", "- 10:00 Kickoff", ""]);
  });

  it("promotes a capture to a task of the chosen project, scheduled when asked, and keeps the capture line", () => {
    const root = lab({ lab: "# Lab\n\n## Open loops\n\n- [ ] Existing\n\n## Done loops\n\n-\n" }, { [TODAY]: dailyWith(TODAY, ["- [ ]"], { captures: ["- write the report", "- keep this one"] }) });
    const settings = useVault(root);
    const [first] = today.todayApi.appendCapture(settings, TODAY, "buy a new chair");
    assert.ok(first);
    const captures = today.readToday(settings, TODAY).captures;
    const target = captures[0] as { line: number; raw: string };
    const promoted = today.todayApi.promoteCapture(settings, TODAY, { line: target.line, raw: target.raw, projectId: "lab", schedule: true });
    assert.equal(promoted.task.title, "write the report");
    assert.equal(promoted.task.scheduled, TODAY);
    assert.equal(promoted.task.status, "todo");
    assert.ok(read(root, "projects/lab.md").includes(`- [ ] Existing\n- [ ] write the report ${SCHEDULED} ${TODAY}\n`));
    const after = read(root, `daily/${TODAY}.md`);
    assert.deepEqual(sectionOf(after, "Captures"), ["", "- write the report → [[lab]]", "- keep this one", "- buy a new chair", ""]);
    assert.ok(sectionOf(after, "Focus").includes("- [ ] [[lab|Lab]] - write the report"));
    const refreshed = today.readToday(settings, TODAY).captures;
    assert.deepEqual(refreshed.map((capture) => [capture.text, capture.promotedTo]), [
      ["write the report", "lab"],
      ["keep this one", null],
      ["buy a new chair", null],
    ]);
    const promotedLine = refreshed[0] as { line: number; raw: string };
    assert.equal(promotedLine.raw, `${target.raw} → [[lab]]`);
    assert.throws(() => today.todayApi.promoteCapture(settings, TODAY, { line: promotedLine.line, raw: promotedLine.raw, projectId: "lab" }), /already promoted/);
    const second = refreshed[1] as { line: number; raw: string };
    assert.throws(() => today.todayApi.promoteCapture(settings, TODAY, { line: second.line, raw: "- something else", projectId: "lab" }), (err: unknown) => err instanceof today.StaleCaptureError);
    const plain = today.todayApi.promoteCapture(settings, TODAY, { line: second.line, raw: second.raw, projectId: "lab" });
    assert.equal(plain.task.scheduled, null);
    assert.throws(() => today.todayApi.promoteCapture(settings, TODAY, { line: 0, raw: "---", projectId: "lab" }), /captures section/);
    const third = refreshed[2] as { line: number; raw: string };
    assert.throws(() => today.todayApi.promoteCapture(settings, TODAY, { line: third.line, raw: third.raw, projectId: "missing" }), /project not found/);
  });
});

describe("focusSource list", () => {
  it("leaves the daily and the old sync alone", () => {
    const focus = ["- [ ] [[lab|Lab Project]] - Beta", "- [ ] a free line", "- [ ] [[lab|Lab Project]] - Alpha"];
    const root = lab({ lab: labProject() }, { [TODAY]: dailyWith(TODAY, focus) });
    const settings = useVault(root, "list");
    const file = join(root, "daily", `${TODAY}.md`);
    const before = readFileSync(file);
    assert.deepEqual(today.todayApi.regenerateFocusMirror(settings, TODAY), { changed: false, skipped: "list", applied: 0 });
    today.queueDailyDiskChange(TODAY);
    assert.equal(today.flushMirrors(settings), false);
    const beta = taskIn(settings, "lab", "Beta");
    const written = board.writeBoardTaskSynced(settings, { projectId: "lab", line: beta.line, raw: beta.raw, status: "done" });
    assert.equal(written.dailySynced, true);
    const after = read(root, `daily/${TODAY}.md`).split("\n");
    const original = before.toString("utf8").split("\n");
    assert.deepEqual(after.flatMap((line, index) => (line === original[index] ? [] : [index])), [original.indexOf(focus[0] as string)]);
    assert.equal(after[original.indexOf(focus[0] as string)], "- [x] [[lab|Lab Project]] - Beta");
    assert.equal(today.flushMirrors(settings), false);
  });
});

describe("loop protection", () => {
  it("writes the daily at most once for a disk change and stays quiet afterwards", () => {
    const root = lab({ lab: labProject() }, { [TODAY]: dailyWith(TODAY, ["- [ ] [[lab|Lab Project]] - Alpha", "- [ ] one free line"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const file = join(root, "daily", `${TODAY}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replace("## Focus\n\n", "## Focus\n\n- [ ] typed in Obsidian\n"));
    write(root, "projects/lab.md", read(root, "projects/lab.md").replace(`- [ ] Eta ${SCHEDULED} ${TOMORROW}`, `- [ ] Eta ${SCHEDULED} ${TODAY}`));
    const events: { event: string; data: unknown }[] = [];
    const off = sse.onBroadcast((event, data) => events.push({ event, data }));
    today.queueDailyDiskChange(TODAY);
    today.queueDailyDiskChange(TODAY);
    assert.equal(today.flushMirrors(settings), true);
    const written = events.filter((entry) => entry.event === "daily");
    assert.equal(written.length, 1);
    assert.match(String((written[0]?.data as { writeId: string }).writeId), /^mirror-/);
    const content = readFileSync(file, "utf8");
    assert.ok(content.includes("## Focus\n\n- [ ] typed in Obsidian\n- [ ] [[lab|Lab Project]] - Alpha\n"));
    assert.ok(content.includes("- [ ] [[lab|Lab Project]] - Eta"));
    today.queueDailyDiskChange(TODAY);
    today.queueDailyDiskChange(TODAY);
    assert.equal(today.flushMirrors(settings), false);
    assert.equal(events.filter((entry) => entry.event === "daily").length, 1);
    off();
    assert.equal(readFileSync(file, "utf8"), content);
  });

  it("G00c: stays inert on a daily the hub wrote without any scheduled task, so the old add-to-daily flow keeps its behaviour", () => {
    const project = "# Lab\n\n## Open loops\n\n- [ ] Plain linked task\n";
    const root = lab({ lab: project });
    const settings = useVault(root);
    daily.writeDaily(settings, TODAY, dailyWith(TODAY, ["- [ ] [[lab|Lab]] - Plain linked task"]));
    const files = [join(root, "projects", "lab.md"), join(root, "daily", `${TODAY}.md`)];
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const write = (mark: string): void => writeFileSync(files[1] as string, readFileSync(files[1] as string, "utf8").replace(/- \[.\] \[\[lab\|Lab\]\]/, `- [${mark}] [[lab|Lab]]`));
    write("x");
    const digest = digestOf(...files);
    today.queueDailyDiskChange(TODAY);
    assert.equal(today.flushMirrors(settings), false);
    assert.equal(digestOf(...files), digest);
    assert.equal(taskIn(settings, "lab", "Plain linked task").status, "todo");
    assert.deepEqual(today.todayApi.regenerateFocusMirror(settings, TODAY), { changed: false, skipped: null, applied: 0 });
  });

  it("does not echo through the real watchers: one hub write per outside edit", async () => {
    const root = lab({ lab: labProject() }, { [TODAY]: dailyWith(TODAY, ["- [ ] [[lab|Lab Project]] - Alpha"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const file = join(root, "daily", `${TODAY}.md`);
    const events: { event: string; data: { source?: string; writeId?: string | null } }[] = [];
    const off = sse.onBroadcast((event, data) => events.push({ event, data: data as { source?: string; writeId?: string | null } }));
    daily.watchDaily(settings);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      write(root, "projects/lab.md", read(root, "projects/lab.md").replace(`- [ ] Eta ${SCHEDULED} ${TOMORROW}`, `- [ ] Eta ${SCHEDULED} ${TODAY}`));
      writeFileSync(file, readFileSync(file, "utf8").replace("## Focus\n\n", "## Focus\n\n- [ ] a line typed outside\n"));
      const mirrored = () => events.filter((entry) => entry.event === "daily" && entry.data.source === "hub" && String(entry.data.writeId).startsWith("mirror-"));
      await waitFor(async () => (mirrored().length >= 1 ? true : null), 8000);
      await new Promise((resolve) => setTimeout(resolve, 2600));
      assert.equal(mirrored().length, 1);
      assert.equal(events.filter((entry) => entry.event === "daily" && entry.data.source === "disk").length, 1);
      assert.ok(readFileSync(file, "utf8").includes("- [ ] a line typed outside"));
    } finally {
      off();
      daily.stopDailyWatch();
    }
  });
});

describe("today routes", () => {
  const box: Sandbox = makeSandbox("cch-today-http-");
  let hub: RunningServer;

  async function http(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  before(async () => {
    write(box.brain, "_templates/daily.md", TEMPLATE);
    write(box.brain, "projects/lab.md", "# Lab Project\n\n## Open loops\n\n- [ ] Route task\n- [ ] Other task\n\n## Done loops\n\n-\n");
    hub = await startServer(box, { HUB_DELEGATION: "1", HUB_SHARE_PORT: String(await freePort()) });
    const saved = await http("PUT", "/delegation/settings", {
      secondBrainRoot: box.brain,
      features: { daily: true, tasks: true },
      tasks: { root: "projects", doneSection: "Done loops" },
      daily: { dir: "daily", template: "_templates/daily.md", wikilinks: true },
    });
    assert.equal(saved.status, 200);
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("validates and stores the daily settings", async () => {
    assert.equal((await http("PUT", "/delegation/settings", { daily: { focusSource: "bogus" } })).status, 400);
    assert.equal((await http("PUT", "/delegation/settings", { daily: { headings: { captures: "a\nb" } } })).status, 400);
    const saved = await http("PUT", "/delegation/settings", { daily: { focusSource: "scheduled", headings: { captures: "Inbox" } } });
    assert.equal(saved.status, 200);
    const daily = (saved.json as { daily: { focusSource?: string; headings: { captures?: string } } }).daily;
    assert.equal(daily.focusSource, "scheduled");
    assert.equal(daily.headings.captures, "Inbox");
    assert.equal((await http("PUT", "/delegation/settings", { daily: { headings: { captures: "" } } })).status, 200);
  });

  it("serves the day, schedules, captures, promotes and migrates", async () => {
    assert.equal((await http("GET", "/delegation/today/not-a-date")).status, 400);
    const empty = await http("GET", `/delegation/today/${TODAY}`);
    assert.equal(empty.status, 200);
    assert.deepEqual(Object.keys(empty.json).sort(), ["ambiguous", "captures", "carriedOver", "dailyExists", "dailyUpdatedAt", "date", "focus", "focusSource", "inNote", "inNoteLinks", "meetings", "summary", "unlinked"]);
    assert.equal(empty.json.dailyExists, false);
    assert.equal(empty.json.focusSource, "scheduled");
    assert.deepEqual((await http("POST", `/delegation/today/${TODAY}/create`)).json, { dailyExists: true });
    assert.equal((await http("GET", `/delegation/today/${TODAY}`)).json.dailyExists, true);
    const board = (await http("GET", "/delegation/tasks-board")).json.tasks as BoardTask[];
    const route = board.find((task) => task.title === "Route task") as BoardTask;
    const scheduled = await http("POST", `/delegation/today/${TODAY}/schedule`, { projectId: route.projectId, line: route.line, raw: route.raw, date: TODAY });
    assert.equal(scheduled.status, 200);
    assert.equal((scheduled.json.task as BoardTask).scheduled, TODAY);
    const stale = await http("POST", `/delegation/today/${TODAY}/schedule`, { projectId: route.projectId, line: route.line, raw: route.raw, date: null });
    assert.equal(stale.status, 409);
    assert.equal(read(box.brain, `daily/${TODAY}.md`).includes("- [ ] [[lab|Lab Project]] - Route task"), true);
    const day = (await http("GET", `/delegation/today/${TODAY}`)).json as { focus: { task: BoardTask; project: { id: string } }[] };
    assert.deepEqual(day.focus.map((entry) => entry.task.title), ["Route task"]);
    const capture = await http("POST", `/delegation/today/${TODAY}/capture`, { text: "an idea from the palette" });
    assert.equal(capture.status, 200);
    const captures = capture.json.captures as { line: number; raw: string; text: string; promotedTo: string | null }[];
    assert.deepEqual(captures.map((entry) => entry.text), ["an idea from the palette"]);
    const promoted = await http("POST", `/delegation/today/${TODAY}/promote`, { line: captures[0]?.line, raw: captures[0]?.raw, projectId: "lab", schedule: true });
    assert.equal(promoted.status, 200);
    assert.equal((promoted.json.task as BoardTask).title, "an idea from the palette");
    assert.equal((await http("POST", `/delegation/today/${TODAY}/promote`, { line: captures[0]?.line, raw: captures[0]?.raw, projectId: "lab" })).status, 409);
    assert.equal((await http("POST", `/delegation/today/${TODAY}/capture`, { text: 12 })).status, 400);
    assert.deepEqual((await http("POST", `/delegation/today/${TODAY}/meeting`, { text: "09:30 Planning" })).json, { meetings: ["09:30 Planning"] });
    const migrated = await http("POST", `/delegation/today/${TODAY}/migrate`);
    assert.equal(migrated.status, 200);
    assert.equal(migrated.json.scheduled, 0);
    assert.equal((await http("POST", `/delegation/today/${PAST}/migrate`)).status, 400);
    assert.equal((await http("POST", `/delegation/today/${TODAY}/schedule`, { projectId: "lab", line: -1, raw: "x", date: TODAY })).status, 400);
  });

  it("H2: ticks a line of yesterday and refuses other days, bad bodies and stale lines", async () => {
    write(box.brain, `daily/${YESTERDAY}.md`, dailyWith(YESTERDAY, ["- [ ] [[lab|Lab Project]] - Other task"]));
    const other = flatten((await http("GET", "/delegation/tasks-board")).json.tasks as BoardTask[]).find((task) => task.title === "Other task") as BoardTask;
    const body = { projectId: other.projectId, line: other.line, raw: other.raw, status: "done" };
    assert.equal((await http("POST", `/delegation/today/${YESTERDAY}/tick`, { ...body, status: "closed" })).status, 400);
    assert.equal((await http("POST", `/delegation/today/${YESTERDAY}/tick`, { ...body, line: -1 })).status, 400);
    assert.equal((await http("POST", `/delegation/today/${TODAY}/tick`, body)).status, 400);
    assert.equal((await http("POST", `/delegation/today/${YESTERDAY}/tick`, { ...body, raw: "- [ ] stale" })).status, 409);
    const ticked = await http("POST", `/delegation/today/${YESTERDAY}/tick`, body);
    assert.equal(ticked.status, 200);
    assert.equal((ticked.json.task as BoardTask).doneAt, YESTERDAY);
    assert.ok(read(box.brain, `daily/${YESTERDAY}.md`).includes("- [x] [[lab|Lab Project]] - Other task"));
  });
});

describe("note blocks", () => {
  const NOTE_FOCUS = ["- [ ] [[lab|Lab]] - Unscheduled task", "  - a note under it", "- [ ] [[lab|Lab]] - Write the **spec** for _v2_", "- [ ] free"];
  const NOTE_PROJECT = "# Lab\n\n## Open loops\n\n- [ ] Unscheduled task\n";

  it("G00c: describes each block outside the focus with its line index, labelled project and body text, the labelled linked line being in the focus", () => {
    const root = lab({ lab: NOTE_PROJECT }, { [TODAY]: dailyWith(TODAY, NOTE_FOCUS) });
    const settings = useVault(root);
    store.setSetting(`today.migrated.${TODAY}`, "1");
    const lines = read(root, `daily/${TODAY}.md`).split(/\r\n|\n/);
    const payload = today.readToday(settings, TODAY);
    assert.deepEqual(payload.noteBlocks, [
      { line: NOTE_FOCUS[2], lineIndex: lines.indexOf(NOTE_FOCUS[2] as string), taskId: null, projectId: "lab", text: "Write the **spec** for _v2_", children: [] },
      { line: NOTE_FOCUS[3], lineIndex: lines.indexOf(NOTE_FOCUS[3] as string), taskId: null, projectId: null, text: "free", children: [] },
    ]);
    assert.deepEqual(payload.inNote, NOTE_FOCUS.slice(2));
    assert.deepEqual(payload.focus.map((entry) => entry.task.title), ["Unscheduled task"]);
  });

  it("leaves noteBlocks out when nothing in the note is outside the focus", () => {
    const root = lab({ lab: NOTE_PROJECT }, { [TODAY]: dailyWith(TODAY, ["- [ ]"]) });
    const settings = useVault(root);
    store.setSetting(`today.migrated.${TODAY}`, "1");
    assert.equal("noteBlocks" in today.readToday(settings, TODAY), false);
  });

  it("G00c: a task created from a block with its text in its labelled project, scheduled for the day, links that same line and adds only one project line, the labelled linked line getting the date of the day", () => {
    const root = lab({ lab: NOTE_PROJECT }, { [TODAY]: dailyWith(TODAY, NOTE_FOCUS) });
    const settings = useVault(root);
    store.setSetting(`today.migrated.${TODAY}`, "1");
    const dailyFile = join(root, "daily", `${TODAY}.md`);
    const dailyBefore = readFileSync(dailyFile);
    const projectBefore = read(root, "projects/lab.md").split("\n");
    const block = today.readToday(settings, TODAY).noteBlocks?.find((item) => item.line === NOTE_FOCUS[2]);
    assert.ok(block && block.projectId !== null && block.text !== null);
    board.createBoardTask(settings, { projectId: block.projectId, title: block.text, scheduled: TODAY });
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const projectAfter = read(root, "projects/lab.md").split("\n");
    assert.deepEqual(projectAfter.filter((line) => !projectBefore.includes(line)), [`- [ ] Unscheduled task ${SCHEDULED} ${TODAY}`, `- [ ] Write the **spec** for _v2_ ${SCHEDULED} ${TODAY}`]);
    assert.equal(projectAfter.length, projectBefore.length + 1);
    assert.equal(readFileSync(dailyFile).equals(dailyBefore), true);
    const payload = today.readToday(settings, TODAY);
    assert.deepEqual(payload.focus.map((entry) => entry.task.title), ["Unscheduled task", "Write the **spec** for _v2_"]);
    assert.equal(payload.noteBlocks?.some((item) => item.line === NOTE_FOCUS[2]), false);
    assert.equal(payload.unlinked.includes(NOTE_FOCUS[2] as string), false);
    assert.equal(readFileSync(dailyFile).equals(dailyBefore), true);
  });
});
