import { randomBytes, randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  SHARE_DEFAULT_MAX_PER_HOUR,
  normalizeTrust,
  type ShareRecord,
  type ShareRequestKind,
  type ShareRequestRecord,
  type ShareRequestStatus,
  type TrustLevel,
} from "./share-types.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS hub_shares (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    workspace TEXT NOT NULL,
    repo TEXT,
    session_id TEXT,
    scope TEXT NOT NULL,
    note TEXT,
    model TEXT,
    max_per_hour INTEGER NOT NULL DEFAULT ${SHARE_DEFAULT_MAX_PER_HOUR},
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    paused INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    uses INTEGER NOT NULL DEFAULT 0
  );
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
  CREATE INDEX IF NOT EXISTS hub_share_requests_share ON hub_share_requests(share_id, created_at DESC);
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

interface ShareRow {
  id: string;
  key: string;
  label: string;
  workspace: string;
  repo: string | null;
  session_id: string | null;
  scope: string;
  note: string | null;
  model: string | null;
  max_per_hour: number;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  paused: number;
  last_used_at: number | null;
  uses: number;
}

interface RequestRow {
  id: string;
  share_id: string;
  kind: ShareRequestKind;
  prompt: string;
  status: ShareRequestStatus;
  answer: string | null;
  error: string | null;
  task_id: string | null;
  session_id: string | null;
  remote: string | null;
  agent: string | null;
  asker: string | null;
  fork_session_id: string | null;
  parent_session_id: string | null;
  created_at: number;
  finished_at: number | null;
}

const toShare = (row: ShareRow): ShareRecord => ({
  id: row.id,
  key: row.key,
  label: row.label,
  workspace: row.workspace,
  repo: row.repo,
  sessionId: row.session_id,
  trust: normalizeTrust(row.scope) ?? "medium",
  note: row.note,
  model: row.model,
  maxPerHour: row.max_per_hour,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  paused: row.paused === 1,
  lastUsedAt: row.last_used_at,
  uses: row.uses,
});

const toRequest = (row: RequestRow): ShareRequestRecord => ({
  id: row.id,
  shareId: row.share_id,
  kind: row.kind,
  prompt: row.prompt,
  status: row.status,
  answer: row.answer,
  error: row.error,
  taskId: row.task_id,
  sessionId: row.session_id,
  remote: row.remote,
  agent: row.agent,
  asker: row.asker,
  forkSessionId: row.fork_session_id,
  parentSessionId: row.parent_session_id,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
});

const insertShareStmt = db.prepare(`
  INSERT INTO hub_shares (id, key, label, workspace, repo, session_id, scope, note, model, max_per_hour, created_at, expires_at)
  VALUES (@id, @key, @label, @workspace, @repo, @sessionId, @scope, @note, @model, @maxPerHour, @createdAt, @expiresAt)
`);
const getShareStmt = db.prepare(`SELECT * FROM hub_shares WHERE id = ?`);
const listSharesStmt = db.prepare(`SELECT * FROM hub_shares ORDER BY created_at DESC`);
const deleteShareStmt = db.prepare(`DELETE FROM hub_shares WHERE id = ?`);
const deleteShareRequestsStmt = db.prepare(`DELETE FROM hub_share_requests WHERE share_id = ?`);
const touchShareStmt = db.prepare(`UPDATE hub_shares SET last_used_at = ?, uses = uses + 1 WHERE id = ?`);
const insertRequestStmt = db.prepare(`
  INSERT INTO hub_share_requests (id, share_id, kind, prompt, status, task_id, remote, agent, asker, parent_session_id, created_at)
  VALUES (@id, @shareId, @kind, @prompt, @status, @taskId, @remote, @agent, @asker, @parentSessionId, @createdAt)
`);
const setRequestForkStmt = db.prepare(`UPDATE hub_share_requests SET fork_session_id = ? WHERE id = ?`);
const listAsksForSessionStmt = db.prepare(`SELECT * FROM hub_share_requests WHERE parent_session_id = ? ORDER BY created_at DESC LIMIT ?`);
const getForkStmt = db.prepare(`SELECT * FROM hub_share_forks WHERE share_id = ? AND asker = ?`);
const upsertForkStmt = db.prepare(`
  INSERT INTO hub_share_forks (share_id, asker, session_id, parent_session_id, created_at, last_used_at, questions)
  VALUES (@shareId, @asker, @sessionId, @parentSessionId, @now, @now, 1)
  ON CONFLICT(share_id, asker) DO UPDATE SET session_id = excluded.session_id, last_used_at = excluded.last_used_at, questions = questions + 1
`);
const listForksStmt = db.prepare(`SELECT * FROM hub_share_forks WHERE parent_session_id = ? ORDER BY last_used_at DESC`);
const listShareForksStmt = db.prepare(`SELECT * FROM hub_share_forks WHERE share_id = ? ORDER BY last_used_at DESC`);
const deleteForksStmt = db.prepare(`DELETE FROM hub_share_forks WHERE share_id = ?`);
const finishRequestStmt = db.prepare(`
  UPDATE hub_share_requests SET status = @status, answer = @answer, error = @error, session_id = @sessionId, finished_at = @finishedAt WHERE id = @id
`);
const getRequestStmt = db.prepare(`SELECT * FROM hub_share_requests WHERE id = ?`);
const listRequestsByShareStmt = db.prepare(`SELECT * FROM hub_share_requests WHERE share_id = ? ORDER BY created_at DESC LIMIT ?`);
const listRequestsStmt = db.prepare(`SELECT * FROM hub_share_requests ORDER BY created_at DESC LIMIT ?`);
const countRecentStmt = db.prepare(`SELECT COUNT(*) AS n FROM hub_share_requests WHERE share_id = ? AND created_at > ? AND status != 'rejected'`);
const runningStmt = db.prepare(`SELECT COUNT(*) AS n FROM hub_share_requests WHERE share_id = ? AND status = 'running' AND kind = ?`);
const finishByTaskStmt = db.prepare(`UPDATE hub_share_requests SET status = @status, error = @error, session_id = @sessionId, finished_at = @finishedAt WHERE task_id = @taskId AND status = 'running'`);
const rotateKeyStmt = db.prepare(`UPDATE hub_shares SET key = ? WHERE id = ?`);

