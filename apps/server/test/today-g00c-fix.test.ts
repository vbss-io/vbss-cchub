import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-today-g00c-fix-data-"));
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
const START = "\u{1F6EB}";
const DONE = "✅";
const BOM = String.fromCharCode(0xfeff);
const roots: string[] = [];

before(async () => {
  store = await import("../src/delegation-store.js");
  board = await import("../src/tasks-board.js");
  daily = await import("../src/daily.js");
  today = await import("../src/today.js");
  today.installTodayHooks();
  today.setFocusStability?.({ delayMs: 0, reread: null });
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
const EMPTY_FOCUS = "## Focus\n\n- [ ]\n";

const TEMPLATE = ["---", "type: daily", "---", "", "# {{date}}", "", "## Focus", "", "- [ ]", "", "## Meetings", "", "-", ""].join("\n");

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function project(title: string, open: string[], eol = "\n"): string {
  return [`# ${title}`, "", "## Open loops", "", ...open, "", "## Done loops", "", "-", ""].join(eol);
}

function dailyOf(date: string, focus: string[], eol = "\n"): string {
  return ["---", "type: daily", "---", "", `# ${date}`, "", "## Focus", "", ...focus, "", "## Meetings", "", "- 10:00 Standup", ""].join(eol);
}

function lab(projects: Record<string, string>, dailies: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cch-today-g00c-fix-vault-"));
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
  store.setSetting(`today.migrated.${TOMORROW}`, "1");
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

function editProject(root: string, name: string, change: (content: string) => string): string {
  const file = join(root, `projects/${name}.md`);
  const next = change(readFileSync(file, "utf8"));
  writeFileSync(file, next);
  return next;
}

function settle(settings: DelegationSettings, ...dates: string[]): void {
  for (let round = 0; round < 3; round += 1) {
    today.flushMirrors(settings);
    for (const date of dates) today.todayApi.regenerateFocusMirror(settings, date);
  }
}

function snapshot(root: string, rels: string[]): Map<string, string> {
  return new Map(rels.map((rel) => [rel, existsSync(join(root, rel)) ? read(root, rel) : ""]));
}

function assertSettled(settings: DelegationSettings, root: string, dates: string[], rels: string[]): void {
  const before = snapshot(root, rels);
  for (let round = 0; round < 3; round += 1) {
    today.flushMirrors(settings);
    for (const date of dates) assert.equal(today.todayApi.regenerateFocusMirror(settings, date).changed, false, `${date} round ${round}`);
  }
  assert.deepEqual(snapshot(root, rels), before);
}

const focusTitles = (settings: DelegationSettings, date: string): string[] => today.readToday(settings, date).focus.map((entry) => entry.task.title);

const projectLines = (root: string, name: string): string[] => read(root, `projects/${name}.md`).split(/\r\n|\n/).slice(4, -5);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function stripSync(date: string): void {
  const record = store.getTodayBaseline(date);
  assert.ok(record);
  const state = JSON.parse(record.state) as Record<string, unknown>;
  delete state.sync;
  store.saveTodayBaseline({ date, path: record.path, content: record.content, state: JSON.stringify(state) });
}

describe("G00c fix, finding 1: a line typed for a task of another day never edits that other daily", () => {
  const LINE = "- [ ] [[alpha|Alpha]] - Task three";

  it("moves the date to the typed day and leaves the daily of the old date byte for byte, its focus still listing the line", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task three ${SCHEDULED} ${TOMORROW}`]) }, { [TODAY]: dailyOf(TODAY, ["- [ ]"]), [TOMORROW]: dailyOf(TOMORROW, [LINE, "  - my note for tomorrow"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    today.todayApi.regenerateFocusMirror(settings, TOMORROW);
    const tomorrow = read(root, dailyRel(TOMORROW));
    const typed = editDaily(root, TODAY, (content) => content.replace(EMPTY_FOCUS, `## Focus\n\n${LINE}\n`));
    settle(settings, TODAY, TOMORROW);
    assert.equal(taskIn(settings, "alpha", "Task three").scheduled, TODAY);
    assert.equal(read(root, dailyRel(TOMORROW)), tomorrow);
    assert.equal(read(root, dailyRel(TODAY)), typed);
    assert.deepEqual(focusTitles(settings, TODAY), ["Task three"]);
    assert.deepEqual(focusTitles(settings, TOMORROW), ["Task three"]);
    assertSettled(settings, root, [TODAY, TOMORROW], ["projects/alpha.md", dailyRel(TODAY), dailyRel(TOMORROW)]);
    assert.equal(taskIn(settings, "alpha", "Task three").scheduled, TODAY);
  });

  it("lets the later daily take the date back once the day that took it is past", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task three ${SCHEDULED} ${TOMORROW}`]) }, { [TODAY]: dailyOf(TODAY, ["- [ ]"]), [TOMORROW]: dailyOf(TOMORROW, [LINE]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    today.todayApi.regenerateFocusMirror(settings, TOMORROW);
    editDaily(root, TODAY, (content) => content.replace(EMPTY_FOCUS, `## Focus\n\n${LINE}\n`));
    settle(settings, TODAY, TOMORROW);
    const tomorrow = read(root, dailyRel(TOMORROW));
    editProject(root, "alpha", (content) => content.replace(`${SCHEDULED} ${TODAY}`, `${SCHEDULED} ${YESTERDAY}`));
    today.todayApi.regenerateFocusMirror(settings, TOMORROW);
    assert.equal(taskIn(settings, "alpha", "Task three").scheduled, TOMORROW);
    assert.equal(read(root, dailyRel(TOMORROW)), tomorrow);
  });

  it("removing the date in the project deletes the line only in the daily of the removed date", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task three ${SCHEDULED} ${TOMORROW}`]) }, { [TODAY]: dailyOf(TODAY, ["- [ ]"]), [TOMORROW]: dailyOf(TOMORROW, [LINE]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    today.todayApi.regenerateFocusMirror(settings, TOMORROW);
    const typed = editDaily(root, TODAY, (content) => content.replace(EMPTY_FOCUS, `## Focus\n\n${LINE}\n`));
    settle(settings, TODAY, TOMORROW);
    const tomorrow = read(root, dailyRel(TOMORROW));
    editProject(root, "alpha", (content) => content.replace(` ${SCHEDULED} ${TODAY}`, ""));
    settle(settings, TODAY, TOMORROW);
    assert.equal(taskIn(settings, "alpha", "Task three").scheduled, null);
    assert.equal(read(root, dailyRel(TODAY)), typed.replace(`${LINE}\n\n`, ""));
    assert.equal(read(root, dailyRel(TOMORROW)), tomorrow);
  });
});

