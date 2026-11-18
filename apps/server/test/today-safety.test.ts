import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { freePort, makeSandbox, startServer, waitFor, type RunningServer, type Sandbox } from "./helpers.js";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-today-safety-data-"));
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
const BOM = String.fromCharCode(0xfeff);
const roots: string[] = [];

before(async () => {
  store = await import("../src/delegation-store.js");
  board = await import("../src/tasks-board.js");
  daily = await import("../src/daily.js");
  today = await import("../src/today.js");
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
const DAY_BEFORE = shift(TODAY, -2);
const TOMORROW = shift(TODAY, 1);

const TEMPLATE = ["---", "type: daily", "---", "", "# {{date}}", "", "## Focus", "", "- [ ]", "", "## Meetings", "", "-", "", "## Captures", "", "-", "", "## Sessions", "", "-", ""].join("\n");

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function lab(projects: Record<string, string>, dailies: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cch-today-safety-vault-"));
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
    tasks: { root: "projects", doneSection: "Done loops" },
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

function project(title: string, open: string[]): string {
  return [`# ${title}`, "", "## Open loops", "", ...open, "", "## Done loops", "", "-", ""].join("\n");
}

function dailyWith(focus: string[], meetings: string[] = ["-"]): string {
  return [`---`, `type: daily`, `---`, ``, `# ${TODAY}`, ``, `## Focus`, ``, ...focus, ``, `## Meetings`, ``, ...meetings, ``, `## Sessions`, ``, `-`, ``].join("\n");
}

function flatten(tasks: BoardTask[]): BoardTask[] {
  return tasks.flatMap((task) => [task, ...flatten(task.subtasks)]);
}

function taskIn(settings: DelegationSettings, projectId: string, title: string): BoardTask {
  const found = flatten(board.readBoard(settings).tasks).find((task) => task.projectId === projectId && task.title === title);
  assert.ok(found, `${projectId}: ${title}`);
  return found;
}

function scheduleOf(settings: DelegationSettings, projectId: string, title: string, date: string | null): void {
  const task = taskIn(settings, projectId, title);
  today.todayApi.schedule(settings, { projectId, line: task.line, raw: task.raw, date });
}

const unmarked = (line: string): string => line.replace(/^(\s*[-*]\s+\[)[ xX-](\])/, "$1$2");

function missingLines(expected: string[], content: string): string[] {
  const lines = content.split(/\r\n|\n/).map(unmarked);
  const missing: string[] = [];
  let at = 0;
  for (const line of expected) {
    let found = at;
    while (found < lines.length && lines[found] !== unmarked(line)) found += 1;
    if (found >= lines.length) missing.push(line);
    else at = found + 1;
  }
  return missing;
}

function dailyPath(root: string): string {
  return join(root, "daily", `${TODAY}.md`);
}

function editDaily(root: string, change: (content: string) => string): void {
  const file = dailyPath(root);
  writeFileSync(file, change(readFileSync(file, "utf8")));
  today.queueDailyDiskChange(TODAY);
}

describe("finding 1: a focus line linked to a task of another date", () => {
  it("G00c: keeps the line and its custom text through every mirror run and brings the carried task to the day of the line", () => {
    const root = lab(
      {
        alpha: project("Alpha Project", [`- [ ] Ship release ${SCHEDULED} ${TODAY}`]),
        beta: project("Beta Project", [`- [ ] Old carried thing ${SCHEDULED} ${YESTERDAY}`]),
      },
      { [TODAY]: dailyWith(["- [ ] [[alpha|Alpha Project]] - Ship release"]) },
    );
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const custom = "- [ ] [[beta|Beta Project]] - Old carried thing (Obsidian note: ask legal)";
    editDaily(root, (content) => content.replace("- [ ] [[alpha|Alpha Project]] - Ship release\n", `- [ ] [[alpha|Alpha Project]] - Ship release\n${custom}\n`));
    const edited = readFileSync(dailyPath(root), "utf8");
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const ship = taskIn(settings, "alpha", "Ship release");
    board.writeBoardTaskSynced(settings, { projectId: "alpha", line: ship.line, raw: ship.raw, status: "doing" });
    today.flushMirrors(settings);
    const content = readFileSync(dailyPath(root), "utf8");
    assert.ok(content.split("\n").includes(custom));
    assert.deepEqual(missingLines(edited.split("\n"), content), []);
    assert.equal(taskIn(settings, "beta", "Old carried thing").scheduled, TODAY);
    const payload = today.readToday(settings, TODAY);
    assert.equal(payload.inNote.includes(custom), false);
    assert.ok(payload.focus.some((entry) => entry.task.title === "Old carried thing"));
  });
});

describe("finding 2: unschedule, reschedule, rename and move keep the daily as it is", () => {
  const LINE = "- [ ] [[alpha|Alpha Project]] - Ship release (call Ana first, she has the keys)";
  const setup = (): { root: string; settings: DelegationSettings; primed: string } => {
    const root = lab(
      { alpha: project("Alpha Project", [`- [ ] Ship release ${SCHEDULED} ${TODAY}`, "- [ ] Other"]), beta: project("Beta Project", ["- [ ] Beta task"]) },
      { [TODAY]: dailyWith([LINE]) },
    );
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const primed = readFileSync(dailyPath(root), "utf8");
    assert.ok(primed.split("\n").includes(LINE));
    return { root, settings, primed };
  };

  it("G00c: unschedule removes the line of the task from the daily and nothing else", () => {
    const { root, settings, primed } = setup();
    scheduleOf(settings, "alpha", "Ship release", null);
    today.flushMirrors(settings);
    assert.equal(readFileSync(dailyPath(root), "utf8"), primed.replace(`${LINE}\n\n`, ""));
    const payload = today.readToday(settings, TODAY);
    assert.deepEqual(payload.focus, []);
    assert.deepEqual(payload.inNote, []);
  });

  it("H3: rename through the board item write renames the custom line, keeps its suffix, adds no generated line and keeps the task in the focus", () => {
    const { root, settings, primed } = setup();
    const task = taskIn(settings, "alpha", "Ship release");
    board.writeBoardTaskSynced(settings, { projectId: "alpha", line: task.line, raw: task.raw, title: "Ship the new release" });
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), primed.replace(LINE, "- [ ] [[alpha|Alpha Project]] - Ship the new release (call Ana first, she has the keys)"));
    assert.equal(primed.includes("Ship the new release"), false);
    const payload = today.readToday(settings, TODAY);
    assert.deepEqual(payload.inNote, []);
    assert.deepEqual(payload.focus.map((entry) => entry.task.title), ["Ship the new release"]);
    assert.equal(taskIn(settings, "alpha", "Ship the new release").scheduled, TODAY);
  });

  it("G00c: reschedule to another date moves the line out, bringing it back writes a fresh line, and a move to another project leaves the daily alone", () => {
    const { root, settings, primed } = setup();
    scheduleOf(settings, "alpha", "Ship release", TOMORROW);
    const moved = primed.replace(`${LINE}\n\n`, "");
    assert.equal(readFileSync(dailyPath(root), "utf8"), moved);
    assert.equal(taskIn(settings, "alpha", "Ship release").scheduled, TOMORROW);
    scheduleOf(settings, "alpha", "Ship release", TODAY);
    const back = readFileSync(dailyPath(root), "utf8");
    assert.deepEqual(missingLines(moved.split("\n"), back), []);
    assert.ok(back.includes("- [ ] [[alpha|Alpha Project]] - Ship release\n"));
    const task = taskIn(settings, "alpha", "Ship release");
    board.moveTaskToProject(settings, { projectId: "alpha", line: task.line, raw: task.raw, targetProjectId: "beta", parent: null });
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(taskIn(settings, "beta", "Ship release").scheduled, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), back);
  });
});

