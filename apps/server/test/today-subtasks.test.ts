import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-today-subtasks-data-"));
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
  today.setFocusStability({ delayMs: 0, reread: null });
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

const TODAY = dayOf(new Date());
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
  const root = mkdtempSync(join(tmpdir(), "cch-today-subtasks-vault-"));
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

function tasksIn(settings: DelegationSettings, title: string): BoardTask[] {
  return flatten(board.readBoard(settings).tasks).filter((task) => task.projectId === "alpha" && task.title === title);
}

function taskIn(settings: DelegationSettings, title: string): BoardTask {
  const found = tasksIn(settings, title)[0];
  assert.ok(found, title);
  return found;
}

const dailyRel = `daily/${TODAY}.md`;
const alphaLine = (title: string): string => `- [ ] [[alpha|Alpha]] - ${title}`;
const projectLines = (root: string): string[] => read(root, "projects/alpha.md").split(/\r\n|\n/).slice(4, -5);

function settle(settings: DelegationSettings): void {
  for (let round = 0; round < 3; round += 1) {
    today.flushMirrors(settings);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
  }
}

function snapshot(root: string): string[] {
  return ["projects/alpha.md", dailyRel].map((rel) => (existsSync(join(root, rel)) ? read(root, rel) : ""));
}

function assertSettled(settings: DelegationSettings, root: string): void {
  const before = snapshot(root);
  for (let round = 0; round < 3; round += 1) {
    today.flushMirrors(settings);
    assert.equal(today.todayApi.regenerateFocusMirror(settings, TODAY).changed, false, `round ${round}`);
  }
  assert.deepEqual(snapshot(root), before);
}

function plan(settings: DelegationSettings, task: BoardTask, planned: boolean): ReturnType<Today["todayApi"]["planSubtask"]> {
  return today.todayApi.planSubtask(settings, TODAY, { projectId: task.projectId, line: task.line, raw: task.raw, planned });
}

