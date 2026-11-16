import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { stripInjectedContext } from "./codex-sessions.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { getSettings } from "./delegation-store.js";
import type { WorkspaceRecord } from "./delegation-types.js";
import { broadcast, onBroadcast } from "./sse.js";
import { redact } from "./trail.js";
import { discoverWorkspaces, workspaceFor } from "./workspaces.js";

export const HISTORY_TEXT_CAP = 4000;
export const HISTORY_STEP_BYTES = 1_048_576;
export const HISTORY_CLIENTS = ["claude", "codex"] as const;
export type HistoryClient = (typeof HISTORY_CLIENTS)[number];
export type HistoryRole = "user" | "assistant";
export type HistorySort = "relevance" | "recent";
export type HistoryGroup = "message" | "session";
export type HistoryEngine = "fts" | "like";

const HEAD_BYTES = 512;
const GIANT_LINE_CHARS = 65_536;
const TITLE_CAP = 100;
const MAX_TOKENS = 8;
const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MAX = 100;
const SNIPPET_BEFORE = 60;
const SNIPPET_LENGTH = 220;
const BROADCAST_EVERY_MS = 2000;
const START_DELAY_MS = 20_000;
const RESCAN_INTERVAL_MS = 5 * 60_000;
const DISCOVERY_YIELD_EVERY = 50;
const TITLE_RANK = { prompt: 1, ai: 2, custom: 3 } as const;

const CLAUDE_INJECTED = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|user-prompt-submit-hook)\b/i;
const CLAUDE_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const CLAUDE_CAVEAT = /^Caveat: The messages below were generated/;

type Json = Record<string, unknown>;

const isString = (value: unknown): value is string => typeof value === "string";
const asObject = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);

db.exec(`
  CREATE TABLE IF NOT EXISTS history_files (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    path         TEXT NOT NULL UNIQUE,
    client       TEXT NOT NULL,
    session_id   TEXT,
    cwd          TEXT,
    title        TEXT,
    title_rank   INTEGER NOT NULL DEFAULT 0,
    size         INTEGER NOT NULL DEFAULT 0,
    mtime        REAL NOT NULL DEFAULT 0,
    byte_offset  INTEGER NOT NULL DEFAULT 0,
    seq          INTEGER NOT NULL DEFAULT 0,
    head         TEXT NOT NULL DEFAULT '',
    first_at     INTEGER,
    last_at      INTEGER,
    indexed_at   INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS history_messages (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id  INTEGER NOT NULL,
    seq      INTEGER NOT NULL,
    role     TEXT NOT NULL,
    at       INTEGER,
    text     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_messages_file ON history_messages(file_id, seq);
  CREATE INDEX IF NOT EXISTS idx_history_messages_at ON history_messages(at);
  CREATE INDEX IF NOT EXISTS idx_history_files_session ON history_files(session_id);
`);

const FTS_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS history_messages_ai AFTER INSERT ON history_messages BEGIN
    INSERT INTO history_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS history_messages_ad AFTER DELETE ON history_messages BEGIN
    INSERT INTO history_fts(history_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
`;

function ensureFts(): boolean {
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(text, content='history_messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');`);
    db.exec(FTS_TRIGGERS);
    return true;
  } catch {
    return false;
  }
}

const ftsAvailable = ensureFts();

interface FileRow {
  id: number;
  path: string;
  client: HistoryClient;
  session_id: string | null;
  cwd: string | null;
  title: string | null;
  title_rank: number;
  size: number;
  mtime: number;
  byte_offset: number;
  seq: number;
  head: string;
  first_at: number | null;
  last_at: number | null;
}

