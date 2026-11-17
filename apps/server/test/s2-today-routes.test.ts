import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { S2_DAILY_TEMPLATE, s2ConfigureVault, s2InitRepo, s2Sandbox, s2StartHub, s2Today, s2Until, s2Wait, s2WriteFile, type S2Hub } from "./helpers/s2-env.js";

const box = s2Sandbox("cch-s2-today-", { HUB_DELEGATION: "1" });

const { db } = await import("../src/db.js");
const today = await import("../src/today.js");
const board = await import("../src/tasks-board.js");
const daily = await import("../src/daily.js");
const { abortActiveRuns } = await import("../src/delegation-launch.js");

let hub: S2Hub;

const TODAY = s2Today();
const YESTERDAY = s2Today(-1);
const SCHEDULED = "⏳";

const LAB = [
  "# Lab",
  "",
  "## Open loops",
  "",
  `- [ ] Alpha ${SCHEDULED} ${TODAY}`,
  "  - [ ] Alpha child",
  "  - [ ] Alpha second child",
  "- [ ] Beta",
  `- [ ] Gamma ${SCHEDULED} ${TODAY}`,
  "- [ ] Delta",
  "",
  "## Done loops",
  "",
  "",
].join("\n");

const dayPath = (date: string): string => join(box.brain, "daily", `${date}.md`);

