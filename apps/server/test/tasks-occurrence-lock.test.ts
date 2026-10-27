import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { makeSandbox, startServer, type RunningServer, type Sandbox } from "./helpers.js";

interface HttpResult {
  status: number;
  json: Record<string, unknown>;
}

interface WireNote {
  line: number;
  raw: string;
  text: string;
}

interface WireTask {
  id: string;
  projectId: string;
  line: number;
  raw: string;
  title: string;
  status: string;
  section: string;
  doneAt: string | null;
  priority: number | null;
  repeat: string | null;
  noteItems: WireNote[];
  subtasks: WireTask[];
}

interface WireToday {
  mismatch: string[];
}

interface WireChild {
  text: string;
  taskId: string | null;
  mismatch: boolean;
}

interface WireItem {
  line: number;
  text: string;
  taskId: string | null;
  mismatch: boolean;
  recurredToday: boolean;
  children: WireChild[];
}

const OCCURRENCE = "this is a finished occurrence of a recurring task - edit it in Obsidian";

const OPEN_HEAD = ["---", "title: Acme Corp", "---", "", "## Open loops", ""];

const OPEN = [
  "- [ ] Weekly report #p1 🔁 every week 📅 2026-10-23",
  "  - [ ] Collect numbers",
  "    - [ ] Review",
  "  - a note",
  "- [ ] Plain task",
  "  - [ ] Plain child",
];

const DONE_TAIL = ["", "## Done loops", "", "- [x] Old win ✅ 2026-01-02", ""];

const ACME = [...OPEN_HEAD, ...OPEN, ...DONE_TAIL].join("\n");

const GLOBEX = ["---", "title: Globex", "---", "", "## Open loops", "", "- [ ] Globex open", "", "## Done loops", "", "- [x] Globex chores 🔁 every day ✅ 2026-10-01", "  - [x] Sweep", ""].join("\n");

