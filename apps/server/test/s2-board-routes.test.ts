import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { s2InitRepo, s2Sandbox, s2StartHub, s2Until, type S2Hub } from "./helpers/s2-env.js";

const box = s2Sandbox("cch-s2-board-", { HUB_DELEGATION: "1" });

const { db } = await import("../src/db.js");
const today = await import("../src/today.js");
const board = await import("../src/tasks-board.js");
const daily = await import("../src/daily.js");
const { abortActiveRuns } = await import("../src/delegation-launch.js");
const { getSettings } = await import("../src/delegation-store.js");

let hub: S2Hub;

const TODAY = ((): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
})();

const shift = (date: string, days: number): string => {
  const at = new Date(`${date}T12:00:00`);
  at.setDate(at.getDate() + days);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
};
const YESTERDAY = shift(TODAY, -1);

const TEMPLATE = ["---", "type: daily", "created: {{date}}", "---", "", "# {{date}}", "", "## Focus", "", "- [ ]", "", "## Meetings", "", "-", "", "## Captures", "", "-", "", "## Sessions", "", "-", ""].join("\n");

const LAB = [
  "---",
  "workspace: pilot",
  "---",
  "",
  "# Lab",
  "",
  "## Open loops",
  "",
  "- [ ] Alpha #p1",
  "  - [ ] Alpha child",
  "  - a plain note under alpha",
  "- [ ] Beta",
  "- [ ] Gamma",
  "- [x] Finished one",
  "- [ ] Repeating chore \u{1F501} every day ⏳ 2026-01-01",
  "",
  "## Done loops",
  "",
  "- [x] Old one ✅ 2026-11-01",
  "",
].join("\n");

const OTHER = ["# Other", "", "## Open loops", "", "- [ ] Elsewhere", "", "## Done loops", "", ""].join("\n");

