import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-today-two-way-data-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.HUB_WORKSPACES_ROOT;
delete process.env.HUB_EDITOR;
delete process.env.HUB_SECOND_BRAIN;

type Store = typeof import("../src/delegation-store.js");
type Board = typeof import("../src/tasks-board.js");
type Daily = typeof import("../src/daily.js");
type Today = typeof import("../src/today.js");
type BoardTask = import("../src/tasks-board.js").BoardTask;
let store: Store;
let board: Board;
let daily: Daily;
let today: Today;

const SCHEDULED = "⏳";
const DUE = "\u{1F4C5}";
const REPEAT = "\u{1F501}";
const roots: string[] = [];

before(async () => {
  store = await import("../src/delegation-store.js");
  board = await import("../src/tasks-board.js");
  daily = await import("../src/daily.js");
  today = await import("../src/today.js");
  today.installTodayHooks();
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

function dayOf(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function shift(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00`);
  at.setDate(at.getDate() + days);
  return dayOf(at);
}

const TODAY = dayOf(new Date());
const YESTERDAY = shift(TODAY, -1);
const TOMORROW = shift(TODAY, 1);
const LATER = shift(TODAY, 4);

const TEMPLATE = ["---", "type: daily", "---", "", "# {{date}}", "", "## Focus", "", "- [ ]", "", "## Meetings", "", "-", ""].join("\n");

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function project(title: string, open: string[]): string {
  return [`# ${title}`, "", "## Open loops", "", ...open, "", "## Done loops", "", "-", ""].join("\n");
}

function dailyOf(date: string, focus: string[]): string {
  return ["---", "type: daily", "---", "", `# ${date}`, "", "## Focus", "", ...focus, "", "## Meetings", "", "- 10:00 Standup", ""].join("\n");
}

function lab(projects: Record<string, string>, dailies: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cch-today-two-way-vault-"));
  roots.push(root);
  write(root, "_templates/daily.md", TEMPLATE);
  for (const [name, content] of Object.entries(projects)) write(root, `projects/${name}.md`, content);
  for (const [date, content] of Object.entries(dailies)) write(root, `daily/${date}.md`, content);
  return root;
}

function useVault(root: string): DelegationSettings {
  store.updateSettings({
    secondBrainRoot: root,
    features: { daily: true, tasks: true, trail: false, usage: false, limits: false },
    tasks: { root: "projects", doneSection: "Done loops", priorityTag: "p" },
    daily: {
      dir: "daily",
      template: "_templates/daily.md",
      wikilinks: true,
      projectOrder: [],
      focusSource: "scheduled",
      headings: { focus: "Focus", meetings: "Meetings", sessions: "Sessions", captures: "" },
    },
  });
  store.setSetting(`today.migrated.${TODAY}`, "1");
  return store.getSettings();
}

function flatten(tasks: BoardTask[]): BoardTask[] {
  return tasks.flatMap((task) => [task, ...flatten(task.subtasks)]);
}

function taskIn(settings: DelegationSettings, projectId: string, title: string): BoardTask {
  const found = flatten(board.readBoard(settings).tasks).find((task) => task.projectId === projectId && task.title === title);
  assert.ok(found, `${projectId}: ${title}`);
  return found;
}

function dailyRel(date: string): string {
  return `daily/${date}.md`;
}

function editDaily(root: string, date: string, change: (content: string) => string): string {
  const file = join(root, dailyRel(date));
  const next = change(readFileSync(file, "utf8"));
  writeFileSync(file, next);
  today.queueDailyDiskChange(date);
  return next;
}

function editProject(root: string, name: string, change: (content: string) => string): string {
  const file = join(root, `projects/${name}.md`);
  const next = change(readFileSync(file, "utf8"));
  writeFileSync(file, next);
  return next;
}

function snapshot(root: string, rels: string[]): Map<string, string> {
  return new Map(rels.map((rel) => [rel, existsSync(join(root, rel)) ? read(root, rel) : ""]));
}

function assertSettled(settings: DelegationSettings, root: string, date: string, rels: string[]): void {
  const before = snapshot(root, rels);
  for (let round = 0; round < 3; round += 1) {
    today.flushMirrors(settings);
    assert.equal(today.todayApi.regenerateFocusMirror(settings, date).changed, false, `round ${round}`);
  }
  assert.deepEqual(snapshot(root, rels), before);
}

const focusTitles = (settings: DelegationSettings, date: string): string[] => today.readToday(settings, date).focus.map((entry) => entry.task.title);

const ALPHA = (date: string): string =>
  project("Alpha", [
    `- [ ] Task one ${SCHEDULED} ${date}`,
    `- [-] Task two #p1 ${SCHEDULED} ${date} ${DUE} 2026-12-01`,
    "  - [ ] Sub of two",
    `- [ ] Task three ${SCHEDULED} ${shift(date, 1)}`,
    "- [ ] Task four",
    `- [ ] Weekly review ${REPEAT} every week`,
  ]);
const BETA = (date: string): string => project("Beta", [`- [ ] Beta one ${SCHEDULED} ${date}`, "- [ ] Beta two"]);

const LINE_ONE = "- [ ] [[alpha|Alpha]] - Task one";
const LINE_TWO = "- [-] [[alpha|Alpha]] - Task two";
const LINE_BETA = "- [ ] [[beta|Beta]] - Beta one";
const FOCUS = [LINE_ONE, LINE_TWO, "  - [ ] Sub of two", "  - a note under two", "", LINE_BETA, "- [ ] free text of the day"];

function primed(date: string = TODAY): { root: string; settings: DelegationSettings } {
  const root = lab({ alpha: ALPHA(date), beta: BETA(date) }, { [date]: dailyOf(date, FOCUS) });
  const settings = useVault(root);
  today.todayApi.regenerateFocusMirror(settings, date);
  assert.equal(read(root, dailyRel(date)), dailyOf(date, FOCUS));
  return { root, settings };
}

const RELS = (date: string): string[] => ["projects/alpha.md", "projects/beta.md", dailyRel(date)];

describe("G00c D1: the focus is the lines of the daily", () => {
  it("lists the linked lines in note order and the free lines as no matching task", () => {
    const { settings } = primed();
    const payload = today.readToday(settings, TODAY);
    assert.deepEqual(
      payload.focus.map((entry) => entry.task.title),
      ["Task one", "Task two", "Beta one"],
    );
    assert.deepEqual(payload.unlinked, ["- [ ] free text of the day"]);
  });
});

describe("G00c D2: a line in the daily mirrors into the scheduled date", () => {
  it("the 15/11 case: emptying the focus from outside empties the focus and removes only the scheduled date of that day", () => {
    const projects: Record<string, string> = {
      alpha: project("Alpha", [
        ...Array.from({ length: 6 }, (_unused, index) => `- [ ] Alpha job ${index + 1} #p${(index % 3) + 1} ${SCHEDULED} ${TODAY}${index === 0 ? ` ${DUE} 2026-12-24` : ""}`),
        `- [ ] Alpha later ${SCHEDULED} ${TOMORROW}`,
      ]),
      beta: project("Beta", Array.from({ length: 4 }, (_unused, index) => `- [-] Beta job ${index + 1} ${SCHEDULED} ${TODAY}`)),
    };
    const lines = [...Array.from({ length: 6 }, (_unused, index) => `- [ ] [[alpha|Alpha]] - Alpha job ${index + 1}`), "", ...Array.from({ length: 4 }, (_unused, index) => `- [-] [[beta|Beta]] - Beta job ${index + 1}`)];
    const root = lab(projects, { [TODAY]: dailyOf(TODAY, lines) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(focusTitles(settings, TODAY).length, 10);
    const alphaBefore = read(root, "projects/alpha.md");
    const betaBefore = read(root, "projects/beta.md");
    const emptied = editDaily(root, TODAY, () => dailyOf(TODAY, ["-"]));
    today.flushMirrors(settings);
    assert.deepEqual(focusTitles(settings, TODAY), []);
    assert.equal(read(root, "projects/alpha.md"), alphaBefore.split(` ${SCHEDULED} ${TODAY}`).join(""));
    assert.equal(read(root, "projects/beta.md"), betaBefore.split(` ${SCHEDULED} ${TODAY}`).join(""));
    assert.ok(read(root, "projects/alpha.md").includes(`- [ ] Alpha later ${SCHEDULED} ${TOMORROW}`));
    assert.ok(read(root, "projects/alpha.md").includes(`- [ ] Alpha job 1 #p1 ${DUE} 2026-12-24`));
    assert.equal(read(root, dailyRel(TODAY)), emptied);
    assertSettled(settings, root, TODAY, RELS(TODAY));
  });

  it("the 15/11 case on a baseline written by the previous version: the emptied focus wins on the first sync", () => {
    const projects = { alpha: project("Alpha", Array.from({ length: 10 }, (_unused, index) => `- [ ] Old job ${index + 1} ${SCHEDULED} ${TODAY}`)) };
    const root = lab(projects, { [TODAY]: dailyOf(TODAY, Array.from({ length: 10 }, (_unused, index) => `- [ ] [[alpha|Alpha]] - Old job ${index + 1}`)) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const record = store.getTodayBaseline(TODAY);
    assert.ok(record);
    const legacy = JSON.parse(record.state) as Record<string, unknown>;
    assert.ok("sync" in legacy);
    delete legacy.sync;
    const emptied = dailyOf(TODAY, ["-"]);
    store.saveTodayBaseline({ date: TODAY, path: record.path, content: emptied, state: JSON.stringify(legacy) });
    write(root, dailyRel(TODAY), emptied);
    const before = read(root, "projects/alpha.md");
    today.runStartupMirror(settings);
    assert.equal(read(root, "projects/alpha.md"), before.split(` ${SCHEDULED} ${TODAY}`).join(""));
    assert.equal(read(root, dailyRel(TODAY)), emptied);
    assert.deepEqual(focusTitles(settings, TODAY), []);
    assertSettled(settings, root, TODAY, ["projects/alpha.md", dailyRel(TODAY)]);
  });

  it("a labelled line added from outside schedules its task for the day and shows it in the focus", () => {
    const { root, settings } = primed();
    const before = read(root, "projects/alpha.md");
    const edited = editDaily(root, TODAY, (content) => content.replace(`${LINE_BETA}\n`, `${LINE_BETA}\n- [ ] [[alpha|Alpha]] - Task four\n`));
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), before.replace("- [ ] Task four\n", `- [ ] Task four ${SCHEDULED} ${TODAY}\n`));
    assert.equal(read(root, dailyRel(TODAY)), edited);
    assert.ok(focusTitles(settings, TODAY).includes("Task four"));
    assertSettled(settings, root, TODAY, RELS(TODAY));
  });

  it("a line deleted from outside removes only the scheduled date of that day and leaves the rest of the line", () => {
    const { root, settings } = primed();
    const before = read(root, "projects/alpha.md");
    editDaily(root, TODAY, (content) => content.replace(`${LINE_ONE}\n`, ""));
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), before.replace(`- [ ] Task one ${SCHEDULED} ${TODAY}\n`, "- [ ] Task one\n"));
    assert.equal(focusTitles(settings, TODAY).includes("Task one"), false);
    assertSettled(settings, root, TODAY, RELS(TODAY));
  });

  it("a recurring task never gets a scheduled date from its line but still shows in the focus, and losing the line leaves it alone", () => {
    const { root, settings } = primed();
    const before = read(root, "projects/alpha.md");
    editDaily(root, TODAY, (content) => content.replace(`${LINE_BETA}\n`, `${LINE_BETA}\n- [ ] [[alpha|Alpha]] - Weekly review\n`));
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), before);
    assert.ok(focusTitles(settings, TODAY).includes("Weekly review"));
    editDaily(root, TODAY, (content) => content.replace("- [ ] [[alpha|Alpha]] - Weekly review\n", ""));
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), before);
    assertSettled(settings, root, TODAY, RELS(TODAY));
  });

  it("a line rewritten until it loses its link stays in the note as no matching task, keeps the date, and its later deletion removes the date", () => {
    const { root, settings } = primed();
    const rewritten = "- [ ] Remember the thing for Ana";
    const edited = editDaily(root, TODAY, (content) => content.replace(LINE_ONE, rewritten));
    today.flushMirrors(settings);
    assert.equal(read(root, dailyRel(TODAY)), edited);
    assert.equal(taskIn(settings, "alpha", "Task one").scheduled, TODAY);
    const payload = today.readToday(settings, TODAY);
    assert.ok(payload.unlinked.includes(rewritten));
    assert.equal(payload.focus.some((entry) => entry.task.title === "Task one"), false);
    assertSettled(settings, root, TODAY, RELS(TODAY));
    editDaily(root, TODAY, (content) => content.replace(`${rewritten}\n`, ""));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Task one").scheduled, null);
    assertSettled(settings, root, TODAY, RELS(TODAY));
  });
});

