import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
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
  priority: number | null;
  subtasks: WireTask[];
}

interface WireItem {
  line: number;
  raw: string;
  checkbox: string;
  label: string | null;
  projectId: string | null;
  text: string;
  taskId: string | null;
  candidates: string[];
  taskStatus: string | null;
  taskPriority: number | null;
  mismatch: boolean;
}

interface WireLinks {
  date: string;
  exists: boolean;
  path: string;
  items: WireItem[];
  taskIds: string[];
}

interface WireToday {
  date: string;
  exists: boolean;
  taskIds: string[];
  states: Record<string, string>;
  mismatch: string[];
}

const FOCUS_DATE = "2026-03-10";
const ADD_DATE = "2026-03-11";

const VAULT: Record<string, string> = {
  "acme.md": [
    "---",
    "title: Acme Corp",
    "---",
    "",
    "## Open loops",
    "",
    "- [ ] Renew contract #p0",
    "- [-] Hire designer",
    "- [ ] HOLD - Legal review - waiting counsel",
    "- [x] Close audit",
    "- [ ] Plan Q4 #P1",
    "",
  ].join("\n"),
  "globex.md": "---\ntitle: Globex Industries\n---\n\n## Open loops\n\n- [ ] Rollout checklist\n- [ ] Banner copy review\n",
  "initech.md": "# Initech\n\n## Open loops\n\n- [ ] Pilot validation\n  - [-] Simulate kickoff call\n- [ ] Rollout checklist\n",
  "cafe-society.md": "---\ntitle: Café Society\n---\n\n## Open loops\n\n- [ ] Renovação do site\n",
};

const FOCUS_DAILY = [
  "---",
  `date: ${FOCUS_DATE}`,
  "---",
  "",
  `# ${FOCUS_DATE}`,
  "",
  "## Focus",
  "",
  "- [ ] [[projetos/acme|Acme Corp]] - Renew contract",
  "- [-] [[globex]] - Rollout checklist",
  "- [x] Initech - Pilot validation",
  "- [ ] [[ghost-project]] - Something unknown",
  "- [ ] Cafe Society - renovacao do site",
  "- [ ] Rollout checklist",
  "- [ ] Hire designer for the brand refresh",
  "- [ ] Plan Q4 budget",
  "- [ ] HOLD - Legal review",
  "- [x] [[acme]] - Legal review - waiting counsel",
  "- [ ] Plain note not in tasks",
  "  - [ ] nested ignored",
  "- [ ] [[acme]]: Close audit",
  "",
  "## Meetings",
  "",
  "- [ ] Renew contract",
  "",
].join("\n");