describe("H1 item 2: a task enters Today with its head and only the subtasks dated that day", () => {
  it("enters with the head only when no subtask has its own date for the day", () => {
    const root = lab(
      { alpha: project("Alpha", [`- [ ] Parent ${SCHEDULED} ${TODAY}`, "  - [ ] Sub A", "  - [ ] Sub B", `  - [x] Sub C ${DONE} ${TODAY}`]) },
      { [TODAY]: dailyOf(TODAY, ["- [ ]"]) },
    );
    const settings = useVault(root);
    settle(settings);
    const content = read(root, dailyRel);
    assert.ok(content.includes(`${alphaLine("Parent")}\n`));
    assert.ok(!content.includes("Sub A"));
    assert.ok(!content.includes("Sub B"));
    assert.ok(!content.includes("Sub C"));
    assert.deepEqual(today.readToday(settings, TODAY).focus.map((entry) => entry.visibleSubtasks), [[]]);
    assertSettled(settings, root);
  });

  it("enters with the head only on a daily created by the hub and on a schedule from the hub", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Parent ${SCHEDULED} ${TODAY}`, "  - [ ] Sub A", "- [ ] Other", "  - [ ] Sub other"]) });
    const settings = useVault(root);
    today.todayApi.createToday(settings, TODAY);
    const created = read(root, dailyRel);
    assert.ok(created.includes(`${alphaLine("Parent")}\n`));
    assert.ok(!created.includes("Sub A"));
    const other = taskIn(settings, "Other");
    today.todayApi.schedule(settings, { projectId: "alpha", line: other.line, raw: other.raw, date: TODAY, from: TODAY });
    settle(settings);
    const scheduled = read(root, dailyRel);
    assert.ok(scheduled.includes(`${alphaLine("Other")}\n`));
    assert.ok(!scheduled.includes("Sub other"));
  });

  it("enters with the subtasks that carry their own date for the day, never a done one", () => {
    const root = lab(
      {
        alpha: project("Alpha", [
          `- [ ] Parent ${SCHEDULED} ${TODAY}`,
          `  - [ ] Sub A ${SCHEDULED} ${TODAY}`,
          "  - [ ] Sub B",
          `  - [x] Sub C ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`,
        ]),
      },
      { [TODAY]: dailyOf(TODAY, ["- [ ]"]) },
    );
    const settings = useVault(root);
    settle(settings);
    const content = read(root, dailyRel);
    assert.ok(content.includes(`${alphaLine("Parent")}\n  - [ ] Sub A\n`));
    assert.ok(!content.includes("Sub B"));
    assert.ok(!content.includes("Sub C"));
    assertSettled(settings, root);
  });
});

describe("H1 item 2: an existing daily keeps the subtask lines it already has", () => {
  it("the mirror leaves every subtask line of an existing daily byte for byte", () => {
    const focus = [alphaLine("Parent"), "  - [ ] Sub A", "  - [ ] Sub B", "  - my note", "  - [x] Sub C"];
    const open = [`- [ ] Parent ${SCHEDULED} ${TODAY}`, "  - [ ] Sub A", "  - [ ] Sub B", `  - [x] Sub C ${DONE} ${TODAY}`];
    const root = lab({ alpha: project("Alpha", open) }, { [TODAY]: dailyOf(TODAY, focus) });
    const settings = useVault(root);
    settle(settings);
    assert.equal(read(root, dailyRel), dailyOf(TODAY, focus));
    assert.deepEqual(projectLines(root), open);
    assert.deepEqual(today.readToday(settings, TODAY).focus[0]?.visibleSubtasks, ["Sub A", "Sub B", "Sub C"].map((title) => taskIn(settings, title).id));
    assertSettled(settings, root);
  });

  it("only the explicit uncheck removes a line it can identify, and a check of a listed line only adds the date", () => {
    const focus = [alphaLine("Parent"), "  - [ ] Sub A", "  - [ ] Sub B", "  - my note"];
    const root = lab({ alpha: project("Alpha", [`- [ ] Parent ${SCHEDULED} ${TODAY}`, "  - [ ] Sub A", "  - [ ] Sub B"]) }, { [TODAY]: dailyOf(TODAY, focus) });
    const settings = useVault(root);
    settle(settings);
    const options = today.todayApi.subtaskOptions(settings, TODAY, { projectId: "alpha", line: taskIn(settings, "Parent").line });
    assert.deepEqual(
      options.subtasks.map((item) => [item.title, item.inToday, item.planned]),
      [
        ["Sub A", true, false],
        ["Sub B", true, false],
      ],
    );
    plan(settings, taskIn(settings, "Sub A"), true);
    assert.equal(read(root, dailyRel), dailyOf(TODAY, focus));
    assert.equal(taskIn(settings, "Sub A").scheduled, TODAY);
    plan(settings, taskIn(settings, "Sub B"), false);
    assert.equal(read(root, dailyRel), dailyOf(TODAY, [alphaLine("Parent"), "  - [ ] Sub A", "  - my note"]));
    assert.equal(taskIn(settings, "Sub B").scheduled, null);
    settle(settings);
    assertSettled(settings, root);
    assert.equal(taskIn(settings, "Sub A").scheduled, TODAY);
  });
});

describe("H1 item 2: Plan subtasks checks and unchecks a subtask", () => {
  it("lists the open subtasks, checks one into the daily under its parent with its date, and unchecks it back", () => {
    const open = [`- [ ] Parent ${SCHEDULED} ${TODAY}`, "  - [ ] Sub A", "  - [-] Sub B", `  - [x] Sub C ${DONE} ${TODAY}`];
    const root = lab({ alpha: project("Alpha", open) }, { [TODAY]: dailyOf(TODAY, ["- [ ]"]) });
    const settings = useVault(root);
    settle(settings);
    const before = read(root, dailyRel);
    const parent = taskIn(settings, "Parent");
    const listed = today.todayApi.subtaskOptions(settings, TODAY, { projectId: "alpha", line: parent.line });
    assert.deepEqual(
      listed.subtasks.map((item) => [item.title, item.status, item.inToday]),
      [
        ["Sub A", "todo", false],
        ["Sub B", "doing", false],
      ],
    );
    const checked = plan(settings, taskIn(settings, "Sub B"), true);
    assert.ok(read(root, dailyRel).includes(`${alphaLine("Parent")}\n  - [-] Sub B\n`));
    assert.ok(!read(root, dailyRel).includes("Sub A"));
    assert.deepEqual(projectLines(root), [`- [ ] Parent ${SCHEDULED} ${TODAY}`, "  - [ ] Sub A", `  - [-] Sub B ${SCHEDULED} ${TODAY}`, `  - [x] Sub C ${DONE} ${TODAY}`]);
    assert.deepEqual(
      checked.subtasks.map((item) => [item.title, item.inToday, item.planned]),
      [
        ["Sub A", false, false],
        ["Sub B", true, true],
      ],
    );
    settle(settings);
    assertSettled(settings, root);
    assert.deepEqual(
      today.readToday(settings, TODAY).focus.map((entry) => [entry.task.title, entry.visibleSubtasks]),
      [["Parent", [taskIn(settings, "Sub B").id]]],
    );
    plan(settings, taskIn(settings, "Sub B"), false);
    assert.equal(read(root, dailyRel), before);
    assert.deepEqual(projectLines(root), open);
    settle(settings);
    assertSettled(settings, root);
    assert.equal(read(root, dailyRel), before);
  });

  it("refuses a done subtask and a task that is not a subtask, writing nothing", () => {
    const open = [`- [ ] Parent ${SCHEDULED} ${TODAY}`, `  - [x] Sub C ${DONE} ${TODAY}`];
    const root = lab({ alpha: project("Alpha", open) }, { [TODAY]: dailyOf(TODAY, ["- [ ]"]) });
    const settings = useVault(root);
    settle(settings);
    const before = snapshot(root);
    assert.throws(() => plan(settings, taskIn(settings, "Sub C"), true), /done or archived/);
    assert.throws(() => plan(settings, taskIn(settings, "Parent"), true), /not a subtask/);
    assert.deepEqual(snapshot(root), before);
  });

  it("refuses a stale subtask line with a conflict", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Parent ${SCHEDULED} ${TODAY}`, "  - [ ] Sub A"]) }, { [TODAY]: dailyOf(TODAY, ["- [ ]"]) });
    const settings = useVault(root);
    settle(settings);
    const sub = taskIn(settings, "Sub A");
    const before = snapshot(root);
    assert.throws(
      () => today.todayApi.planSubtask(settings, TODAY, { projectId: "alpha", line: sub.line, raw: `${sub.raw} changed`, planned: true }),
      (err: unknown) => err instanceof today.StaleTodayLineError,
    );
    assert.deepEqual(snapshot(root), before);
  });
});

