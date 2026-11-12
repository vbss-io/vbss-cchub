import { findBoardTask, groupTasksByProject, type ProjectTaskGroup } from "./board-model";
import type { BoardProject, BoardTarget, BoardTask, TodayEntry } from "./delegation";
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

export type BacklogIntent = "today" | "tomorrow" | "done" | "open" | "next" | "prev";

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
