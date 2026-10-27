import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { makeSandbox, startServer, type RunningServer, type Sandbox } from "./helpers.js";

interface HttpResult {
  status: number;
  json: Record<string, unknown>;
}

interface WireTask {
  id: string;
  projectId: string;
  line: number;
  raw: string;
  title: string;
  status: string;
  section: string;
  priority: number | null;
  start: string | null;
  scheduled: string | null;
  due: string | null;
  repeat: string | null;
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
  taskId: string | null;
  mismatch: boolean;
  recurredToday: boolean;
  children: WireChild[];
}

const OPEN_HEAD = ["---", "title: Acme Corp", "---", "", "## Open loops", ""];

const WEEKLY = [
  "- [ ] Weekly report #p1 🔁 every week 📅 2026-10-23",
  "  - [ ] Collect numbers",
  "  - [-] Write summary",
  "    - [ ] Review",
  "  - a note",
];

const REOPENED = [
  "- [ ] Weekly report #p1 🔁 every week 📅 2026-10-30",
  "  - [ ] Collect numbers",
  "  - [ ] Write summary",
  "    - [ ] Review",
  "  - a note",
];

const OLD_WIN = "- [x] Old win ✅ 2026-01-02";
const DONE_TAIL = ["", "## Done loops", "", OLD_WIN, ""];
const ACME = [...OPEN_HEAD, ...WEEKLY, ...DONE_TAIL].join("\n");

