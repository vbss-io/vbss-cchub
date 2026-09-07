import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import type { CodexRunLink } from "./codex-sessions.js";
import { config } from "./config.js";
import { db } from "./db.js";
import type {
  CodexSandbox,
  DelegationSettings,
  OriginClient,
  PermissionMode,
  ReportKind,
  ReportRecord,
  RunEventRecord,
  RunKind,
  Runner,
  RunRecord,
  TaskDetail,
  TaskRecord,
  TaskStatus,
} from "./delegation-types.js";
import { RUN_TIMEOUT_DEFAULT, RUN_TIMEOUT_MAX, RUN_TIMEOUT_MIN } from "./delegation-types.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS hub_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS hub_tasks (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    prompt            TEXT NOT NULL,
    workspace         TEXT NOT NULL,
    repo              TEXT,
    cwd               TEXT NOT NULL,
    add_dirs          TEXT NOT NULL,
    runner            TEXT NOT NULL,
    requested_model   TEXT,
    permission_mode   TEXT,
    sandbox           TEXT,
    status            TEXT NOT NULL,
    session_id        TEXT,
    created_by        TEXT,
    origin_session_id TEXT,
    origin_client     TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hub_runs (
    id                TEXT PRIMARY KEY,
    task_id           TEXT NOT NULL,
    seq               INTEGER NOT NULL,
    kind              TEXT NOT NULL,
    runner            TEXT NOT NULL,
    prompt            TEXT NOT NULL,
    requested_model   TEXT,
    effective_model   TEXT,
    permission_mode   TEXT,
    status            TEXT NOT NULL,
    session_id        TEXT,
    result            TEXT,
    error             TEXT,
    exit_code         INTEGER,
    started_at        INTEGER NOT NULL,
    finished_at       INTEGER,
    UNIQUE(task_id, seq)
  );
  CREATE TABLE IF NOT EXISTS hub_reports (
    id          TEXT PRIMARY KEY,
    task_id     TEXT,
    session_id  TEXT,
    workspace   TEXT,
    kind        TEXT NOT NULL,
    text        TEXT NOT NULL,
    source      TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hub_reports_task ON hub_reports(task_id, created_at);
  CREATE TABLE IF NOT EXISTS hub_run_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL,
    task_id     TEXT NOT NULL,
    kind        TEXT NOT NULL,
    text        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hub_run_events_run ON hub_run_events(run_id, id);
`);

const hubTaskColumns = new Set(
  (db.prepare(`PRAGMA table_info(hub_tasks)`).all() as { name: string }[]).map((column) => column.name),
);
for (const [name, type] of [
  ["origin_session_id", "TEXT"],
  ["origin_client", "TEXT"],
  ["archived_at", "INTEGER"],
] as const) {
  if (!hubTaskColumns.has(name)) db.exec(`ALTER TABLE hub_tasks ADD COLUMN ${name} ${type}`);
}

const MAX_EVENTS_PER_RUN = 2_000;
const MAX_EVENT_TEXT = 20_000;

interface TaskRow {
  id: string;
  title: string;
  prompt: string;
  workspace: string;
  repo: string | null;
  cwd: string;
  add_dirs: string;
  runner: string;
  requested_model: string | null;
  permission_mode: string | null;
  sandbox: string | null;
  status: string;
  session_id: string | null;
  created_by: string | null;
  origin_session_id: string | null;
  origin_client: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  last_error: string | null;
  runs_count: number;
}

interface RunRow {
  id: string;
  task_id: string;
  seq: number;
  kind: string;
  runner: string;
  prompt: string;
  requested_model: string | null;
  effective_model: string | null;
  permission_mode: string | null;
  status: string;
  session_id: string | null;
  result: string | null;
  error: string | null;
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
}

interface ReportRow {
  id: string;
  task_id: string | null;
  session_id: string | null;
  workspace: string | null;
  kind: string;
  text: string;
  source: string | null;
  created_at: number;
}

interface RunEventRow {
  id: number;
  run_id: string;
  task_id: string;
  kind: string;
  text: string;
  created_at: number;
}

const parseDirs = (raw: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

const toTask = (row: TaskRow): TaskRecord => ({
  id: row.id,
  title: row.title,
  prompt: row.prompt,
  workspace: row.workspace,
  repo: row.repo,
  cwd: row.cwd,
  addDirs: parseDirs(row.add_dirs),
  runner: row.runner as Runner,
  requestedModel: row.requested_model,
  permissionMode: row.permission_mode as PermissionMode | null,
  sandbox: row.sandbox as CodexSandbox | null,
  status: row.status as TaskStatus,
  sessionId: row.session_id,
  createdBy: row.created_by,
  originSessionId: row.origin_session_id,
  originClient: row.origin_client as OriginClient | null,
  lastError: row.last_error,
  runsCount: row.runs_count ?? 0,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toRun = (row: RunRow): RunRecord => ({
  id: row.id,
  taskId: row.task_id,
  seq: row.seq,
  kind: row.kind as RunKind,
  runner: row.runner as Runner,
  prompt: row.prompt,
  requestedModel: row.requested_model,
  effectiveModel: row.effective_model,
  permissionMode: row.permission_mode as PermissionMode | null,
  status: row.status as TaskStatus,
  sessionId: row.session_id,
  result: row.result,
  error: row.error,
  exitCode: row.exit_code,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

const toReport = (row: ReportRow): ReportRecord => ({
  id: row.id,
  taskId: row.task_id,
  sessionId: row.session_id,
  workspace: row.workspace,
  kind: row.kind as ReportKind,
  text: row.text,
  source: row.source,
  createdAt: row.created_at,
});

const toRunEvent = (row: RunEventRow): RunEventRecord => ({
  id: row.id,
  runId: row.run_id,
  taskId: row.task_id,
  kind: row.kind as RunEventRecord["kind"],
  text: row.text,
  createdAt: row.created_at,
});

const listSettingsStmt = db.prepare(`SELECT key, value FROM hub_settings`);
const upsertSettingStmt = db.prepare(`
  INSERT INTO hub_settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function defaultOwnerName(): string {
  try {
    return userInfo().username;
  } catch {
    return "the owner";
  }
}

function clampRunTimeout(value: number): number {
  if (!Number.isFinite(value)) return RUN_TIMEOUT_DEFAULT;
  return Math.min(Math.max(Math.round(value), RUN_TIMEOUT_MIN), RUN_TIMEOUT_MAX);
}

export function getSettings(): DelegationSettings {
  const rows = listSettingsStmt.all() as { key: string; value: string | null }[];
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const storedTimeout = stored.get("runTimeoutMinutes");
  return {
    workspacesRoot: stored.get("workspacesRoot") ?? config.workspacesRoot,
    editorCommand: stored.get("editorCommand") ?? config.editorCommand,
    secondBrainRoot: stored.get("secondBrainRoot") ?? config.secondBrainRoot,
    autonomy: stored.get("autonomy") === "safe" ? "safe" : "full",
    ownerName: stored.get("ownerName") ?? defaultOwnerName(),
    runTimeoutMinutes: storedTimeout != null ? clampRunTimeout(Number(storedTimeout)) : RUN_TIMEOUT_DEFAULT,
  };
}

export function getSetting(key: string): string | null {
  const row = db.prepare(`SELECT value FROM hub_settings WHERE key = ?`).get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string | null): void {
  upsertSettingStmt.run(key, value);
}

export function updateSettings(patch: Partial<DelegationSettings>): DelegationSettings {
  const apply = db.transaction(() => {
    if (patch.workspacesRoot !== undefined) upsertSettingStmt.run("workspacesRoot", patch.workspacesRoot);
    if (patch.editorCommand !== undefined) upsertSettingStmt.run("editorCommand", patch.editorCommand);
    if (patch.secondBrainRoot !== undefined) upsertSettingStmt.run("secondBrainRoot", patch.secondBrainRoot);
    if (patch.autonomy !== undefined) upsertSettingStmt.run("autonomy", patch.autonomy);
    if (patch.ownerName !== undefined) upsertSettingStmt.run("ownerName", patch.ownerName);
    if (patch.runTimeoutMinutes !== undefined) {
      upsertSettingStmt.run("runTimeoutMinutes", String(clampRunTimeout(patch.runTimeoutMinutes)));
    }
  });
  apply();
  return getSettings();
}

const TASK_SELECT = `
  SELECT t.*,
    (SELECT r.error FROM hub_runs r WHERE r.task_id = t.id ORDER BY r.seq DESC LIMIT 1) AS last_error,
    (SELECT COUNT(*) FROM hub_runs r WHERE r.task_id = t.id) AS runs_count
  FROM hub_tasks t
`;

const insertTaskStmt = db.prepare(`
  INSERT INTO hub_tasks
    (id, title, prompt, workspace, repo, cwd, add_dirs, runner, requested_model, permission_mode, sandbox, status, created_by, origin_session_id, origin_client, created_at, updated_at)
  VALUES
    (@id, @title, @prompt, @workspace, @repo, @cwd, @addDirs, @runner, @requestedModel, @permissionMode, @sandbox, @status, @createdBy, @originSessionId, @originClient, @now, @now)
`);
const getTaskStmt = db.prepare(`${TASK_SELECT} WHERE t.id = ?`);
const listTasksStmt = db.prepare(`${TASK_SELECT} ORDER BY t.updated_at DESC, t.rowid DESC LIMIT ?`);
const listTasksActiveStmt = db.prepare(
  `${TASK_SELECT} WHERE t.archived_at IS NULL ORDER BY t.updated_at DESC, t.rowid DESC LIMIT ?`,
);
const listTasksByStatusStmt = db.prepare(
  `${TASK_SELECT} WHERE t.status = ? ORDER BY t.updated_at DESC, t.rowid DESC LIMIT ?`,
);
const listTasksByStatusActiveStmt = db.prepare(
  `${TASK_SELECT} WHERE t.status = ? AND t.archived_at IS NULL ORDER BY t.updated_at DESC, t.rowid DESC LIMIT ?`,
);
const listTasksByOriginStmt = db.prepare(
  `${TASK_SELECT} WHERE t.origin_session_id = ? ORDER BY t.updated_at DESC, t.rowid DESC LIMIT ?`,
);
const listRunsStmt = db.prepare(`SELECT * FROM hub_runs WHERE task_id = ? ORDER BY seq`);
const getRunStmt = db.prepare(`SELECT * FROM hub_runs WHERE id = ?`);
const runningRunStmt = db.prepare(`SELECT id FROM hub_runs WHERE task_id = ? AND status = 'running' LIMIT 1`);
const nextSeqStmt = db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM hub_runs WHERE task_id = ?`);
const insertRunStmt = db.prepare(`
  INSERT INTO hub_runs
    (id, task_id, seq, kind, runner, prompt, requested_model, permission_mode, status, session_id, started_at)
  VALUES
    (@id, @taskId, @seq, @kind, @runner, @prompt, @requestedModel, @permissionMode, @status, @sessionId, @now)
`);
const finishRunStmt = db.prepare(`
  UPDATE hub_runs SET
    status = @status,
    effective_model = @effectiveModel,
    session_id = COALESCE(@sessionId, session_id),
    result = @result,
    error = @error,
    exit_code = @exitCode,
    finished_at = @finishedAt
  WHERE id = @id
`);
const touchTaskStmt = db.prepare(`
  UPDATE hub_tasks SET
    status = @status,
    session_id = COALESCE(@sessionId, session_id),
    updated_at = @now
  WHERE id = @id
`);
const insertReportStmt = db.prepare(`
  INSERT INTO hub_reports (id, task_id, session_id, workspace, kind, text, source, created_at)
  VALUES (@id, @taskId, @sessionId, @workspace, @kind, @text, @source, @now)
`);
const getReportStmt = db.prepare(`SELECT * FROM hub_reports WHERE id = ?`);
const listReportsStmt = db.prepare(`SELECT * FROM hub_reports ORDER BY created_at DESC, rowid DESC LIMIT ?`);
const listReportsByTaskStmt = db.prepare(
  `SELECT * FROM hub_reports WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`,
);
const insertEventStmt = db.prepare(`
  INSERT INTO hub_run_events (run_id, task_id, kind, text, created_at) VALUES (@runId, @taskId, @kind, @text, @now)
`);
const lastEventStmt = db.prepare(`SELECT * FROM hub_run_events WHERE run_id = ? ORDER BY id DESC LIMIT 1`);
const appendEventTextStmt = db.prepare(`UPDATE hub_run_events SET text = text || ?, created_at = ? WHERE id = ?`);
const countEventsStmt = db.prepare(`SELECT COUNT(*) AS count FROM hub_run_events WHERE run_id = ?`);
const listEventsByRunStmt = db.prepare(`SELECT * FROM hub_run_events WHERE run_id = ? ORDER BY id ASC`);
const listEventsByTaskStmt = db.prepare(`SELECT * FROM hub_run_events WHERE task_id = ? ORDER BY id ASC`);

export class TaskBusyError extends Error {
  constructor(taskId: string) {
    super(`task ${taskId} already has a run in flight`);
    this.name = "TaskBusyError";
  }
}

export function createTask(input: {
  title: string;
  prompt: string;
  workspace: string;
  repo: string | null;
  cwd: string;
  addDirs: string[];
  runner: Runner;
  model: string | null;
  permissionMode: PermissionMode | null;
  sandbox: CodexSandbox | null;
  createdBy: string | null;
  originSessionId: string | null;
  originClient: OriginClient | null;
}): TaskRecord {
  const id = randomUUID();
  insertTaskStmt.run({
    id,
    title: input.title,
    prompt: input.prompt,
    workspace: input.workspace,
    repo: input.repo,
    cwd: input.cwd,
    addDirs: JSON.stringify(input.addDirs),
    runner: input.runner,
    requestedModel: input.model,
    permissionMode: input.permissionMode,
    sandbox: input.sandbox,
    status: "pending",
    createdBy: input.createdBy,
    originSessionId: input.originSessionId,
    originClient: input.originClient,
    now: Date.now(),
  });
  return toTask(getTaskStmt.get(id) as TaskRow);
}

const setOriginStmt = db.prepare(`UPDATE hub_tasks SET origin_session_id = @originSessionId, origin_client = @originClient, updated_at = @now WHERE id = @id`);

export function setTaskOrigin(id: string, originSessionId: string | null, originClient: OriginClient | null): TaskRecord | null {
  setOriginStmt.run({ id, originSessionId, originClient, now: Date.now() });
  return getTask(id);
}

const setArchivedStmt = db.prepare(`UPDATE hub_tasks SET archived_at = @archivedAt, updated_at = @now WHERE id = @id`);

export function archiveTask(id: string): TaskRecord | null {
  setArchivedStmt.run({ id, archivedAt: Date.now(), now: Date.now() });
  return getTask(id);
}

export function unarchiveTask(id: string): TaskRecord | null {
  setArchivedStmt.run({ id, archivedAt: null, now: Date.now() });
  return getTask(id);
}

export function getTask(id: string): TaskRecord | null {
  const row = getTaskStmt.get(id) as TaskRow | undefined;
  return row ? toTask(row) : null;
}

export function listTasks(
  options: { status?: TaskStatus | null; limit?: number; includeArchived?: boolean } = {},
): TaskRecord[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const includeArchived = options.includeArchived ?? false;
  const rows = options.status
    ? ((includeArchived ? listTasksByStatusStmt : listTasksByStatusActiveStmt).all(options.status, limit) as TaskRow[])
    : ((includeArchived ? listTasksStmt : listTasksActiveStmt).all(limit) as TaskRow[]);
  return rows.map(toTask);
}

export function listTasksByOrigin(originSessionId: string, limit = 100): TaskRecord[] {
  return (listTasksByOriginStmt.all(originSessionId, Math.min(Math.max(limit, 1), 500)) as TaskRow[]).map(toTask);
}

export function getTaskDetail(id: string): TaskDetail | null {
  const task = getTask(id);
  if (!task) return null;
  const runs = (listRunsStmt.all(id) as RunRow[]).map(toRun);
  const reports = (listReportsByTaskStmt.all(id) as ReportRow[]).map(toReport);
  return { task, runs, reports };
}

export function beginRun(input: {
  taskId: string;
  kind: RunKind;
  runner: Runner;
  prompt: string;
  model: string | null;
  permissionMode: PermissionMode | null;
  sessionId: string | null;
}): RunRecord {
  const id = randomUUID();
  const now = Date.now();
  const start = db.transaction(() => {
    if (runningRunStmt.get(input.taskId)) throw new TaskBusyError(input.taskId);
    const { seq } = nextSeqStmt.get(input.taskId) as { seq: number };
    insertRunStmt.run({
      id,
      taskId: input.taskId,
      seq,
      kind: input.kind,
      runner: input.runner,
      prompt: input.prompt,
      requestedModel: input.model,
      permissionMode: input.permissionMode,
      status: "running",
      sessionId: input.sessionId,
      now,
    });
    touchTaskStmt.run({ id: input.taskId, status: "running", sessionId: null, now });
  });
  start.immediate();
  return toRun(getRunStmt.get(id) as RunRow);
}

export function finishRun(input: {
  runId: string;
  taskId: string;
  status: TaskStatus;
  effectiveModel: string | null;
  sessionId: string | null;
  result: string | null;
  error: string | null;
  exitCode: number | null;
}): RunRecord {
  const now = Date.now();
  const commit = db.transaction(() => {
    finishRunStmt.run({
      id: input.runId,
      status: input.status,
      effectiveModel: input.effectiveModel,
      sessionId: input.sessionId,
      result: input.result,
      error: input.error,
      exitCode: input.exitCode,
      finishedAt: now,
    });
    touchTaskStmt.run({ id: input.taskId, status: input.status, sessionId: input.sessionId, now });
  });
  commit();
  return toRun(getRunStmt.get(input.runId) as RunRow);
}

const interruptRunsStmt = db.prepare(`
  UPDATE hub_runs
  SET status = 'interrupted', error = 'hub restarted while the run was in flight', finished_at = @now
  WHERE status = 'running'
`);
const interruptTasksStmt = db.prepare(`
  UPDATE hub_tasks SET status = 'interrupted', updated_at = @now WHERE status = 'running'
`);

export function markRunningAsInterrupted(): number {
  const now = Date.now();
  const sweep = db.transaction(() => {
    const runs = interruptRunsStmt.run({ now }).changes;
    interruptTasksStmt.run({ now });
    return runs;
  });
  return sweep();
}

export function createReport(input: {
  taskId: string | null;
  sessionId: string | null;
  workspace: string | null;
  kind: ReportKind;
  text: string;
  source: string | null;
}): ReportRecord {
  const id = randomUUID();
  insertReportStmt.run({ id, ...input, now: Date.now() });
  return toReport(getReportStmt.get(id) as ReportRow);
}

export function listReports(options: { taskId?: string | null; limit?: number } = {}): ReportRecord[] {
  if (options.taskId) return (listReportsByTaskStmt.all(options.taskId) as ReportRow[]).map(toReport);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  return (listReportsStmt.all(limit) as ReportRow[]).map(toReport);
}

export function appendRunEvent(input: { runId: string; taskId: string; kind: RunEventRecord["kind"]; text: string }): boolean {
  const now = Date.now();
  const last = lastEventStmt.get(input.runId) as RunEventRow | undefined;
  if (input.kind === "text" && last && last.kind === "text" && last.text.length < MAX_EVENT_TEXT) {
    appendEventTextStmt.run(input.text, now, last.id);
    return true;
  }
  const { count } = countEventsStmt.get(input.runId) as { count: number };
  if (count >= MAX_EVENTS_PER_RUN) return false;
  insertEventStmt.run({ runId: input.runId, taskId: input.taskId, kind: input.kind, text: input.text, now });
  return true;
}

export function listRunEvents(runId: string): RunEventRecord[] {
  return (listEventsByRunStmt.all(runId) as RunEventRow[]).map(toRunEvent);
}

export function listTaskEvents(taskId: string): RunEventRecord[] {
  return (listEventsByTaskStmt.all(taskId) as RunEventRow[]).map(toRunEvent);
}

const codexRunLinksStmt = db.prepare(`
  SELECT r.session_id AS threadId, r.task_id AS taskId, r.status, r.seq, t.title AS taskTitle
  FROM hub_runs r
  LEFT JOIN hub_tasks t ON t.id = r.task_id
  WHERE r.runner = 'codex' AND r.session_id IS NOT NULL
  ORDER BY r.seq ASC
`);

export function listCodexRunLinks(): CodexRunLink[] {
  const rows = codexRunLinksStmt.all() as { threadId: string; taskId: string; status: string; seq: number; taskTitle: string | null }[];
  const byThread = new Map<string, CodexRunLink>();
  for (const row of rows) {
    byThread.set(row.threadId, { threadId: row.threadId, taskId: row.taskId, latestRunStatus: row.status, taskTitle: row.taskTitle });
  }
  return [...byThread.values()];
}
