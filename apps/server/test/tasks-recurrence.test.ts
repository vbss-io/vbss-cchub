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
  doneAt: string | null;
  start: string | null;
  scheduled: string | null;
  due: string | null;
  repeat: string | null;
  subtasks: WireTask[];
}

interface WireToday {
  taskIds: string[];
  states: Record<string, string>;
  mismatch: string[];
}

interface WireLinkItem {
  line: number;
  taskId: string | null;
  checkbox: string;
  mismatch: boolean;
  recurredToday: boolean;
}

const OPEN_HEAD = ["---", "title: Acme Corp", "---", "", "## Open loops", ""];

const WEEKLY = [
  "- [ ] Weekly report #p1 🔁 every week 🛫 2026-10-20 📅 2026-10-23",
  "  - [x] Collect numbers",
  "  - [-] Write summary",
  "    - [ ] Review",
  "  - a note",
];

const RULES = [
  "- [ ] Month end 🔁 every month 📅 2026-01-31",
  "- [ ] Leap 🔁 every year 📅 2024-02-29",
  "- [ ] Biweekly 🔁 every 2 weeks ⏳ 2026-12-25",
  "- [ ] Standup 🔁 every day 📅 2026-12-31",
  "- [ ] Quarterly 🔁 every 3 months 📅 2026-11-30",
  "- [ ] Workday 🔁 every weekday 📅 2026-10-30",
  "- [ ] Weekend 🔁 every weekday 🛫 2026-10-31",
  "- [ ] Odd rule 🔁 every week when done 📅 2026-10-23",
  "- [ ] No dates 🔁 every week",
  "- [ ] Plain parent",
  "  - [ ] Recurring child 🔁 every week 📅 2026-10-23",
  "- [ ] Normal task",
];

const DONE_TAIL = ["", "## Done loops", "", "- [x] Old win ✅ 2026-01-02", ""];

const ACME = [...OPEN_HEAD, ...WEEKLY, ...RULES, ...DONE_TAIL].join("\n");

