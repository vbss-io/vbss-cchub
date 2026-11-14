import { findBoardTask, groupTasksByProject, type ProjectTaskGroup } from "./board-model";
import { mergeTrailIntoSummary, parseMeetings } from "./daily-plan";
import type {
  BoardProject,
  BoardTarget,
  BoardTask,
  DailyCloseYesterdayInput,
  DailyComposeInput,
  DailyPrepare,
  DailyYesterday,
  DailyYesterdayTask,
  TodayAmbiguityReason,
  TodayAmbiguous,
  TodayData,
  TodayEntry,
  TodayLinkTickInput,
  TodayOutOfSync,
  TodayUnmatched,
} from "./delegation";
import { addDays, flattenNodes, parseInlineTokens, type KeyEventLike, type OutlineGroup, type OutlineNode } from "./outliner-model";

export const TODAY_DRAG_MIME = "application/x-cchub-task";

export type BacklogStatus = "todo" | "doing" | "blocked" | "hold";

export const BACKLOG_STATUSES: readonly BacklogStatus[] = ["todo", "doing", "blocked", "hold"];

export const BACKLOG_STATUS_LABEL: Record<BacklogStatus, string> = {
  todo: "To-do",
  doing: "Doing",
  blocked: "Blocked",
  hold: "Hold",
};

export interface BacklogFilters {
  search: string;
  projectId: string | null;
  statuses: readonly BacklogStatus[];
}

export const DEFAULT_BACKLOG_FILTERS: BacklogFilters = { search: "", projectId: null, statuses: ["todo", "doing", "blocked"] };

export type BacklogIntent = "today" | "tomorrow" | "done" | "doing" | "open" | "next" | "prev";

export interface QuickAdd {
  title: string;
  priority?: number;
  due?: string;
}

export function localDay(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export const nextDay = (day: string): string => addDays(day, 1);

export function describeDay(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  if (day === addDays(today, -1)) return "Yesterday";
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export function outlineNodeOf(task: BoardTask, depth: number): OutlineNode {
  return {
    id: task.id,
    projectId: task.projectId,
    line: task.line,
    raw: task.raw,
    title: task.title,
    status: task.status,
    priority: task.priority,
    due: task.due ?? null,
    notes: task.noteItems.map((note) => ({ line: note.line, raw: note.raw, text: note.text })),
    children: task.subtasks.map((subtask) => outlineNodeOf(subtask, depth + 1)),
    depth,
  };
}

export function outlineGroupsOf(entries: readonly TodayEntry[]): OutlineGroup[] {
  const groups = new Map<string, OutlineGroup>();
  for (const entry of entries) {
    const existing = groups.get(entry.project.id);
    const node = outlineNodeOf(entry.task, 0);
    if (existing) existing.items.push(node);
    else groups.set(entry.project.id, { project: { id: entry.project.id, title: entry.project.title }, items: [node] });
  }
  return [...groups.values()];
}

function collectIds(tasks: readonly BoardTask[], into: Set<string>): Set<string> {
  for (const task of tasks) {
    into.add(task.id);
    collectIds(task.subtasks, into);
  }
  return into;
}

export const taskIdsOf = (tasks: readonly BoardTask[]): Set<string> => collectIds(tasks, new Set<string>());

export const entryTaskIds = (entries: readonly TodayEntry[]): Set<string> => taskIdsOf(entries.map((entry) => entry.task));

export function parentOfTask(tasks: readonly BoardTask[], id: string): BoardTask | null {
  for (const task of tasks) {
    if (task.subtasks.some((subtask) => subtask.id === id)) return task;
    const nested = parentOfTask(task.subtasks, id);
    if (nested !== null) return nested;
  }
  return null;
}

export function rootNodeOf(groups: readonly OutlineGroup[], node: OutlineNode): OutlineNode {
  for (const group of groups) {
    if (group.project.id !== node.projectId) continue;
    const root = group.items.find((item) => flattenNodes([item]).some((candidate) => candidate.id === node.id));
    if (root !== undefined) return root;
  }
  return node;
}

export function realSiblings(tasks: readonly BoardTask[], id: string): BoardTask[] {
  const task = findBoardTask([...tasks], id);
  if (task === null) return [];
  const parent = parentOfTask(tasks, id);
  const pool = parent === null ? tasks.filter((candidate) => candidate.projectId === task.projectId && candidate.section === task.section) : parent.subtasks;
  return [...pool].sort((a, b) => a.line - b.line);
}

export function moveSteps(tasks: readonly BoardTask[], id: string, targetId: string): number {
  const siblings = realSiblings(tasks, id);
  const from = siblings.findIndex((task) => task.id === id);
  const to = siblings.findIndex((task) => task.id === targetId);
  if (from === -1 || to === -1) return 1;
  return Math.max(1, Math.abs(from - to));
}

export function targetOfTask(task: Pick<BoardTask, "projectId" | "line" | "raw">): BoardTarget {
  return { projectId: task.projectId, line: task.line, raw: task.raw };
}

export function parseQuickAdd(text: string, today: string): QuickAdd | null {
  const parsed = parseInlineTokens(text, today);
  if (parsed.title === "") return null;
  return {
    title: parsed.title,
    ...(parsed.priority !== undefined && parsed.priority !== null ? { priority: parsed.priority } : {}),
    ...(parsed.due !== undefined && parsed.due !== null ? { due: parsed.due } : {}),
  };
}

export function encodeDragTarget(target: BoardTarget): string {
  return JSON.stringify({ projectId: target.projectId, line: target.line, raw: target.raw });
}

export function decodeDragTarget(text: string): BoardTarget | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.projectId !== "string" || typeof record.raw !== "string") return null;
    if (typeof record.line !== "number" || !Number.isInteger(record.line) || record.line < 0) return null;
    return { projectId: record.projectId, line: record.line, raw: record.raw };
  } catch {
    return null;
  }
}

