import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { s2InitRepo, s2Sandbox, s2StartHub, s2Until, type S2Hub } from "./helpers/s2-env.js";

const box = s2Sandbox("cch-s2-routines-", { HUB_DELEGATION: "1" });

const { db } = await import("../src/db.js");
const { abortActiveRuns } = await import("../src/delegation-launch.js");
const { config } = await import("../src/config.js");
const routines = await import("../src/routines.js");
const routineStore = await import("../src/routine-store.js");
const delegationStore = await import("../src/delegation-store.js");

let hub: S2Hub;

interface RoutineJson {
  id: string;
  name: string;
  enabled: boolean;
  running: boolean;
  workspace: string | null;
  repo: string | null;
  cwd: string | null;
  schedule: { kind: string };
  lastRun: { id: string; status: string } | null;
  runs?: { id: string; status: string }[];
}

interface RunJson {
  id: string;
  status: string;
  taskId: string | null;
}

before(async () => {
  s2InitRepo(box.repoA);
  routines.ensureRoutineListener();
  hub = await s2StartHub(box);
  const settings = await hub.http("PUT", "/delegation/settings", { workspacesRoot: box.root, autonomy: "full", features: { delegated: true } });
  assert.equal(settings.status, 200, settings.text);
});

after(async () => {
  abortActiveRuns("test over");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await hub.close();
  if (db.open) db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const errorOf = (json: unknown): string => (json as { error: string }).error;
const base = { name: "Nightly", prompt: "tidy up", schedule: { kind: "daily", time: "03:30" }, workspace: "pilot" };

async function createRoutine(extra: Record<string, unknown> = {}): Promise<RoutineJson> {
  const res = await hub.http("POST", "/delegation/routines", { ...base, ...extra });
  assert.equal(res.status, 201, res.text);
  return res.json as RoutineJson;
}

describe("routine settings and schedule preview", () => {
  it("reads and validates the catch-up window", async () => {
    const read = await hub.http("GET", "/delegation/routines/settings");
    assert.equal(read.status, 200);
    const written = await hub.http("PUT", "/delegation/routines/settings", { catchUpHours: 6 });
    assert.equal(written.status, 200, written.text);
    assert.equal((written.json as { catchUpHours: number }).catchUpHours, 6);
    for (const catchUpHours of ["6", 1.5, -1, 73]) {
      const bad = await hub.http("PUT", "/delegation/routines/settings", { catchUpHours });
      assert.equal(bad.status, 400);
      assert.match(errorOf(bad.json), /catchUpHours must be an integer between/);
    }
  });

  it("previews the next fire times and rejects bad schedules", async () => {
    const ok = await hub.http("POST", "/delegation/routines/schedule/preview", { schedule: { kind: "interval", everyHours: 4 } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((ok.json as { next: number[] }).next.length, 5);
    const bad = await hub.http("POST", "/delegation/routines/schedule/preview", { schedule: { kind: "hourly" } });
    assert.equal(bad.status, 400);
    assert.match(errorOf(bad.json), /schedule.kind must be one of/);
  });
});

describe("routine create and update", () => {
  it("creates a routine on a workspace and lists it with its gate", async () => {
    const routine = await createRoutine({ repo: "repo-a" });
    assert.equal(routine.workspace, "pilot");
    assert.equal(routine.repo, "repo-a");
    assert.equal(routine.running, false);
    const list = (await hub.http("GET", "/delegation/routines")).json as { routines: RoutineJson[]; gate: string | null; schedulerGate: string | null; unread: number };
    assert.ok(list.routines.some((item) => item.id === routine.id));
    assert.equal(list.gate, null);
    assert.equal(typeof list.unread, "number");
    const detail = await hub.http("GET", `/delegation/routines/${routine.id}`);
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray((detail.json as RoutineJson).runs));
  });

  it("creates a routine on an absolute folder", async () => {
    const routine = await createRoutine({ name: "Folder routine", workspace: undefined, cwd: box.repoB });
    assert.equal(routine.cwd, box.repoB);
    assert.equal(routine.workspace, null);
  });

  it("rejects bad create payloads with a precise message", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ name: "" }, /name must be 1-80 characters on one line/],
      [{ name: "a\nb" }, /name must be 1-80 characters on one line/],
      [{ name: "x".repeat(81) }, /name must be 1-80 characters on one line/],
      [{ prompt: "" }, /prompt must be 1-20000 characters/],
      [{ prompt: "p".repeat(20_001) }, /prompt must be 1-20000 characters/],
      [{ runner: "gpt" }, /runner must be one of/],
      [{ schedule: "daily" }, /schedule must be an object/],
      [{ enabled: "yes" }, /enabled must be a boolean/],
      [{ cwd: box.repoB }, /either workspace .* or cwd, not both/],
      [{ workspace: undefined, cwd: "relative/path" }, /cwd must be an existing absolute directory/],
      [{ workspace: undefined, cwd: join(box.tmp, "missing") }, /cwd must be an existing absolute directory/],
      [{ workspace: undefined }, /workspace or cwd required/],
    ];
    for (const [patch, message] of cases) {
      const res = await hub.http("POST", "/delegation/routines", { ...base, ...patch });
      assert.equal(res.status, 400, res.text);
      assert.match(errorOf(res.json), message);
    }
    const ghost = await hub.http("POST", "/delegation/routines", { ...base, workspace: "ghost" });
    assert.equal(ghost.status, 404);
    const withModel = await createRoutine({ name: "Codex routine", runner: "codex", model: "gpt-x", enabled: false });
    assert.equal(withModel.enabled, false);
  });

  it("patches fields and switches targets", async () => {
    const routine = await createRoutine({ name: "To patch", repo: "repo-a" });
    const renamed = await hub.http("PATCH", `/delegation/routines/${routine.id}`, { name: "Patched", enabled: false });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal((renamed.json as RoutineJson).name, "Patched");
    assert.equal((renamed.json as RoutineJson).repo, "repo-a");
    const retarget = await hub.http("PATCH", `/delegation/routines/${routine.id}`, { repo: "repo-b" });
    assert.equal(retarget.status, 200, retarget.text);
    assert.equal((retarget.json as RoutineJson).repo, "repo-b");
    const toFolder = await hub.http("PATCH", `/delegation/routines/${routine.id}`, { cwd: box.repoA });
    assert.equal((toFolder.json as RoutineJson).cwd, box.repoA);
    const keepFolder = await hub.http("PATCH", `/delegation/routines/${routine.id}`, { name: "Still folder" });
    assert.equal((keepFolder.json as RoutineJson).cwd, box.repoA);
    const repoNeedsWorkspace = await hub.http("PATCH", `/delegation/routines/${routine.id}`, { repo: "repo-a" });
    assert.equal(repoNeedsWorkspace.status, 400);
    assert.match(errorOf(repoNeedsWorkspace.json), /repo needs a workspace/);
    const back = await hub.http("PATCH", `/delegation/routines/${routine.id}`, { workspace: "pilot" });
    assert.equal((back.json as RoutineJson).workspace, "pilot");
    assert.equal((back.json as RoutineJson).repo, null);
    assert.equal((await hub.http("PATCH", "/delegation/routines/ghost", { name: "x" })).status, 404);
    const emptyName = await hub.http("PATCH", `/delegation/routines/${routine.id}`, { name: "" });
    assert.equal(emptyName.status, 400);
  });
});

