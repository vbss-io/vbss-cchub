import type { TaskStatus } from "./delegation";
import type { Bucket, FilterKey } from "./sessions-filter";
import type { SessionStatus } from "./types";

export type Origin = "all" | "claude" | "codex" | "delegated";
export type RunOrigin = Exclude<Origin, "all">;

export const ORIGIN_LABEL: Readonly<Record<Origin, string>> = {
  all: "All",
  claude: "Claude",
  codex: "Codex",
  delegated: "Delegated",
};

const ORIGINS: readonly Origin[] = ["all", "claude", "codex", "delegated"];

export const originOptions = (delegatedOn: boolean): Origin[] => ORIGINS.filter((origin) => delegatedOn || origin !== "delegated");

export const normalizeOrigin = (origin: Origin, delegatedOn: boolean): Origin => (origin === "delegated" && !delegatedOn ? "all" : origin);

export const parseOrigin = (value: string | null | undefined): Origin => ORIGINS.find((origin) => origin === value) ?? "all";

export const taskInFlight = (status: TaskStatus): boolean => status === "pending" || status === "running";

export const taskNeedsYou = (status: TaskStatus): boolean => status === "attention" || status === "failed" || status === "interrupted";

export interface TaskShape {
  status: TaskStatus;
  archivedAt: number | null;
  isolation: string;
  worktreePath: string | null;
  mergedAt: number | null;
}

export const taskReadyToMerge = (task: TaskShape): boolean =>
  task.status === "completed" && task.isolation === "worktree" && task.worktreePath !== null && task.mergedAt === null;

export type TaskTone = "go" | "pend" | "hold" | "unread" | "muted";

export function taskStatusTone(task: TaskShape): TaskTone {
  if (task.archivedAt != null) return "muted";
  if (taskInFlight(task.status)) return "go";
  if (task.status === "attention") return "pend";
  if (task.status === "failed" || task.status === "interrupted") return "hold";
  return taskReadyToMerge(task) ? "unread" : "muted";
}

export const runStatusTone = (status: TaskStatus): TaskTone =>
  taskStatusTone({ status, archivedAt: null, isolation: "shared", worktreePath: null, mergedAt: null });

export function taskBucket(task: TaskShape): Bucket {
  if (task.archivedAt != null) return "archived";
  if (taskInFlight(task.status)) return "active";
  if (task.status === "attention") return "waiting";
  if (taskNeedsYou(task.status) || taskReadyToMerge(task)) return "idle";
  return "ended";
}

const BUCKET_STATUS: Partial<Record<Bucket, SessionStatus>> = { active: "active", waiting: "waiting", idle: "idle" };

export const taskRunStatus = (task: TaskShape): SessionStatus => BUCKET_STATUS[taskBucket(task)] ?? "ended";

export interface OriginEntry {
  origin: RunOrigin;
  live: boolean;
  folded?: boolean;
}

export function originCounts(entries: readonly OriginEntry[]): Record<Origin, number> {
  const counts: Record<Origin, number> = { all: 0, claude: 0, codex: 0, delegated: 0 };
  for (const entry of entries) {
    if (!entry.live) continue;
    counts[entry.origin] += 1;
    if (!entry.folded) counts.all += 1;
  }
  return counts;
}

export const originIncludes = (selected: Origin, origin: RunOrigin): boolean => selected === "all" || selected === origin;

export const filterForOrigin = (filter: FilterKey, origin: Origin): FilterKey => (filter === "favorites" && !originIncludes(origin, "claude") ? "all" : filter);

export interface LabelledOption<K extends string> {
  key: K;
  label: string;
}

export const withLiveCounts = <K extends string>(options: readonly LabelledOption<K>[], counts: Partial<Record<K, number>>): LabelledOption<K>[] =>
  options.map((option) => {
    const count = counts[option.key] ?? 0;
    return count > 0 ? { key: option.key, label: `${option.label} (${count})` } : { key: option.key, label: option.label };
  });

export interface TaskRunLink {
  id: string;
  sessionId: string | null;
}

export interface ThreadRunLink {
  id: string;
  hubTaskId: string | null;
}

export interface FoldedRuns {
  sessionOf: Map<string, string>;
  threadOf: Map<string, string>;
  foldedSessions: Set<string>;
  foldedThreads: Set<string>;
}

