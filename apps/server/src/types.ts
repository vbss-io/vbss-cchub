export const HOOK_KINDS = [
  "session_start",
  "user_prompt",
  "notification",
  "stop",
  "session_end",
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
  title: string | null;
  customTitle: string | null;
  lastMessage: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  contextTokens: number | null;
  archivedAt: number | null;
  startedAt: number;
  updatedAt: number;
}
