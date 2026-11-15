import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-today-late-data-"));
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

const TEMPLATE = ["---", "type: daily", "---", "", "# {{date}}", "", "## Focus", "", "- [ ]", "", "## Meetings", "", "-", "", "## Sessions", "", "-", ""].join("\n");

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

const CEMIG = project("Cemig", ["- [-] Teams (fase 4): melhorar a experiência no Teams", "- [ ] Portal: revisar o fluxo de login", "- [ ] Relatório mensal"]);
const WORKAI = project(
  "Workai",
  [
    "- [-] **Feegow**: levar os recursos da Medware pro Feegow #p1",
    `- [ ] Planejar a migração do banco ${SCHEDULED} ${TOMORROW}`,
    "- [ ] Review the draft contract with Ana",
    "- [ ] Review the draft contract with Bruno",
  ],
  [`- [x] Fechar o relatório antigo ${DONE} ${YESTERDAY}`],
);

function lab(dailies: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cch-today-late-vault-"));
  roots.push(root);
  write(root, "_templates/daily.md", TEMPLATE);
  write(root, "projects/cemig.md", CEMIG);
  write(root, "projects/workai.md", WORKAI);
  write(root, "projects/notes.md", "# Notes\n\nfree text, no tasks here\n");
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
  store.setSetting(`today.migrated.${TODAY}`, null);
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

function appendToFocus(root: string, date: string, lines: string[]): string {
  const file = join(root, dailyRel(date));
  const content = readFileSync(file, "utf8");
  const heading = "## Focus\n";
  const at = content.indexOf(heading);
  assert.notEqual(at, -1);
  const next = `${content.slice(0, at + heading.length)}\n${lines.join("\n")}${content.slice(at + heading.length)}`;
  writeFileSync(file, next);
  today.queueDailyDiskChange(date);
  today.flushMirrors(store.getSettings());
  return next;
}

function withoutScheduled(text: string): string {
  return text.replace(new RegExp(` ${SCHEDULED} \\d{4}-\\d{2}-\\d{2}`, "g"), "");
}

const LATE = [
  "- [-] [[cemig|Cemig]] - Teams (fase 4): melhorar a experiência no Teams",
  "- [ ] [[cemig|Cemig]] - Portal: revisar o fluxo de login (ver com a Ana)",
  "- [-] [[workai|Workai]] - Feegow: levar os recursos da Medware pro Feegow #p1",
];

describe("late lines: a skill writes the focus after the hub created the daily", () => {
  it("schedules every new line that links to one unscheduled task, keeps the lines and touches nothing else", () => {
    const root = lab();
    const settings = useVault(root);
    today.todayApi.createToday(settings, TODAY);
    assert.equal(store.getSetting(`today.migrated.${TODAY}`), "1");
    const notes = read(root, "projects/notes.md");
    const template = read(root, "_templates/daily.md");
    const written = appendToFocus(root, TODAY, LATE);
    assert.equal(taskIn(settings, "cemig", "Teams (fase 4): melhorar a experiência no Teams").scheduled, TODAY);
    assert.equal(taskIn(settings, "cemig", "Portal: revisar o fluxo de login").scheduled, TODAY);
    assert.equal(taskIn(settings, "workai", "**Feegow**: levar os recursos da Medware pro Feegow").scheduled, TODAY);
    assert.equal(taskIn(settings, "cemig", "Relatório mensal").scheduled, null);
    assert.equal(withoutScheduled(read(root, "projects/cemig.md")), CEMIG);
    assert.equal(withoutScheduled(read(root, "projects/workai.md")), WORKAI.replace(` ${SCHEDULED} ${TOMORROW}`, ""));
    assert.ok(read(root, "projects/workai.md").includes(`- [ ] Planejar a migração do banco ${SCHEDULED} ${TOMORROW}`));
    assert.equal(read(root, "projects/notes.md"), notes);
    assert.equal(read(root, "_templates/daily.md"), template);
    assert.equal(read(root, dailyRel(TODAY)), written);
    const payload = today.readToday(settings, TODAY);
    assert.deepEqual(payload.focus.map((entry) => entry.task.title).sort(), ["**Feegow**: levar os recursos da Medware pro Feegow", "Portal: revisar o fluxo de login", "Teams (fase 4): melhorar a experiência no Teams"]);
    assert.deepEqual(payload.inNote, []);
    assert.equal(payload.unmatched, undefined);
  });

  it("schedules lines a client save adds to the focus", () => {
    const root = lab();
    const settings = useVault(root);
    today.todayApi.createToday(settings, TODAY);
    const content = read(root, dailyRel(TODAY)).replace("## Focus\n", `## Focus\n\n${LATE[0]}\n`);
    today.saveDailyFromClient(settings, TODAY, content);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "cemig", "Teams (fase 4): melhorar a experiência no Teams").scheduled, TODAY);
    assert.equal(read(root, dailyRel(TODAY)), content);
  });

  it("never schedules again a task the user took out of the day while its line stays", () => {
    const root = lab();
    const settings = useVault(root);
    today.todayApi.createToday(settings, TODAY);
    appendToFocus(root, TODAY, LATE);
    const teams = taskIn(settings, "cemig", "Teams (fase 4): melhorar a experiência no Teams");
    today.todayApi.schedule(settings, { projectId: "cemig", line: teams.line, raw: teams.raw, date: null });
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "cemig", "Teams (fase 4): melhorar a experiência no Teams").scheduled, null);
    appendToFocus(root, TODAY, ["- [ ] typed by hand"]);
    assert.equal(taskIn(settings, "cemig", "Teams (fase 4): melhorar a experiência no Teams").scheduled, null);
    const file = join(root, dailyRel(TODAY));
    const reworded = readFileSync(file, "utf8").replace(LATE[0] as string, `${LATE[0] as string} (pedir acesso)`);
    writeFileSync(file, reworded);
    today.queueDailyDiskChange(TODAY);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "cemig", "Teams (fase 4): melhorar a experiência no Teams").scheduled, null);
    assert.equal(taskIn(settings, "cemig", "Teams (fase 4): melhorar a experiência no Teams").raw.includes(SCHEDULED), false);
    assert.equal(readFileSync(file, "utf8"), reworded);
    assert.ok(today.readToday(settings, TODAY).inNote.includes(`${LATE[0] as string} (pedir acesso)`));
  });

  it("leaves a task scheduled for another date, a task finished earlier and an ambiguous line alone", () => {
    const root = lab();
    const settings = useVault(root);
    today.todayApi.createToday(settings, TODAY);
    const cemig = read(root, "projects/cemig.md");
    const workai = read(root, "projects/workai.md");
    const lines = [
      "- [ ] [[workai|Workai]] - Planejar a migração do banco",
      "- [x] [[workai|Workai]] - Fechar o relatório antigo",
      "- [ ] [[workai|Workai]] - Review the draft contract",
    ];
    const written = appendToFocus(root, TODAY, lines);
    assert.equal(read(root, "projects/workai.md"), workai);
    assert.equal(read(root, "projects/cemig.md"), cemig);
    assert.equal(read(root, dailyRel(TODAY)), written);
    assert.equal(taskIn(settings, "workai", "Planejar a migração do banco").scheduled, TOMORROW);
    const payload = today.readToday(settings, TODAY);
    assert.deepEqual(payload.focus, []);
    assert.deepEqual(payload.inNote, lines);
    assert.deepEqual(payload.inNoteLinks, [
      { line: lines[0], taskId: taskIn(settings, "workai", "Planejar a migração do banco").id },
      { line: lines[1], taskId: taskIn(settings, "workai", "Fechar o relatório antigo").id },
      { line: lines[2], taskId: null },
    ]);
    assert.deepEqual(
      payload.ambiguous.map((item) => item.text),
      ["- [ ] [[workai|Workai]] - Review the draft contract"],
    );
  });

  it("never schedules from a past daily and never writes it", () => {
    const past = ["---", "type: daily", "---", "", `# ${YESTERDAY}`, "", "## Focus", "", "- [ ]", "", "## Meetings", "", "-", ""].join("\n");
    const root = lab({ [YESTERDAY]: past });
    const settings = useVault(root);
    const cemig = read(root, "projects/cemig.md");
    const written = appendToFocus(root, YESTERDAY, [LATE[0] as string]);
    today.todayApi.regenerateFocusMirror(settings, YESTERDAY);
    assert.equal(read(root, dailyRel(YESTERDAY)), written);
    assert.equal(read(root, "projects/cemig.md"), cemig);
  });

  it("does not schedule lines that were already in the daily when the hub first saw it", () => {
    const content = ["---", "type: daily", "---", "", `# ${TODAY}`, "", "## Focus", "", LATE[0] as string, "", "## Meetings", "", "-", ""].join("\n");
    const root = lab({ [TODAY]: content });
    const settings = useVault(root);
    store.setSetting(`today.migrated.${TODAY}`, "1");
    const cemig = read(root, "projects/cemig.md");
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    appendToFocus(root, TODAY, ["- [ ] typed by hand"]);
    assert.equal(read(root, "projects/cemig.md"), cemig);
    const payload = today.readToday(settings, TODAY);
    assert.deepEqual(payload.inNote.filter((line) => line.includes("Teams")), [LATE[0]]);
    const teams = taskIn(settings, "cemig", "Teams (fase 4): melhorar a experiência no Teams");
    assert.deepEqual(payload.inNoteLinks.filter((item) => item.taskId !== null), [{ line: LATE[0], taskId: teams.id }]);
    const before = read(root, dailyRel(TODAY));
    today.todayApi.schedule(settings, { projectId: "cemig", line: teams.line, raw: teams.raw, date: TODAY });
    const after = today.readToday(settings, TODAY);
    assert.deepEqual(after.focus.map((entry) => entry.task.id), [teams.id]);
    assert.deepEqual(after.inNoteLinks.filter((item) => item.line === LATE[0]), []);
    assert.equal(read(root, dailyRel(TODAY)), before);
  });
});