export function foldTaskRuns(tasks: readonly TaskRunLink[], threads: readonly ThreadRunLink[]): FoldedRuns {
  const sessionOf = new Map<string, string>();
  const threadOf = new Map<string, string>();
  const foldedSessions = new Set<string>();
  const foldedThreads = new Set<string>();
  const taskIds = new Set<string>();
  for (const task of tasks) {
    taskIds.add(task.id);
    if (task.sessionId) {
      sessionOf.set(task.id, task.sessionId);
      foldedSessions.add(task.sessionId);
    }
  }
  for (const thread of threads) {
    if (!thread.hubTaskId || !taskIds.has(thread.hubTaskId)) continue;
    if (!threadOf.has(thread.hubTaskId)) threadOf.set(thread.hubTaskId, thread.id);
    foldedThreads.add(thread.id);
  }
  return { sessionOf, threadOf, foldedSessions, foldedThreads };
}

export const emptyFold = (): FoldedRuns => foldTaskRuns([], []);

export interface NeedsYouPartition<T> {
  band: T[];
  rest: T[];
}

export function partitionNeedsYou<T extends { needs: boolean }>(items: readonly T[], enabled: boolean): NeedsYouPartition<T> {
  if (!enabled) return { band: [], rest: [...items] };
  return { band: items.filter((item) => item.needs), rest: items.filter((item) => !item.needs) };
}

export function needsByGroup<T>(band: readonly T[], groupOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of band) {
    const name = groupOf(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

export interface RunsRoute {
  origin: Origin | null;
  taskId: string | null;
}

export function runsRouteOf(view: string, param: string | null): RunsRoute | null {
  if (view !== "tasks") return null;
  const taskId = param?.trim() ? param.trim() : null;
  return taskId ? { origin: null, taskId } : { origin: "delegated", taskId: null };
}

export const SESSIONS_PREFS_SCREEN = "sessions";
export const NEEDS_YOU_TOP_KEY = "needsYouTop";

type LayoutPrefs = Readonly<Record<string, Readonly<Record<string, number>>>>;

export function needsYouOnTop(layout: LayoutPrefs | undefined): boolean {
  if (!layout || !Object.hasOwn(layout, SESSIONS_PREFS_SCREEN)) return true;
  const screen = layout[SESSIONS_PREFS_SCREEN];
  if (!screen || !Object.hasOwn(screen, NEEDS_YOU_TOP_KEY)) return true;
  return screen[NEEDS_YOU_TOP_KEY] !== 0;
}

export function withNeedsYouOnTop(layout: LayoutPrefs | undefined, on: boolean): { layout: Record<string, Record<string, number>> } {
  const current = layout && Object.hasOwn(layout, SESSIONS_PREFS_SCREEN) ? (layout[SESSIONS_PREFS_SCREEN] ?? {}) : {};
  return { layout: { [SESSIONS_PREFS_SCREEN]: { ...current, [NEEDS_YOU_TOP_KEY]: on ? 1 : 0 } } };
}

export type TaskPrimary = "continue" | "cancel" | "merge" | null;

export interface TaskPrimaryInput {
  status: TaskStatus;
  archived: boolean;
  mergeable: boolean;
}

export function taskPrimaryAction({ status, archived, mergeable }: TaskPrimaryInput): TaskPrimary {
  if (archived) return null;
  if (taskInFlight(status)) return "cancel";
  if (taskNeedsYou(status)) return "continue";
  if (mergeable) return "merge";
  return "continue";
}

export interface WorktreeShape {
  exists: boolean;
  dirty: boolean;
  commits: readonly unknown[];
  mergedAt: number | null;
}

export const worktreeMergeable = (worktree: WorktreeShape | null, running: boolean): boolean =>
  worktree !== null && worktree.exists && !worktree.dirty && worktree.commits.length > 0 && worktree.mergedAt === null && !running;

const DAY_MS = 24 * 3_600_000;

export interface TaskSummary {
  running: number;
  needYou: number;
  doneToday: number;
  failed: number;
}

export function taskSummary(tasks: readonly { status: TaskStatus; updatedAt: number; archivedAt: number | null }[], now: number): TaskSummary {
  const live = tasks.filter((task) => task.archivedAt == null);
  return {
    running: live.filter((task) => taskInFlight(task.status)).length,
    needYou: live.filter((task) => taskNeedsYou(task.status)).length,
    doneToday: live.filter((task) => task.status === "completed" && now - task.updatedAt < DAY_MS).length,
    failed: live.filter((task) => task.status === "failed").length,
  };
}

export function humanizeDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export interface TaskTimingInput {
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  runsCount: number;
}

export interface TaskTiming {
  startedAt: number;
  duration: string;
  runs: string;
}

export function taskTiming(task: TaskTimingInput, now: number): TaskTiming {
  const running = taskInFlight(task.status);
  const label = humanizeDuration(Math.max(0, (running ? now : task.updatedAt) - task.createdAt));
  return { startedAt: task.createdAt, duration: running ? `running ${label}` : label, runs: `${task.runsCount} run${task.runsCount === 1 ? "" : "s"}` };
}
