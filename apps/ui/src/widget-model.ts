import { needsYou } from "./attention";
import type { TaskStatus } from "./delegation";
import type { SessionRecord } from "./types";

export interface SplitSessions {
  needsYou: SessionRecord[];
  running: SessionRecord[];
  idle: SessionRecord[];
}

const byRecent = (a: SessionRecord, b: SessionRecord): number => b.updatedAt - a.updatedAt;

const favoritesFirst = (a: SessionRecord, b: SessionRecord): number =>
  Number(b.favoriteAt != null) - Number(a.favoriteAt != null) || byRecent(a, b);

export function splitSessions(sessions: readonly SessionRecord[]): SplitSessions {
  return {
    needsYou: sessions.filter(needsYou).sort(byRecent),
    running: sessions.filter((session) => session.status === "active").sort(favoritesFirst),
    idle: sessions.filter((session) => session.status === "idle" && !needsYou(session)).sort(favoritesFirst),
  };
}

export type WidgetTone = "pend" | "unread" | "go" | "hold" | "idle";

export function sessionTone(session: SessionRecord): WidgetTone {
  if (session.status === "waiting") return "pend";
  if (needsYou(session)) return "unread";
  if (session.status === "active") return "go";
  return "idle";
}

export function taskTone(status: TaskStatus): WidgetTone {
  if (status === "attention") return "pend";
  if (status === "failed" || status === "interrupted") return "hold";
  if (status === "pending" || status === "running") return "go";
  return "idle";
}

export interface PipCounts {
  failed: number;
  needYou: number;
  running: number;
}

export function pipTone({ failed, needYou, running }: PipCounts): WidgetTone {
  if (failed > 0) return "hold";
  if (needYou > 0) return "pend";
  if (running > 0) return "go";
  return "idle";
}