describe("G00c fix, finding 2: the same task typed in two dailies", () => {
  it("keeps both typed lines byte for byte and the date of the daily seen last", () => {
    const LINE = "- [ ] [[alpha|Alpha]] - Task four";
    const root = lab({ alpha: project("Alpha", ["- [ ] Task four"]) }, { [TODAY]: dailyOf(TODAY, ["- [ ]"]), [TOMORROW]: dailyOf(TOMORROW, ["- [ ]"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    today.todayApi.regenerateFocusMirror(settings, TOMORROW);
    const first = editDaily(root, TODAY, (content) => content.replace(EMPTY_FOCUS, `## Focus\n\n${LINE}\n`));
    const second = editDaily(root, TOMORROW, (content) => content.replace(EMPTY_FOCUS, `## Focus\n\n${LINE}\n`));
    settle(settings, TODAY, TOMORROW);
    settle(settings, TODAY, TOMORROW);
    assert.equal(read(root, dailyRel(TODAY)), first);
    assert.equal(read(root, dailyRel(TOMORROW)), second);
    assert.equal(taskIn(settings, "alpha", "Task four").scheduled, TOMORROW);
    assert.deepEqual(focusTitles(settings, TODAY), ["Task four"]);
    assert.deepEqual(focusTitles(settings, TOMORROW), ["Task four"]);
    assertSettled(settings, root, [TODAY, TOMORROW], ["projects/alpha.md", dailyRel(TODAY), dailyRel(TOMORROW)]);
  });
});

describe("G00c fix, finding 3: a daily that reads empty or broken changes nothing, and done tasks are history", () => {
  const LINES = ["- [ ] [[alpha|Alpha]] - Task one", "- [ ] [[alpha|Alpha]] - Task two"];
  const ALPHA = project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY} ${DUE} 2026-12-24 #p1`, `- [ ] Task two #p2 ${SCHEDULED} ${TODAY}`, "- [ ] x"]);

  it("a truncated daily removes no date, and the restored daily leaves both files byte for byte", () => {
    const root = lab({ alpha: ALPHA }, { [TODAY]: dailyOf(TODAY, LINES) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const projectBefore = read(root, "projects/alpha.md");
    const dailyBefore = read(root, dailyRel(TODAY));
    editDaily(root, TODAY, (content) => content.slice(0, 30));
    settle(settings, TODAY);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    assert.equal(read(root, dailyRel(TODAY)), dailyBefore.slice(0, 30));
    editDaily(root, TODAY, () => dailyBefore);
    settle(settings, TODAY);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    assert.equal(read(root, dailyRel(TODAY)), dailyBefore);
  });

  it("a daily emptied to 0 bytes, without its frontmatter or without its focus heading keeps every date, like a deleted daily", () => {
    const variants: [string, (content: string) => string][] = [
      ["empty", () => ""],
      ["bom only", () => BOM],
      ["no frontmatter", (content) => content.replace("---\ntype: daily\n---\n\n", "")],
      ["heading renamed", (content) => content.replace("## Focus", "## Foco")],
      ["deleted", (content) => content],
    ];
    for (const [name, change] of variants) {
      const root = lab({ alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyOf(TODAY, [LINES[0] as string]) });
      const settings = useVault(root);
      today.todayApi.regenerateFocusMirror(settings, TODAY);
      const projectBefore = read(root, "projects/alpha.md");
      if (name === "deleted") {
        unlinkSync(join(root, dailyRel(TODAY)));
        today.queueDailyDiskChange(TODAY);
      } else editDaily(root, TODAY, change);
      settle(settings, TODAY);
      assert.equal(read(root, "projects/alpha.md"), projectBefore, name);
    }
  });

  it("a daily emptied and restored keeps the date of a done task, an exact unlabeled line and a subtask", () => {
    const lines = ["- [x] [[alpha|Alpha]] - Done one", "- [ ] Exact unlabeled", "- [ ] [[alpha|Alpha]] - Parent", "  - [ ] Child"];
    const alpha = project("Alpha", [`- [x] Done one ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`, `- [ ] Exact unlabeled ${SCHEDULED} ${TODAY}`, `- [ ] Parent ${SCHEDULED} ${TODAY}`, `  - [ ] Child ${SCHEDULED} ${TODAY}`]);
    const root = lab({ alpha }, { [TODAY]: dailyOf(TODAY, lines) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const projectBefore = read(root, "projects/alpha.md");
    const dailyBefore = read(root, dailyRel(TODAY));
    editDaily(root, TODAY, () => "");
    settle(settings, TODAY);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    editDaily(root, TODAY, () => dailyBefore);
    settle(settings, TODAY);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    assert.equal(read(root, dailyRel(TODAY)), dailyBefore);
  });

  it("the line of a done task removed from the daily keeps its date, and its date removed in the project keeps its line", () => {
    const root = lab(
      { alpha: project("Alpha", [`- [x] Done one ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`, `- [x] Done two ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`]) },
      { [TODAY]: dailyOf(TODAY, ["- [x] [[alpha|Alpha]] - Done one", "- [x] [[alpha|Alpha]] - Done two"]) },
    );
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const edited = editDaily(root, TODAY, (content) => content.replace("- [x] [[alpha|Alpha]] - Done one\n", ""));
    settle(settings, TODAY);
    assert.equal(taskIn(settings, "alpha", "Done one").scheduled, TODAY);
    editProject(root, "alpha", (content) => content.replace(`Done two ${SCHEDULED} ${TODAY} `, "Done two "));
    settle(settings, TODAY);
    assert.equal(read(root, dailyRel(TODAY)), edited);
  });

  it("an emptied focus section with its heading still removes the dates, after the second read agrees", () => {
    const root = lab({ alpha: ALPHA }, { [TODAY]: dailyOf(TODAY, LINES) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const emptied = editDaily(root, TODAY, (content) => content.replace(`${LINES.join("\n")}\n`, "-\n"));
    today.setFocusStability({ reread: () => dailyOf(TODAY, LINES) });
    try {
      settle(settings, TODAY);
      assert.equal(taskIn(settings, "alpha", "Task one").scheduled, TODAY);
      assert.equal(taskIn(settings, "alpha", "Task two").scheduled, TODAY);
    } finally {
      today.setFocusStability({ reread: null });
    }
    settle(settings, TODAY);
    assert.deepEqual(projectLines(root, "alpha"), [`- [ ] Task one ${DUE} 2026-12-24 #p1`, "- [ ] Task two #p2", "- [ ] x"]);
    assert.equal(read(root, dailyRel(TODAY)), emptied);
    assert.deepEqual(focusTitles(settings, TODAY), []);
  });

  it("waits for the stability window before removing a date, and applies the removal when the file still reads the same", async () => {
    const root = lab({ alpha: ALPHA }, { [TODAY]: dailyOf(TODAY, LINES) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    today.setFocusStability({ delayMs: 60 });
    try {
      editDaily(root, TODAY, (content) => content.replace(`${LINES[1] as string}\n`, ""));
      today.flushMirrors(settings);
      assert.equal(taskIn(settings, "alpha", "Task two").scheduled, TODAY);
      assert.deepEqual(today.todayApi.regenerateFocusMirror(settings, TODAY), { changed: false, skipped: "unsettled", applied: 0 });
      await sleep(200);
      assert.equal(taskIn(settings, "alpha", "Task two").scheduled, null);
      assert.equal(taskIn(settings, "alpha", "Task one").scheduled, TODAY);
    } finally {
      today.setFocusStability({ delayMs: 0 });
    }
  });

  it("drops a pending removal when the file changes back inside the stability window", async () => {
    const root = lab({ alpha: ALPHA }, { [TODAY]: dailyOf(TODAY, LINES) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const before = read(root, "projects/alpha.md");
    today.setFocusStability({ delayMs: 60 });
    try {
      const full = read(root, dailyRel(TODAY));
      editDaily(root, TODAY, (content) => content.replace(`${LINES.join("\n")}\n`, "-\n"));
      today.flushMirrors(settings);
      editDaily(root, TODAY, () => full);
      today.flushMirrors(settings);
      await sleep(200);
      assert.equal(read(root, "projects/alpha.md"), before);
    } finally {
      today.setFocusStability({ delayMs: 0 });
    }
  });
});

describe("G00c fix, finding 4: a baseline written by the previous version", () => {
  it("inserts the line of a task dated the day that the daily never had, and unschedules a seen task whose line was removed", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Seen one ${SCHEDULED} ${TODAY}`, `- [ ] Seen two ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyOf(TODAY, ["- [ ] [[alpha|Alpha]] - Seen one", "- [ ] [[alpha|Alpha]] - Seen two"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    stripSync(TODAY);
    editProject(root, "alpha", (content) => content.replace(`- [ ] Seen two ${SCHEDULED} ${TODAY}\n`, `- [ ] Seen two ${SCHEDULED} ${TODAY}\n- [ ] Brand new ${SCHEDULED} ${TODAY}\n`));
    editDaily(root, TODAY, (content) => content.replace("- [ ] [[alpha|Alpha]] - Seen two\n", ""));
    today.forgetTodayState();
    today.runStartupMirror(settings);
    settle(settings, TODAY);
    assert.deepEqual(projectLines(root, "alpha"), [`- [ ] Seen one ${SCHEDULED} ${TODAY}`, "- [ ] Seen two", `- [ ] Brand new ${SCHEDULED} ${TODAY}`]);
    assert.ok(read(root, dailyRel(TODAY)).includes("- [ ] [[alpha|Alpha]] - Seen one\n- [ ] [[alpha|Alpha]] - Brand new\n"));
    assert.deepEqual(focusTitles(settings, TODAY), ["Seen one", "Brand new"]);
  });

  it("inserts the line of a task dated in Obsidian while the previous version ran", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Seen one ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyOf(TODAY, ["- [ ] [[alpha|Alpha]] - Seen one"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    stripSync(TODAY);
    editProject(root, "alpha", (content) => content.replace("## Open loops\n\n", `## Open loops\n\n- [ ] Other day thing ${SCHEDULED} ${TODAY}\n`));
    today.forgetTodayState();
    today.runStartupMirror(settings);
    settle(settings, TODAY);
    assert.deepEqual(focusTitles(settings, TODAY), ["Seen one", "Other day thing"]);
    assert.ok(read(root, dailyRel(TODAY)).includes("- [ ] [[alpha|Alpha]] - Other day thing"));
  });

  it("the 15/11 case: a focus emptied while the previous version ran removes only the scheduled tokens of the seen tasks", () => {
    const open = [`- [ ] Task one ${SCHEDULED} ${TODAY} ${DUE} 2026-12-24 #p1`, `- [-] Task two #p2 ${SCHEDULED} ${TODAY}`, `- [ ] Weekly ${SCHEDULED} ${TODAY} ${REPEAT} every week`, `- [x] Done one ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`];
    const lines = ["- [ ] [[alpha|Alpha]] - Task one", "- [-] [[alpha|Alpha]] - Task two", "- [ ] [[alpha|Alpha]] - Weekly", "- [x] [[alpha|Alpha]] - Done one"];
    const root = lab({ alpha: project("Alpha", open) }, { [TODAY]: dailyOf(TODAY, lines) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    stripSync(TODAY);
    const emptied = editDaily(root, TODAY, (content) => content.replace(`${lines.join("\n")}\n`, "-\n"));
    today.forgetTodayState();
    today.runStartupMirror(settings);
    settle(settings, TODAY);
    assert.deepEqual(projectLines(root, "alpha"), [`- [ ] Task one ${DUE} 2026-12-24 #p1`, "- [-] Task two #p2", `- [ ] Weekly ${SCHEDULED} ${TODAY} ${REPEAT} every week`, `- [x] Done one ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`]);
    assert.equal(read(root, dailyRel(TODAY)), emptied);
  });

  it("the 15/11 case when the previous version already stored the emptied daily: the seen tasks lose only their scheduled token", () => {
    const open = [`- [ ] Task one ${SCHEDULED} ${TODAY} ${DUE} 2026-12-24 #p1`, `- [-] Task two #p2 ${SCHEDULED} ${TODAY}`];
    const lines = ["- [ ] [[alpha|Alpha]] - Task one", "- [-] [[alpha|Alpha]] - Task two"];
    const root = lab({ alpha: project("Alpha", open) }, { [TODAY]: dailyOf(TODAY, lines) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const emptied = editDaily(root, TODAY, (content) => content.replace(`${lines.join("\n")}\n`, "-\n"));
    today.forgetTodayState();
    stripSync(TODAY);
    const record = store.getTodayBaseline(TODAY);
    assert.ok(record);
    store.saveTodayBaseline({ date: TODAY, path: record.path, content: emptied, state: record.state });
    today.runStartupMirror(settings);
    settle(settings, TODAY);
    assert.deepEqual(projectLines(root, "alpha"), [`- [ ] Task one ${DUE} 2026-12-24 #p1`, "- [-] Task two #p2"]);
    assert.equal(read(root, dailyRel(TODAY)), emptied);
    assert.deepEqual(focusTitles(settings, TODAY), []);
  });
});

describe("G00c fix, finding 5: a daily created outside the hub", () => {
  it("gives the date of the day to the confident lines, never to a recurring or a done task", () => {
    const root = lab({ alpha: project("Alpha", ["- [ ] Plan the week", "- [ ] Write report", `- [ ] Weekly sync ${REPEAT} every week`, "- [ ] Ticked already", "- [ ] Exact unlabeled title"]) });
    const settings = useVault(root);
    const content = dailyOf(TODAY, ["- [ ] [[alpha|Alpha]] - Plan the week", "- [ ] [[alpha|Alpha]] - Write report", "- [ ] [[alpha|Alpha]] - Weekly sync", "- [x] [[alpha|Alpha]] - Ticked already", "- [ ] Exact unlabeled title"]);
    write(root, dailyRel(TODAY), content);
    today.queueDailyDiskChange(TODAY);
    settle(settings, TODAY);
    assert.equal(taskIn(settings, "alpha", "Plan the week").scheduled, TODAY);
    assert.equal(taskIn(settings, "alpha", "Write report").scheduled, TODAY);
    assert.equal(taskIn(settings, "alpha", "Exact unlabeled title").scheduled, TODAY);
    assert.equal(taskIn(settings, "alpha", "Weekly sync").scheduled, null);
    assert.equal(taskIn(settings, "alpha", "Ticked already").scheduled, null);
    assert.equal(read(root, dailyRel(TODAY)), content);
    assert.ok(focusTitles(settings, TODAY).includes("Plan the week"));
    assertSettled(settings, root, [TODAY], ["projects/alpha.md", dailyRel(TODAY)]);
  });
});

describe("G00c fix, finding 6: scheduled date edits touch only the scheduled token", () => {
  const D = "2026-11-20";
  const E = "2026-11-21";
  const X = "2026-12-24";
  const S0 = "2026-11-01";
  const T0 = "2026-11-10";
  const CASES: [string, string][] = [
    ["- [ ] Task", `- [ ] Task ${SCHEDULED} ${D}`],
    ["- [ ] Task #p1", `- [ ] Task #p1 ${SCHEDULED} ${D}`],
    [`- [ ] Task ${DUE} ${X}`, `- [ ] Task ${SCHEDULED} ${D} ${DUE} ${X}`],
    [`- [ ] Task ${DUE} ${X} #p1`, `- [ ] Task ${SCHEDULED} ${D} ${DUE} ${X} #p1`],
    [`- [ ] Task #p1 ${DUE} ${X}`, `- [ ] Task #p1 ${SCHEDULED} ${D} ${DUE} ${X}`],
    [`- [ ] Task ${START} ${S0} ${DUE} ${X}`, `- [ ] Task ${START} ${S0} ${SCHEDULED} ${D} ${DUE} ${X}`],
    [`- [ ] Task ${START} ${S0}`, `- [ ] Task ${START} ${S0} ${SCHEDULED} ${D}`],
    [`- [ ] Task ${REPEAT} every week`, `- [ ] Task ${REPEAT} every week ${SCHEDULED} ${D}`],
    [`- [ ] Task ${REPEAT} every week ${DUE} ${X} #p2`, `- [ ] Task ${REPEAT} every week ${SCHEDULED} ${D} ${DUE} ${X} #p2`],
    [`- [x] Task ${DONE} ${T0}`, `- [x] Task ${SCHEDULED} ${D} ${DONE} ${T0}`],
    [`- [x] Task #p2 ${DONE} ${T0}`, `- [x] Task #p2 ${SCHEDULED} ${D} ${DONE} ${T0}`],
    [`- [x] Task ${DUE} ${X} ${DONE} ${T0}`, `- [x] Task ${SCHEDULED} ${D} ${DUE} ${X} ${DONE} ${T0}`],
    ["  - [-] Sub [[link|Label]] with `code` and text", `  - [-] Sub [[link|Label]] with \`code\` and text ${SCHEDULED} ${D}`],
    ["- [ ] Blocked: Task - waiting on Ana", `- [ ] Blocked: Task - waiting on Ana ${SCHEDULED} ${D}`],
    ["- [ ] Task with trailing spaces  ", `- [ ] Task with trailing spaces ${SCHEDULED} ${D}  `],
  ];

  it("adds the token in its canonical place and removes it, every other byte staying put", () => {
    const settings = useVault(lab({ alpha: project("Alpha", ["- [ ] x"]) }));
    for (const [plain, dated] of CASES) {
      assert.equal(board.withScheduledToken(plain, settings.tasks, D), dated, plain);
      assert.equal(board.withScheduledToken(dated, settings.tasks, null), plain, dated);
      assert.equal(board.withScheduledToken(dated, settings.tasks, D), dated, dated);
      assert.equal(board.withScheduledToken(dated, settings.tasks, E), dated.replace(D, E), dated);
    }
  });

  it("removes a token in a non canonical place without moving the other markers", () => {
    const settings = useVault(lab({ alpha: project("Alpha", ["- [ ] x"]) }));
    const cases: [string, string][] = [
      [`- [ ] Task one ${SCHEDULED} ${D} ${DUE} ${X} #p1`, `- [ ] Task one ${DUE} ${X} #p1`],
      [`- [ ] ${SCHEDULED} ${D} Task first`, "- [ ] Task first"],
      [`- [ ] Task ${SCHEDULED}️ ${D}`, "- [ ] Task"],
      [`- [ ] Task #p1 ${SCHEDULED} ${D} ${REPEAT} every day`, `- [ ] Task #p1 ${REPEAT} every day`],
      [`- [x] Task ${SCHEDULED} ${D} ${DONE} ${T0} #p3`, `- [x] Task ${DONE} ${T0} #p3`],
    ];
    for (const [dated, plain] of cases) assert.equal(board.withScheduledToken(dated, settings.tasks, null), plain, dated);
  });

  it("an automatic unschedule from a removed daily line keeps the project line byte for byte apart from the token, CRLF and BOM included", () => {
    const raw = `- [ ] Task one ${SCHEDULED} ${TODAY} ${DUE} 2026-12-24 #p1`;
    const root = lab({ alpha: `${BOM}${project("Alpha", [raw, `- [-] Task two #p2 ${SCHEDULED} ${TODAY}`], "\r\n")}` }, { [TODAY]: `${BOM}${dailyOf(TODAY, ["- [ ] [[alpha|Alpha]] - Task one", "- [-] [[alpha|Alpha]] - Task two"], "\r\n")}` });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const before = read(root, "projects/alpha.md");
    editDaily(root, TODAY, (content) => content.replace("- [ ] [[alpha|Alpha]] - Task one\r\n", ""));
    settle(settings, TODAY);
    assert.equal(read(root, "projects/alpha.md"), before.replace(raw, `- [ ] Task one ${DUE} 2026-12-24 #p1`));
    const two = taskIn(settings, "alpha", "Task two");
    today.todayApi.schedule(settings, { projectId: "alpha", line: two.line, raw: two.raw, date: null, from: TODAY });
    assert.equal(read(root, "projects/alpha.md"), before.replace(raw, `- [ ] Task one ${DUE} 2026-12-24 #p1`).replace(`- [-] Task two #p2 ${SCHEDULED} ${TODAY}`, "- [-] Task two #p2"));
  });

  it("Clear today removes only the tokens and Undo restores every byte", () => {
    const open = [`- [ ] Task one ${SCHEDULED} ${TODAY} ${DUE} 2026-12-24 #p1`, `  - [ ] Sub one ${SCHEDULED} ${TODAY}`, `- [x] Task two ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`, `- [ ] Rec ${SCHEDULED} ${TODAY} ${REPEAT} every day`];
    const root = lab({ alpha: project("Alpha", open, "\r\n") }, { [TODAY]: dailyOf(TODAY, ["- [ ] [[alpha|Alpha]] - Task one", "  - [ ] Sub one", "  - free note", "- [x] [[alpha|Alpha]] - Task two", "- [ ] free"], "\r\n") });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const projectBefore = read(root, "projects/alpha.md");
    const dailyBefore = read(root, dailyRel(TODAY));
    const cleared = today.todayApi.clearToday(settings, TODAY);
    assert.deepEqual(projectLines(root, "alpha"), [`- [ ] Task one ${DUE} 2026-12-24 #p1`, "  - [ ] Sub one", `- [x] Task two ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`, `- [ ] Rec ${SCHEDULED} ${TODAY} ${REPEAT} every day`]);
    settle(settings, TODAY);
    assert.deepEqual(today.todayApi.undoClear(settings, TODAY, cleared.token), { restored: true });
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
    assert.equal(read(root, dailyRel(TODAY)), dailyBefore);
  });
});

describe("G00c fix, finding 7: automatic syncs never delete free notes", () => {
  const FOCUS = ["- [ ] [[alpha|Alpha]] - Task one", "  - [ ] Sub one", "  - my own notes on this", "    - a deeper note", "- [ ] [[alpha|Alpha]] - Task two"];
  const ALPHA = project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`, "  - [ ] Sub one", `- [ ] Task two ${SCHEDULED} ${TODAY}`]);

  it("the date removed in the project removes the line and its subtask lines, and keeps the notes one level out", () => {
    const root = lab({ alpha: ALPHA }, { [TODAY]: dailyOf(TODAY, FOCUS) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    editProject(root, "alpha", (content) => content.replace(`- [ ] Task one ${SCHEDULED} ${TODAY}`, "- [ ] Task one"));
    settle(settings, TODAY);
    assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, ["- my own notes on this", "  - a deeper note", "- [ ] [[alpha|Alpha]] - Task two"]));
    assert.deepEqual(focusTitles(settings, TODAY), ["Task two"]);
  });

  it("moving a task to another day from the hub keeps its notes in the daily it leaves", () => {
    const root = lab({ alpha: ALPHA }, { [TODAY]: dailyOf(TODAY, FOCUS), [TOMORROW]: dailyOf(TOMORROW, ["- [ ]"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    today.todayApi.regenerateFocusMirror(settings, TOMORROW);
    const one = taskIn(settings, "alpha", "Task one");
    today.todayApi.schedule(settings, { projectId: "alpha", line: one.line, raw: one.raw, date: TOMORROW, from: TODAY });
    settle(settings, TODAY, TOMORROW);
    assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, ["- my own notes on this", "  - a deeper note", "- [ ] [[alpha|Alpha]] - Task two"]));
    assert.equal(taskIn(settings, "alpha", "Task one").scheduled, TOMORROW);
    assert.ok(read(root, dailyRel(TOMORROW)).includes("- [ ] [[alpha|Alpha]] - Task one\n"));
  });

  it("Remove from focus still deletes the whole block", () => {
    const root = lab({ alpha: ALPHA }, { [TODAY]: dailyOf(TODAY, FOCUS) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const one = taskIn(settings, "alpha", "Task one");
    today.todayApi.schedule(settings, { projectId: "alpha", line: one.line, raw: one.raw, date: null, from: TODAY });
    assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, ["- [ ] [[alpha|Alpha]] - Task two"]));
  });
});

describe("G00c fix, finding 9: Undo for Clear today", () => {
  it("is kept in the hub database, so it survives the in-memory state", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`, "- [ ] other"]) }, { [TODAY]: dailyOf(TODAY, ["- [ ] [[alpha|Alpha]] - Task one"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const before = snapshot(root, ["projects/alpha.md", dailyRel(TODAY)]);
    const cleared = today.todayApi.clearToday(settings, TODAY);
    assert.ok((store.getSetting("today.clearUndo") ?? "").includes(cleared.token));
    today.forgetTodayState();
    assert.deepEqual(today.todayApi.undoClear(settings, TODAY, cleared.token), { restored: true });
    assert.deepEqual(snapshot(root, ["projects/alpha.md", dailyRel(TODAY)]), before);
    assert.equal((store.getSetting("today.clearUndo") ?? "").includes(cleared.token), false);
  });

  it("refuses with the name of the project file that changed and writes nothing", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`, "- [ ] other"]) }, { [TODAY]: dailyOf(TODAY, ["- [ ] [[alpha|Alpha]] - Task one"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const cleared = today.todayApi.clearToday(settings, TODAY);
    editProject(root, "alpha", (content) => content.replace("## Open loops\n\n", "## Open loops\n\n- [ ] inserted above\n"));
    settle(settings, TODAY);
    const after = snapshot(root, ["projects/alpha.md", dailyRel(TODAY)]);
    assert.throws(() => today.todayApi.undoClear(settings, TODAY, cleared.token), /^Error: projects\/alpha\.md changed after Clear today, nothing was restored$/);
    assert.deepEqual(snapshot(root, ["projects/alpha.md", dailyRel(TODAY)]), after);
  });

  it("expires after 30 minutes", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyOf(TODAY, ["- [ ] [[alpha|Alpha]] - Task one"]) });
    const settings = useVault(root);
    today.todayApi.regenerateFocusMirror(settings, TODAY);
    const cleared = today.todayApi.clearToday(settings, TODAY);
    const stored = JSON.parse(store.getSetting("today.clearUndo") ?? "{}") as Record<string, { at: number }>;
    const record = stored[cleared.token];
    assert.ok(record);
    record.at -= 31 * 60 * 1000;
    store.setSetting("today.clearUndo", JSON.stringify(stored));
    assert.throws(() => today.todayApi.undoClear(settings, TODAY, cleared.token), /nothing to undo/);
  });
});

const alphaLine = (title: string, mark = " "): string => `- [${mark}] [[alpha|Alpha]] - ${title}`;
const betaLine = (title: string): string => `- [ ] [[beta|Beta]] - ${title}`;

describe("G00c fix wave 2, finding 1: a deleted daily that comes back is adopted like a daily never seen", () => {
  const variants: [string, string, (date: string) => string][] = [
    ["today from the template", TODAY, (date) => TEMPLATE.replace("{{date}}", date)],
    ["today with a dash placeholder", TODAY, (date) => dailyOf(date, ["-"])],
    ["tomorrow from the template", TOMORROW, (date) => TEMPLATE.replace("{{date}}", date)],
  ];
  for (const [name, date, recreate] of variants) {
    it(`keeps every date and inserts the lines again: ${name}`, () => {
      const root = lab({ alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${date}`, `- [ ] Task two ${SCHEDULED} ${date}`]) }, { [date]: dailyOf(date, [alphaLine("Task one"), alphaLine("Task two")]) });
      const settings = useVault(root);
      settle(settings, date);
      const projectBefore = read(root, "projects/alpha.md");
      unlinkSync(join(root, dailyRel(date)));
      today.queueDailyDiskChange(date);
      settle(settings, date);
      assert.equal(read(root, "projects/alpha.md"), projectBefore);
      write(root, dailyRel(date), recreate(date));
      today.queueDailyDiskChange(date);
      settle(settings, date);
      assert.equal(read(root, "projects/alpha.md"), projectBefore, name);
      assert.ok(read(root, dailyRel(date)).includes(`${alphaLine("Task one")}\n${alphaLine("Task two")}\n`), name);
      assert.deepEqual(focusTitles(settings, date), ["Task one", "Task two"]);
      assertSettled(settings, root, [date], ["projects/alpha.md", dailyRel(date)]);
    });
  }

  it("a recreated daily with a typed line gives that line the date, like a daily created outside the hub", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`, "- [ ] Task free"]) }, { [TODAY]: dailyOf(TODAY, [alphaLine("Task one")]) });
    const settings = useVault(root);
    settle(settings, TODAY);
    unlinkSync(join(root, dailyRel(TODAY)));
    today.queueDailyDiskChange(TODAY);
    settle(settings, TODAY);
    write(root, dailyRel(TODAY), dailyOf(TODAY, [alphaLine("Task free")]));
    today.queueDailyDiskChange(TODAY);
    settle(settings, TODAY);
    assert.equal(taskIn(settings, "alpha", "Task one").scheduled, TODAY);
    assert.equal(taskIn(settings, "alpha", "Task free").scheduled, TODAY);
    assert.deepEqual(focusTitles(settings, TODAY).sort(), ["Task free", "Task one"]);
  });
});

describe("G00c fix wave 2, finding 2: a done subtask is history on every path", () => {
  const DONE_TODAY = `${DONE} ${TODAY}`;

  it("the date of the parent removed in the project keeps the date and the line of its done subtask", () => {
    const root = lab(
      { alpha: project("Alpha", [`- [ ] Parent ${SCHEDULED} ${TODAY}`, `  - [x] Sub done ${SCHEDULED} ${TODAY} ${DONE_TODAY}`, `  - [ ] Sub open ${SCHEDULED} ${TODAY}`]) },
      { [TODAY]: dailyOf(TODAY, [alphaLine("Parent"), "  - [x] Sub done", "  - [ ] Sub open"]) },
    );
    const settings = useVault(root);
    settle(settings, TODAY);
    editProject(root, "alpha", (content) => content.replace(`- [ ] Parent ${SCHEDULED} ${TODAY}`, "- [ ] Parent"));
    settle(settings, TODAY);
    assert.deepEqual(projectLines(root, "alpha"), ["- [ ] Parent", `  - [x] Sub done ${SCHEDULED} ${TODAY} ${DONE_TODAY}`, "  - [ ] Sub open"]);
    assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, ["- [x] Sub done"]));
    assertSettled(settings, root, [TODAY], ["projects/alpha.md", dailyRel(TODAY)]);
  });

  it("moving the parent to another day from the hub leaves its done subtask on the day it was done", () => {
    const root = lab(
      { alpha: project("Alpha", [`- [ ] Parent ${SCHEDULED} ${TODAY}`, `  - [x] Sub done ${SCHEDULED} ${TODAY} ${DONE_TODAY}`, `  - [ ] Sub open ${SCHEDULED} ${TODAY}`]) },
      { [TODAY]: dailyOf(TODAY, [alphaLine("Parent"), "  - [x] Sub done", "  - [ ] Sub open"]), [TOMORROW]: dailyOf(TOMORROW, ["- [ ]"]) },
    );
    const settings = useVault(root);
    settle(settings, TODAY, TOMORROW);
    const parent = taskIn(settings, "alpha", "Parent");
    today.todayApi.schedule(settings, { projectId: "alpha", line: parent.line, raw: parent.raw, date: TOMORROW, from: TODAY });
    settle(settings, TODAY, TOMORROW);
    assert.equal(taskIn(settings, "alpha", "Parent").scheduled, TOMORROW);
    assert.equal(taskIn(settings, "alpha", "Sub open").scheduled, TOMORROW);
    assert.equal(taskIn(settings, "alpha", "Sub done").scheduled, TODAY);
  });

  it("Clear today keeps the date of a done subtask", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Parent ${SCHEDULED} ${TODAY}`, `  - [x] Sub done ${SCHEDULED} ${TODAY} ${DONE_TODAY}`]) }, { [TODAY]: dailyOf(TODAY, [alphaLine("Parent"), "  - [x] Sub done"]) });
    const settings = useVault(root);
    settle(settings, TODAY);
    today.todayApi.clearToday(settings, TODAY);
    assert.deepEqual(projectLines(root, "alpha"), ["- [ ] Parent", `  - [x] Sub done ${SCHEDULED} ${TODAY} ${DONE_TODAY}`]);
  });
});

describe("G00c fix wave 2, finding 3: notes freed by an automatic removal become top level lines", () => {
  it("never lands under the block before, keeps the nesting among the freed notes and is idempotent", () => {
    const root = lab(
      { alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`, `- [ ] Task two ${SCHEDULED} ${TODAY}`, `  - [ ] Sub two ${SCHEDULED} ${TODAY}`]) },
      { [TODAY]: dailyOf(TODAY, [alphaLine("Task one"), alphaLine("Task two"), "  - [ ] Sub two", "    - note under sub", "  - free note two", "    - deeper free note"]) },
    );
    const settings = useVault(root);
    settle(settings, TODAY);
    editProject(root, "alpha", (content) => content.replace(`- [ ] Task two ${SCHEDULED} ${TODAY}`, "- [ ] Task two"));
    settle(settings, TODAY);
    assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, [alphaLine("Task one"), "- note under sub", "- free note two", "  - deeper free note"]));
    assertSettled(settings, root, [TODAY], ["projects/alpha.md", dailyRel(TODAY)]);
    const one = taskIn(settings, "alpha", "Task one");
    today.todayApi.schedule(settings, { projectId: "alpha", line: one.line, raw: one.raw, date: null, from: TODAY });
    assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, ["- note under sub", "- free note two", "  - deeper free note"]));
  });

  it("dropping and adding the date again keeps the freed notes as they are", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyOf(TODAY, [alphaLine("Task one"), "  - note A", "    - deeper note"]) });
    const settings = useVault(root);
    settle(settings, TODAY);
    for (let round = 0; round < 3; round += 1) {
      editProject(root, "alpha", (content) => content.replace(`- [ ] Task one ${SCHEDULED} ${TODAY}`, "- [ ] Task one"));
      settle(settings, TODAY);
      assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, ["- note A", "  - deeper note"]), `round ${round}`);
      editProject(root, "alpha", (content) => content.replace("- [ ] Task one", `- [ ] Task one ${SCHEDULED} ${TODAY}`));
      settle(settings, TODAY);
      assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, ["- note A", "  - deeper note", "", alphaLine("Task one")]), `round ${round}`);
    }
  });
});

describe("G00c fix wave 2, finding 4: a reworded line holds only the task whose line it replaced", () => {
  const base = (): string =>
    lab(
      { alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`, `- [ ] Task two ${SCHEDULED} ${TODAY} #p1`, "- [ ] Task three"]), beta: project("Beta", [`- [ ] Beta one ${SCHEDULED} ${TODAY}`, `- [ ] Beta two ${DUE} 2026-12-01`]) },
      { [TODAY]: dailyOf(TODAY, [alphaLine("Task one"), alphaLine("Task two"), "", betaLine("Beta one")]) },
    );
  const rewrites: [string, string[]][] = [
    ["with group headings", ["### Beta", betaLine("Beta one"), betaLine("Beta two"), "  - ask Ana", "", "### Alpha", alphaLine("Task two (morning: review PR)"), alphaLine("Task three")]],
    ["without headings", [betaLine("Beta one"), betaLine("Beta two"), "", alphaLine("Task two (morning: review PR)"), alphaLine("Task three")]],
  ];
  for (const [name, lines] of rewrites) {
    it(`the good-morning rewrite ${name}: the deleted line loses its date, the reworded one keeps its own`, () => {
      const root = base();
      const settings = useVault(root);
      settle(settings, TODAY);
      const rewritten = editDaily(root, TODAY, () => dailyOf(TODAY, lines));
      settle(settings, TODAY);
      assert.deepEqual(projectLines(root, "alpha"), ["- [ ] Task one", `- [ ] Task two ${SCHEDULED} ${TODAY} #p1`, `- [ ] Task three ${SCHEDULED} ${TODAY}`]);
      assert.deepEqual(projectLines(root, "beta"), [`- [ ] Beta one ${SCHEDULED} ${TODAY}`, `- [ ] Beta two ${SCHEDULED} ${TODAY} ${DUE} 2026-12-01`]);
      assert.equal(read(root, dailyRel(TODAY)), rewritten);
      assertSettled(settings, root, [TODAY], ["projects/alpha.md", "projects/beta.md", dailyRel(TODAY)]);
    });
  }

  it("a reworded line in place of its own line keeps its task, and an unlabeled line naming a removed task keeps that one", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`, `- [ ] Task two ${SCHEDULED} ${TODAY}`, `- [ ] Task four ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyOf(TODAY, [alphaLine("Task one"), alphaLine("Task two"), alphaLine("Task four")]) });
    const settings = useVault(root);
    settle(settings, TODAY);
    editDaily(root, TODAY, () => dailyOf(TODAY, [alphaLine("Task two (morning: review PR)"), "- [ ] Alpha: finish Task four today"]));
    settle(settings, TODAY);
    assert.deepEqual(projectLines(root, "alpha"), ["- [ ] Task one", `- [ ] Task two ${SCHEDULED} ${TODAY}`, `- [ ] Task four ${SCHEDULED} ${TODAY}`]);
  });
});

describe("G00c fix wave 2, finding 5: outside additions wait for a stable read, and a removed line gives back the date it took", () => {
  it("a partial write stuck past the window moves nothing before the window, and the restored file gives every date back", async () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Deploy ${SCHEDULED} ${YESTERDAY}`, `- [ ] Deploy the API ${SCHEDULED} ${TODAY}`, `- [ ] Write notes ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyOf(TODAY, [alphaLine("Deploy the API"), alphaLine("Write notes")]) });
    const settings = useVault(root);
    settle(settings, TODAY);
    const projectBefore = read(root, "projects/alpha.md");
    const full = read(root, dailyRel(TODAY));
    today.setFocusStability({ delayMs: 60 });
    try {
      editDaily(root, TODAY, () => full.slice(0, full.indexOf("Deploy the API") + "Deploy".length));
      today.flushMirrors(settings);
      assert.equal(read(root, "projects/alpha.md"), projectBefore);
      await sleep(250);
      assert.equal(taskIn(settings, "alpha", "Deploy").scheduled, TODAY);
      editDaily(root, TODAY, () => full);
      today.flushMirrors(settings);
      await sleep(250);
      today.flushMirrors(settings);
      assert.equal(read(root, "projects/alpha.md"), projectBefore);
      assert.equal(read(root, dailyRel(TODAY)), full);
    } finally {
      today.setFocusStability({ delayMs: 0 });
    }
  });

  it("a line typed for a task of tomorrow and removed again gives the date back to tomorrow", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task three ${SCHEDULED} ${TOMORROW}`]) }, { [TODAY]: dailyOf(TODAY, ["- [ ]"]), [TOMORROW]: dailyOf(TOMORROW, [alphaLine("Task three")]) });
    const settings = useVault(root);
    settle(settings, TODAY, TOMORROW);
    const tomorrow = read(root, dailyRel(TOMORROW));
    editDaily(root, TODAY, (content) => content.replace(EMPTY_FOCUS, `## Focus\n\n${alphaLine("Task three")}\n`));
    settle(settings, TODAY, TOMORROW);
    assert.equal(taskIn(settings, "alpha", "Task three").scheduled, TODAY);
    editDaily(root, TODAY, (content) => content.replace(`${alphaLine("Task three")}\n`, "- [ ]\n"));
    settle(settings, TODAY, TOMORROW);
    assert.equal(taskIn(settings, "alpha", "Task three").scheduled, TOMORROW);
    assert.equal(read(root, dailyRel(TOMORROW)), tomorrow);
    assert.deepEqual(focusTitles(settings, TOMORROW), ["Task three"]);
    assertSettled(settings, root, [TODAY, TOMORROW], ["projects/alpha.md", dailyRel(TODAY), dailyRel(TOMORROW)]);
  });

  it("a line typed for an undated task and removed again leaves it undated", () => {
    const root = lab({ alpha: project("Alpha", ["- [ ] Task five"]) }, { [TODAY]: dailyOf(TODAY, ["- [ ]"]) });
    const settings = useVault(root);
    settle(settings, TODAY);
    const projectBefore = read(root, "projects/alpha.md");
    editDaily(root, TODAY, (content) => content.replace(EMPTY_FOCUS, `## Focus\n\n${alphaLine("Task five")}\n`));
    settle(settings, TODAY);
    assert.equal(taskIn(settings, "alpha", "Task five").scheduled, TODAY);
    editDaily(root, TODAY, (content) => content.replace(`${alphaLine("Task five")}\n`, "- [ ]\n"));
    settle(settings, TODAY);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
  });
});

describe("G00c fix wave 2, finding 6: Clear today leaves done tasks alone", () => {
  it("keeps the date and the line of a done task, and Undo restores every byte", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Open one ${SCHEDULED} ${TODAY}`, `- [x] Done one ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`]) }, { [TODAY]: dailyOf(TODAY, [alphaLine("Open one"), alphaLine("Done one", "x")]) });
    const settings = useVault(root);
    settle(settings, TODAY);
    const before = snapshot(root, ["projects/alpha.md", dailyRel(TODAY)]);
    const cleared = today.todayApi.clearToday(settings, TODAY);
    assert.equal(cleared.lines, 1);
    assert.equal(cleared.unscheduled, 1);
    assert.equal(taskIn(settings, "alpha", "Done one").scheduled, TODAY);
    assert.equal(taskIn(settings, "alpha", "Open one").scheduled, null);
    assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, [alphaLine("Done one", "x")]));
    assert.deepEqual(today.todayApi.undoClear(settings, TODAY, cleared.token), { restored: true });
    assert.deepEqual(snapshot(root, ["projects/alpha.md", dailyRel(TODAY)]), before);
  });
});

describe("G00c fix wave 2, finding 7: the sync does not queue another run of the day it is writing", () => {
  it("an unschedule written by the mirror leaves no run of that day pending", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`, `- [ ] Task two ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyOf(TODAY, [alphaLine("Task one"), alphaLine("Task two")]) });
    const settings = useVault(root);
    settle(settings, TODAY);
    editDaily(root, TODAY, (content) => content.replace(`${alphaLine("Task one")}\n`, ""));
    today.flushMirrors(settings);
    assert.equal(taskIn(settings, "alpha", "Task one").scheduled, null);
    writeFileSync(join(root, dailyRel(TODAY)), read(root, dailyRel(TODAY)).replace(`${alphaLine("Task two")}\n`, ""));
    assert.equal(today.flushMirrors(settings), false);
    assert.equal(taskIn(settings, "alpha", "Task two").scheduled, TODAY);
  });
});

describe("G00c fix wave 2, finding 9: the scheduled token writer replaces a malformed scheduled token", () => {
  const D = "2026-11-20";

  it("sets and clears a token whose date is not a calendar date, takes a bare hourglass in the text as the token and leaves one in a link alone", () => {
    const settings = useVault(lab({ alpha: project("Alpha", ["- [ ] x"]) }));
    const cases: [string, string, string][] = [
      [`- [ ] A ${SCHEDULED} 2026-02-30`, `- [ ] A ${SCHEDULED} ${D}`, "- [ ] A"],
      [`- [ ] A ${SCHEDULED} 2026-2-3 #p1`, `- [ ] A ${SCHEDULED} ${D} #p1`, "- [ ] A #p1"],
      [`- [ ] A ${SCHEDULED} 2026-02-30 ${DUE} 2026-12-01`, `- [ ] A ${SCHEDULED} ${D} ${DUE} 2026-12-01`, `- [ ] A ${DUE} 2026-12-01`],
      [`- [ ] A text ${SCHEDULED} in middle`, `- [ ] A text ${SCHEDULED} ${D} middle`, "- [ ] A text middle"],
      [`- [ ] A [doc](http://x/${SCHEDULED} 2026-11-10)`, `- [ ] A [doc](http://x/${SCHEDULED} 2026-11-10) ${SCHEDULED} ${D}`, `- [ ] A [doc](http://x/${SCHEDULED} 2026-11-10)`],
    ];
    for (const [raw, set, cleared] of cases) {
      assert.equal(board.withScheduledToken(raw, settings.tasks, D), set, raw);
      assert.equal(board.withScheduledToken(raw, settings.tasks, null), cleared, raw);
    }
  });
});

