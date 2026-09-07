import { applyCodexOverlay, scanCodexSessions } from "./codex-sessions.js";
import type { CodexSessionRecord, CodexThreadOverride } from "./codex-sessions.js";
import { db } from "./db.js";
import { listCodexRunLinks } from "./delegation-store.js";

const CACHE_MS = 5_000;

db.exec(`
  CREATE TABLE IF NOT EXISTS codex_threads (
    id            TEXT PRIMARY KEY,
    custom_title  TEXT,
    archived_at   INTEGER,
    hidden_at     INTEGER
  );
`);

interface CodexThreadRow {
  id: string;
  custom_title: string | null;
  archived_at: number | null;
  hidden_at: number | null;
}

const listOverridesStmt = db.prepare(`SELECT * FROM codex_threads`);
const setTitleStmt = db.prepare(`
  INSERT INTO codex_threads (id, custom_title) VALUES (@id, @title)
  ON CONFLICT(id) DO UPDATE SET custom_title = @title
`);
const setArchivedStmt = db.prepare(`
  INSERT INTO codex_threads (id, archived_at) VALUES (@id, @archivedAt)
  ON CONFLICT(id) DO UPDATE SET archived_at = @archivedAt
`);
const setHiddenStmt = db.prepare(`
  INSERT INTO codex_threads (id, archived_at, hidden_at) VALUES (@id, @now, @now)
  ON CONFLICT(id) DO UPDATE SET archived_at = @now, hidden_at = @now
`);

const toOverride = (row: CodexThreadRow): CodexThreadOverride => ({
  id: row.id,
  customTitle: row.custom_title,
  archivedAt: row.archived_at,
  hidden: row.hidden_at != null,
});

export function listCodexOverrides(): CodexThreadOverride[] {
  return (listOverridesStmt.all() as CodexThreadRow[]).map(toOverride);
}

let cached: { at: number; value: CodexSessionRecord[] } | null = null;

function invalidate(): void {
  cached = null;
}

export function listCodexSessions(): CodexSessionRecord[] {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = applyCodexOverlay(scanCodexSessions(), {
    links: listCodexRunLinks(),
    overrides: listCodexOverrides(),
  });
  cached = { at: now, value };
  return value;
}

export function setCodexTitle(id: string, title: string | null): void {
  const clean = title && title.trim().length > 0 ? title.trim() : null;
  setTitleStmt.run({ id, title: clean });
  invalidate();
}

export function archiveCodexThread(id: string): void {
  setArchivedStmt.run({ id, archivedAt: Date.now() });
  invalidate();
}

export function unarchiveCodexThread(id: string): void {
  setArchivedStmt.run({ id, archivedAt: null });
  invalidate();
}

export function hideCodexThread(id: string): void {
  setHiddenStmt.run({ id, now: Date.now() });
  invalidate();
}
