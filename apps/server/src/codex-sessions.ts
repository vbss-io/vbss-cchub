import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "./config.js";
import type { TranscriptEntry } from "./transcript.js";

const HEAD_BYTES = 262_144;
const TAIL_BYTES = 262_144;
const ACTIVE_WINDOW_MS = 20 * 60_000;
const ENDED_AFTER_MS = 12 * 3_600_000;
const EXEC_ENDED_AFTER_MS = 2 * 60_000;
const MAX_TEXT = 4_000;
const MAX_TOOL_TEXT = 200;

const INJECTED_USER_PREFIXES = [
  "<recommended_plugins",
  "<environment_context",
  "<user_instructions",
  "<permissions",
  "<turn_aborted",
  "<codex_internal_context",
  "<system-reminder",
  "# AGENTS.md instructions",
  "You are running inside the",
  "You have an MCP server named",
];

export type CodexSessionStatus = "active" | "idle" | "ended";

export type CodexClient = "codex-app" | "codex-cli" | "codex-exec" | "codex-vscode";

export type CodexOrigin = "hub" | null;

export interface CodexRunLink {
  threadId: string;
  taskId: string;
  latestRunStatus: string;
  taskTitle?: string | null;
}

export interface CodexThreadOverride {
  id: string;
  customTitle: string | null;
  archivedAt: number | null;
  hidden: boolean;
}

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
  origin: CodexOrigin;
  hubTaskId: string | null;
  customTitle: string | null;
  archivedAt: number | null;
  hidden: boolean;
}

const FINISHED_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "attention"]);

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

const clip = (text: string, max: number): string => {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
};

function joinTextParts(payload: Json): string | null {
  const content = payload.content;
  if (isString(content)) return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    const item = asObject(part);
    if (item && isString(item.text)) parts.push(item.text);
  }
  const text = parts.join("\n").trim();
  return text.length > 0 ? text : null;
}

function messageText(payload: Json, role: "user" | "assistant"): string | null {
  if (payload.type !== "message" || payload.role !== role) return null;
  return joinTextParts(payload);
}

const isInjectedContext = (text: string): boolean => {
  const trimmed = text.trimStart();
  return INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
};

const HUB_CONTEXT_PREFIXES = ["You are running inside the", "You have an MCP server named"];
const HUB_CONTEXT_SEPARATOR = "\n\n---\n\n";
const INJECTED_TAG = /^<([a-z_-]+)[\s>]/i;

