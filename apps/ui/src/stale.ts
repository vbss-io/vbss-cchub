import type { SessionRecord } from "./types";

const STALE_HOURS = Number(import.meta.env.VITE_STALE_HOURS) || 4;
const STALE_MS = STALE_HOURS * 3_600_000;

export function isStale(session: SessionRecord): boolean {
  return (
    session.archivedAt == null &&
    session.status !== "ended" &&
    Date.now() - session.updatedAt > STALE_MS
  );
}