export function backlogKeyIntent(event: KeyEventLike): BacklogIntent | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  switch (event.key) {
    case "t":
    case "T":
      return "today";
    case "m":
    case "M":
      return "tomorrow";
    case "d":
    case "D":
      return "done";
    case "s":
    case "S":
      return "doing";
    case "Enter":
      return "open";
    case "ArrowDown":
    case "j":
      return "next";
    case "ArrowUp":
    case "k":
      return "prev";
    default:
      return null;
  }
}

export function toggleBacklogStatus(statuses: readonly BacklogStatus[], status: BacklogStatus): BacklogStatus[] {
  const next = statuses.includes(status) ? statuses.filter((item) => item !== status) : [...statuses, status];
  return BACKLOG_STATUSES.filter((item) => next.includes(item));
}

function matchesSearch(task: BoardTask, project: BoardProject | undefined, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === "") return true;
  const haystack = [task.title, task.reason ?? "", project?.title ?? "", ...task.noteItems.map((note) => note.text)].join(" ").toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

export function backlogTasks(tasks: readonly BoardTask[], projects: readonly BoardProject[], excluded: ReadonlySet<string>, filters: BacklogFilters): BoardTask[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  return tasks.filter(
    (task) =>
      task.section === "open" &&
      !excluded.has(task.id) &&
      (BACKLOG_STATUSES as readonly string[]).includes(task.status) &&
      filters.statuses.includes(task.status as BacklogStatus) &&
      (filters.projectId === null || task.projectId === filters.projectId) &&
      matchesSearch(task, byId.get(task.projectId), filters.search),
  );
}

export function backlogGroups(
  tasks: readonly BoardTask[],
  projects: readonly BoardProject[],
  order: readonly string[],
  excluded: ReadonlySet<string>,
  filters: BacklogFilters,
): ProjectTaskGroup[] {
  return groupTasksByProject(backlogTasks(tasks, projects, excluded, filters), [...projects], order);
}

export function countBacklog(groups: readonly ProjectTaskGroup[]): number {
  return groups.reduce((total, group) => total + group.tasks.length, 0);
}

export const noteOnlyLines = (data: Pick<TodayData, "inNote" | "unlinked">): string[] => data.inNote ?? data.unlinked;

const AMBIGUITY_HINT: Record<TodayAmbiguityReason, string> = {
  "same-title": "Another task has the same title, so it was not added to the note.",
  "unclear-line": "A line in the note could mean this task or another one, so nothing was added.",
  "several-lines": "Its parent appears more than once in the note, so it was not placed.",
  "several-tasks": "This line matches more than one task, so its checkbox is not synced.",
  "duplicate-line": "This line was copied or removed, so its checkbox was not synced. Check the task status.",
};

export const ambiguityHint = (item: Pick<TodayAmbiguous, "reason">): string => AMBIGUITY_HINT[item.reason];

export const outOfSyncKey = (item: TodayOutOfSync): string => [item.projectId, item.taskTitle, item.line].join("\u0000");

