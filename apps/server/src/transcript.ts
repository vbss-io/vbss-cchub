import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

export interface SessionName {
  name: string | null;
  nameSource: string | null;
}

interface SessionMetaFile {
  sessionId?: string;
  name?: string;
  nameSource?: string;
  updatedAt?: number;
}

export function readSessionName(sessionsDir: string, sessionId: string): SessionName {
  let best: SessionMetaFile | null = null;
  try {
    for (const file of readdirSync(sessionsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const entry = JSON.parse(readFileSync(join(sessionsDir, file), "utf8")) as SessionMetaFile;
        if (entry.sessionId === sessionId && (!best || (entry.updatedAt ?? 0) > (best.updatedAt ?? 0))) {
          best = entry;
        }
      } catch {
        continue;
      }
    }
  } catch {
    /* no sessions dir */
  }
  return { name: best?.name ?? null, nameSource: best?.nameSource ?? null };
}

export interface TranscriptInfo {
  title: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  contextTokens: number | null;
}

interface TranscriptLine {
  type?: string;
  aiTitle?: string;
  customTitle?: string;
  timestamp?: string;
  message?: { model?: string; usage?: Record<string, number>; content?: unknown; role?: string };
}

export function readTranscript(path: string | null): TranscriptInfo {
  const out: TranscriptInfo = {
    title: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    contextTokens: null,
  };
  if (!path) return out;

  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").trim().split("\n");
  } catch {
    return out;
  }

  let tokensIn = 0;
  let tokensOut = 0;
  let lastUsage: Record<string, number> | null = null;
  let aiTitle: string | null = null;
  let customTitle: string | null = null;

  for (const line of lines) {
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") aiTitle = entry.aiTitle;
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") customTitle = entry.customTitle;
    if (entry.type === "assistant" && entry.message) {
      if (typeof entry.message.model === "string") out.model = entry.message.model;
      const usage = entry.message.usage;
      if (usage) {
        tokensIn += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        tokensOut += usage.output_tokens ?? 0;
        lastUsage = usage;
      }
    }
  }

  out.title = customTitle ?? aiTitle;
  if (lastUsage) {
    out.contextTokens =
      (lastUsage.input_tokens ?? 0) +
      (lastUsage.cache_read_input_tokens ?? 0) +
      (lastUsage.cache_creation_input_tokens ?? 0);
    out.tokensIn = tokensIn;
    out.tokensOut = tokensOut;
  }
  return out;
}

export type TranscriptRole = "user" | "assistant" | "tool" | "result";

export interface TranscriptEntry {
  at: number | null;
  role: TranscriptRole;
  text: string;
  tool: string | null;
}

const TAIL_BYTES = 512_000;
const MAX_TEXT = 4000;
const MAX_TOOL_TEXT = 200;

type Json = Record<string, unknown>;

const isString = (value: unknown): value is string => typeof value === "string";
const asObject = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

const clip = (text: string, max: number): string => {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
};

function readTailText(path: string): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8", 0, read);
    if (start === 0) return text;
    const firstBreak = text.indexOf("\n");
    return firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
  } finally {
    closeSync(fd);
  }
}

const dropPartialFirstLine = (text: string, start: number): string => {
  if (start === 0) return text;
  const firstBreak = text.indexOf("\n");
  return firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
};

async function readTailTextAsync(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return dropPartialFirstLine(buffer.toString("utf8", 0, bytesRead), start);
  } finally {
    await handle.close();
  }
}

function toolSummary(name: string, input: unknown): string {
  const obj = asObject(input);
  if (!obj) return "";
  const preferred = ["command", "file_path", "pattern", "path", "url", "description", "prompt", "query", "subagent_type"];
  for (const key of preferred) {
    const value = obj[key];
    if (isString(value) && value.trim().length > 0) return clip(value, MAX_TOOL_TEXT);
  }
  const first = Object.values(obj).find(isString);
  return first ? clip(first, MAX_TOOL_TEXT) : "";
}

function contentText(content: unknown): string {
  if (isString(content)) return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = asObject(part);
      return item && item.type === "text" && isString(item.text) ? item.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function entriesFromLine(entry: TranscriptLine): TranscriptEntry[] {
  const at = isString(entry.timestamp) ? Date.parse(entry.timestamp) || null : null;
  const message = entry.message;
  if (!message) return [];
  if (entry.type === "user") {
    if (isString(message.content)) {
      const text = clip(message.content, MAX_TEXT);
      return text.length > 0 ? [{ at, role: "user", text, tool: null }] : [];
    }
    if (!Array.isArray(message.content)) return [];
    const out: TranscriptEntry[] = [];
    for (const part of message.content) {
      const item = asObject(part);
      if (!item) continue;
      if (item.type === "text" && isString(item.text) && item.text.trim().length > 0) {
        out.push({ at, role: "user", text: clip(item.text, MAX_TEXT), tool: null });
      }
      if (item.type === "tool_result") {
        const text = clip(contentText(item.content) || (isString(item.content) ? item.content : ""), MAX_TOOL_TEXT);
        out.push({ at, role: "result", text: text || "(no output)", tool: null });
      }
    }
    return out;
  }
  if (entry.type === "assistant" && Array.isArray(message.content)) {
    const out: TranscriptEntry[] = [];
    for (const part of message.content) {
      const item = asObject(part);
      if (!item) continue;
      if (item.type === "text" && isString(item.text) && item.text.trim().length > 0) {
        out.push({ at, role: "assistant", text: clip(item.text, MAX_TEXT), tool: null });
      }
      if (item.type === "tool_use" && isString(item.name)) {
        out.push({ at, role: "tool", text: toolSummary(item.name, item.input), tool: item.name });
      }
    }
    return out;
  }
  return [];
}

function entriesFromTail(text: string, limit: number): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      entries.push(...entriesFromLine(JSON.parse(trimmed) as TranscriptLine));
    } catch {
      continue;
    }
  }
  return entries.slice(-limit);
}

export function readTranscriptTail(path: string | null, limit = 40): TranscriptEntry[] {
  if (!path) return [];
  try {
    return entriesFromTail(readTailText(path), limit);
  } catch {
    return [];
  }
}

export async function readTranscriptTailAsync(path: string | null, limit = 40): Promise<TranscriptEntry[]> {
  if (!path) return [];
  try {
    return entriesFromTail(await readTailTextAsync(path), limit);
  } catch {
    return [];
  }
}