describe("G00c fix wave 3, finding 1: a change seen in a project waits for a stable second read of that project", () => {
  const custom = (): { root: string; settings: DelegationSettings } => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`, `- [ ] Task two ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyOf(TODAY, [alphaLine("Task one"), alphaLine("Task two")]) });
    const settings = useVault(root);
    settle(settings, TODAY);
    editDaily(root, TODAY, (content) => content.replace(alphaLine("Task one"), `${alphaLine("Task one (draft for Ana, due 3pm)")}\n  - invoice 4471`));
    settle(settings, TODAY);
    return { root, settings };
  };

  for (const transient of ["- [ ] Task one ", "- [ ] Task one", `- [ ] Task one ${SCHEDULED}`, `- [ ] Task one ${SCHEDULED} 2026-11-1`]) {
    it(`an autosave without the date undone inside the window leaves both files byte for byte: ${JSON.stringify(transient)}`, async () => {
      const { root, settings } = custom();
      const dailyBefore = read(root, dailyRel(TODAY));
      const projectBefore = read(root, "projects/alpha.md");
      today.setFocusStability({ delayMs: 60 });
      try {
        editProject(root, "alpha", (content) => content.replace(`- [ ] Task one ${SCHEDULED} ${TODAY}`, transient));
        today.todayApi.regenerateFocusMirror(settings, TODAY, { source: "board" });
        assert.equal(read(root, dailyRel(TODAY)), dailyBefore);
        editProject(root, "alpha", () => projectBefore);
        today.todayApi.regenerateFocusMirror(settings, TODAY, { source: "board" });
        await sleep(250);
        today.flushMirrors(settings);
        assert.equal(read(root, dailyRel(TODAY)), dailyBefore);
        assert.equal(read(root, "projects/alpha.md"), projectBefore);
      } finally {
        today.setFocusStability({ delayMs: 0 });
      }
    });
  }

  it("a date removed in the project that still reads the same after the window removes the line, keeping the notes", async () => {
    const { root, settings } = custom();
    today.setFocusStability({ delayMs: 60 });
    try {
      editProject(root, "alpha", (content) => content.replace(`- [ ] Task one ${SCHEDULED} ${TODAY}`, "- [ ] Task one"));
      assert.deepEqual(today.todayApi.regenerateFocusMirror(settings, TODAY, { source: "board" }), { changed: false, skipped: "unsettled", applied: 0 });
      await sleep(250);
      assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, ["- invoice 4471", alphaLine("Task two")]));
    } finally {
      today.setFocusStability({ delayMs: 0 });
    }
  });

  it("a date added in the project waits for the window before the line goes in", async () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`, "- [ ] Task two"]) }, { [TODAY]: dailyOf(TODAY, [alphaLine("Task one")]) });
    const settings = useVault(root);
    settle(settings, TODAY);
    const before = read(root, dailyRel(TODAY));
    today.setFocusStability({ delayMs: 60 });
    try {
      editProject(root, "alpha", (content) => content.replace("- [ ] Task two", `- [ ] Task two ${SCHEDULED} ${TODAY}`));
      today.todayApi.regenerateFocusMirror(settings, TODAY, { source: "board" });
      assert.equal(read(root, dailyRel(TODAY)), before);
      await sleep(250);
      assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, [alphaLine("Task one"), alphaLine("Task two")]));
    } finally {
      today.setFocusStability({ delayMs: 0 });
    }
  });

  it("a date removed by the hub in the board mirrors at once", () => {
    const { root, settings } = custom();
    today.setFocusStability({ delayMs: 60 });
    try {
      const one = taskIn(settings, "alpha", "Task one");
      board.writeBoardTaskSynced(settings, { projectId: "alpha", line: one.line, raw: one.raw, scheduled: null });
      today.todayApi.regenerateFocusMirror(settings, TODAY, { source: "board" });
      assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, ["- invoice 4471", alphaLine("Task two")]));
    } finally {
      today.setFocusStability({ delayMs: 0 });
    }
  });
});

describe("G00c fix wave 3, finding 2: a daily seen for the first time is checked and read twice like any other", () => {
  const ALPHA = (): string => project("Alpha", [`- [ ] Dated one ${SCHEDULED} ${TODAY}`, `- [ ] Dated two ${SCHEDULED} ${TODAY}`, "- [ ] Free task"]);
  const FULL = dailyOf(TODAY, [alphaLine("Free task"), alphaLine("Dated two"), "  - my plan for two"]);

  for (const [name, partial] of [
    ["frontmatter only", "---\ntype: daily\n---\n"],
    ["no focus heading yet", `---\ntype: daily\n---\n\n# ${TODAY}\n`],
    ["truncated after the focus heading", FULL.slice(0, FULL.indexOf("## Focus") + "## Focus\n\n".length)],
  ] as [string, string][]) {
    it(`a partial first write is never written into and no date is lost: ${name}`, async () => {
      const root = lab({ alpha: ALPHA() });
      const settings = useVault(root);
      const projectBefore = read(root, "projects/alpha.md");
      today.setFocusStability({ delayMs: 60 });
      try {
        write(root, dailyRel(TODAY), partial);
        today.queueDailyDiskChange(TODAY);
        today.flushMirrors(settings);
        assert.equal(read(root, dailyRel(TODAY)), partial);
        assert.equal(read(root, "projects/alpha.md"), projectBefore);
        write(root, dailyRel(TODAY), FULL);
        today.queueDailyDiskChange(TODAY);
        today.flushMirrors(settings);
        await sleep(250);
        today.flushMirrors(settings);
        assert.equal(taskIn(settings, "alpha", "Dated one").scheduled, TODAY);
        assert.equal(taskIn(settings, "alpha", "Dated two").scheduled, TODAY);
        assert.equal(taskIn(settings, "alpha", "Free task").scheduled, TODAY);
        assert.equal(read(root, dailyRel(TODAY)), dailyOf(TODAY, [alphaLine("Free task"), alphaLine("Dated two"), "  - my plan for two", alphaLine("Dated one")]));
      } finally {
        today.setFocusStability({ delayMs: 0 });
      }
    });
  }

  it("a complete first-seen daily without the focus heading is left alone, file and dates", () => {
    const root = lab({ alpha: ALPHA() });
    const settings = useVault(root);
    const projectBefore = read(root, "projects/alpha.md");
    const content = ["---", "type: daily", "---", "", `# ${TODAY}`, "", "## Notes", "", "- wrote this by hand", alphaLine("Free task"), ""].join("\n");
    write(root, dailyRel(TODAY), content);
    today.queueDailyDiskChange(TODAY);
    settle(settings, TODAY);
    assert.equal(read(root, dailyRel(TODAY)), content);
    assert.equal(read(root, "projects/alpha.md"), projectBefore);
  });

  it("a known daily without the focus heading never gets one, neither from a project date nor from the hub", () => {
    const content = ["---", "type: daily", "---", "", `# ${TODAY}`, "", "## Notes", "", "- free text", ""].join("\n");
    const root = lab({ alpha: project("Alpha", [`- [ ] Dated one ${SCHEDULED} ${TODAY}`, "- [ ] Free task", "- [ ] Other"]) }, { [TODAY]: content });
    const settings = useVault(root);
    settle(settings, TODAY);
    editProject(root, "alpha", (text) => text.replace("- [ ] Free task", `- [ ] Free task ${SCHEDULED} ${TODAY}`));
    settle(settings, TODAY);
    assert.equal(read(root, dailyRel(TODAY)), content);
    const other = taskIn(settings, "alpha", "Other");
    today.todayApi.schedule(settings, { projectId: "alpha", line: other.line, raw: other.raw, date: TODAY });
    settle(settings, TODAY);
    assert.equal(read(root, dailyRel(TODAY)), content);
    assert.equal(taskIn(settings, "alpha", "Other").scheduled, TODAY);
  });
});

