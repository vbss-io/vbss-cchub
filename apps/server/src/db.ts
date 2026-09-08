import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import type { AgentRecord, GroupRecord, HookKind, HookPayload, SessionRecord, SessionStatus } from "./types.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
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
  ["favorite_at", "INTEGER"],
] as const) {
  if (!existingColumns.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    agent_id        TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    agent_type      TEXT,
    status          TEXT NOT NULL,
    transcript_path TEXT,
    last_message    TEXT,
    started_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id, status);
`);

function ensureColumns(table: string, columns: [string, string][]): void {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
  );
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

ensureColumns("sessions", [
  ["client", "TEXT"],
  ["claude_pid", "INTEGER"],
  ["transcript_path", "TEXT"],
  ["share_label", "TEXT"],
]);
ensureColumns("agents", [
  ["transcript_path", "TEXT"],
  ["last_message", "TEXT"],
]);

const STALE_HOURS = Number(process.env.HUB_STALE_HOURS ?? 4);
const STALE_MS = Number.isFinite(STALE_HOURS) && STALE_HOURS > 0 ? STALE_HOURS * 3_600_000 : 4 * 3_600_000;

export function isProcessAlive(pid: number | null): boolean {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

const statusByKind: Record<Exclude<HookKind, "meta">, SessionStatus> = {
  session_start: "active",
  user_prompt: "active",
  notification: "waiting",
  stop: "idle",
  session_end: "ended",
  subagent_start: "active",
  subagent_stop: "active",
};

db.exec(`
  CREATE TABLE IF NOT EXISTS hub_share_requests (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    answer TEXT,
    error TEXT,
    task_id TEXT,
    session_id TEXT,
    remote TEXT,
    agent TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS hub_share_forks (
    share_id TEXT NOT NULL,
    asker TEXT NOT NULL,
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    questions INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (share_id, asker)
  );
`);
ensureColumns("hub_share_requests", [
  ["asker", "TEXT"],
  ["fork_session_id", "TEXT"],
  ["parent_session_id", "TEXT"],
]);

db.exec(`
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
`);
ensureColumns("hub_tasks", [
  ["origin_session_id", "TEXT"],
  ["origin_client", "TEXT"],
]);

const isHelper = (alias: string): string =>
  `${alias}.client = 'claude-desktop' AND ${alias}.cwd IS NOT NULL AND (LOWER(${alias}.cwd) LIKE '%\\scratch-workspaces\\%' OR LOWER(${alias}.cwd) LIKE '%/scratch-workspaces/%')`;

const parentOf = (alias: string): string => `(
    SELECT p.session_id FROM sessions p
    WHERE p.host_pid = ${alias}.host_pid
      AND p.client = 'claude-desktop'
      AND p.session_id != ${alias}.session_id
      AND NOT (${isHelper("p")})
    ORDER BY p.started_at DESC LIMIT 1
  )`;

const SESSION_SELECT = `
  SELECT s.*,
    (SELECT COUNT(*) FROM agents a WHERE a.session_id = s.session_id AND a.status = 'running') AS agents_running,
    (SELECT COUNT(*) FROM agents a WHERE a.session_id = s.session_id) AS agents_total,
    (SELECT COUNT(*) FROM hub_share_forks f WHERE f.parent_session_id = s.session_id) AS forks,
    (SELECT COUNT(*) FROM hub_share_forks f JOIN sessions fs ON fs.session_id = f.session_id WHERE f.parent_session_id = s.session_id AND fs.status != 'ended') AS forks_live,
    (SELECT COUNT(*) FROM hub_share_requests r WHERE r.parent_session_id = s.session_id) AS remote_asks,
    (SELECT COUNT(*) FROM hub_tasks dt WHERE dt.origin_session_id = s.session_id) AS delegated,
    (SELECT COUNT(*) FROM hub_tasks dt WHERE dt.origin_session_id = s.session_id AND dt.status IN ('running', 'pending')) AS delegated_running,
    (SELECT parent_session_id FROM hub_share_forks f WHERE f.session_id = s.session_id LIMIT 1) AS fork_of,
    (CASE WHEN ${isHelper("s")} THEN ${parentOf("s")} ELSE NULL END) AS helper_of,
    (SELECT COUNT(*) FROM sessions h WHERE ${isHelper("h")} AND h.status != 'ended' AND ${parentOf("h")} = s.session_id) AS helpers,
    (SELECT COUNT(*) FROM sessions h WHERE ${isHelper("h")} AND ${parentOf("h")} = s.session_id) AS helpers_total
  FROM sessions s
`;

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
  claude_pid: number | null;
  client: string | null;
  transcript_path: string | null;
  share_label: string | null;
  forks: number;
  forks_live: number;
  remote_asks: number;
  delegated: number;
  delegated_running: number;
  fork_of: string | null;
  helper_of: string | null;
  helpers: number;
  helpers_total: number;
  archived_at: number | null;
  favorite_at: number | null;
  agents_running: number;
  agents_total: number;
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
  claudePid: row.claude_pid,
  client: row.client,
  transcriptPath: row.transcript_path,
  shareLabel: row.share_label,
  forkOf: row.fork_of ?? null,
  forks: row.forks ?? 0,
  forksLive: row.forks_live ?? 0,
  remoteAsks: row.remote_asks ?? 0,
  delegatedTasks: row.delegated ?? 0,
  delegatedRunning: row.delegated_running ?? 0,
  helperOf: row.helper_of ?? null,
  helpers: row.helpers ?? 0,
  helpersTotal: row.helpers_total ?? 0,
  stale: row.status !== "ended" && Date.now() - row.updated_at > STALE_MS,
  title: row.title,
  customTitle: row.custom_title,
  lastMessage: row.last_message,
  model: row.model,
  tokensIn: row.tokens_in,
  tokensOut: row.tokens_out,
  contextTokens: row.context_tokens,
  archivedAt: row.archived_at,
  favoriteAt: row.favorite_at,
  agentsRunning: row.agents_running ?? 0,
  agentsTotal: row.agents_total ?? 0,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
});

const upsertStmt = db.prepare(`
  INSERT INTO sessions
    (session_id, status, cwd, source, host_pid, shell_pid, claude_pid, client, transcript_path, share_label, title, last_message, model, tokens_in, tokens_out, context_tokens, started_at, updated_at)
  VALUES
    (@sessionId, @status, @cwd, @source, @hostPid, @shellPid, @claudePid, @client, @transcriptPath, @shareLabel, @title, @message, @model, @tokensIn, @tokensOut, @contextTokens, @now, @now)
  ON CONFLICT(session_id) DO UPDATE SET
    status = @status,
    cwd = CASE WHEN @pinCwd = 1 THEN COALESCE(@cwd, cwd) ELSE COALESCE(cwd, @cwd) END,
    source = COALESCE(@source, source),
    host_pid = COALESCE(@hostPid, host_pid),
    shell_pid = CASE WHEN @hostPid IS NOT NULL THEN @shellPid ELSE shell_pid END,
    claude_pid = COALESCE(@claudePid, claude_pid),
    client = COALESCE(@client, client),
    transcript_path = COALESCE(@transcriptPath, transcript_path),
    share_label = COALESCE(@shareLabel, share_label),
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

const getStmt = db.prepare(`${SESSION_SELECT} WHERE s.session_id = ?`);
const listStmt = db.prepare(`${SESSION_SELECT} ORDER BY s.updated_at DESC`);
const upsertAgentStmt = db.prepare(`
  INSERT INTO agents (agent_id, session_id, agent_type, status, transcript_path, last_message, started_at, updated_at)
  VALUES (@agentId, @sessionId, @agentType, @status, @transcriptPath, @lastMessage, @now, @now)
  ON CONFLICT(agent_id) DO UPDATE SET
    status = @status,
    agent_type = COALESCE(@agentType, agent_type),
    transcript_path = COALESCE(@transcriptPath, transcript_path),
    last_message = COALESCE(@lastMessage, last_message),
    updated_at = @now
`);
const endAgentsStmt = db.prepare(`UPDATE agents SET status = 'ended', updated_at = ? WHERE session_id = ? AND status = 'running'`);
const listAgentsStmt = db.prepare(`SELECT * FROM agents WHERE session_id = ? ORDER BY started_at`);

interface AgentRow {
  agent_id: string;
  session_id: string;
  agent_type: string | null;
  status: string;
  transcript_path: string | null;
  last_message: string | null;
  started_at: number;
  updated_at: number;
}

const toAgent = (row: AgentRow): AgentRecord => ({
  agentId: row.agent_id,
  sessionId: row.session_id,
  agentType: row.agent_type,
  status: row.status as AgentRecord["status"],
  transcriptPath: row.transcript_path,
  lastMessage: row.last_message,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
});

export function listAgents(sessionId: string): AgentRecord[] {
  return (listAgentsStmt.all(sessionId) as AgentRow[]).map(toAgent);
}

const metaStmt = db.prepare(`
  UPDATE sessions SET
    host_pid = COALESCE(@hostPid, host_pid),
    shell_pid = CASE WHEN @hostPid IS NOT NULL THEN @shellPid ELSE shell_pid END,
    claude_pid = COALESCE(@claudePid, claude_pid),
    client = COALESCE(@client, client),
    transcript_path = COALESCE(@transcriptPath, transcript_path),
    title = COALESCE(@title, title),
    model = COALESCE(@model, model),
    tokens_in = COALESCE(@tokensIn, tokens_in),
    tokens_out = COALESCE(@tokensOut, tokens_out),
    context_tokens = COALESCE(@contextTokens, context_tokens)
  WHERE session_id = @sessionId
`);

export function applyMeta(payload: HookPayload): SessionRecord | null {
  metaStmt.run({
    sessionId: payload.sessionId,
    hostPid: payload.hostPid,
    shellPid: payload.shellPid,
    claudePid: payload.claudePid,
    client: payload.client,
    transcriptPath: payload.transcriptPath,
    title: payload.title,
    model: payload.model,
    tokensIn: payload.tokensIn,
    tokensOut: payload.tokensOut,
    contextTokens: payload.contextTokens,
  });
  const row = getStmt.get(payload.sessionId) as SessionRow | undefined;
  return row ? toRecord(row) : null;
}

const apply = db.transaction((payload: HookPayload, now: number): SessionRecord => {
  if (payload.kind === "meta") {
    const record = applyMeta(payload);
    if (record) return record;
  }
  const status = payload.kind === "meta" ? "active" : statusByKind[payload.kind];
  upsertStmt.run({
    sessionId: payload.sessionId,
    status,
    cwd: payload.cwd,
    pinCwd: payload.kind === "session_start" ? 1 : 0,
    source: payload.source,
    hostPid: payload.hostPid,
    shellPid: payload.shellPid,
    title: payload.title,
    message: payload.message,
    model: payload.model,
    tokensIn: payload.tokensIn,
    tokensOut: payload.tokensOut,
    contextTokens: payload.contextTokens,
    claudePid: payload.claudePid,
    client: payload.client,
    transcriptPath: payload.transcriptPath,
    shareLabel: payload.shareLabel,
    now,
  });
  insertEventStmt.run({
    sessionId: payload.sessionId,
    kind: payload.kind,
    message: payload.message,
    now,
  });
  if ((payload.kind === "subagent_start" || payload.kind === "subagent_stop") && payload.agentId) {
    upsertAgentStmt.run({
      agentId: payload.agentId,
      sessionId: payload.sessionId,
      agentType: payload.agentType,
      status: payload.kind === "subagent_start" ? "running" : "ended",
      transcriptPath: null,
      lastMessage: payload.agentMessage,
      now,
    });
  }
  if (payload.kind === "session_end") endAgentsStmt.run(now, payload.sessionId);
  return toRecord(getStmt.get(payload.sessionId) as SessionRow);
});

export function applyHook(payload: HookPayload, at?: number): SessionRecord {
  return apply(payload, at ?? Date.now());
}

export function listSessions(): SessionRecord[] {
  return (listStmt.all() as SessionRow[]).map(toRecord);
}

const liveWithPidStmt = db.prepare(
  `SELECT session_id, COALESCE(claude_pid, shell_pid, host_pid) AS pid FROM sessions WHERE status != 'ended' AND COALESCE(claude_pid, shell_pid, host_pid) IS NOT NULL`,
);
const endSessionStmt = db.prepare(
  `UPDATE sessions SET status = 'ended', last_message = COALESCE(last_message, 'process exited'), updated_at = ? WHERE session_id = ?`,
);

const endWithMessageStmt = db.prepare(
  `UPDATE sessions SET status = 'ended', last_message = ?, updated_at = ? WHERE session_id = ? AND status != 'ended'`,
);

export function endSession(sessionId: string, message: string): SessionRecord | null {
  const now = Date.now();
  const changed = endWithMessageStmt.run(message, now, sessionId).changes;
  if (changed === 0) return null;
  endAgentsStmt.run(now, sessionId);
  insertEventStmt.run({ sessionId, kind: "session_end", message, now });
  const row = getStmt.get(sessionId) as SessionRow | undefined;
  return row ? toRecord(row) : null;
}

export function endDeadSessions(): SessionRecord[] {
  const now = Date.now();
  const ended: SessionRecord[] = [];
  const sweep = db.transaction(() => {
    for (const row of liveWithPidStmt.all() as { session_id: string; pid: number }[]) {
      if (isProcessAlive(row.pid)) continue;
      endSessionStmt.run(now, row.session_id);
      endAgentsStmt.run(now, row.session_id);
      insertEventStmt.run({ sessionId: row.session_id, kind: "session_end", message: "process exited", now });
      ended.push(toRecord(getStmt.get(row.session_id) as SessionRow));
    }
  });
  sweep();
  return ended;
}

export function getSession(sessionId: string): SessionRecord | null {
  const row = getStmt.get(sessionId) as SessionRow | undefined;
  return row ? toRecord(row) : null;
}

const sessionByPidStmt = db.prepare(
  `${SESSION_SELECT}
   WHERE s.claude_pid = @pid OR s.host_pid = @pid OR s.shell_pid = @pid
   ORDER BY CASE WHEN s.claude_pid = @pid THEN 0 WHEN s.host_pid = @pid THEN 1 ELSE 2 END, s.updated_at DESC
   LIMIT 1`,
);

export function sessionByPid(pid: number | null): SessionRecord | null {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return null;
  const row = sessionByPidStmt.get({ pid }) as SessionRow | undefined;
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

const favoriteStmt = db.prepare(`UPDATE sessions SET favorite_at = ? WHERE session_id = ?`);

export function setSessionFavorite(sessionId: string, favorite: boolean): SessionRecord | null {
  favoriteStmt.run(favorite ? Date.now() : null, sessionId);
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

const emptySessionsStmt = db.prepare(`
  SELECT session_id FROM sessions
  WHERE model IS NULL AND context_tokens IS NULL AND updated_at < ?
`);

const purgeEmptyTx = db.transaction((cutoff: number): string[] => {
  const ids = (emptySessionsStmt.all(cutoff) as { session_id: string }[]).map(
    (row) => row.session_id,
  );
  const dropEvents = db.prepare(`DELETE FROM events WHERE session_id = ?`);
  const dropSession = db.prepare(`DELETE FROM sessions WHERE session_id = ?`);
  for (const id of ids) {
    dropEvents.run(id);
    dropSession.run(id);
  }
  return ids;
});

export function purgeEmptySessions(ttlMs: number): string[] {
  if (ttlMs <= 0) return [];
  return purgeEmptyTx(Date.now() - ttlMs);
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
