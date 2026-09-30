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
    needsYou: sessions.filter((session) => session.status === "waiting").sort(byRecent),
    running: sessions.filter((session) => session.status === "active").sort(favoritesFirst),
    idle: sessions.filter((session) => session.status === "idle").sort(favoritesFirst),
  };
}
