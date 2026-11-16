import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { addCosts, EMPTY_COST, getSetting, setSetting, taskCost } from "./delegation-store.js";
import type { CostTotals, Runner } from "./delegation-types.js";
import { nextFireAfter, type RoutineSchedule } from "./routine-schedule.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS hub_routines (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    prompt        TEXT NOT NULL,
    workspace     TEXT,
    repo          TEXT,
    cwd           TEXT,
    runner        TEXT NOT NULL,
    model         TEXT,
    schedule      TEXT NOT NULL,
    enabled       INTEGER NOT NULL,
    anchor_at     INTEGER NOT NULL,
    next_fire_at  INTEGER,
    last_fired_at INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hub_routine_runs (
    id           TEXT PRIMARY KEY,
    routine_id   TEXT NOT NULL,
    task_id      TEXT,
    trigger      TEXT NOT NULL,
    status       TEXT NOT NULL,
    due_at       INTEGER,
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER,
    summary      TEXT,
    error        TEXT,
    note         TEXT,
    missed_slots INTEGER,
    read_at      INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_hub_routine_runs_routine ON hub_routine_runs(routine_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_hub_routine_runs_task ON hub_routine_runs(task_id);
`);

export const ROUTINE_TRIGGERS = ["schedule", "catch-up", "manual"] as const;
export type RoutineTrigger = (typeof ROUTINE_TRIGGERS)[number];

export const ROUTINE_RUN_STATUSES = ["running", "completed", "attention", "failed", "cancelled", "interrupted", "missed", "skipped"] as const;
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number];

export interface RoutineRecord {
  id: string;
  name: string;
  prompt: string;
  workspace: string | null;
  repo: string | null;
  cwd: string | null;
  runner: Runner;
  model: string | null;
  schedule: RoutineSchedule;
  enabled: boolean;
  anchorAt: number;
  nextFireAt: number | null;
  lastFiredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRunRecord {
  id: string;
  routineId: string;
  routineName: string | null;
  taskId: string | null;
  trigger: RoutineTrigger;
  status: RoutineRunStatus;
  dueAt: number | null;
  startedAt: number;
  finishedAt: number | null;
  summary: string | null;
  error: string | null;
  note: string | null;
  missedSlots: number | null;
  read: boolean;
  readAt: number | null;
  cost: CostTotals;
}

interface RoutineRow {
  id: string;
  name: string;
  prompt: string;
  workspace: string | null;
  repo: string | null;
  cwd: string | null;
  runner: string;
  model: string | null;
  schedule: string;
  enabled: number;
  anchor_at: number;
  next_fire_at: number | null;
  last_fired_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RoutineRunRow {
  id: string;
  routine_id: string;
  routine_name: string | null;
  task_id: string | null;
  trigger: string;
  status: string;
  due_at: number | null;
  started_at: number;
  finished_at: number | null;
  summary: string | null;
  error: string | null;
  note: string | null;
  missed_slots: number | null;
  read_at: number | null;
}

const FALLBACK_SCHEDULE: RoutineSchedule = { kind: "daily", time: "09:00" };

function parseStoredSchedule(raw: string): RoutineSchedule {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && "kind" in parsed ? (parsed as RoutineSchedule) : FALLBACK_SCHEDULE;
  } catch {
    return FALLBACK_SCHEDULE;
  }
}

const toRoutine = (row: RoutineRow): RoutineRecord => ({
  id: row.id,
  name: row.name,
  prompt: row.prompt,
  workspace: row.workspace,
  repo: row.repo,
  cwd: row.cwd,
  runner: row.runner === "codex" ? "codex" : "claude",
  model: row.model,
  schedule: parseStoredSchedule(row.schedule),
  enabled: row.enabled === 1,
  anchorAt: row.anchor_at,
  nextFireAt: row.next_fire_at,
  lastFiredAt: row.last_fired_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toRoutineRun = (row: RoutineRunRow): RoutineRunRecord => ({
  id: row.id,
  routineId: row.routine_id,
  routineName: row.routine_name,
  taskId: row.task_id,
  trigger: (ROUTINE_TRIGGERS as readonly string[]).includes(row.trigger) ? (row.trigger as RoutineTrigger) : "schedule",
  status: (ROUTINE_RUN_STATUSES as readonly string[]).includes(row.status) ? (row.status as RoutineRunStatus) : "failed",
  dueAt: row.due_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  summary: row.summary,
  error: row.error,
  note: row.note,
  missedSlots: row.missed_slots,
  read: row.read_at !== null,
  readAt: row.read_at,
  cost: row.task_id ? taskCost(row.task_id) : { ...EMPTY_COST },
});

const RUN_SELECT = `SELECT rr.*, r.name AS routine_name FROM hub_routine_runs rr LEFT JOIN hub_routines r ON r.id = rr.routine_id`;

const insertRoutineStmt = db.prepare(`
  INSERT INTO hub_routines (id, name, prompt, workspace, repo, cwd, runner, model, schedule, enabled, anchor_at, next_fire_at, last_fired_at, created_at, updated_at)
  VALUES (@id, @name, @prompt, @workspace, @repo, @cwd, @runner, @model, @schedule, @enabled, @anchorAt, @nextFireAt, NULL, @now, @now)
`);
const getRoutineStmt = db.prepare(`SELECT * FROM hub_routines WHERE id = ?`);
const listRoutinesStmt = db.prepare(`SELECT * FROM hub_routines ORDER BY created_at ASC, rowid ASC`);
const updateRoutineStmt = db.prepare(`
  UPDATE hub_routines SET name = @name, prompt = @prompt, workspace = @workspace, repo = @repo, cwd = @cwd, runner = @runner, model = @model,
    schedule = @schedule, enabled = @enabled, anchor_at = @anchorAt, next_fire_at = @nextFireAt, updated_at = @now
  WHERE id = @id
`);
const deleteRoutineStmt = db.prepare(`DELETE FROM hub_routines WHERE id = ?`);
const deleteRoutineRunsStmt = db.prepare(`DELETE FROM hub_routine_runs WHERE routine_id = ?`);
const advanceRoutineStmt = db.prepare(`UPDATE hub_routines SET next_fire_at = @nextFireAt, last_fired_at = COALESCE(@firedAt, last_fired_at) WHERE id = @id`);
const insertRunStmt = db.prepare(`
  INSERT INTO hub_routine_runs (id, routine_id, task_id, trigger, status, due_at, started_at, finished_at, summary, error, note, missed_slots, read_at)
  VALUES (@id, @routineId, @taskId, @trigger, @status, @dueAt, @startedAt, @finishedAt, @summary, @error, @note, @missedSlots, NULL)
`);
const getRunStmt = db.prepare(`${RUN_SELECT} WHERE rr.id = ?`);
const runningForTaskStmt = db.prepare(`${RUN_SELECT} WHERE rr.task_id = ? AND rr.status = 'running' LIMIT 1`);
const runningForRoutineStmt = db.prepare(`${RUN_SELECT} WHERE rr.routine_id = ? AND rr.status = 'running' ORDER BY rr.started_at DESC LIMIT 1`);
const runsForRoutineStmt = db.prepare(`${RUN_SELECT} WHERE rr.routine_id = ? ORDER BY rr.started_at DESC, rr.rowid DESC LIMIT ?`);
const lastRunForRoutineStmt = db.prepare(`${RUN_SELECT} WHERE rr.routine_id = ? ORDER BY rr.started_at DESC, rr.rowid DESC LIMIT 1`);
const finishRunStmt = db.prepare(`
  UPDATE hub_routine_runs SET status = @status, finished_at = @finishedAt, summary = @summary, error = @error WHERE id = @id AND status = 'running'
`);
const inboxStmt = db.prepare(`${RUN_SELECT} WHERE rr.status != 'running' ORDER BY COALESCE(rr.finished_at, rr.started_at) DESC, rr.rowid DESC LIMIT ?`);
const inboxUnreadStmt = db.prepare(`${RUN_SELECT} WHERE rr.status != 'running' AND rr.read_at IS NULL ORDER BY COALESCE(rr.finished_at, rr.started_at) DESC, rr.rowid DESC LIMIT ?`);
const unreadCountStmt = db.prepare(`SELECT COUNT(*) AS count FROM hub_routine_runs WHERE status != 'running' AND read_at IS NULL`);
const markReadStmt = db.prepare(`UPDATE hub_routine_runs SET read_at = @readAt WHERE id = @id AND status != 'running'`);
const markAllReadStmt = db.prepare(`UPDATE hub_routine_runs SET read_at = @readAt WHERE status != 'running' AND read_at IS NULL`);
const interruptRunsStmt = db.prepare(`
  UPDATE hub_routine_runs SET status = 'interrupted', finished_at = @now, error = COALESCE(error, 'hub restarted while the routine was running') WHERE status = 'running'
`);
const taskIdsForRoutineStmt = db.prepare(`SELECT task_id FROM hub_routine_runs WHERE routine_id = ? AND task_id IS NOT NULL`);

export interface RoutineInput {
  name: string;
  prompt: string;
  workspace: string | null;
  repo: string | null;
  cwd: string | null;
  runner: Runner;
  model: string | null;
  schedule: RoutineSchedule;
  enabled: boolean;
}

export function createRoutine(input: RoutineInput, now: number = Date.now()): RoutineRecord {
  const id = randomUUID();
  insertRoutineStmt.run({
    id,
    name: input.name,
    prompt: input.prompt,
    workspace: input.workspace,
    repo: input.repo,
    cwd: input.cwd,
    runner: input.runner,
    model: input.model,
    schedule: JSON.stringify(input.schedule),
    enabled: input.enabled ? 1 : 0,
    anchorAt: now,
    nextFireAt: input.enabled ? nextFireAfter(input.schedule, now, now) : null,
    now,
  });
  return getRoutine(id) as RoutineRecord;
}

export function getRoutine(id: string): RoutineRecord | null {
  const row = getRoutineStmt.get(id) as RoutineRow | undefined;
  return row ? toRoutine(row) : null;
}

export function listRoutines(): RoutineRecord[] {
  return (listRoutinesStmt.all() as RoutineRow[]).map(toRoutine);
}

export function updateRoutine(id: string, patch: Partial<RoutineInput>, now: number = Date.now()): RoutineRecord | null {
  const current = getRoutine(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  const scheduleChanged = patch.schedule !== undefined && JSON.stringify(patch.schedule) !== JSON.stringify(current.schedule);
  const anchorAt = scheduleChanged ? now : current.anchorAt;
  const reschedule = scheduleChanged || (patch.enabled === true && !current.enabled) || (next.enabled && current.nextFireAt === null);
  const nextFireAt = !next.enabled ? null : reschedule ? nextFireAfter(next.schedule, now, anchorAt) : current.nextFireAt;
  updateRoutineStmt.run({
    id,
    name: next.name,
    prompt: next.prompt,
    workspace: next.workspace,
    repo: next.repo,
    cwd: next.cwd,
    runner: next.runner,
    model: next.model,
    schedule: JSON.stringify(next.schedule),
    enabled: next.enabled ? 1 : 0,
    anchorAt,
    nextFireAt,
    now,
  });
  return getRoutine(id);
}

export function deleteRoutine(id: string): boolean {
  const remove = db.transaction(() => {
    deleteRoutineRunsStmt.run(id);
    return deleteRoutineStmt.run(id).changes > 0;
  });
  return remove();
}

export function advanceRoutine(id: string, nextFireAt: number | null, firedAt: number | null): void {
  advanceRoutineStmt.run({ id, nextFireAt, firedAt });
}

export function insertRoutineRun(input: {
  routineId: string;
  taskId: string | null;
  trigger: RoutineTrigger;
  status: RoutineRunStatus;
  dueAt: number | null;
  startedAt?: number;
  summary?: string | null;
  error?: string | null;
  note?: string | null;
  missedSlots?: number | null;
}): RoutineRunRecord {
  const id = randomUUID();
  const startedAt = input.startedAt ?? Date.now();
  insertRunStmt.run({
    id,
    routineId: input.routineId,
    taskId: input.taskId,
    trigger: input.trigger,
    status: input.status,
    dueAt: input.dueAt,
    startedAt,
    finishedAt: input.status === "running" ? null : startedAt,
    summary: input.summary ?? null,
    error: input.error ?? null,
    note: input.note ?? null,
    missedSlots: input.missedSlots ?? null,
  });
  return getRoutineRun(id) as RoutineRunRecord;
}

export function getRoutineRun(id: string): RoutineRunRecord | null {
  const row = getRunStmt.get(id) as RoutineRunRow | undefined;
  return row ? toRoutineRun(row) : null;
}

export function runningRoutineRunForTask(taskId: string): RoutineRunRecord | null {
  const row = runningForTaskStmt.get(taskId) as RoutineRunRow | undefined;
  return row ? toRoutineRun(row) : null;
}

export function runningRoutineRun(routineId: string): RoutineRunRecord | null {
  const row = runningForRoutineStmt.get(routineId) as RoutineRunRow | undefined;
  return row ? toRoutineRun(row) : null;
}

export function lastRoutineRun(routineId: string): RoutineRunRecord | null {
  const row = lastRunForRoutineStmt.get(routineId) as RoutineRunRow | undefined;
  return row ? toRoutineRun(row) : null;
}

export function listRoutineRuns(routineId: string, limit = 50): RoutineRunRecord[] {
  return (runsForRoutineStmt.all(routineId, Math.min(Math.max(limit, 1), 500)) as RoutineRunRow[]).map(toRoutineRun);
}

export function finishRoutineRun(id: string, input: { status: RoutineRunStatus; summary: string | null; error: string | null }, now: number = Date.now()): RoutineRunRecord | null {
  if (finishRunStmt.run({ id, status: input.status, finishedAt: now, summary: input.summary, error: input.error }).changes === 0) return null;
  return getRoutineRun(id);
}

export function listInbox(options: { unreadOnly?: boolean; limit?: number } = {}): RoutineRunRecord[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  return ((options.unreadOnly ? inboxUnreadStmt : inboxStmt).all(limit) as RoutineRunRow[]).map(toRoutineRun);
}

export function unreadInboxCount(): number {
  return (unreadCountStmt.get() as { count: number }).count;
}

export function markInboxRead(id: string, read: boolean, now: number = Date.now()): RoutineRunRecord | null {
  if (markReadStmt.run({ id, readAt: read ? now : null }).changes === 0) return null;
  return getRoutineRun(id);
}

export function markAllInboxRead(now: number = Date.now()): number {
  return markAllReadStmt.run({ readAt: now }).changes;
}

export function markRoutineRunsInterrupted(now: number = Date.now()): number {
  return interruptRunsStmt.run({ now }).changes;
}

export function routineCost(routineId: string): CostTotals {
  const ids = [...new Set((taskIdsForRoutineStmt.all(routineId) as { task_id: string }[]).map((row) => row.task_id))];
  return addCosts(ids.map(taskCost));
}

export const CATCH_UP_HOURS_KEY = "routines.catchUpHours";
export const CATCH_UP_HOURS_DEFAULT = 12;
export const CATCH_UP_HOURS_MIN = 0;
export const CATCH_UP_HOURS_MAX = 72;

export interface RoutineSettings {
  catchUpHours: number;
}

export function getRoutineSettings(): RoutineSettings {
  const raw = getSetting(CATCH_UP_HOURS_KEY);
  const value = raw === null ? Number.NaN : Number(raw);
  const catchUpHours = Number.isInteger(value) && value >= CATCH_UP_HOURS_MIN && value <= CATCH_UP_HOURS_MAX ? value : CATCH_UP_HOURS_DEFAULT;
  return { catchUpHours };
}

export function setRoutineSettings(patch: Partial<RoutineSettings>): RoutineSettings {
  if (patch.catchUpHours !== undefined) setSetting(CATCH_UP_HOURS_KEY, String(patch.catchUpHours));
  return getRoutineSettings();
}