describe("H1 item 2: subtasks with the same title are never swapped", () => {
  it("refuses to check or uncheck either of two subtasks with the same title and writes nothing", () => {
    const focus = [alphaLine("Parent"), "  - [ ] Same"];
    const root = lab({ alpha: project("Alpha", [`- [ ] Parent ${SCHEDULED} ${TODAY}`, "  - [ ] Same", "  - [ ] Same", "  - [ ] Other"]) }, { [TODAY]: dailyOf(TODAY, focus) });
    const settings = useVault(root);
    settle(settings);
    const before = snapshot(root);
    const [first, second] = tasksIn(settings, "Same");
    assert.ok(first && second);
    assert.throws(() => plan(settings, first, true), /same title/);
    assert.throws(() => plan(settings, second, false), /same title/);
    assert.deepEqual(snapshot(root), before);
    const options = today.todayApi.subtaskOptions(settings, TODAY, { projectId: "alpha", line: taskIn(settings, "Parent").line });
    assert.deepEqual(
      options.subtasks.map((item) => [item.title, item.duplicate]),
      [
        ["Same", true],
        ["Same", true],
        ["Other", false],
      ],
    );
    plan(settings, taskIn(settings, "Other"), true);
    assert.equal(read(root, dailyRel), dailyOf(TODAY, [alphaLine("Parent"), "  - [ ] Same", "  - [ ] Other"]));
  });

  it("a dated subtask whose title repeats under the same parent never enters as the wrong line", () => {
    const root = lab(
      { alpha: project("Alpha", [`- [ ] Parent ${SCHEDULED} ${TODAY}`, `  - [ ] Same ${SCHEDULED} ${TODAY}`, "  - [ ] Same"]) },
      { [TODAY]: dailyOf(TODAY, ["- [ ]"]) },
    );
    const settings = useVault(root);
    settle(settings);
    const content = read(root, dailyRel);
    assert.ok(content.includes(`${alphaLine("Parent")}\n`));
    assert.ok(!content.includes("  - [ ] Same"));
  });
});
