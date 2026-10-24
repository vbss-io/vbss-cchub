import type { BoardCheckbox, BoardCreateInput, BoardNoteItem, BoardProject, BoardStatus, BoardTask, BoardToday } from "./delegation";

export const BOARD_STATUSES: readonly BoardStatus[] = ["blocked", "hold", "todo", "doing", "done", "archived"];

export const BOARD_STATUS_LABEL: Record<BoardStatus, string> = {
  blocked: "Blocked",
  hold: "Hold",
  todo: "To-Do",
  doing: "Doing",
  done: "Done",
  archived: "Archived",
};

export const WORKING_STATUSES: readonly BoardStatus[] = BOARD_STATUSES.filter((status) => status !== "archived");

export const REASON_STATUSES: readonly BoardStatus[] = ["blocked", "hold", "archived"];

export const DONE_SECTION_PAGE = 20;

export const DEFAULT_PRIORITY_LEVELS = 4;

const MAX_PRIORITY_DIGIT = 9;

export const supportsReason = (status: BoardStatus): boolean => REASON_STATUSES.includes(status);

export type BoardViewMode = "kanban" | "table";

export interface BoardFilters {
  projectId: string | null;
  includeSubprojects: boolean;
  statuses: BoardStatus[];
  search: string;
  todayOnly: boolean;
  hiddenPriorities: (number | null)[];
}

export type TableSortKey = "priority" | "status" | "project" | "title";

export type TableSortDir = "asc" | "desc";

export interface TableSort {
  key: TableSortKey;
  dir: TableSortDir;
}

export const TABLE_SORT_KEYS: readonly TableSortKey[] = ["priority", "status", "project", "title"];

export interface BoardPrefs {
  view: BoardViewMode;
  hideEmptyColumns: boolean;
  tableSort: TableSort;
  filters: BoardFilters;
}

export const DEFAULT_BOARD_PREFS: BoardPrefs = {
  view: "kanban",
  hideEmptyColumns: true,
  tableSort: { key: "priority", dir: "asc" },
  filters: { projectId: null, includeSubprojects: true, statuses: [...WORKING_STATUSES], search: "", todayOnly: false, hiddenPriorities: [] },
};

export interface BoardProjectOption {
  id: string;
  label: string;
  depth: number;
}

export interface TaskPromptVars {
  project: string;
  projectPath: string;
  task: string;
  subtasks: string;
  notes: string;
  status: string;
  reason: string;
  priority: string;
}

export interface BoardFocusItem {
  project: string;
  text: string;
}

const NBSP = String.fromCharCode(160);
const INDENT_PER_DEPTH = 2;

const isStatus = (value: unknown): value is BoardStatus => typeof value === "string" && (BOARD_STATUSES as readonly string[]).includes(value);

const isPriorityDigit = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_PRIORITY_DIGIT;

function parseHiddenPriorities(value: unknown): (number | null)[] {
  if (!Array.isArray(value)) return [];
  const kept = value.filter((item): item is number | null => item === null || isPriorityDigit(item));
  return kept.filter((item, index) => kept.indexOf(item) === index);
}

function parseTableSort(value: unknown): TableSort {
  const defaults = DEFAULT_BOARD_PREFS.tableSort;
  if (typeof value !== "object" || value === null) return { ...defaults };
  const stored = value as { key?: unknown; dir?: unknown };
  const key = TABLE_SORT_KEYS.find((candidate) => candidate === stored.key);
  return { key: key ?? defaults.key, dir: stored.dir === "asc" || stored.dir === "desc" ? stored.dir : defaults.dir };
}