describe("G00c fix wave 3, finding 3: a task cut from one project and pasted in another keeps its daily line", () => {
  const base = (): string =>
    lab(
      { alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`, `- [ ] Task two ${SCHEDULED} ${TODAY}`, "- [ ] Task three"]), beta: project("Beta", [`- [ ] Beta one ${SCHEDULED} ${TODAY}`]) },
      { [TODAY]: dailyOf(TODAY, [alphaLine("Task one"), "  - note on one", alphaLine("Task two"), "", betaLine("Beta one")]) },
    );

  it("cut then paste in two saves: no second line, the old line follows the task, and deleting it unschedules the moved task", () => {
    const root = base();
    const settings = useVault(root);
    settle(settings, TODAY);
    const before = read(root, dailyRel(TODAY));
    editProject(root, "alpha", (content) => content.replace(`- [ ] Task two ${SCHEDULED} ${TODAY}\n`, ""));
    today.queueDailyDiskChange(TODAY);
    settle(settings, TODAY);
    assert.equal(read(root, dailyRel(TODAY)), before);
    editProject(root, "beta", (content) => content.replace(`- [ ] Beta one ${SCHEDULED} ${TODAY}`, `- [ ] Beta one ${SCHEDULED} ${TODAY}\n- [ ] Task two ${SCHEDULED} ${TODAY}`));
    today.queueDailyDiskChange(TODAY);
    settle(settings, TODAY);
    assert.equal(read(root, dailyRel(TODAY)), before);
    assert.equal(taskIn(settings, "beta", "Task two").scheduled, TODAY);
    assert.ok(focusTitles(settings, TODAY).includes("Task two"));
    assertSettled(settings, root, [TODAY], ["projects/alpha.md", "projects/beta.md", dailyRel(TODAY)]);
    editDaily(root, TODAY, (content) => content.replace(`${alphaLine("Task two")}\n`, ""));
    settle(settings, TODAY);
    assert.equal(taskIn(settings, "beta", "Task two").scheduled, null);
  });
});

describe("G00c fix wave 3, finding 4: a task renamed in the project while its line is deleted loses its date", () => {
  it("resolves the renamed task by its place in the project", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`, `- [ ] Task two ${SCHEDULED} ${TODAY}`]) }, { [TODAY]: dailyOf(TODAY, [alphaLine("Task one"), "  - note on one", alphaLine("Task two")]) });
    const settings = useVault(root);
    settle(settings, TODAY);
    editProject(root, "alpha", (content) => content.replace(`- [ ] Task one ${SCHEDULED} ${TODAY}`, `- [ ] Meeting with Ana about budget ${SCHEDULED} ${TODAY}`));
    const edited = editDaily(root, TODAY, (content) => content.replace(`${alphaLine("Task one")}\n  - note on one\n`, ""));
    settle(settings, TODAY);
    assert.equal(taskIn(settings, "alpha", "Meeting with Ana about budget").scheduled, null);
    assert.equal(taskIn(settings, "alpha", "Task two").scheduled, TODAY);
    assert.equal(read(root, dailyRel(TODAY)), edited);
  });
});

