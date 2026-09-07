export const HOOK_KINDS = [
  "session_start",
  "user_prompt",
  "notification",
  "stop",
  "session_end",
  "subagent_start",
  "subagent_stop",
] as const;

export type HookKind = (typeof HOOK_KINDS)[number];

export type SessionStatus = "active" | "waiting" | "idle" | "ended";

export interface HookPayload {
  kind: HookKind;
  sessionId: string;
  cwd: string | null;
  source: string | null;
  hostPid: number | null;
  shellPid: number | null;
  title: string | null;
  message: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  contextTokens: number | null;
  agentId: string | null;
  agentType: string | null;
  client: string | null;
  claudePid: number | null;
  transcriptPath: string | null;
  agentMessage: string | null;
  shareLabel: string | null;
}

export type AgentStatus = "running" | "ended";

export interface AgentRecord {
  agentId: string;
  sessionId: string;
  agentType: string | null;
  status: AgentStatus;
  transcriptPath: string | null;
  lastMessage: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface GroupRecord {
  id: string;
  name: string;
  match: string;
  position: number;
}

export interface SessionRecord {
  sessionId: string;
  status: SessionStatus;
  cwd: string | null;
  source: string | null;
  hostPid: number | null;
  shellPid: number | null;
  claudePid: number | null;
  client: string | null;
  transcriptPath: string | null;
  shareLabel: string | null;
  forkOf: string | null;
  forks: number;
  forksLive: number;
  remoteAsks: number;
  delegatedTasks: number;
  delegatedRunning: number;
  helperOf: string | null;
  helpers: number;
  helpersTotal: number;
  stale: boolean;
  title: string | null;
  customTitle: string | null;
  lastMessage: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  contextTokens: number | null;
  archivedAt: number | null;
  favoriteAt: number | null;
  agentsRunning: number;
  agentsTotal: number;
  startedAt: number;
  updatedAt: number;
}
