import { readdirSync, readFileSync } from "node:fs";
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
  message?: { model?: string; usage?: Record<string, number> };
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

  for (const line of lines) {
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") out.title = entry.aiTitle;
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
