import type { UsageDay } from "./delegation";
import type { Tone } from "./widget-layout";

export type SortDirection = "asc" | "desc";

export const CONTEXT_WARN = 300_000;
export const CONTEXT_HOLD = 600_000;

export function sortRows<T>(rows: readonly T[], value: (row: T) => number | string, direction: SortDirection = "desc"): T[] {
  const sign = direction === "desc" ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, key: value(row) }))
    .sort((a, b) => {
      const order =
        typeof a.key === "number" && typeof b.key === "number"
          ? a.key - b.key
          : String(a.key).localeCompare(String(b.key));
      return order !== 0 ? order * sign : a.index - b.index;
    })
    .map((entry) => entry.row);
}

export interface DayBar {
  day: string;
  claude: number;
  codex: number;
  total: number;
}

export function dayBarHeights(byDay: readonly UsageDay[]): DayBar[] {
  const max = byDay.reduce((peak, entry) => Math.max(peak, entry.claude.read + entry.codex.read), 0);
  const scale = (value: number): number => (max > 0 ? (value / max) * 100 : 0);
  return byDay.map((entry) => ({
    day: entry.day,
    claude: scale(entry.claude.read),
    codex: scale(entry.codex.read),
    total: scale(entry.claude.read + entry.codex.read),
  }));
}

export function contextTone(p90: number): Exclude<Tone, "muted"> {
  if (!Number.isFinite(p90)) return "go";
  if (p90 > CONTEXT_HOLD) return "hold";
  if (p90 > CONTEXT_WARN) return "pend";
  return "go";
}

export function timeAgo(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function sourceNote(source: string | undefined): string | null {
  if (source === "api" || source === "live") return "live";
  if (source === "cache") return "from local cache";
  if (source === "rollout") return "from local session";
  return null;
}

export function sharePercent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0";
  return String(Math.round(Math.min(1, share) * 100));
}

const PROJECT_TAILS: readonly RegExp[] = [/--workspaces-(.+)$/, /-Projetos-(.+)$/, /-Obsidian-(.+)$/];

export function shortProject(project: string, cwd: string | null = null): string {
  if (cwd) {
    const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  for (const pattern of PROJECT_TAILS) {
    const match = pattern.exec(project);
    if (match?.[1]) return match[1];
  }
  return project;
}