describe("G00c fix wave 3, finding 5: the first sight of a daily never moves a date between days", () => {
  for (const order of [[TODAY, TOMORROW], [TOMORROW, TODAY]]) {
    it(`two dailies seen for the first time that list the same task keep its date: ${order.join(" then ")}`, () => {
      const root = lab(
        { alpha: project("Alpha", [`- [ ] Both ${SCHEDULED} ${TODAY}`, `- [ ] Later ${SCHEDULED} ${TOMORROW}`]) },
        { [TODAY]: dailyOf(TODAY, [alphaLine("Both"), alphaLine("Later")]), [TOMORROW]: dailyOf(TOMORROW, [alphaLine("Both"), "  - tomorrow note", alphaLine("Later")]) },
      );
      const settings = useVault(root);
      const before = snapshot(root, ["projects/alpha.md", dailyRel(TODAY), dailyRel(TOMORROW)]);
      settle(settings, ...order);
      assert.deepEqual(snapshot(root, ["projects/alpha.md", dailyRel(TODAY), dailyRel(TOMORROW)]), before);
      assert.deepEqual(focusTitles(settings, TODAY), ["Both", "Later"]);
      assert.deepEqual(focusTitles(settings, TOMORROW), ["Both", "Later"]);
      editDaily(root, TOMORROW, (content) => content.replace(`${alphaLine("Both")}\n  - tomorrow note\n`, ""));
      settle(settings, TODAY, TOMORROW);
      assert.equal(taskIn(settings, "alpha", "Both").scheduled, TODAY);
    });
  }
});