const shortId = (): string => randomBytes(5).toString("hex");
const secretKey = (): string => randomBytes(24).toString("base64url");

export function createShare(input: {
  label: string;
  workspace: string;
  repo: string | null;
  sessionId: string | null;
  trust: TrustLevel;
  note: string | null;
  model: string | null;
  maxPerHour: number | null;
  expiresAt: number | null;
}): ShareRecord {
  const id = shortId();
  insertShareStmt.run({
    id,
    key: secretKey(),
    label: input.label,
    workspace: input.workspace,
    repo: input.repo,
    sessionId: input.sessionId,
    scope: input.trust,
    note: input.note,
    model: input.model,
    maxPerHour: input.maxPerHour ?? SHARE_DEFAULT_MAX_PER_HOUR,
    createdAt: Date.now(),
    expiresAt: input.expiresAt,
  });
  return getShare(id) as ShareRecord;
}

export function getShare(id: string): ShareRecord | null {
  const row = getShareStmt.get(id) as ShareRow | undefined;
  return row ? toShare(row) : null;
}

export function listShares(): ShareRecord[] {
  return (listSharesStmt.all() as ShareRow[]).map(toShare);
}

export function updateShare(
  id: string,
  patch: { label?: string; note?: string | null; paused?: boolean; revoked?: boolean; expiresAt?: number | null; maxPerHour?: number },
): ShareRecord | null {
  const current = getShare(id);
  if (!current) return null;
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.label !== undefined) {
    sets.push("label = @label");
    params.label = patch.label;
  }
  if (patch.note !== undefined) {
    sets.push("note = @note");
    params.note = patch.note;
  }
  if (patch.paused !== undefined) {
    sets.push("paused = @paused");
    params.paused = patch.paused ? 1 : 0;
  }
  if (patch.revoked) {
    sets.push("revoked_at = @revokedAt");
    params.revokedAt = Date.now();
  }
  if (patch.expiresAt !== undefined) {
    sets.push("expires_at = @expiresAt");
    params.expiresAt = patch.expiresAt;
  }
  if (patch.maxPerHour !== undefined) {
    sets.push("max_per_hour = @maxPerHour");
    params.maxPerHour = patch.maxPerHour;
  }
  if (sets.length > 0) db.prepare(`UPDATE hub_shares SET ${sets.join(", ")} WHERE id = @id`).run(params);
  return getShare(id);
}

export function deleteShare(id: string): boolean {
  const remove = db.transaction(() => {
    deleteShareRequestsStmt.run(id);
    deleteForksStmt.run(id);
    return deleteShareStmt.run(id).changes > 0;
  });
  return remove();
}

export function touchShare(id: string): void {
  touchShareStmt.run(Date.now(), id);
}