const getFileStmt = db.prepare(`SELECT * FROM history_files WHERE path = ?`);
const insertFileStmt = db.prepare(`INSERT INTO history_files (path, client) VALUES (?, ?)`);
const updateFileStmt = db.prepare(`
  UPDATE history_files SET session_id = @session_id, cwd = @cwd, title = @title, title_rank = @title_rank, size = @size, mtime = @mtime,
    byte_offset = @byte_offset, seq = @seq, head = @head, first_at = @first_at, last_at = @last_at, indexed_at = @indexed_at
  WHERE id = @id
`);
const insertMessageStmt = db.prepare(`INSERT INTO history_messages (file_id, seq, role, at, text) VALUES (?, ?, ?, ?, ?)`);
const deleteMessagesStmt = db.prepare(`DELETE FROM history_messages WHERE file_id = ?`);
const deleteFileStmt = db.prepare(`DELETE FROM history_files WHERE id = ?`);
const listFilePathsStmt = db.prepare(`SELECT id, path FROM history_files`);
const distinctCwdsStmt = db.prepare(`SELECT DISTINCT cwd FROM history_files WHERE cwd IS NOT NULL`);

interface Discovered {
  client: HistoryClient;
  path: string;
}

interface IndexedMessage {
  role: HistoryRole;
  at: number | null;
  text: string;
}

interface LineFacts {
  message: IndexedMessage | null;
  cwd: string | null;
  sessionId: string | null;
  title: { text: string; rank: number } | null;
}