export function parseBoardPrefs(raw: string | null): BoardPrefs {
  if (raw === null) return DEFAULT_BOARD_PREFS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_BOARD_PREFS;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_BOARD_PREFS;
  const stored = parsed as { view?: unknown; hideEmptyColumns?: unknown; tableSort?: unknown; filters?: unknown };
  const filters = typeof stored.filters === "object" && stored.filters !== null ? (stored.filters as Record<string, unknown>) : {};
  const defaults = DEFAULT_BOARD_PREFS.filters;
  return {
    view: stored.view === "table" || stored.view === "kanban" ? stored.view : DEFAULT_BOARD_PREFS.view,
    hideEmptyColumns: typeof stored.hideEmptyColumns === "boolean" ? stored.hideEmptyColumns : DEFAULT_BOARD_PREFS.hideEmptyColumns,
    tableSort: parseTableSort(stored.tableSort),
    filters: {
      projectId: typeof filters.projectId === "string" && filters.projectId !== "" ? filters.projectId : defaults.projectId,
      includeSubprojects: typeof filters.includeSubprojects === "boolean" ? filters.includeSubprojects : defaults.includeSubprojects,
      statuses: Array.isArray(filters.statuses) ? filters.statuses.filter(isStatus) : [...defaults.statuses],
      search: typeof filters.search === "string" ? filters.search : defaults.search,
      todayOnly: typeof filters.todayOnly === "boolean" ? filters.todayOnly : defaults.todayOnly,
      hiddenPriorities: parseHiddenPriorities(filters.hiddenPriorities),
    },
  };
}

export function activeStatuses(filters: BoardFilters): BoardStatus[] {
  const picked = BOARD_STATUSES.filter((status) => filters.statuses.includes(status));
  return picked.length > 0 ? picked : [...WORKING_STATUSES];
}

export function kanbanColumns(filters: BoardFilters): BoardStatus[] {
  return activeStatuses(filters).includes("archived") ? [...BOARD_STATUSES] : [...WORKING_STATUSES];
}

export function visibleKanbanColumns(columns: BoardStatus[], counts: Record<BoardStatus, number>, hideEmpty: boolean, dragging: boolean): BoardStatus[] {
  if (!hideEmpty || dragging) return columns;
  return columns.filter((status) => counts[status] > 0);
}

export function expandableIds(tasks: BoardTask[]): string[] {
  return tasks.flatMap((task) => [task.id, ...expandableIds(task.subtasks)]);
}

export function priorityLevelList(levels: number | null | undefined, current: number | null = null): number[] {
  const count = typeof levels === "number" && Number.isInteger(levels) && levels >= 1 && levels <= MAX_PRIORITY_DIGIT + 1 ? levels : DEFAULT_PRIORITY_LEVELS;
  const list = Array.from({ length: count }, (_, level) => level);
  return current !== null && !list.includes(current) ? [...list, current] : list;
}

export function priorityFilterLevels(levels: number | null | undefined, tasks: BoardTask[]): number[] {
  const base = priorityLevelList(levels);
  const extra = tasks.flatMap((task) => (task.priority !== null && !base.includes(task.priority) ? [task.priority] : []));
  return [...base, ...extra.filter((level, index) => extra.indexOf(level) === index).sort((a, b) => a - b)];
}

export function priorityLabel(priority: number): string {
  return `P${priority}`;
}

export function priorityTone(priority: number, levels: number | null | undefined): 0 | 1 | 2 | 3 {
  const last = priorityLevelList(levels).length - 1;
  if (priority > 0 && priority >= last) return 3;
  return Math.min(priority, 2) as 0 | 1 | 2;
}