describe("daily and tasks links", () => {
  const box: Sandbox = makeSandbox("cch-tasks-daily-");
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

  const today = (): string => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };
  const flat = (tasks: WireTask[]): WireTask[] => tasks.flatMap((task) => [task, ...flat(task.subtasks)]);
  const dailyPath = (date: string): string => join(dailyDir, `${date}.md`);
  const writeDailyFile = (date: string, content: string): void => {
    mkdirSync(dailyDir, { recursive: true });
    writeFileSync(dailyPath(date), content);
  };
  const readDailyFile = (date: string): string => readFileSync(dailyPath(date), "utf8");
  const features = async (daily: boolean, tasks: boolean): Promise<void> => {
    const res = await http("PUT", "/delegation/settings", { features: { daily, tasks } });
    assert.equal(res.status, 200);
  };
  const wikilinks = async (value: boolean): Promise<void> => {
    assert.equal((await http("PUT", "/delegation/settings", { daily: { wikilinks: value } })).status, 200);
  };
  const board = async (): Promise<WireTask[]> => flat((await http("GET", "/delegation/tasks-board")).json.tasks as WireTask[]);
  const find = async (projectId: string, title: string): Promise<WireTask> => {
    const found = (await board()).find((task) => task.projectId === projectId && task.title === title);
    assert.ok(found, `${projectId} ${title}`);
    return found;
  };
  const links = async (date?: string): Promise<HttpResult & { body: WireLinks }> => {
    const res = await http("GET", `/delegation/tasks-board/daily-links${date ? `?date=${date}` : ""}`);
    return { ...res, body: res.json as unknown as WireLinks };
  };
  const addToDaily = (task: WireTask, extra: Record<string, unknown> = {}): Promise<HttpResult> =>
    http("POST", "/delegation/tasks-board/add-to-daily", { projectId: task.projectId, line: task.line, raw: task.raw, date: ADD_DATE, ...extra });
  const itemOf = (result: WireLinks, text: string): WireItem => {
    const found = result.items.find((item) => item.raw.includes(text));
    assert.ok(found, text);
    return found;
  };

  before(async () => {
    for (const [rel, content] of Object.entries(VAULT)) {
      const full = join(vault, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    hub = await startServer(box, { HUB_DELEGATION: "1" });
    const res = await http("PUT", "/delegation/settings", {
      workspacesRoot: box.root,
      secondBrainRoot: box.brain,
      features: { daily: true, tasks: true },
      daily: { wikilinks: true },
      tasks: { root: vault },
    });
    assert.equal(res.status, 200);
    writeDailyFile(FOCUS_DATE, FOCUS_DAILY);
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("resolves the project by the wikilink alias when the link target is not a project name", async () => {
    const date = "2026-03-21";
    writeDailyFile(date, "# Day\n\n## Focus\n\n- [ ] [[acmecorp|Acme Corp]] - Renew contract\n");
    const result = await links(date);
    assert.equal(result.status, 200);
    const item = itemOf(result.body, "Renew contract");
    assert.equal(item.label, "acmecorp");
    assert.equal(item.projectId, "acme");
    assert.equal(item.taskId, (await find("acme", "Renew contract")).id);
  });

  it("links focus items to tasks by wikilink alias, plain label, diacritics and the tail of a longer text", async () => {
    const result = await links(FOCUS_DATE);
    assert.equal(result.status, 200);
    assert.equal(result.body.date, FOCUS_DATE);
    assert.equal(result.body.exists, true);
    assert.equal(result.body.path, dailyPath(FOCUS_DATE));
    assert.equal(result.body.items.length, 12);

    const renew = await find("acme", "Renew contract");
    const alias = itemOf(result.body, "Acme Corp]] - Renew contract");
    assert.equal(alias.label, "acme");
    assert.equal(alias.projectId, "acme");
    assert.equal(alias.text, "Renew contract");
    assert.equal(alias.taskId, renew.id);
    assert.equal(alias.taskStatus, "todo");
    assert.equal(alias.checkbox, "todo");
    assert.equal(alias.mismatch, false);
    assert.deepEqual(alias.candidates, []);
    assert.equal(alias.line, FOCUS_DAILY.split("\n").indexOf("- [ ] [[projetos/acme|Acme Corp]] - Renew contract"));
    assert.equal(alias.raw, "- [ ] [[projetos/acme|Acme Corp]] - Renew contract");

    const globex = itemOf(result.body, "[[globex]]");
    assert.equal(globex.checkbox, "doing");
    assert.equal(globex.projectId, "globex");
    assert.equal(globex.taskId, (await find("globex", "Rollout checklist")).id);
    assert.equal(globex.mismatch, true);

    const plain = itemOf(result.body, "Initech - Pilot validation");
    assert.equal(plain.label, "Initech");
    assert.equal(plain.projectId, "initech");
    assert.equal(plain.text, "Pilot validation");
    assert.equal(plain.taskId, (await find("initech", "Pilot validation")).id);
    assert.equal(plain.checkbox, "done");

    const cafe = itemOf(result.body, "Cafe Society");
    assert.equal(cafe.projectId, "cafe-society");
    assert.equal(cafe.taskId, (await find("cafe-society", "Renovação do site")).id);

    const prefix = itemOf(result.body, "Hire designer for the brand refresh");
    assert.equal(prefix.label, null);
    assert.equal(prefix.projectId, null);
    assert.equal(prefix.taskId, (await find("acme", "Hire designer")).id);
    assert.equal(prefix.taskStatus, "doing");

    const short = itemOf(result.body, "Plan Q4 budget");
    assert.equal(short.taskId, null);
    assert.deepEqual(short.candidates, []);
    assert.equal(short.taskStatus, null);
    assert.equal(short.mismatch, false);
  });

  it("reports the linked task priority on each daily item and null when nothing is linked", async () => {
    const result = await links(FOCUS_DATE);
    const renew = await find("acme", "Renew contract");
    assert.equal(renew.priority, 0);
    assert.equal(itemOf(result.body, "Acme Corp]] - Renew contract").taskPriority, 0);
    assert.equal(itemOf(result.body, "Hire designer for the brand refresh").taskPriority, null);
    assert.equal(itemOf(result.body, "Plan Q4 budget").taskPriority, null);
    assert.equal(itemOf(result.body, "Plain note not in tasks").taskPriority, null);
    assert.equal(itemOf(result.body, "[[ghost-project]]").taskPriority, null);
    const plan = await find("acme", "Plan Q4");
    assert.equal(plan.priority, 1);
    assert.equal(plan.title, "Plan Q4");
    assert.equal(itemOf(result.body, "Close audit").taskPriority, null);
  });

  it("reports unresolved labels, plain notes and ambiguous matches with candidates", async () => {
    const result = await links(FOCUS_DATE);
    const ghost = itemOf(result.body, "ghost-project");
    assert.equal(ghost.label, "ghost-project");
    assert.equal(ghost.projectId, null);
    assert.equal(ghost.text, "Something unknown");
    assert.equal(ghost.taskId, null);
    assert.deepEqual(ghost.candidates, []);

    const note = itemOf(result.body, "Plain note not in tasks");
    assert.equal(note.taskId, null);
    assert.equal(note.projectId, null);
    assert.equal(note.label, null);

    const ambiguous = result.body.items.find((item) => item.raw === "- [ ] Rollout checklist");
    assert.ok(ambiguous);
    assert.equal(ambiguous.taskId, null);
    assert.equal(ambiguous.taskStatus, null);
    assert.deepEqual(
      [...ambiguous.candidates].sort(),
      [(await find("globex", "Rollout checklist")).id, (await find("initech", "Rollout checklist")).id].sort(),
    );
    assert.equal(result.body.items.some((item) => item.raw.includes("nested ignored")), false);
    assert.equal(result.body.items.some((item) => item.text === "Renew contract" && item.projectId === null), false);
  });

  it("flags mismatches between the daily checkbox and the task status and ignores a status prefix in the daily", async () => {
    const result = await links(FOCUS_DATE);
    const legal = await find("acme", "Legal review");
    assert.equal(legal.status, "hold");
    const prefixed = itemOf(result.body, "- [ ] HOLD - Legal review");
    assert.equal(prefixed.taskId, legal.id);
    assert.equal(prefixed.mismatch, false);
    const full = itemOf(result.body, "Legal review - waiting counsel");
    assert.equal(full.taskId, legal.id);
    assert.equal(full.checkbox, "done");
    assert.equal(full.mismatch, false);
    const initech = itemOf(result.body, "Initech - Pilot validation");
    assert.equal(initech.mismatch, true);
    const closed = itemOf(result.body, "[[acme]]: Close audit");
    assert.equal(closed.text, "Close audit");
    assert.equal(closed.taskStatus, "done");
    assert.equal(closed.mismatch, true);
    assert.equal(itemOf(result.body, "Renew contract").mismatch, false);
    const ids = result.body.taskIds;
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes(legal.id));
    assert.ok(ids.includes((await find("acme", "Close audit")).id));
    assert.equal(ids.includes((await find("globex", "Banner copy review")).id), false);
  });

  it("strips the priority token from a daily item before matching and in the duplicate check", async () => {
    const date = "2026-03-22";
    writeDailyFile(
      date,
      ["## Focus", "", "- [ ] [[acme]] - Plan Q4 #P1", "- [ ] Plan Q4 #p3", "- [ ] #p1", ""].join("\n"),
    );
    const result = await links(date);
    const plan = await find("acme", "Plan Q4");
    const labelled = itemOf(result.body, "[[acme]] - Plan Q4 #P1");
    assert.equal(labelled.taskId, plan.id);
    assert.equal(labelled.taskPriority, 1);
    assert.equal(itemOf(result.body, "- [ ] Plan Q4 #p3").taskId, plan.id);
    assert.equal(itemOf(result.body, "- [ ] #p1").taskId, null);
    const again = await addToDaily(plan, { date });
    assert.equal(again.status, 409);
    assert.equal(again.json.error, "already in the daily");
  });

  it("answers an empty list when the daily does not exist and rejects a bad date", async () => {
    const missing = await links("2001-01-01");
    assert.equal(missing.status, 200);
    assert.equal(missing.body.exists, false);
    assert.deepEqual(missing.body.items, []);
    assert.deepEqual(missing.body.taskIds, []);
    assert.equal(missing.body.date, "2001-01-01");
    assert.equal((await links("nope")).status, 400);
  });

  it("defaults to today and matches the same task through a prefix of its full text", async () => {
    writeDailyFile(today(), "## Focus\n\n- [x] [[acme]] - Renew contract\n- [-] [[globex]] - Rollout\n- [ ] globex - Banner copy review\n");
    const result = await links();
    assert.equal(result.body.date, today());
    assert.equal(result.body.exists, true);
    assert.equal(result.body.items.length, 3);
    assert.equal(result.body.items[0]?.mismatch, true);
    assert.equal(result.body.items[1]?.taskId, null);
    assert.equal(result.body.items[2]?.taskId, (await find("globex", "Banner copy review")).id);
  });

  it("adds a today block to the board payload when both features are on", async () => {
    writeDailyFile(today(), "## Focus\n\n- [x] [[acme]] - Renew contract\n- [-] [[globex]] - Rollout checklist\n- [ ] Plain note\n");
    const payload = (await http("GET", "/delegation/tasks-board")).json;
    const todayBlock = payload.today as WireToday;
    const renew = await find("acme", "Renew contract");
    const rollout = await find("globex", "Rollout checklist");
    assert.equal(todayBlock.date, today());
    assert.equal(todayBlock.exists, true);
    assert.deepEqual([...todayBlock.taskIds].sort(), [renew.id, rollout.id].sort());
    assert.deepEqual(todayBlock.states, { [renew.id]: "done", [rollout.id]: "doing" });
    assert.deepEqual([...todayBlock.mismatch].sort(), [renew.id, rollout.id].sort());

    const hidden = dailyPath(today());
    renameSync(hidden, `${hidden}.bak`);
    const without = (await http("GET", "/delegation/tasks-board")).json.today as WireToday;
    assert.deepEqual(without, { date: today(), exists: false, taskIds: [], states: {}, mismatch: [] });
    renameSync(`${hidden}.bak`, hidden);

    await features(false, true);
    assert.equal((await http("GET", "/delegation/tasks-board")).json.today, null);
    await features(true, false);
    assert.equal((await http("GET", "/delegation/tasks-board")).json.today, null);
    await features(true, true);
    assert.notEqual((await http("GET", "/delegation/tasks-board")).json.today, null);
  });

  it("rejects both daily routes when either feature is off", async () => {
    const globexTask = await find("globex", "Banner copy review");
    for (const [daily, tasks] of [[false, true], [true, false]] as const) {
      await features(daily, tasks);
      assert.equal((await http("GET", "/delegation/tasks-board/daily-links")).status, 400);
      const add = await http("POST", "/delegation/tasks-board/add-to-daily", { projectId: "globex", line: globexTask.line, raw: globexTask.raw });
      assert.equal(add.status, 400);
    }
    await features(true, true);
  });

  describe("add to daily", () => {
    const BASE_DAILY = "---\ndate: 2026-03-11\n---\n\n# 2026-03-11\n\n## Focus\n\n- [ ] Existing item\n\n## Meetings\n\n- [ ] Sync\n";

    it("opens a new group with the wikilinked project alias before an unresolved item and then refuses a duplicate", async () => {
      writeDailyFile(ADD_DATE, BASE_DAILY);
      await wikilinks(true);
      const banner = await find("globex", "Banner copy review");
      const res = await addToDaily(banner);
      assert.equal(res.status, 201);
      assert.equal(res.json.date, ADD_DATE);
      assert.equal(res.json.line, 8);
      assert.equal(res.json.raw, "- [ ] [[globex|Globex Industries]] - Banner copy review");
      assert.equal(readDailyFile(ADD_DATE), BASE_DAILY.replace("- [ ] Existing item\n", "- [ ] [[globex|Globex Industries]] - Banner copy review\n\n- [ ] Existing item\n"));
      const after = await links(ADD_DATE);
      assert.equal(itemOf(after.body, "Banner copy review").taskId, banner.id);
      const again = await addToDaily(banner);
      assert.equal(again.status, 409);
      assert.equal(again.json.error, "already in the daily");
    });

    it("keeps the alias when the title matches the name ignoring case and uses [-] for a doing task", async () => {
      writeDailyFile(ADD_DATE, BASE_DAILY);
      await wikilinks(true);
      const kickoff = await find("initech", "Simulate kickoff call");
      assert.equal(kickoff.status, "doing");
      const res = await addToDaily(kickoff);
      assert.equal(res.status, 201);
      assert.equal(res.json.raw, "- [-] [[initech|Initech]] - Simulate kickoff call");
      assert.ok(readDailyFile(ADD_DATE).includes("## Focus\n\n- [-] [[initech|Initech]] - Simulate kickoff call\n\n- [ ] Existing item\n\n## Meetings"));
    });

    it("writes the plain project title when wikilinks are off", async () => {
      writeDailyFile(ADD_DATE, BASE_DAILY);
      await wikilinks(false);
      const plan = await find("acme", "Plan Q4");
      const res = await addToDaily(plan);
      assert.equal(res.status, 201);
      assert.equal(res.json.raw, "- [ ] Acme Corp - Plan Q4");
      assert.ok(readDailyFile(ADD_DATE).includes("## Focus\n\n- [ ] Acme Corp - Plan Q4\n\n- [ ] Existing item\n"));
      await wikilinks(true);
    });

    it("resolves a plain label whose project title contains the separator", async () => {
      const dashFile = join(vault, "dash.md");
      writeFileSync(dashFile, "---\ntitle: Dash - Web\n---\n\n## Open loops\n\n- [ ] Fix\n");
      try {
        writeDailyFile(ADD_DATE, BASE_DAILY);
        await wikilinks(false);
        const fix = await find("dash", "Fix");
        const first = await addToDaily(fix);
        assert.equal(first.status, 201);
        assert.equal(first.json.raw, "- [ ] Dash - Web - Fix");
        const after = await links(ADD_DATE);
        const item = itemOf(after.body, "Dash - Web - Fix");
        assert.equal(item.label, "Dash - Web");
        assert.equal(item.projectId, "dash");
        assert.equal(item.text, "Fix");
        assert.equal(item.taskId, fix.id);
        const again = await addToDaily(fix);
        assert.equal(again.status, 409);
        assert.equal(again.json.error, "already in the daily");
        assert.equal(readDailyFile(ADD_DATE).split("Dash - Web - Fix").length - 1, 1);
      } finally {
        rmSync(dashFile, { force: true });
        await wikilinks(true);
      }
    });

    it("refuses to add a task again when the daily already lists it among ambiguous candidates", async () => {
      const twinFile = join(vault, "twin.md");
      writeFileSync(twinFile, "# Twin\n\n## Open loops\n\n- [ ] Renew lease\n- [ ] Renew lease\n");
      try {
        writeDailyFile(ADD_DATE, BASE_DAILY);
        await wikilinks(true);
        const twins = (await board()).filter((task) => task.projectId === "twin");
        assert.equal(twins.length, 2);
        const first = await addToDaily(twins[0] as WireTask);
        assert.equal(first.status, 201);
        const item = itemOf((await links(ADD_DATE)).body, "Renew lease");
        assert.equal(item.taskId, null);
        assert.deepEqual(item.candidates.sort(), twins.map((task) => task.id).sort());
        const again = await addToDaily(twins[0] as WireTask);
        assert.equal(again.status, 409);
        assert.equal(again.json.error, "already in the daily");
        const other = await addToDaily(twins[1] as WireTask);
        assert.equal(other.status, 409);
        assert.equal(readDailyFile(ADD_DATE).split("Renew lease").length - 1, 1);
      } finally {
        rmSync(twinFile, { force: true });
      }
    });

    it("answers 404 when the daily is missing, 409 on a stale task and 400 on bad bodies", async () => {
      const task = await find("globex", "Banner copy review");
      const missing = await addToDaily(task, { date: "2001-01-01" });
      assert.equal(missing.status, 404);
      assert.match(String(missing.json.error), /create the daily first/);
      assert.equal(existsSync(dailyPath("2001-01-01")), false);
      writeDailyFile(ADD_DATE, BASE_DAILY);
      const stale = await addToDaily({ ...task, raw: "- [ ] Banner copy review edited" });
      assert.equal(stale.status, 409);
      assert.equal(stale.json.error, "changed on disk");
      assert.equal(readDailyFile(ADD_DATE), BASE_DAILY);
      assert.equal((await addToDaily(task, { date: "nope" })).status, 400);
      assert.equal((await addToDaily(task, { projectId: "" })).status, 400);
      assert.equal((await addToDaily(task, { projectId: "ghost" })).status, 404);
      assert.equal((await http("POST", "/delegation/tasks-board/add-to-daily", { projectId: "globex", raw: task.raw })).status, 400);
      assert.equal(readDailyFile(ADD_DATE), BASE_DAILY);
    });

    it("fills an empty placeholder, creates a missing focus section and keeps CRLF", async () => {
      await wikilinks(true);
      const banner = await find("globex", "Banner copy review");
      writeDailyFile(ADD_DATE, "## Focus\n\n- [ ]\n\n## Meetings\n");
      assert.equal((await addToDaily(banner)).status, 201);
      assert.equal(readDailyFile(ADD_DATE), "## Focus\n\n- [ ] [[globex|Globex Industries]] - Banner copy review\n\n## Meetings\n");
      writeDailyFile(ADD_DATE, "# Notes only\n\ntext\n");
      assert.equal((await addToDaily(banner)).status, 201);
      assert.equal(readDailyFile(ADD_DATE), "# Notes only\n\ntext\n\n## Focus\n\n- [ ] [[globex|Globex Industries]] - Banner copy review\n");
      writeDailyFile(ADD_DATE, BASE_DAILY.replace(/\n/g, "\r\n"));
      assert.equal((await addToDaily(banner)).status, 201);
      const crlf = readDailyFile(ADD_DATE);
      assert.equal(crlf.replace(/\r\n/g, "").includes("\n"), false);
      assert.ok(crlf.includes("## Focus\r\n\r\n- [ ] [[globex|Globex Industries]] - Banner copy review\r\n\r\n- [ ] Existing item\r\n\r\n## Meetings\r\n"));
    });
  });
});