describe("recurring tasks", () => {
  const box: Sandbox = makeSandbox("cch-tasks-recur-");
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
  const dateOf = (when: Date): string => `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  const today = (): string => dateOf(new Date());
  const OTHER_DATE = "2026-04-03";
  const flat = (tasks: WireTask[]): WireTask[] => tasks.flatMap((task) => [task, ...flat(task.subtasks)]);
  const readVault = (rel: string): string => readFileSync(join(vault, rel), "utf8");
  const writeVault = (rel: string, content: string): void => {
    const full = join(vault, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const dailyPath = (date: string): string => join(dailyDir, `${date}.md`);
  const writeDailyFile = (date: string, content: string): void => {
    mkdirSync(dailyDir, { recursive: true });
    writeFileSync(dailyPath(date), content);
  };
  const readDailyFile = (date: string): string => readFileSync(dailyPath(date), "utf8");
  const settings = (patch: Record<string, unknown>): Promise<HttpResult> => http("PUT", "/delegation/settings", patch);
  const boardPayload = async (): Promise<Record<string, unknown>> => (await http("GET", "/delegation/tasks-board")).json;
  const board = async (): Promise<WireTask[]> => flat((await boardPayload()).tasks as WireTask[]);
  const find = async (title: string, section = "open"): Promise<WireTask> => {
    const found = (await board()).find((task) => task.title === title && task.section === section);
    assert.ok(found, `${title} in ${section}`);
    return found;
  };
  const patch = (task: WireTask, change: Record<string, unknown>): Promise<HttpResult> =>
    http("PATCH", "/delegation/tasks-board/item", { projectId: task.projectId, line: task.line, raw: task.raw, ...change });
  const focus = (...lines: string[]): string => ["## Foco de hoje", "", ...lines, "", "## Reuniões", "", "-", ""].join("\n");
  const putDaily = async (date: string, content: string): Promise<HttpResult> => {
    const current = await http("GET", `/delegation/daily/${date}`);
    return http("PUT", `/delegation/daily/${date}`, { content, baseUpdatedAt: current.json.updatedAt });
  };
  const stamp = (): string => ` ✅ ${today()}`;

  before(async () => {
    writeVault("acme.md", ACME);
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
    writeVault("acme.md", ACME);
    rmSync(dailyDir, { recursive: true, force: true });
    assert.equal((await settings({ tasks: { doneSection: "Done loops" } })).status, 200);
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("PATCH done", () => {
    it("copies the block to the top of the done section and reopens the original with its dates advanced", async () => {
      const res = await patch(await find("Weekly report"), { status: "done" });
      assert.equal(res.status, 200);
      assert.equal(res.json.recurred, true);
      const task = res.json.task as WireTask;
      assert.equal(task.status, "todo");
      assert.equal(task.section, "open");
      assert.equal(task.raw, "- [ ] Weekly report #p1 🔁 every week 🛫 2026-10-27 📅 2026-10-30");
      assert.deepEqual([task.start, task.due, task.repeat], ["2026-10-27", "2026-10-30", "every week"]);
      assert.deepEqual(task.subtasks.map((subtask) => subtask.status), ["todo", "todo"]);
      assert.equal(
        readVault("acme.md"),
        [
          ...OPEN_HEAD,
          "- [ ] Weekly report #p1 🔁 every week 🛫 2026-10-27 📅 2026-10-30",
          "  - [ ] Collect numbers",
          "  - [ ] Write summary",
          "    - [ ] Review",
          "  - a note",
          ...RULES,
          "",
          "## Done loops",
          "",
          `- [x] Weekly report #p1 🔁 every week 🛫 2026-10-20 📅 2026-10-23${stamp()}`,
          "  - [x] Collect numbers",
          "  - [x] Write summary",
          "    - [x] Review",
          "  - a note",
          "- [x] Old win ✅ 2026-01-02",
          "",
        ].join("\n"),
      );
      const copy = await find("Weekly report", "done");
      assert.deepEqual([copy.status, copy.doneAt, copy.due, copy.repeat], ["done", today(), "2026-10-23", "every week"]);
    });

    it("advances every rule kind, including month ends, leap days and weekdays", async () => {
      const cases: [string, string][] = [
        ["Month end", "- [ ] Month end 🔁 every month 📅 2026-02-28"],
        ["Leap", "- [ ] Leap 🔁 every year 📅 2025-02-28"],
        ["Biweekly", "- [ ] Biweekly 🔁 every 2 weeks ⏳ 2027-01-08"],
        ["Standup", "- [ ] Standup 🔁 every day 📅 2027-01-01"],
        ["Quarterly", "- [ ] Quarterly 🔁 every 3 months 📅 2027-02-28"],
        ["Workday", "- [ ] Workday 🔁 every weekday 📅 2026-11-02"],
        ["Weekend", "- [ ] Weekend 🔁 every weekday 🛫 2026-11-02"],
        ["Odd rule", "- [ ] Odd rule 🔁 every week when done 📅 2026-10-23"],
        ["No dates", "- [ ] No dates 🔁 every week"],
      ];
      for (const [title, reopened] of cases) {
        const original = await find(title);
        const res = await patch(original, { status: "done" });
        assert.equal(res.status, 200, title);
        assert.equal(res.json.recurred, true, title);
        assert.equal((res.json.task as WireTask).raw, reopened, title);
        const copy = await find(title, "done");
        assert.equal(copy.raw, `${original.raw.replace("- [ ]", "- [x]")}${stamp()}`, title);
      }
      const content = readVault("acme.md");
      assert.equal(content.split("\n").filter((line) => line.startsWith("- [x]")).length, cases.length + 1);
    });

    it("treats a recurring subtask like any subtask and reports recurred false on plain writes", async () => {
      const child = await patch(await find("Recurring child"), { status: "done" });
      assert.equal(child.status, 200);
      assert.equal(child.json.recurred, false);
      assert.equal((child.json.task as WireTask).raw, "  - [x] Recurring child 🔁 every week 📅 2026-10-23");
      assert.equal(readVault("acme.md"), ACME.replace("  - [ ] Recurring child", "  - [x] Recurring child"));
      const normal = await patch(await find("Normal task"), { status: "doing" });
      assert.equal(normal.json.recurred, false);
    });

    it("inserts the copy right after the original when no done section is configured", async () => {
      assert.equal((await settings({ tasks: { doneSection: "" } })).status, 200);
      const res = await patch(await find("Weekly report"), { status: "done" });
      assert.equal(res.status, 200);
      assert.equal(res.json.recurred, true);
      assert.equal((res.json.task as WireTask).line, 6);
      assert.equal(
        readVault("acme.md"),
        [
          ...OPEN_HEAD,
          "- [ ] Weekly report #p1 🔁 every week 🛫 2026-10-27 📅 2026-10-30",
          "  - [ ] Collect numbers",
          "  - [ ] Write summary",
          "    - [ ] Review",
          "  - a note",
          `- [x] Weekly report #p1 🔁 every week 🛫 2026-10-20 📅 2026-10-23${stamp()}`,
          "  - [x] Collect numbers",
          "  - [x] Write summary",
          "    - [x] Review",
          "  - a note",
          ...RULES,
          ...DONE_TAIL,
        ].join("\n"),
      );
      const copy = (await board()).find((task) => task.title === "Weekly report" && task.status === "done");
      assert.ok(copy);
      assert.equal(copy.doneAt, today());
    });
  });

  describe("sweep-done", () => {
    it("recurs a recurring task completed by hand and moves already stamped occurrences like any done task", async () => {
      writeVault(
        "acme.md",
        [
          ...OPEN_HEAD,
          "- [x] Weekly report #p1 🔁 every week 🛫 2026-10-20 📅 2026-10-23",
          "  - [ ] Collect numbers",
          "- [x] Plugin done 🔁 every week 📅 2026-10-23 ✅ 2026-10-22",
          "- [ ] Plugin done 🔁 every week 📅 2026-10-30",
          "- [x] Finished plain",
          ...DONE_TAIL,
        ].join("\n"),
      );
      const res = await http("POST", "/delegation/tasks-board/sweep-done", {});
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { moved: 3, projects: ["acme"] });
      const content = readVault("acme.md");
      assert.ok(content.startsWith([...OPEN_HEAD, "- [ ] Weekly report #p1 🔁 every week 🛫 2026-10-27 📅 2026-10-30", "  - [ ] Collect numbers", "- [ ] Plugin done 🔁 every week 📅 2026-10-30", "", "## Done loops", ""].join("\n")), content);
      const done = content.split("## Done loops\n\n")[1] as string;
      const doneLines = done.split("\n").filter((line) => line !== "");
      assert.equal(doneLines.length, 5);
      assert.ok(doneLines.includes(`- [x] Weekly report #p1 🔁 every week 🛫 2026-10-20 📅 2026-10-23${stamp()}`));
      assert.ok(doneLines.includes("  - [x] Collect numbers"));
      assert.ok(!doneLines.includes("  - [ ] Collect numbers"));
      assert.ok(doneLines.includes("- [x] Plugin done 🔁 every week 📅 2026-10-23 ✅ 2026-10-22"));
      assert.ok(doneLines.includes(`- [x] Finished plain${stamp()}`));
      assert.equal(doneLines[doneLines.length - 1], "- [x] Old win ✅ 2026-01-02");
      const again = await http("POST", "/delegation/tasks-board/sweep-done", {});
      assert.deepEqual(again.json, { moved: 0, projects: [] });
    });

    it("leaves a hand-completed recurring task in place when a subtask write finishes it", async () => {
      const head = "- [x] Weekly report #p1 🔁 every week 🛫 2026-10-20 📅 2026-10-23";
      writeVault("acme.md", [...OPEN_HEAD, head, "  - [ ] Collect numbers", ...DONE_TAIL].join("\n"));
      const res = await patch(await find("Collect numbers"), { status: "done" });
      assert.equal(res.status, 200);
      assert.deepEqual([res.json.moved, res.json.recurred], [false, false]);
      assert.equal(readVault("acme.md"), [...OPEN_HEAD, head, "  - [x] Collect numbers", ...DONE_TAIL].join("\n"));
    });

    it("skips a recurring task it cannot rewrite and still sweeps the others", async () => {
      writeVault("acme.md", [...OPEN_HEAD, "- [x] Clash 🔁 every week 📅 2026-10-23 📅 2026-10-24", "- [x] Finished plain", ...DONE_TAIL].join("\n"));
      const res = await http("POST", "/delegation/tasks-board/sweep-done", {});
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { moved: 1, projects: ["acme"] });
      const content = readVault("acme.md");
      assert.ok(content.includes("\n- [x] Clash 🔁 every week 📅 2026-10-23 📅 2026-10-24\n\n## Done loops\n"), content);
      assert.ok(content.includes(`\n- [x] Finished plain${stamp()}\n`), content);
    });
  });

  describe("daily links", () => {
    it("completes a recurring task from today's daily once and keeps the daily line done", async () => {
      const before = focus("- [ ] [[acme|Acme Corp]] - Weekly report", "  - [x] Collect numbers", "  - [-] Write summary");
      const afterSave = focus("- [x] [[acme|Acme Corp]] - Weekly report", "  - [x] Collect numbers", "  - [x] Write summary");
      writeDailyFile(today(), before);
      const res = await putDaily(today(), afterSave);
      assert.equal(res.status, 200);
      const content = readVault("acme.md");
      assert.equal(content.match(/Weekly report/g)?.length, 2);
      assert.ok(content.includes("\n- [ ] Weekly report #p1 🔁 every week 🛫 2026-10-27 📅 2026-10-30\n  - [ ] Collect numbers\n  - [ ] Write summary\n"));
      assert.ok(content.includes(`\n- [x] Weekly report #p1 🔁 every week 🛫 2026-10-20 📅 2026-10-23${stamp()}\n`));
      assert.equal(readDailyFile(today()), afterSave);
      const original = await find("Weekly report");
      const todayBlock = (await boardPayload()).today as WireToday;
      assert.ok(todayBlock.taskIds.includes(original.id));
      assert.deepEqual(todayBlock.mismatch, []);
      const links = await http("GET", "/delegation/tasks-board/daily-links");
      const item = (links.json.items as WireLinkItem[])[0] as WireLinkItem;
      assert.equal(item.taskId, original.id);
      assert.equal(item.mismatch, false);
    });

    it("writes [x] only on the daily item line after a recurrence from the board and leaves its nested lines alone", async () => {
      const daily = focus("- [ ] [[acme|Acme Corp]] - Weekly report", "  - [x] Collect numbers", "  - [ ] Write summary", "- [ ] [[acme|Acme Corp]] - Normal task");
      writeDailyFile(today(), daily);
      const res = await patch(await find("Weekly report"), { status: "done" });
      assert.equal(res.status, 200);
      assert.equal(res.json.recurred, true);
      assert.equal(res.json.dailySynced, true);
      const marked = focus("- [x] [[acme|Acme Corp]] - Weekly report", "  - [x] Collect numbers", "  - [ ] Write summary", "- [ ] [[acme|Acme Corp]] - Normal task");
      assert.equal(readDailyFile(today()), marked);
      const todayBlock = (await boardPayload()).today as WireToday;
      assert.deepEqual(todayBlock.mismatch, []);
      const sync = await http("POST", "/delegation/tasks-board/sync-daily", { projectId: "acme", line: (res.json.task as WireTask).line, raw: (res.json.task as WireTask).raw });
      assert.deepEqual(sync.json, { date: today(), updated: 0 });
      assert.equal(readDailyFile(today()), marked);
    });

    it("leaves a recurring item out of sync checks on the daily of its copy and on any other day", async () => {
      writeDailyFile(today(), focus("- [ ] [[acme|Acme Corp]] - Weekly report"));
      writeDailyFile(OTHER_DATE, focus("- [x] [[acme|Acme Corp]] - Weekly report"));
      const res = await patch(await find("Weekly report"), { status: "done" });
      assert.equal(res.status, 200);
      writeDailyFile(today(), focus("- [ ] [[acme|Acme Corp]] - Weekly report"));
      const original = await find("Weekly report");
      const todayBlock = (await boardPayload()).today as WireToday;
      assert.deepEqual(todayBlock.mismatch, []);
      const todayItem = ((await http("GET", "/delegation/tasks-board/daily-links")).json.items as WireLinkItem[])[0] as WireLinkItem;
      assert.equal(todayItem.taskId, original.id);
      assert.equal(todayItem.mismatch, false);
      assert.equal(todayItem.recurredToday, true);
      const otherItem = ((await http("GET", `/delegation/tasks-board/daily-links?date=${OTHER_DATE}`)).json.items as WireLinkItem[])[0] as WireLinkItem;
      assert.equal(otherItem.taskId, original.id);
      assert.equal(otherItem.mismatch, false);
      assert.equal(otherItem.recurredToday, false);
    });
  });

  describe("finished occurrences", () => {
    const OCCURRENCE = "this is a finished occurrence of a recurring task - edit it in Obsidian";

    it("refuses every status change on a done copy and on its subtasks and writes nothing", async () => {
      assert.equal((await patch(await find("Weekly report"), { status: "done" })).status, 200);
      const written = readVault("acme.md");
      const copy = await find("Weekly report", "done");
      for (const status of ["todo", "doing", "done", "blocked", "hold", "archived"]) {
        const res = await patch(copy, { status });
        assert.equal(res.status, 400, status);
        assert.equal(res.json.error, OCCURRENCE, status);
      }
      for (const nested of flat(copy.subtasks)) {
        const res = await patch(nested, { status: "todo" });
        assert.equal(res.status, 400, nested.title);
        assert.equal(res.json.error, OCCURRENCE, nested.title);
      }
      assert.equal(readVault("acme.md"), written);
    });

    it("refuses a status change on a copy made in Obsidian instead of moving it back to Open loops", async () => {
      const handmade = [...OPEN_HEAD, "- [ ] Plain open", "", "## Done loops", "", "- [x] Plugin done 🔁 every week 📅 2026-10-23 ✅ 2026-10-22", "  - [x] Step", ""].join("\n");
      writeVault("acme.md", handmade);
      const res = await patch(await find("Plugin done", "done"), { status: "todo" });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, OCCURRENCE);
      const step = await patch(await find("Step", "done"), { status: "doing" });
      assert.equal(step.status, 400);
      assert.equal(readVault("acme.md"), handmade);
    });

    it("refuses status changes on the copy left after the original when no done section is configured", async () => {
      assert.equal((await settings({ tasks: { doneSection: "" } })).status, 200);
      assert.equal((await patch(await find("Weekly report"), { status: "done" })).status, 200);
      const written = readVault("acme.md");
      const copy = (await board()).find((task) => task.title === "Weekly report" && task.doneAt !== null);
      assert.ok(copy);
      const res = await patch(copy, { status: "todo" });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, OCCURRENCE);
      const child = await patch(copy.subtasks[0] as WireTask, { status: "todo" });
      assert.equal(child.status, 400);
      assert.equal(readVault("acme.md"), written);
    });

    it("refuses title and priority edits on a copy and writes nothing", async () => {
      assert.equal((await patch(await find("Weekly report"), { status: "done" })).status, 200);
      const written = readVault("acme.md");
      const copy = await find("Weekly report", "done");
      const renamed = await patch(copy, { title: "Weekly report (sent)" });
      assert.equal(renamed.status, 400);
      assert.equal(renamed.json.error, OCCURRENCE);
      const prioritized = await patch(copy, { priority: 2 });
      assert.equal(prioritized.status, 400);
      assert.equal(prioritized.json.error, OCCURRENCE);
      assert.equal(readVault("acme.md"), written);
      assert.ok(written.includes("\n- [ ] Weekly report #p1 🔁 every week 🛫 2026-10-27 📅 2026-10-30\n"));
    });

    it("never sweeps a copy", async () => {
      assert.equal((await patch(await find("Weekly report"), { status: "done" })).status, 200);
      const written = readVault("acme.md");
      const res = await http("POST", "/delegation/tasks-board/sweep-done", {});
      assert.deepEqual(res.json, { moved: 0, projects: [] });
      assert.equal(readVault("acme.md"), written);
    });
  });
});
