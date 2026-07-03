export type SessionStatus = "active" | "waiting" | "idle" | "ended";

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
