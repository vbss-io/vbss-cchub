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
  it("keeps the line and its custom text through every mirror run and lists it as in the note", () => {
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
    assert.equal(taskIn(settings, "beta", "Old carried thing").scheduled, YESTERDAY);
    assert.ok(today.readToday(settings, TODAY).inNote.includes(custom));
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

  it("unschedule leaves the custom text and lists the line as in the note", () => {
    const { root, settings, primed } = setup();
    scheduleOf(settings, "alpha", "Ship release", null);
    today.flushMirrors(settings);
    assert.equal(readFileSync(dailyPath(root), "utf8"), primed);
    const payload = today.readToday(settings, TODAY);
    assert.deepEqual(payload.focus, []);
    assert.deepEqual(payload.inNote, [LINE]);
  });

  it("rename through the board item write keeps the custom line and adds no generated line", () => {
    const { root, settings, primed } = setup();
    const task = taskIn(settings, "alpha", "Ship release");
    board.writeBoardTaskSynced(settings, { projectId: "alpha", line: task.line, raw: task.raw, title: "Ship the new release" });
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), primed);
    assert.equal(primed.includes("Ship the new release"), false);
    assert.deepEqual(today.readToday(settings, TODAY).inNote, [LINE]);
  });

  it("reschedule to another date and move to another project leave the daily alone", () => {
    const { root, settings, primed } = setup();
    scheduleOf(settings, "alpha", "Ship release", TOMORROW);
    assert.equal(readFileSync(dailyPath(root), "utf8"), primed);
    scheduleOf(settings, "alpha", "Ship release", TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), primed);
    const task = taskIn(settings, "alpha", "Ship release");
    board.moveTaskToProject(settings, { projectId: "alpha", line: task.line, raw: task.raw, targetProjectId: "beta", parent: null });
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    assert.equal(taskIn(settings, "beta", "Ship release").scheduled, TODAY);
    assert.equal(readFileSync(dailyPath(root), "utf8"), primed);
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
    assert.equal(after, ticked);
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
  it("stay under the line where the user put them", () => {
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
    assert.equal(readFileSync(dailyPath(root), "utf8"), primed);
    const staying = taskIn(settings, "lab", "Staying task");
    board.createBoardTask(settings, { projectId: "lab", title: "New staying sub", status: "todo", parentLine: staying.line, parentRaw: staying.raw });
    today.flushMirrors(settings);
    const after = readFileSync(dailyPath(root), "utf8");
    assert.ok(after.includes(`${focus.slice(0, 3).join("\n")}\n- [ ] [[lab|Lab]] - Staying task\n  - note B\n  - [ ] New staying sub\n`));
  });
});

describe("finding 7: duplicate lines", () => {
  it("are never removed by the first migration or by the mirror", () => {
    const focus = ["- [ ] [[lab|Lab]] - Mig one", "- [ ] [[lab|Lab]] - Mig one", "- [ ] free"];
    const root = lab({ lab: project("Lab", ["- [ ] Mig one"]) }, { [TODAY]: dailyWith(focus) });
    const settings = useVault(root);
    const before = readFileSync(dailyPath(root), "utf8");
    const result = today.todayApi.migrateFocus(settings, TODAY);
    assert.equal(result.scheduled, 1);
    assert.equal(readFileSync(dailyPath(root), "utf8"), before);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const after = readFileSync(dailyPath(root), "utf8");
    assert.equal(after, before);
    assert.equal(after.split("\n").filter((line) => line === "- [ ] [[lab|Lab]] - Mig one").length, 2);
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

  it("never sync the checkbox of a line whose task carries no scheduled date", () => {
    const root = lab({ lab: project("Lab", ["- [ ] Legacy linked"]) }, { [TODAY]: dailyWith(["- [ ] [[lab|Lab]] - Legacy linked"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
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

describe("property: every line of the daily survives any sequence of operations", () => {
  for (const fixture of FIXTURES) {
    for (const seed of [7, 19, 42]) {
      it(`${fixture.name}, seed ${seed}`, () => {
        const root = lab({ alpha: ALPHA, beta: BETA }, { [TODAY]: fixture.daily });
        const settings = useVault(root);
        const random = prng(seed);
        const pick = <T>(items: T[]): T | undefined => items[Math.floor(random() * items.length)];
        const expected = fixture.daily.split(/\r\n|\n/);
        const openTasks = (): BoardTask[] => flatten(board.readBoard(settings).tasks).filter((task) => task.section === "open" && task.status !== "archived");
        const check = (step: string): void => {
          const content = readFileSync(dailyPath(root), "utf8");
          assert.deepEqual(missingLines(expected, content), [], step);
          if (fixture.bom) assert.equal(content.startsWith(BOM), true, step);
          if (fixture.crlf) assert.equal(content.replace(/\r\n/g, "").includes("\n"), false, step);
        };
        today.todayApi.regenerateFocusMirror(settings, TODAY);
        check("prime");
        for (let step = 0; step < 14; step += 1) {
          const op = Math.floor(random() * 10);
          const label = `step ${step} op ${op}`;
          const task = pick(openTasks());
          try {
            if (op === 0 && task) today.todayApi.schedule(settings, { projectId: task.projectId, line: task.line, raw: task.raw, date: pick([TODAY, TOMORROW, null]) ?? null });
            if (op === 1 && task) board.writeBoardTaskSynced(settings, { projectId: task.projectId, line: task.line, raw: task.raw, status: pick(["todo", "doing", "done"] as const) ?? "done" });
            if (op === 2 && task) board.writeBoardTaskSynced(settings, { projectId: task.projectId, line: task.line, raw: task.raw, title: `${task.title} r${step}` });
            if (op === 3) {
              const content = readFileSync(dailyPath(root), "utf8");
              const lines = content.split(/(\r\n|\n)/);
              const boxes = lines.flatMap((line, index) => (/^\s*[-*]\s+\[[ xX-]\]/.test(line) ? [index] : []));
              const at = pick(boxes);
              if (at !== undefined) {
                const line = lines[at] as string;
                lines[at] = line.replace(/^(\s*[-*]\s+\[)[ xX-](\])/, (_whole, open: string, close: string) => `${open}${random() < 0.5 ? "x" : " "}${close}`);
                writeFileSync(dailyPath(root), lines.join(""));
                today.queueDailyDiskChange(TODAY);
              }
            }
            if (op === 4) {
              const added = `- [ ] typed by hand ${seed}-${step}`;
              const content = readFileSync(dailyPath(root), "utf8");
              const eol = content.includes("\r\n") ? "\r\n" : "\n";
              const lines = content.split(/\r\n|\n/);
              const heading = lines.findIndex((line) => line.trim() === "## Focus");
              const at = heading === -1 ? lines.length - 1 : heading + 1;
              lines.splice(at, 0, added);
              writeFileSync(dailyPath(root), lines.join(eol));
              const expectedHeading = expected.findIndex((line) => line.trim() === "## Focus");
              expected.splice(expectedHeading === -1 ? expected.length - 1 : expectedHeading + 1, 0, added);
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
          } catch (err) {
            if (!(err instanceof board.TaskConflictError) && !(err instanceof Error && /occurrence|nothing was written/.test(err.message))) throw err;
          }
          today.flushMirrors(settings);
          check(label);
        }
      });
    }
  }
});
