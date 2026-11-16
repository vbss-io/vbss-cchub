import { basename } from "node:path";
import { config } from "./config.js";
import { createInternalTask, delegateTask, onRunFinished, startRun, type RunFinishedInfo } from "./delegation-launch.js";
import { getSettings, listReports, listTasks } from "./delegation-store.js";
import type { TaskRecord } from "./delegation-types.js";
import { decideDue, detectClockJump } from "./routine-schedule.js";
import {
  advanceRoutine,
  finishRoutineRun,
  getRoutineSettings,
  insertRoutineRun,
  listRoutines,
  markRoutineRunsInterrupted,
  runningRoutineRun,
  runningRoutineRunForTask,
  unreadInboxCount,
  type RoutineRecord,
  type RoutineRunRecord,
  type RoutineRunStatus,
  type RoutineTrigger,
} from "./routine-store.js";
import { broadcast } from "./sse.js";
import { isDirectory, samePath } from "./workspaces.js";

export const ROUTINE_SOURCE_PREFIX = "routine:";
const SUMMARY_MAX = 4000;
const EVENT_ERROR_MAX = 300;
const DEFAULT_TICK_MS = 30_000;
const DEFAULT_BOOT_DELAY_MS = 5_000;

export class RoutineGateError extends Error {
  readonly status = 409;
}

export const routineSource = (routineId: string): string => `${ROUTINE_SOURCE_PREFIX}${routineId}`;

export const routineIdOfTask = (task: Pick<TaskRecord, "createdBy">): string | null =>
  task.createdBy?.startsWith(ROUTINE_SOURCE_PREFIX) ? task.createdBy.slice(ROUTINE_SOURCE_PREFIX.length) : null;

export function routinesGate(): string | null {
  if (!config.delegationEnabled) return "delegation is disabled on this hub";
  if (!getSettings().features.delegated) return "the Delegated plugin is off";
  return null;
}

export function schedulerGate(): string | null {
  const gate = routinesGate();
  if (gate) return gate;
  if (config.previewMode && process.env.HUB_ROUTINES_IN_PREVIEW !== "1") return "scheduled routines do not fire in preview mode";
  return null;
}

function eventError(run: RoutineRunRecord): string | null {
  if (run.status !== "failed") return null;
  const detail = (run.error ?? "the run failed").replace(/\s+/g, " ").trim();
  return detail.length > EVENT_ERROR_MAX ? `${detail.slice(0, EVENT_ERROR_MAX)}…` : detail;
}

function broadcastInbox(run: RoutineRunRecord, name: string | null = null): void {
  broadcast("routine-run", {
    routineId: run.routineId,
    runId: run.id,
    taskId: run.taskId,
    status: run.status,
    read: run.read,
    routineName: run.routineName ?? name,
    error: eventError(run),
  });
  broadcast("routines-inbox", { unread: unreadInboxCount() });
  broadcast("routines", { changedAt: Date.now() });
}

function folderBusy(routine: RoutineRecord): boolean {
  if (routine.workspace || !routine.cwd) return false;
  const cwd = routine.cwd;
  return listTasks({ limit: 500, includeArchived: true }).some(
    (task) => (task.status === "running" || task.status === "pending") && task.isolation === "shared" && samePath(task.cwd, cwd),
  );
}

function launchRoutineTask(routine: RoutineRecord): TaskRecord {
  const source = routineSource(routine.id);
  if (routine.workspace) {
    return delegateTask({
      prompt: routine.prompt,
      workspace: routine.workspace,
      repo: routine.repo,
      runner: routine.runner,
      model: routine.model,
      permissionMode: null,
      sandbox: null,
      title: routine.name,
      source,
    }).task;
  }
  const cwd = routine.cwd ?? "";
  if (!isDirectory(cwd)) throw new Error(`working directory no longer exists: ${cwd}`);
  const task = createInternalTask({ title: routine.name, prompt: routine.prompt, workspace: basename(cwd) || cwd, cwd, addDirs: [], runner: routine.runner, createdBy: source });
  startRun(task, "launch", routine.prompt, routine.model, null);
  return task;
}

export interface FireOptions {
  trigger: RoutineTrigger;
  dueAt: number | null;
  note?: string | null;
  missedSlots?: number | null;
  now?: number;
}

export function fireRoutine(routine: RoutineRecord, options: FireOptions): RoutineRunRecord {
  const gate = routinesGate();
  if (gate) throw new RoutineGateError(gate);
  const now = options.now ?? Date.now();
  const busy = runningRoutineRun(routine.id);
  if (busy) {
    if (options.trigger === "manual") throw new RoutineGateError("this routine is still running");
    const skipped = insertRoutineRun({ routineId: routine.id, taskId: null, trigger: options.trigger, status: "skipped", dueAt: options.dueAt, startedAt: now, note: "the previous run was still in progress", missedSlots: options.missedSlots ?? null });
    broadcastInbox(skipped);
    return skipped;
  }
  if (folderBusy(routine)) {
    if (options.trigger === "manual") throw new RoutineGateError("the folder is busy with another running task");
    const skipped = insertRoutineRun({ routineId: routine.id, taskId: null, trigger: options.trigger, status: "skipped", dueAt: options.dueAt, startedAt: now, note: "folder busy with another running task", missedSlots: options.missedSlots ?? null });
    broadcastInbox(skipped);
    return skipped;
  }
  let task: TaskRecord;
  try {
    task = launchRoutineTask(routine);
  } catch (err) {
    const failed = insertRoutineRun({
      routineId: routine.id,
      taskId: null,
      trigger: options.trigger,
      status: "failed",
      dueAt: options.dueAt,
      startedAt: now,
      error: err instanceof Error ? err.message : String(err),
      note: options.note ?? null,
      missedSlots: options.missedSlots ?? null,
    });
    broadcastInbox(failed, routine.name);
    return failed;
  }
  const run = insertRoutineRun({ routineId: routine.id, taskId: task.id, trigger: options.trigger, status: "running", dueAt: options.dueAt, startedAt: now, note: options.note ?? null, missedSlots: options.missedSlots ?? null });
  advanceRoutine(routine.id, routine.nextFireAt, now);
  broadcast("routines", { changedAt: now });
  return run;
}