const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function timeOf(value: unknown): number | null {
  if (!isString(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function prepareHistoryText(text: string): string {
  const head = text.length > HISTORY_TEXT_CAP * 2 ? text.slice(0, HISTORY_TEXT_CAP * 2) : text;
  const clean = redact(head).text.trim();
  return clean.length > HISTORY_TEXT_CAP ? `${clean.slice(0, HISTORY_TEXT_CAP)}…` : clean;
}

function textParts(content: unknown): string {
  if (isString(content)) return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const item = asObject(part);
    if (item && (item.type === "text" || item.type === "input_text" || item.type === "output_text") && isString(item.text)) parts.push(item.text);
  }
  return parts.join("\n");
}

function cleanClaudeUser(text: string): string {
  const stripped = text.replace(CLAUDE_REMINDER, "").trim();
  if (CLAUDE_INJECTED.test(stripped) || CLAUDE_CAVEAT.test(stripped)) return "";
  return stripped;
}

const emptyFacts = (): LineFacts => ({ message: null, cwd: null, sessionId: null, title: null });

export function claudeLineFacts(line: string): LineFacts | null {
  if (line.length > GIANT_LINE_CHARS && line.includes('"tool_result"')) return null;
  let entry: Json | null;
  try {
    entry = asObject(JSON.parse(line));
  } catch {
    return null;
  }
  if (!entry) return null;
  const facts = emptyFacts();
  if (isString(entry.cwd)) facts.cwd = entry.cwd;
  if (isString(entry.sessionId)) facts.sessionId = entry.sessionId;
  if (entry.type === "custom-title" && isString(entry.customTitle) && entry.customTitle.trim()) facts.title = { text: entry.customTitle.trim(), rank: TITLE_RANK.custom };
  if (entry.type === "ai-title" && isString(entry.aiTitle) && entry.aiTitle.trim()) facts.title = { text: entry.aiTitle.trim(), rank: TITLE_RANK.ai };
  if ((entry.type === "user" || entry.type === "assistant") && entry.isMeta !== true && entry.isSidechain !== true) {
    const message = asObject(entry.message);
    const raw = textParts(message?.content);
    const text = entry.type === "user" ? cleanClaudeUser(raw) : raw.trim();
    if (text) facts.message = { role: entry.type, at: timeOf(entry.timestamp), text: prepareHistoryText(text) };
  }
  return facts;
}

export function codexLineFacts(line: string): LineFacts | null {
  if (!line.includes('"session_meta"') && !line.includes('"response_item"')) return null;
  if (line.length > GIANT_LINE_CHARS && (line.includes('"function_call_output"') || line.includes('"custom_tool_call_output"'))) return null;
  let entry: Json | null;
  try {
    entry = asObject(JSON.parse(line));
  } catch {
    return null;
  }
  if (!entry) return null;
  const payload = asObject(entry.payload);
  if (!payload) return null;
  const facts = emptyFacts();
  if (entry.type === "session_meta") {
    facts.sessionId = isString(payload.id) ? payload.id : isString(payload.session_id) ? payload.session_id : null;
    facts.cwd = isString(payload.cwd) ? payload.cwd : null;
    return facts;
  }
  if (entry.type !== "response_item" || payload.type !== "message") return facts;
  if (payload.role !== "user" && payload.role !== "assistant") return facts;
  const raw = textParts(payload.content);
  const text = payload.role === "user" ? stripInjectedContext(raw) : raw.trim();
  if (text) facts.message = { role: payload.role, at: timeOf(entry.timestamp), text: prepareHistoryText(text) };
  return facts;
}

function listJsonl(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

async function discoverClaude(root: string): Promise<Discovered[]> {
  const found: Discovered[] = [];
  let visited = 0;
  for (const dir of subdirs(root)) {
    for (const path of listJsonl(dir)) found.push({ client: "claude", path });
    visited += 1;
    if (visited % DISCOVERY_YIELD_EVERY === 0) await pause();
  }
  return found;
}

async function discoverCodex(root: string): Promise<Discovered[]> {
  const found: Discovered[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const path of listJsonl(dir)) found.push({ client: "codex", path });
    visited += 1;
    if (visited % DISCOVERY_YIELD_EVERY === 0) await pause();
    if (depth >= 3) return;
    for (const child of subdirs(dir)) await walk(child, depth + 1);
  };
  if (existsSync(root)) await walk(root, 0);
  return found;
}

function readBytes(path: string, position: number, length: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, position);
    return read === length ? buffer : buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

const headOf = (path: string, size: number): string => (size > 0 ? readBytes(path, 0, Math.min(HEAD_BYTES, size)).toString("hex") : "");

const sameHead = (stored: string, current: string): boolean => (stored.length <= current.length ? current.startsWith(stored) : stored.startsWith(current));

function firstLineTitle(text: string): string {
  const line = text.split(/\r?\n/).find((item) => item.trim().length > 0)?.trim() ?? "";
  return line.length > TITLE_CAP ? `${line.slice(0, TITLE_CAP)}…` : line;
}

type FileState = FileRow;

function freshState(row: FileRow): FileState {
  return { ...row, session_id: null, cwd: null, title: null, title_rank: 0, byte_offset: 0, seq: 0, head: "", first_at: null, last_at: null };
}

function applyFacts(state: FileState, facts: LineFacts, pending: IndexedMessage[]): void {
  if (facts.cwd && !state.cwd) state.cwd = facts.cwd;
  if (facts.sessionId && state.client === "codex" && !state.session_id) state.session_id = facts.sessionId;
  if (facts.title && facts.title.rank >= state.title_rank) {
    state.title = facts.title.text.slice(0, TITLE_CAP * 2);
    state.title_rank = facts.title.rank;
  }
  const message = facts.message;
  if (!message) return;
  if (message.role === "user" && state.title_rank < TITLE_RANK.prompt) {
    state.title = firstLineTitle(message.text);
    state.title_rank = TITLE_RANK.prompt;
  }
  if (message.at !== null) {
    state.first_at = state.first_at === null ? message.at : Math.min(state.first_at, message.at);
    state.last_at = state.last_at === null ? message.at : Math.max(state.last_at, message.at);
  }
  pending.push(message);
}

const commitStep = db.transaction((state: FileState, pending: IndexedMessage[], resetFirst: boolean) => {
  if (resetFirst) deleteMessagesStmt.run(state.id);
  for (const message of pending) {
    state.seq += 1;
    insertMessageStmt.run(state.id, state.seq, message.role, message.at, message.text);
  }
  updateFileStmt.run({ ...state, indexed_at: Date.now() });
});

function nextNewline(path: string, from: number, size: number): number {
  let position = from;
  while (position < size) {
    const chunk = readBytes(path, position, Math.min(HISTORY_STEP_BYTES, size - position));
    if (chunk.length === 0) return -1;
    const index = chunk.indexOf(0x0a);
    if (index >= 0) return position + index;
    position += chunk.length;
  }
  return -1;
}

interface FileOutcome {
  status: "skipped" | "indexed" | "reset" | "missing";
  rows: number;
  bytes: number;
}

let stopRequested = false;

async function indexFile(source: Discovered): Promise<FileOutcome> {
  let size: number;
  let mtime: number;
  try {
    const stat = statSync(source.path);
    size = stat.size;
    mtime = stat.mtimeMs;
  } catch {
    return { status: "missing", rows: 0, bytes: 0 };
  }
  let row = getFileStmt.get(source.path) as FileRow | undefined;
  if (row && row.size === size && row.mtime === mtime) return { status: "skipped", rows: 0, bytes: 0 };
  if (!row) {
    insertFileStmt.run(source.path, source.client);
    row = getFileStmt.get(source.path) as FileRow;
  }
  const head = headOf(source.path, size);
  const replaced = size < row.byte_offset || !sameHead(row.head, head);
  const state: FileState = replaced ? freshState(row) : { ...row };
  if (source.client === "claude") state.session_id = basename(source.path, ".jsonl");
  state.head = head;
  let resetPending = replaced;
  let rows = 0;
  let bytes = 0;
  const parse = source.client === "claude" ? claudeLineFacts : codexLineFacts;
  while (state.byte_offset < size && !stopRequested) {
    const chunk = readBytes(source.path, state.byte_offset, Math.min(HISTORY_STEP_BYTES, size - state.byte_offset));
    if (chunk.length === 0) break;
    const lastBreak = chunk.lastIndexOf(0x0a);
    if (lastBreak < 0) {
      if (state.byte_offset + chunk.length >= size) break;
      const skipTo = nextNewline(source.path, state.byte_offset + chunk.length, size);
      if (skipTo < 0) break;
      bytes += skipTo + 1 - state.byte_offset;
      state.byte_offset = skipTo + 1;
      commitStep(state, [], resetPending);
      resetPending = false;
      await pause();
      continue;
    }
    const pending: IndexedMessage[] = [];
    let start = 0;
    while (start <= lastBreak) {
      const end = chunk.indexOf(0x0a, start);
      const line = chunk.toString("utf8", start, end).trim();
      start = end + 1;
      if (!line) continue;
      const facts = parse(line);
      if (facts) applyFacts(state, facts, pending);
    }
    state.byte_offset += lastBreak + 1;
    bytes += lastBreak + 1;
    rows += pending.length;
    commitStep(state, pending, resetPending);
    resetPending = false;
    await pause();
  }
  if (!stopRequested) {
    state.size = size;
    state.mtime = mtime;
  }
  commitStep(state, [], resetPending);
  return { status: replaced && row.byte_offset > 0 ? "reset" : "indexed", rows, bytes };
}

export interface HistoryRunSummary {
  files: number;
  indexed: number;
  reset: number;
  skipped: number;
  removed: number;
  rows: number;
  bytes: number;
  ms: number;
  stopped: boolean;
}

export interface HistoryIndexStatus {
  enabled: boolean;
  engine: HistoryEngine;
  running: boolean;
  progress: { done: number; total: number } | null;
  files: number;
  sessions: number;
  rows: number;
  textBytes: number;
  dbBytes: number;
  lastBuildMs: number | null;
  lastBuildAt: number | null;
  lastRun: HistoryRunSummary | null;
  lastError: string | null;
  roots: { claude: string; codex: string };
}

export interface HistoryRoots {
  claude: string;
  codex: string;
}

const defaultRoots = (): HistoryRoots => ({ claude: config.claudeProjectsDir, codex: config.codexSessionsDir });

let running: Promise<HistoryRunSummary> | null = null;
let progress: { done: number; total: number } | null = null;
let lastRun: HistoryRunSummary | null = null;
let lastBuildAt: number | null = null;
let lastError: string | null = null;
let lastBroadcastAt = 0;

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function historyStatus(roots: HistoryRoots = defaultRoots()): HistoryIndexStatus {
  const counts = db
    .prepare(`SELECT (SELECT COUNT(*) FROM history_files) AS files, (SELECT COUNT(DISTINCT session_id) FROM history_files) AS sessions, (SELECT COUNT(*) FROM history_messages) AS rows, (SELECT COALESCE(SUM(LENGTH(text)), 0) FROM history_messages) AS textBytes`)
    .get() as { files: number; sessions: number; rows: number; textBytes: number };
  return {
    enabled: getSettings().memory.historyIndex,
    engine: ftsAvailable ? "fts" : "like",
    running: running !== null,
    progress,
    files: counts.files,
    sessions: counts.sessions,
    rows: counts.rows,
    textBytes: counts.textBytes,
    dbBytes: fileSize(config.dbPath) + fileSize(`${config.dbPath}-wal`),
    lastBuildMs: lastRun?.ms ?? null,
    lastBuildAt,
    lastRun,
    lastError,
    roots,
  };
}

function announce(force: boolean): void {
  const now = Date.now();
  if (!force && now - lastBroadcastAt < BROADCAST_EVERY_MS) return;
  lastBroadcastAt = now;
  try {
    broadcast("history", historyStatus());
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
}

function removeVanished(seen: Set<string>): number {
  const rows = listFilePathsStmt.all() as { id: number; path: string }[];
  let removed = 0;
  const drop = db.transaction((id: number) => {
    deleteMessagesStmt.run(id);
    deleteFileStmt.run(id);
  });
  for (const row of rows) {
    if (seen.has(row.path) || existsSync(row.path)) continue;
    drop(row.id);
    removed += 1;
  }
  return removed;
}

async function runPass(roots: HistoryRoots): Promise<HistoryRunSummary> {
  const started = Date.now();
  const summary: HistoryRunSummary = { files: 0, indexed: 0, reset: 0, skipped: 0, removed: 0, rows: 0, bytes: 0, ms: 0, stopped: false };
  const sources = [...(await discoverClaude(roots.claude)), ...(await discoverCodex(roots.codex))];
  summary.files = sources.length;
  progress = { done: 0, total: sources.length };
  announce(true);
  for (const source of sources) {
    if (stopRequested) break;
    try {
      const outcome = await indexFile(source);
      if (outcome.status === "skipped") summary.skipped += 1;
      else if (outcome.status === "reset") summary.reset += 1;
      else if (outcome.status === "indexed") summary.indexed += 1;
      summary.rows += outcome.rows;
      summary.bytes += outcome.bytes;
    } catch (err) {
      lastError = `${source.path}: ${err instanceof Error ? err.message : String(err)}`;
    }
    progress = { done: progress.done + 1, total: sources.length };
    announce(false);
  }
  summary.stopped = stopRequested;
  if (!stopRequested) summary.removed = removeVanished(new Set(sources.map((source) => source.path)));
  summary.ms = Date.now() - started;
  return summary;
}

export function runHistoryIndex(roots: HistoryRoots = defaultRoots()): Promise<HistoryRunSummary> {
  if (running) return running;
  stopRequested = false;
  const pass = (async (): Promise<HistoryRunSummary> => {
    try {
      const summary = await runPass(roots);
      lastRun = summary;
      lastBuildAt = Date.now();
      if (!summary.stopped) lastError = null;
      return summary;
    } finally {
      running = null;
      progress = null;
      announce(true);
    }
  })();
  running = pass;
  return pass;
}

export function whenHistoryIdle(): Promise<void> {
  return running ? running.then(() => undefined) : Promise.resolve();
}

export async function stopHistoryIndex(): Promise<void> {
  if (!running) return;
  stopRequested = true;
  await whenHistoryIdle();
  stopRequested = false;
}

export async function clearHistoryIndex(): Promise<void> {
  await stopHistoryIndex();
  const wipe = db.transaction(() => {
    if (ftsAvailable) db.exec(`DROP TRIGGER IF EXISTS history_messages_ai; DROP TRIGGER IF EXISTS history_messages_ad;`);
    db.exec(`DELETE FROM history_messages; DELETE FROM history_files;`);
    if (ftsAvailable) {
      db.exec(`INSERT INTO history_fts(history_fts) VALUES ('delete-all');`);
      db.exec(FTS_TRIGGERS);
    }
  });
  wipe();
  lastRun = null;
  lastBuildAt = null;
  announce(true);
}

export async function rebuildHistoryIndex(roots: HistoryRoots = defaultRoots()): Promise<HistoryRunSummary> {
  await clearHistoryIndex();
  return runHistoryIndex(roots);
}

let startTimer: NodeJS.Timeout | null = null;
let rescanTimer: NodeJS.Timeout | null = null;
let unwatchSettings: (() => void) | null = null;

function scheduledPass(): void {
  if (!getSettings().memory.historyIndex) return;
  void runHistoryIndex().catch((err: unknown) => {
    lastError = err instanceof Error ? err.message : String(err);
  });
}

function applyHistorySetting(enabled: boolean): void {
  if (enabled) {
    scheduledPass();
    return;
  }
  void stopHistoryIndex();
}

export function startHistoryIndexer(delayMs = START_DELAY_MS, intervalMs = RESCAN_INTERVAL_MS): void {
  stopHistoryIndexer();
  startTimer = setTimeout(scheduledPass, delayMs);
  startTimer.unref();
  rescanTimer = setInterval(scheduledPass, intervalMs);
  rescanTimer.unref();
  let enabled = getSettings().memory.historyIndex;
  unwatchSettings = onBroadcast((event) => {
    if (event !== "settings") return;
    const next = getSettings().memory.historyIndex;
    if (next === enabled) return;
    enabled = next;
    applyHistorySetting(next);
  });
}

export function stopHistoryIndexer(): void {
  if (startTimer) clearTimeout(startTimer);
  if (rescanTimer) clearInterval(rescanTimer);
  unwatchSettings?.();
  startTimer = null;
  rescanTimer = null;
  unwatchSettings = null;
}

export interface HistorySearchInput {
  q: string;
  client?: HistoryClient | null;
  workspace?: string | null;
  from?: number | null;
  to?: number | null;
  limit?: number;
  offset?: number;
  sort?: HistorySort;
  group?: HistoryGroup;
  engine?: HistoryEngine;
}

export interface HistoryHit {
  messageId: number;
  sessionId: string | null;
  client: HistoryClient;
  title: string | null;
  cwd: string | null;
  workspace: string | null;
  role: HistoryRole;
  at: number | null;
  seq: number;
  snippet: string;
  highlights: [number, number][];
  matches: number;
}

export interface HistorySearchResult {
  enabled: boolean;
  engine: HistoryEngine;
  query: string;
  tokens: string[];
  hits: HistoryHit[];
  offset: number;
  limit: number;
  hasMore: boolean;
}

export function queryTokens(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(tokens.map((token) => token.toLowerCase()))].slice(0, MAX_TOKENS);
}

const foldChar = (ch: string): string => ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

interface Folded {
  text: string;
  map: number[];
}

function fold(text: string): Folded {
  let out = "";
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const piece = foldChar(text[index] ?? "");
    for (let k = 0; k < piece.length; k += 1) map.push(index);
    out += piece;
  }
  return { text: out, map };
}

export function highlightSnippet(text: string, tokens: string[]): { snippet: string; highlights: [number, number][] } {
  const flat = text.replace(/\s+/g, " ").trim();
  const folded = fold(flat);
  const needles = tokens.map((token) => fold(token).text).filter((needle) => needle.length > 0);
  const found: [number, number][] = [];
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const index = folded.text.indexOf(needle, from);
      if (index < 0) break;
      const start = folded.map[index] ?? 0;
      const end = (folded.map[index + needle.length - 1] ?? start) + 1;
      found.push([start, end]);
      from = index + needle.length;
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  const anchor = merged[0]?.[0] ?? 0;
  const start = Math.max(0, anchor - SNIPPET_BEFORE);
  const end = Math.min(flat.length, start + SNIPPET_LENGTH);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  const snippet = `${prefix}${flat.slice(start, end)}${suffix}`;
  const shift = prefix.length - start;
  const highlights = merged
    .filter((range) => range[1] > start && range[0] < end)
    .map((range): [number, number] => [Math.max(range[0], start) + shift, Math.min(range[1], end) + shift]);
  return { snippet, highlights };
}

function ftsMatch(tokens: string[], query: string): string {
  const prefixLast = !/\s$/.test(query);
  return tokens.map((token, index) => `"${token.replace(/"/g, '""')}"${prefixLast && index === tokens.length - 1 ? "*" : ""}`).join(" ");
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export type WorkspaceResolver = (cwd: string | null) => string | null;

export function workspaceResolver(workspaces: WorkspaceRecord[] = discoverWorkspaces(getSettings().workspacesRoot)): WorkspaceResolver {
  const cache = new Map<string, string | null>();
  return (cwd) => {
    if (!cwd) return null;
    const known = cache.get(cwd);
    if (known !== undefined) return known;
    const name = workspaceFor(workspaces, cwd)?.name ?? null;
    cache.set(cwd, name);
    return name;
  };
}

interface HitRow {
  id: number;
  seq: number;
  role: HistoryRole;
  at: number | null;
  text: string;
  sessionId: string | null;
  client: HistoryClient;
  cwd: string | null;
  title: string | null;
  matches: number;
}

export function searchHistory(input: HistorySearchInput, resolve: WorkspaceResolver = workspaceResolver()): HistorySearchResult {
  const engine: HistoryEngine = input.engine ?? (ftsAvailable ? "fts" : "like");
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? SEARCH_LIMIT_DEFAULT), 1), SEARCH_LIMIT_MAX);
  const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
  const tokens = queryTokens(input.q);
  const enabled = getSettings().memory.historyIndex;
  const empty: HistorySearchResult = { enabled, engine, query: input.q, tokens, hits: [], offset, limit, hasMore: false };
  if (!enabled || tokens.length === 0) return empty;
  const useFts = engine === "fts" && ftsAvailable;
  const where: string[] = [];
  const params: (string | number)[] = [];
  let from = `FROM history_messages m JOIN history_files f ON f.id = m.file_id`;
  let score = "0";
  if (useFts) {
    from = `FROM history_fts JOIN history_messages m ON m.id = history_fts.rowid JOIN history_files f ON f.id = m.file_id`;
    where.push("history_fts MATCH ?");
    params.push(ftsMatch(tokens, input.q));
    score = "bm25(history_fts)";
  } else {
    for (const token of tokens) {
      where.push(`m.text LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(token)}%`);
    }
  }
  if (input.client) {
    where.push("f.client = ?");
    params.push(input.client);
  }
  if (input.workspace) {
    const cwds = (distinctCwdsStmt.all() as { cwd: string }[]).map((row) => row.cwd).filter((cwd) => resolve(cwd) === input.workspace);
    if (cwds.length === 0) return empty;
    where.push(`f.cwd IN (${cwds.map(() => "?").join(", ")})`);
    params.push(...cwds);
  }
  if (typeof input.from === "number") {
    where.push("COALESCE(m.at, f.last_at) >= ?");
    params.push(input.from);
  }
  if (typeof input.to === "number") {
    where.push("COALESCE(m.at, f.last_at) < ?");
    params.push(input.to);
  }
  const inner = `SELECT m.id AS id, m.file_id AS fileId, m.seq AS seq, m.role AS role, COALESCE(m.at, f.last_at) AS at, m.text AS text, f.session_id AS sessionId, f.client AS client, f.cwd AS cwd, f.title AS title, ${score} AS score ${from} WHERE ${where.join(" AND ")}`;
  const recent = input.sort === "recent" || !useFts;
  const sql =
    input.group === "session"
      ? `WITH hits AS MATERIALIZED (${inner}) SELECT id, seq, role, at, text, sessionId, client, cwd, title, ${recent ? "MAX(at)" : "MIN(score)"} AS pick, COUNT(*) AS matches FROM hits GROUP BY fileId ORDER BY pick ${recent ? "DESC" : "ASC"}, id DESC LIMIT ? OFFSET ?`
      : `SELECT id, seq, role, at, text, sessionId, client, cwd, title, 1 AS matches FROM (${inner}) ORDER BY ${recent ? "at DESC, id DESC" : "score ASC, at DESC"} LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, limit + 1, offset) as HitRow[];
  const hits = rows.slice(0, limit).map((row): HistoryHit => {
    const { snippet, highlights } = highlightSnippet(row.text, tokens);
    return {
      messageId: row.id,
      sessionId: row.sessionId,
      client: row.client,
      title: row.title,
      cwd: row.cwd,
      workspace: resolve(row.cwd),
      role: row.role,
      at: row.at,
      seq: row.seq,
      snippet,
      highlights,
      matches: row.matches,
    };
  });
  return { enabled, engine: useFts ? "fts" : "like", query: input.q, tokens, hits, offset, limit, hasMore: rows.length > limit };
}
