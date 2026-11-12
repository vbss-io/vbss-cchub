import type { SessionStatus } from "./types";

export type Bucket = "archived" | "empty" | "ended" | "stale" | "waiting" | "idle" | "active" | "hidden";
export type ExtraFilterKey = "waiting" | "ended" | "stale" | "empty" | "archived";
export type FilterKey = SessionStatus | "all" | "needs-you" | "archived" | "stale" | "empty" | "favorites";

export const LIVE_BUCKETS: readonly Bucket[] = ["waiting", "idle", "active"];

export const EXTRA_FILTERS: readonly { key: ExtraFilterKey; label: string; hint: string }[] = [
  { key: "waiting", label: "Waiting only", hint: "Sessions blocked on a decision or permission" },
  { key: "ended", label: "Ended", hint: "Sessions that sent an end signal" },
  { key: "stale", label: "Inactive", hint: "No activity for hours and no end signal" },
  { key: "empty", label: "Empty", hint: "Sessions that never produced a turn" },
  { key: "archived", label: "Archived", hint: "Sessions you archived" },
];

export const isExtraFilter = (filter: FilterKey): filter is ExtraFilterKey => EXTRA_FILTERS.some((item) => item.key === filter);

export function matchesFilter(filter: FilterKey, bucket: Bucket, needs: boolean): boolean {
  if (filter === "favorites" || bucket === "hidden") return false;
  if (filter === "all") return LIVE_BUCKETS.includes(bucket);
  if (filter === "needs-you") return needs && (LIVE_BUCKETS.includes(bucket) || bucket === "stale");
  return bucket === filter;
}

export function countsOf(tally: Record<ExtraFilterKey, number>): { key: ExtraFilterKey; label: string; hint: string; count: number }[] {
  return EXTRA_FILTERS.map((item) => ({ ...item, count: tally[item.key] }));
}
