import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-today-yesterday-data-"));
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
const DONE = "✅";
const REPEAT = "\u{1F501}";
const TODAY = "2026-11-17";
const YESTERDAY = "2026-11-16";
const BEFORE = "2026-11-15";
const TOMORROW = "2026-11-18";
const roots: string[] = [];

const TEMPLATE = ["---", "type: daily", "---", "", "# {{date}}", "", "## Focus", "", "- [ ]", "", "## Meetings", "", "-", ""].join("\n");

before(async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 17, 10, 0, 0) });
  store = await import("../src/delegation-store.js");
  board = await import("../src/tasks-board.js");
  daily = await import("../src/daily.js");
  today = await import("../src/today.js");
  today.installTodayHooks();
  today.setFocusStability({ delayMs: 0, reread: null });
});

beforeEach(() => today.forgetTodayState());
afterEach(() => today.forgetTodayState());

after(async () => {
  today.removeTodayHooks();
  daily.stopDailyWatch();
  board.stopTasksBoardWatch();
  mock.timers.reset();
  (await import("../src/db.js")).db.close();
  for (const dir of [dataDir, ...roots]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function project(title: string, open: string[], done: string[] = ["-"]): string {
  return [`# ${title}`, "", "## Open loops", "", ...open, "", "## Done loops", "", ...done, ""].join("\n");
}

function dailyOf(date: string, focus: string[]): string {
  return ["---", "type: daily", "---", "", `# ${date}`, "", "## Focus", "", ...focus, "", "## Meetings", "", "- 10:00 Standup", ""].join("\n");
}

function lab(projects: Record<string, string>, dailies: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cch-today-yesterday-vault-"));
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

const dailyRel = (date: string): string => `daily/${date}.md`;

function editDaily(root: string, date: string, change: (content: string) => string): string {
  const file = join(root, dailyRel(date));
  const next = change(readFileSync(file, "utf8"));
  writeFileSync(file, next);
  today.queueDailyDiskChange(date);
  return next;
}

const line = (title: string, mark = " "): string => `- [${mark}] [[alpha|Alpha]] - ${title}`;

const focusTitles = (settings: DelegationSettings, date: string): string[] => today.readToday(settings, date).focus.map((entry) => entry.task.title);

const tick = (task: BoardTask, status: "todo" | "doing" | "done") => ({ projectId: task.projectId, line: task.line, raw: task.raw, status });

describe("H2: the day of yesterday syncs its checkboxes", () => {
  it("ticking a line in the note of yesterday closes the task with the date of yesterday and keeps its scheduled date", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`, "- [ ] Other"]) }, { [YESTERDAY]: dailyOf(YESTERDAY, [line("Ship release")]) });
    const settings = useVault(root);
    assert.deepEqual(today.todayApi.regenerateFocusMirror(settings, YESTERDAY), { changed: false, skipped: null, applied: 0 });
    const edited = editDaily(root, YESTERDAY, (content) => content.replace(line("Ship release"), line("Ship release", "x")));
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), project("Alpha", ["- [ ] Other"], [`- [x] Ship release ${SCHEDULED} ${YESTERDAY} ${DONE} ${YESTERDAY}`]));
    assert.equal(taskIn(settings, "alpha", "Ship release").doneAt, YESTERDAY);
    assert.equal(read(root, dailyRel(YESTERDAY)), edited);
    assert.deepEqual(focusTitles(settings, YESTERDAY), ["Ship release"]);
  });

  it("a doing mark in the note of yesterday sets the task doing without a done date", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`]) }, { [YESTERDAY]: dailyOf(YESTERDAY, [line("Ship release")]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, YESTERDAY);
    editDaily(root, YESTERDAY, (content) => content.replace(line("Ship release"), line("Ship release", "-")));
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), project("Alpha", [`- [-] Ship release ${SCHEDULED} ${YESTERDAY}`]));
  });

  it("unticking reopens only a task closed yesterday, any other done date stays and is reported", () => {
    const root = lab(
      { alpha: project("Alpha", ["- [ ] Other"], [`- [x] Ship release ${SCHEDULED} ${YESTERDAY} ${DONE} ${YESTERDAY}`, `- [x] Old work ${DONE} ${BEFORE}`]) },
      { [YESTERDAY]: dailyOf(YESTERDAY, [line("Ship release", "x"), line("Old work", "x")]) },
    );
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, YESTERDAY);
    editDaily(root, YESTERDAY, (content) => content.replace(line("Ship release", "x"), line("Ship release")).replace(line("Old work", "x"), line("Old work")));
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), project("Alpha", ["- [ ] Other", `- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`], [`- [x] Old work ${DONE} ${BEFORE}`]));
    assert.deepEqual(today.readToday(settings, YESTERDAY).outOfSync, [{ line: line("Old work"), taskTitle: "Old work", projectId: "alpha", dailyCheckbox: "todo", projectStatus: "done" }]);
  });

  it("lines added to the focus of yesterday link to their tasks, show in Focus and sync without moving any scheduled date", () => {
    const root = lab(
      { alpha: project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`, `- [ ] Write notes ${SCHEDULED} ${TODAY}`, "- [ ] Plain task", `- [ ] Later ${SCHEDULED} ${TOMORROW}`]) },
      { [YESTERDAY]: dailyOf(YESTERDAY, [line("Ship release")]) },
    );
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, YESTERDAY);
    const added = editDaily(root, YESTERDAY, (content) => content.replace(`${line("Ship release")}\n`, `${line("Ship release")}\n${line("Write notes")}\n${line("Plain task")}\n${line("Later")}\n`));
    today.flushMirrors(settings);
    assert.equal(read(root, dailyRel(YESTERDAY)), added);
    const payload = today.readToday(settings, YESTERDAY);
    assert.deepEqual(payload.focus.map((entry) => entry.task.title), ["Ship release", "Write notes", "Plain task", "Later"]);
    assert.deepEqual([payload.inNote, payload.unlinked, payload.unmatched], [[], [], undefined]);
    const before = read(root, "projects/alpha.md");
    editDaily(root, YESTERDAY, (content) => content.replace(line("Write notes"), line("Write notes", "x")).replace(line("Plain task"), line("Plain task", "x")));
    today.flushMirrors(settings);
    assert.equal(
      read(root, "projects/alpha.md"),
      project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`, `- [ ] Later ${SCHEDULED} ${TOMORROW}`], [`- [x] Plain task ${DONE} ${YESTERDAY}`, `- [x] Write notes ${SCHEDULED} ${TODAY} ${DONE} ${YESTERDAY}`]),
    );
    assert.notEqual(before, read(root, "projects/alpha.md"));
    assert.deepEqual(today.todayApi.focusOf(settings, YESTERDAY).map((entry) => entry.task.title), ["Ship release", "Write notes", "Plain task", "Later"]);
  });

  it("never adds, removes or moves a scheduled date and never inserts or drops a line of yesterday", () => {
    const projectText = project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`, `- [ ] Missing ${SCHEDULED} ${YESTERDAY}`, `- [ ] Moved ${SCHEDULED} ${TOMORROW}`, "- [ ] Loose"]);
    const root = lab({ alpha: projectText }, { [YESTERDAY]: dailyOf(YESTERDAY, [line("Ship release"), line("Moved")]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, YESTERDAY);
    assert.equal(read(root, dailyRel(YESTERDAY)), dailyOf(YESTERDAY, [line("Ship release"), line("Moved")]));
    const edited = editDaily(root, YESTERDAY, (content) => content.replace(`${line("Ship release")}\n`, "").replace(`${line("Moved")}\n`, `${line("Moved")}\n${line("Loose")}\n`));
    today.flushMirrors(settings);
    for (let round = 0; round < 3; round += 1) today.todayApi.regenerateFocusMirror(settings, YESTERDAY);
    assert.equal(read(root, "projects/alpha.md"), projectText);
    assert.equal(read(root, dailyRel(YESTERDAY)), edited);
    assert.deepEqual(focusTitles(settings, YESTERDAY), ["Moved", "Loose", "Ship release", "Missing"]);
    assert.deepEqual(today.readToday(settings, YESTERDAY).carriedOver, []);
  });

  it("a Note tab save and Close yesterday of the day of yesterday close the task with its date", () => {
    const root = lab(
      { alpha: project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`, `- [ ] Write notes ${SCHEDULED} ${YESTERDAY}`]) },
      { [YESTERDAY]: dailyOf(YESTERDAY, [line("Ship release"), line("Write notes")]) },
    );
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, YESTERDAY);
    const saved = read(root, dailyRel(YESTERDAY)).replace(line("Ship release"), line("Ship release", "x"));
    today.saveDailyFromClient(settings, YESTERDAY, saved);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship release").doneAt, YESTERDAY);
    const closed = saved.replace(line("Write notes"), line("Write notes", "x"));
    today.closeDailyTicks(settings, YESTERDAY, saved, closed);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Write notes").doneAt, YESTERDAY);
    assert.equal(read(root, dailyRel(YESTERDAY)), closed);
  });

  it("the day before yesterday stays history: no mirror, no sync, no hub tick", () => {
    const projectText = project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${BEFORE}`, "- [ ] Loose"]);
    const content = dailyOf(BEFORE, [line("Ship release"), line("Loose")]);
    const root = lab({ alpha: projectText }, { [BEFORE]: content });
    const settings = useVault(root);
    assert.deepEqual(today.todayApi.regenerateFocusMirror(settings, BEFORE), { changed: false, skipped: "past", applied: 0 });
    const edited = editDaily(root, BEFORE, (text) => text.replace(line("Ship release"), line("Ship release", "x")).replace(line("Loose"), line("Loose", "x")));
    assert.equal(today.flushMirrors(settings), false);
    today.saveDailyFromClient(settings, BEFORE, edited);
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), projectText);
    assert.equal(read(root, dailyRel(BEFORE)), edited);
    const payload = today.readToday(settings, BEFORE);
    assert.deepEqual(payload.focus.map((entry) => entry.task.title), ["Ship release"]);
    assert.deepEqual(payload.inNote, [line("Loose", "x")]);
    assert.equal(payload.outOfSync, undefined);
    assert.throws(() => today.todayApi.tickDay(settings, BEFORE, tick(taskIn(settings, "alpha", "Loose"), "done")), /only the focus of yesterday/);
    assert.throws(() => today.todayApi.tickDay(settings, TODAY, tick(taskIn(settings, "alpha", "Loose"), "done")), /only the focus of yesterday/);
  });
});

describe("H2: hub actions on the day of yesterday", () => {
  it("a tick from Today writes the note of yesterday first and then closes the task with the date of yesterday", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`, `- [ ] Write notes ${SCHEDULED} ${TODAY}`]) }, { [YESTERDAY]: dailyOf(YESTERDAY, [line("Ship release"), line("Write notes")]) });
    const settings = useVault(root);
    const done = today.todayApi.tickDay(settings, YESTERDAY, tick(taskIn(settings, "alpha", "Write notes"), "done"));
    assert.equal(done.task.doneAt, YESTERDAY);
    assert.equal(read(root, dailyRel(YESTERDAY)), dailyOf(YESTERDAY, [line("Ship release"), line("Write notes", "x")]));
    assert.equal(read(root, "projects/alpha.md"), project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`], [`- [x] Write notes ${SCHEDULED} ${TODAY} ${DONE} ${YESTERDAY}`]));
    assert.ok(statSync(join(root, dailyRel(YESTERDAY))).mtimeMs <= statSync(join(root, "projects/alpha.md")).mtimeMs);
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, YESTERDAY);
    assert.equal(taskIn(settings, "alpha", "Write notes").doneAt, YESTERDAY);
    const reopened = today.todayApi.tickDay(settings, YESTERDAY, tick(taskIn(settings, "alpha", "Write notes"), "todo"));
    assert.equal(reopened.task.raw, `- [ ] Write notes ${SCHEDULED} ${TODAY}`);
    assert.equal(read(root, dailyRel(YESTERDAY)), dailyOf(YESTERDAY, [line("Ship release"), line("Write notes")]));
    const doing = today.todayApi.tickDay(settings, YESTERDAY, tick(taskIn(settings, "alpha", "Ship release"), "doing"));
    assert.equal(doing.task.status, "doing");
    assert.equal(read(root, dailyRel(YESTERDAY)), dailyOf(YESTERDAY, [line("Ship release", "-"), line("Write notes")]));
    const same = today.todayApi.tickDay(settings, YESTERDAY, tick(taskIn(settings, "alpha", "Ship release"), "doing"));
    assert.equal(same.task.status, "doing");
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), project("Alpha", [`- [-] Ship release ${SCHEDULED} ${YESTERDAY}`, `- [ ] Write notes ${SCHEDULED} ${TODAY}`]));
  });

  it("a tick from Today refuses to reopen a task closed on another day, a recurring task, a stale line and a missing note", () => {
    const root = lab(
      { alpha: project("Alpha", [`- [ ] Daily review ${REPEAT} every day ${SCHEDULED} ${YESTERDAY}`, `- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`], [`- [x] Old work ${DONE} ${BEFORE}`]) },
      { [YESTERDAY]: dailyOf(YESTERDAY, [line("Old work", "x"), line("Daily review"), line("Ship release")]) },
    );
    const settings = useVault(root);
    const projectText = read(root, "projects/alpha.md");
    const old = taskIn(settings, "alpha", "Old work");
    assert.throws(() => today.todayApi.tickDay(settings, YESTERDAY, tick(old, "todo")), new RegExp(`"Old work" was completed on ${BEFORE}, reopen it in Tasks`));
    assert.throws(() => today.todayApi.tickDay(settings, YESTERDAY, tick(taskIn(settings, "alpha", "Daily review"), "done")), /recurring tasks are completed in Tasks/);
    assert.throws(() => today.todayApi.tickDay(settings, YESTERDAY, { ...tick(taskIn(settings, "alpha", "Ship release"), "done"), raw: "- [ ] stale" }), board.TaskConflictError);
    assert.throws(() => today.todayApi.tickDay(settings, YESTERDAY, { ...tick(taskIn(settings, "alpha", "Ship release"), "done"), line: 99 }), board.TaskConflictError);
    assert.equal(read(root, "projects/alpha.md"), projectText);
    assert.equal(read(root, dailyRel(YESTERDAY)), dailyOf(YESTERDAY, [line("Old work", "x"), line("Daily review"), line("Ship release")]));
    rmSync(join(root, dailyRel(YESTERDAY)));
    assert.throws(() => today.todayApi.tickDay(settings, YESTERDAY, tick(taskIn(settings, "alpha", "Ship release"), "done")), /daily not found/);
    store.updateSettings({ features: { ...settings.features, daily: false } });
    assert.throws(() => today.todayApi.tickDay(store.getSettings(), YESTERDAY, tick(old, "done")), /daily feature is disabled/);
  });

  it("a tick from Today refuses a task without a line in the note of yesterday and writes nothing", () => {
    const projectText = project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`, `- [ ] Not in the note ${SCHEDULED} ${YESTERDAY}`, "- [ ] Loose"]);
    const root = lab({ alpha: projectText }, { [YESTERDAY]: dailyOf(YESTERDAY, [line("Ship release")]) });
    const settings = useVault(root);
    assert.deepEqual(focusTitles(settings, YESTERDAY), ["Ship release", "Not in the note"]);
    for (const title of ["Not in the note", "Loose"]) {
      assert.throws(
        () => today.todayApi.tickDay(settings, YESTERDAY, tick(taskIn(settings, "alpha", title), "done")),
        { message: `"${title}" has no line in the focus of yesterday, add it to that focus first or complete it in Tasks` },
      );
    }
    assert.equal(read(root, dailyRel(YESTERDAY)), dailyOf(YESTERDAY, [line("Ship release")]));
    assert.equal(read(root, "projects/alpha.md"), projectText);
  });

  it("a subtask ticked and unticked on yesterday reopens without a done date, from the hub and from the note", () => {
    const parent = line("Ship release");
    const root = lab({ alpha: project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`, "  - [ ] Write notes", "  - [ ] Tag build"]) }, { [YESTERDAY]: dailyOf(YESTERDAY, [parent, "  - [ ] Write notes", "  - [ ] Tag build"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, YESTERDAY);
    const done = today.todayApi.tickDay(settings, YESTERDAY, tick(taskIn(settings, "alpha", "Write notes"), "done"));
    assert.deepEqual([done.task.status, done.task.doneAt], ["done", null]);
    assert.equal(read(root, dailyRel(YESTERDAY)), dailyOf(YESTERDAY, [parent, "  - [x] Write notes", "  - [ ] Tag build"]));
    const reopened = today.todayApi.tickDay(settings, YESTERDAY, tick(taskIn(settings, "alpha", "Write notes"), "todo"));
    assert.equal(reopened.task.status, "todo");
    assert.equal(read(root, dailyRel(YESTERDAY)), dailyOf(YESTERDAY, [parent, "  - [ ] Write notes", "  - [ ] Tag build"]));
    today.flushMirrors(settings);
    editDaily(root, YESTERDAY, (content) => content.replace("  - [ ] Tag build", "  - [x] Tag build"));
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`, "  - [ ] Write notes", "  - [x] Tag build"]));
    editDaily(root, YESTERDAY, (content) => content.replace("  - [x] Tag build", "  - [ ] Tag build"));
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`, "  - [ ] Write notes", "  - [ ] Tag build"]));
    assert.equal(today.readToday(settings, YESTERDAY).outOfSync, undefined);
  });

  it("a task closed without a done date, with no Done section configured, reopens on yesterday from the hub and from the note", () => {
    const loose = (mark: string, title: string): string => `- [${mark}] ${title} ${SCHEDULED} ${YESTERDAY}`;
    const root = lab({ alpha: ["# Alpha", "", "## Open loops", "", loose(" ", "Ship release"), loose(" ", "Write notes"), ""].join("\n") }, { [YESTERDAY]: dailyOf(YESTERDAY, [line("Ship release"), line("Write notes")]) });
    const vault = useVault(root);
    const settings = store.updateSettings({ tasks: { ...vault.tasks, doneSection: "" } });
    today.todayApi.regenerateFocusMirror(settings, YESTERDAY);
    const shipped = today.todayApi.tickDay(settings, YESTERDAY, tick(taskIn(settings, "alpha", "Ship release"), "done"));
    assert.deepEqual([shipped.task.raw, shipped.task.doneAt], [loose("x", "Ship release"), null]);
    assert.equal(today.todayApi.tickDay(settings, YESTERDAY, tick(shipped.task, "todo")).task.raw, loose(" ", "Ship release"));
    today.flushMirrors(settings);
    editDaily(root, YESTERDAY, (content) => content.replace(line("Write notes"), line("Write notes", "x")));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Write notes").raw, loose("x", "Write notes"));
    editDaily(root, YESTERDAY, (content) => content.replace(line("Write notes", "x"), line("Write notes")));
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), ["# Alpha", "", "## Open loops", "", loose(" ", "Ship release"), loose(" ", "Write notes"), ""].join("\n"));
  });

  it("a recurring task ticked in the note of yesterday is reported, never completed", () => {
    const projectText = project(
      "Alpha",
      [
        `- [ ] Daily review ${REPEAT} every day ${SCHEDULED} ${YESTERDAY}`,
        `- [-] Weekly sync ${REPEAT} every week ${SCHEDULED} ${YESTERDAY}`,
        `- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`,
        `- [ ] Stand up ${REPEAT} every day ${SCHEDULED} ${TODAY}`,
      ],
      [`- [x] Stand up ${REPEAT} every day ${SCHEDULED} ${YESTERDAY} ${DONE} ${YESTERDAY}`],
    );
    const root = lab({ alpha: projectText }, { [YESTERDAY]: dailyOf(YESTERDAY, [line("Daily review"), line("Weekly sync"), line("Ship release"), line("Stand up", "x")]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, YESTERDAY);
    assert.equal(today.readToday(settings, YESTERDAY).outOfSync, undefined);
    const edited = editDaily(root, YESTERDAY, (content) =>
      content
        .replace(line("Daily review"), line("Daily review", "x"))
        .replace(line("Weekly sync"), line("Weekly sync", "-"))
        .replace(line("Stand up", "x"), line("Stand up"))
        .replace(line("Ship release"), `${line("Ship release")}\n${line("Daily review")}`),
    );
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), projectText);
    assert.equal(read(root, dailyRel(YESTERDAY)), edited);
    assert.deepEqual(today.readToday(settings, YESTERDAY).outOfSync, [
      { line: line("Stand up"), taskTitle: "Stand up", projectId: "alpha", dailyCheckbox: "todo", projectStatus: "done", reason: "recurring-done" },
      { line: line("Daily review", "x"), taskTitle: "Daily review", projectId: "alpha", dailyCheckbox: "done", projectStatus: "todo" },
    ]);
  });

  it("the payload says when a day closes through its note: only yesterday in scheduled mode", () => {
    const root = lab({ alpha: project("Alpha", ["- [ ] Loose"]) }, { [YESTERDAY]: dailyOf(YESTERDAY, []) });
    const settings = useVault(root);
    assert.equal(today.readToday(settings, YESTERDAY).closesDay, true);
    for (const date of [TODAY, BEFORE, TOMORROW]) assert.equal(today.readToday(settings, date).closesDay, undefined);
    store.updateSettings({ daily: { ...settings.daily, focusSource: "list" } });
    assert.equal(today.readToday(store.getSettings(), YESTERDAY).closesDay, undefined);
  });

  it("Add to focus on yesterday writes the line in the note and never dates the task", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Ship release ${SCHEDULED} ${YESTERDAY}`, "- [ ] Loose", `- [ ] Later ${SCHEDULED} ${TOMORROW}`]) }, { [YESTERDAY]: dailyOf(YESTERDAY, [line("Ship release")]) });
    const settings = useVault(root);
    const loose = taskIn(settings, "alpha", "Loose");
    const later = taskIn(settings, "alpha", "Later");
    const projectText = read(root, "projects/alpha.md");
    assert.equal(today.todayApi.schedule(settings, { projectId: "alpha", line: loose.line, raw: loose.raw, date: YESTERDAY, from: YESTERDAY }).task.id, loose.id);
    today.todayApi.schedule(settings, { projectId: "alpha", line: later.line, raw: later.raw, date: YESTERDAY, from: YESTERDAY });
    today.flushMirrors(settings);
    assert.equal(read(root, dailyRel(YESTERDAY)), dailyOf(YESTERDAY, [line("Ship release"), line("Loose"), line("Later")]));
    assert.equal(read(root, "projects/alpha.md"), projectText);
    assert.deepEqual(focusTitles(settings, YESTERDAY), ["Ship release", "Loose", "Later"]);
    assert.throws(() => today.todayApi.schedule(settings, { projectId: "alpha", line: loose.line, raw: "- [ ] stale", date: YESTERDAY, from: YESTERDAY }), board.TaskConflictError);
    rmSync(join(root, dailyRel(YESTERDAY)));
    assert.throws(() => today.todayApi.schedule(settings, { projectId: "alpha", line: loose.line, raw: loose.raw, date: YESTERDAY, from: YESTERDAY }), /create the daily first/);
    assert.equal(read(root, "projects/alpha.md"), projectText);
  });
});