describe("routine runs, inbox and delete", () => {
  it("runs a routine manually, lists the run and fills the inbox", async () => {
    const routine = await createRoutine({ name: "Run me", prompt: "sleep:700" });
    const started = await hub.http("POST", `/delegation/routines/${routine.id}/run`);
    assert.equal(started.status, 201, started.text);
    const run = started.json as RunJson;
    assert.ok(run.taskId);
    const again = await hub.http("POST", `/delegation/routines/${routine.id}/run`);
    assert.equal(again.status, 409);
    assert.match(errorOf(again.json), /still running/);
    const busyDelete = await hub.http("DELETE", `/delegation/routines/${routine.id}`);
    assert.equal(busyDelete.status, 409);
    const done = await s2Until(async () => {
      const runs = (await hub.http("GET", `/delegation/routines/${routine.id}/runs?limit=5`)).json as RunJson[];
      return runs.find((item) => item.id === run.id && item.status !== "running") ?? null;
    }, 20_000);
    assert.equal(done.status, "completed");
    const inbox = (await hub.http("GET", "/delegation/routines/inbox?limit=10")).json as { unread: number; items: { id: string; read: boolean }[] };
    const item = inbox.items.find((entry) => entry.id === run.id);
    assert.ok(item, "run is in the inbox");
    assert.equal(item.read, false);
    const read = await hub.http("POST", `/delegation/routines/inbox/${run.id}/read`);
    assert.equal(read.status, 200, read.text);
    const unreadOnly = (await hub.http("GET", "/delegation/routines/inbox?unread=1")).json as { items: { id: string }[] };
    assert.ok(!unreadOnly.items.some((entry) => entry.id === run.id));
    const unread = await hub.http("POST", `/delegation/routines/inbox/${run.id}/unread`);
    assert.equal((unread.json as { item: { read: boolean } }).item.read, false);
    const all = await hub.http("POST", "/delegation/routines/inbox/read-all");
    assert.equal(all.status, 200);
    assert.equal((all.json as { unread: number }).unread, 0);
    assert.equal((await hub.http("POST", "/delegation/routines/inbox/ghost/read")).status, 404);
    const removed = await hub.http("DELETE", `/delegation/routines/${routine.id}`);
    assert.equal(removed.status, 200);
    assert.equal((await hub.http("GET", `/delegation/routines/${routine.id}`)).status, 404);
    assert.equal((await hub.http("GET", `/delegation/routines/${routine.id}/runs`)).status, 404);
    assert.equal((await hub.http("DELETE", `/delegation/routines/${routine.id}`)).status, 404);
    assert.equal((await hub.http("POST", `/delegation/routines/${routine.id}/run`)).status, 404);
  });

  it("refuses an in-progress inbox item as unreadable", async () => {
    const routine = await createRoutine({ name: "In progress", prompt: "sleep:30000" });
    const run = (await hub.http("POST", `/delegation/routines/${routine.id}/run`)).json as RunJson;
    const mark = await hub.http("POST", `/delegation/routines/inbox/${run.id}/read`);
    assert.equal(mark.status, 409);
    assert.match(errorOf(mark.json), /still in progress/);
    const concurrent = await hub.http("POST", `/delegation/routines/${(await createRoutine({ name: "Second" })).id}/run`);
    assert.equal(concurrent.status, 201, concurrent.text);
    await hub.http("POST", `/delegation/tasks/${run.taskId}/cancel`);
    await s2Until(async () => {
      const runs = (await hub.http("GET", `/delegation/routines/${routine.id}/runs`)).json as RunJson[];
      return runs.every((item) => item.status !== "running") ? true : null;
    }, 20_000);
  });

  it("fires scheduled runs directly: skips while running, fails on a missing folder, reports the gates", async () => {
    const folder = join(box.tmp, "routine-folder");
    s2InitRepo(folder);
    const routine = routineStore.createRoutine({ name: "Direct", prompt: "sleep:30000", runner: "claude", model: null, schedule: { kind: "daily", time: "04:00" }, enabled: true, workspace: null, repo: null, cwd: folder });
    const first = routines.fireRoutine(routine, { trigger: "manual", dueAt: null });
    assert.equal(first.status, "running");
    const skipped = routines.fireRoutine(routine, { trigger: "schedule", dueAt: Date.now() });
    assert.equal(skipped.status, "skipped");
    assert.match(skipped.note ?? "", /previous run was still in progress/);
    const sibling = routineStore.createRoutine({ name: "Sibling", prompt: "x", runner: "claude", model: null, schedule: { kind: "daily", time: "05:00" }, enabled: true, workspace: null, repo: null, cwd: folder });
    assert.throws(() => routines.fireRoutine(sibling, { trigger: "manual", dueAt: null }), /folder is busy/);
    const siblingSkipped = routines.fireRoutine(sibling, { trigger: "schedule", dueAt: null });
    assert.equal(siblingSkipped.status, "skipped");
    assert.match(siblingSkipped.note ?? "", /folder busy/);
    const taskId = first.taskId as string;
    await hub.http("POST", `/delegation/tasks/${taskId}/cancel`);
    await s2Until(() => (routineStore.runningRoutineRun(routine.id) === null ? true : null), 20_000);

    const vanishing = join(box.tmp, "vanishing");
    s2InitRepo(vanishing);
    const doomed = routineStore.createRoutine({ name: "Doomed", prompt: "x", runner: "claude", model: null, schedule: { kind: "daily", time: "06:00" }, enabled: true, workspace: null, repo: null, cwd: vanishing });
    rmSync(vanishing, { recursive: true, force: true });
    const failed = routines.fireRoutine(doomed, { trigger: "schedule", dueAt: 5, note: "n", missedSlots: 2 });
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", /working directory no longer exists/);

    const original = config.delegationEnabled;
    (config as { delegationEnabled: boolean }).delegationEnabled = false;
    try {
      assert.throws(() => routines.fireRoutine(routine, { trigger: "manual", dueAt: null }), /delegation is disabled/);
      assert.match(routines.routinesGate() ?? "", /delegation is disabled/);
      assert.equal(routines.schedulerGate(), routines.routinesGate());
    } finally {
      (config as { delegationEnabled: boolean }).delegationEnabled = original;
    }
    delegationStore.updateSettings({ features: { delegated: false } });
    assert.match(routines.routinesGate() ?? "", /Delegated plugin is off/);
    delegationStore.updateSettings({ features: { delegated: true } });
    assert.equal(routines.routinesGate(), null);
    const preview = config.previewMode;
    (config as { previewMode: boolean }).previewMode = true;
    try {
      assert.match(routines.schedulerGate() ?? "", /do not fire in preview mode/);
    } finally {
      (config as { previewMode: boolean }).previewMode = preview;
    }
  });
});