export function parseDismissedOutOfSync(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function visibleOutOfSync(items: readonly TodayOutOfSync[] | undefined, dismissed: readonly string[]): TodayOutOfSync[] {
  const hidden = new Set(dismissed);
  return (items ?? []).filter((item) => !hidden.has(outOfSyncKey(item)));
}

export function keepDismissed(dismissed: readonly string[], items: readonly TodayOutOfSync[] | undefined): string[] {
  const live = new Set((items ?? []).map(outOfSyncKey));
  return dismissed.filter((key) => live.has(key));
}

export function taskOfOutOfSync(tasks: readonly BoardTask[], item: TodayOutOfSync): BoardTask | null {
  const found: BoardTask[] = [];
  const visit = (list: readonly BoardTask[]): void => {
    for (const candidate of list) {
      if (candidate.projectId === item.projectId && candidate.title === item.taskTitle) found.push(candidate);
      visit(candidate.subtasks);
    }
  };
  visit(tasks);
  return found.length === 1 ? (found[0] as BoardTask) : null;
}

export const unmatchedKey = (item: Pick<TodayUnmatched, "lineIndex" | "line">): string => `${item.lineIndex}\u0000${item.line}`;

export type LinkTarget = NonNullable<TodayLinkTickInput["target"]>;

export const linkTargetOfTask = (task: Pick<BoardTask, "projectId" | "line" | "raw">): LinkTarget => ({ projectId: task.projectId, line: task.line, raw: task.raw });

export const linkTickInput = (item: Pick<TodayUnmatched, "lineIndex" | "line">, target: LinkTarget | null): TodayLinkTickInput => ({
  lineIndex: item.lineIndex,
  raw: item.line,
  target,
  action: target === null ? "dismiss" : "apply",
});

export interface PickerTask {
  task: BoardTask;
  projectTitle: string;
}

export const PICKER_LIMIT = 30;

export function pickerTasks(tasks: readonly BoardTask[], projects: readonly BoardProject[], query: string, limit: number = PICKER_LIMIT): { items: PickerTask[]; total: number } {
  const titles = new Map(projects.map((project) => [project.id, project.title]));
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== "");
  const matches: PickerTask[] = [];
  const visit = (list: readonly BoardTask[]): void => {
    for (const candidate of list) {
      if (candidate.section === "open" && (BACKLOG_STATUSES as readonly string[]).includes(candidate.status)) {
        const projectTitle = titles.get(candidate.projectId) ?? candidate.projectId;
        const haystack = `${candidate.title} ${projectTitle}`.toLowerCase();
        if (words.every((word) => haystack.includes(word))) matches.push({ task: candidate, projectTitle });
      }
      visit(candidate.subtasks);
    }
  };
  visit(tasks);
  return { items: matches.slice(0, limit), total: matches.length };
}

export const RECENT_DONE_DAYS = 7;

export function recentlyDoneTasks(
  tasks: readonly BoardTask[],
  projects: readonly BoardProject[],
  query: string,
  today: string,
  limit: number = PICKER_LIMIT,
): { items: PickerTask[]; total: number } {
  const titles = new Map(projects.map((project) => [project.id, project.title]));
  const words = query.trim().toLowerCase().split(/\s+/).filter((word) => word !== "");
  const since = addDays(today, -RECENT_DONE_DAYS);
  const matches: PickerTask[] = [];
  for (const candidate of flattenBoardTasks(tasks)) {
    if (candidate.status !== "done" || candidate.doneAt === null || candidate.doneAt < since) continue;
    const projectTitle = titles.get(candidate.projectId) ?? candidate.projectId;
    const haystack = `${candidate.title} ${projectTitle}`.toLowerCase();
    if (words.every((word) => haystack.includes(word))) matches.push({ task: candidate, projectTitle });
  }
  matches.sort((a, b) => (a.task.doneAt === b.task.doneAt ? a.task.line - b.task.line : (a.task.doneAt ?? "") < (b.task.doneAt ?? "") ? 1 : -1));
  return { items: matches.slice(0, limit), total: matches.length };
}

export function focusFact(scheduled: string | null | undefined, today: string): string | null {
  if (scheduled === null || scheduled === undefined || scheduled === "") return null;
  return scheduled === today ? "In today's focus" : `Scheduled ${scheduled}`;
}

export function siblingsAfter(tasks: readonly BoardTask[], id: string): number {
  const anchor = findBoardTask([...tasks], id);
  if (anchor === null) return 0;
  const parent = parentOfTask(tasks, id);
  if (parent !== null) return parent.subtasks.filter((task) => task.line > anchor.line).length + parent.noteItems.filter((note) => note.line > anchor.line).length;
  return tasks.filter((task) => task.projectId === anchor.projectId && task.section === anchor.section && task.group === anchor.group && task.line > anchor.line).length;
}

