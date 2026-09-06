import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "./config.js";

const HEAD_BYTES = 262_144;
const TAIL_BYTES = 262_144;
const ACTIVE_WINDOW_MS = 20 * 60_000;
const ENDED_AFTER_MS = 12 * 3_600_000;
const CACHE_MS = 5_000;

export type CodexSessionStatus = "active" | "idle" | "ended";

export type CodexClient = "codex-app" | "codex-cli" | "codex-exec" | "codex-vscode";

export interface CodexSessionRecord {
  id: string;
  title: string;
  cwd: string | null;
  originator: string | null;
  source: string | null;
  threadSource: string | null;
  client: CodexClient;
  status: CodexSessionStatus;
  turns: number;
  lastMessage: string | null;
  startedAt: number;
  updatedAt: number;
  file: string;
}

type Json = Record<string, unknown>;

const isString = (value: unknown): value is string => typeof value === "string";
const asObject = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

function readSlice(file: string, position: number, length: number): string {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, position);
    return buffer.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
}

function parseLines(text: string): Json[] {
  const out: Json[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = asObject(JSON.parse(trimmed));
      if (parsed) out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

function messageText(payload: Json, role: "user" | "assistant"): string | null {
  if (payload.type !== "message" || payload.role !== role) return null;
  const content = payload.content;
  if (isString(content)) return content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    const item = asObject(part);
    const text = item && isString(item.text) ? item.text : null;
    if (text && (role === "assistant" || !text.trimStart().startsWith("<"))) return text;
  }
  return null;
}

function titleFrom(text: string | null, cwd: string | null): string {
  const firstLine = (text ?? "").split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
  if (firstLine.length > 0) return firstLine.slice(0, 100);
  return cwd ? basename(cwd) : "codex";
}

export function classifyCodexClient(originator: string | null, source: string | null): CodexClient {
  const origin = (originator ?? "").toLowerCase();
  const src = (source ?? "").toLowerCase();
  if (origin.includes("desktop")) return "codex-app";
  if (origin.includes("exec") || src === "exec") return "codex-exec";
  if (src === "vscode") return "codex-vscode";
  return "codex-cli";
}

export function parseRollout(file: string, now = Date.now()): CodexSessionRecord | null {
  const stat = statSync(file);
  const head = parseLines(readSlice(file, 0, Math.min(HEAD_BYTES, stat.size)));
  const meta = head.find((entry) => entry.type === "session_meta");
  const payload = meta ? asObject(meta.payload) : null;
  if (!payload) return null;
  const id = isString(payload.id) ? payload.id : isString(payload.session_id) ? payload.session_id : null;
  if (!id) return null;
  const cwd = isString(payload.cwd) ? payload.cwd : null;
  let firstUser: string | null = null;
  for (const entry of head) {
    if (entry.type !== "response_item") continue;
    const inner = asObject(entry.payload);
    const text = inner ? messageText(inner, "user") : null;
    if (text) {
      firstUser = text;
      break;
    }
  }
  const tailStart = Math.max(0, stat.size - TAIL_BYTES);
  const tail = tailStart === 0 ? head : parseLines(readSlice(file, tailStart, stat.size - tailStart));
  let lastStarted = -1;
  let lastCompleted = -1;
  let turns = 0;
  let lastMessage: string | null = null;
  tail.forEach((entry, index) => {
    if (entry.type === "response_item") {
      const inner = asObject(entry.payload);
      const text = inner ? messageText(inner, "assistant") : null;
      if (text) lastMessage = text.trim().slice(0, 300);
      return;
    }
    if (entry.type !== "event_msg") return;
    const inner = asObject(entry.payload);
    if (!inner) return;
    if (inner.type === "task_started") lastStarted = index;
    if (inner.type === "task_complete") {
      lastCompleted = index;
      turns += 1;
    }
  });
  const updatedAt = stat.mtimeMs;
  const inTurn = lastStarted > lastCompleted;
  const status: CodexSessionStatus =
    now - updatedAt > ENDED_AFTER_MS ? "ended" : inTurn && now - updatedAt < ACTIVE_WINDOW_MS ? "active" : "idle";
  const startedAt = isString(payload.timestamp) ? Date.parse(payload.timestamp) || stat.birthtimeMs : stat.birthtimeMs;
  const originator = isString(payload.originator) ? payload.originator : null;
  const source = isString(payload.source) ? payload.source : null;
  return {
    id,
    title: titleFrom(firstUser, cwd),
    cwd,
    originator,
    source,
    threadSource: isString(payload.thread_source) ? payload.thread_source : null,
    client: classifyCodexClient(originator, source),
    status,
    turns,
    lastMessage,
    startedAt,
    updatedAt,
    file,
  };
}

function dayDirs(root: string, days: number, now: number): string[] {
  const dirs: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(now - offset * 86_400_000);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    dirs.push(join(root, year, month, day));
  }
  return dirs;
}

export function scanCodexSessions(
  root: string = config.codexSessionsDir,
  options: { days?: number; limit?: number; now?: number } = {},
): CodexSessionRecord[] {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 40;
  const records: CodexSessionRecord[] = [];
  for (const dir of dayDirs(root, options.days ?? 3, now)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      try {
        const record = parseRollout(join(dir, entry), now);
        if (record) records.push(record);
      } catch {
        continue;
      }
    }
  }
  return records.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

let cached: { at: number; value: CodexSessionRecord[] } | null = null;

export function listCodexSessions(): CodexSessionRecord[] {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = scanCodexSessions();
  cached = { at: now, value };
  return value;
}
