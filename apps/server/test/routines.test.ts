import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { makeSandbox, sandboxEnv, waitFor } from "./helpers.js";

const box = makeSandbox("cch-routines-");
const env = sandboxEnv(box, { HUB_DELEGATION: "1", HUB_PORT: "1", FAKE_CLAUDE_DELAY_MS: "50", FAKE_CLAUDE_COST: "0.25", USERPROFILE: box.home, HOME: box.home });
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);

type Store = typeof import("../src/routine-store.js");
type Routines = typeof import("../src/routines.js");
type Delegation = typeof import("../src/delegation-store.js");
type Sse = typeof import("../src/sse.js");
let store: Store;
let routines: Routines;
let delegation: Delegation;
let sse: Sse;
const events: { event: string; data: unknown }[] = [];
let dbHandle: import("better-sqlite3").Database | null = null;

before(async () => {
  delegation = await import("../src/delegation-store.js");
  store = await import("../src/routine-store.js");
  routines = await import("../src/routines.js");
  sse = await import("../src/sse.js");
  dbHandle = (await import("../src/db.js")).db;
  sse.onBroadcast((event, data) => events.push({ event, data }));
  routines.ensureRoutineListener();
  delegation.updateSettings({ workspacesRoot: box.root, features: { delegated: true } });
});

after(async () => {
  const { db } = await import("../src/db.js");
  db.close();
  try {
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    void 0;
  }
});

beforeEach(() => {
  events.length = 0;
  store.setRoutineSettings({ catchUpHours: 12 });
  for (const routine of store.listRoutines()) store.deleteRoutine(routine.id);
});

const HOUR = 3_600_000;

const clockOf = (at: number): string => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const staleDaily = (now: number): import("../src/routine-store.js").RoutineInput["schedule"] => ({ kind: "daily", time: clockOf(now - 14 * HOUR) });

function makeRoutine(over: Partial<import("../src/routine-store.js").RoutineInput> = {}) {
  return store.createRoutine({
    name: "nightly check",
    prompt: "check the repo",
    workspace: "pilot",
    repo: null,
    cwd: null,
    runner: "claude",
    model: null,
    schedule: { kind: "daily", time: "09:00" },
    enabled: true,
    ...over,
  });
}

const finished = (id: string) =>
  waitFor(async () => {
    const run = store.getRoutineRun(id);
    return run && run.status !== "running" ? run : null;
  }, 15000);

const toasts = () => events.filter((item) => item.event === "toast");

