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
  reason: string | null;
  status: string;
  priority: number | null;
  doneAt: string | null;
  start: string | null;
  scheduled: string | null;
  due: string | null;
  repeat: string | null;
  subtasks: WireTask[];
}

const ACME_LINES = [
  "---",
  "title: Acme Corp",
  "---",
  "",
  "## Open loops",
  "",
  "- [ ] Plan launch 🛫 2026-11-02 ⏳ 2026-11-03 📅 2026-11-05",
  "- [ ] Glued📅2026-11-09 #p2",
  "- [ ] Middle 📅 2026-11-11 words #p1 🔁 every week",
  "- [ ] Code `📅 2026-11-12` kept",
  "- [ ] BLOCK - Vendor audit 📅 2026-11-13 - waiting vendor",
  "- [-] Weekly sync 🔁every 2 weeks🛫2026-11-02",
  "- [ ] Bad date 📅 2026-02-30",
  "- [ ] Conflict 📅 2026-11-01 📅 2026-11-02",
  "- [ ] Variation 📅️ 2026-11-14 ⏳️2026-11-15",
  "- [ ] Parent plain",
  "  - [ ] Child dated 📅 2026-11-20 🔁 every month",
  "- [ ] Plain task",
  "",
  "## Done loops",
  "",
  "- [x] Shipped 📅 2026-10-01 ✅ 2026-10-02",
  "- [x] Reverse ✅ 2026-10-03 📅 2026-10-01",
  "",
];

const ACME = ACME_LINES.join("\n");