function summaryFor(info: RunFinishedInfo): string | null {
  const report = listReports({ taskId: info.task.id })
    .filter((item) => item.kind === "result")
    .pop();
  const text = report?.text ?? info.result ?? null;
  if (!text) return null;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX)}…` : text;
}

const STATUS_BY_OUTCOME: Record<string, RoutineRunStatus> = {
  completed: "completed",
  attention: "attention",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
};

export function handleRunFinished(info: RunFinishedInfo): RoutineRunRecord | null {
  if (routineIdOfTask(info.task) === null) return null;
  const pending = runningRoutineRunForTask(info.task.id);
  if (!pending) return null;
  const status = STATUS_BY_OUTCOME[info.status] ?? "failed";
  const finished = finishRoutineRun(pending.id, { status, summary: summaryFor(info), error: status === "completed" ? null : info.error });
  if (!finished) return null;
  broadcastInbox(finished, info.task.title);
  return finished;
}

export interface TickOutcome {
  routineId: string;
  action: "run" | "catch-up" | "missed" | "wait" | "blocked";
  run: RoutineRunRecord | null;
}

export function runSchedulerTick(now: number = Date.now(), resumed = false): TickOutcome[] {
  const gate = schedulerGate();
  const catchUpMs = getRoutineSettings().catchUpHours * 3_600_000;
  const outcomes: TickOutcome[] = [];
  for (const routine of listRoutines()) {
    if (!routine.enabled || routine.nextFireAt === null) continue;
    const decision = decideDue({ schedule: routine.schedule, anchor: routine.anchorAt, nextFireAt: routine.nextFireAt, now, catchUpMs });
    if (decision.action === "wait") continue;
    if (gate) {
      outcomes.push({ routineId: routine.id, action: "blocked", run: null });
      continue;
    }
    const why = resumed ? "the computer was asleep" : "the hub was off";
    if (decision.action === "missed") {
      advanceRoutine(routine.id, decision.nextFireAt, null);
      const hours = Math.round(((now - (decision.dueAt ?? now)) / 3_600_000) * 10) / 10;
      const missed = insertRoutineRun({
        routineId: routine.id,
        taskId: null,
        trigger: "schedule",
        status: "missed",
        dueAt: decision.dueAt,
        startedAt: now,
        note: `missed by ${hours} h while ${why}; catch-up runs only within ${getRoutineSettings().catchUpHours} h`,
        missedSlots: decision.missedSlots,
      });
      broadcastInbox(missed);
      outcomes.push({ routineId: routine.id, action: "missed", run: missed });
      continue;
    }
    advanceRoutine(routine.id, decision.nextFireAt, null);
    const advanced = { ...routine, nextFireAt: decision.nextFireAt };
    const trigger: RoutineTrigger = decision.action === "catch-up" ? "catch-up" : "schedule";
    const note = decision.action === "catch-up" ? `catch-up run: the slot was missed while ${why}` : decision.missedSlots > 0 ? `${decision.missedSlots} earlier slot(s) skipped while ${why}` : null;
    try {
      const run = fireRoutine(advanced, { trigger, dueAt: decision.dueAt, note, missedSlots: decision.missedSlots, now });
      outcomes.push({ routineId: routine.id, action: decision.action, run });
    } catch (err) {
      console.error(`routine ${routine.id} could not fire: ${String(err)}`);
      outcomes.push({ routineId: routine.id, action: "blocked", run: null });
    }
  }
  return outcomes;
}

let tickTimer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let lastTickAt: number | null = null;
let unsubscribe: (() => void) | null = null;

export function ensureRoutineListener(): void {
  if (unsubscribe) return;
  unsubscribe = onRunFinished((info) => {
    handleRunFinished(info);
  });
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function tick(tickMs: number): void {
  const now = Date.now();
  const resumed = detectClockJump(lastTickAt, now, tickMs);
  lastTickAt = now;
  if (resumed) console.log("routines: clock jump detected, checking missed routines");
  try {
    runSchedulerTick(now, resumed);
  } catch (err) {
    console.error(`routine scheduler tick failed: ${String(err)}`);
  }
}

export function startRoutineScheduler(): void {
  ensureRoutineListener();
  if (tickTimer) return;
  const interrupted = markRoutineRunsInterrupted();
  if (interrupted > 0) console.log(`marked ${interrupted} routine runs interrupted on restart`);
  const tickMs = Math.max(envMs("HUB_ROUTINES_TICK_MS", DEFAULT_TICK_MS), 50);
  bootTimer = setTimeout(() => tick(tickMs), envMs("HUB_ROUTINES_BOOT_DELAY_MS", DEFAULT_BOOT_DELAY_MS));
  bootTimer.unref();
  tickTimer = setInterval(() => tick(tickMs), tickMs);
  tickTimer.unref();
}

export function stopRoutineScheduler(): void {
  if (tickTimer) clearInterval(tickTimer);
  if (bootTimer) clearTimeout(bootTimer);
  tickTimer = null;
  bootTimer = null;
  lastTickAt = null;
}