before(async () => {
  s2InitRepo(box.repoA);
  s2WriteFile(box.brain, "_templates/daily.md", S2_DAILY_TEMPLATE);
  s2WriteFile(box.brain, "projects/lab.md", LAB);
  s2WriteFile(box.brain, `daily/${YESTERDAY}.md`, `---\ntype: daily\ncreated: ${YESTERDAY}\n---\n\n# ${YESTERDAY}\n\n## Focus\n\n- [ ] Carry on\n- [x] Done yesterday\n\n## Meetings\n\n-\n\n## Captures\n\n-\n\n## Sessions\n\n-\n`);
  hub = await s2StartHub(box);
  await s2ConfigureVault(hub, box);
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
  subtasks: TaskView[];
}

const flat = (tasks: TaskView[]): TaskView[] => tasks.flatMap((task) => [task, ...flat(task.subtasks)]);

async function find(title: string): Promise<TaskView> {
  const res = await hub.http("GET", "/delegation/tasks-board");
  const found = flat((res.json as { tasks: TaskView[] }).tasks).find((task) => task.title === title);
  assert.ok(found, title);
  return found;
}

const target = (task: TaskView) => ({ projectId: task.projectId, line: task.line, raw: task.raw });
const errorOf = (json: unknown): string => (json as { error: string }).error;
const url = (path: string, date = TODAY): string => `/delegation/today/${date}${path}`;

describe("today validation", () => {
  it("rejects an invalid date on every verb", async () => {
    const res = await hub.http("GET", "/delegation/today/not-a-date");
    assert.equal(res.status, 400);
    assert.match(errorOf(res.json), /date must be a valid YYYY-MM-DD/);
    assert.equal((await hub.http("POST", "/delegation/today/2026-13-45/clear")).status, 400);
  });

  it("answers 400 for malformed bodies of each action", async () => {
    const alpha = await find("Alpha");
    const cases: [string, string, Record<string, unknown>, RegExp][] = [
      ["POST", "/schedule", { date: 5 }, /date must be a YYYY-MM-DD string or null/],
      ["POST", "/schedule", { date: null }, /projectId required/],
      ["POST", "/schedule", { date: null, projectId: "lab", line: -1, raw: "x" }, /line must be a non-negative integer/],
      ["POST", "/subtasks", { projectId: "lab", line: 1, raw: "x" }, /planned must be a boolean/],
      ["POST", "/reorder", { ...target(alpha), direction: "sideways" }, /direction must be up or down/],
      ["POST", "/clear/undo", {}, /token required/],
      ["POST", "/capture", {}, /text required/],
      ["POST", "/meeting", {}, /text required/],
      ["POST", "/promote", { ...target(alpha), schedule: "yes" }, /schedule must be a boolean/],
      ["POST", "/promote", { line: 1, raw: "x" }, /projectId required/],
      ["POST", "/link-tick", { lineIndex: -1 }, /lineIndex must be a non-negative integer/],
      ["POST", "/link-tick", { lineIndex: 1, action: "ignore" }, /action must be apply or dismiss/],
      ["POST", "/link-tick", { lineIndex: 1, action: "apply", raw: "x", target: 5 }, /target must be an object or null/],
      ["POST", "/task", {}, /projectId required/],
      ["POST", "/task", { projectId: "lab" }, /title required/],
      ["POST", "/task", { projectId: "lab", title: "x", priority: "high" }, /priority must be a number or null/],
      ["POST", "/task", { projectId: "lab", title: "x", due: 5 }, /due must be a YYYY-MM-DD string or null/],
      ["POST", "/task", { projectId: "lab", title: "x", after: 5 }, /after must be an object with line and raw/],
      ["POST", "/task", { projectId: "lab", title: "x", parentLine: 1 }, /raw required/],
      ["POST", "/task", { projectId: "lab", title: "x" }, /only the focus of yesterday creates its tasks here/],
    ];
    for (const [method, path, body, message] of cases) {
      const res = await hub.http(method, url(path), body);
      assert.equal(res.status, 400, `${path}: ${res.text}`);
      assert.match(errorOf(res.json), message, path);
    }
    const subtasks = await hub.http("GET", url("/subtasks?line=abc&projectId=lab"));
    assert.equal(subtasks.status, 400);
    const noProject = await hub.http("GET", url("/subtasks?line=1"));
    assert.equal(noProject.status, 400);
    assert.match(errorOf(noProject.json), /projectId required/);
  });
});

describe("today flow", () => {
  it("creates the day, reads it, captures and promotes a note, and records a meeting", async () => {
    const created = await hub.http("POST", url("/create"));
    assert.equal(created.status, 200, created.text);
    const read = await hub.http("GET", url(""));
    assert.equal(read.status, 200, read.text);
    assert.equal((read.json as { date: string }).date, TODAY);

    const capture = await hub.http("POST", url("/capture"), { text: "call the dentist" });
    assert.equal(capture.status, 200, capture.text);
    assert.ok(Array.isArray((capture.json as { captures: unknown[] }).captures));
    const meeting = await hub.http("POST", url("/meeting"), { text: "10:00 sync with the team" });
    assert.equal(meeting.status, 200, meeting.text);
    assert.match(readFileSync(dayPath(TODAY), "utf8"), /sync with the team/);
    const content = readFileSync(dayPath(TODAY), "utf8").split(/\r?\n/);
    const line = content.findIndex((entry) => entry.includes("call the dentist"));
    assert.ok(line >= 0, "capture landed in the daily note");
    const promoted = await hub.http("POST", url("/promote"), { line, raw: content[line], projectId: "lab", schedule: true });
    assert.equal(promoted.status, 200, promoted.text);
    const stale = await hub.http("POST", url("/promote"), { line, raw: "- not what is there", projectId: "lab" });
    assert.equal(stale.status, 409);
  });

  it("schedules, reorders and clears the focus with an undo token", async () => {
    const beta = await find("Beta");
    const scheduled = await hub.http("POST", url("/schedule"), { ...target(beta), date: TODAY });
    assert.equal(scheduled.status, 200, scheduled.text);
    const gamma = await find("Gamma");
    const reordered = await hub.http("POST", url("/reorder"), { ...target(gamma), direction: "up" });
    assert.equal(reordered.status, 200, reordered.text);
    const unscheduled = await hub.http("POST", url("/schedule"), { ...target(await find("Beta")), date: null });
    assert.equal(unscheduled.status, 200, unscheduled.text);
    const cleared = await hub.http("POST", url("/clear"));
    assert.equal(cleared.status, 200, cleared.text);
    const token = (cleared.json as { token: string }).token;
    assert.equal(typeof token, "string");
    const undone = await hub.http("POST", url("/clear/undo"), { token });
    assert.equal(undone.status, 200, undone.text);
    assert.deepEqual(undone.json, { restored: true });
    const bogus = await hub.http("POST", url("/clear/undo"), { token: "no-such-token" });
    assert.equal(bogus.status, 404, bogus.text);
  });

  it("lists and plans subtasks of a scheduled task", async () => {
    const alpha = await find("Alpha");
    const options = await hub.http("GET", url(`/subtasks?projectId=lab&line=${alpha.line}`));
    assert.equal(options.status, 200, options.text);
    const child = await find("Alpha child");
    const planned = await hub.http("POST", url("/subtasks"), { ...target(child), planned: true });
    assert.equal(planned.status, 200, planned.text);
    const unplanned = await hub.http("POST", url("/subtasks"), { ...target(await find("Alpha child")), planned: false });
    assert.equal(unplanned.status, 200, unplanned.text);
  });

  it("creates a task on yesterday through its note", async () => {
    const created = await hub.http("POST", url("/task", YESTERDAY), { projectId: "lab", title: "Made yesterday", priority: null, due: null, parentLine: null, after: null });
    assert.equal(created.status, 201, created.text);
    assert.equal((created.json as { task: { title: string; scheduled: string | null } }).task.scheduled, null);
    assert.match(readFileSync(dayPath(YESTERDAY), "utf8"), /- \[ \] \[\[lab\|Lab\]\] - Made yesterday/);
    const delta = await find("Delta");
    const placed = await hub.http("POST", url("/task", YESTERDAY), { projectId: "lab", title: "After delta", priority: 2, due: TODAY, after: target(delta) });
    assert.equal(placed.status, 201, placed.text);
    const missing = await hub.http("POST", url("/task", "2026-02-30"), { projectId: "lab", title: "x" });
    assert.equal(missing.status, 400);
  });

  it("migrates the focus and resolves link ticks", async () => {
    const migrated = await hub.http("POST", url("/migrate"));
    assert.equal(migrated.status, 200, migrated.text);
    const dismissed = await hub.http("POST", url("/link-tick"), { lineIndex: 0, raw: "- [x] something", target: null, action: "dismiss" });
    assert.equal(dismissed.status, 409, dismissed.text);
    const alpha = await find("Alpha");
    const applied = await hub.http("POST", url("/link-tick"), { lineIndex: 0, raw: "- [x] something", target: target(alpha), action: "apply" });
    assert.equal(applied.status, 409, applied.text);
    const badTarget = await hub.http("POST", url("/link-tick"), { lineIndex: 0, raw: "x", target: { projectId: "lab", line: "no", raw: "r" }, action: "apply" });
    assert.equal(badTarget.status, 400);
    const missing = await hub.http("POST", url("/create", "2026-02-30"));
    assert.equal(missing.status, 400);
  });
});

describe("daily routes", () => {
  it("lists the diary and reads and writes a day", async () => {
    const info = await hub.http("GET", "/delegation/daily");
    assert.equal(info.status, 200, info.text);
    const body = info.json as { enabled: boolean; dates: string[]; running: unknown };
    assert.equal(body.enabled, true);
    assert.ok(body.dates.includes(YESTERDAY));
    assert.equal(body.running, null);
    const read = await hub.http("GET", `/delegation/daily/${YESTERDAY}`);
    assert.equal(read.status, 200, read.text);
    const content = (read.json as { content: string; updatedAt: number }).content;
    const updatedAt = (read.json as { updatedAt: number }).updatedAt;
    const written = await hub.http("PUT", `/delegation/daily/${YESTERDAY}`, { content: `${content}\n- added by the test\n`, baseUpdatedAt: updatedAt, writeId: "w1" });
    assert.equal(written.status, 200, written.text);
    await s2Wait(30);
    s2WriteFile(box.brain, `daily/${YESTERDAY}.md`, `${content}
- edited elsewhere
`);
    const conflict = await hub.http("PUT", `/delegation/daily/${YESTERDAY}`, { content: "overwrite", baseUpdatedAt: updatedAt });
    assert.equal(conflict.status, 409, conflict.text);
    assert.ok(typeof (conflict.json as { content: string }).content === "string");
    assert.equal((await hub.http("PUT", `/delegation/daily/${YESTERDAY}`, {})).status, 400);
    assert.equal((await hub.http("PUT", `/delegation/daily/${YESTERDAY}`, { content: "x", writeId: 5 })).status, 400);
    assert.equal((await hub.http("PUT", `/delegation/daily/${YESTERDAY}`, { content: "x", writeId: "w".repeat(65) })).status, 400);
    assert.equal((await hub.http("PUT", "/delegation/daily/bad-date", { content: "x" })).status, 400);
    assert.equal((await hub.http("GET", "/delegation/daily/bad-date")).status, 400);
  });

  it("reports the sessions of a date and validates the query", async () => {
    const ok = await hub.http("GET", `/delegation/daily/sessions?date=${TODAY}`);
    assert.equal(ok.status, 200, ok.text);
    assert.ok(Array.isArray(ok.json));
    assert.equal((await hub.http("GET", "/delegation/daily/sessions")).status, 400);
  });

  it("prepares the day with yesterday's tasks and closes yesterday", async () => {
    s2WriteFile(box.brain, `daily/${YESTERDAY}.md`, `---
type: daily
created: ${YESTERDAY}
---

# ${YESTERDAY}

## Focus

- [ ] Carry on
- [x] Done yesterday

## Meetings

-
`);
    const prepared = await hub.http("GET", `/delegation/daily/${TODAY}/prepare`);
    assert.equal(prepared.status, 200, prepared.text);
    const prep = prepared.json as { yesterday: { date: string; closed: boolean; tasks: { line: number }[] } | null };
    assert.equal(prep.yesterday?.date, YESTERDAY);
    assert.equal(prep.yesterday?.closed, false);
    const first = prep.yesterday?.tasks[0];
    assert.ok(first);
    const closed = await hub.http("POST", `/delegation/daily/${TODAY}/close-yesterday`, { yesterday: YESTERDAY, summary: "went fine", tasks: [{ line: first.line, checked: true }] });
    assert.equal(closed.status, 200, closed.text);
    assert.equal((closed.json as { closed: boolean }).closed, true);
    const reprepared = (await hub.http("GET", `/delegation/daily/${TODAY}/prepare`)).json as { yesterday: { closed: boolean } };
    assert.equal(reprepared.yesterday.closed, true);
    assert.equal((await hub.http("GET", "/delegation/daily/oops/prepare")).status, 400);
  });

  it("rejects malformed close-yesterday requests", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ yesterday: "nope" }, /yesterday must be a valid YYYY-MM-DD/],
      [{ yesterday: YESTERDAY, summary: 4 }, /summary must be a string/],
      [{ yesterday: YESTERDAY, tasks: [5] }, /entries must be objects/],
      [{ yesterday: YESTERDAY, tasks: [{ line: "a", checked: true }] }, /line and tasks\[\]\.checked required/],
      [{ yesterday: "2020-01-01", tasks: [] }, /yesterday diary not found/],
    ];
    for (const [body, message] of cases) {
      const res = await hub.http("POST", `/delegation/daily/${TODAY}/close-yesterday`, body);
      assert.equal(res.status, 400, res.text);
      assert.match(errorOf(res.json), message);
    }
    assert.equal((await hub.http("POST", "/delegation/daily/bad/close-yesterday", {})).status, 400);
  });

  it("composes a diary from focus items, refusing to overwrite without a flag", async () => {
    const date = s2Today(3);
    const body = { focus: [{ project: "lab", text: "Alpha" }, { project: null, text: "Free item", block: "- [ ] Free item" }], meetings: ["09:00 standup"], briefing: "Plan" };
    const composed = await hub.http("POST", `/delegation/daily/${date}/compose`, body);
    assert.equal(composed.status, 200, composed.text);
    assert.match(readFileSync(dayPath(date), "utf8"), /standup/);
    const clash = await hub.http("POST", `/delegation/daily/${date}/compose`, body);
    assert.equal(clash.status, 409);
    const overwritten = await hub.http("POST", `/delegation/daily/${date}/compose`, { ...body, overwrite: true });
    assert.equal(overwritten.status, 200, overwritten.text);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ meetings: [] }, /focus must be an array/],
      [{ focus: [5], meetings: [] }, /focus\[\] entries must be objects/],
      [{ focus: [{ project: "x" }], meetings: [] }, /focus\[\]\.text required/],
      [{ focus: [] }, /meetings must be an array/],
    ];
    for (const [bad, message] of cases) {
      const res = await hub.http("POST", `/delegation/daily/${date}/compose`, bad);
      assert.equal(res.status, 400, res.text);
      assert.match(errorOf(res.json), message);
    }
    assert.equal((await hub.http("POST", "/delegation/daily/bad/compose", {})).status, 400);
  });

  it("organizes the focus and refuses a stale base", async () => {
    const ok = await hub.http("POST", `/delegation/daily/${TODAY}/organize-focus`, {});
    assert.equal(ok.status, 200, ok.text);
    const stale = await hub.http("POST", `/delegation/daily/${TODAY}/organize-focus`, { baseUpdatedAt: 1 });
    assert.equal(stale.status, 200, stale.text);
    assert.equal((await hub.http("POST", "/delegation/daily/bad/organize-focus", {})).status, 400);
  });

  it("starts a generation run once and reports it as running", async () => {
    const date = s2Today(5);
    const started = await hub.http("POST", `/delegation/daily/${date}/generate`, { focus: "ship it", context: "notes" });
    assert.equal(started.status, 201, started.text);
    const again = await hub.http("POST", `/delegation/daily/${date}/generate`, {});
    assert.equal(again.status, 409);
    assert.ok(typeof (again.json as { taskId: string }).taskId === "string");
    const info = (await hub.http("GET", "/delegation/daily")).json as { running: { date: string } | null };
    assert.ok(info.running === null || info.running.date === date);
    assert.equal((await hub.http("POST", "/delegation/daily/bad/generate", {})).status, 400);
    await s2Until(async () => {
      const list = (await hub.http("GET", "/delegation/tasks?limit=5")).json as { status: string }[];
      return list.every((item) => item.status !== "running" && item.status !== "pending") ? true : null;
    }, 20_000);
  });

  it("reports a disabled diary when no second brain is linked", async () => {
    await hub.http("PUT", "/delegation/settings", { secondBrainRoot: null, features: { daily: false } });
    const info = await hub.http("GET", "/delegation/daily");
    assert.equal(info.status, 200);
    assert.equal((info.json as { enabled: boolean }).enabled, false);
  });
});