describe("routine scheduler", () => {
  it("runs due routines, catches up late ones, records missed slots and reports blocked ones", async () => {
    const anchor = Date.now();
    const hour = 3_600_000;
    const make = (name: string) =>
      routineStore.createRoutine({ name, prompt: "tick", runner: "claude", model: null, schedule: { kind: "interval", everyHours: 1 }, enabled: true, workspace: "pilot", repo: null, cwd: null }, anchor);
    routineStore.setRoutineSettings({ catchUpHours: 72 });
    const onTime = make("On time");
    const first = routines.runSchedulerTick(anchor + hour + 1000);
    assert.equal(first.find((item) => item.routineId === onTime.id)?.action, "run");
    await s2Until(() => (routineStore.runningRoutineRun(onTime.id) === null ? true : null), 20_000);
    const late = make("Late");
    const second = routines.runSchedulerTick(anchor + hour + 30 * 60_000, true);
    const lateOutcome = second.find((item) => item.routineId === late.id);
    assert.equal(lateOutcome?.action, "catch-up");
    assert.match(lateOutcome?.run?.note ?? "", /catch-up run: the slot was missed while the computer was asleep/);
    assert.ok(!second.some((item) => item.routineId === onTime.id));
    await s2Until(() => (routineStore.runningRoutineRun(late.id) === null ? true : null), 20_000);
    routineStore.setRoutineSettings({ catchUpHours: 0 });
    const missed = make("Missed");
    const third = routines.runSchedulerTick(anchor + hour + 30 * 60_000);
    const missedOutcome = third.find((item) => item.routineId === missed.id);
    assert.equal(missedOutcome?.action, "missed");
    assert.equal(missedOutcome?.run?.status, "missed");
    assert.match(missedOutcome?.run?.note ?? "", /missed by .* h while the hub was off; catch-up runs only within 0 h/);
    const original = config.delegationEnabled;
    (config as { delegationEnabled: boolean }).delegationEnabled = false;
    try {
      const blocked = routines.runSchedulerTick(anchor + 10 * 86_400_000);
      assert.ok(blocked.length >= 3 && blocked.every((item) => item.action === "blocked" && item.run === null));
    } finally {
      (config as { delegationEnabled: boolean }).delegationEnabled = original;
    }
    routineStore.setRoutineSettings({ catchUpHours: 12 });
  });

  it("starts and stops the timers and marks interrupted runs", async () => {
    process.env.HUB_ROUTINES_TICK_MS = "60";
    process.env.HUB_ROUTINES_BOOT_DELAY_MS = "0";
    try {
      routines.startRoutineScheduler();
      routines.startRoutineScheduler();
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      routines.stopRoutineScheduler();
      delete process.env.HUB_ROUTINES_TICK_MS;
      delete process.env.HUB_ROUTINES_BOOT_DELAY_MS;
    }
    assert.equal(routines.routineIdOfTask({ createdBy: "routine:abc" }), "abc");
    assert.equal(routines.routineIdOfTask({ createdBy: null }), null);
    assert.equal(routines.routineSource("abc"), "routine:abc");
  });

  it("ignores finished tasks that are not routine runs", () => {
    const task = delegationStore.createTask({ title: "plain", prompt: "p", workspace: "pilot", repo: null, cwd: box.repoA, addDirs: [], runner: "claude", model: null, permissionMode: null, sandbox: null, createdBy: null, originSessionId: null, originClient: null });
    const outcome = routines.handleRunFinished({ task, runId: "r", kind: "launch", status: "completed", result: "x", error: null, costUsd: null });
    assert.equal(outcome, null);
    const routineTask = { ...task, createdBy: "routine:ghost" };
    assert.equal(routines.handleRunFinished({ task: routineTask, runId: "r", kind: "launch", status: "completed", result: "x", error: null, costUsd: null }), null);
  });
});