export function comparePriority(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export function sortByPriority(tasks: BoardTask[]): BoardTask[] {
  return [...tasks].sort((a, b) => comparePriority(a.priority, b.priority));
}

export function toggleHiddenPriority(hidden: (number | null)[], priority: number | null): (number | null)[] {
  return hidden.includes(priority) ? hidden.filter((item) => item !== priority) : [...hidden, priority];
}

export type TodayAvailability = "off" | "missing" | "ready";

export function todayAvailability(today: BoardToday | null): TodayAvailability {
  if (today === null) return "off";
  return today.exists ? "ready" : "missing";
}

export function multiSelectSummary(label: string, selected: string[], total: number): string {
  if (selected.length >= total) return `${label}: All`;
  if (selected.length === 0) return `${label}: None`;
  if (selected.length <= 2) return `${label}: ${selected.join(", ")}`;
  return `${label}: ${selected.length} of ${total}`;
}

const sameStatusSet = (a: readonly BoardStatus[], b: readonly BoardStatus[]): boolean => a.length === b.length && a.every((status) => b.includes(status));

export const hasDefaultStatuses = (filters: BoardFilters): boolean => sameStatusSet(activeStatuses(filters), WORKING_STATUSES);

export function statusFilterSummary(filters: BoardFilters): string {
  const active = activeStatuses(filters);
  if (hasDefaultStatuses(filters)) return "Status: All but Archived";
  return multiSelectSummary("Status", active.map((status) => BOARD_STATUS_LABEL[status]), BOARD_STATUSES.length);
}

const priorityName = (level: number | null): string => (level === null ? "No priority" : priorityLabel(level));

export function priorityFilterSummary(filters: BoardFilters, levels: (number | null)[]): string {
  const shown = levels.filter((level) => !filters.hiddenPriorities.includes(level));
  return multiSelectSummary("Priority", shown.map(priorityName), levels.length);
}

export function viewSummary(prefs: BoardPrefs, availability: TodayAvailability): string {
  const on = Number(prefs.hideEmptyColumns) + Number(prefs.filters.todayOnly && availability !== "off");
  return on === 0 ? "View" : `View: ${on} on`;
}

export function hasCustomFilters(prefs: BoardPrefs, availability: TodayAvailability): boolean {
  const { filters } = prefs;
  const defaults = DEFAULT_BOARD_PREFS;
  if (filters.projectId !== null) return true;
  if (!hasDefaultStatuses(filters)) return true;
  if (filters.hiddenPriorities.length > 0) return true;
  if (filters.todayOnly && availability !== "off") return true;
  if (filters.search.trim() !== "") return true;
  return prefs.hideEmptyColumns !== defaults.hideEmptyColumns;
}

export function resetFilterPrefs(prefs: BoardPrefs): BoardPrefs {
  const defaults = DEFAULT_BOARD_PREFS;
  return {
    ...prefs,
    hideEmptyColumns: defaults.hideEmptyColumns,
    filters: { ...defaults.filters, statuses: [...defaults.filters.statuses], hiddenPriorities: [] },
  };
}

export interface FilterNoteContext {
  projectTitle: string | null;
  availability: TodayAvailability;
}

export function activeFilterNotes(filters: BoardFilters, context: FilterNoteContext): string[] {
  const notes: string[] = [];
  if (filters.projectId !== null && context.projectTitle !== null) notes.push(`project ${context.projectTitle}`);
  const statuses = activeStatuses(filters);
  if (!hasDefaultStatuses(filters)) notes.push(`status ${statuses.map((status) => BOARD_STATUS_LABEL[status]).join(", ")}`);
  if (filters.hiddenPriorities.length > 0) notes.push(`priority hidden: ${[...filters.hiddenPriorities].sort(comparePriority).map(priorityName).join(", ")}`);
  if (filters.todayOnly && context.availability !== "off") {
    notes.push(context.availability === "missing" ? "In today's daily (today's daily does not exist yet)" : "In today's daily");
  }
  const needle = filters.search.trim();
  if (needle !== "") notes.push(`search "${needle}"`);
  return notes;
}

export function emptyResultsMessage(notes: string[]): string {
  return notes.length === 0 ? "There are no tasks to show." : `No tasks match: ${notes.join(", ")}`;
}

export function todayMissingHint(filters: BoardFilters, availability: TodayAvailability): string | null {
  return filters.todayOnly && availability === "missing" ? "Today's daily does not exist yet, so nothing is linked to it" : null;
}

export function nextTableSort(current: TableSort, key: TableSortKey): TableSort {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: "asc" };
}

export function sortTableTasks(tasks: BoardTask[], sort: TableSort, projectLabels: ReadonlyMap<string, string>): BoardTask[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const primary = (a: BoardTask, b: BoardTask): number => {
    if (sort.key === "priority") return a.priority === null || b.priority === null ? comparePriority(a.priority, b.priority) : sign * comparePriority(a.priority, b.priority);
    if (sort.key === "status") return sign * (BOARD_STATUSES.indexOf(a.status) - BOARD_STATUSES.indexOf(b.status));
    if (sort.key === "project") return sign * (projectLabels.get(a.projectId) ?? a.projectId).localeCompare(projectLabels.get(b.projectId) ?? b.projectId);
    return sign * a.title.localeCompare(b.title);
  };
  return [...tasks].sort((a, b) => primary(a, b) || comparePriority(a.priority, b.priority));
}

