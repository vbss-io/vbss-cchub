import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { makeSandbox, startServer, type RunningServer, type Sandbox } from "./helpers.js";

interface HttpResult {
  status: number;
  json: Record<string, unknown>;
}

interface WireChild {
  mismatch: boolean;
}

interface WireItem {
  line: number;
  taskStatus: string | null;
  mismatch: boolean;
  recurredToday: boolean;
  children: WireChild[];
}

interface WireTask {
  id: string;
  projectId: string;
  line: number;
  raw: string;
  title: string;
}

const PAST = "2026-04-03";
const FUTURE = "2099-01-02";

const ACME = [
  "---",
  "title: Acme Corp",
  "---",
  "",
  "## Open loops",
  "",
  "- [ ] Weekly report #p1 🔁 every week 📅 2026-10-23",
  "  - [ ] Collect numbers",
  "  - [ ] Write summary",
  "- [ ] Parent task",
  "  - [ ] Child one",
  "  - [ ] Child two",
  "  - [x] Child three",
  "  - [ ] Child four",
  "- [x] ARCHIVED - Old plan - dropped",
  "- [ ] ARCHIVED - Stale idea - dropped",
  "- [ ] BLOCK - Vendor audit - waiting vendor",
  "- [-] HOLD - Office move",
  "",
  "## Done loops",
  "",
  "- [x] Old win ✅ 2026-01-02",
  "",
].join("\n");