export function stepsBelowAnchor(tasks: readonly BoardTask[], anchorId: string, created: Pick<BoardTask, "group">): number {
  const anchor = findBoardTask([...tasks], anchorId);
  if (anchor === null) return 0;
  if (parentOfTask(tasks, anchorId) === null && created.group !== anchor.group) return 0;
  return siblingsAfter(tasks, anchorId);
}

export const START_DAY_EVENT = "cchub:daily-start-day";

export const planDraftKey = (date: string): string => `hub.daily.plan.${date}`;

export const startPanelAuto = (date: string, today: string, dailyExists: boolean): boolean => !dailyExists && date >= today;

export type LineChoice = "bring" | "drop";

export type YesterdayItem = { kind: "task"; key: string; entry: TodayEntry } | { kind: "line"; key: string; line: DailyYesterdayTask };

export interface YesterdayPlan {
  open: YesterdayItem[];
  done: DailyYesterdayTask[];
}

const WIKILINK_RE = /\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g;

export function plainLineText(text: string): string {
  return text
    .replace(WIKILINK_RE, (_whole, target: string, label: string | undefined) => label ?? target)
    .replace(/\s+/g, " ")
    .trim();
}

export function lineMatchesTitle(text: string, title: string): boolean {
  const wanted = plainLineText(title).toLowerCase();
  if (wanted === "") return false;
  const plain = plainLineText(text).toLowerCase();
  return plain === wanted || plain.endsWith(` - ${wanted}`);
}

export function flattenBoardTasks(tasks: readonly BoardTask[]): BoardTask[] {
  return tasks.flatMap((task) => [task, ...flattenBoardTasks(task.subtasks)]);
}

const NOTE_MARKER_RE = /^\s*[-*]\s+\[[ xX-]\]\s*/;

export const lineInNote = (text: string, noteLines: readonly string[]): boolean => {
  const wanted = plainLineText(text).toLowerCase();
  return wanted !== "" && noteLines.some((line) => plainLineText(line.replace(NOTE_MARKER_RE, "")).toLowerCase() === wanted);
};

export function planYesterday(yesterday: DailyYesterday | null, carried: readonly TodayEntry[], tasks: readonly BoardTask[], noteLines: readonly string[] = []): YesterdayPlan {
  const lines = yesterday?.tasks ?? [];
  const known = flattenBoardTasks(tasks);
  const handled = (line: DailyYesterdayTask): boolean => known.some((task) => lineMatchesTitle(line.text, task.title)) || lineInNote(line.text, noteLines);
  const open: YesterdayItem[] = [
    ...carried.map((entry): YesterdayItem => ({ kind: "task", key: `task:${entry.task.id}`, entry })),
    ...lines.filter((line) => line.state !== "done" && !handled(line)).map((line): YesterdayItem => ({ kind: "line", key: `line:${line.line}`, line })),
  ];
  return { open, done: lines.filter((line) => line.state === "done") };
}

export const pendingLineKeys = (open: readonly YesterdayItem[], choices: Readonly<Record<string, LineChoice>>): string[] =>
  open.flatMap((item) => (item.kind === "line" && choices[item.key] === undefined ? [item.key] : []));

export const broughtLines = (open: readonly YesterdayItem[], choices: Readonly<Record<string, LineChoice>>): DailyYesterdayTask[] =>
  open.flatMap((item) => (item.kind === "line" && choices[item.key] === "bring" ? [item.line] : []));

export const trailSummary = (prepare: Pick<DailyPrepare, "yesterdayTrail"> | null): string => mergeTrailIntoSummary("", prepare?.yesterdayTrail?.bullets ?? []);

export interface StartDayDraft {
  summary: string;
  useSummary: boolean;
  meetingsText: string;
  lines: readonly DailyYesterdayTask[];
}

export function composeStartDay(draft: StartDayDraft): DailyComposeInput {
  const briefing = draft.useSummary ? draft.summary.trim() : "";
  return {
    focus: draft.lines.map((line) => ({ project: null, text: line.text, ...(line.block !== undefined ? { block: line.block } : {}) })),
    meetings: parseMeetings(draft.meetingsText),
    ...(briefing !== "" ? { briefing } : {}),
  };
}

export const closeYesterdayBody = (yesterday: Pick<DailyYesterday, "date">): DailyCloseYesterdayInput => ({
  yesterday: yesterday.date,
  tasks: [],
});