export function createShareRequest(input: {
  shareId: string;
  kind: ShareRequestKind;
  prompt: string;
  status: ShareRequestStatus;
  taskId: string | null;
  remote: string | null;
  agent: string | null;
  asker: string | null;
  parentSessionId: string | null;
}): ShareRequestRecord {
  const id = randomUUID();
  insertRequestStmt.run({ id, ...input, createdAt: Date.now() });
  return getShareRequest(id) as ShareRequestRecord;
}

export function setShareRequestFork(id: string, forkSessionId: string | null): void {
  setRequestForkStmt.run(forkSessionId, id);
}

export function listAsksForSession(parentSessionId: string, limit = 50): ShareRequestRecord[] {
  return (listAsksForSessionStmt.all(parentSessionId, Math.min(Math.max(limit, 1), 500)) as RequestRow[]).map(toRequest);
}

export interface ShareForkRecord {
  shareId: string;
  asker: string;
  sessionId: string;
  parentSessionId: string | null;
  createdAt: number;
  lastUsedAt: number;
  questions: number;
}

interface ForkRow {
  share_id: string;
  asker: string;
  session_id: string;
  parent_session_id: string | null;
  created_at: number;
  last_used_at: number;
  questions: number;
}

const toFork = (row: ForkRow): ShareForkRecord => ({
  shareId: row.share_id,
  asker: row.asker,
  sessionId: row.session_id,
  parentSessionId: row.parent_session_id,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  questions: row.questions,
});

export function getShareFork(shareId: string, asker: string): ShareForkRecord | null {
  const row = getForkStmt.get(shareId, asker) as ForkRow | undefined;
  return row ? toFork(row) : null;
}

export function touchShareFork(input: { shareId: string; asker: string; sessionId: string; parentSessionId: string | null }): void {
  upsertForkStmt.run({ ...input, now: Date.now() });
}

export function listForksForSession(parentSessionId: string): ShareForkRecord[] {
  return (listForksStmt.all(parentSessionId) as ForkRow[]).map(toFork);
}

export function listShareForks(shareId: string): ShareForkRecord[] {
  return (listShareForksStmt.all(shareId) as ForkRow[]).map(toFork);
}

export function deleteShareForks(shareId: string): number {
  return deleteForksStmt.run(shareId).changes;
}

export function deleteOrphanShareForks(): number {
  return db.prepare(`DELETE FROM hub_share_forks WHERE share_id NOT IN (SELECT id FROM hub_shares)`).run().changes;
}

export function limitOf(value: unknown, fallback = 50, max = 500): number {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function finishShareRequest(input: {
  id: string;
  status: ShareRequestStatus;
  answer: string | null;
  error: string | null;
  sessionId: string | null;
}): ShareRequestRecord | null {
  finishRequestStmt.run({ ...input, finishedAt: Date.now() });
  return getShareRequest(input.id);
}

export function getShareRequest(id: string): ShareRequestRecord | null {
  const row = getRequestStmt.get(id) as RequestRow | undefined;
  return row ? toRequest(row) : null;
}

export function listShareRequests(options: { shareId?: string | null; limit?: number } = {}): ShareRequestRecord[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const rows = options.shareId
    ? (listRequestsByShareStmt.all(options.shareId, limit) as RequestRow[])
    : (listRequestsStmt.all(limit) as RequestRow[]);
  return rows.map(toRequest);
}

export function countRecentShareRequests(shareId: string, sinceMs: number): number {
  return (countRecentStmt.get(shareId, Date.now() - sinceMs) as { n: number }).n;
}

export function hasRunningAsk(shareId: string): boolean {
  return (runningStmt.get(shareId, "ask") as { n: number }).n > 0;
}

export function hasRunningImplement(shareId: string): boolean {
  return (runningStmt.get(shareId, "implement") as { n: number }).n > 0;
}

export function finishShareRequestByTask(input: { taskId: string; status: ShareRequestStatus; error: string | null; sessionId: string | null }): number {
  return finishByTaskStmt.run({ ...input, finishedAt: Date.now() }).changes;
}

export function rotateShareKey(id: string): ShareRecord | null {
  rotateKeyStmt.run(secretKey(), id);
  return getShare(id);
}

export function markInterruptedShareRequests(): number {
  return db
    .prepare(`UPDATE hub_share_requests SET status = 'failed', error = 'hub restarted mid-request', finished_at = ? WHERE status = 'running' AND kind = 'ask'`)
    .run(Date.now()).changes;
}