describe("findings 3 and 4: a hub restart keeps the persisted baseline", () => {
  const boxes: Sandbox[] = [];
  const hubs: RunningServer[] = [];

  after(async () => {
    for (const hub of hubs) await stop(hub);
    for (const box of boxes) rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function stop(hub: RunningServer): Promise<void> {
    if (hub.child.exitCode !== null || hub.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      hub.child.once("exit", () => resolve());
      hub.child.kill();
    });
  }

  async function boot(box: Sandbox): Promise<RunningServer> {
    const hub = await startServer(box, { HUB_DELEGATION: "1", HUB_SHARE_PORT: String(await freePort()) });
    hubs.push(hub);
    return hub;
  }

  async function http(hub: RunningServer, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  async function prepare(projectText: string): Promise<{ box: Sandbox; hub: RunningServer }> {
    const box = makeSandbox("cch-today-restart-");
    boxes.push(box);
    write(box.brain, "_templates/daily.md", TEMPLATE);
    write(box.brain, "projects/alpha.md", projectText);
    const hub = await boot(box);
    const saved = await http(hub, "PUT", "/delegation/settings", {
      secondBrainRoot: box.brain,
      features: { daily: true, tasks: true },
      tasks: { root: "projects", doneSection: "Done loops" },
      daily: { dir: "daily", template: "_templates/daily.md", wikilinks: true, focusSource: "scheduled" },
    });
    assert.equal(saved.status, 200);
    return { box, hub };
  }

  async function boardTasks(hub: RunningServer): Promise<BoardTask[]> {
    return flatten((await http(hub, "GET", "/delegation/tasks-board")).json.tasks as BoardTask[]);
  }

  it("finding 3: a task finished in the project while the hub was down is never reopened by an unrelated daily edit", async () => {
    const { box, hub } = await prepare(project("Alpha Project", ["- [ ] Ship release", "- [ ] Other task"]));
    assert.deepEqual((await http(hub, "POST", `/delegation/today/${TODAY}/create`)).json, { dailyExists: true });
    const ship = (await boardTasks(hub)).find((task) => task.title === "Ship release") as BoardTask;
    assert.equal((await http(hub, "POST", `/delegation/today/${TODAY}/schedule`, { projectId: "alpha", line: ship.line, raw: ship.raw, date: TODAY })).status, 200);
    const dailyFile = join(box.brain, "daily", `${TODAY}.md`);
    assert.ok(readFileSync(dailyFile, "utf8").includes("- [ ] [[alpha|Alpha Project]] - Ship release\n"));
    await stop(hub);
    const projectFile = join(box.brain, "projects", "alpha.md");
    const finished = `- [x] Ship release ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`;
    writeFileSync(projectFile, readFileSync(projectFile, "utf8").replace(`- [ ] Ship release ${SCHEDULED} ${TODAY}`, finished));
    const second = await boot(box);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const edited = readFileSync(dailyFile, "utf8").replace("## Meetings\n\n-\n", "## Meetings\n\n- 15:00 Unrelated sync\n");
    writeFileSync(dailyFile, edited);
    await waitFor(async () => (readFileSync(dailyFile, "utf8").includes("- [x] [[alpha|Alpha Project]] - Ship release\n") ? true : null), 10000);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const projectText = readFileSync(projectFile, "utf8");
    assert.ok(projectText.includes(finished));
    assert.equal(projectText.includes("- [ ] Ship release"), false);
    const after = readFileSync(dailyFile, "utf8");
    assert.ok(after.includes("- 15:00 Unrelated sync\n"));
    assert.deepEqual(missingLines(edited.split("\n"), after), []);
    assert.equal((await boardTasks(second)).find((task) => task.title.startsWith("Ship release"))?.status, "done");
  });

  it("finding 4 and finding 5 over HTTP: compose schedules the picks, and a tick made while the hub was down reaches the project after the restart", async () => {
    const { box, hub } = await prepare(project("Alpha Project", ["- [ ] Write notes", "- [ ] Other task", "- [ ] Not picked"]));
    const composed = await http(hub, "POST", `/delegation/daily/${TODAY}/compose`, {
      focus: [
        { project: "alpha", text: "Write notes" },
        { project: "alpha", text: "Other task" },
        { project: null, text: "a free item" },
      ],
      meetings: [],
    });
    assert.equal(composed.status, 200);
    const projectFile = join(box.brain, "projects", "alpha.md");
    const projectText = readFileSync(projectFile, "utf8");
    assert.ok(projectText.includes(`- [ ] Write notes ${SCHEDULED} ${TODAY}`));
    assert.ok(projectText.includes(`- [ ] Other task ${SCHEDULED} ${TODAY}`));
    assert.ok(projectText.includes("- [ ] Not picked\n"));
    const dailyFile = join(box.brain, "daily", `${TODAY}.md`);
    const composedText = readFileSync(dailyFile, "utf8");
    assert.ok(composedText.includes("- [ ] [[alpha|Alpha Project]] - Write notes\n"));
    assert.ok(composedText.includes("- [ ] a free item\n"));
    await stop(hub);
    writeFileSync(dailyFile, composedText.replace("- [ ] [[alpha|Alpha Project]] - Write notes", "- [x] [[alpha|Alpha Project]] - Write notes"));
    const ticked = readFileSync(dailyFile, "utf8");
    const second = await boot(box);
    const other = (await boardTasks(second)).find((task) => task.title === "Other task") as BoardTask;
    const renamed = await http(second, "PATCH", "/delegation/tasks-board/item", { projectId: "alpha", line: other.line, raw: other.raw, title: "Other task renamed" });
    assert.equal(renamed.status, 200);
    const notes = (await boardTasks(second)).find((task) => task.title === "Write notes");
    assert.equal(notes?.status, "done");
    assert.ok(readFileSync(projectFile, "utf8").includes(`- [x] Write notes ${SCHEDULED} ${TODAY}`));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = readFileSync(dailyFile, "utf8");
    assert.equal(after, ticked.replace("- [ ] [[alpha|Alpha Project]] - Other task\n", "- [ ] [[alpha|Alpha Project]] - Other task renamed\n"));
  });
});

describe("finding 5: the plan wizard compose schedules the picks", () => {
  it("schedules the board picks, keeps the free items as lines and appends the other tasks of the day", () => {
    const root = lab({
      lab: project("Lab", ["- [ ] Pick me", "- [-] Doing pick", `- [ ] Already today ${SCHEDULED} ${TODAY}`, "- [ ] Not picked", "- [ ] Free idea elsewhere"]),
    });
    const settings = useVault(root);
    const content = daily.composeDaily(
      daily.dailyTemplateText(settings),
      {
        focus: [
          { project: "lab", text: "Pick me" },
          { project: null, text: "Free idea" },
          { project: null, text: "Doing pick", block: "- [-] [[lab|Lab]] - Doing pick" },
        ],
        meetings: [],
        sessions: [],
      },
      { date: TODAY, headings: settings.daily.headings, wikilinks: true, board: board.composeBoardFor(settings) },
    );
    daily.writeDaily(settings, TODAY, content);
    const projectText = read(root, "projects/lab.md");
    assert.ok(projectText.includes(`- [ ] Pick me ${SCHEDULED} ${TODAY}`));
    assert.ok(projectText.includes(`- [-] Doing pick ${SCHEDULED} ${TODAY}`));
    assert.ok(projectText.includes("- [ ] Not picked\n"));
    assert.ok(projectText.includes("- [ ] Free idea elsewhere\n"));
    const written = read(root, `daily/${TODAY}.md`);
    assert.deepEqual(missingLines(content.split("\n"), written), []);
    assert.ok(written.includes("- [ ] [[lab|Lab]] - Already today"));
    assert.ok(written.includes("- [ ] Free idea\n"));
    assert.deepEqual(
      today.todayApi.focusOf(settings, TODAY).map((entry) => entry.task.title),
      ["Pick me", "Doing pick", "Already today"],
    );
  });
});

describe("finding 6: notes nested under a task that leaves the day", () => {
  it("G00c: leave with the line of the task, and the block of a task that stays keeps its notes", () => {
    const focus = ["- [ ] [[lab|Lab]] - Leaving task", "  - note A that belongs to leaving", "  - [ ] Leaving sub", "- [ ] [[lab|Lab]] - Staying task", "  - note B"];
    const root = lab(
      { lab: project("Lab", [`- [ ] Leaving task ${SCHEDULED} ${TODAY}`, "  - [ ] Leaving sub", `- [ ] Staying task ${SCHEDULED} ${TODAY}`]) },
      { [TODAY]: dailyWith(focus) },
    );
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const primed = readFileSync(dailyPath(root), "utf8");
    assert.ok(primed.includes(`${focus.join("\n")}\n`));
    scheduleOf(settings, "lab", "Leaving task", null);
    today.flushMirrors(settings);
    assert.equal(readFileSync(dailyPath(root), "utf8"), primed.replace(`${focus.slice(0, 3).join("\n")}\n`, ""));
    const staying = taskIn(settings, "lab", "Staying task");
    board.createBoardTask(settings, { projectId: "lab", title: "New staying sub", status: "todo", parentLine: staying.line, parentRaw: staying.raw });
    today.flushMirrors(settings);
    assert.ok(!readFileSync(dailyPath(root), "utf8").includes("New staying sub"));
    const sub = taskIn(settings, "lab", "New staying sub");
    today.todayApi.planSubtask(settings, TODAY, { projectId: "lab", line: sub.line, raw: sub.raw, planned: true });
    today.flushMirrors(settings);
    const after = readFileSync(dailyPath(root), "utf8");
    assert.ok(after.includes("## Focus\n\n- [ ] [[lab|Lab]] - Staying task\n  - note B\n  - [ ] New staying sub\n"));
  });
});

describe("finding 7: duplicate lines", () => {
  it("H3: are merged into one line by the mirror after the first migration, keeping the free line", () => {
    const focus = ["- [ ] [[lab|Lab]] - Mig one", "- [ ] [[lab|Lab]] - Mig one", "- [ ] free"];
    const root = lab({ lab: project("Lab", ["- [ ] Mig one"]) }, { [TODAY]: dailyWith(focus) });
    const settings = useVault(root);
    const before = readFileSync(dailyPath(root), "utf8");
    const result = today.todayApi.migrateFocus(settings, TODAY);
    assert.equal(result.scheduled, 1);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const after = readFileSync(dailyPath(root), "utf8");
    assert.equal(after, before.replace("- [ ] [[lab|Lab]] - Mig one\n- [ ] [[lab|Lab]] - Mig one\n", "- [ ] [[lab|Lab]] - Mig one\n"));
    assert.equal(after.split("\n").filter((line) => line === "- [ ] [[lab|Lab]] - Mig one").length, 1);
    assert.equal(taskIn(settings, "lab", "Mig one").scheduled, TODAY);
  });
});

describe("finding 8: a tick on a line whose title is shared by two tasks", () => {
  it("reaches no task, appends no copy and is reported as ambiguous", () => {
    const LINE = "- [ ] [[lab|Lab]] - Same title";
    const root = lab({ lab: project("Lab", [`- [ ] Same title ${SCHEDULED} ${TODAY}`, "- [ ] Same title"]) }, { [TODAY]: dailyWith([LINE]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([LINE]));
    editDaily(root, (content) => content.replace(LINE, "- [x] [[lab|Lab]] - Same title"));
    const ticked = readFileSync(dailyPath(root), "utf8");
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), ticked);
    const projectText = read(root, "projects/lab.md");
    assert.ok(projectText.includes(`- [ ] Same title ${SCHEDULED} ${TODAY}\n- [ ] Same title\n`));
    const payload = today.readToday(settings, TODAY);
    assert.deepEqual(
      payload.ambiguous.map((item) => [item.kind, item.reason]),
      [
        ["line", "several-tasks"],
        ["task", "unclear-line"],
      ],
    );
    assert.equal(payload.ambiguous[0]?.text, "- [x] [[lab|Lab]] - Same title");
  });
});

describe("tick conflicts", () => {
  it("leave both sides alone when the daily and the project changed differently since the baseline", () => {
    const LINE = "- [ ] [[lab|Lab]] - Both sides";
    const root = lab({ lab: project("Lab", [`- [ ] Both sides ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([LINE]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    writeFileSync(dailyPath(root), readFileSync(dailyPath(root), "utf8").replace(LINE, "- [x] [[lab|Lab]] - Both sides"));
    const ticked = readFileSync(dailyPath(root), "utf8");
    const task = taskIn(settings, "lab", "Both sides");
    board.writeBoardTask(settings, { projectId: "lab", line: task.line, raw: task.raw, status: "doing" });
    today.queueDailyDiskChange(TODAY);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "lab", "Both sides").status, "doing");
    assert.equal(readFileSync(dailyPath(root), "utf8"), ticked);
    assert.deepEqual(today.todayApi.regenerateFocusMirror(settings, TODAY), { changed: false, skipped: null, applied: 0 });
  });

  it("G00c: never sync the checkbox of a line the hub wrote whose task carries no scheduled date", () => {
    const root = lab({ lab: project("Lab", ["- [ ] Legacy linked"]) });
    const settings = useVault(root);
    daily.writeDaily(settings, TODAY, dailyWith(["- [ ] [[lab|Lab]] - Legacy linked"]));
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(taskIn(settings, "lab", "Legacy linked").scheduled, null);
    const task = taskIn(settings, "lab", "Legacy linked");
    board.writeBoardTask(settings, { projectId: "lab", line: task.line, raw: task.raw, status: "doing" });
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith(["- [ ] [[lab|Lab]] - Legacy linked"]));
  });
});

describe("baseline", () => {
  it("is stored per date in its own table, adopted without changing either side and replaced when the vault path changes", () => {
    const root = lab({ lab: project("Lab", [`- [-] Started ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith(["- [x] [[lab|Lab]] - Started"]) });
    const settings = useVault(root);
    store.deleteTodayBaseline(TODAY);
    const projectBefore = read(root, "projects/lab.md");
    const dailyBefore = readFileSync(dailyPath(root), "utf8");
    assert.deepEqual(today.todayApi.regenerateFocusMirror(settings, TODAY), { changed: false, skipped: null, applied: 0 });
    assert.equal(read(root, "projects/lab.md"), projectBefore);
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyBefore);
    const stored = store.getTodayBaseline(TODAY);
    assert.equal(stored?.content, dailyBefore);
    assert.equal(stored?.path, dailyPath(root));
    const other = lab({ lab: project("Lab", [`- [ ] Started ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith(["- [x] [[lab|Lab]] - Started"]) });
    const otherSettings = useVault(other);
    today.todayApi.regenerateFocusMirror(otherSettings, TODAY);
    assert.equal(taskIn(otherSettings, "lab", "Started").status, "todo");
    assert.equal(store.getTodayBaseline(TODAY)?.path, dailyPath(other));
  });
});

interface Fixture {
  name: string;
  daily: string;
  bom: boolean;
  crlf: boolean;
}

const ALPHA = project("Alpha Project", [
  `- [ ] Fix - the parser ${SCHEDULED} ${TODAY}`,
  "  - [ ] Write the failing case",
  "  - a note under the parser",
  "- [ ] Write docs",
  `- [-] Plan sprint ${SCHEDULED} ${YESTERDAY}`,
]);
const BETA = `${BOM}${project("Beta Project", [`- [ ] Ship it ${SCHEDULED} ${TODAY}`, "- [ ] Call vendor"]).replace(/\n/g, "\r\n")}`;

const FIXTURES: Fixture[] = [
  {
    name: "crlf, bom, nested foreign lines and aliased wikilinks",
    bom: true,
    crlf: true,
    daily: `${BOM}${[
      "---",
      "type: daily",
      "---",
      "",
      `# ${TODAY}`,
      "",
      "## Focus",
      "",
      "- [ ] [[alpha|Alpha Project]] - Fix - the parser (pair with Bia)",
      "  - my own nested note",
      "    - deeper foreign line",
      "- [x] [[beta|Beta]] - Call vendor",
      "- free text line",
      "some paragraph without a bullet",
      "",
      "## Meetings",
      "",
      "- 10:00 Sync",
      "",
    ].join("\r\n")}`,
  },
  {
    name: "heading with trailing spaces, no meetings section and a title with a dash",
    bom: false,
    crlf: false,
    daily: [`# ${TODAY}`, "", "## Focus   ", "", "- [ ] [[beta|Beta]] - Ship it", "- [ ] Something unlinked - with a dash", "", "## Captures", "", "- idea", ""].join("\n"),
  },
  {
    name: "no focus section at all",
    bom: false,
    crlf: false,
    daily: [`# ${TODAY}`, "", "## Meetings", "", "- 09:00 Standup", ""].join("\n"),
  },
];

function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("property: every user line survives any sequence of operations, only exact duplicates of a surviving line are removed and renames are reported", () => {
  const OPEN: ReadonlySet<string> = new Set(["todo", "doing", "blocked", "hold"]);
  const BOX_RE = /^(\s*[-*]\s+\[)([ xX-])(\])/;
  const checkboxOf = (line: string): "todo" | "doing" | "done" | null => {
    const mark = line.match(BOX_RE)?.[2];
    if (mark === undefined) return null;
    return mark === " " ? "todo" : mark === "-" ? "doing" : "done";
  };
  const statusBox = (status: string): string | null => (status === "todo" ? "todo" : status === "doing" ? "doing" : status === "done" ? "done" : null);

  for (const fixture of FIXTURES) {
    for (const seed of [7, 19, 42, 77, 123, 1592]) {
      it(`${fixture.name}, seed ${seed}`, () => {
        const root = lab({ alpha: ALPHA, beta: BETA }, { [TODAY]: fixture.daily });
        const settings = useVault(root);
        const random = prng(seed);
        const pick = <T>(items: T[]): T | undefined => items[Math.floor(random() * items.length)];
        const expected = fixture.daily.split(/\r\n|\n/);
        const keyOf = (task: BoardTask): string => `${task.projectId}|${task.title}`;
        const allTasks = (): BoardTask[] => flatten(board.readBoard(settings).tasks);
        const openTasks = (): BoardTask[] => allTasks().filter((task) => task.section === "open" && task.status !== "archived");
        const identities = new Map<string, string>();
        const copies: string[] = [];
        const released = new Map<string, number>();
        const renameKey = (from: string, to: string): void => {
          for (const [line, key] of identities) if (key === from) identities.set(line, to);
        };
        const readContent = (): string => readFileSync(dailyPath(root), "utf8");
        const eolOf = (content: string): string => (content.includes("\r\n") ? "\r\n" : "\n");
        const scopeKeys = (): Set<string> => {
          const keys = new Set<string>();
          const visit = (task: BoardTask, covered: boolean): void => {
            const hit = covered || task.scheduled === TODAY || (task.status === "done" && task.scheduled !== null && task.scheduled <= TODAY && task.doneAt === TODAY);
            if (hit) keys.add(keyOf(task));
            for (const subtask of task.subtasks) visit(subtask, hit);
          };
          for (const task of board.readBoard(settings).tasks) visit(task, false);
          return keys;
        };
        const lineTask = (content: string, index: number): { key: string; tracked: boolean } | null => {
          const payload = board.readBoard(settings);
          const link = board.scanDaily(settings, TODAY, content, payload.projects, payload.tasks).links.find((item) => item.line === index);
          const remembered = identities.get(unmarked(content.split(/\r\n|\n/)[index] ?? ""));
          const key = link ? keyOf(link.task) : (remembered ?? null);
          return key === null ? null : { key, tracked: scopeKeys().has(key) || remembered === key };
        };
        const remember = (): void => {
          const content = readContent();
          const payload = board.readBoard(settings);
          const scoped = scopeKeys();
          const texts = content.split(/\r\n|\n/);
          for (const link of board.scanDaily(settings, TODAY, content, payload.projects, payload.tasks).links) {
            const key = keyOf(link.task);
            if (scoped.has(key)) identities.set(unmarked(texts[link.line] as string), key);
          }
        };
        const canon = (line: string): string => {
          const rest = line.match(/^\s*[-*+]\s+\[[ xX-]\]\s?(.*)$/)?.[1];
          return rest === undefined ? line.trim() : rest.replace(/^\[\[[^\]]*\]\]\s+-\s+/, "").trim();
        };
        const variants = (text: string): { core: string; suffix: string | null }[] => {
          const split = text.match(/^(.*\S)\s+(_[^_\s](?:[^_]*[^_\s])?_)$/);
          return split === null ? [{ core: text, suffix: null }] : [{ core: text, suffix: null }, { core: split[1] as string, suffix: split[2] as string }];
        };
        const duplicateOf = (gone: string, survivors: string[], titles: ReadonlySet<string>): boolean =>
          variants(gone).some(
            (removed) =>
              titles.has(removed.core) &&
              survivors.some((kept) =>
                variants(kept).some((item) => (item.core === removed.core || board.stripInlineMarkup(item.core) === removed.core) && (removed.suffix === null || item.suffix === removed.suffix)),
              ),
          );
        const check = (step: string): void => {
          const content = readContent();
          const lines = content.split(/\r\n|\n/);
          const canons = lines.map(canon);
          const left = new Map<string, number>();
          for (const text of canons) left.set(text, (left.get(text) ?? 0) + 1);
          const renamed = today
            .readToday(settings, TODAY)
            .ambiguous.filter((item) => item.reason === "renamed")
            .map((item) => item.text.split(" -> ") as [string, string]);
          const titles = new Set(allTasks().flatMap((item) => [item.title, item.reason === null ? item.title : `${item.title} - ${item.reason}`]));
          const missing: string[] = [];
          const next: string[] = [];
          for (const line of expected) {
            const text = canon(line);
            const count = left.get(text) ?? 0;
            if (count > 0) {
              left.set(text, count - 1);
              next.push(line);
              continue;
            }
            const rename = renamed.find(([from, to]) => from === text && canons.includes(to));
            if (rename !== undefined) {
              next.push(`- [ ] ${rename[1]}`);
              continue;
            }
            const sources = renamed.flatMap(([from, to]) => (canons.includes(to) ? [from] : []));
            if (duplicateOf(text, canons, titles) || duplicateOf(text, sources, new Set([...titles, ...sources.flatMap((from) => variants(from).map((item) => item.core))]))) continue;
            const freed = released.get(text) ?? 0;
            if (freed > 0) {
              released.set(text, freed - 1);
              continue;
            }
            missing.push(line);
            next.push(line);
          }
          assert.deepEqual(missing, [], `${step} CONTENT ${JSON.stringify(content)} EXPECTED ${JSON.stringify(expected)}`);
          expected.splice(0, expected.length, ...next);
          released.clear();
          if (fixture.bom) assert.equal(content.startsWith(BOM), true, step);
          if (fixture.crlf) assert.equal(content.replace(/\r\n/g, "").includes("\n"), false, step);
        };
        const matched = (lines: string[]): number[] => {
          const plain = lines.map(unmarked);
          const out: number[] = [];
          let at = 0;
          for (const line of expected) {
            const wanted = unmarked(line);
            while (at < plain.length && plain[at] !== wanted) at += 1;
            out.push(at);
            at += 1;
          }
          return out;
        };
        const slotFor = (lines: string[], index: number): number => matched(lines).filter((position) => position < index).length;
        const boxLines = (content: string, nested: boolean | null): number[] =>
          content.split(/\r\n|\n/).flatMap((line, index) => (BOX_RE.test(line) && (nested === null || /^\s+/.test(line) === nested) ? [index] : []));
        const toggle = (content: string, index: number): { content: string; line: string; before: string | null; after: string | null } => {
          const lines = content.split(/\r\n|\n/);
          const old = lines[index] as string;
          const mark = random() < 0.5 ? "x" : " ";
          lines[index] = old.replace(BOX_RE, (_whole, open: string, _mark: string, close: string) => `${open}${mark}${close}`);
          return { content: lines.join(eolOf(content)), line: lines[index] as string, before: checkboxOf(old), after: checkboxOf(lines[index] as string) };
        };
        today.todayApi.regenerateFocusMirror(settings, TODAY);
        check("prime");
        remember();
        for (let step = 0; step < 18; step += 1) {
          const draw = Math.floor(random() * 28);
          const op = draw >= 24 ? 20 + (draw % 2) : draw >= 18 ? 18 + (draw % 2) : draw;
          const label = `seed ${seed} step ${step} op ${op}`;
          const task = pick(openTasks());
          const statusBefore = new Map(allTasks().map((item) => [keyOf(item), item.status]));
          const renames = new Map<string, string>();
          const allowedReopen = new Set<string>();
          const ticks: { line: string; key: string; checkbox: string }[] = [];
          const userTick = (content: string, index: number, result: { line: string; before: string | null; after: string | null }): void => {
            const found = lineTask(content, index);
            if (found === null || result.after === null || result.before === result.after) return;
            if (result.before === "done") allowedReopen.add(found.key);
            ticks.push({ line: result.line, key: found.key, checkbox: result.after });
          };
          try {
            if (op === 0 && task) {
              const date = pick([TODAY, TOMORROW, null]) ?? null;
              if (date !== TODAY) {
                const content = readContent();
                const payload = board.readBoard(settings);
                const lines = content.split(/\r\n|\n/);
                const depthAt = (index: number): number => (lines[index]?.match(/^\s*/)?.[0] ?? "").length;
                for (const link of board.scanDaily(settings, TODAY, content, payload.projects, payload.tasks).links.filter((item) => item.task.id === task.id)) {
                  for (let index = link.line; index === link.line || (index < lines.length && (lines[index] as string).trim() !== "" && depthAt(index) > depthAt(link.line)); index += 1) {
                    const text = canon(lines[index] as string);
                    released.set(text, (released.get(text) ?? 0) + 1);
                  }
                }
              }
              today.todayApi.schedule(settings, { projectId: task.projectId, line: task.line, raw: task.raw, date });
            }
            if (op === 1 && task) {
              allowedReopen.add(keyOf(task));
              board.writeBoardTaskSynced(settings, { projectId: task.projectId, line: task.line, raw: task.raw, status: pick(["todo", "doing", "done"] as const) ?? "done" });
            }
            if (op === 2 && task) {
              const title = `${task.title} r${step}`;
              board.writeBoardTaskSynced(settings, { projectId: task.projectId, line: task.line, raw: task.raw, title });
              renames.set(keyOf(task), `${task.projectId}|${title}`);
            }
            if (op === 3 || op === 13) {
              const content = readContent();
              const at = pick(boxLines(content, op === 13 ? true : null));
              if (at !== undefined) {
                const result = toggle(content, at);
                writeFileSync(dailyPath(root), result.content);
                userTick(result.content, at, result);
                today.queueDailyDiskChange(TODAY);
              }
            }
            if (op === 4) {
              const added = `- [ ] typed by hand ${seed}-${step}`;
              const content = readContent();
              const lines = content.split(/\r\n|\n/);
              const heading = lines.findIndex((line) => line.trim() === "## Focus");
              const at = heading === -1 ? lines.length - 1 : heading + 1;
              expected.splice(slotFor(lines, at), 0, added);
              lines.splice(at, 0, added);
              writeFileSync(dailyPath(root), lines.join(eolOf(content)));
              today.queueDailyDiskChange(TODAY);
            }
            if (op === 5) today.todayApi.migrateFocus(settings, TODAY);
            if (op === 6) today.todayApi.appendCapture(settings, TODAY, `captured ${step}`);
            if (op === 7) today.todayApi.regenerateFocusMirror(settings, TODAY);
            if (op === 8) board.createBoardTask(settings, { projectId: pick(["alpha", "beta"]) ?? "alpha", title: `Created ${seed} ${step}`, status: "todo", scheduled: TODAY });
            if (op === 9) {
              today.forgetTodayState();
              today.todayApi.regenerateFocusMirror(settings, TODAY);
            }
            if (op === 10) {
              const content = readContent();
              const at = pick(boxLines(content, null));
              if (at !== undefined) {
                const result = toggle(content, at);
                userTick(result.content, at, result);
                today.saveDailyFromClient(settings, TODAY, result.content);
              }
            }
            if (op === 11) {
              const content = readContent();
              const payload = board.readBoard(settings);
              const linked = board.scanDaily(settings, TODAY, content, payload.projects, payload.tasks).links.filter((link) => link.depth === 0);
              const chosen = pick(linked);
              if (chosen) {
                const lines = content.split(/\r\n|\n/);
                const original = lines[chosen.line] as string;
                const copy = random() < 0.5 ? original.replace(BOX_RE, "$1 $3") : original.replace(BOX_RE, "$1x$3");
                const at = random() < 0.5 ? chosen.line : chosen.line + 1;
                expected.splice(slotFor(lines, at), 0, copy);
                copies.push(unmarked(copy));
                lines.splice(at, 0, copy);
                today.saveDailyFromClient(settings, TODAY, lines.join(eolOf(content)));
              }
            }
            if (op === 12) {
              const text = copies.pop();
              if (text !== undefined) {
                const content = readContent();
                const lines = content.split(/\r\n|\n/);
                const at = lines.map(unmarked).lastIndexOf(text);
                if (at !== -1 && lines.filter((line) => unmarked(line) === text).length >= 2) {
                  const inExpected = expected.findIndex((line) => canon(line) === canon(lines[at] as string));
                  if (inExpected !== -1) expected.splice(inExpected, 1);
                  lines.splice(at, 1);
                  today.saveDailyFromClient(settings, TODAY, lines.join(eolOf(content)));
                }
              }
            }
            if (op === 14 && task) {
              const file = join(root, "projects", `${task.projectId}.md`);
              const text = readFileSync(file, "utf8");
              const lines = text.split(/(\r\n|\n)/);
              const index = lines.indexOf(task.raw);
              if (index !== -1 && task.raw.includes(task.title)) {
                const title = `${task.title} d${step}`;
                lines[index] = task.raw.replace(task.title, title);
                writeFileSync(file, lines.join(""));
                renames.set(keyOf(task), `${task.projectId}|${title}`);
              }
            }
            if (op === 15) {
              const content = readContent();
              const payload = board.readBoard(settings);
              const chosen = pick(board.scanDaily(settings, TODAY, content, payload.projects, payload.tasks).links.filter((link) => link.depth === 0));
              if (chosen) {
                const lines = content.split(/\r\n|\n/);
                const original = lines[chosen.line] as string;
                const reworded = `${original} asap`;
                const at = expected.findIndex((line) => canon(line) === canon(original));
                if (at !== -1 && lines.filter((line) => unmarked(line) === unmarked(original)).length === 1) {
                  lines[chosen.line] = reworded;
                  expected[at] = reworded;
                  const key = identities.get(unmarked(original));
                  if (key !== undefined) identities.set(unmarked(reworded), key);
                  today.saveDailyFromClient(settings, TODAY, lines.join(eolOf(content)));
                }
              }
            }
            if (op === 16 || op === 17) {
              const content = readContent();
              const payload = board.readBoard(settings);
              const links = board.scanDaily(settings, TODAY, content, payload.projects, payload.tasks).links;
              const lines = content.split(/\r\n|\n/);
              const heading = lines.findIndex((line) => line.trim() === "## Focus");
              let sectionEnd = heading + 1;
              while (heading !== -1 && sectionEnd < lines.length && !/^##\s/.test(lines[sectionEnd] as string)) sectionEnd += 1;
              let last = sectionEnd - 1;
              while (last > heading && (lines[last] as string).trim() === "") last -= 1;
              const leadOf = (text: string): number => (text.match(/^\s*/)?.[0] ?? "").length;
              const blockEnd = (start: number): number => {
                let end = start + 1;
                while (end < sectionEnd && (lines[end] as string).trim() !== "" && leadOf(lines[end] as string) > leadOf(lines[start] as string)) end += 1;
                return end;
              };
              const chosen = pick(links.filter((link) => (op === 16 ? link.depth === 0 : link.depth > 0)));
              if (chosen && heading !== -1) {
                const start = chosen.line;
                const end = blockEnd(start);
                const subtree = new Set(Array.from({ length: end - start }, (_unused, k) => start + k));
                const rest = lines.map((_line, index) => index).filter((index) => !subtree.has(index));
                let after: number | null = null;
                let lead = "";
                if (op === 16) {
                  after = random() < 0.5 ? heading : last;
                } else {
                  const parents = links.filter((link) => link.depth === 0 && !(link.line < start && blockEnd(link.line) >= end));
                  const parent = random() < 0.3 ? undefined : pick(parents);
                  if (parent) {
                    after = blockEnd(parent.line) - 1;
                    lead = `${(lines[parent.line] as string).match(/^\s*/)?.[0] ?? ""}  `;
                  } else {
                    after = last;
                  }
                }
                const at = after === null || subtree.has(after) ? -1 : rest.indexOf(after);
                if (at !== -1) {
                  const order = [...rest.slice(0, at + 1), ...subtree, ...rest.slice(at + 1)];
                  const shift = leadOf(lines[start] as string);
                  const textAt = (index: number): string => {
                    const text = lines[index] as string;
                    return op === 17 && subtree.has(index) ? `${lead}${text.slice(shift)}` : text;
                  };
                  const moved = order.map(textAt);
                  const newIndex = new Map(order.map((index, position) => [index, position]));
                  const positions = matched(lines);
                  const next = expected.map((text, k) => {
                    const old = positions[k] as number;
                    return { text: subtree.has(old) ? textAt(old) : text, at: newIndex.get(old) ?? Number.MAX_SAFE_INTEGER };
                  });
                  expected.splice(0, expected.length, ...next.sort((a, b) => a.at - b.at).map((item) => item.text));
                  for (const index of subtree) {
                    const key = identities.get(unmarked(lines[index] as string));
                    if (key !== undefined) identities.set(unmarked(textAt(index)), key);
                  }
                  const headAt = newIndex.get(start) as number;
                  const plain = moved.join(eolOf(content));
                  const result = random() < 0.5 ? toggle(plain, headAt) : null;
                  const saved = result === null ? plain : result.content;
                  if (result !== null) userTick(saved, headAt, result);
                  if (random() < 0.5) {
                    writeFileSync(dailyPath(root), saved);
                    today.queueDailyDiskChange(TODAY);
                  } else {
                    today.saveDailyFromClient(settings, TODAY, saved);
                  }
                }
              }
            }
            if (op === 20 && task) {
              const siblings = openTasks().filter((item) => item.projectId === task.projectId && item.id !== task.id && !flatten(task.subtasks).some((sub) => sub.id === item.id));
              const parent = random() < 0.4 ? null : (pick(siblings) ?? null);
              board.reparentBoardTask(settings, { projectId: task.projectId, line: task.line, raw: task.raw, parent: parent === null ? null : { line: parent.line, raw: parent.raw } });
            }
            if (op === 21) {
              const content = readContent();
              const payload = board.readBoard(settings);
              const chosen = pick(board.scanDaily(settings, TODAY, content, payload.projects, payload.tasks).links);
              if (chosen) {
                const lines = content.split(/\r\n|\n/);
                const original = lines[chosen.line] as string;
                const variant = Math.floor(random() * 5);
                const tokens = [`${original} #p${step % 4}`, `${original} ${SCHEDULED} ${TODAY}`];
                const typed = variant === 0 ? `${original} _note ${seed}-${step}_` : variant === 1 ? `${original} again for Ana ${seed}-${step}` : variant === 2 ? original.replace(BOX_RE, "$1x$3") : (tokens[variant - 3] as string);
                const at = chosen.line + 1;
                expected.splice(slotFor(lines, at), 0, typed);
                lines.splice(at, 0, typed);
                if (random() < 0.5) {
                  writeFileSync(dailyPath(root), lines.join(eolOf(content)));
                  today.queueDailyDiskChange(TODAY);
                } else {
                  today.saveDailyFromClient(settings, TODAY, lines.join(eolOf(content)));
                }
              }
            }
            if (op === 18 || op === 19) {
              const content = readContent();
              const payload = board.readBoard(settings);
              const lines = content.split(/\r\n|\n/);
              const leaves = board
                .scanDaily(settings, TODAY, content, payload.projects, payload.tasks)
                .links.filter(
                  (link) =>
                    link.depth === 0 &&
                    !/^\s+\S/.test(lines[link.line + 1] ?? "") &&
                    lines.filter((line) => unmarked(line) === unmarked(lines[link.line] as string)).length === 1,
                );
              const chosen = pick(leaves);
              if (chosen) {
                const original = lines[chosen.line] as string;
                const at = expected.findIndex((line) => canon(line) === canon(original));
                lines.splice(chosen.line, 1);
                if (at !== -1) expected.splice(at, 1);
                const heading = lines.findIndex((line) => line.trim() === "## Focus");
                let end = op === 18 && heading !== -1 ? heading + 1 : lines.length;
                while (op === 18 && heading !== -1 && end < lines.length && !/^##\s/.test(lines[end] as string)) end += 1;
                let last = end - 1;
                while (last >= 0 && (lines[last] as string).trim() === "") last -= 1;
                const target = last + 1;
                const moved = op === 18 ? `${original} (call Bob ${seed}-${step})` : original;
                lines.splice(target, 0, moved);
                const result = random() < 0.7 ? toggle(lines.join(eolOf(content)), target) : null;
                const finalText = result === null ? moved : result.line;
                lines[target] = finalText;
                expected.splice(slotFor(lines, target), 0, finalText);
                identities.set(unmarked(finalText), identities.get(unmarked(original)) ?? keyOf(chosen.task));
                const saved = lines.join(eolOf(content));
                if (result !== null) userTick(saved, target, { line: finalText, before: checkboxOf(original), after: result.after });
                if (random() < 0.5) {
                  writeFileSync(dailyPath(root), saved);
                  today.queueDailyDiskChange(TODAY);
                } else {
                  today.saveDailyFromClient(settings, TODAY, saved);
                }
              }
            }
          } catch (err) {
            if (!(err instanceof board.TaskConflictError) && !(err instanceof Error && /occurrence|nothing was written|already top-level|own subtask/.test(err.message))) throw err;
          }
          for (const [from, to] of renames) renameKey(from, to);
          today.flushMirrors(settings);
          check(label);
          const statusAfter = new Map(allTasks().map((item) => [keyOf(item), item.status]));
          for (const [key, status] of statusBefore) {
            const now = statusAfter.get(renames.get(key) ?? key);
            if (status === "done" && now !== undefined && OPEN.has(now)) assert.ok(allowedReopen.has(key) || allowedReopen.has(renames.get(key) ?? key), `${label}: ${key} reopened without an untick`);
          }
          if (ticks.length > 0) {
            const payload = today.readToday(settings, TODAY);
            const reported = new Set([...(payload.outOfSync ?? []).map((item) => item.line), ...payload.ambiguous.map((item) => item.text), ...(payload.unmatched ?? []).map((item) => item.line)]);
            const keyOfId = new Map(allTasks().map((item) => [item.id, keyOf(item)]));
            const reportedKeys = new Set([
              ...(payload.outOfSync ?? []).map((item) => `${item.projectId}|${item.taskTitle}`),
              ...payload.ambiguous.flatMap((item) => (item.taskId === null ? [] : [keyOfId.get(item.taskId) ?? ""])),
            ]);
            const content = readContent();
            const board2 = board.readBoard(settings);
            const boxes = new Map<string, Set<string>>();
            for (const link of board.scanDaily(settings, TODAY, content, board2.projects, board2.tasks).links) boxes.set(keyOf(link.task), (boxes.get(keyOf(link.task)) ?? new Set<string>()).add(link.checkbox));
            for (const tick of ticks) {
              const now = statusAfter.get(tick.key);
              const applied = now !== undefined && statusBox(now) === tick.checkbox;
              const told = reported.has(tick.line) || reportedKeys.has(tick.key);
              const kept = content.split(/\r\n|\n/).some((line) => canon(line) === canon(tick.line) && checkboxOf(line) === tick.checkbox) || boxes.get(tick.key)?.has(tick.checkbox) === true;
              assert.ok(kept || told, `${label}: the ticked line "${tick.line}" was rewritten`);
              assert.ok(applied || told, `${label}: tick on "${tick.line}" for ${tick.key} was dropped (status ${now ?? "missing"})`);
            }
          }
          remember();
        }
      });
    }
  }
});

describe("fix wave 2, finding 1: a tick saved together with a text edit", () => {
  const SHIP = "- [ ] [[alpha|Alpha Project]] - Ship release";
  const OTHER = "- [ ] [[alpha|Alpha Project]] - Other task";
  const setup = (other = `- [ ] Other task ${SCHEDULED} ${TODAY}`, otherLine = OTHER): { root: string; settings: DelegationSettings } => {
    const root = lab({ alpha: project("Alpha Project", [`- [ ] Ship release ${SCHEDULED} ${TODAY}`, other]) }, { [TODAY]: dailyWith([SHIP, otherLine]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([SHIP, otherLine]));
    return { root, settings };
  };

  it("reaches the project when the line gained a suffix, and an untick with another edit reopens it", () => {
    const { root, settings } = setup();
    const ticked = "- [x] [[alpha|Alpha Project]] - Other task - done, sent to Ana";
    editDaily(root, (content) => content.replace(OTHER, ticked));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Other task").status, "done");
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([SHIP, ticked]));
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync ?? [], []);
    const reopened = "- [ ] [[alpha|Alpha Project]] - Other task - done, sent to Ana, reopened";
    editDaily(root, (content) => content.replace(ticked, reopened));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Other task").status, "todo");
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([SHIP, reopened]));
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "todo");
  });

  it("reopens a finished task when the line is unticked and edited in the same save", () => {
    const done = "- [x] [[alpha|Alpha Project]] - Other task";
    const { root, settings } = setup(`- [x] Other task ${SCHEDULED} ${TODAY}`, done);
    const edited = "- [ ] [[alpha|Alpha Project]] - Other task (not really)";
    editDaily(root, (content) => content.replace(done, edited));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Other task").status, "todo");
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([SHIP, edited]));
  });

  it("reports a line changed beyond recognition as out of sync and leaves both sides untouched", () => {
    const { root, settings } = setup();
    const projectBefore = read(root, "projects/alpha.md");
    const changed = "- [x] [[alpha|Alpha Project]] - Call the bank";
    editDaily(root, (content) => content.replace(OTHER, changed));
    const edited = readFileSync(dailyPath(root), "utf8");
    const expected = [{ line: changed, taskTitle: "Other task", projectId: "alpha", dailyCheckbox: "done", projectStatus: "todo" }];
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync, expected);
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), edited);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync, expected);
    const other = taskIn(settings, "alpha", "Other task");
    board.writeBoardTaskSynced(settings, { projectId: "alpha", line: other.line, raw: other.raw, status: "done" });
    today.flushMirrors(settings);
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync ?? [], []);
    assert.equal(readFileSync(dailyPath(root), "utf8"), edited);
  });

  it("drops the out of sync report once the line changes again", () => {
    const { root, settings } = setup();
    const changed = "- [x] [[alpha|Alpha Project]] - Call the bank";
    editDaily(root, (content) => content.replace(OTHER, changed));
    today.flushMirrors(settings);
    assert.equal(today.readToday(settings, TODAY).outOfSync?.length, 1);
    editDaily(root, (content) => content.replace(changed, "- [x] [[alpha|Alpha Project]] - Call the bank today"));
    today.flushMirrors(settings);
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync ?? [], []);
    assert.equal(taskIn(settings, "alpha", "Other task").status, "todo");
  });
});

describe("fix wave 2, finding 2: placeholder lines and promote", () => {
  const withCaptures = (captures: string[]): string => `${dailyWith(["- [ ] free"])}\n## Captures\n\n${captures.join("\n")}\n`;

  it("fills only an empty placeholder and never touches a non-empty neighbour", () => {
    const root = lab({ alpha: project("Alpha Project", ["- [ ] Ship release"]) }, { [TODAY]: withCaptures(["- existing idea", "-"]) });
    const settings = useVault(root);
    const before = readFileSync(dailyPath(root), "utf8");
    today.todayApi.appendCapture(settings, TODAY, "new idea");
    const after = readFileSync(dailyPath(root), "utf8");
    assert.deepEqual(missingLines(before.split("\n"), after), []);
    assert.ok(after.includes("- existing idea\n-\n- new idea\n"));
    today.todayApi.appendMeeting(settings, TODAY, "10:00 Sync");
    const withMeeting = readFileSync(dailyPath(root), "utf8");
    assert.ok(withMeeting.includes("## Meetings\n\n- 10:00 Sync\n\n## Sessions"));
    assert.deepEqual(missingLines(after.split("\n").filter((line) => line !== "-"), withMeeting), []);
  });

  it("replaces a lone '- [ ] ' placeholder and leaves the rest of the note alone", () => {
    const root = lab({ alpha: project("Alpha Project", ["- [ ] Ship release"]) }, { [TODAY]: withCaptures(["- [ ] "]) });
    const settings = useVault(root);
    const before = readFileSync(dailyPath(root), "utf8");
    today.todayApi.appendCapture(settings, TODAY, "first idea");
    const after = readFileSync(dailyPath(root), "utf8");
    assert.equal(after, before.replace("\n- [ ] \n", "\n- first idea\n"));
  });

  it("promote only appends the link to the captured line", () => {
    const raw = "- call Ana about the [x] thing - later";
    const root = lab({ alpha: project("Alpha Project", ["- [ ] Ship release"]) }, { [TODAY]: withCaptures([raw]) });
    const settings = useVault(root);
    const before = readFileSync(dailyPath(root), "utf8");
    const line = before.split("\n").indexOf(raw);
    today.todayApi.promoteCapture(settings, TODAY, { line, raw, projectId: "alpha" });
    const after = readFileSync(dailyPath(root), "utf8");
    assert.equal(after, before.replace(`${raw}\n`, `${raw} → [[alpha]]\n`));
  });
});

describe("fix wave 2, finding 3: duplicate lines added or removed", () => {
  const LINE = "- [ ] [[alpha|Alpha Project]] - Ship release";
  const TICKED = "- [x] [[alpha|Alpha Project]] - Ship release";
  const duplicateReports = (settings: DelegationSettings): string[] =>
    today
      .readToday(settings, TODAY)
      .ambiguous.filter((item) => item.reason === "duplicate-line")
      .map((item) => item.text);

  const disagreements = (settings: DelegationSettings): [string, string][] => (today.readToday(settings, TODAY).outOfSync ?? []).map((item) => [item.line, item.dailyCheckbox]);

  for (const where of ["above", "below"] as const) {
    it(`H3: an unticked copy added ${where} a ticked line reopens nothing, is merged and the copy is reported`, () => {
      const root = lab({ alpha: project("Alpha Project", [`- [x] Ship release ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([TICKED]) });
      const settings = useVault(root);
      today.todayApi.regenerateFocusMirror(settings, TODAY);
      editDaily(root, (content) => content.replace(`${TICKED}\n`, where === "above" ? `${LINE}\n${TICKED}\n` : `${TICKED}\n${LINE}\n`));
      assert.equal(duplicateReports(settings).length, 1);
      today.flushMirrors(settings);
      today.todayApi.regenerateFocusMirror(settings, TODAY);
      assert.equal(taskIn(settings, "alpha", "Ship release").status, "done");
      assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([TICKED]));
      assert.deepEqual(duplicateReports(settings), []);
      assert.deepEqual(disagreements(settings), [[TICKED, "todo"]]);
    });
  }

  it("H3: two copies that disagree are merged with the project state, tick nothing and the copy is reported", () => {
    const root = lab({ alpha: project("Alpha Project", [`- [ ] Ship release ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([LINE, TICKED]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "todo");
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([LINE]));
    assert.deepEqual(disagreements(settings), [[LINE, "done"]]);
  });

  it("H3: a copy added by hand is merged and a later tick on the line syncs again", () => {
    const root = lab({ alpha: project("Alpha Project", [`- [ ] Ship release ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([LINE]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    editDaily(root, (content) => content.replace(`${LINE}\n`, `${LINE}\n${LINE}\n`));
    today.flushMirrors(settings);
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([LINE]));
    editDaily(root, (content) => content.replace(`${LINE}\n`, `${TICKED}\n`));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "done");
    assert.deepEqual(duplicateReports(settings), []);
  });
});

describe("fix wave 2, finding 4: a hub write right after a disk edit", () => {
  const LINE = "- [ ] [[alpha|Alpha Project]] - Ship release";
  for (const kind of ["capture", "meeting"] as const) {
    it(`a tick on disk followed by a ${kind} within the debounce still reaches the project`, () => {
      const root = lab({ alpha: project("Alpha Project", [`- [ ] Ship release ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([LINE]) });
      const settings = useVault(root);
      today.todayApi.regenerateFocusMirror(settings, TODAY);
      writeFileSync(dailyPath(root), readFileSync(dailyPath(root), "utf8").replace(LINE, "- [x] [[alpha|Alpha Project]] - Ship release"));
      if (kind === "capture") today.todayApi.appendCapture(settings, TODAY, "idea while ticking");
      else today.todayApi.appendMeeting(settings, TODAY, "11:00 Call");
      today.flushMirrors(settings);
      assert.equal(taskIn(settings, "alpha", "Ship release").status, "done");
      assert.ok(readFileSync(dailyPath(root), "utf8").includes("- [x] [[alpha|Alpha Project]] - Ship release\n"));
    });
  }
});

describe("fix wave 2, finding 4: the hub runs the mirror at startup", () => {
  const boxes: Sandbox[] = [];
  const hubs: RunningServer[] = [];

  async function stop(hub: RunningServer): Promise<void> {
    if (hub.child.exitCode !== null || hub.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      hub.child.once("exit", () => resolve());
      hub.child.kill();
    });
  }

  after(async () => {
    for (const hub of hubs) await stop(hub);
    for (const box of boxes) rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function boot(box: Sandbox): Promise<RunningServer> {
    const hub = await startServer(box, { HUB_DELEGATION: "1", HUB_SHARE_PORT: String(await freePort()) });
    hubs.push(hub);
    return hub;
  }

  async function call(hub: RunningServer, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${hub.base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  it("applies a tick made while the hub was down without any further trigger", async () => {
    const box = makeSandbox("cch-today-startup-");
    boxes.push(box);
    write(box.brain, "_templates/daily.md", TEMPLATE);
    write(box.brain, "projects/alpha.md", project("Alpha Project", ["- [ ] Ship release", "- [ ] Other task"]));
    const hub = await boot(box);
    const saved = await call(hub, "PUT", "/delegation/settings", {
      secondBrainRoot: box.brain,
      features: { daily: true, tasks: true },
      tasks: { root: "projects", doneSection: "Done loops" },
      daily: { dir: "daily", template: "_templates/daily.md", wikilinks: true, focusSource: "scheduled" },
    });
    assert.equal(saved.status, 200);
    assert.equal((await call(hub, "POST", `/delegation/today/${TODAY}/create`)).status, 200);
    const tasks = flatten((await call(hub, "GET", "/delegation/tasks-board")).json.tasks as BoardTask[]);
    const ship = tasks.find((task) => task.title === "Ship release") as BoardTask;
    assert.equal((await call(hub, "POST", `/delegation/today/${TODAY}/schedule`, { projectId: "alpha", line: ship.line, raw: ship.raw, date: TODAY })).status, 200);
    const dailyFile = join(box.brain, "daily", `${TODAY}.md`);
    assert.ok(readFileSync(dailyFile, "utf8").includes("- [ ] [[alpha|Alpha Project]] - Ship release\n"));
    await stop(hub);
    writeFileSync(dailyFile, readFileSync(dailyFile, "utf8").replace("- [ ] [[alpha|Alpha Project]] - Ship release", "- [x] [[alpha|Alpha Project]] - Ship release"));
    const ticked = readFileSync(dailyFile, "utf8");
    await boot(box);
    const projectFile = join(box.brain, "projects", "alpha.md");
    await waitFor(async () => (readFileSync(projectFile, "utf8").includes(`- [x] Ship release ${SCHEDULED} ${TODAY}`) ? true : null), 10000);
    assert.equal(readFileSync(dailyFile, "utf8"), ticked);
  });
});

describe("fix wave 3, finding 1: Note tab saves go through the tick planner", () => {
  const LINE = "- [ ] [[alpha|Alpha Project]] - Ship release";
  const TICKED = "- [x] [[alpha|Alpha Project]] - Ship release";
  const duplicateReports = (settings: DelegationSettings): string[] =>
    today
      .readToday(settings, TODAY)
      .ambiguous.filter((item) => item.reason === "duplicate-line")
      .map((item) => item.text);

  it("H3: a Note tab save that adds an unticked copy above a ticked line reopens nothing, is merged and the copy is reported", () => {
    const root = lab({ alpha: project("Alpha Project", [`- [x] Ship release ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([TICKED]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const saved = readFileSync(dailyPath(root), "utf8").replace(`${TICKED}\n`, `${LINE}\n${TICKED}\n`);
    today.saveDailyFromClient(settings, TODAY, saved);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "done");
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "done");
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([TICKED]));
    assert.deepEqual(duplicateReports(settings), []);
    assert.deepEqual((today.readToday(settings, TODAY).outOfSync ?? []).map((item) => item.dailyCheckbox), ["todo"]);
  });

  it("H3: a Note tab save of two copies that disagree ticks nothing and keeps one line with the project state", () => {
    const root = lab({ alpha: project("Alpha Project", [`- [ ] Ship release ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([LINE]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const saved = readFileSync(dailyPath(root), "utf8").replace(`${LINE}\n`, `${LINE}\n${TICKED}\n`);
    today.saveDailyFromClient(settings, TODAY, saved);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "todo");
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([LINE]));
    assert.deepEqual((today.readToday(settings, TODAY).outOfSync ?? []).map((item) => item.dailyCheckbox), ["done"]);
  });

  it("a plain tick saved from the Note tab still reaches the project", () => {
    const root = lab({ alpha: project("Alpha Project", [`- [ ] Ship release ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([LINE]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const saved = readFileSync(dailyPath(root), "utf8").replace(LINE, TICKED);
    today.saveDailyFromClient(settings, TODAY, saved);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "done");
    assert.equal(readFileSync(dailyPath(root), "utf8"), saved);
  });

  it("H3: explicit Use daily and Sync to daily act on the one line left after the copies are merged", () => {
    const root = lab({ alpha: project("Alpha Project", [`- [x] Ship release ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([LINE, TICKED]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const before = readFileSync(dailyPath(root), "utf8");
    assert.equal(before, dailyWith([TICKED]));
    const task = taskIn(settings, "alpha", "Ship release");
    assert.equal(today.syncTaskToDailyChecked(settings, { projectId: "alpha", line: task.line, raw: task.raw, date: TODAY }).updated, 0);
    assert.equal(today.syncTaskFromDailyChecked(settings, { line: before.split("\n").indexOf(TICKED), date: TODAY }).updated, 0);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "done");
    assert.equal(readFileSync(dailyPath(root), "utf8"), before);
  });

  it("G00c: a status write from the board never runs the legacy marks in scheduled mode on lines the hub wrote", () => {
    const root = lab({ alpha: project("Alpha Project", ["- [ ] Legacy linked"]) });
    const settings = useVault(root);
    daily.writeDaily(settings, TODAY, dailyWith(["- [ ] [[alpha|Alpha Project]] - Legacy linked", "- [ ] [[alpha|Alpha Project]] - Legacy linked"]));
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(taskIn(settings, "alpha", "Legacy linked").scheduled, null);
    const before = readFileSync(dailyPath(root), "utf8");
    const task = taskIn(settings, "alpha", "Legacy linked");
    const result = board.writeBoardTaskSynced(settings, { projectId: "alpha", line: task.line, raw: task.raw, status: "done" });
    today.flushMirrors(settings);
    assert.equal(result.dailySynced, false);
    assert.equal(readFileSync(dailyPath(root), "utf8"), before);
  });
});

describe("fix wave 3, finding 1 over HTTP: PUT /delegation/daily in scheduled mode", () => {
  const boxes: Sandbox[] = [];
  const hubs: RunningServer[] = [];
  const LINE = "- [ ] [[alpha|Alpha Project]] - Ship release";
  const TICKED = "- [x] [[alpha|Alpha Project]] - Ship release";

  async function stop(hub: RunningServer): Promise<void> {
    if (hub.child.exitCode !== null || hub.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      hub.child.once("exit", () => resolve());
      hub.child.kill();
    });
  }

  after(async () => {
    for (const hub of hubs) await stop(hub);
    for (const box of boxes) rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function call(hub: RunningServer, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${hub.base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  async function prepare(projectLines: string[], focus: string[]): Promise<{ box: Sandbox; hub: RunningServer }> {
    const box = makeSandbox("cch-today-note-");
    boxes.push(box);
    write(box.brain, "_templates/daily.md", TEMPLATE);
    write(box.brain, "projects/alpha.md", project("Alpha Project", projectLines));
    write(box.brain, `daily/${TODAY}.md`, dailyWith(focus));
    const hub = await startServer(box, { HUB_DELEGATION: "1", HUB_SHARE_PORT: String(await freePort()) });
    hubs.push(hub);
    const saved = await call(hub, "PUT", "/delegation/settings", {
      secondBrainRoot: box.brain,
      features: { daily: true, tasks: true },
      tasks: { root: "projects", doneSection: "Done loops" },
      daily: { dir: "daily", template: "_templates/daily.md", wikilinks: true, focusSource: "scheduled" },
    });
    assert.equal(saved.status, 200);
    assert.equal((await call(hub, "POST", `/delegation/today/${TODAY}/create`)).status, 200);
    return { box, hub };
  }

  async function settle(hub: RunningServer, merged: string): Promise<string[]> {
    const found = await waitFor(async () => {
      const payload = (await call(hub, "GET", `/delegation/today/${TODAY}`)).json;
      const items = (payload.outOfSync ?? []) as { line: string; dailyCheckbox: string }[];
      return items.some((item) => item.line === merged) ? items.map((item) => item.dailyCheckbox) : null;
    }, 10000);
    await new Promise((resolve) => setTimeout(resolve, 900));
    return found;
  }

  async function statusOf(hub: RunningServer): Promise<string | undefined> {
    return flatten((await call(hub, "GET", "/delegation/tasks-board")).json.tasks as BoardTask[]).find((task) => task.title === "Ship release")?.status;
  }

  it("H3: a duplicate unticked line added above a ticked one keeps the task done, is merged and reported", async () => {
    const { box, hub } = await prepare([`- [x] Ship release ${SCHEDULED} ${TODAY}`], [TICKED]);
    const dailyFile = join(box.brain, "daily", `${TODAY}.md`);
    const current = await call(hub, "GET", `/delegation/daily/${TODAY}`);
    const content = (current.json.content as string).replace(`${TICKED}\n`, `${LINE}\n${TICKED}\n`);
    const put = await call(hub, "PUT", `/delegation/daily/${TODAY}`, { content, baseUpdatedAt: current.json.updatedAt });
    assert.equal(put.status, 200);
    assert.equal(await statusOf(hub), "done");
    assert.deepEqual(await settle(hub, TICKED), ["todo"]);
    assert.equal(await statusOf(hub), "done");
    assert.equal(readFileSync(dailyFile, "utf8"), content.replace(`${LINE}\n`, ""));
  });

  it("H3: two copies that disagree keep the task open, are merged and reported", async () => {
    const { box, hub } = await prepare([`- [ ] Ship release ${SCHEDULED} ${TODAY}`], [LINE]);
    const dailyFile = join(box.brain, "daily", `${TODAY}.md`);
    const current = await call(hub, "GET", `/delegation/daily/${TODAY}`);
    const content = (current.json.content as string).replace(`${LINE}\n`, `${LINE}\n${TICKED}\n`);
    const put = await call(hub, "PUT", `/delegation/daily/${TODAY}`, { content, baseUpdatedAt: current.json.updatedAt });
    assert.equal(put.status, 200);
    assert.equal(await statusOf(hub), "todo");
    assert.deepEqual(await settle(hub, LINE), ["done"]);
    assert.equal(await statusOf(hub), "todo");
    assert.equal(readFileSync(dailyFile, "utf8"), content.replace(`${TICKED}\n`, ""));
  });
});

describe("fix wave 3, finding 2: subtasks whose parent carries the scheduled date", () => {
  const PARENT = "- [ ] [[alpha|Alpha Project]] - Parent job";
  const CHILD = "  - [ ] Child step";
  const CHILD_DONE = "  - [x] Child step";

  it("a tick on a subtask line the hub inserted reaches the project from disk and from the Note tab", () => {
    const root = lab({ alpha: project("Alpha Project", [`- [ ] Parent job ${SCHEDULED} ${TODAY}`, `  - [ ] Child step ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith(["- [ ] free"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const primed = readFileSync(dailyPath(root), "utf8");
    assert.ok(primed.includes(`${PARENT}\n${CHILD}\n`));
    editDaily(root, (content) => content.replace(`${PARENT}\n${CHILD}\n`, `${PARENT}\n${CHILD_DONE}\n`));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Child step").status, "done");
    assert.equal(taskIn(settings, "alpha", "Parent job").status, "todo");
    today.saveDailyFromClient(settings, TODAY, readFileSync(dailyPath(root), "utf8").replace(CHILD_DONE, CHILD));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Child step").status, "todo");
    assert.equal(readFileSync(dailyPath(root), "utf8"), primed);
  });

  it("a tick on a subtask line the user wrote reaches the project", () => {
    const root = lab({ alpha: project("Alpha Project", [`- [ ] Parent job ${SCHEDULED} ${TODAY}`, "  - [ ] Child step", "    - [ ] Grandchild step"]) }, { [TODAY]: dailyWith([PARENT, CHILD, "    - [ ] Grandchild step"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([PARENT, CHILD, "    - [ ] Grandchild step"]));
    editDaily(root, (content) => content.replace("    - [ ] Grandchild step", "    - [x] Grandchild step"));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Grandchild step").status, "done");
    const child = taskIn(settings, "alpha", "Child step");
    board.writeBoardTaskSynced(settings, { projectId: "alpha", line: child.line, raw: child.raw, status: "doing" });
    today.flushMirrors(settings);
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([PARENT, "  - [-] Child step", "    - [x] Grandchild step"]));
  });
});

describe("fix wave 3, finding 3: a task renamed in the project while its line is ticked", () => {
  const LINE = "- [ ] [[alpha|Alpha Project]] - Ship release";
  const TICKED = "- [x] [[alpha|Alpha Project]] - Ship release";
  const setup = (): { root: string; settings: DelegationSettings } => {
    const root = lab({ alpha: project("Alpha Project", [`- [ ] Ship release ${SCHEDULED} ${TODAY}`, `- [ ] Other task ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([LINE, "- [ ] [[alpha|Alpha Project]] - Other task"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    return { root, settings };
  };

  it("H3: renames the line and applies the tick to the renamed task when the rename came through the board first", () => {
    const { root, settings } = setup();
    const task = taskIn(settings, "alpha", "Ship release");
    board.writeBoardTaskSynced(settings, { projectId: "alpha", line: task.line, raw: task.raw, title: "Ship the new build" });
    today.flushMirrors(settings);
    const renamed = "- [ ] [[alpha|Alpha Project]] - Ship the new build";
    assert.ok(readFileSync(dailyPath(root), "utf8").includes(`${renamed}\n`));
    editDaily(root, (content) => content.replace(renamed, renamed.replace("- [ ]", "- [x]")));
    const ticked = readFileSync(dailyPath(root), "utf8");
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship the new build").status, "done");
    assert.equal(taskIn(settings, "alpha", "Other task").status, "todo");
    assert.equal(readFileSync(dailyPath(root), "utf8"), ticked);
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync ?? [], []);
  });

  it("applies the tick when the rename and the tick happened on disk before the hub saw either", () => {
    const { root, settings } = setup();
    write(root, "projects/alpha.md", read(root, "projects/alpha.md").replace("- [ ] Ship release", "- [ ] Ship the new build"));
    editDaily(root, (content) => content.replace(LINE, TICKED));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship the new build").status, "done");
    assert.equal(taskIn(settings, "alpha", "Other task").status, "todo");
  });

  it("reports the tick as out of sync when the task is gone and a neighbour took its place", () => {
    const { root, settings } = setup();
    const projectText = read(root, "projects/alpha.md").replace(`- [ ] Ship release ${SCHEDULED} ${TODAY}\n`, "");
    write(root, "projects/alpha.md", projectText);
    editDaily(root, (content) => content.replace(LINE, TICKED));
    const ticked = readFileSync(dailyPath(root), "utf8");
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(read(root, "projects/alpha.md"), projectText);
    assert.equal(readFileSync(dailyPath(root), "utf8"), ticked);
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync, [{ line: TICKED, taskTitle: "Ship release", projectId: "alpha", dailyCheckbox: "done", projectStatus: "todo" }]);
  });
});

describe("fix wave 3, finding 4: a capture fills one placeholder only", () => {
  it("replaces the first empty placeholder and keeps the blank line and the other placeholder", () => {
    const content = `${dailyWith(["- [ ] free"])}\n## Captures\n\n-\n\n- [ ]\n`;
    const root = lab({ alpha: project("Alpha Project", ["- [ ] Ship release"]) }, { [TODAY]: content });
    const settings = useVault(root);
    today.todayApi.appendCapture(settings, TODAY, "first idea");
    assert.equal(readFileSync(dailyPath(root), "utf8"), content.replace("## Captures\n\n-\n\n- [ ]\n", "## Captures\n\n- first idea\n\n- [ ]\n"));
  });
});

describe("fix wave 3, finding 5: a reworded line keeps its identity", () => {
  const LINE = "- [ ] [[alpha|Alpha Project]] - Ship release";
  const setup = (): { root: string; settings: DelegationSettings } => {
    const root = lab({ alpha: project("Alpha Project", [`- [ ] Ship release ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([LINE]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    return { root, settings };
  };

  it("a reworded line ticked in a later save reaches the task", () => {
    const { root, settings } = setup();
    const reworded = "- [ ] [[alpha|Alpha Project]] - Ship the release to production";
    today.saveDailyFromClient(settings, TODAY, readFileSync(dailyPath(root), "utf8").replace(LINE, reworded));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "todo");
    editDaily(root, (content) => content.replace(reworded, reworded.replace("- [ ]", "- [x]")));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "done");
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync ?? [], []);
  });

  it("a line reworded beyond recognition and ticked later is reported, never applied", () => {
    const { root, settings } = setup();
    const reworded = "- [ ] [[alpha|Alpha Project]] - Call the bank";
    editDaily(root, (content) => content.replace(LINE, reworded));
    today.flushMirrors(settings);
    const ticked = reworded.replace("- [ ]", "- [x]");
    today.saveDailyFromClient(settings, TODAY, readFileSync(dailyPath(root), "utf8").replace(reworded, ticked));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "todo");
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync, [{ line: ticked, taskTitle: "Ship release", projectId: "alpha", dailyCheckbox: "done", projectStatus: "todo" }]);
  });
});

describe("fix wave 3: more adversarial cases", () => {
  it("a Note tab save of a daily older than yesterday in scheduled mode syncs nothing", () => {
    const line = "- [ ] [[alpha|Alpha Project]] - Ship release";
    const olderDaily = dailyWith([line]).replace(`# ${TODAY}`, `# ${DAY_BEFORE}`);
    const root = lab({ alpha: project("Alpha Project", [`- [ ] Ship release ${SCHEDULED} ${DAY_BEFORE}`]) }, { [DAY_BEFORE]: olderDaily });
    const settings = useVault(root);
    const saved = olderDaily.replace(line, "- [x] [[alpha|Alpha Project]] - Ship release");
    today.saveDailyFromClient(settings, DAY_BEFORE, saved);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "todo");
    assert.equal(read(root, `daily/${DAY_BEFORE}.md`), saved);
  });

  it("H3: close yesterday on today's daily goes through the planner and a duplicate is merged", () => {
    const LINE = "- [ ] [[alpha|Alpha Project]] - Ship release";
    const TICKED = "- [x] [[alpha|Alpha Project]] - Ship release";
    const root = lab({ alpha: project("Alpha Project", [`- [x] Ship release ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([TICKED]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const before = readFileSync(dailyPath(root), "utf8");
    const after = before.replace(`${TICKED}\n`, `${LINE}\n${TICKED}\n`);
    today.closeDailyTicks(settings, TODAY, before, after);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "done");
    assert.equal(readFileSync(dailyPath(root), "utf8"), before);
  });

  it("Use daily applies an unambiguous line in scheduled mode", () => {
    const LINE = "- [ ] [[alpha|Alpha Project]] - Ship release";
    const root = lab({ alpha: project("Alpha Project", [`- [x] Ship release ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([LINE]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const result = today.syncTaskFromDailyChecked(settings, { line: readFileSync(dailyPath(root), "utf8").split("\n").indexOf(LINE), date: TODAY });
    assert.equal(result.updated, 1);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "todo");
  });

  it("H3: a renamed subtask and a subtask under a renamed parent are renamed and keep their ticks", () => {
    const PARENT = "- [ ] [[alpha|Alpha Project]] - Parent job";
    const root = lab(
      { alpha: project("Alpha Project", [`- [ ] Parent job ${SCHEDULED} ${TODAY}`, "  - [ ] Child one", "  - [ ] Child two"]) },
      { [TODAY]: dailyWith([PARENT, "  - [ ] Child one", "  - [ ] Child two"]) },
    );
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const child = taskIn(settings, "alpha", "Child one");
    board.writeBoardTaskSynced(settings, { projectId: "alpha", line: child.line, raw: child.raw, title: "First child renamed" });
    today.flushMirrors(settings);
    assert.ok(readFileSync(dailyPath(root), "utf8").includes("\n  - [ ] First child renamed\n"));
    editDaily(root, (content) => content.replace("  - [ ] First child renamed", "  - [x] First child renamed"));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "First child renamed").status, "done");
    const parent = taskIn(settings, "alpha", "Parent job");
    board.writeBoardTaskSynced(settings, { projectId: "alpha", line: parent.line, raw: parent.raw, title: "Parent job renamed entirely" });
    today.flushMirrors(settings);
    editDaily(root, (content) => content.replace("  - [ ] Child two", "  - [x] Child two"));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Child two").status, "done");
    assert.equal(taskIn(settings, "alpha", "Parent job renamed entirely").status, "todo");
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync ?? [], []);
  });
});

describe("fix wave 4, finding 1: a moved line keeps its identity", () => {
  const P1 = "- [ ] [[alpha|Alpha Project]] - First job";
  const P2 = "- [ ] [[alpha|Alpha Project]] - Second job";
  const P3 = "- [ ] [[alpha|Alpha Project]] - Third job";
  const ticked = (line: string): string => line.replace("- [ ]", "- [x]");
  const setup = (): { root: string; settings: DelegationSettings } => {
    const root = lab(
      { alpha: project("Alpha Project", [`- [ ] First job ${SCHEDULED} ${TODAY}`, `- [ ] Second job ${SCHEDULED} ${TODAY}`, `- [ ] Third job ${SCHEDULED} ${TODAY}`]) },
      { [TODAY]: dailyWith([P1, P2, P3]) },
    );
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([P1, P2, P3]));
    return { root, settings };
  };

  it("a line moved to the end and ticked in the same Note tab save reaches the project", () => {
    const { root, settings } = setup();
    const saved = dailyWith([P2, P3, ticked(P1)]);
    today.saveDailyFromClient(settings, TODAY, saved);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "First job").status, "done");
    assert.equal(taskIn(settings, "alpha", "Second job").status, "todo");
    assert.equal(taskIn(settings, "alpha", "Third job").status, "todo");
    assert.equal(readFileSync(dailyPath(root), "utf8"), saved);
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync ?? [], []);
  });

  it("a line moved and ticked on disk reaches the project, and a later untick at the new place reopens it", () => {
    const { root, settings } = setup();
    editDaily(root, () => dailyWith([P2, ticked(P1), P3]));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "First job").status, "done");
    editDaily(root, () => dailyWith([P2, P1, P3]));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "First job").status, "todo");
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([P2, P1, P3]));
  });

  const PA = "- [ ] [[alpha|Alpha Project]] - Parent A";
  const PB = "- [ ] [[alpha|Alpha Project]] - Parent B";
  const nested = (): { root: string; settings: DelegationSettings } => {
    const root = lab(
      { alpha: project("Alpha Project", [`- [ ] Parent A ${SCHEDULED} ${TODAY}`, "  - [ ] Child step", `- [ ] Parent B ${SCHEDULED} ${TODAY}`, "  - [ ] Other child"]) },
      { [TODAY]: dailyWith([PA, "  - [ ] Child step", PB, "  - [ ] Other child"]) },
    );
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([PA, "  - [ ] Child step", PB, "  - [ ] Other child"]));
    return { root, settings };
  };

  it("H3: a subtask moved under another parent goes back under its project parent and keeps syncing", () => {
    const { root, settings } = nested();
    const moved = dailyWith([PA, PB, "  - [ ] Other child", "  - [ ] Child step"]);
    today.saveDailyFromClient(settings, TODAY, moved);
    today.flushMirrors(settings);
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([PA, "  - [ ] Child step", PB, "  - [ ] Other child"]));
    editDaily(root, () => dailyWith([PA, "  - [x] Child step", PB, "  - [ ] Other child"]));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Child step").status, "done");
    assert.equal(taskIn(settings, "alpha", "Other child").status, "todo");
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([PA, "  - [x] Child step", PB, "  - [ ] Other child"]));
  });

  it("H3: a subtask moved under another parent and ticked in the same save reaches the project and goes back", () => {
    const { root, settings } = nested();
    const saved = dailyWith([PA, PB, "  - [ ] Other child", "  - [x] Child step"]);
    editDaily(root, () => saved);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Child step").status, "done");
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([PA, "  - [x] Child step", PB, "  - [ ] Other child"]));
  });

  it("H3: an outdented subtask ticked in the same save goes back under its parent and keeps its identity", () => {
    const { root, settings } = nested();
    const outdented = dailyWith([PA, PB, "  - [ ] Other child", "- [x] Child step"]);
    today.saveDailyFromClient(settings, TODAY, outdented);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Child step").status, "done");
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([PA, "  - [x] Child step", PB, "  - [ ] Other child"]));
    editDaily(root, () => dailyWith([PA, "  - [ ] Child step", PB, "  - [ ] Other child"]));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Child step").status, "todo");
    assert.equal(taskIn(settings, "alpha", "Parent A").status, "todo");
  });

  it("two identical moved lines that cannot be told apart are reported as ambiguous and tick nothing", () => {
    const PC = "- [ ] [[alpha|Alpha Project]] - Parent C";
    const root = lab(
      {
        alpha: project("Alpha Project", [
          `- [ ] Parent A ${SCHEDULED} ${TODAY}`,
          "  - [ ] Review",
          `- [ ] Parent B ${SCHEDULED} ${TODAY}`,
          "  - [ ] Review",
          `- [ ] Parent C ${SCHEDULED} ${TODAY}`,
        ]),
      },
      { [TODAY]: dailyWith([PA, "  - [ ] Review", PB, "  - [ ] Review", PC]) },
    );
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([PA, "  - [ ] Review", PB, "  - [ ] Review", PC]));
    const projectBefore = read(root, "projects/alpha.md");
    const saved = dailyWith([PA, PB, PC, "  - [ ] Review", "  - [x] Review"]);
    today.saveDailyFromClient(settings, TODAY, saved);
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    assert.equal(readFileSync(dailyPath(root), "utf8"), saved);
    const payload = today.readToday(settings, TODAY);
    const reported = payload.ambiguous.filter((item) => item.reason === "several-lines").map((item) => item.text);
    assert.ok(reported.includes("  - [x] Review"), JSON.stringify(payload.ambiguous));
  });
});

describe("fix wave 4, finding 2: add to daily schedules the task in scheduled mode", () => {
  it("writes the scheduled date on the task so a later tick on the line syncs", () => {
    const root = lab({ alpha: project("Alpha Project", ["- [ ] Ship release", `  - [ ] Write notes ${SCHEDULED} ${TODAY}`, "  - [ ] Undated step", "- [ ] Other task"]) }, { [TODAY]: dailyWith(["- [ ] free"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const ship = taskIn(settings, "alpha", "Ship release");
    const result = today.addTaskToDailyChecked(settings, { projectId: "alpha", line: ship.line, raw: ship.raw, date: TODAY });
    assert.equal(result.raw, "- [ ] [[alpha|Alpha Project]] - Ship release");
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship release").scheduled, TODAY);
    assert.equal(taskIn(settings, "alpha", "Other task").scheduled, null);
    const added = readFileSync(dailyPath(root), "utf8");
    assert.equal(added.split("\n").filter((line) => line === "- [ ] [[alpha|Alpha Project]] - Ship release").length, 1);
    assert.equal(added.split("\n").filter((line) => line === "  - [ ] Write notes").length, 1);
    assert.equal(added.includes("Undated step"), false);
    editDaily(root, (content) => content.replace("- [ ] [[alpha|Alpha Project]] - Ship release", "- [x] [[alpha|Alpha Project]] - Ship release"));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Ship release").status, "done");
    editDaily(root, (content) => content.replace("  - [ ] Write notes", "  - [x] Write notes"));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Write notes").status, "done");
  });

  it("leaves the task unscheduled in list mode and for a past date", () => {
    const root = lab(
      { alpha: project("Alpha Project", ["- [ ] Ship release"]) },
      { [TODAY]: dailyWith(["- [ ] free"]), [YESTERDAY]: dailyWith(["- [ ] free"]).replace(`# ${TODAY}`, `# ${YESTERDAY}`) },
    );
    const settings = useVault(root);
    store.updateSettings({ daily: { ...settings.daily, focusSource: "list" } });
    const listSettings = store.getSettings();
    const ship = taskIn(listSettings, "alpha", "Ship release");
    today.addTaskToDailyChecked(listSettings, { projectId: "alpha", line: ship.line, raw: ship.raw, date: TODAY });
    assert.equal(taskIn(listSettings, "alpha", "Ship release").scheduled, null);
    assert.ok(readFileSync(dailyPath(root), "utf8").includes("- [ ] [[alpha|Alpha Project]] - Ship release\n"));
    const scheduled = useVault(root);
    const fresh = taskIn(scheduled, "alpha", "Ship release");
    today.addTaskToDailyChecked(scheduled, { projectId: "alpha", line: fresh.line, raw: fresh.raw, date: YESTERDAY });
    assert.equal(taskIn(scheduled, "alpha", "Ship release").scheduled, null);
  });
});

describe("fix wave 4, finding 3: unticking a recurring task completed today", () => {
  it("is reported as out of sync with the recurring-done reason and changes nothing", () => {
    const REPEAT = "\u{1F501}";
    const LINE = "- [ ] [[lab|Lab]] - Theta";
    const TICKED = "- [x] [[lab|Lab]] - Theta";
    const root = lab({ lab: project("Lab", [`- [ ] Theta ${REPEAT} every day ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyWith([LINE]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    editDaily(root, (content) => content.replace(LINE, TICKED));
    today.flushMirrors(settings);
    const projectDone = read(root, "projects/lab.md");
    assert.ok(projectDone.includes(`- [ ] Theta ${REPEAT} every day ${SCHEDULED} ${TOMORROW}`));
    assert.ok(projectDone.includes(`${DONE} ${TODAY}`));
    editDaily(root, (content) => content.replace(TICKED, LINE));
    const unticked = readFileSync(dailyPath(root), "utf8");
    const expected = [{ line: LINE, taskTitle: "Theta", projectId: "lab", dailyCheckbox: "todo", projectStatus: "done", reason: "recurring-done" }];
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync, expected);
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(read(root, "projects/lab.md"), projectDone);
    assert.equal(readFileSync(dailyPath(root), "utf8"), unticked);
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync, expected);
  });
});

describe("fix wave 5: a tick the planner cannot place is reported as unmatched", () => {
  const P1 = "- [ ] [[alpha|Alpha Project]] - First job";
  const P2 = "- [ ] [[alpha|Alpha Project]] - Second job";
  const P3 = "- [ ] [[alpha|Alpha Project]] - Third job";
  const BOB = " (call Bob)";
  const ticked = (line: string): string => line.replace("- [ ]", "- [x]");
  const setup = (firstDone = false): { root: string; settings: DelegationSettings; projectBefore: string } => {
    const first = `- [${firstDone ? "x" : " "}] First job ${SCHEDULED} ${TODAY}`;
    const root = lab(
      { alpha: project("Alpha Project", [first, `- [ ] Second job ${SCHEDULED} ${TODAY}`, `- [ ] Third job ${SCHEDULED} ${TODAY}`]) },
      { [TODAY]: dailyWith([firstDone ? ticked(P1) : P1, P2, P3]) },
    );
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([firstDone ? ticked(P1) : P1, P2, P3]));
    return { root, settings, projectBefore: read(root, "projects/alpha.md") };
  };
  const unmatchedOf = (settings: DelegationSettings): import("../src/today.js").TodayUnmatched[] => today.readToday(settings, TODAY).unmatched ?? [];
  const only = (settings: DelegationSettings, line: string): import("../src/today.js").TodayUnmatched => {
    const items = unmatchedOf(settings);
    assert.equal(items.length, 1, JSON.stringify(items));
    const item = items[0] as import("../src/today.js").TodayUnmatched;
    assert.equal(item.line, line);
    return item;
  };
  const indexIn = (root: string, line: string): number => readFileSync(dailyPath(root), "utf8").split("\n").indexOf(line);

  it("a line moved and reworded and ticked in the same save is reported with the task as the best guess and nothing changes", () => {
    const { root, settings, projectBefore } = setup();
    const line = `${ticked(P1)}${BOB}`;
    const saved = dailyWith([P2, P3, line]);
    today.saveDailyFromClient(settings, TODAY, saved);
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    assert.equal(readFileSync(dailyPath(root), "utf8"), saved);
    const item = only(settings, line);
    assert.equal(item.lineIndex, indexIn(root, line));
    assert.equal(item.section, "Focus");
    assert.equal(item.checkbox, "done");
    assert.equal(item.candidates[0]?.title, "First job");
    assert.equal(item.candidates[0]?.projectId, "alpha");
    assert.ok(item.candidates.length <= 3);
    assert.deepEqual(today.readToday(settings, TODAY).outOfSync ?? [], []);
  });

  it("a line moved and reworded in one save and ticked in a later save is reported", () => {
    const { root, settings, projectBefore } = setup();
    const moved = `${P1}${BOB}`;
    today.saveDailyFromClient(settings, TODAY, dailyWith([P2, P3, moved]));
    today.flushMirrors(settings);
    assert.deepEqual(unmatchedOf(settings), []);
    editDaily(root, (content) => content.replace(moved, ticked(moved)));
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    const item = only(settings, ticked(moved));
    assert.equal(item.checkbox, "done");
    assert.equal(item.candidates[0]?.title, "First job");
  });

  it("a subtask re-parented, reworded and ticked in the same save is reported", () => {
    const PA = "- [ ] [[alpha|Alpha Project]] - Parent A";
    const PB = "- [ ] [[alpha|Alpha Project]] - Parent B";
    const root = lab(
      { alpha: project("Alpha Project", [`- [ ] Parent A ${SCHEDULED} ${TODAY}`, "  - [ ] Child step", `- [ ] Parent B ${SCHEDULED} ${TODAY}`, "  - [ ] Other child"]) },
      { [TODAY]: dailyWith([PA, "  - [ ] Child step", PB, "  - [ ] Other child"]) },
    );
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const projectBefore = read(root, "projects/alpha.md");
    const saved = dailyWith([PA, PB, "  - [ ] Other child", "  - [x] Child step for real"]);
    today.saveDailyFromClient(settings, TODAY, saved);
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    assert.equal(readFileSync(dailyPath(root), "utf8"), saved);
    const item = only(settings, "  - [x] Child step for real");
    assert.equal(item.candidates[0]?.title, "Child step");
  });

  it("a finished task whose line is moved, reworded and unticked stays done and is reported", () => {
    const { root, settings, projectBefore } = setup(true);
    const line = `${P1}${BOB}`;
    const saved = dailyWith([P2, P3, line]);
    today.saveDailyFromClient(settings, TODAY, saved);
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "First job").status, "done");
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    const item = only(settings, line);
    assert.equal(item.checkbox, "todo");
    assert.equal(item.candidates[0]?.title, "First job");
  });

  it("a linked line moved to the meetings and ticked is reported with its section", () => {
    const { root, settings, projectBefore } = setup();
    const saved = dailyWith([P2, P3], [ticked(P1)]);
    today.saveDailyFromClient(settings, TODAY, saved);
    today.flushMirrors(settings);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    assert.equal(readFileSync(dailyPath(root), "utf8"), saved);
    const item = only(settings, ticked(P1));
    assert.equal(item.section, "Meetings");
    assert.equal(item.candidates[0]?.title, "First job");
  });

  it("apply sets the task from the line, pins the pairing and later ticks on that line sync", () => {
    const { root, settings } = setup();
    const line = `${ticked(P1)}${BOB}`;
    const saved = dailyWith([P2, P3, line]);
    today.saveDailyFromClient(settings, TODAY, saved);
    today.flushMirrors(settings);
    const item = only(settings, line);
    const target = item.candidates[0] as import("../src/today.js").TodayUnmatchedCandidate;
    const result = today.todayApi.linkTick(settings, TODAY, { lineIndex: item.lineIndex, raw: item.line, target, action: "apply" });
    assert.deepEqual(result.unmatched, []);
    assert.equal(taskIn(settings, "alpha", "First job").status, "done");
    today.flushMirrors(settings);
    assert.equal(readFileSync(dailyPath(root), "utf8"), saved);
    assert.deepEqual(unmatchedOf(settings), []);
    editDaily(root, (content) => content.replace(line, `${P1}${BOB}`));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "First job").status, "todo");
    assert.deepEqual(unmatchedOf(settings), []);
    editDaily(root, (content) => content.replace(`${P1}${BOB}`, line));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "First job").status, "done");
    assert.equal(taskIn(settings, "alpha", "Second job").status, "todo");
    assert.equal(readFileSync(dailyPath(root), "utf8"), saved);
  });

  it("apply on a meetings line pins it so a later untick reopens the task", () => {
    const { root, settings } = setup();
    today.saveDailyFromClient(settings, TODAY, dailyWith([P2, P3], [ticked(P1)]));
    today.flushMirrors(settings);
    const item = only(settings, ticked(P1));
    today.todayApi.linkTick(settings, TODAY, { lineIndex: item.lineIndex, raw: item.line, target: item.candidates[0] ?? null, action: "apply" });
    assert.equal(taskIn(settings, "alpha", "First job").status, "done");
    editDaily(root, (content) => content.replace(ticked(P1), P1));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "First job").status, "todo");
    assert.equal(readFileSync(dailyPath(root), "utf8"), dailyWith([P2, P3], [P1]));
    assert.deepEqual(unmatchedOf(settings), []);
  });

  it("apply refuses a stale line or a stale task and changes nothing", () => {
    const { root, settings, projectBefore } = setup();
    const line = `${ticked(P1)}${BOB}`;
    today.saveDailyFromClient(settings, TODAY, dailyWith([P2, P3, line]));
    today.flushMirrors(settings);
    const item = only(settings, line);
    const target = item.candidates[0] as import("../src/today.js").TodayUnmatchedCandidate;
    assert.throws(() => today.todayApi.linkTick(settings, TODAY, { lineIndex: item.lineIndex, raw: `${line} edited`, target, action: "apply" }), today.StaleTodayLineError);
    assert.throws(() => today.todayApi.linkTick(settings, TODAY, { lineIndex: item.lineIndex, raw: item.line, target: { ...target, raw: `${target.raw} old` }, action: "apply" }), board.TaskConflictError);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    assert.equal(only(settings, line).line, line);
  });

  it("dismiss removes the report and changes neither side", () => {
    const { root, settings, projectBefore } = setup();
    const line = `${ticked(P1)}${BOB}`;
    const saved = dailyWith([P2, P3, line]);
    today.saveDailyFromClient(settings, TODAY, saved);
    today.flushMirrors(settings);
    const item = only(settings, line);
    const result = today.todayApi.linkTick(settings, TODAY, { lineIndex: item.lineIndex, raw: item.line, target: null, action: "dismiss" });
    assert.deepEqual(result.unmatched, []);
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.deepEqual(unmatchedOf(settings), []);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    assert.equal(readFileSync(dailyPath(root), "utf8"), saved);
  });

  it("a plain new free-text ticked line is not reported", () => {
    const { settings } = setup();
    today.saveDailyFromClient(settings, TODAY, dailyWith([P1, P2, P3, "- [x] buy milk"], ["- [x] call the plumber"]));
    today.flushMirrors(settings);
    assert.deepEqual(unmatchedOf(settings), []);
    assert.equal("unmatched" in today.readToday(settings, TODAY), false);
  });

  it("a new ticked line that names an open task without a link is reported", () => {
    const root = lab({ alpha: project("Alpha Project", ["- [ ] Renew the domain name"]) }, { [TODAY]: dailyWith(["- [ ] free"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    today.saveDailyFromClient(settings, TODAY, dailyWith(["- [ ] free"], ["- [x] finally renew the domain name today"]));
    today.flushMirrors(settings);
    const item = only(settings, "- [x] finally renew the domain name today");
    assert.equal(item.candidates[0]?.title, "Renew the domain name");
    assert.equal(taskIn(settings, "alpha", "Renew the domain name").status, "todo");
  });
});

describe("fix wave 5 over HTTP: POST /delegation/today/:date/link-tick", () => {
  const boxes: Sandbox[] = [];
  const hubs: RunningServer[] = [];

  after(async () => {
    for (const hub of hubs) {
      if (hub.child.exitCode !== null || hub.child.signalCode !== null) continue;
      await new Promise<void>((resolve) => {
        hub.child.once("exit", () => resolve());
        hub.child.kill();
      });
    }
    for (const box of boxes) rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function call(hub: RunningServer, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${hub.base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  it("validates the body, refuses a stale line and applies the pairing", async () => {
    const P1 = "- [ ] [[alpha|Alpha Project]] - First job";
    const P2 = "- [ ] [[alpha|Alpha Project]] - Second job";
    const box = makeSandbox("cch-today-link-");
    boxes.push(box);
    write(box.brain, "_templates/daily.md", TEMPLATE);
    write(box.brain, "projects/alpha.md", project("Alpha Project", [`- [ ] First job ${SCHEDULED} ${TODAY}`, `- [ ] Second job ${SCHEDULED} ${TODAY}`]));
    write(box.brain, `daily/${TODAY}.md`, dailyWith([P1, P2]));
    const hub = await startServer(box, { HUB_DELEGATION: "1", HUB_SHARE_PORT: String(await freePort()) });
    hubs.push(hub);
    const saved = await call(hub, "PUT", "/delegation/settings", {
      secondBrainRoot: box.brain,
      features: { daily: true, tasks: true },
      tasks: { root: "projects", doneSection: "Done loops" },
      daily: { dir: "daily", template: "_templates/daily.md", wikilinks: true, focusSource: "scheduled" },
    });
    assert.equal(saved.status, 200);
    assert.equal((await call(hub, "POST", `/delegation/today/${TODAY}/create`)).status, 200);
    const current = await call(hub, "GET", `/delegation/daily/${TODAY}`);
    const line = "- [x] [[alpha|Alpha Project]] - First job (call Bob)";
    const content = (current.json.content as string).replace(`${P1}\n${P2}\n`, `${P2}\n${line}\n`);
    assert.equal((await call(hub, "PUT", `/delegation/daily/${TODAY}`, { content, baseUpdatedAt: current.json.updatedAt })).status, 200);
    const unmatched = await waitFor(async () => {
      const payload = (await call(hub, "GET", `/delegation/today/${TODAY}`)).json;
      const items = (payload.unmatched ?? []) as { line: string; lineIndex: number; candidates: { projectId: string; line: number; raw: string; title: string }[] }[];
      return items.length > 0 ? items : null;
    }, 10000);
    const item = unmatched[0] as { line: string; lineIndex: number; candidates: { projectId: string; line: number; raw: string; title: string }[] };
    assert.equal(item.line, line);
    const target = item.candidates[0] as { projectId: string; line: number; raw: string; title: string };
    assert.equal(target.title, "First job");
    const url = `/delegation/today/${TODAY}/link-tick`;
    assert.equal((await call(hub, "POST", url, { lineIndex: -1, raw: line, target, action: "apply" })).status, 400);
    assert.equal((await call(hub, "POST", url, { lineIndex: item.lineIndex, raw: line, target, action: "link" })).status, 400);
    assert.equal((await call(hub, "POST", url, { lineIndex: item.lineIndex, raw: line, target: null, action: "apply" })).status, 400);
    assert.equal((await call(hub, "POST", url, { lineIndex: item.lineIndex, raw: line, target: { projectId: "alpha", line: "x", raw: target.raw }, action: "apply" })).status, 400);
    assert.equal((await call(hub, "POST", url, { lineIndex: item.lineIndex, raw: `${line} stale`, target, action: "apply" })).status, 409);
    assert.equal((await call(hub, "POST", url, { lineIndex: item.lineIndex, raw: line, target: { ...target, raw: "- [ ] gone" }, action: "apply" })).status, 409);
    const applied = await call(hub, "POST", url, { lineIndex: item.lineIndex, raw: line, target: { projectId: target.projectId, line: target.line, raw: target.raw }, action: "apply" });
    assert.equal(applied.status, 200);
    assert.deepEqual(applied.json.unmatched, []);
    assert.equal((applied.json.task as BoardTask).status, "done");
    assert.ok(readFileSync(join(box.brain, "projects", "alpha.md"), "utf8").includes(`- [x] First job ${SCHEDULED} ${TODAY}`));
    assert.equal(readFileSync(join(box.brain, "daily", `${TODAY}.md`), "utf8"), content);
  });
});
