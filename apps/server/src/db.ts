import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import type { GroupRecord, HookKind, HookPayload, SessionRecord, SessionStatus } from "./types.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    session_id     TEXT PRIMARY KEY,
    status         TEXT NOT NULL,
    cwd            TEXT,
    title          TEXT,
    custom_title   TEXT,
    last_message   TEXT,
    model          TEXT,
    tokens_in      INTEGER,
    tokens_out     INTEGER,
    context_tokens INTEGER,
    source         TEXT,
    host_pid       INTEGER,
    archived_at    INTEGER,
    started_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    kind        TEXT NOT NULL,
    message     TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, created_at);
  CREATE TABLE IF NOT EXISTS groups (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    match_pattern TEXT NOT NULL,
    position      INTEGER NOT NULL
  );
`);

const existingColumns = new Set(
  (db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map((column) => column.name),
);
for (const [name, type] of [
  ["custom_title", "TEXT"],
  ["model", "TEXT"],
  ["tokens_in", "INTEGER"],
  ["tokens_out", "INTEGER"],
  ["context_tokens", "INTEGER"],
  ["source", "TEXT"],
  ["host_pid", "INTEGER"],
  ["shell_pid", "INTEGER"],
  ["archived_at", "INTEGER"],
] as const) {
  if (!existingColumns.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
}

const statusByKind: Record<HookKind, SessionStatus> = {
  session_start: "active",
  user_prompt: "active",
  notification: "waiting",
  stop: "idle",
  session_end: "ended",
};

interface SessionRow {
  session_id: string;
  status: string;
  cwd: string | null;
  title: string | null;
  custom_title: string | null;
  last_message: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  context_tokens: number | null;
  source: string | null;
  host_pid: number | null;
  shell_pid: number | null;
  archived_at: number | null;
  started_at: number;
  updated_at: number;
}

const toRecord = (row: SessionRow): SessionRecord => ({
  sessionId: row.session_id,
  status: row.status as SessionStatus,
  cwd: row.cwd,
  source: row.source,
  hostPid: row.host_pid,
  shellPid: row.shell_pid,
  title: row.title,
  customTitle: row.custom_title,
  lastMessage: row.last_message,
  model: row.model,
  tokensIn: row.tokens_in,
  tokensOut: row.tokens_out,
  contextTokens: row.context_tokens,
  archivedAt: row.archived_at,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
});

const upsertStmt = db.prepare(`
  INSERT INTO sessions
    (session_id, status, cwd, source, host_pid, shell_pid, title, last_message, model, tokens_in, tokens_out, context_tokens, started_at, updated_at)
  VALUES
    (@sessionId, @status, @cwd, @source, @hostPid, @shellPid, @title, @message, @model, @tokensIn, @tokensOut, @contextTokens, @now, @now)
  ON CONFLICT(session_id) DO UPDATE SET
    status = @status,
    cwd = COALESCE(@cwd, cwd),
    source = COALESCE(@source, source),
    host_pid = COALESCE(@hostPid, host_pid),
    shell_pid = CASE WHEN @hostPid IS NOT NULL THEN @shellPid ELSE shell_pid END,
    title = COALESCE(@title, title),
    last_message = COALESCE(@message, last_message),
    model = COALESCE(@model, model),
    tokens_in = COALESCE(@tokensIn, tokens_in),
    tokens_out = COALESCE(@tokensOut, tokens_out),
    context_tokens = COALESCE(@contextTokens, context_tokens),
    archived_at = NULL,
    updated_at = @now
`);

const insertEventStmt = db.prepare(`
  INSERT INTO events (session_id, kind, message, created_at)
  VALUES (@sessionId, @kind, @message, @now)
`);

const getStmt = db.prepare(`SELECT * FROM sessions WHERE session_id = ?`);
const listStmt = db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`);

const apply = db.transaction((payload: HookPayload, now: number): SessionRecord => {
  const status = statusByKind[payload.kind];
  upsertStmt.run({
    sessionId: payload.sessionId,
    status,
    cwd: payload.cwd,
    source: payload.source,
    hostPid: payload.hostPid,
    shellPid: payload.shellPid,
    title: payload.title,
    message: payload.message,
    model: payload.model,
    tokensIn: payload.tokensIn,
    tokensOut: payload.tokensOut,
    contextTokens: payload.contextTokens,
    now,
  });
  insertEventStmt.run({
    sessionId: payload.sessionId,
    kind: payload.kind,
    message: payload.message,
    now,
  });
  return toRecord(getStmt.get(payload.sessionId) as SessionRow);
});

export function applyHook(payload: HookPayload): SessionRecord {
  return apply(payload, Date.now());
}

export function listSessions(): SessionRecord[] {
  return (listStmt.all() as SessionRow[]).map(toRecord);
}

export function getSession(sessionId: string): SessionRecord | null {
  const row = getStmt.get(sessionId) as SessionRow | undefined;
  return row ? toRecord(row) : null;
}

const renameStmt = db.prepare(`UPDATE sessions SET custom_title = ? WHERE session_id = ?`);

export function renameSession(sessionId: string, title: string | null): SessionRecord | null {
  renameStmt.run(title && title.trim().length > 0 ? title.trim() : null, sessionId);
  const row = getStmt.get(sessionId) as SessionRow | undefined;
  return row ? toRecord(row) : null;
}

const archiveStmt = db.prepare(`UPDATE sessions SET archived_at = ? WHERE session_id = ?`);

export function archiveSession(sessionId: string): SessionRecord | null {
  archiveStmt.run(Date.now(), sessionId);
  const row = getStmt.get(sessionId) as SessionRow | undefined;
  return row ? toRecord(row) : null;
}

const removeTx = db.transaction((sessionId: string): number => {
  db.prepare(`DELETE FROM events WHERE session_id = ?`).run(sessionId);
  return db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId).changes;
});

export function deleteSession(sessionId: string): boolean {
  return removeTx(sessionId) > 0;
}

const groupSelect = `SELECT id, name, match_pattern AS "match", position FROM groups ORDER BY position`;

export function listGroups(): GroupRecord[] {
  return db.prepare(groupSelect).all() as GroupRecord[];
}

export function createGroup(name: string, match: string): GroupRecord {
  const id = randomUUID();
  const { pos } = db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM groups`).get() as {
    pos: number;
  };
  db.prepare(`INSERT INTO groups (id, name, match_pattern, position) VALUES (?, ?, ?, ?)`).run(
    id,
    name,
    match,
    pos,
  );
  return { id, name, match, position: pos };
}

export function updateGroup(
  id: string,
  fields: { name?: string; match?: string },
): GroupRecord | null {
  if (fields.name !== undefined) {
    db.prepare(`UPDATE groups SET name = ? WHERE id = ?`).run(fields.name, id);
  }
  if (fields.match !== undefined) {
    db.prepare(`UPDATE groups SET match_pattern = ? WHERE id = ?`).run(fields.match, id);
  }
  const row = db
    .prepare(`SELECT id, name, match_pattern AS "match", position FROM groups WHERE id = ?`)
    .get(id) as GroupRecord | undefined;
  return row ?? null;
}

export function deleteGroup(id: string): boolean {
  return db.prepare(`DELETE FROM groups WHERE id = ?`).run(id).changes > 0;
}

const reorderTx = db.transaction((ids: string[]) => {
  const stmt = db.prepare(`UPDATE groups SET position = ? WHERE id = ?`);
  ids.forEach((id, index) => stmt.run(index, id));
});

export function reorderGroups(ids: string[]): GroupRecord[] {
  reorderTx(ids);
  return listGroups();
}