describe("daily to tasks sync covers the basics", () => {
  const box: Sandbox = makeSandbox("cch-tasks-basic-sync-");
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
  const flat = (tasks: (WireTask & { subtasks?: WireTask[] })[]): WireTask[] => tasks.flatMap((task) => [task, ...flat((task.subtasks ?? []) as WireTask[])]);
  const readVault = (): string => readFileSync(join(vault, "acme.md"), "utf8");
  const writeVault = (content: string): void => {
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "acme.md"), content);
  };
  const dailyPath = (date: string): string => join(dailyDir, `${date}.md`);
  const writeDailyFile = (date: string, content: string): void => {
    mkdirSync(dailyDir, { recursive: true });
    writeFileSync(dailyPath(date), content);
  };
  const readDailyFile = (date: string): string => readFileSync(dailyPath(date), "utf8");
  const settings = (patch: Record<string, unknown>): Promise<HttpResult> => http("PUT", "/delegation/settings", patch);
  const boardPayload = async (): Promise<Record<string, unknown>> => (await http("GET", "/delegation/tasks-board")).json;
  const mismatchIds = async (): Promise<string[]> => (((await boardPayload()).today as { mismatch: string[] }).mismatch);
  const find = async (title: string): Promise<WireTask> => {
    const found = flat((await boardPayload()).tasks as WireTask[]).find((task) => task.title === title);
    assert.ok(found, title);
    return found;
  };
  const patch = (task: WireTask, change: Record<string, unknown>): Promise<HttpResult> =>
    http("PATCH", "/delegation/tasks-board/item", { projectId: task.projectId, line: task.line, raw: task.raw, ...change });
  const focus = (...lines: string[]): string => ["## Foco de hoje", "", ...lines, "", "## Reuniões", "", "-", ""].join("\n");
  const putDaily = async (date: string, content: string): Promise<HttpResult> => {
    const current = await http("GET", `/delegation/daily/${date}`);
    return http("PUT", `/delegation/daily/${date}`, { content, baseUpdatedAt: current.json.updatedAt });
  };
  const fromDaily = (body: Record<string, unknown>): Promise<HttpResult> => http("POST", "/delegation/tasks-board/sync-from-daily", body);
  const links = async (date: string): Promise<WireItem[]> => (await http("GET", `/delegation/tasks-board/daily-links?date=${date}`)).json.items as WireItem[];
  const copies = (text: string): string[] => text.split("\n").filter((line) => line.startsWith("- [x] Weekly report"));
  const label = (title: string): string => `[[acme|Acme Corp]] - ${title}`;

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

  beforeEach(() => {
    writeVault(ACME);
    rmSync(dailyDir, { recursive: true, force: true });
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("recurring tasks", () => {
    it("writes nothing from a past or future daily with the recurring item ticked", async () => {
      for (const date of [PAST, FUTURE]) {
        writeDailyFile(date, focus(`- [x] ${label("Weekly report")}`, "  - [x] Collect numbers"));
        const [item] = await links(date);
        assert.equal(item?.mismatch, false, date);
        assert.deepEqual(item?.children.map((child) => child.mismatch), [false], date);
        const res = await fromDaily({ line: 2, date });
        assert.equal(res.status, 200, date);
        assert.deepEqual(res.json, { date, updated: 0, failed: [] }, date);
        assert.equal(readVault(), ACME, date);
      }
      assert.deepEqual(await mismatchIds(), []);
    });

    it("completes the recurring task once from a daily save and keeps a single copy on later saves and Use daily", async () => {
      writeDailyFile(today(), focus(`- [ ] ${label("Weekly report")}`));
      assert.equal((await putDaily(today(), focus(`- [x] ${label("Weekly report")}`))).status, 200);
      const afterFirst = readVault();
      assert.equal(copies(afterFirst).length, 1);
      assert.ok(afterFirst.includes("- [ ] Weekly report #p1 🔁 every week 📅 2026-10-30"));
      assert.ok(copies(afterFirst)[0]?.endsWith(`✅ ${today()}`));
      assert.equal((await putDaily(today(), focus(`- [ ] ${label("Weekly report")}`))).status, 200);
      assert.equal((await putDaily(today(), focus(`- [x] ${label("Weekly report")}`))).status, 200);
      assert.equal(readVault(), afterFirst);
      const useDaily = await fromDaily({ line: 2 });
      assert.deepEqual(useDaily.json, { date: today(), updated: 0, failed: [] });
      assert.equal(readVault(), afterFirst);
      const [item] = await links(today());
      assert.equal(item?.mismatch, false);
      assert.equal(item?.recurredToday, true);
      assert.deepEqual(await mismatchIds(), []);
    });

    it("completes the recurring task once from Use daily and writes no nested line", async () => {
      writeDailyFile(today(), focus(`- [x] ${label("Weekly report")}`, "  - [x] Collect numbers", "  - [-] Write summary"));
      const [pending] = await links(today());
      assert.equal(pending?.mismatch, true);
      assert.deepEqual(pending?.children.map((child) => child.mismatch), [false, false]);
      const first = await fromDaily({ line: 2 });
      assert.deepEqual(first.json, { date: today(), updated: 1, failed: [] });
      const afterFirst = readVault();
      assert.equal(copies(afterFirst).length, 1);
      assert.ok(afterFirst.includes("- [ ] Weekly report #p1 🔁 every week 📅 2026-10-30\n  - [ ] Collect numbers\n  - [ ] Write summary\n"));
      assert.deepEqual((await fromDaily({ line: 2 })).json, { date: today(), updated: 0, failed: [] });
      assert.equal(readVault(), afterFirst);
    });

    it("ignores nested daily lines of a recurring task on a daily save and on Use daily", async () => {
      writeDailyFile(today(), focus(`- [ ] ${label("Weekly report")}`, "  - [ ] Collect numbers"));
      assert.equal((await putDaily(today(), focus(`- [ ] ${label("Weekly report")}`, "  - [x] Collect numbers"))).status, 200);
      assert.equal(readVault(), ACME);
      const res = await fromDaily({ line: 2 });
      assert.deepEqual(res.json, { date: today(), updated: 0, failed: [] });
      assert.equal(readVault(), ACME);
      assert.deepEqual(await mismatchIds(), []);
    });
  });

  describe("archived, blocked and hold tasks", () => {
    const ARCHIVED = focus(`- [x] ${label("Old plan - dropped")}`, `- [ ] ${label("Stale idea - dropped")}`);
    const PAUSED = focus(`- [x] ${label("Vendor audit - waiting vendor")}`, `- [x] ${label("Office move")}`);

    it("never flags archived items, writes nothing on Use daily and keeps the prefixes", async () => {
      writeDailyFile(today(), ARCHIVED);
      const items = await links(today());
      assert.deepEqual(items.map((item) => [item.taskStatus, item.mismatch]), [["archived", false], ["archived", false]]);
      assert.deepEqual(await mismatchIds(), []);
      for (const line of [2, 3]) {
        const res = await fromDaily({ line });
        assert.deepEqual(res.json, { date: today(), updated: 0, failed: [] }, `line ${line}`);
      }
      assert.equal(readVault(), ACME);
      assert.ok(readVault().includes("- [x] ARCHIVED - Old plan - dropped\n- [ ] ARCHIVED - Stale idea - dropped\n"));
    });

    it("writes nothing for archived items on a daily save", async () => {
      writeDailyFile(today(), ARCHIVED);
      const swapped = focus(`- [ ] ${label("Old plan - dropped")}`, `- [x] ${label("Stale idea - dropped")}`);
      assert.equal((await putDaily(today(), swapped)).status, 200);
      assert.equal(readVault(), ACME);
    });

    it("leaves blocked and hold tasks untouched on Use daily and on a daily save", async () => {
      writeDailyFile(today(), PAUSED);
      const items = await links(today());
      assert.deepEqual(items.map((item) => [item.taskStatus, item.mismatch]), [["blocked", false], ["hold", false]]);
      assert.deepEqual(await mismatchIds(), []);
      for (const line of [2, 3]) assert.deepEqual((await fromDaily({ line })).json, { date: today(), updated: 0, failed: [] }, `line ${line}`);
      assert.equal(readVault(), ACME);
      const toggled = focus(`- [ ] ${label("Vendor audit - waiting vendor")}`, `- [-] ${label("Office move")}`);
      assert.equal((await putDaily(today(), toggled)).status, 200);
      assert.equal(readVault(), ACME);
    });
  });

  describe("non-recurring subtasks", () => {
    it("applies daily checkboxes to the subtasks and the task from Use daily and from a daily save", async () => {
      writeDailyFile(today(), focus(`- [ ] ${label("Parent task")}`, "  - [x] Child one", "  - [-] Child two", "  - [ ] Child four"));
      const res = await fromDaily({ line: 2 });
      assert.deepEqual(res.json, { date: today(), updated: 2, failed: [] });
      assert.ok(readVault().includes("- [ ] Parent task\n  - [x] Child one\n  - [-] Child two\n  - [x] Child three\n  - [ ] Child four\n"));
      assert.equal((await putDaily(today(), focus(`- [ ] ${label("Parent task")}`, "  - [x] Child one", "  - [-] Child two", "  - [x] Child four"))).status, 200);
      assert.ok(readVault().includes("  - [x] Child three\n  - [x] Child four\n"));
    });

    it("writes a subtask status change from the board into the daily line", async () => {
      writeDailyFile(today(), focus(`- [ ] ${label("Parent task")}`, "  - [ ] Child one", "  - [ ] Child four"));
      const res = await patch(await find("Child four"), { status: "done" });
      assert.equal(res.status, 200);
      assert.equal(res.json.dailySynced, true);
      assert.equal(readDailyFile(today()), focus(`- [ ] ${label("Parent task")}`, "  - [ ] Child one", "  - [x] Child four"));
    });
  });

  describe("Use daily", () => {
    it("writes each differing line once and nothing else", async () => {
      writeDailyFile(today(), focus(`- [x] ${label("Parent task")}`, "  - [x] Child one", "  - [ ] Child two", "  - [x] Child three", "  - [-] Child four"));
      const first = await fromDaily({ line: 2 });
      assert.deepEqual(first.json, { date: today(), updated: 3, failed: [] });
      assert.ok(readVault().includes("- [x] Parent task\n  - [x] Child one\n  - [ ] Child two\n  - [x] Child three\n  - [-] Child four\n"));
      const second = await fromDaily({ line: 2 });
      assert.deepEqual(second.json, { date: today(), updated: 0, failed: [] });
    });
  });
});