describe("G00c fix wave 3, finding 6: the line of a dated subtask mirrors its own date", () => {
  it("deleting the subtask line under its listed parent removes only the subtask date, a done subtask keeps it", () => {
    const root = lab(
      { alpha: project("Alpha", [`- [ ] Parent ${SCHEDULED} ${TODAY}`, `  - [ ] Sub A ${SCHEDULED} ${TODAY}`, "  - [ ] Sub B", `  - [x] Sub C ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`]) },
      { [TODAY]: dailyOf(TODAY, [alphaLine("Parent"), "  - [ ] Sub A", "  - [ ] Sub B", "  - [x] Sub C"]) },
    );
    const settings = useVault(root);
    settle(settings, TODAY);
    const edited = editDaily(root, TODAY, (content) => content.replace("  - [ ] Sub A\n", "").replace("  - [x] Sub C\n", ""));
    settle(settings, TODAY);
    assert.deepEqual(projectLines(root, "alpha"), [`- [ ] Parent ${SCHEDULED} ${TODAY}`, "  - [ ] Sub A", "  - [ ] Sub B", `  - [x] Sub C ${SCHEDULED} ${TODAY} ${DONE} ${TODAY}`]);
    assert.equal(read(root, dailyRel(TODAY)), edited);
    assertSettled(settings, root, [TODAY], ["projects/alpha.md", dailyRel(TODAY)]);
  });
});

