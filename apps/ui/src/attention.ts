import type { SessionRecord } from "./types";

type AttentionSession = Pick<SessionRecord, "status" | "unread" | "helperOf">;

export function needsYou(session: AttentionSession): boolean {
  if (session.helperOf) return false;
  return session.status === "waiting" || session.unread === true;
}

export function attentionCount(sessions: readonly AttentionSession[]): number {
  return sessions.filter(needsYou).length;
}