describe("routines", () => {
  it("starts with no routine created by default", () => {
    assert.deepEqual(store.listRoutines(), []);
    assert.equal(store.unreadInboxCount(), 0);
  });

  it("does not fire while the Delegated plugin is off and keeps the slot due", () => {
    const routine = makeRoutine();
    const due = Date.now() - 30_000;
    store.advanceRoutine(routine.id, due, null);
    delegation.updateSettings({ features: { delegated: false } });
    try {
      const outcomes = routines.runSchedulerTick(Date.now());
      assert.deepEqual(outcomes.map((item) => item.action), ["blocked"]);
      assert.equal(store.listRoutineRuns(routine.id).length, 0);
      assert.equal(store.getRoutine(routine.id)?.nextFireAt, due);
    } finally {
      delegation.updateSettings({ features: { delegated: true } });
    }
  });

  it("runs an on-time routine through the delegation path and lands it unread in the inbox with its cost", async () => {
    const routine = makeRoutine();
    const now = Date.now();
    store.advanceRoutine(routine.id, now - 30_000, null);
    const [outcome] = routines.runSchedulerTick(now);
    assert.equal(outcome?.action, "run");
    const run = outcome?.run;
    assert.ok(run?.taskId);
    assert.equal(run.status, "running");
    const task = delegation.getTask(run.taskId);
    assert.equal(task?.createdBy, `routine:${routine.id}`);
    assert.equal(task?.workspace, "pilot");
    const done = await finished(run.id);
    assert.equal(done.status, "completed");
    assert.match(done.summary ?? "", /handled: check the repo/);
    assert.equal(done.read, false);
    assert.equal(done.cost.costUsd, 0.25);
    assert.equal(done.cost.tokensIn, 150);
    assert.equal(done.cost.tokensOut, 40);
    assert.equal(store.unreadInboxCount(), 1);
    assert.ok((store.getRoutine(routine.id)?.nextFireAt ?? 0) > now);
    assert.equal(toasts().length, 0);
    assert.ok(events.some((item) => item.event === "routines-inbox"));
    assert.equal(store.routineCost(routine.id).costUsd, 0.25);
  });

  it("catches up exactly once for slots missed within the window, never in a burst", async () => {
    const routine = makeRoutine({ schedule: { kind: "interval", everyHours: 1 } });
    const now = Date.now();
    const anchor = now - 5 * HOUR - 20 * 60_000;
    dbHandle?.prepare(`UPDATE hub_routines SET anchor_at = ? WHERE id = ?`).run(anchor, routine.id);
    store.advanceRoutine(routine.id, anchor + HOUR, null);
    const first = routines.runSchedulerTick(now);
    assert.deepEqual(first.map((item) => item.action), ["catch-up"]);
    assert.equal(first[0]?.run?.trigger, "catch-up");
    assert.equal(first[0]?.run?.missedSlots, 4);
    assert.equal(first[0]?.run?.dueAt, anchor + 5 * HOUR);
    assert.equal(store.getRoutine(routine.id)?.nextFireAt, anchor + 6 * HOUR);
    await finished(first[0]?.run?.id ?? "");
    assert.deepEqual(routines.runSchedulerTick(now + 1000).map((item) => item.action), []);
    assert.equal(store.listRoutineRuns(routine.id).length, 1);
  });

  it("records a missed entry, without running, when the slot is older than the window", () => {
    const now = Date.now();
    const routine = makeRoutine({ schedule: staleDaily(now) });
    store.advanceRoutine(routine.id, now - 20 * HOUR, null);
    const [outcome] = routines.runSchedulerTick(now);
    assert.equal(outcome?.action, "missed");
    assert.equal(outcome?.run?.status, "missed");
    assert.equal(outcome?.run?.taskId, null);
    assert.match(outcome?.run?.note ?? "", /within 12 h/);
    assert.ok((store.getRoutine(routine.id)?.nextFireAt ?? 0) > now);
    assert.equal(routines.runSchedulerTick(now + 1000).length, 0);
  });

  it("honours the catch-up hours setting", () => {
    store.setRoutineSettings({ catchUpHours: 0 });
    const routine = makeRoutine();
    const now = Date.now();
    store.advanceRoutine(routine.id, now - HOUR, null);
    assert.equal(routines.runSchedulerTick(now)[0]?.action, "missed");
  });

  it("marks inbox items read and unread", async () => {
    const now = Date.now();
    const routine = makeRoutine({ schedule: staleDaily(now) });
    store.advanceRoutine(routine.id, now - 20 * HOUR, null);
    routines.runSchedulerTick(now);
    const manual = routines.fireRoutine(routine, { trigger: "manual", dueAt: null });
    await finished(manual.id);
    const unreadBefore = store.unreadInboxCount();
    assert.ok(unreadBefore >= 2);
    const inbox = store.listInbox({ unreadOnly: true });
    const first = inbox[0];
    assert.ok(first);
    assert.equal(store.markInboxRead(first.id, true)?.read, true);
    assert.equal(store.unreadInboxCount(), unreadBefore - 1);
    assert.equal(store.listInbox({ unreadOnly: true }).some((item) => item.id === first.id), false);
    assert.equal(store.markInboxRead(first.id, false)?.read, false);
    assert.equal(store.unreadInboxCount(), unreadBefore);
    store.markAllInboxRead();
    assert.equal(store.unreadInboxCount(), 0);
    assert.ok(store.listInbox().length >= 2);
  });

  it("never broadcasts a toast and carries the failure on the routine-run event", async () => {
    const routine = makeRoutine();
    process.env.FAKE_CLAUDE_MODE = "error";
    let run;
    try {
      run = routines.fireRoutine(routine, { trigger: "manual", dueAt: null });
    } finally {
      delete process.env.FAKE_CLAUDE_MODE;
    }
    const done = await finished(run.id);
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /error_max_turns/);
    assert.equal(toasts().length, 0);
    const failedEvent = events.filter((item) => item.event === "routine-run").map((item) => item.data as { status: string; routineName: string | null; taskId: string | null; error: string | null }).pop();
    assert.equal(failedEvent?.status, "failed");
    assert.equal(failedEvent?.routineName, "nightly check");
    assert.equal(failedEvent?.taskId, done.taskId);
    assert.match(failedEvent?.error ?? "", /error_max_turns/);
  });

  it("skips a scheduled slot while the previous run is still going and refuses a second manual run", async () => {
    const routine = makeRoutine({ prompt: "sleep:1500" });
    const first = routines.fireRoutine(routine, { trigger: "manual", dueAt: null });
    assert.throws(() => routines.fireRoutine(routine, { trigger: "manual", dueAt: null }), /still running/);
    const now = Date.now();
    store.advanceRoutine(routine.id, now - 10_000, null);
    const [outcome] = routines.runSchedulerTick(now);
    assert.equal(outcome?.run?.status, "skipped");
    await finished(first.id);
  });

  it("runs a routine in a plain cwd outside any workspace", async () => {
    const routine = makeRoutine({ workspace: null, cwd: box.repoB });
    const run = routines.fireRoutine(routine, { trigger: "manual", dueAt: null });
    const done = await finished(run.id);
    assert.equal(done.status, "completed");
    assert.equal(delegation.getTask(done.taskId ?? "")?.cwd, box.repoB);
  });

  it("skips a plain-cwd routine while another task is running in the same folder and refuses a manual fire", async () => {
    const holder = makeRoutine({ name: "holder", workspace: null, cwd: box.repoB, prompt: "sleep:1500" });
    const waiting = makeRoutine({ name: "waiting", workspace: null, cwd: box.repoB });
    const first = routines.fireRoutine(holder, { trigger: "manual", dueAt: null });
    assert.throws(() => routines.fireRoutine(waiting, { trigger: "manual", dueAt: null }), /folder is busy/);
    const skipped = routines.fireRoutine(waiting, { trigger: "schedule", dueAt: Date.now() });
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.taskId, null);
    assert.equal(skipped.note, "folder busy with another running task");
    await finished(first.id);
    const after = routines.fireRoutine(waiting, { trigger: "manual", dueAt: null });
    assert.equal((await finished(after.id)).status, "completed");
  });

  it("marks routine runs left running by a crash as interrupted", () => {
    const routine = makeRoutine();
    const stuck = store.insertRoutineRun({ routineId: routine.id, taskId: null, trigger: "schedule", status: "running", dueAt: null });
    assert.ok(store.markRoutineRunsInterrupted() >= 1);
    assert.equal(store.getRoutineRun(stuck.id)?.status, "interrupted");
  });

  it("recomputes the next fire on schedule change and clears it when paused", () => {
    const routine = makeRoutine();
    const paused = store.updateRoutine(routine.id, { enabled: false });
    assert.equal(paused?.nextFireAt, null);
    const resumed = store.updateRoutine(routine.id, { enabled: true });
    assert.ok((resumed?.nextFireAt ?? 0) > Date.now());
    const hourly = store.updateRoutine(routine.id, { schedule: { kind: "interval", everyHours: 2 } });
    assert.ok(Math.abs((hourly?.nextFireAt ?? 0) - (Date.now() + 2 * HOUR)) < 5000);
  });
});

