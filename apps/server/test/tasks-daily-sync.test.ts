import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  subtasks: WireTask[];
}

interface WireToday {
  date: string;
  exists: boolean;
  taskIds: string[];
  states: Record<string, string>;
  mismatch: string[];
}

const ACME = [
  "---",
  "title: Acme Corp",
  "---",
  "",
  "## Open loops",
  "",
  "- [ ] Renew contract #p0",
  "  - [x] Draft terms",
  "  - [-] Legal sign-off",
  "    - [ ] Counsel review",
  "  - plain note",
  "- [ ] Hire designer",
  "- [ ] BLOCK - Vendor audit - waiting vendor",
  "- [-] HOLD - Office move",
  "",
  "## Done loops",
  "",
  "- [x] Old win ✅ 2026-01-02",
  "",
].join("\n");

const VAULT: Record<string, string> = {
  "acme.md": ACME,
  "globex.md": "---\ntitle: Globex\n---\n\n## Open loops\n\n- [ ] Rollout checklist\n",
  "hooli.md": "## Open loops\n\n- [ ] Index rebuild\n",
  "initech.md": "# Initech\n\n## Open loops\n\n- [ ] Pilot validation\n",
  "umbrella.md": "---\ntitle: Umbrella\n---\n\n## Open loops\n\n- [ ] Vaccine stock\n",
};

const ADD_DATE = "2026-04-02";
const OTHER_DATE = "2026-04-03";

