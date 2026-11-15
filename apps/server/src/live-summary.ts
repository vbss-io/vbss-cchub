import type { LiveAgent } from "./live.js";
import type { AgentRecord, SessionRecord } from "./types.js";
import type { TranscriptEntry } from "./transcript.js";

export const LAST_MESSAGE_PREVIEW = 280;

export interface LiveAgentSummary extends AgentRecord {
  turns: number;
  lastMessageTruncated: boolean;
}

export interface SessionLiveSummary {
  session: SessionRecord;
  transcript: TranscriptEntry[];
  agents: LiveAgentSummary[];
  agentCounts: { total: number; running: number };
}

export type LiveQuery = { mode: "full" } | { mode: "summary" } | { mode: "agent"; agentId: string };

export function parseLiveQuery(query: Record<string, unknown>): LiveQuery {
  const agentId = typeof query.subagent === "string" ? query.subagent.trim() : "";
  if (agentId) return { mode: "agent", agentId: agentId.slice(0, 200) };
  if (query.subagents === "summary") return { mode: "summary" };
  return { mode: "full" };
}

export const AGENT_TAIL_LIMIT = 12;
export const AGENT_TURNS_CACHE_SIZE = 2000;

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export interface TurnCounterOptions {
  capacity: number;
  stamp: (path: string) => Promise<FileStamp | null>;
  count: (path: string) => Promise<number>;
}

export function createTurnCounter(options: TurnCounterOptions): (path: string | null) => Promise<number> {
  const cache = new Map<string, number>();
  return async (path) => {
    if (!path) return 0;
    const stamp = await options.stamp(path);
    if (!stamp) return options.count(path);
    const key = `${path}|${stamp.mtimeMs}|${stamp.size}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const turns = await options.count(path);
    cache.set(key, turns);
    while (cache.size > options.capacity) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
    return turns;
  };
}

export function summarizeAgent(agent: LiveAgent, turns?: number): LiveAgentSummary {
  const { transcript, ...record } = agent;
  const message = record.lastMessage;
  const truncated = message != null && message.length > LAST_MESSAGE_PREVIEW;
  return {
    ...record,
    lastMessage: truncated ? `${message.slice(0, LAST_MESSAGE_PREVIEW).trimEnd()}\u2026` : message,
    turns: turns ?? transcript.length,
    lastMessageTruncated: truncated,
  };
}