describe("G00c fix wave 3, finding 7: the scheduled token writer and block ids, bare hourglasses", () => {
  const D = "2026-11-20";
  it("inserts before a trailing block id and treats any hourglass as the scheduled token", () => {
    const settings = useVault(lab({ alpha: project("Alpha", ["- [ ] x"]) }));
    const cases: [string, string, string][] = [
      ["- [ ] Task ^abc123", `- [ ] Task ${SCHEDULED} ${D} ^abc123`, "- [ ] Task ^abc123"],
      ["- [ ] Task #p1 ^blk-1", `- [ ] Task #p1 ${SCHEDULED} ${D} ^blk-1`, "- [ ] Task #p1 ^blk-1"],
      [`- [ ] Task ${DUE} 2026-12-01 ^abc`, `- [ ] Task ${SCHEDULED} ${D} ${DUE} 2026-12-01 ^abc`, `- [ ] Task ${DUE} 2026-12-01 ^abc`],
      [`- [ ] Task ${SCHEDULED} 2026-11-10 ^abc`, `- [ ] Task ${SCHEDULED} ${D} ^abc`, "- [ ] Task ^abc"],
      [`- [ ] Task ${SCHEDULED}`, `- [ ] Task ${SCHEDULED} ${D}`, "- [ ] Task"],
      [`- [ ] Task ${SCHEDULED} tomorrow`, `- [ ] Task ${SCHEDULED} ${D}`, "- [ ] Task"],
      [`- [ ] Task ${SCHEDULED} ${DUE} 2026-12-01`, `- [ ] Task ${SCHEDULED} ${D} ${DUE} 2026-12-01`, `- [ ] Task ${DUE} 2026-12-01`],
      [`- [ ] Task ${SCHEDULED} ${SCHEDULED} 2026-11-10`, `- [ ] Task ${SCHEDULED} ${D}`, "- [ ] Task"],
    ];
    for (const [raw, set, cleared] of cases) {
      assert.equal(board.withScheduledToken(raw, settings.tasks, D), set, raw);
      assert.equal(board.withScheduledToken(raw, settings.tasks, null), cleared, raw);
      assert.equal(board.withScheduledToken(set, settings.tasks, D), set, set);
    }
  });
});

describe("G00c fix wave 3, finding 8: Undo names the daily by its file", () => {
  it("refuses with the path of the daily that changed and writes nothing", () => {
    const root = lab({ alpha: project("Alpha", [`- [ ] Task one ${SCHEDULED} ${TODAY}`, "- [ ] other"]) }, { [TODAY]: dailyOf(TODAY, [alphaLine("Task one")]) });
    const settings = useVault(root);
    settle(settings, TODAY);
    const cleared = today.todayApi.clearToday(settings, TODAY);
    editDaily(root, TODAY, (content) => content.replace("- 10:00 Standup", "- 10:00 Standup moved"));
    settle(settings, TODAY);
    const after = snapshot(root, ["projects/alpha.md", dailyRel(TODAY)]);
    assert.throws(() => today.todayApi.undoClear(settings, TODAY, cleared.token), new RegExp(`^Error: daily/${TODAY}\\.md changed after Clear today, nothing was restored$`));
    assert.deepEqual(snapshot(root, ["projects/alpha.md", dailyRel(TODAY)]), after);
  });
});