describe("finished occurrences are read-only and the recurrence day holds", () => {
  const box: Sandbox = makeSandbox("cch-tasks-occurrence-");
  const vault = join(box.tmp, "vault");
  const dailyDir = join(box.brain, "daily");
  let hub: RunningServer;

  async function http(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const res = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  const pad = (value: number): string => String(value).padStart(2, "0");
  const today = (): string => {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  };
  const flat = (tasks: WireTask[]): WireTask[] => tasks.flatMap((task) => [task, ...flat(task.subtasks)]);
  const readVault = (rel = "acme.md"): string => readFileSync(join(vault, rel), "utf8");
  const writeVault = (content: string, rel = "acme.md"): void => {
    const full = join(vault, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const dailyPath = (): string => join(dailyDir, `${today()}.md`);
  const writeDailyFile = (content: string): void => {
    mkdirSync(dailyDir, { recursive: true });
    writeFileSync(dailyPath(), content);
  };
  const readDailyFile = (): string => readFileSync(dailyPath(), "utf8");
  const settings = (patch: Record<string, unknown>): Promise<HttpResult> => http("PUT", "/delegation/settings", patch);
  const boardPayload = async (): Promise<Record<string, unknown>> => (await http("GET", "/delegation/tasks-board")).json;
  const board = async (): Promise<WireTask[]> => flat((await boardPayload()).tasks as WireTask[]);
  const find = async (title: string, section = "open", projectId = "acme"): Promise<WireTask> => {
    const found = (await board()).find((task) => task.title === title && task.section === section && task.projectId === projectId);
    assert.ok(found, `${title} in ${section}`);
    return found;
  };
  const ref = (task: { line: number; raw: string }): { line: number; raw: string } => ({ line: task.line, raw: task.raw });
  const target = (task: WireTask): Record<string, unknown> => ({ projectId: task.projectId, line: task.line, raw: task.raw });
  const patch = (task: WireTask, change: Record<string, unknown>): Promise<HttpResult> => http("PATCH", "/delegation/tasks-board/item", { ...target(task), ...change });
  const focus = (...lines: string[]): string => ["## Foco de hoje", "", ...lines, "", "## Reuniões", "", "-", ""].join("\n");
  const putDaily = async (content: string): Promise<HttpResult> => {
    const current = await http("GET", `/delegation/daily/${today()}`);
    return http("PUT", `/delegation/daily/${today()}`, { content, baseUpdatedAt: current.json.updatedAt });
  };
  const fromDaily = (line: number): Promise<HttpResult> => http("POST", "/delegation/tasks-board/sync-from-daily", { line });
  const links = async (): Promise<WireItem[]> => (await http("GET", "/delegation/tasks-board/daily-links")).json.items as WireItem[];
  const todayMismatch = async (): Promise<string[]> => [...((await boardPayload()).today as WireToday).mismatch].sort();
  const linesWith = (content: string, needle: string): number => content.split(/\r?\n/).filter((line) => line.includes(needle)).length;

  const assertRefused = async (label: string, request: Promise<HttpResult>): Promise<void> => {
    const res = await request;
    assert.equal(res.status, 400, `${label}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.error, OCCURRENCE, label);
  };

  before(async () => {
    writeVault(ACME);
    hub = await startServer(box, { HUB_DELEGATION: "1" });
    const res = await settings({
      workspacesRoot: box.root,
      secondBrainRoot: box.brain,
      features: { daily: true, tasks: true },
      daily: { wikilinks: true, headings: { focus: "Foco de hoje" } },
      tasks: { root: vault, doneSection: "Done loops" },
    });
    assert.equal(res.status, 200);
  });

  beforeEach(async () => {
    writeVault(ACME);
    writeVault(GLOBEX, "globex.md");
    rmSync(dailyDir, { recursive: true, force: true });
    assert.equal((await settings({ tasks: { doneSection: "Done loops", doneStamp: " ✅ {{date}}" } })).status, 200);
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("lock", () => {
    it("refuses every hub write on a copy in the done section and inside its block, and writes nothing", async () => {
      assert.equal((await patch(await find("Weekly report"), { status: "done" })).json.recurred, true);
      writeDailyFile(focus("- [ ] [[acme|Acme Corp]] - Plain task"));
      const acme = readVault();
      const globex = readVault("globex.md");
      const daily = readDailyFile();
      const copy = await find("Weekly report", "done");
      const sub = await find("Collect numbers", "done");
      const deep = await find("Review", "done");
      const note = copy.noteItems[0] as WireNote;
      const plain = await find("Plain task");
      const plainChild = await find("Plain child");
      const globexCopy = await find("Globex chores", "done", "globex");
      const changes: Record<string, unknown>[] = [
        { status: "todo" },
        { status: "done" },
        { status: "archived" },
        { title: "Weekly report (sent)" },
        { reason: "late" },
        { priority: 2 },
        { priority: null },
        { start: "2026-10-01" },
        { scheduled: "2026-10-01" },
        { due: null },
        { repeat: "every day" },
        { repeat: null },
      ];
      for (const change of changes) await assertRefused(`copy ${JSON.stringify(change)}`, patch(copy, change));
      await assertRefused("subtask title", patch(sub, { title: "Collect more" }));
      await assertRefused("subtask priority", patch(sub, { priority: 1 }));
      await assertRefused("nested status", patch(deep, { status: "todo" }));
      await assertRefused("subtask under copy", http("POST", "/delegation/tasks-board/item", { projectId: "acme", title: "New step", parentLine: copy.line, parentRaw: copy.raw }));
      await assertRefused("subtask under copy subtask", http("POST", "/delegation/tasks-board/item", { projectId: "acme", title: "New step", parentLine: sub.line, parentRaw: sub.raw }));
      await assertRefused("note add on copy", http("POST", "/delegation/tasks-board/note", { ...target(copy), text: "more" }));
      await assertRefused("note add on subtask", http("POST", "/delegation/tasks-board/note", { ...target(sub), text: "more" }));
      await assertRefused("note edit", http("PATCH", "/delegation/tasks-board/note", { projectId: "acme", ...ref(note), text: "changed" }));
      await assertRefused("note delete", http("DELETE", "/delegation/tasks-board/note", { projectId: "acme", ...ref(note) }));
      await assertRefused("move copy up", http("POST", "/delegation/tasks-board/move", { ...target(copy), direction: "up" }));
      await assertRefused("move copy down", http("POST", "/delegation/tasks-board/move", { ...target(copy), direction: "down" }));
      await assertRefused("move note", http("POST", "/delegation/tasks-board/move", { projectId: "acme", ...ref(note), direction: "up" }));
      await assertRefused("reparent copy under open task", http("POST", "/delegation/tasks-board/reparent", { ...target(copy), parent: ref(plain) }));
      await assertRefused("promote copy subtask", http("POST", "/delegation/tasks-board/reparent", { ...target(sub), parent: null }));
      await assertRefused("open task under copy", http("POST", "/delegation/tasks-board/reparent", { ...target(plain), parent: ref(copy) }));
      await assertRefused("open subtask under copy subtask", http("POST", "/delegation/tasks-board/reparent", { ...target(plainChild), parent: ref(sub) }));
      await assertRefused("copy to another project", http("POST", "/delegation/tasks-board/move-to-project", { ...target(copy), targetProjectId: "globex" }));
      await assertRefused("copy subtask to another project", http("POST", "/delegation/tasks-board/move-to-project", { ...target(sub), targetProjectId: "globex" }));
      await assertRefused("open task under a copy of another project", http("POST", "/delegation/tasks-board/move-to-project", { ...target(plain), targetProjectId: "globex", parent: ref(globexCopy) }));
      await assertRefused("delegate copy", http("POST", "/delegation/tasks-board/delegate", { ...target(copy), workspace: "pilot", prompt: "go" }));
      await assertRefused("delegate copy subtask", http("POST", "/delegation/tasks-board/delegate", { ...target(sub), workspace: "pilot", prompt: "go" }));
      await assertRefused("copy to daily", http("POST", "/delegation/tasks-board/add-to-daily", target(copy)));
      await assertRefused("copy subtask to daily", http("POST", "/delegation/tasks-board/add-to-daily", target(sub)));
      assert.equal(readVault(), acme);
      assert.equal(readVault("globex.md"), globex);
      assert.equal(readDailyFile(), daily);
      assert.deepEqual((await http("POST", "/delegation/tasks-board/sweep-done", {})).json, { moved: 0, projects: [] });
      assert.equal(readVault(), acme);
      assert.equal(readVault("globex.md"), globex);
    });

    it("refuses hub writes on the copy left after the original when no done section is configured", async () => {
      assert.equal((await settings({ tasks: { doneSection: "" } })).status, 200);
      assert.equal((await patch(await find("Weekly report"), { status: "done" })).json.recurred, true);
      writeDailyFile(focus("- [ ] [[acme|Acme Corp]] - Plain task"));
      const acme = readVault();
      const daily = readDailyFile();
      const copy = (await board()).find((task) => task.title === "Weekly report" && task.doneAt !== null);
      assert.ok(copy);
      const sub = copy.subtasks[0] as WireTask;
      const plain = await find("Plain task");
      await assertRefused("title", patch(copy, { title: "Weekly report (sent)" }));
      await assertRefused("priority", patch(copy, { priority: 3 }));
      await assertRefused("due", patch(copy, { due: "2026-12-01" }));
      await assertRefused("subtask title", patch(sub, { title: "Collect more" }));
      await assertRefused("note add", http("POST", "/delegation/tasks-board/note", { ...target(copy), text: "more" }));
      await assertRefused("subtask under copy", http("POST", "/delegation/tasks-board/item", { projectId: "acme", title: "New step", parentLine: copy.line, parentRaw: copy.raw }));
      await assertRefused("move copy up", http("POST", "/delegation/tasks-board/move", { ...target(copy), direction: "up" }));
      await assertRefused("reparent copy", http("POST", "/delegation/tasks-board/reparent", { ...target(copy), parent: ref(plain) }));
      await assertRefused("open task under copy", http("POST", "/delegation/tasks-board/reparent", { ...target(plain), parent: ref(copy) }));
      await assertRefused("copy to another project", http("POST", "/delegation/tasks-board/move-to-project", { ...target(copy), targetProjectId: "globex" }));
      await assertRefused("copy to daily", http("POST", "/delegation/tasks-board/add-to-daily", target(copy)));
      assert.equal(readVault(), acme);
      assert.equal(readDailyFile(), daily);
    });

    it("keeps writes on the reopened original and on plain done tasks working", async () => {
      assert.equal((await patch(await find("Weekly report"), { status: "done" })).status, 200);
      const renamed = await patch(await find("Weekly report"), { title: "Weekly report v2", priority: 2 });
      assert.equal(renamed.status, 200);
      const old = await patch(await find("Old win", "done"), { title: "Old win again" });
      assert.equal(old.status, 200);
      const content = readVault();
      assert.ok(content.includes("\n- [ ] Weekly report v2 #p2 🔁 every week 📅 2026-10-30\n"), content);
      assert.ok(content.includes("\n- [x] Old win again ✅ 2026-01-02\n"), content);
    });
  });

  describe("recurrence day", () => {
    it("keeps the daily item out of sync checks and never completes again when the copy was renamed in Obsidian", async () => {
      writeDailyFile(focus("- [ ] [[acme|Acme Corp]] - Weekly report", "  - [ ] Collect numbers"));
      assert.equal((await patch(await find("Weekly report"), { status: "done" })).json.recurred, true);
      writeVault(readVault().replace("- [x] Weekly report #p1", "- [x] Weekly report (sent) #p1"));
      const renamed = readVault();
      const original = await find("Weekly report");
      const item = (await links())[0] as WireItem;
      assert.equal(item.taskId, original.id);
      assert.equal(item.recurredToday, true);
      assert.equal(item.mismatch, false);
      assert.deepEqual(item.children.map((child) => child.mismatch), [false]);
      assert.deepEqual(await todayMismatch(), []);
      assert.equal((await putDaily(focus("- [ ] [[acme|Acme Corp]] - Weekly report", "  - [x] Collect numbers"))).status, 200);
      assert.equal((await putDaily(focus("- [x] [[acme|Acme Corp]] - Weekly report", "  - [x] Collect numbers"))).status, 200);
      assert.equal(readVault(), renamed);
      const useDaily = await fromDaily(2);
      assert.equal(useDaily.status, 200);
      assert.deepEqual(useDaily.json, { date: today(), updated: 0, failed: [] });
      assert.equal(readVault(), renamed);
      assert.equal(linesWith(renamed, "Weekly report"), 2);
    });

    it("excludes a daily item that still names the copy after the original was renamed", async () => {
      writeDailyFile(focus("- [ ] [[acme|Acme Corp]] - Weekly report"));
      assert.equal((await patch(await find("Weekly report"), { status: "done" })).json.recurred, true);
      assert.equal((await patch(await find("Weekly report"), { title: "Weekly report v2" })).status, 200);
      const written = readVault();
      const original = await find("Weekly report v2");
      const item = (await links())[0] as WireItem;
      assert.equal(item.taskId, original.id);
      assert.equal(item.recurredToday, true);
      assert.equal(item.mismatch, false);
      assert.deepEqual(await todayMismatch(), []);
      assert.equal((await putDaily(focus("- [ ] [[acme|Acme Corp]] - Weekly report"))).status, 200);
      assert.equal((await putDaily(focus("- [x] [[acme|Acme Corp]] - Weekly report"))).status, 200);
      assert.deepEqual((await fromDaily(2)).json, { date: today(), updated: 0, failed: [] });
      assert.equal(readVault(), written);
    });

    it("excludes a top-level daily item linked to a subtask of the recurring task", async () => {
      writeDailyFile(focus("- [ ] [[acme|Acme Corp]] - Weekly report", "- [x] [[acme|Acme Corp]] - Collect numbers"));
      assert.equal((await patch(await find("Weekly report"), { status: "done" })).json.recurred, true);
      const written = readVault();
      const collect = await find("Collect numbers");
      const item = (await links()).find((candidate) => candidate.text === "Collect numbers");
      assert.ok(item);
      assert.equal(item.taskId, collect.id);
      assert.equal(item.recurredToday, true);
      assert.equal(item.mismatch, false);
      assert.deepEqual(await todayMismatch(), []);
      assert.deepEqual((await fromDaily(3)).json, { date: today(), updated: 0, failed: [] });
      assert.equal(readVault(), written);
      assert.equal((await find("Collect numbers")).status, "todo");
    });
  });

  describe("one mismatch rule", () => {
    it("compares the exact checkbox on items, children and the board", async () => {
      writeVault(
        [
          ...OPEN_HEAD,
          "- [ ] Plain task",
          "  - [ ] Plain child",
          "  - [-] Busy child",
          "- [-] Doing thing",
          "- [ ] BLOCK - Waiting on legal",
          "- [x] ARCHIVED - Old idea",
          ...DONE_TAIL,
        ].join("\n"),
      );
      writeDailyFile(
        focus(
          "- [-] [[acme|Acme Corp]] - Plain task",
          "  - [-] Plain child",
          "  - [-] Busy child",
          "- [ ] [[acme|Acme Corp]] - Doing thing",
          "- [ ] [[acme|Acme Corp]] - Waiting on legal",
          "- [x] [[acme|Acme Corp]] - Old idea",
        ),
      );
      const items = await links();
      assert.deepEqual(
        items.map((item) => [item.text, item.mismatch]),
        [
          ["Plain task", true],
          ["Doing thing", true],
          ["Waiting on legal", false],
          ["Old idea", false],
        ],
      );
      assert.deepEqual((items[0] as WireItem).children.map((child) => [child.text, child.mismatch]), [
        ["Plain child", true],
        ["Busy child", false],
      ]);
      const expected = [(await find("Plain task")).id, (await find("Plain child")).id, (await find("Doing thing")).id].sort();
      assert.deepEqual(await todayMismatch(), expected);
    });
  });

  describe("custom done stamp", () => {
    it("ends the repeat rule before the stamp so the copy keeps its date and stays read-only", async () => {
      assert.equal((await settings({ tasks: { doneStamp: " (done {{date}})" } })).status, 200);
      writeVault([...OPEN_HEAD, "- [ ] Stretch 🔁 every day", "- [ ] Plain task", ...DONE_TAIL].join("\n"));
      const res = await patch(await find("Stretch"), { status: "done" });
      assert.equal(res.status, 200);
      assert.equal(res.json.recurred, true);
      const copy = await find("Stretch", "done");
      assert.equal(copy.raw, `- [x] Stretch 🔁 every day (done ${today()})`);
      assert.deepEqual([copy.title, copy.repeat, copy.doneAt], ["Stretch", "every day", today()]);
      const written = readVault();
      await assertRefused("status", patch(copy, { status: "todo" }));
      await assertRefused("reparent", http("POST", "/delegation/tasks-board/reparent", { ...target(copy), parent: ref(await find("Plain task")) }));
      assert.equal(readVault(), written);
      assert.equal(linesWith(written, "Stretch"), 2);
    });

    it("reads a hand-written copy with a custom stamp followed by a priority tag", async () => {
      assert.equal((await settings({ tasks: { doneStamp: " (done {{date}})" } })).status, 200);
      writeVault([...OPEN_HEAD, "- [ ] Stretch 🔁 every day", ...DONE_TAIL.slice(0, -1), "- [x] Stretch 🔁 every 2 days (done 2026-10-01) #p2", ""].join("\n"));
      const copy = await find("Stretch", "done");
      assert.deepEqual([copy.title, copy.repeat, copy.doneAt, copy.priority], ["Stretch", "every 2 days", "2026-10-01", 2]);
      const written = readVault();
      await assertRefused("status", patch(copy, { status: "todo" }));
      assert.equal(readVault(), written);
    });
  });
});