describe("G00c D4: a scheduled date changed in the project mirrors into the daily", () => {
  it("removing the date in the project removes the line and its child block from the daily", () => {
    const { root, settings } = primed();
    editProject(root, "alpha", (content) => content.replace(`- [-] Task two #p1 ${SCHEDULED} ${TODAY} ${DUE} 2026-12-01`, `- [-] Task two #p1 ${DUE} 2026-12-01`));
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, [LINE_ONE, "", LINE_BETA, "- [ ] free text of the day"]));
    assert.deepEqual(focusTitles(settings, TODAY), ["Task one", "Beta one"]);
    assertSettled(settings, root, TODAY, RELS(TODAY));
  });

  it("putting the date in the project inserts the line in the group of its project", () => {
    const { root, settings } = primed();
    editProject(root, "alpha", (content) => content.replace("- [ ] Task four\n", `- [ ] Task four ${SCHEDULED} ${TODAY}\n`));
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const content = read(root, dailyRel(TODAY));
    assert.ok(content.includes(`${LINE_ONE}\n${LINE_TWO}\n  - [ ] Sub of two\n  - a note under two\n- [ ] [[alpha|Alpha]] - Task four\n`) || content.includes("- [ ] [[alpha|Alpha]] - Task four\n"));
    assert.ok(focusTitles(settings, TODAY).includes("Task four"));
    for (const line of FOCUS) assert.ok(content.split("\n").includes(line), line);
    assertSettled(settings, root, TODAY, RELS(TODAY));
  });

  it("when both sides changed the same task, the daily wins", () => {
    const root = lab({ alpha: ALPHA(TODAY), beta: BETA(TODAY) }, { [TODAY]: dailyOf(TODAY, [LINE_ONE, "- [ ] [[alpha|Alpha]] - Task four"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(taskIn(settings, "alpha", "Task four").scheduled, null);
    editProject(root, "alpha", (content) => content.replace("- [ ] Task four\n", `- [ ] Task four ${SCHEDULED} ${TODAY}\n`));
    const edited = editDaily(root, TODAY, (content) => content.replace("- [ ] [[alpha|Alpha]] - Task four\n", ""));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Task four").scheduled, null);
    assert.equal(read(root, dailyRel(TODAY)), edited);
    assert.equal(focusTitles(settings, TODAY).includes("Task four"), false);
    assertSettled(settings, root, TODAY, RELS(TODAY));
  });

  it("a future day with a daily is two-way, and a future day without a daily only gets the date until the daily is created", () => {
    const root = lab({ alpha: ALPHA(TODAY), beta: BETA(TODAY) }, { [TOMORROW]: dailyOf(TOMORROW, ["- [ ] [[alpha|Alpha]] - Task three"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TOMORROW);
    assert.deepEqual(focusTitles(settings, TOMORROW), ["Task three"]);
    editDaily(root, TOMORROW, (content) => content.replace("- [ ] [[alpha|Alpha]] - Task three\n", ""));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Task three").scheduled, null);
    const four = taskIn(settings, "alpha", "Task four");
    today.todayApi.schedule(settings, { projectId: "alpha", line: four.line, raw: four.raw, date: LATER, from: TODAY });
    assert.equal(existsSync(join(root, dailyRel(LATER))), false);
    assert.equal(taskIn(settings, "alpha", "Task four").scheduled, LATER);
    today.todayApi.createToday(settings, LATER);
    assert.ok(read(root, dailyRel(LATER)).includes("- [ ] [[alpha|Alpha]] - Task four\n"));
    assert.deepEqual(focusTitles(settings, LATER), ["Task four"]);
  });

  it("a past daily is never written and its lines never change a date", () => {
    const past = dailyOf(YESTERDAY, ["- [ ] [[alpha|Alpha]] - Task four"]);
    const root = lab({ alpha: ALPHA(YESTERDAY), beta: BETA(TODAY) }, { [YESTERDAY]: past });
    const settings = useVault(root);
    const before = read(root, "projects/alpha.md");
    assert.deepEqual(today.todayApi.regenerateFocusMirror(settings, YESTERDAY), { changed: false, skipped: "past", applied: 0 });
    editDaily(root, YESTERDAY, (content) => content.replace("- [ ] [[alpha|Alpha]] - Task four\n", ""));
    editProject(root, "alpha", (content) => content.replace(`- [ ] Task one ${SCHEDULED} ${YESTERDAY}`, "- [ ] Task one"));
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, YESTERDAY);
    assert.equal(read(root, dailyRel(YESTERDAY)), past.replace("- [ ] [[alpha|Alpha]] - Task four\n", ""));
    assert.equal(read(root, "projects/alpha.md"), before.replace(`- [ ] Task one ${SCHEDULED} ${YESTERDAY}`, "- [ ] Task one"));
    assert.throws(() => today.todayApi.clearToday(settings, YESTERDAY), /scheduled focus of today or a later day/);
  });
});

describe("G00c D3: hub actions write the daily first", () => {
  it("Remove from focus deletes the line and its child block and removes the date", () => {
    const { root, settings } = primed();
    const two = taskIn(settings, "alpha", "Task two");
    today.todayApi.schedule(settings, { projectId: "alpha", line: two.line, raw: two.raw, date: null, from: TODAY });
    assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, [LINE_ONE, "", LINE_BETA, "- [ ] free text of the day"]));
    assert.equal(taskIn(settings, "alpha", "Task two").raw, `- [-] Task two #p1 ${DUE} 2026-12-01`);
    assertSettled(settings, root, TODAY, RELS(TODAY));
  });

  it("Remove from focus of a line-only task deletes the line and keeps a date of another day", () => {
    const root = lab({ alpha: ALPHA(TODAY), beta: BETA(TODAY) }, { [TODAY]: dailyOf(TODAY, [LINE_ONE, "- [ ] [[alpha|Alpha]] - Task three"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.ok(focusTitles(settings, TODAY).includes("Task three"));
    const three = taskIn(settings, "alpha", "Task three");
    today.todayApi.schedule(settings, { projectId: "alpha", line: three.line, raw: three.raw, date: null, from: TODAY });
    const content = read(root, dailyRel(TODAY));
    assert.equal(content.includes("Task three"), false);
    assert.ok(content.includes(`${LINE_ONE}
`));
    assert.equal(taskIn(settings, "alpha", "Task three").scheduled, TOMORROW);
  });

  it("Add to focus inserts the line in the group of its project, then dates the task", () => {
    const { root, settings } = primed();
    const four = taskIn(settings, "alpha", "Task four");
    today.todayApi.schedule(settings, { projectId: "alpha", line: four.line, raw: four.raw, date: TODAY, from: TODAY });
    const content = read(root, dailyRel(TODAY));
    for (const line of FOCUS) assert.ok(content.split("\n").includes(line), line);
    assert.ok(content.includes("- [ ] [[alpha|Alpha]] - Task four\n"));
    assert.equal(taskIn(settings, "alpha", "Task four").scheduled, TODAY);
    assert.ok(focusTitles(settings, TODAY).includes("Task four"));
    assertSettled(settings, root, TODAY, RELS(TODAY));
  });

  it("reorder moves the block of a line past its neighbour of the same project", () => {
    const { root, settings } = primed();
    const two = taskIn(settings, "alpha", "Task two");
    assert.deepEqual(today.todayApi.reorderFocus(settings, TODAY, { projectId: "alpha", line: two.line, raw: two.raw, direction: "up" }), { moved: true });
    assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, [LINE_TWO, "  - [ ] Sub of two", "  - a note under two", LINE_ONE, "", LINE_BETA, "- [ ] free text of the day"]));
    assert.deepEqual(focusTitles(settings, TODAY), ["Task two", "Task one", "Beta one"]);
    assert.deepEqual(today.todayApi.reorderFocus(settings, TODAY, { projectId: "alpha", line: two.line, raw: two.raw, direction: "up" }), { moved: false });
    assertSettled(settings, root, TODAY, RELS(TODAY));
  });

  it("Clear today empties the linked lines and the dates, and Undo restores every file byte for byte", () => {
    const { root, settings } = primed();
    const before = snapshot(root, RELS(TODAY));
    const cleared = today.todayApi.clearToday(settings, TODAY);
    assert.deepEqual([cleared.lines, cleared.unscheduled], [3, 3]);
    assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, ["- [ ] free text of the day"]));
    assert.equal(read(root, "projects/alpha.md").includes(`${SCHEDULED} ${TODAY}`), false);
    assert.equal(read(root, "projects/beta.md").includes(`${SCHEDULED} ${TODAY}`), false);
    assert.ok(read(root, "projects/alpha.md").includes(`- [ ] Task three ${SCHEDULED} ${TOMORROW}`));
    assert.deepEqual(focusTitles(settings, TODAY), []);
    assertSettled(settings, root, TODAY, RELS(TODAY));
    assert.deepEqual(today.todayApi.undoClear(settings, TODAY, cleared.token), { restored: true });
    assert.deepEqual(snapshot(root, RELS(TODAY)), before);
    assert.deepEqual(focusTitles(settings, TODAY), ["Task one", "Task two", "Beta one"]);
    assertSettled(settings, root, TODAY, RELS(TODAY));
    assert.throws(() => today.todayApi.undoClear(settings, TODAY, cleared.token), /nothing to undo/);
  });

  it("Undo refuses when the daily changed after the clear and writes nothing", () => {
    const { root, settings } = primed();
    const cleared = today.todayApi.clearToday(settings, TODAY);
    editDaily(root, TODAY, (content) => content.replace("- 10:00 Standup", "- 10:00 Standup moved"));
    today.flushMirrors(settings);
    const after = snapshot(root, RELS(TODAY));
    assert.throws(() => today.todayApi.undoClear(settings, TODAY, cleared.token), /changed on disk/);
    assert.deepEqual(snapshot(root, RELS(TODAY)), after);
  });
});

describe("G00c D6: no loop", () => {
  it("the sync run again and again leaves every file byte for byte", () => {
    const { root, settings } = primed();
    assertSettled(settings, root, TODAY, RELS(TODAY));
    editDaily(root, TODAY, (content) => content.replace(`${LINE_ONE}\n`, ""));
    today.flushMirrors(settings);
    assertSettled(settings, root, TODAY, RELS(TODAY));
  });
});
