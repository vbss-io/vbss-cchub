import type { SessionRecord } from "./types";

type AttentionSession = Pick<SessionRecord, "status" | "unread">;

export function needsYou(session: AttentionSession): boolean {
  return session.status === "waiting" || session.unread === true;
}

export function attentionCount(sessions: readonly AttentionSession[]): number {
  return sessions.filter(needsYou).length;
}
