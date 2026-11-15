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

export function summarizeAgent(agent: LiveAgent): LiveAgentSummary {
  const { transcript, ...record } = agent;
  const message = record.lastMessage;
  const truncated = message != null && message.length > LAST_MESSAGE_PREVIEW;
  return {
    ...record,
    lastMessage: truncated ? `${message.slice(0, LAST_MESSAGE_PREVIEW).trimEnd()}\u2026` : message,
    turns: transcript.length,
    lastMessageTruncated: truncated,
  };
}