describe("task dates and repeat signifiers", () => {
  const box: Sandbox = makeSandbox("cch-tasks-dates-");
  const vault = join(box.tmp, "vault");
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

  const flat = (tasks: WireTask[]): WireTask[] => tasks.flatMap((task) => [task, ...flat(task.subtasks)]);
  const readVault = (rel: string): string => readFileSync(join(vault, rel), "utf8");
  const writeVault = (rel: string, content: string): void => {
    const full = join(vault, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const board = async (): Promise<WireTask[]> => flat((await http("GET", "/delegation/tasks-board")).json.tasks as WireTask[]);
  const find = async (title: string, projectId = "acme"): Promise<WireTask> => {
    const found = (await board()).find((task) => task.projectId === projectId && task.title === title);
    assert.ok(found, `${projectId} ${title}`);
    return found;
  };
  const patch = (task: WireTask, change: Record<string, unknown>): Promise<HttpResult> =>
    http("PATCH", "/delegation/tasks-board/item", { projectId: task.projectId, line: task.line, raw: task.raw, ...change });
  const withLine = (index: number, text: string, lines: string[] = ACME_LINES): string => {
    const copy = [...lines];
    copy[index] = text;
    return copy.join("\n");
  };
  const lineOf = (text: string): number => ACME_LINES.indexOf(text);

  before(async () => {
    writeVault("acme.md", ACME);
    hub = await startServer(box, { HUB_DELEGATION: "1" });
    const res = await http("PUT", "/delegation/settings", {
      workspacesRoot: box.root,
      secondBrainRoot: box.brain,
      features: { tasks: true },
      tasks: { root: vault, doneSection: "Done loops" },
    });
    assert.equal(res.status, 200);
  });

  beforeEach(() => {
    writeVault("acme.md", ACME);
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("parsing", () => {
    it("reads each signifier anywhere after the title, glued or spaced, and strips it from the title", async () => {
      const plan = await find("Plan launch");
      assert.deepEqual([plan.start, plan.scheduled, plan.due, plan.repeat], ["2026-11-02", "2026-11-03", "2026-11-05", null]);
      const glued = await find("Glued");
      assert.deepEqual([glued.due, glued.priority], ["2026-11-09", 2]);
      const middle = await find("Middle words");
      assert.deepEqual([middle.due, middle.priority, middle.repeat], ["2026-11-11", 1, "every week"]);
      const weekly = await find("Weekly sync");
      assert.deepEqual([weekly.repeat, weekly.start, weekly.status], ["every 2 weeks", "2026-11-02", "doing"]);
      const variation = await find("Variation");
      assert.deepEqual([variation.due, variation.scheduled], ["2026-11-14", "2026-11-15"]);
      const plain = await find("Plain task");
      assert.deepEqual([plain.start, plain.scheduled, plain.due, plain.repeat], [null, null, null, null]);
    });

    it("ignores signifiers inside inline code and keeps invalid dates in the title", async () => {
      const code = await find("Code `📅 2026-11-12` kept");
      assert.equal(code.due, null);
      const bad = await find("Bad date 📅 2026-02-30");
      assert.equal(bad.due, null);
    });

    it("works with the reason, the priority tag, the done stamp and subtasks", async () => {
      const vendor = await find("Vendor audit");
      assert.deepEqual([vendor.status, vendor.reason, vendor.due], ["blocked", "waiting vendor", "2026-11-13"]);
      const shipped = await find("Shipped");
      assert.deepEqual([shipped.due, shipped.doneAt], ["2026-10-01", "2026-10-02"]);
      const reverse = await find("Reverse");
      assert.deepEqual([reverse.due, reverse.doneAt], ["2026-10-01", "2026-10-03"]);
      const child = await find("Child dated");
      assert.deepEqual([child.due, child.repeat], ["2026-11-20", "every month"]);
      const conflict = await find("Conflict");
      assert.equal(conflict.due, "2026-11-01");
    });
  });

  describe("rewrites keep the signifiers in canonical order", () => {
    it("title, status, priority and reason writes keep every signifier and touch only that line", async () => {
      const title = await patch(await find("Plan launch"), { title: "Kickoff" });
      assert.equal(title.status, 200);
      assert.equal((title.json.task as WireTask).raw, "- [ ] Kickoff 🛫 2026-11-02 ⏳ 2026-11-03 📅 2026-11-05");
      assert.equal(readVault("acme.md"), withLine(lineOf("- [ ] Plan launch 🛫 2026-11-02 ⏳ 2026-11-03 📅 2026-11-05"), "- [ ] Kickoff 🛫 2026-11-02 ⏳ 2026-11-03 📅 2026-11-05"));

      writeVault("acme.md", ACME);
      const priority = await patch(await find("Middle words"), { priority: 0 });
      assert.equal((priority.json.task as WireTask).raw, "- [ ] Middle words #p0 🔁 every week 📅 2026-11-11");

      const status = await patch(await find("Glued"), { status: "doing" });
      assert.equal((status.json.task as WireTask).raw, "- [-] Glued #p2 📅 2026-11-09");

      const glued = await find("Weekly sync");
      const hold = await patch(glued, { status: "hold", reason: "waiting" });
      assert.equal(hold.status, 200);
      assert.equal((hold.json.task as WireTask).raw, "- [-] HOLD - Weekly sync - waiting 🔁 every 2 weeks 🛫 2026-11-02");

      const vendor = await patch(await find("Vendor audit"), { reason: "new reason" });
      assert.equal((vendor.json.task as WireTask).raw, "- [ ] BLOCK - Vendor audit - new reason 📅 2026-11-13");
    });

    it("keeps the done stamp last on done-section rewrites", async () => {
      const reverse = await patch(await find("Reverse"), { priority: 1 });
      assert.equal(reverse.status, 200);
      assert.equal((reverse.json.task as WireTask).raw, "- [x] Reverse #p1 📅 2026-10-01 ✅ 2026-10-03");
      const shipped = await patch(await find("Shipped"), { due: "2026-09-30" });
      assert.equal((shipped.json.task as WireTask).raw, "- [x] Shipped 📅 2026-09-30 ✅ 2026-10-02");
    });

    it("refuses to rewrite a line with two different values for the same signifier", async () => {
      const res = await patch(await find("Conflict"), { status: "doing" });
      assert.equal(res.status, 400);
      assert.match(String(res.json.error), /due/);
      assert.equal(readVault("acme.md"), ACME);
    });
  });

  describe("PATCH dates and repeat", () => {
    it("sets, replaces and clears start, scheduled, due and repeat", async () => {
      const glued = await find("Glued");
      const due = await patch(glued, { due: "2026-12-01" });
      assert.equal(due.status, 200);
      const dueTask = due.json.task as WireTask;
      assert.equal(dueTask.raw, "- [ ] Glued #p2 📅 2026-12-01");
      assert.equal(dueTask.due, "2026-12-01");
      const both = await patch(dueTask, { start: "2026-11-20", repeat: "every month", scheduled: "2026-11-21" });
      const bothTask = both.json.task as WireTask;
      assert.equal(bothTask.raw, "- [ ] Glued #p2 🔁 every month 🛫 2026-11-20 ⏳ 2026-11-21 📅 2026-12-01");
      assert.deepEqual([bothTask.start, bothTask.scheduled, bothTask.due, bothTask.repeat], ["2026-11-20", "2026-11-21", "2026-12-01", "every month"]);
      const cleared = await patch(bothTask, { due: null, repeat: "  ", scheduled: null });
      assert.equal((cleared.json.task as WireTask).raw, "- [ ] Glued #p2 🛫 2026-11-20");
      assert.equal(readVault("acme.md"), withLine(lineOf("- [ ] Glued📅2026-11-09 #p2"), "- [ ] Glued #p2 🛫 2026-11-20"));
      const subtask = await patch(await find("Child dated"), { due: "2026-11-21" });
      assert.equal((subtask.json.task as WireTask).raw, "  - [ ] Child dated 🔁 every month 📅 2026-11-21");
    });

    it("answers 400 on invalid dates or repeat values and writes nothing", async () => {
      const plain = await find("Plain task");
      const bad: Record<string, unknown>[] = [
        { due: "2026-02-30" },
        { due: "2026-1-01" },
        { start: 20261101 },
        { scheduled: "tomorrow" },
        { due: "" },
        { repeat: "every\nweek" },
        { repeat: 5 },
        { repeat: "every week 📅 2026-01-01" },
      ];
      for (const change of bad) {
        const res = await patch(plain, change);
        assert.equal(res.status, 400, JSON.stringify(change));
        const field = Object.keys(change)[0] as string;
        assert.match(String(res.json.error), new RegExp(field), JSON.stringify(change));
      }
      const title = await patch(plain, { title: "Sneaky 📅 2026-01-01" });
      assert.equal(title.status, 400);
      const empty = await patch(plain, {});
      assert.equal(empty.status, 400);
      assert.match(String(empty.json.error), /due/);
      assert.equal(readVault("acme.md"), ACME);
    });

    it("keeps CRLF line endings", async () => {
      writeVault("acme.md", ACME.replace(/\n/g, "\r\n"));
      const res = await patch(await find("Plain task"), { due: "2026-12-24" });
      assert.equal(res.status, 200);
      assert.equal(readVault("acme.md"), withLine(lineOf("- [ ] Plain task"), "- [ ] Plain task 📅 2026-12-24").replace(/\n/g, "\r\n"));
    });
  });

  describe("POST item", () => {
    it("creates a task with dates, repeat and priority in canonical order", async () => {
      const res = await http("POST", "/delegation/tasks-board/item", {
        projectId: "acme",
        title: "New thing",
        priority: 1,
        due: "2026-12-24",
        start: "2026-12-20",
        repeat: "every year",
      });
      assert.equal(res.status, 201);
      const task = res.json.task as WireTask;
      assert.equal(task.raw, "- [ ] New thing #p1 🔁 every year 🛫 2026-12-20 📅 2026-12-24");
      assert.deepEqual([task.start, task.due, task.repeat, task.scheduled], ["2026-12-20", "2026-12-24", "every year", null]);
      const child = await http("POST", "/delegation/tasks-board/item", {
        projectId: "acme",
        title: "Sub",
        parentLine: task.line,
        parentRaw: task.raw,
        scheduled: "2026-12-21",
      });
      assert.equal(child.status, 201);
      assert.equal((child.json.task as WireTask).raw, "  - [ ] Sub ⏳ 2026-12-21");
    });

    it("answers 400 on invalid dates and writes nothing", async () => {
      for (const change of [{ due: "2026-13-01" }, { repeat: "a\nb" }, { start: false }]) {
        const res = await http("POST", "/delegation/tasks-board/item", { projectId: "acme", title: "Nope", ...change });
        assert.equal(res.status, 400, JSON.stringify(change));
      }
      assert.equal(readVault("acme.md"), ACME);
    });
  });
});