export function stripInjectedContext(text: string): string {
  let rest = text.trimStart();
  for (let guard = 0; guard < 8 && rest.length > 0; guard += 1) {
    if (!isInjectedContext(rest)) return rest.trim();
    if (HUB_CONTEXT_PREFIXES.some((prefix) => rest.startsWith(prefix))) {
      const separator = rest.indexOf(HUB_CONTEXT_SEPARATOR);
      if (separator < 0) return "";
      rest = rest.slice(separator + HUB_CONTEXT_SEPARATOR.length).trimStart();
      continue;
    }
    const name = rest.match(INJECTED_TAG)?.[1];
    if (!name) return "";
    const close = rest.indexOf(`</${name}>`);
    if (close < 0) return "";
    rest = rest.slice(close + name.length + 3).trimStart();
  }
  return rest.trim();
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
    const real = text ? stripInjectedContext(text) : "";
    if (real.length > 0) {
      firstUser = real;
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
  const turnClosed = lastCompleted >= 0 && lastCompleted >= lastStarted;
  const originator = isString(payload.originator) ? payload.originator : null;
  const source = isString(payload.source) ? payload.source : null;
  const activity: CodexSessionStatus = inTurn && now - updatedAt < ACTIVE_WINDOW_MS ? "active" : "idle";
  const execEnded = source === "exec" && turnClosed && now - updatedAt > EXEC_ENDED_AFTER_MS;
  const status: CodexSessionStatus =
    now - updatedAt > ENDED_AFTER_MS || execEnded ? "ended" : activity;
  const startedAt = isString(payload.timestamp) ? Date.parse(payload.timestamp) || stat.birthtimeMs : stat.birthtimeMs;
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
    origin: null,
    hubTaskId: null,
    customTitle: null,
    archivedAt: null,
    hidden: false,
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

export function applyCodexOverlay(
  records: CodexSessionRecord[],
  overlay: { links?: CodexRunLink[]; overrides?: CodexThreadOverride[] } = {},
): CodexSessionRecord[] {
  const linkById = new Map((overlay.links ?? []).map((link) => [link.threadId, link]));
  const overrideById = new Map((overlay.overrides ?? []).map((override) => [override.id, override]));
  const out: CodexSessionRecord[] = [];
  for (const record of records) {
    const override = overrideById.get(record.id);
    if (override?.hidden) continue;
    const link = linkById.get(record.id);
    const status = link && FINISHED_RUN_STATUSES.has(link.latestRunStatus) ? "ended" : record.status;
    out.push({
      ...record,
      status,
      title: link?.taskTitle ? link.taskTitle : record.title,
      origin: link ? "hub" : record.origin,
      hubTaskId: link ? link.taskId : record.hubTaskId,
      customTitle: override?.customTitle ?? null,
      archivedAt: override?.archivedAt ?? null,
      hidden: override?.hidden ?? false,
    });
  }
  return out;
}

function readMetaId(file: string): string | null {
  const stat = statSync(file);
  const head = parseLines(readSlice(file, 0, Math.min(HEAD_BYTES, stat.size)));
  const meta = head.find((entry) => entry.type === "session_meta");
  const payload = meta ? asObject(meta.payload) : null;
  if (!payload) return null;
  return isString(payload.id) ? payload.id : isString(payload.session_id) ? payload.session_id : null;
}

export function findCodexRollout(
  id: string,
  root: string = config.codexSessionsDir,
  options: { days?: number; now?: number } = {},
): string | null {
  const now = options.now ?? Date.now();
  for (const dir of dayDirs(root, options.days ?? 3, now)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const file = join(dir, entry);
      try {
        if (readMetaId(file) === id) return file;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function codexToolSummary(payload: Json): string {
  const raw = payload.arguments;
  let obj: Json | null = null;
  if (isString(raw)) {
    try {
      obj = asObject(JSON.parse(raw));
    } catch {
      obj = null;
    }
  } else {
    obj = asObject(raw);
  }
  if (obj) {
    for (const key of ["command", "file_path", "path", "pattern", "query", "url", "cmd"]) {
      const value = obj[key];
      if (isString(value) && value.trim().length > 0) return clip(value, MAX_TOOL_TEXT);
      if (Array.isArray(value)) {
        const joined = value.filter(isString).join(" ");
        if (joined.trim().length > 0) return clip(joined, MAX_TOOL_TEXT);
      }
    }
    const first = Object.values(obj).find(isString);
    if (first) return clip(first, MAX_TOOL_TEXT);
  }
  return isString(raw) ? clip(raw, MAX_TOOL_TEXT) : "";
}

function codexOutputText(output: unknown): string {
  if (isString(output)) return clip(output, MAX_TOOL_TEXT);
  if (Array.isArray(output)) {
    const text = output
      .map((part) => {
        const item = asObject(part);
        return item && isString(item.text) ? item.text : "";
      })
      .filter((value) => value.length > 0)
      .join("\n");
    return clip(text, MAX_TOOL_TEXT);
  }
  const item = asObject(output);
  return item && isString(item.text) ? clip(item.text, MAX_TOOL_TEXT) : "";
}

function codexEntriesFromPayload(payload: Json, at: number | null): TranscriptEntry[] {
  const type = payload.type;
  if (type === "message") {
    if (payload.role === "user") {
      const text = joinTextParts(payload);
      const real = text ? stripInjectedContext(text) : "";
      if (!real) return [];
      return [{ at, role: "user", text: clip(real, MAX_TEXT), tool: null }];
    }
    if (payload.role === "assistant") {
      const text = joinTextParts(payload);
      return text ? [{ at, role: "assistant", text: clip(text, MAX_TEXT), tool: null }] : [];
    }
    return [];
  }
  if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
    const name = isString(payload.name) ? payload.name : type === "local_shell_call" ? "shell" : "tool";
    return [{ at, role: "tool", text: codexToolSummary(payload), tool: name }];
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const text = codexOutputText(payload.output);
    return [{ at, role: "result", text: text || "(no output)", tool: null }];
  }
  return [];
}

export function codexLiveEntries(file: string, limit = 40): TranscriptEntry[] {
  let text: string;
  try {
    const stat = statSync(file);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    text = readSlice(file, start, stat.size - start);
  } catch {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const entry of parseLines(text)) {
    if (entry.type !== "response_item") continue;
    const inner = asObject(entry.payload);
    if (!inner) continue;
    const at = isString(entry.timestamp) ? Date.parse(entry.timestamp) || null : null;
    entries.push(...codexEntriesFromPayload(inner, at));
  }
  return entries.slice(-limit);
}
