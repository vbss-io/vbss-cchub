import { needsYou } from "./attention";
import type { TaskStatus } from "./delegation";
import type { SessionRecord } from "./types";
import { resetLabel, type LimitWindowKind } from "./usage-format";
import { formatTokens } from "./widget-layout";

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

export type WidgetSurface = "connecting" | "off" | "on";

export function widgetSurface({ loaded, enabled }: { loaded: boolean; enabled: boolean }): WidgetSurface {
  if (!loaded) return "connecting";
  return enabled ? "on" : "off";
}

export const IDLE_ROW_LIMIT = 8;

export function elapsedLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest > 0 ? `${hours}h${rest}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export interface RowMeta {
  text: string;
  extras: string[];
}

type RowSession = Pick<SessionRecord, "status" | "unread" | "helperOf" | "agentsRunning" | "agentsTotal" | "startedAt" | "updatedAt">;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

export function sessionRowMeta(session: RowSession, peers: number, now: number): RowMeta {
  const running = session.agentsRunning ?? 0;
  const extras = [
    ...(running > 0 ? [`${plural(running, "subagent")} running · ${session.agentsTotal ?? running} spawned`] : []),
    ...(peers > 0 ? [`${peers} more here: other live agents share this folder`] : []),
  ];
  const since = elapsedLabel(now - session.updatedAt);
  if (session.status === "waiting") return { text: `needs input · ${since}`, extras };
  if (needsYou(session)) return { text: `finished · ${since}`, extras };
  if (session.status === "active") return { text: `running · ${elapsedLabel(now - session.startedAt)}`, extras };
  return { text: since, extras };
}

interface RowTask {
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
}

const TASK_WORD: Record<TaskStatus, string> = {
  pending: "queued",
  running: "running",
  completed: "done",
  attention: "needs you",
  failed: "failed",
  interrupted: "interrupted",
  cancelled: "cancelled",
};

export function taskRowMeta(task: RowTask, branch: string | null, now: number): RowMeta {
  const word = TASK_WORD[task.status];
  const since = task.status === "pending" ? null : elapsedLabel(now - (task.status === "running" ? task.createdAt : task.updatedAt));
  const parts = [word, ...(since ? [since] : []), ...(branch ? [branch] : [])];
  return { text: parts.join(" · "), extras: [] };
}

export type WidgetSectionKey = "needs" | "running" | "idle" | "delegated" | "done";

export interface SectionCounts {
  needs: number;
  running: number;
  idle: number;
  delegated: number;
  done: number;
}

export interface SectionPlan {
  key: WidgetSectionKey;
  label: string;
  count: number;
  shown: number;
  more: number;
}

const SECTION_LABEL: Record<WidgetSectionKey, string> = {
  needs: "Needs you",
  running: "Running",
  idle: "Idle",
  delegated: "Delegated",
  done: "Recently done",
};

const SECTION_ORDER: readonly WidgetSectionKey[] = ["needs", "running", "idle", "delegated", "done"];

export function planSections(counts: SectionCounts, delegatedOn: boolean): SectionPlan[] {
  return SECTION_ORDER.filter((key) => counts[key] > 0 && (delegatedOn || (key !== "delegated" && key !== "done"))).map((key) => {
    const count = counts[key];
    const shown = key === "idle" ? Math.min(count, IDLE_ROW_LIMIT) : count;
    return { key, label: SECTION_LABEL[key], count, shown, more: count - shown };
  });
}

export const moreLabel = (extras: readonly string[]): string | null => (extras.length > 0 ? `+${extras.length}` : null);

export interface HeadCounts {
  live: number;
  idle: number;
  needYou: number;
}

export const headline = ({ live, idle, needYou }: HeadCounts): string => `${live} live · ${idle} idle · ${needYou} need you`;

export function gaugeResetText(resetsAt: number | null, now: number, window: LimitWindowKind, required = false): string {
  const label = resetLabel(resetsAt, now, window, required);
  if (label.kind === "countdown") return `resets in ${label.text}`;
  return label.kind === "unknown" ? "reset time unknown" : "";
}

export const tokenLine = (read: number, output: number): string => `Read ${formatTokens(read)} · Output ${formatTokens(output)}`;

export const periodLabel = (days: number): string => `Last ${days} days`;