describe("recurring tasks and their daily subtasks", () => {
  const box: Sandbox = makeSandbox("cch-tasks-recur-daily-");
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
  const stamp = (): string => ` ✅ ${today()}`;
  const flat = (tasks: WireTask[]): WireTask[] => tasks.flatMap((task) => [task, ...flat(task.subtasks)]);
  const readVault = (): string => readFileSync(join(vault, "acme.md"), "utf8");
  const writeVault = (content: string): void => {
    const full = join(vault, "acme.md");
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
  const find = async (title: string, section = "open"): Promise<WireTask> => {
    const found = flat((await boardPayload()).tasks as WireTask[]).find((task) => task.title === title && task.section === section);
    assert.ok(found, `${title} in ${section}`);
    return found;
  };
  const patch = (task: WireTask, change: Record<string, unknown>): Promise<HttpResult> =>
    http("PATCH", "/delegation/tasks-board/item", { projectId: task.projectId, line: task.line, raw: task.raw, ...change });
  const focus = (...lines: string[]): string => ["## Foco de hoje", "", ...lines, "", "## Reuniões", "", "-", ""].join("\n");
  const putDaily = async (content: string): Promise<HttpResult> => {
    const current = await http("GET", `/delegation/daily/${today()}`);
    return http("PUT", `/delegation/daily/${today()}`, { content, baseUpdatedAt: current.json.updatedAt });
  };
  const fromDaily = (body: Record<string, unknown>): Promise<HttpResult> => http("POST", "/delegation/tasks-board/sync-from-daily", body);
  const links = async (): Promise<WireItem[]> => (await http("GET", "/delegation/tasks-board/daily-links")).json.items as WireItem[];
  const assertInSync = async (): Promise<void> => {
    const items = await links();
    for (const item of items) {
      assert.equal(item.mismatch, false, `item ${item.line}`);
      for (const child of item.children) assert.equal(child.mismatch, false, child.text);
    }
    assert.deepEqual(((await boardPayload()).today as WireToday).mismatch, []);
  };
  const doneCopy = (...nested: string[]): string[] => [`- [x] Weekly report #p1 🔁 every week 📅 2026-10-23${stamp()}`, ...nested, "  - a note"];
  const ALL_DONE = ["  - [x] Collect numbers", "  - [x] Write summary", "    - [x] Review"];
  const RECURRED = [...OPEN_HEAD, ...REOPENED, "", "## Done loops", "", ...doneCopy(...ALL_DONE), OLD_WIN, ""].join("\n");

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
    rmSync(dailyDir, { recursive: true, force: true });
    assert.equal((await settings({ tasks: { doneSection: "Done loops" } })).status, 200);
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("completion from the daily", () => {
    it("closes the copy with every nested task line done and leaves the daily untouched", async () => {
      writeDailyFile(focus("- [ ] [[acme|Acme Corp]] - Weekly report", "  - [x] Collect numbers", "  - [-] Write summary", "    - [ ] Review"));
      const ticked = focus("- [x] [[acme|Acme Corp]] - Weekly report", "  - [x] Collect numbers", "  - [-] Write summary", "    - [ ] Review");
      assert.equal((await putDaily(ticked)).status, 200);
      assert.equal(readVault(), RECURRED);
      assert.equal(readDailyFile(), ticked);
      await assertInSync();
      assert.equal((await links())[0]?.recurredToday, true);
      const useDaily = await fromDaily({ line: 2 });
      assert.equal(useDaily.status, 200);
      assert.deepEqual(useDaily.json, { date: today(), updated: 0, failed: [] });
      assert.equal(readVault(), RECURRED);
      assert.equal(readDailyFile(), ticked);
    });

    it("ignores later daily changes on the recurred item and its children", async () => {
      writeDailyFile(focus("- [ ] [[acme|Acme Corp]] - Weekly report", "  - [x] Collect numbers", "  - [-] Write summary", "    - [ ] Review"));
      assert.equal((await putDaily(focus("- [x] [[acme|Acme Corp]] - Weekly report", "  - [x] Collect numbers", "  - [-] Write summary", "    - [ ] Review"))).status, 200);
      const later = focus("- [x] [[acme|Acme Corp]] - Weekly report", "  - [ ] Collect numbers", "  - [-] Write summary", "    - [x] Review");
      assert.equal((await putDaily(later)).status, 200);
      assert.equal(readVault(), RECURRED);
      assert.equal(readDailyFile(), later);
      await assertInSync();
      const unticked = focus("- [ ] [[acme|Acme Corp]] - Weekly report", "  - [ ] Collect numbers", "  - [ ] Write summary", "    - [x] Review");
      assert.equal((await putDaily(unticked)).status, 200);
      assert.equal(readVault(), RECURRED);
      assert.equal(readDailyFile(), unticked);
      await assertInSync();
      assert.deepEqual((await fromDaily({ line: 2 })).json, { date: today(), updated: 0, failed: [] });
      const original = await find("Weekly report");
      const sync = await http("POST", "/delegation/tasks-board/sync-daily", { projectId: "acme", line: original.line, raw: original.raw });
      assert.deepEqual(sync.json, { date: today(), updated: 0 });
      assert.equal(readVault(), RECURRED);
      assert.equal(readDailyFile(), unticked);
    });

    it("recurs from sync-from-daily once, ignores nested daily lines and closes every nested line of the copy", async () => {
      writeDailyFile(focus("- [x] [[acme|Acme Corp]] - Weekly report", "  - [x] Collect numbers", "  - [ ] Write summary", "    - [ ] Review", "  - [x] Unknown step"));
      const res = await fromDaily({ line: 2 });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { date: today(), updated: 1, failed: [] });
      assert.equal(readVault(), RECURRED);
      await assertInSync();
      assert.deepEqual((await fromDaily({ line: 2 })).json, { date: today(), updated: 0, failed: [] });
    });
  });

  describe("completion from the board", () => {
    it("closes every nested line of the copy and marks only the daily item line", async () => {
      const nested = ["  - [ ] Collect numbers", "  - [ ] Write summary", "    - [x] Review"];
      writeDailyFile(focus("- [ ] [[acme|Acme Corp]] - Weekly report", ...nested));
      const res = await patch(await find("Weekly report"), { status: "done" });
      assert.equal(res.status, 200);
      assert.deepEqual([res.json.recurred, res.json.dailySynced], [true, true]);
      assert.equal(readVault(), RECURRED);
      const marked = focus("- [x] [[acme|Acme Corp]] - Weekly report", ...nested);
      assert.equal(readDailyFile(), marked);
      await assertInSync();
      const task = res.json.task as WireTask;
      const sync = await http("POST", "/delegation/tasks-board/sync-daily", { projectId: "acme", line: task.line, raw: task.raw });
      assert.deepEqual(sync.json, { date: today(), updated: 0 });
      assert.equal(readDailyFile(), marked);
    });

    it("does not write later board changes of the reopened task into the recurred daily lines", async () => {
      writeDailyFile(focus("- [ ] [[acme|Acme Corp]] - Weekly report", "  - [ ] Collect numbers", "  - [ ] Write summary"));
      assert.equal((await patch(await find("Weekly report"), { status: "done" })).status, 200);
      const marked = focus("- [x] [[acme|Acme Corp]] - Weekly report", "  - [ ] Collect numbers", "  - [ ] Write summary");
      assert.equal(readDailyFile(), marked);
      const child = await patch(await find("Collect numbers"), { status: "done" });
      assert.equal(child.status, 200);
      assert.equal(child.json.dailySynced, false);
      const parent = await patch(await find("Weekly report"), { status: "doing" });
      assert.equal(parent.status, 200);
      assert.equal(parent.json.dailySynced, false);
      assert.equal(readDailyFile(), marked);
      await assertInSync();
    });

    it("places a second completion on the same day above the first copy, with or without a done section", async () => {
      const first = await patch(await find("Weekly report"), { status: "done" });
      assert.equal(first.json.recurred, true);
      const second = await patch(first.json.task as WireTask, { status: "done" });
      assert.equal(second.status, 200);
      assert.equal(second.json.recurred, true);
      assert.equal((second.json.task as WireTask).due, "2026-11-06");
      const secondCopy = [`- [x] Weekly report #p1 🔁 every week 📅 2026-10-30${stamp()}`, ...ALL_DONE, "  - a note"];
      const reopenedTwice = REOPENED.map((line) => line.replace("2026-10-30", "2026-11-06"));
      const firstCopy = doneCopy(...ALL_DONE);
      assert.equal(readVault(), [...OPEN_HEAD, ...reopenedTwice, "", "## Done loops", "", ...secondCopy, ...firstCopy, OLD_WIN, ""].join("\n"));

      writeVault([...OPEN_HEAD, ...WEEKLY, "- [ ] Next task", ""].join("\n"));
      assert.equal((await settings({ tasks: { doneSection: "" } })).status, 200);
      const plainFirst = await patch(await find("Weekly report"), { status: "done" });
      const plainSecond = await patch(plainFirst.json.task as WireTask, { status: "done" });
      assert.equal(plainSecond.json.recurred, true);
      assert.equal((plainSecond.json.task as WireTask).line, 6);
      assert.equal(readVault(), [...OPEN_HEAD, ...reopenedTwice, ...secondCopy, ...firstCopy, "- [ ] Next task", ""].join("\n"));
    });
  });

  describe("sync-from-daily failures", () => {
    it("applies every other child and the item when one child fails, and reports the failure", async () => {
      writeVault([...OPEN_HEAD, "- [ ] Parent task", "  - [ ] Good child", "  - [ ] Bad child 📅 2026-10-01 📅 2026-10-02", "  - [ ] Last child", ...DONE_TAIL].join("\n"));
      writeDailyFile(focus("- [x] [[acme|Acme Corp]] - Parent task", "  - [x] Good child", "  - [x] Bad child", "  - [x] Last child"));
      const bad = await find("Bad child");
      const res = await fromDaily({ line: 2 });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, {
        date: today(),
        updated: 3,
        failed: [{ taskId: bad.id, error: "the task has two different due values, fix the line in the file first" }],
      });
      assert.equal(
        readVault(),
        [...OPEN_HEAD, "- [x] Parent task", "  - [x] Good child", "  - [ ] Bad child 📅 2026-10-01 📅 2026-10-02", "  - [x] Last child", ...DONE_TAIL].join("\n"),
      );
    });

    it("answers the error only when every needed write failed", async () => {
      const clash = [...OPEN_HEAD, "- [ ] Clash 📅 2026-10-01 📅 2026-10-02", ...DONE_TAIL].join("\n");
      writeVault(clash);
      writeDailyFile(focus("- [x] [[acme|Acme Corp]] - Clash"));
      const res = await fromDaily({ line: 2 });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, "the task has two different due values, fix the line in the file first");
      assert.equal(readVault(), clash);
    });
  });

  describe("links and out-of-range dates in titles", () => {
    const LINKED = [
      ...OPEN_HEAD,
      "- [ ] Wiki [[notes|📅 2026-10-30]] here",
      "- [ ] Link [spec](https://example.com/📅 2026-10-30) here",
      "- [ ] Raw https://example.com/🔁every-day tail 📅 2026-11-01",
      "- [ ] Alias [[notes| #p1 ]] text #p2",
      "- [ ] Ancient 📅 0002-10-27",
      "- [ ] Future 🛫 2206-10-27 📅 2026-11-01",
      "- [ ] Edge 🔁 every day 📅 2100-12-31",
      ...DONE_TAIL,
    ];

    it("keeps signifiers and priority tags inside wikilinks, links and URLs as title text", async () => {
      writeVault(LINKED.join("\n"));
      const wiki = await find("Wiki [[notes|📅 2026-10-30]] here");
      assert.equal(wiki.due, null);
      const link = await find("Link [spec](https://example.com/📅 2026-10-30) here");
      assert.equal(link.due, null);
      const raw = await find("Raw https://example.com/🔁every-day tail");
      assert.deepEqual([raw.due, raw.repeat], ["2026-11-01", null]);
      const alias = await find("Alias [[notes| #p1 ]] text");
      assert.equal(alias.priority, 2);
      const wikiRes = await patch(wiki, { priority: 3 });
      assert.equal(wikiRes.status, 200);
      assert.equal((wikiRes.json.task as WireTask).raw, "- [ ] Wiki [[notes|📅 2026-10-30]] here #p3");
      const linkRes = await patch(await find("Link [spec](https://example.com/📅 2026-10-30) here"), { due: "2026-11-15" });
      assert.equal((linkRes.json.task as WireTask).raw, "- [ ] Link [spec](https://example.com/📅 2026-10-30) here 📅 2026-11-15");
    });

    it("keeps dates outside 2000-2100 as title text and never advances past 2100", async () => {
      writeVault(LINKED.join("\n"));
      const ancient = await find("Ancient 📅 0002-10-27");
      assert.equal(ancient.due, null);
      const future = await find("Future 🛫 2206-10-27");
      assert.deepEqual([future.start, future.due], [null, "2026-11-01"]);
      const res = await patch(future, { priority: 1 });
      assert.equal((res.json.task as WireTask).raw, "- [ ] Future 🛫 2206-10-27 #p1 📅 2026-11-01");
      const edge = await patch(await find("Edge"), { status: "done" });
      assert.equal(edge.json.recurred, true);
      assert.equal((edge.json.task as WireTask).raw, "- [ ] Edge 🔁 every day 📅 2100-12-31");
    });

    it("answers 400 on PATCH and POST dates outside 2000-2100 and accepts the bounds", async () => {
      writeVault(ACME);
      const task = await find("Weekly report");
      for (const [field, value] of [["due", "1999-12-31"], ["start", "2101-01-01"], ["scheduled", "0002-10-27"]] as const) {
        const res = await patch(task, { [field]: value });
        assert.equal(res.status, 400, `${field} ${value}`);
        assert.equal(res.json.error, `${field} must be a date between 2000 and 2100`);
      }
      const created = await http("POST", "/delegation/tasks-board/item", { projectId: "acme", title: "Far", due: "2206-10-27" });
      assert.equal(created.status, 400);
      assert.equal(created.json.error, "due must be a date between 2000 and 2100");
      assert.equal(readVault(), ACME);
      const low = await patch(task, { start: "2000-01-01" });
      assert.equal(low.status, 200);
      const high = await patch(low.json.task as WireTask, { due: "2100-12-31" });
      assert.equal(high.status, 200);
      assert.equal((high.json.task as WireTask).raw, "- [ ] Weekly report #p1 🔁 every week 🛫 2000-01-01 📅 2100-12-31");
    });
  });
});