describe("daily and tasks sync", () => {
  const box: Sandbox = makeSandbox("cch-tasks-sync-");
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
  const tomorrow = (): string => {
    const now = new Date();
    return dateOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  };
  const flat = (tasks: WireTask[]): WireTask[] => tasks.flatMap((task) => [task, ...flat(task.subtasks)]);
  const dailyPath = (date: string): string => join(dailyDir, `${date}.md`);
  const writeDailyFile = (date: string, content: string): void => {
    mkdirSync(dailyDir, { recursive: true });
    writeFileSync(dailyPath(date), content);
  };
  const readDailyFile = (date: string): string => readFileSync(dailyPath(date), "utf8");
  const readVault = (rel: string): string => readFileSync(join(vault, rel), "utf8");
  const settings = async (patch: Record<string, unknown>): Promise<HttpResult> => http("PUT", "/delegation/settings", patch);
  const boardPayload = async (): Promise<Record<string, unknown>> => (await http("GET", "/delegation/tasks-board")).json;
  const board = async (): Promise<WireTask[]> => flat((await boardPayload()).tasks as WireTask[]);
  const find = async (projectId: string, title: string): Promise<WireTask> => {
    const found = (await board()).find((task) => task.projectId === projectId && task.title === title);
    assert.ok(found, `${projectId} ${title}`);
    return found;
  };
  const addToDaily = (task: WireTask, date: string = ADD_DATE): Promise<HttpResult> =>
    http("POST", "/delegation/tasks-board/add-to-daily", { projectId: task.projectId, line: task.line, raw: task.raw, date });
  const patch = (task: WireTask, change: Record<string, unknown>): Promise<HttpResult> =>
    http("PATCH", "/delegation/tasks-board/item", { projectId: task.projectId, line: task.line, raw: task.raw, ...change });
  const syncDaily = (task: WireTask, extra: Record<string, unknown> = {}): Promise<HttpResult> =>
    http("POST", "/delegation/tasks-board/sync-daily", { projectId: task.projectId, line: task.line, raw: task.raw, ...extra });
  const putDaily = async (date: string, content: string): Promise<HttpResult> => {
    const current = await http("GET", `/delegation/daily/${date}`);
    return http("PUT", `/delegation/daily/${date}`, { content, baseUpdatedAt: current.json.updatedAt });
  };
  const resetVault = (): void => {
    for (const [rel, content] of Object.entries(VAULT)) {
      const full = join(vault, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  };
  const focus = (...lines: string[]): string => ["## Foco de hoje", "", ...lines, "", "## Reuniões", "", "-", ""].join("\n");

  before(async () => {
    resetVault();
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
    resetVault();
    assert.equal((await settings({ daily: { wikilinks: true, projectOrder: [] } })).status, 200);
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  describe("label", () => {
    it("always writes [[name|Title]] with wikilinks, even when the title equals the name ignoring case, and the title without", async () => {
      writeDailyFile(ADD_DATE, "## Foco de hoje\n\n- [ ]\n\n## Reuniões\n");
      const globex = await addToDaily(await find("globex", "Rollout checklist"));
      assert.equal(globex.status, 201);
      assert.equal(globex.json.raw, "- [ ] [[globex|Globex]] - Rollout checklist");
      const hooli = await addToDaily(await find("hooli", "Index rebuild"));
      assert.equal(hooli.json.raw, "- [ ] [[hooli|hooli]] - Index rebuild");
      assert.equal((await settings({ daily: { wikilinks: false } })).status, 200);
      const initech = await addToDaily(await find("initech", "Pilot validation"));
      assert.equal(initech.json.raw, "- [ ] Initech - Pilot validation");
      assert.equal(
        readDailyFile(ADD_DATE),
        "## Foco de hoje\n\n- [ ] [[globex|Globex]] - Rollout checklist\n\n- [ ] [[hooli|hooli]] - Index rebuild\n\n- [ ] Initech - Pilot validation\n\n## Reuniões\n",
      );
    });
  });

  describe("project order setting", () => {
    it("defaults to an empty list, validates an array of ids and round-trips it without duplicates", async () => {
      const current = (await http("GET", "/delegation/settings")).json.daily as Record<string, unknown>;
      assert.deepEqual(current.projectOrder, []);
      const saved = await settings({ daily: { projectOrder: ["umbrella", "ghost", " acme ", "umbrella"] } });
      assert.equal(saved.status, 200);
      assert.deepEqual((saved.json.daily as Record<string, unknown>).projectOrder, ["umbrella", "ghost", "acme"]);
      assert.deepEqual(((await http("GET", "/delegation/settings")).json.daily as Record<string, unknown>).projectOrder, ["umbrella", "ghost", "acme"]);
      for (const bad of ["acme", [1], [""], ["a\nb"], null, { acme: 1 }]) {
        const res = await settings({ daily: { projectOrder: bad } });
        assert.equal(res.status, 400, JSON.stringify(bad));
        assert.match(String(res.json.error), /daily\.projectOrder/);
      }
      assert.deepEqual(((await http("GET", "/delegation/settings")).json.daily as Record<string, unknown>).projectOrder, ["umbrella", "ghost", "acme"]);
    });

    it("places a new group by the effective order: listed ids first, then the tree order, unknown ids ignored", async () => {
      const base = focus("- [ ] [[acme|Acme Corp]] - Hire designer", "", "- [ ] [[initech|Initech]] - Pilot validation");
      writeDailyFile(ADD_DATE, base);
      assert.equal((await settings({ daily: { projectOrder: ["ghost", "umbrella"] } })).status, 200);
      assert.equal((await addToDaily(await find("umbrella", "Vaccine stock"))).status, 201);
      assert.equal(
        readDailyFile(ADD_DATE),
        focus("- [ ] [[umbrella|Umbrella]] - Vaccine stock", "", "- [ ] [[acme|Acme Corp]] - Hire designer", "", "- [ ] [[initech|Initech]] - Pilot validation"),
      );
      writeDailyFile(ADD_DATE, base);
      assert.equal((await settings({ daily: { projectOrder: ["initech"] } })).status, 200);
      assert.equal((await addToDaily(await find("globex", "Rollout checklist"))).status, 201);
      assert.equal(
        readDailyFile(ADD_DATE),
        focus("- [ ] [[acme|Acme Corp]] - Hire designer", "", "- [ ] [[initech|Initech]] - Pilot validation", "", "- [ ] [[globex|Globex]] - Rollout checklist"),
      );
    });
  });

  describe("placement", () => {
    const PLACE = [
      "# 2026-04-02",
      "",
      "## Foco de hoje",
      "",
      "- [ ] [[acme|Acme Corp]] - Hire designer",
      "  - [ ] call agency",
      "- [x] Acme Corp - Old thing",
      "  - [x] nested done",
      "",
      "- [ ] [[initech|Initech]] - Pilot validation",
      "",
      "- [ ] Loose unresolved item",
      "",
      "## Reuniões",
      "",
      "-",
      "",
    ];

    it("joins the last group of the same project after its nested lines without adding blank lines", async () => {
      writeDailyFile(ADD_DATE, PLACE.join("\n"));
      const res = await addToDaily(await find("acme", "Vendor audit"));
      assert.equal(res.status, 201);
      assert.equal(res.json.line, 8);
      assert.equal(res.json.raw, "- [ ] [[acme|Acme Corp]] - Vendor audit");
      const expected = [...PLACE];
      expected.splice(8, 0, "- [ ] [[acme|Acme Corp]] - Vendor audit");
      assert.equal(readDailyFile(ADD_DATE), expected.join("\n"));
    });

    it("opens a new group between groups by order and before unresolved groups, one blank line around it", async () => {
      writeDailyFile(ADD_DATE, PLACE.join("\n"));
      const globex = await addToDaily(await find("globex", "Rollout checklist"));
      assert.equal(globex.status, 201);
      assert.equal(globex.json.line, 9);
      const afterGlobex = [...PLACE];
      afterGlobex.splice(9, 0, "- [ ] [[globex|Globex]] - Rollout checklist", "");
      assert.equal(readDailyFile(ADD_DATE), afterGlobex.join("\n"));
      const umbrella = await addToDaily(await find("umbrella", "Vaccine stock"));
      assert.equal(umbrella.status, 201);
      const afterUmbrella = [...afterGlobex];
      afterUmbrella.splice(13, 0, "- [ ] [[umbrella|Umbrella]] - Vaccine stock", "");
      assert.equal(readDailyFile(ADD_DATE), afterUmbrella.join("\n"));
      assert.equal(umbrella.json.line, 13);
    });

    it("separates glued groups, collapses a wide gap, keeps the heading spacing and goes first or last", async () => {
      writeDailyFile(ADD_DATE, "## Foco de hoje\n- [ ] [[acme|Acme Corp]] - Hire designer\n- [ ] [[initech|Initech]] - Pilot validation\n## Reuniões\n");
      assert.equal((await addToDaily(await find("globex", "Rollout checklist"))).status, 201);
      assert.equal(
        readDailyFile(ADD_DATE),
        "## Foco de hoje\n- [ ] [[acme|Acme Corp]] - Hire designer\n\n- [ ] [[globex|Globex]] - Rollout checklist\n\n- [ ] [[initech|Initech]] - Pilot validation\n## Reuniões\n",
      );
      assert.equal((await addToDaily(await find("umbrella", "Vaccine stock"))).status, 201);
      assert.equal(
        readDailyFile(ADD_DATE),
        "## Foco de hoje\n- [ ] [[acme|Acme Corp]] - Hire designer\n\n- [ ] [[globex|Globex]] - Rollout checklist\n\n- [ ] [[initech|Initech]] - Pilot validation\n\n- [ ] [[umbrella|Umbrella]] - Vaccine stock\n## Reuniões\n",
      );

      writeDailyFile(ADD_DATE, "## Foco de hoje\n\n- [ ] [[globex|Globex]] - Rollout checklist\n\n\n\n- [ ] [[initech|Initech]] - Pilot validation\n");
      assert.equal((await addToDaily(await find("acme", "Hire designer"))).status, 201);
      assert.equal((await addToDaily(await find("hooli", "Index rebuild"))).status, 201);
      assert.equal(
        readDailyFile(ADD_DATE),
        "## Foco de hoje\n\n- [ ] [[acme|Acme Corp]] - Hire designer\n\n- [ ] [[globex|Globex]] - Rollout checklist\n\n- [ ] [[hooli|hooli]] - Index rebuild\n\n- [ ] [[initech|Initech]] - Pilot validation\n",
      );
    });

    it("keeps CRLF and a missing final newline", async () => {
      writeDailyFile(ADD_DATE, "## Foco de hoje\r\n\r\n- [ ] [[acme|Acme Corp]] - Hire designer\r\n\r\n- [ ] [[initech|Initech]] - Pilot validation");
      assert.equal((await addToDaily(await find("globex", "Rollout checklist"))).status, 201);
      assert.equal((await addToDaily(await find("umbrella", "Vaccine stock"))).status, 201);
      assert.equal(
        readDailyFile(ADD_DATE),
        "## Foco de hoje\r\n\r\n- [ ] [[acme|Acme Corp]] - Hire designer\r\n\r\n- [ ] [[globex|Globex]] - Rollout checklist\r\n\r\n- [ ] [[initech|Initech]] - Pilot validation\r\n\r\n- [ ] [[umbrella|Umbrella]] - Vaccine stock",
      );
    });
  });

  describe("subtasks", () => {
    it("writes a top-level task with its nested subtasks and adds a subtask alone even when its parent is listed", async () => {
      writeDailyFile(ADD_DATE, "## Foco de hoje\n\n- [ ]\n\n## Reuniões\n");
      const renew = await find("acme", "Renew contract");
      const res = await addToDaily(renew);
      assert.equal(res.status, 201);
      assert.equal(res.json.line, 2);
      assert.equal(res.json.raw, "- [ ] [[acme|Acme Corp]] - Renew contract");
      assert.equal(res.json.subtasks, 3);
      const withTree = "## Foco de hoje\n\n- [ ] [[acme|Acme Corp]] - Renew contract\n  - [x] Draft terms\n  - [-] Legal sign-off\n    - [ ] Counsel review\n\n## Reuniões\n";
      assert.equal(readDailyFile(ADD_DATE), withTree);

      const legal = await addToDaily(await find("acme", "Legal sign-off"));
      assert.equal(legal.status, 201);
      assert.equal(legal.json.raw, "- [-] [[acme|Acme Corp]] - Legal sign-off");
      assert.equal(legal.json.line, 6);
      assert.equal(legal.json.subtasks, 0);
      const withLegal = withTree.replace("Counsel review\n", "Counsel review\n- [-] [[acme|Acme Corp]] - Legal sign-off\n");
      assert.equal(readDailyFile(ADD_DATE), withLegal);

      const again = await addToDaily(await find("acme", "Legal sign-off"));
      assert.equal(again.status, 409);
      assert.equal(again.json.error, "already in the daily");
      assert.equal((await addToDaily(await find("acme", "Renew contract"))).status, 409);
      assert.equal((await addToDaily(await find("acme", "Counsel review"))).status, 201);
      assert.equal(readDailyFile(ADD_DATE), withLegal.replace("Legal sign-off\n\n", "Legal sign-off\n- [ ] [[acme|Acme Corp]] - Counsel review\n\n"));
    });

    it("marks a done task and its done subtasks with [x]", async () => {
      writeDailyFile(ADD_DATE, "## Foco de hoje\n\n- [ ]\n");
      const old = await find("acme", "Old win");
      const res = await addToDaily(old);
      assert.equal(res.status, 201);
      assert.equal(readDailyFile(ADD_DATE), "## Foco de hoje\n\n- [x] [[acme|Acme Corp]] - Old win\n");
    });
  });

  describe("task to daily", () => {
    const TODAY_DAILY = [
      "## Foco de hoje",
      "",
      "- [ ] [[acme|Acme Corp]] - Renew contract",
      "  - [x] Draft terms",
      "  - [-] Legal sign-off",
      "    - [ ] Counsel review",
      "- [ ] [[acme|Acme Corp]] - Hire designer",
      "",
      "- [ ] [[globex|Globex]] - Rollout checklist",
      "",
      "## Reuniões",
      "",
    ].join("\r\n");

    it("updates the linked top-level and nested lines of today's daily on a status PATCH", async () => {
      writeDailyFile(today(), TODAY_DAILY);
      const hire = await patch(await find("acme", "Hire designer"), { status: "doing" });
      assert.equal(hire.status, 200);
      assert.equal(hire.json.dailySynced, true);
      let expected = TODAY_DAILY.replace("- [ ] [[acme|Acme Corp]] - Hire designer", "- [-] [[acme|Acme Corp]] - Hire designer");
      assert.equal(readDailyFile(today()), expected);

      const counsel = await patch(await find("acme", "Counsel review"), { status: "done" });
      assert.equal(counsel.status, 200);
      assert.equal(counsel.json.dailySynced, true);
      expected = expected.replace("    - [ ] Counsel review", "    - [x] Counsel review");
      assert.equal(readDailyFile(today()), expected);

      const priority = await patch(await find("acme", "Renew contract"), { priority: 2 });
      assert.equal(priority.status, 200);
      assert.equal(priority.json.dailySynced, false);
      const vendor = await patch(await find("acme", "Vendor audit"), { status: "hold" });
      assert.equal(vendor.status, 200);
      assert.equal(vendor.json.dailySynced, false);
      assert.equal(readDailyFile(today()), expected);

      const rollout = await patch(await find("globex", "Rollout checklist"), { status: "done" });
      assert.equal(rollout.status, 200);
      assert.equal(rollout.json.moved, true);
      assert.equal(rollout.json.dailySynced, true);
      expected = expected.replace("- [ ] [[globex|Globex]] - Rollout checklist", "- [x] [[globex|Globex]] - Rollout checklist");
      assert.equal(readDailyFile(today()), expected);
      const repeat = await patch(await find("globex", "Rollout checklist"), { status: "done" });
      assert.equal(repeat.status, 200);
      assert.equal(repeat.json.dailySynced, false);

      const archived = await patch(await find("acme", "Hire designer"), { status: "archived" });
      assert.equal(archived.json.dailySynced, true);
      assert.equal(readDailyFile(today()), expected.replace("- [-] [[acme|Acme Corp]] - Hire designer", "- [x] [[acme|Acme Corp]] - Hire designer"));
    });

    it("leaves other dates alone and does not fail the PATCH when the daily cannot be written", async () => {
      writeDailyFile(today(), TODAY_DAILY);
      writeDailyFile(OTHER_DATE, TODAY_DAILY);
      const path = dailyPath(today());
      chmodSync(path, 0o444);
      let res: HttpResult;
      try {
        res = await patch(await find("acme", "Hire designer"), { status: "doing" });
      } finally {
        chmodSync(path, 0o666);
      }
      assert.equal(res.status, 200);
      assert.equal(res.json.dailySynced, false);
      assert.equal((res.json.task as WireTask).status, "doing");
      assert.ok(readVault("acme.md").includes("\n- [-] Hire designer\n"));
      assert.equal(readDailyFile(today()), TODAY_DAILY);
      assert.equal(readDailyFile(OTHER_DATE), TODAY_DAILY);
    });

    it("syncs the daily when a delegation marks the task as doing", async () => {
      writeDailyFile(today(), TODAY_DAILY);
      const hire = await find("acme", "Hire designer");
      const res = await http("POST", "/delegation/tasks-board/delegate", { projectId: hire.projectId, line: hire.line, raw: hire.raw, workspace: "pilot", prompt: "do it" });
      assert.equal(res.status, 201);
      assert.equal((res.json.task as WireTask).status, "doing");
      assert.equal(readDailyFile(today()), TODAY_DAILY.replace("- [ ] [[acme|Acme Corp]] - Hire designer", "- [-] [[acme|Acme Corp]] - Hire designer"));
    });
  });

  describe("daily to tasks", () => {
    const BEFORE = focus(
      "- [ ] [[acme|Acme Corp]] - Renew contract",
      "  - [x] Draft terms",
      "  - [-] Legal sign-off",
      "    - [ ] Counsel review",
      "- [ ] [[acme|Acme Corp]] - Hire designer",
      "- [-] [[acme|Acme Corp]] - Office move",
      "- [x] [[acme|Acme Corp]] - Vendor audit",
      "",
      "- [ ] [[globex|Globex]] - Rollout checklist",
    );
    const AFTER = focus(
      "- [-] [[acme|Acme Corp]] - Renew contract",
      "  - [ ] Draft terms",
      "  - [-] Legal sign-off",
      "    - [x] Counsel review",
      "- [x] [[acme|Acme Corp]] - Hire designer",
      "- [ ] [[acme|Acme Corp]] - Office move",
      "- [ ] [[acme|Acme Corp]] - Vendor audit",
      "",
      "- [ ] [[globex|Globex]] - Rollout checklist",
    );

    it("applies changed checkboxes of today's daily to the linked tasks and subtasks", async () => {
      writeDailyFile(today(), BEFORE);
      const res = await putDaily(today(), AFTER);
      assert.equal(res.status, 200);
      assert.equal(res.json.date, today());
      assert.equal(readDailyFile(today()), AFTER);
      assert.equal(
        readVault("acme.md"),
        [
          "---",
          "title: Acme Corp",
          "---",
          "",
          "## Open loops",
          "",
          "- [-] Renew contract #p0",
          "  - [ ] Draft terms",
          "  - [-] Legal sign-off",
          "    - [x] Counsel review",
          "  - plain note",
          "- [ ] BLOCK - Vendor audit - waiting vendor",
          "- [-] HOLD - Office move",
          "",
          "## Done loops",
          "",
          `- [x] Hire designer ✅ ${today()}`,
          "- [x] Old win ✅ 2026-01-02",
          "",
        ].join("\n"),
      );
      assert.equal(readVault("globex.md"), VAULT["globex.md"]);
    });

    it("turns [ ] back into todo only for done or doing tasks", async () => {
      writeFileSync(join(vault, "acme.md"), ACME.replace("- [ ] Hire designer", "- [-] Hire designer"));
      writeDailyFile(today(), focus("- [x] [[acme|Acme Corp]] - Old win", "- [-] [[acme|Acme Corp]] - Office move", "- [-] [[acme|Acme Corp]] - Hire designer"));
      const res = await putDaily(today(), focus("- [ ] [[acme|Acme Corp]] - Old win", "- [ ] [[acme|Acme Corp]] - Office move", "- [ ] [[acme|Acme Corp]] - Hire designer"));
      assert.equal(res.status, 200);
      const acme = readVault("acme.md");
      assert.ok(acme.includes("\n- [-] HOLD - Office move\n"));
      assert.ok(acme.includes("\n- [ ] Hire designer\n"));
      assert.ok(acme.includes("\n- [ ] Old win\n"));
      assert.equal(acme.includes("Old win ✅"), false);
      assert.equal((await find("acme", "Old win")).status, "todo");
    });

    it("does nothing for another date", async () => {
      writeDailyFile(OTHER_DATE, BEFORE);
      const res = await putDaily(OTHER_DATE, AFTER);
      assert.equal(res.status, 200);
      assert.equal(readDailyFile(OTHER_DATE), AFTER);
      assert.equal(readVault("acme.md"), ACME);
    });

    it("syncs the tasks when close-yesterday writes today's diary", async () => {
      const content = focus("- [ ] [[acme|Acme Corp]] - Hire designer");
      writeDailyFile(today(), content);
      const res = await http("POST", `/delegation/daily/${tomorrow()}/close-yesterday`, { yesterday: today(), tasks: [{ line: 2, checked: true }] });
      assert.equal(res.status, 200);
      assert.ok(readDailyFile(today()).includes("- [x] [[acme|Acme Corp]] - Hire designer"));
      assert.equal((await find("acme", "Hire designer")).status, "done");
    });
  });

  describe("sync-daily route", () => {
    it("sets the linked lines of the task and its nested subtasks to the task state", async () => {
      const content = focus(
        "- [x] [[acme|Acme Corp]] - Renew contract",
        "  - [ ] Draft terms",
        "  - [x] Legal sign-off",
        "    - [-] Counsel review",
        "- [ ] [[acme|Acme Corp]] - Office move",
      );
      writeDailyFile(today(), content);
      const legal = await syncDaily(await find("acme", "Legal sign-off"));
      assert.equal(legal.status, 200);
      assert.deepEqual(legal.json, { date: today(), updated: 2 });
      const afterLegal = content.replace("  - [x] Legal sign-off", "  - [-] Legal sign-off").replace("    - [-] Counsel review", "    - [ ] Counsel review");
      assert.equal(readDailyFile(today()), afterLegal);
      const renew = await syncDaily(await find("acme", "Renew contract"));
      assert.equal(renew.status, 200);
      assert.deepEqual(renew.json, { date: today(), updated: 2 });
      assert.equal(readDailyFile(today()), afterLegal.replace("- [x] [[acme|Acme Corp]] - Renew contract", "- [ ] [[acme|Acme Corp]] - Renew contract").replace("  - [ ] Draft terms", "  - [x] Draft terms"));
      const again = await syncDaily(await find("acme", "Renew contract"));
      assert.deepEqual(again.json, { date: today(), updated: 0 });
      const office = await syncDaily(await find("acme", "Office move"));
      assert.deepEqual(office.json, { date: today(), updated: 0 });
    });

    it("answers 404 when the task is not in the daily, 409 on a stale raw and honours the date", async () => {
      writeDailyFile(today(), focus("- [ ] [[acme|Acme Corp]] - Renew contract"));
      const hire = await find("acme", "Hire designer");
      const missing = await syncDaily(hire);
      assert.equal(missing.status, 404);
      const stale = await syncDaily({ ...hire, raw: "- [ ] Hire designer edited" });
      assert.equal(stale.status, 409);
      assert.equal(stale.json.error, "changed on disk");
      assert.equal((await syncDaily(hire, { date: "2001-01-01" })).status, 404);
      assert.equal((await syncDaily(hire, { date: "nope" })).status, 400);
      writeDailyFile(OTHER_DATE, focus("- [x] [[acme|Acme Corp]] - Hire designer"));
      const dated = await syncDaily(hire, { date: OTHER_DATE });
      assert.equal(dated.status, 200);
      assert.deepEqual(dated.json, { date: OTHER_DATE, updated: 1 });
      assert.equal(readDailyFile(OTHER_DATE), focus("- [ ] [[acme|Acme Corp]] - Hire designer"));
      assert.equal((await settings({ features: { daily: false } })).status, 200);
      try {
        assert.equal((await syncDaily(hire, { date: OTHER_DATE })).status, 400);
      } finally {
        assert.equal((await settings({ features: { daily: true } })).status, 200);
      }
    });
  });

  describe("daily subtask sync", () => {
    interface WireChild {
      line: number;
      raw: string;
      checkbox: string;
      text: string;
      taskId: string | null;
      taskStatus: string | null;
      mismatch: boolean;
    }
    interface WireItem {
      line: number;
      taskId: string | null;
      children: WireChild[];
    }

    const DAILY = focus(
      "- [x] [[acme|Acme Corp]] - Renew contract",
      "  - [x] Draft terms",
      "  - [x] Legal sign-off",
      "    - [x] Counsel review",
      "  - [ ] Unknown step",
      "  - loose note",
      "- [-] [[acme|Acme Corp]] - Hire designer",
      "",
      "- [x] Loose unresolved item",
      "  - [x] Draft terms",
    );
    const fromDaily = (body: Record<string, unknown>): Promise<HttpResult> => http("POST", "/delegation/tasks-board/sync-from-daily", body);

    it("lists the nested task lines of each item with their matched subtasks", async () => {
      writeDailyFile(today(), DAILY);
      const links = await http("GET", "/delegation/tasks-board/daily-links");
      assert.equal(links.status, 200);
      const items = links.json.items as WireItem[];
      const ids = async (...titles: string[]): Promise<string[]> => Promise.all(titles.map(async (title) => (await find("acme", title)).id));
      const [renew, draft, legal, counsel] = await ids("Renew contract", "Draft terms", "Legal sign-off", "Counsel review");
      const renewItem = items[0] as WireItem;
      assert.equal(renewItem.taskId, renew);
      assert.deepEqual(
        renewItem.children.map(({ line, raw, checkbox, text, taskId, taskStatus, mismatch }) => ({ line, raw, checkbox, text, taskId, taskStatus, mismatch })),
        [
          { line: 3, raw: "  - [x] Draft terms", checkbox: "done", text: "Draft terms", taskId: draft, taskStatus: "done", mismatch: false },
          { line: 4, raw: "  - [x] Legal sign-off", checkbox: "done", text: "Legal sign-off", taskId: legal, taskStatus: "doing", mismatch: true },
          { line: 5, raw: "    - [x] Counsel review", checkbox: "done", text: "Counsel review", taskId: counsel, taskStatus: "todo", mismatch: true },
          { line: 6, raw: "  - [ ] Unknown step", checkbox: "todo", text: "Unknown step", taskId: null, taskStatus: null, mismatch: false },
        ],
      );
      assert.deepEqual((items[1] as WireItem).children, []);
      const loose = items[2] as WireItem;
      assert.equal(loose.taskId, null);
      assert.deepEqual(loose.children.map((child) => [child.text, child.taskId]), [["Draft terms", null]]);
      const todayBlock = (await boardPayload()).today as WireToday;
      assert.deepEqual([...todayBlock.mismatch].sort(), [renew, legal, counsel, (await find("acme", "Hire designer")).id].sort());
    });

    it("applies the daily state of an item and its children to the linked task and subtasks", async () => {
      writeDailyFile(today(), DAILY);
      const res = await fromDaily({ line: 2 });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { date: today(), updated: 3, failed: [] });
      assert.equal(
        readVault("acme.md"),
        [
          "---",
          "title: Acme Corp",
          "---",
          "",
          "## Open loops",
          "",
          "- [ ] Hire designer",
          "- [ ] BLOCK - Vendor audit - waiting vendor",
          "- [-] HOLD - Office move",
          "",
          "## Done loops",
          "",
          `- [x] Renew contract #p0 ✅ ${today()}`,
          "  - [x] Draft terms",
          "  - [x] Legal sign-off",
          "    - [x] Counsel review",
          "  - plain note",
          "- [x] Old win ✅ 2026-01-02",
          "",
        ].join("\n"),
      );
      assert.equal(readDailyFile(today()), DAILY);
      const again = await fromDaily({ line: 2, date: today() });
      assert.deepEqual(again.json, { date: today(), updated: 0, failed: [] });
      const hire = await fromDaily({ line: 8 });
      assert.deepEqual(hire.json, { date: today(), updated: 1, failed: [] });
      assert.equal((await find("acme", "Hire designer")).status, "doing");
    });

    it("answers 404 when the line links to no task, 400 on a bad body and honours the date", async () => {
      writeDailyFile(today(), DAILY);
      const loose = await fromDaily({ line: 10 });
      assert.equal(loose.status, 404);
      assert.equal((await fromDaily({ line: 0 })).status, 404);
      assert.equal((await fromDaily({ line: 3 })).status, 404);
      assert.equal((await fromDaily({ line: 999 })).status, 404);
      assert.equal((await fromDaily({})).status, 400);
      assert.equal((await fromDaily({ line: -1 })).status, 400);
      assert.equal((await fromDaily({ line: 2, date: "nope" })).status, 400);
      assert.equal((await fromDaily({ line: 2, date: "2001-01-01" })).status, 404);
      assert.equal(readVault("acme.md"), ACME);
      writeDailyFile(OTHER_DATE, focus("- [x] [[acme|Acme Corp]] - Hire designer"));
      const dated = await fromDaily({ line: 2, date: OTHER_DATE });
      assert.deepEqual(dated.json, { date: OTHER_DATE, updated: 1, failed: [] });
      assert.ok(readVault("acme.md").includes(`- [x] Hire designer ✅ ${today()}`));
    });
  });

  describe("board payload", () => {
    it("lists tasks and subtasks whose daily checkbox differs from their state", async () => {
      writeDailyFile(
        today(),
        focus(
          "- [x] [[acme|Acme Corp]] - Renew contract",
          "  - [ ] Draft terms",
          "  - [-] Legal sign-off",
          "    - [-] Counsel review",
          "- [ ] [[acme|Acme Corp]] - Hire designer",
          "- [-] [[acme|Acme Corp]] - Office move",
        ),
      );
      const todayBlock = (await boardPayload()).today as WireToday;
      const ids = async (...titles: string[]): Promise<string[]> => Promise.all(titles.map(async (title) => (await find("acme", title)).id));
      assert.deepEqual([...todayBlock.mismatch].sort(), (await ids("Renew contract", "Draft terms", "Counsel review")).sort());
      assert.deepEqual([...todayBlock.taskIds].sort(), (await ids("Renew contract", "Hire designer", "Office move")).sort());
      const [draft, legal] = await ids("Draft terms", "Legal sign-off");
      assert.equal(todayBlock.states[draft as string], "todo");
      assert.equal(todayBlock.states[legal as string], "doing");
    });
  });

  describe("stale saves and rewrites", () => {
    const SAVED = focus("- [ ] [[acme|Acme Corp]] - Hire designer", "", "- [ ] [[globex|Globex]] - Rollout checklist");
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const putWithBase = (date: string, content: string, baseUpdatedAt: unknown): Promise<HttpResult> =>
      http("PUT", `/delegation/daily/${date}`, { content, baseUpdatedAt });

    it("409s a daily save made on a base older than the hub's task-to-daily write and keeps the task change", async () => {
      writeDailyFile(today(), SAVED);
      const opened = await http("GET", `/delegation/daily/${today()}`);
      const staleBase = opened.json.updatedAt as number;
      await sleep(30);
      const moved = await patch(await find("acme", "Hire designer"), { status: "done" });
      assert.equal(moved.json.dailySynced, true);
      const synced = readDailyFile(today());
      assert.ok(synced.includes("- [x] [[acme|Acme Corp]] - Hire designer"));

      const stale = await putWithBase(today(), SAVED.replace("Rollout checklist", "Rollout checklist notes"), staleBase);
      assert.equal(stale.status, 409);
      assert.equal(stale.json.content, synced);
      assert.equal(readDailyFile(today()), synced);
      assert.equal((await find("acme", "Hire designer")).status, "done");

      const reloaded = await putWithBase(today(), synced.replace("Rollout checklist", "Rollout checklist notes"), stale.json.updatedAt);
      assert.equal(reloaded.status, 200);
      const again = await putWithBase(today(), synced.replace("Rollout checklist", "Rollout checklist notes 2"), reloaded.json.updatedAt);
      assert.equal(again.status, 200);
    });

    it("409s a stale save after an add-to-daily write and accepts the same client's consecutive saves", async () => {
      writeDailyFile(today(), SAVED);
      const opened = await http("GET", `/delegation/daily/${today()}`);
      const staleBase = opened.json.updatedAt as number;
      await sleep(30);
      const added = await addToDaily(await find("initech", "Pilot validation"), today());
      assert.equal(added.status, 201);
      const stale = await putWithBase(today(), `${SAVED}extra\n`, staleBase);
      assert.equal(stale.status, 409);
      const first = await putDaily(today(), readDailyFile(today()).replace("Rollout checklist", "Rollout one"));
      assert.equal(first.status, 200);
      const second = await putWithBase(today(), readDailyFile(today()).replace("Rollout one", "Rollout two"), first.json.updatedAt);
      assert.equal(second.status, 200);
    });

    it("keeps done tasks done when the wizard recomposes today's daily with overwrite", async () => {
      writeFileSync(join(vault, "acme.md"), ACME.replace("- [ ] Hire designer", "- [x] Hire designer"));
      writeDailyFile(today(), focus("- [x] [[acme|Acme Corp]] - Hire designer", "", "- [ ] [[globex|Globex]] - Rollout checklist"));
      const untouched = readVault("acme.md");
      const res = await http("POST", `/delegation/daily/${today()}/compose`, {
        overwrite: true,
        focus: [
          { project: "acme", text: "Hire designer" },
          { project: "globex", text: "Rollout checklist" },
        ],
        meetings: [],
      });
      assert.equal(res.status, 200);
      assert.ok(readDailyFile(today()).includes("- [ ] [[acme|Acme Corp]] - Hire designer"));
      assert.equal(readVault("acme.md"), untouched);
      assert.equal((await find("acme", "Hire designer")).status, "done");
    });

    it("replaces every placeholder line of an otherwise empty focus section with the new group", async () => {
      writeDailyFile(ADD_DATE, "## Foco de hoje\n\n- [ ]\n- [ ]\n\n## Reuniões\n");
      const res = await addToDaily(await find("globex", "Rollout checklist"));
      assert.equal(res.status, 201);
      assert.equal(res.json.line, 2);
      assert.equal(readDailyFile(ADD_DATE), "## Foco de hoje\n\n- [ ] [[globex|Globex]] - Rollout checklist\n\n## Reuniões\n");
      writeDailyFile(OTHER_DATE, "## Foco de hoje\n\n-\n\n- [ ]\n-\n## Reuniões\n");
      const spaced = await addToDaily(await find("globex", "Rollout checklist"), OTHER_DATE);
      assert.equal(spaced.status, 201);
      assert.equal(readDailyFile(OTHER_DATE), "## Foco de hoje\n\n- [ ] [[globex|Globex]] - Rollout checklist\n## Reuniões\n");
    });
  });
});