const NOTE_TASK_LIKE = /^([-*+]\s+)?\[[ xX-]\]/;
const NOTE_FENCE_LIKE = /^(`{3,}|~{3,})/;

export function validateNoteText(text: string): string | null {
  const value = text.trim();
  if (value === "") return "Write the note first";
  if (MULTILINE.test(value)) return "A note must be a single line";
  if (NOTE_TASK_LIKE.test(value) || NOTE_FENCE_LIKE.test(value)) return "A note cannot look like a task or a code fence";
  return null;
}

function flattenTasks(tasks: BoardTask[]): BoardTask[] {
  return tasks.flatMap((task) => [task, ...flattenTasks(task.subtasks)]);
}

const rawKey = (task: BoardTask): string => JSON.stringify([task.projectId, task.raw]);

export function remapExpanded(previous: BoardTask[], next: BoardTask[], expanded: ReadonlySet<string>): ReadonlySet<string> {
  if (expanded.size === 0) return expanded;
  const nextAll = flattenTasks(next);
  const nextById = new Map(nextAll.map((task) => [task.id, task]));
  const idsByRaw = new Map<string, string[]>();
  for (const task of nextAll) idsByRaw.set(rawKey(task), [...(idsByRaw.get(rawKey(task)) ?? []), task.id]);
  const previousAll = flattenTasks(previous);
  const previousIds = new Set(previousAll.map((task) => task.id));
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const task of previousAll) {
    const key = rawKey(task);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    if (!expanded.has(task.id)) continue;
    const sameLine = nextById.get(task.id)?.raw === task.raw ? task.id : null;
    const moved = idsByRaw.get(key)?.[occurrence] ?? null;
    const edited = nextById.has(task.id) ? task.id : null;
    const mapped = sameLine ?? moved ?? edited;
    if (mapped !== null) result.add(mapped);
  }
  for (const id of expanded) if (!previousIds.has(id) && nextById.has(id)) result.add(id);
  return result;
}

export function allExpanded(tasks: BoardTask[], expanded: ReadonlySet<string>): boolean {
  const ids = expandableIds(tasks);
  return ids.length > 0 && ids.every((id) => expanded.has(id));
}

export function projectScope(projects: BoardProject[], projectId: string | null, includeSubprojects: boolean): Set<string> | null {
  if (projectId === null || !projects.some((project) => project.id === projectId)) return null;
  const scope = new Set<string>([projectId]);
  if (!includeSubprojects) return scope;
  let grew = true;
  while (grew) {
    grew = false;
    for (const project of projects) {
      if (project.parent !== null && scope.has(project.parent) && !scope.has(project.id)) {
        scope.add(project.id);
        grew = true;
      }
    }
  }
  return scope;
}

function searchText(task: BoardTask, project: BoardProject | undefined): string {
  const own = [task.title, task.group ?? "", ...task.notes, project?.title ?? "", project?.name ?? ""];
  const nested = task.subtasks.map((subtask) => searchText(subtask, undefined));
  return [...own, ...nested].join("\n").toLowerCase();
}

function inTodaySet(task: BoardTask, ids: ReadonlySet<string>): boolean {
  return ids.has(task.id) || task.subtasks.some((subtask) => inTodaySet(subtask, ids));
}

export function filterBoardTasks(tasks: BoardTask[], projects: BoardProject[], filters: BoardFilters, todayIds: ReadonlySet<string> | null = null): BoardTask[] {
  const scope = projectScope(projects, filters.projectId, filters.includeSubprojects);
  const statuses = activeStatuses(filters);
  const needle = filters.search.trim().toLowerCase();
  const byId = new Map(projects.map((project) => [project.id, project]));
  return tasks.filter((task) => {
    if (scope && !scope.has(task.projectId)) return false;
    if (!statuses.includes(task.status)) return false;
    if (filters.hiddenPriorities.includes(task.priority)) return false;
    if (filters.todayOnly && todayIds !== null && !inTodaySet(task, todayIds)) return false;
    return needle === "" || searchText(task, byId.get(task.projectId)).includes(needle);
  });
}

export function groupByStatus(tasks: BoardTask[]): Record<BoardStatus, BoardTask[]> {
  const groups: Record<BoardStatus, BoardTask[]> = { blocked: [], hold: [], todo: [], doing: [], done: [], archived: [] };
  for (const task of tasks) groups[task.status].push(task);
  return groups;
}

function byDoneAtDesc(a: BoardTask, b: BoardTask): number {
  if (a.doneAt === b.doneAt) return 0;
  if (a.doneAt === null) return 1;
  if (b.doneAt === null) return -1;
  return a.doneAt < b.doneAt ? 1 : -1;
}

export function orderDoneColumn(tasks: BoardTask[]): BoardTask[] {
  const open = tasks.filter((task) => task.section !== "done");
  const swept = tasks.filter((task) => task.section === "done").sort(byDoneAtDesc);
  return [...open, ...swept];
}

export function capDoneSection(tasks: BoardTask[], limit: number): { tasks: BoardTask[]; hidden: number } {
  const ranked = tasks.filter((task) => task.section === "done").sort(byDoneAtDesc);
  const keep = new Set(ranked.slice(0, Math.max(0, limit)).map((task) => task.id));
  return { tasks: tasks.filter((task) => task.section !== "done" || keep.has(task.id)), hidden: ranked.length - keep.size };
}

export function doneColumnView(tasks: BoardTask[], limit: number): { tasks: BoardTask[]; hidden: number } {
  return capDoneSection(orderDoneColumn(tasks), limit);
}

export function todayIdSet(today: BoardToday | null): ReadonlySet<string> | null {
  return today === null ? null : new Set(today.taskIds);
}

export function todayHint(today: BoardToday | null, taskId: string): BoardCheckbox | null {
  return today?.states[taskId] ?? null;
}

export function todayAddState(today: BoardToday | null): { visible: boolean; allowed: boolean; hint: string } {
  if (today === null) return { visible: false, allowed: false, hint: "Turn on the Daily feature to link tasks to your daily" };
  if (!today.exists) return { visible: true, allowed: false, hint: "Create today's daily first" };
  return { visible: true, allowed: true, hint: "Add to today's daily" };
}

export function sweepTargets(projects: BoardProject[], filters: BoardFilters): string[] | null {
  const scope = projectScope(projects, filters.projectId, filters.includeSubprojects);
  if (scope === null) return null;
  return projects.filter((project) => scope.has(project.id)).map((project) => project.id);
}

export function reasonChange(value: string, current: string | null): string | null | undefined {
  const next = value.trim();
  if (next === (current ?? "")) return undefined;
  return next === "" ? null : next;
}

export interface NewTaskDraft {
  projectId: string;
  title: string;
  status: BoardStatus;
  reason: string;
  priority: number | null;
}

const MULTILINE = /[\r\n]/;

export function validateNewTask(draft: NewTaskDraft): string | null {
  if (draft.projectId === "") return "Pick a project";
  if (draft.title.trim() === "") return "Give the task a title";
  if (MULTILINE.test(draft.title.trim())) return "The title must be a single line";
  if (supportsReason(draft.status) && MULTILINE.test(draft.reason.trim())) return "The reason must be a single line";
  return null;
}

export function newTaskBody(draft: NewTaskDraft, parent: BoardTask | null): BoardCreateInput {
  const reason = draft.reason.trim();
  return {
    projectId: draft.projectId,
    title: draft.title.trim(),
    status: draft.status,
    ...(supportsReason(draft.status) && reason !== "" ? { reason } : {}),
    ...(draft.priority !== null ? { priority: draft.priority } : {}),
    ...(parent ? { parentLine: parent.line, parentRaw: parent.raw } : {}),
  };
}

export interface TaskSettingsInput {
  reasonSeparator: string;
  doneSection: string;
  doneStamp: string;
  priorityTag: string;
  priorityLevels: string;
}

const PRIORITY_TAG_FORMAT = /^[A-Za-z0-9_-]+$/;

export function validateTaskSettings(values: TaskSettingsInput): Record<keyof TaskSettingsInput, string | null> {
  const levels = values.priorityLevels.trim();
  return {
    priorityTag: PRIORITY_TAG_FORMAT.test(values.priorityTag.trim()) ? null : "Use letters, digits, - or _ only",
    priorityLevels: /^\d+$/.test(levels) && Number(levels) >= 1 && Number(levels) <= 10 ? null : "Use a whole number from 1 to 10",
    reasonSeparator:
      values.reasonSeparator.trim() === ""
        ? "Use a separator with some text in it, such as \" | \""
        : MULTILINE.test(values.reasonSeparator)
          ? "The separator must be a single line"
          : null,
    doneSection: MULTILINE.test(values.doneSection) ? "The section name must be a single line" : null,
    doneStamp: MULTILINE.test(values.doneStamp)
      ? "The stamp must be a single line"
      : !values.doneStamp.includes("{{date}}")
        ? "The stamp must contain {{date}}"
        : null,
  };
}

export function candidateLabels(ids: string[], tasks: BoardTask[], projects: BoardProject[]): string[] {
  return ids.map((id) => {
    const found = findBoardTask(tasks, id);
    if (!found) return id;
    const chain = projectBreadcrumb(projects, found.projectId);
    return `${chain[chain.length - 1] ?? found.projectId}: ${found.title}`;
  });
}

export function projectBreadcrumb(projects: BoardProject[], projectId: string): string[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(projectId);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor.title);
    cursor = cursor.parent === null ? undefined : byId.get(cursor.parent);
  }
  return chain.reverse();
}

export function projectOptions(projects: BoardProject[]): BoardProjectOption[] {
  return projects.map((project) => ({ id: project.id, depth: project.depth, label: `${NBSP.repeat(project.depth * INDENT_PER_DEPTH)}${project.title}` }));
}

export function subtaskProgress(task: BoardTask): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const visit = (items: BoardTask[]): void => {
    for (const item of items) {
      total += 1;
      if (item.status === "done") done += 1;
      visit(item.subtasks);
    }
  };
  visit(task.subtasks);
  return { done, total };
}

function subtaskLines(tasks: BoardTask[], level: number): string[] {
  return tasks.flatMap((task) => {
    const mark = task.checkbox === "done" ? "x" : task.checkbox === "doing" ? "-" : " ";
    const base = task.prefix ? `${task.prefix} - ${task.title}` : task.title;
    const label = task.reason ? `${base} - ${task.reason}` : base;
    return [`${"  ".repeat(level)}- [${mark}] ${label}`, ...subtaskLines(task.subtasks, level + 1)];
  });
}

export function taskPromptVars(project: BoardProject, task: BoardTask): TaskPromptVars {
  const subtasks = subtaskLines(task.subtasks, 0);
  return {
    project: project.title,
    projectPath: project.path,
    task: task.title,
    subtasks: subtasks.length > 0 ? subtasks.join("\n") : "none",
    notes: task.notes.length > 0 ? task.notes.map((note) => `- ${note}`).join("\n") : "none",
    status: task.status,
    reason: task.reason ?? "none",
    priority: task.priority === null ? "none" : priorityLabel(task.priority),
  };
}

export function renderTaskDelegatePrompt(template: string, vars: TaskPromptVars): string {
  return template
    .split("{{project}}")
    .join(vars.project)
    .split("{{projectPath}}")
    .join(vars.projectPath)
    .split("{{task}}")
    .join(vars.task)
    .split("{{subtasks}}")
    .join(vars.subtasks)
    .split("{{notes}}")
    .join(vars.notes)
    .split("{{status}}")
    .join(vars.status)
    .split("{{reason}}")
    .join(vars.reason)
    .split("{{priority}}")
    .join(vars.priority);
}

export function delegatePromptFor(template: string, project: BoardProject, task: BoardTask): string {
  return renderTaskDelegatePrompt(template, taskPromptVars(project, task));
}

export function findBoardTask(tasks: BoardTask[], id: string): BoardTask | null {
  for (const task of tasks) {
    if (task.id === id) return task;
    const nested = findBoardTask(task.subtasks, id);
    if (nested) return nested;
  }
  return null;
}

export function replaceBoardTask(tasks: BoardTask[], updated: BoardTask): BoardTask[] {
  return tasks.map((task) => {
    if (task.id === updated.id) return updated;
    if (task.subtasks.length === 0) return task;
    const subtasks = replaceBoardTask(task.subtasks, updated);
    return subtasks.some((subtask, index) => subtask !== task.subtasks[index]) ? { ...task, subtasks } : task;
  });
}

export function pickableTasks(tasks: BoardTask[], projects: BoardProject[], projectId: string | null): BoardTask[] {
  return filterBoardTasks(tasks, projects, { projectId, includeSubprojects: true, statuses: ["todo", "doing"], search: "", todayOnly: false, hiddenPriorities: [] });
}

export function focusItemFromTask(project: BoardProject, task: BoardTask): BoardFocusItem {
  return { project: project.name, text: task.title };
}

export function formatList(items: string[]): string {
  return items.join(", ");
}

export function parseList(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export type MoveDirection = "up" | "down";

export interface MoveAvailability {
  up: boolean;
  down: boolean;
}

export type OwnedItem = { kind: "task"; line: number; task: BoardTask } | { kind: "note"; line: number; note: BoardNoteItem };

const CLOSED_MOVE: MoveAvailability = { up: false, down: false };

export function orderedChildren(task: BoardTask): OwnedItem[] {
  const items: OwnedItem[] = [
    ...task.noteItems.map((note): OwnedItem => ({ kind: "note", line: note.line, note })),
    ...task.subtasks.map((subtask): OwnedItem => ({ kind: "task", line: subtask.line, task: subtask })),
  ];
  return items.sort((a, b) => a.line - b.line);
}

export function findParentTask(tasks: BoardTask[], id: string): BoardTask | null {
  for (const task of tasks) {
    if (task.subtasks.some((subtask) => subtask.id === id)) return task;
    const nested = findParentTask(task.subtasks, id);
    if (nested) return nested;
  }
  return null;
}

export const isSubtask = (tasks: BoardTask[], task: BoardTask): boolean => findParentTask(tasks, task.id) !== null;

function positionAvailability(positions: number[], index: number): MoveAvailability {
  if (index < 0) return CLOSED_MOVE;
  return { up: index > 0, down: index < positions.length - 1 };
}

export function taskMoveAvailability(tasks: BoardTask[], task: BoardTask): MoveAvailability {
  const parent = findParentTask(tasks, task.id);
  if (parent) {
    const siblings = orderedChildren(parent);
    return positionAvailability(
      siblings.map((item) => item.line),
      siblings.findIndex((item) => item.kind === "task" && item.line === task.line),
    );
  }
  const topLevel = tasks
    .filter((candidate) => candidate.projectId === task.projectId && candidate.section === task.section && candidate.group === task.group)
    .map((candidate) => candidate.line)
    .sort((a, b) => a - b);
  return positionAvailability(topLevel, topLevel.indexOf(task.line));
}

export function noteMoveAvailability(owner: BoardTask, note: BoardNoteItem): MoveAvailability {
  const siblings = orderedChildren(owner);
  return positionAvailability(
    siblings.map((item) => item.line),
    siblings.findIndex((item) => item.kind === "note" && item.line === note.line),
  );
}

export interface ParentCandidate {
  task: BoardTask;
  level: number;
}

export function parentCandidates(tasks: BoardTask[], projectId: string, exclude: BoardTask | null = null): ParentCandidate[] {
  const found: ParentCandidate[] = [];
  const visit = (items: BoardTask[], level: number): void => {
    for (const item of [...items].sort((a, b) => a.line - b.line)) {
      if (exclude !== null && item.id === exclude.id) continue;
      found.push({ task: item, level });
      visit(item.subtasks, level + 1);
    }
  };
  visit(
    tasks.filter((task) => task.projectId === projectId),
    0,
  );
  return found;
}

export function moveTargetProjects(projects: BoardProject[], currentProjectId: string): BoardProjectOption[] {
  return projectOptions(projects.filter((project) => project.id !== currentProjectId));
}

export type TaskAnchor = Pick<BoardTask, "id" | "projectId" | "title" | "line">;

export function findTaskAfterRefetch(tasks: BoardTask[], anchor: TaskAnchor): BoardTask | null {
  const byId = findBoardTask(tasks, anchor.id);
  if (byId && byId.projectId === anchor.projectId && byId.title === anchor.title) return byId;
  const sameTitle = flattenTasks(tasks).filter((task) => task.projectId === anchor.projectId && task.title === anchor.title);
  const nearest = [...sameTitle].sort((a, b) => Math.abs(a.line - anchor.line) - Math.abs(b.line - anchor.line))[0];
  return nearest ?? null;
}

export function remapTaskId(previous: BoardTask[], next: BoardTask[], id: string): string | null {
  const mapped = remapExpanded(previous, next, new Set([id]));
  return [...mapped][0] ?? null;
}

export const organizeFocus = (root: BoardTask, target: BoardTask, result: BoardTask): BoardTask => (target.id === root.id ? result : root);

export const obsidianUrl = (absolutePath: string): string => `obsidian://open?path=${encodeURIComponent(absolutePath)}`;

export const parentCandidateLabel = (candidate: ParentCandidate): string =>
  `${NBSP.repeat(candidate.level * INDENT_PER_DEPTH)}${candidate.task.title}${candidate.task.section === "done" ? " (done section)" : ""}`;