const write = (rel: string, content: string): void => {
  const full = join(box.brain, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};

before(async () => {
  s2InitRepo(box.repoA);
  write("_templates/daily.md", TEMPLATE);
  write("projects/lab.md", LAB);
  write("projects/other.md", OTHER);
  write(`daily/${YESTERDAY}.md`, `---\ntype: daily\ncreated: ${YESTERDAY}\n---\n\n# ${YESTERDAY}\n\n## Focus\n\n- [ ] Carry on\n- [x] Done yesterday\n\n## Meetings\n\n-\n\n## Captures\n\n-\n\n## Sessions\n\n-\n`);
  hub = await s2StartHub(box);
  const res = await hub.http("PUT", "/delegation/settings", {
    workspacesRoot: box.root,
    autonomy: "full",
    secondBrainRoot: box.brain,
    features: { daily: true, tasks: true, trail: false, usage: false, limits: false },
    tasks: { root: "projects", doneSection: "Done loops" },
    daily: { dir: "daily", template: "_templates/daily.md", wikilinks: true, focusSource: "scheduled", headings: { focus: "Focus", meetings: "Meetings", sessions: "Sessions", captures: "Captures" } },
  });
  assert.equal(res.status, 200, res.text);
});

after(async () => {
  abortActiveRuns("test over");
  await new Promise((resolve) => setTimeout(resolve, 300));
  today.removeTodayHooks();
  daily.stopDailyWatch();
  today.forgetTodayState();
  board.stopTasksBoardWatch();
  await hub.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  today.forgetTodayState();
  if (db.open) db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

interface TaskView {
  projectId: string;
  line: number;
  raw: string;
  title: string;
  status: string;
  subtasks: TaskView[];
  noteItems: { line: number; raw: string; text: string }[];
}

interface BoardView {
  projects: { id: string; name: string }[];
  tasks: TaskView[];
  enabled: boolean;
  today: { taskIds: string[] } | null;
}

const flat = (tasks: TaskView[]): TaskView[] => tasks.flatMap((task) => [task, ...flat(task.subtasks)]);

async function readBoard(): Promise<BoardView> {
  const res = await hub.http("GET", "/delegation/tasks-board");
  assert.equal(res.status, 200, res.text);
  return res.json as BoardView;
}

async function find(title: string, projectId = "lab"): Promise<TaskView> {
  const found = flat((await readBoard()).tasks).find((task) => task.projectId === projectId && task.title === title);
  assert.ok(found, `${projectId}: ${title}`);
  return found;
}

const target = (task: TaskView) => ({ projectId: task.projectId, line: task.line, raw: task.raw });
const errorOf = (json: unknown): string => (json as { error: string }).error;

describe("board read and item edits", () => {
  it("lists the projects and tasks of the vault", async () => {
    const view = await readBoard();
    assert.equal(view.enabled, true);
    assert.ok(view.projects.some((project) => project.id === "lab"));
    assert.ok(flat(view.tasks).some((task) => task.title === "Alpha child"));
  });

  it("changes status, title, reason, priority and dates of an item", async () => {
    const beta = await find("Beta");
    const blocked = await hub.http("PATCH", "/delegation/tasks-board/item", { ...target(beta), status: "blocked", reason: "waiting on legal", title: "Beta renamed", priority: 2, due: "2026-12-24" });
    assert.equal(blocked.status, 200, blocked.text);
    const renamed = await find("Beta renamed");
    assert.equal(renamed.status, "blocked");
    const back = await hub.http("PATCH", "/delegation/tasks-board/item", { ...target(renamed), status: "todo", reason: null, priority: null, due: null, start: null, scheduled: null, repeat: null });
    assert.equal(back.status, 200, back.text);
  });

  it("rejects malformed edits and stale lines", async () => {
    const gamma = await find("Gamma");
    const cases: [Record<string, unknown>, number, RegExp][] = [
      [{ line: 1, raw: "x" }, 400, /projectId required/],
      [{ projectId: "lab", line: -1, raw: "x" }, 400, /line must be a non-negative integer/],
      [{ projectId: "lab", line: 1 }, 400, /raw required/],
      [{ ...target(gamma), status: "weird" }, 400, /status must be one of/],
      [{ ...target(gamma), title: 5 }, 400, /title must be a string/],
      [{ ...target(gamma), reason: 5 }, 400, /reason must be a string or null/],
      [{ ...target(gamma), raw: "- [ ] not what is on disk", status: "done" }, 409, /changed/],
    ];
    for (const [body, status, message] of cases) {
      const res = await hub.http("PATCH", "/delegation/tasks-board/item", body);
      assert.equal(res.status, status, res.text);
      assert.match(errorOf(res.json), message);
    }
  });

  it("creates tasks at the end, as subtasks and after a sibling, and validates the payload", async () => {
    const created = await hub.http("POST", "/delegation/tasks-board/item", { projectId: "lab", title: "Created plain", status: "todo", reason: null, priority: 1, scheduled: "2026-12-01" });
    assert.equal(created.status, 201, created.text);
    const alpha = await find("Alpha");
    const child = await hub.http("POST", "/delegation/tasks-board/item", { projectId: "lab", title: "Created child", parentLine: alpha.line, parentRaw: alpha.raw });
    assert.equal(child.status, 201, child.text);
    const gamma = await find("Gamma");
    const after = await hub.http("POST", "/delegation/tasks-board/item", { projectId: "lab", title: "After gamma", after: { line: gamma.line, raw: gamma.raw } });
    assert.equal(after.status, 201, after.text);
    const bad: [Record<string, unknown>, number, RegExp][] = [
      [{ title: "x" }, 400, /projectId required/],
      [{ projectId: "lab" }, 400, /title required/],
      [{ projectId: "lab", title: "x", status: "weird" }, 400, /status must be one of/],
      [{ projectId: "lab", title: "x", reason: 4 }, 400, /reason must be a string or null/],
      [{ projectId: "lab", title: "x", parentLine: -2, parentRaw: "r" }, 400, /parentLine must be a non-negative integer/],
      [{ projectId: "lab", title: "x", parentLine: 1 }, 400, /parentRaw required with parentLine/],
      [{ projectId: "lab", title: "x", after: 5 }, 400, /after must be an object/],
      [{ projectId: "lab", title: "x", after: { line: -1, raw: "r" } }, 400, /after.line must be a non-negative integer/],
      [{ projectId: "lab", title: "x", after: { line: 1 } }, 400, /after.raw required/],
      [{ projectId: "ghost", title: "x" }, 404, /project not found/],
    ];
    for (const [body, status, message] of bad) {
      const res = await hub.http("POST", "/delegation/tasks-board/item", body);
      assert.equal(res.status, status, res.text);
      assert.match(errorOf(res.json), message);
    }
  });
});

describe("board notes", () => {
  it("adds, edits and deletes a note under a task", async () => {
    const alpha = await find("Alpha");
    const added = await hub.http("POST", "/delegation/tasks-board/note", { ...target(alpha), text: "first note" });
    assert.equal(added.status, 201, added.text);
    const withNote = await find("Alpha");
    const note = withNote.noteItems.find((item) => item.text === "first note");
    assert.ok(note, "note was added");
    const edited = await hub.http("PATCH", "/delegation/tasks-board/note", { projectId: "lab", line: note.line, raw: note.raw, text: "edited note" });
    assert.equal(edited.status, 200, edited.text);
    const after = (await find("Alpha")).noteItems.find((item) => item.text === "edited note");
    assert.ok(after, "note was edited");
    const removed = await hub.http("DELETE", "/delegation/tasks-board/note", { projectId: "lab", line: after.line, raw: after.raw });
    assert.equal(removed.status, 200, removed.text);
    assert.ok(!(await find("Alpha")).noteItems.some((item) => item.text === "edited note"));
  });

  it("rejects notes without text", async () => {
    const alpha = await find("Alpha");
    const res = await hub.http("POST", "/delegation/tasks-board/note", { ...target(alpha), text: 3 });
    assert.equal(res.status, 400);
    assert.match(errorOf(res.json), /single non-empty line/);
    assert.equal((await hub.http("PATCH", "/delegation/tasks-board/note", { ...target(alpha), text: null })).status, 400);
    assert.equal((await hub.http("DELETE", "/delegation/tasks-board/note", {})).status, 400);
  });
});

describe("board organize routes", () => {
  it("moves an item up and down and reports the ends", async () => {
    const gamma = await find("Gamma");
    const up = await hub.http("POST", "/delegation/tasks-board/move", { ...target(gamma), direction: "up" });
    assert.equal(up.status, 200, up.text);
    const moved = await find("Gamma");
    const down = await hub.http("POST", "/delegation/tasks-board/move", { ...target(moved), direction: "down" });
    assert.equal(down.status, 200, down.text);
    const bad = await hub.http("POST", "/delegation/tasks-board/move", { ...target(moved), direction: "sideways" });
    assert.equal(bad.status, 400);
    const first = flat((await readBoard()).tasks).filter((task) => task.projectId === "lab")[0] as TaskView;
    const edge = await hub.http("POST", "/delegation/tasks-board/move", { ...target(first), direction: "up" });
    assert.equal(edge.status, 400);
    assert.match(errorOf(edge.json), /already first/);
  });

  it("reparents a task under another and back to the top level", async () => {
    const gamma = await find("Gamma");
    const alpha = await find("Alpha");
    const nested = await hub.http("POST", "/delegation/tasks-board/reparent", { ...target(gamma), parent: { line: alpha.line, raw: alpha.raw } });
    assert.equal(nested.status, 200, nested.text);
    const child = await find("Gamma");
    const noParent = await hub.http("POST", "/delegation/tasks-board/reparent", { ...target(child) });
    assert.equal(noParent.status, 400);
    assert.match(errorOf(noParent.json), /parent must be null or/);
    const badParent = await hub.http("POST", "/delegation/tasks-board/reparent", { ...target(child), parent: "alpha" });
    assert.equal(badParent.status, 400);
    const badShape = await hub.http("POST", "/delegation/tasks-board/reparent", { ...target(child), parent: { line: "x", raw: 1 } });
    assert.equal(badShape.status, 400);
    const out = await hub.http("POST", "/delegation/tasks-board/reparent", { ...target(child), parent: null });
    assert.equal(out.status, 200, out.text);
    const again = await hub.http("POST", "/delegation/tasks-board/reparent", { ...target(await find("Gamma")), parent: null });
    assert.equal(again.status, 400);
    assert.match(errorOf(again.json), /already top-level/);
  });

  it("moves a task to another project", async () => {
    const gamma = await find("Gamma");
    const moved = await hub.http("POST", "/delegation/tasks-board/move-to-project", { ...target(gamma), targetProjectId: "other" });
    assert.equal(moved.status, 200, moved.text);
    const inOther = await find("Gamma", "other");
    const elsewhere = await find("Elsewhere", "other");
    const nested = await hub.http("POST", "/delegation/tasks-board/move-to-project", { ...target(inOther), targetProjectId: "lab", parent: { line: (await find("Alpha")).line, raw: (await find("Alpha")).raw } });
    assert.equal(nested.status, 200, nested.text);
    assert.equal((await hub.http("POST", "/delegation/tasks-board/move-to-project", { ...target(elsewhere) })).status, 400);
    const same = await hub.http("POST", "/delegation/tasks-board/move-to-project", { ...target(elsewhere), targetProjectId: "other" });
    assert.equal(same.status, 400);
    const ghost = await hub.http("POST", "/delegation/tasks-board/move-to-project", { ...target(elsewhere), targetProjectId: "ghost" });
    assert.equal(ghost.status, 404);
    assert.match(errorOf(ghost.json), /target project not found/);
    const back = await hub.http("POST", "/delegation/tasks-board/move-to-project", { ...target(await find("Elsewhere", "other")), targetProjectId: "lab" });
    assert.equal(back.status, 200, back.text);
    const restore = await hub.http("POST", "/delegation/tasks-board/move-to-project", { ...target(await find("Elsewhere", "lab")), targetProjectId: "other" });
    assert.equal(restore.status, 200, restore.text);
  });

  it("sweeps finished tasks into the done section", async () => {
    const swept = await hub.http("POST", "/delegation/tasks-board/sweep-done", { projectId: "lab" });
    assert.equal(swept.status, 200, swept.text);
    assert.ok((swept.json as { moved: number }).moved >= 1);
    const all = await hub.http("POST", "/delegation/tasks-board/sweep-done", {});
    assert.equal(all.status, 200, all.text);
    assert.equal((await hub.http("POST", "/delegation/tasks-board/sweep-done", { projectId: "ghost" })).status, 404);
    assert.match(readFileSync(join(box.brain, "projects/lab.md"), "utf8"), /Finished one/);
  });
});

describe("board open and delegate", () => {
  it("opens the project folder of a task through the editor command", async () => {
    await hub.http("PUT", "/delegation/settings", { editorCommand: process.execPath });
    const ok = await hub.http("POST", "/delegation/tasks-board/open", { projectId: "lab" });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await hub.http("POST", "/delegation/tasks-board/open", { projectId: "ghost" })).status, 404);
    assert.equal((await hub.http("POST", "/delegation/tasks-board/open", {})).status, 404);
  });

  it("delegates a task to a run and rejects bad runners", async () => {
    const alpha = await find("Alpha");
    const bad = await hub.http("POST", "/delegation/tasks-board/delegate", { ...target(alpha), runner: "gpt", workspace: "pilot" });
    assert.equal(bad.status, 400);
    const res = await hub.http("POST", "/delegation/tasks-board/delegate", { ...target(alpha), workspace: "pilot", prompt: "Do {{task}}", runner: "claude" });
    assert.equal(res.status, 201, res.text);
    await s2Until(async () => {
      const list = (await hub.http("GET", "/delegation/tasks?limit=5")).json as { status: string }[];
      return list.length > 0 && list.every((item) => item.status !== "running" && item.status !== "pending") ? true : null;
    }, 20_000);
  });
});

describe("daily links and sync", () => {
  it("adds a task to the daily note, reads the links, syncs both ways", async () => {
    await hub.http("POST", `/delegation/today/${TODAY}/create`);
    const beta = await find("Beta renamed");
    const added = await hub.http("POST", "/delegation/tasks-board/add-to-daily", { ...target(beta), date: TODAY });
    assert.equal(added.status, 201, added.text);
    const dup = await hub.http("POST", "/delegation/tasks-board/add-to-daily", { ...target(await find("Beta renamed")), date: TODAY });
    assert.equal(dup.status, 409, dup.text);
    const links = await hub.http("GET", `/delegation/tasks-board/daily-links?date=${TODAY}`);
    assert.equal(links.status, 200, links.text);
    const defaultDate = await hub.http("GET", "/delegation/tasks-board/daily-links");
    assert.equal(defaultDate.status, 200);
    const synced = await hub.http("POST", "/delegation/tasks-board/sync-daily", { ...target(await find("Beta renamed")), date: TODAY });
    assert.equal(synced.status, 200, synced.text);
    const fromDaily = await hub.http("POST", "/delegation/tasks-board/sync-from-daily", { line: 0, date: TODAY });
    assert.equal(fromDaily.status, 404, fromDaily.text);
    assert.equal((await hub.http("POST", "/delegation/tasks-board/sync-from-daily", { line: -1 })).status, 400);
    assert.equal((await hub.http("POST", "/delegation/tasks-board/add-to-daily", {})).status, 400);
    assert.equal((await hub.http("POST", "/delegation/tasks-board/sync-daily", {})).status, 400);
  });
});

describe("board without the feature", () => {
  it("answers disabled and refuses writes when the tasks feature is off", async () => {
    await hub.http("PUT", "/delegation/settings", { features: { tasks: false } });
    const view = (await hub.http("GET", "/delegation/tasks-board")).json as BoardView;
    assert.equal(view.enabled, false);
    const open = await hub.http("POST", "/delegation/tasks-board/open", { projectId: "lab" });
    assert.equal(open.status, 400);
    assert.match(errorOf(open.json), /tasks feature is disabled/);
    await hub.http("PUT", "/delegation/settings", { features: { tasks: true } });
    assert.ok(existsSync(join(box.brain, "projects/lab.md")));
    assert.equal(getSettings().features.tasks, true);
  });
});
