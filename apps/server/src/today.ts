import { randomUUID } from "node:crypto";
import {
  DailyConflictError,
  dailyFile,
  dailyTemplateText,
  findHeadingIndex,
  isPlaceholderLine,
  isValidDailyDate,
  readDaily,
  renderFocusLines,
  renderTemplate,
  setDailyHooks,
  taskBlock,
  writeDaily,
  type ComposeBoard,
  type ComposeFocusItem,
  type DailyReadResult,
  type DailyWriteOrigin,
} from "./daily.js";
import { BadRequestError, NotFoundError } from "./delegation-launch.js";
import { getSetting, getSettings, getTodayBaseline, saveTodayBaseline, setSetting } from "./delegation-store.js";
import type { DelegationSettings, FocusSource } from "./delegation-types.js";
import { localDate } from "./second-brain.js";
import {
  applyStatusChange,
  checkboxForStatus,
  collectBoard,
  composeBoardFrom,
  createBoardTask,
  docLine,
  effectiveProjectOrder,
  flattenTasks,
  focusRange,
  joinReason,
  normalizeText,
  openDoc,
  renderDoc,
  requireBoardRoot,
  scanDaily,
  setBoardHooks,
  statusFromCheckbox,
  taskNeedle,
  writeBoardTask,
  type BoardCheckbox,
  type BoardProject,
  type BoardStatus,
  type BoardTask,
  type DocLine,
  type FocusScan,
  type ParsedDoc,
} from "./tasks-board.js";

export interface TodayProject {
  id: string;
  title: string;
  name: string;
}

export interface TodayEntry {
  task: BoardTask;
  project: TodayProject;
  parentTitle: string | null;
}

export interface TodayCapture {
  line: number;
  raw: string;
  text: string;
  promotedTo: string | null;
}

export type AmbiguityReason = "same-title" | "unclear-line" | "several-lines" | "several-tasks";

export interface TodayAmbiguous {
  kind: "task" | "line";
  text: string;
  line: number | null;
  taskId: string | null;
  reason: AmbiguityReason;
}

export interface TodayPayload {
  date: string;
  focusSource: FocusSource;
  focus: TodayEntry[];
  carriedOver: TodayEntry[];
  meetings: string[];
  captures: TodayCapture[];
  unlinked: string[];
  inNote: string[];
  ambiguous: TodayAmbiguous[];
  summary: string | null;
  dailyExists: boolean;
  dailyUpdatedAt: number | null;
}

export interface ScheduleInput {
  projectId: string;
  line: number;
  raw: string;
  date: string | null;
}

export interface PromoteInput {
  line: number;
  raw: string;
  projectId: string;
  schedule?: boolean;
}

export type MirrorSource = "api" | "board" | "disk" | "client" | "migrate";

export type MirrorSkip = "disabled" | "list" | "past" | "no-daily" | "no-board" | "refused" | "conflict" | "failed";

export interface MirrorOptions {
  source?: MirrorSource;
  hints?: ReadonlySet<string>;
}

export interface MirrorResult {
  changed: boolean;
  skipped: MirrorSkip | null;
  applied: number;
}

export interface MigrationSkip {
  taskId: string;
  title: string;
  scheduled: string | null;
  reason: "scheduled-elsewhere" | "finished-earlier" | "archived";
}

export interface MigrationFailure {
  taskId: string;
  error: string;
}

export interface MigrationResult {
  scheduled: number;
  synced: number;
  skipped: MigrationSkip[];
  failed: MigrationFailure[];
  ambiguous: TodayAmbiguous[];
}

export interface TodayApi {
  focusOf(settings: DelegationSettings, date: string): TodayEntry[];
  carriedOver(settings: DelegationSettings, date: string): TodayEntry[];
  schedule(settings: DelegationSettings, input: ScheduleInput): { task: BoardTask };
  regenerateFocusMirror(settings: DelegationSettings, date: string, options?: MirrorOptions): MirrorResult;
  migrateFocus(settings: DelegationSettings, date: string): MigrationResult;
  appendCapture(settings: DelegationSettings, date: string, text: string): TodayCapture[];
  promoteCapture(settings: DelegationSettings, date: string, input: PromoteInput): { task: BoardTask };
  appendMeeting(settings: DelegationSettings, date: string, text: string): string[];
  createToday(settings: DelegationSettings, date: string): { dailyExists: true };
}

export class StaleCaptureError extends Error {
  constructor() {
    super("the capture changed on disk");
  }
}

const LINE_SPLIT_RE = /\r\n|\n/;
const SECTION_RE = /^##\s+/;
const MARK_RE = /^(\s*[-*]\s+\[)([ xX-])(\])/;
const FOCUS_LINE_RE = /^\s*[-*]\s+\[[ xX-]\]\s?(.*)$/;
const BULLET_RE = /^[-*+]\s+(.*)$/;
const LEADING_CHECKBOX_RE = /^\[[ xX-]\]\s*/;
const PROMOTED_RE = /\s*(?:\u2192|->)\s*\[\[([^\]]+)\]\]\s*$/;
const BQUOTE_RE = /^\s{0,3}>\s?/;
const SCHEDULED_DATE_RE = /\u23F3\uFE0F?\s*(\d{4}-\d{2}-\d{2})/g;
const PROMOTE_ARROW = "\u2192";
const SUBTASK_INDENT = "  ";
const KEY_SEPARATOR = "\u0000";
const CAPTURE_MAX = 2000;
const SEEN_LIMIT = 400;
const BASELINE_KEEP_DAYS = 7;
const MIGRATED_KEY = "today.migrated.";
const BOARD_DELAY_MS = 50;
const CLIENT_DELAY_MS = 400;
const DISK_DELAY_MS = 1200;
const OPEN_STATUSES: ReadonlySet<BoardStatus> = new Set<BoardStatus>(["todo", "doing", "blocked", "hold"]);
const SYNCED_STATUSES: ReadonlySet<BoardStatus> = new Set<BoardStatus>(["todo", "doing", "done"]);
const MARKS: Record<BoardCheckbox, string> = { todo: " ", doing: "-", done: "x" };

export function focusSourceOf(settings: DelegationSettings): FocusSource {
  return settings.daily.focusSource ?? "scheduled";
}

function isScheduledMode(settings: DelegationSettings): boolean {
  return focusSourceOf(settings) === "scheduled" && settings.features.daily && settings.features.tasks;
}

function isCurrentOrFuture(date: string): boolean {
  return date >= localDate();
}

interface BoardData {
  projects: BoardProject[];
  tasks: BoardTask[];
}

function loadBoardData(settings: DelegationSettings): BoardData | null {
  if (!settings.features.tasks) return null;
  try {
    const { loaded, tasks } = collectBoard(requireBoardRoot(settings), settings.tasks);
    return { projects: loaded.projects, tasks };
  } catch {
    return null;
  }
}

function readDailySafe(settings: DelegationSettings, date: string): DailyReadResult | null {
  try {
    return readDaily(settings, date);
  } catch {
    return null;
  }
}

const isOpenTask = (task: BoardTask): boolean => OPEN_STATUSES.has(task.status);

function inFocus(task: BoardTask, date: string): boolean {
  if (isOpenTask(task)) return task.scheduled === date;
  if (task.status !== "done" || task.scheduled === null) return false;
  if (task.doneAt === date) return task.scheduled <= date;
  return task.doneAt === null && task.scheduled === date;
}

const isCarried = (task: BoardTask, date: string): boolean => isOpenTask(task) && task.scheduled !== null && task.scheduled < date;

function selectEntries(settings: DelegationSettings, data: BoardData, matches: (task: BoardTask) => boolean): TodayEntry[] {
  const projects = new Map(data.projects.map((project) => [project.id, project]));
  const rank = new Map(effectiveProjectOrder(data.projects, settings.daily.projectOrder).map((id, index) => [id, index]));
  const found: { entry: TodayEntry; rank: number }[] = [];
  const visit = (task: BoardTask, parent: BoardTask | null, covered: boolean): void => {
    const hit = matches(task);
    const project = projects.get(task.projectId);
    if (hit && !covered && project) {
      found.push({
        entry: { task, project: { id: project.id, title: project.title, name: project.name }, parentTitle: parent?.title ?? null },
        rank: rank.get(task.projectId) ?? Number.POSITIVE_INFINITY,
      });
    }
    for (const subtask of task.subtasks) visit(subtask, task, covered || hit);
  };
  for (const task of data.tasks) visit(task, null, false);
  return found.sort((a, b) => (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1)).map(({ entry }) => entry);
}

function computeFocus(settings: DelegationSettings, data: BoardData | null, date: string): TodayEntry[] {
  return data === null ? [] : selectEntries(settings, data, (task) => inFocus(task, date));
}

function computeCarried(settings: DelegationSettings, data: BoardData | null, date: string): TodayEntry[] {
  return data === null || !isCurrentOrFuture(date) ? [] : selectEntries(settings, data, (task) => isCarried(task, date));
}

const isBlankText = (text: string | undefined): boolean => text === undefined || text.trim() === "";

const splitLines = (content: string): string[] => content.split(LINE_SPLIT_RE);

function checkboxOfMark(mark: string): BoardCheckbox {
  if (mark === "-") return "doing";
  return mark === " " ? "todo" : "done";
}

function checkboxOfLine(text: string): BoardCheckbox | null {
  const match = text.match(MARK_RE);
  return match ? checkboxOfMark(match[2] as string) : null;
}

function withCheckbox(text: string, checkbox: BoardCheckbox): string {
  const current = checkboxOfLine(text);
  if (current === null || current === checkbox) return text;
  return text.replace(MARK_RE, (_whole, open: string, _mark: string, close: string) => `${open}${MARKS[checkbox]}${close}`);
}

const unmarkedText = (text: string): string => text.replace(MARK_RE, "$1$3");

function lineKeys(texts: string[]): string[] {
  const counts = new Map<string, number>();
  return texts.map((text) => {
    const base = unmarkedText(text);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return `${base}${KEY_SEPARATOR}${seen}`;
  });
}

function checkboxesByKey(texts: string[]): Map<string, BoardCheckbox> {
  const keys = lineKeys(texts);
  const out = new Map<string, BoardCheckbox>();
  texts.forEach((text, index) => {
    const checkbox = checkboxOfLine(text);
    if (checkbox !== null) out.set(keys[index] as string, checkbox);
  });
  return out;
}

function keepsEveryLine(before: string, after: string): boolean {
  const next = splitLines(after).map(unmarkedText);
  let at = 0;
  for (const line of splitLines(before)) {
    const wanted = unmarkedText(line);
    while (at < next.length && next[at] !== wanted) at += 1;
    if (at >= next.length) return false;
    at += 1;
  }
  return true;
}

const fingerprintOf = (projectId: string, title: string): string => `${projectId}${KEY_SEPARATOR}${normalizeText(title)}`;

const fingerprint = (task: BoardTask): string => fingerprintOf(task.projectId, task.title);

const projectCheckbox = (task: BoardTask): BoardCheckbox | null => (SYNCED_STATUSES.has(task.status) ? checkboxForStatus(task.status) : null);

const isOccurrence = (task: BoardTask): boolean => task.repeat !== null && task.doneAt !== null;

const markOf = (task: BoardTask): string => MARKS[checkboxForStatus(task.status)];

interface MarkMemo {
  checkbox: BoardCheckbox;
  task: string;
  id: string;
}

interface SeenTask {
  projectId: string;
  title: string;
}

interface BaselineState {
  marks: Record<string, MarkMemo>;
  seen: SeenTask[];
  focus: SeenTask[];
}

interface Baseline {
  content: string;
  state: BaselineState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCheckbox(value: unknown): value is BoardCheckbox {
  return value === "todo" || value === "doing" || value === "done";
}

function parseState(raw: string): BaselineState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const marks: Record<string, MarkMemo> = {};
  if (isRecord(value.marks)) {
    for (const [key, memo] of Object.entries(value.marks)) {
      if (isRecord(memo) && isCheckbox(memo.checkbox) && typeof memo.task === "string" && typeof memo.id === "string") {
        marks[key] = { checkbox: memo.checkbox, task: memo.task, id: memo.id };
      }
    }
  }
  return { marks, seen: parseSeen(value.seen), focus: parseSeen(value.focus) };
}

function parseSeen(value: unknown): SeenTask[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) =>
    isRecord(item) && typeof item.projectId === "string" && typeof item.title === "string" ? [{ projectId: item.projectId, title: item.title }] : [],
  );
}

function daysBefore(date: string, days: number): string {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}

function loadBaseline(date: string, path: string): Baseline | null {
  const record = getTodayBaseline(date);
  if (!record || record.path !== path) return null;
  const state = parseState(record.state);
  return state === null ? null : { content: record.content, state };
}

function storeBaseline(date: string, path: string, baseline: Baseline): void {
  const state = JSON.stringify(baseline.state);
  const current = getTodayBaseline(date);
  if (current && current.path === path && current.content === baseline.content && current.state === state) return;
  saveTodayBaseline({ date, path, content: baseline.content, state }, daysBefore(localDate(), BASELINE_KEEP_DAYS));
}

interface LinkedLine {
  line: number;
  checkbox: BoardCheckbox;
  task: BoardTask;
  effective: BoardCheckbox | null;
  userSynced: boolean;
}

function linkedLinesOf(scan: FocusScan): LinkedLine[] {
  const out: LinkedLine[] = [];
  for (const entry of scan.entries) {
    const task = entry.match.task;
    if (task === null) continue;
    if (!entry.held) out.push({ line: entry.line, checkbox: entry.checkbox, task, effective: projectCheckbox(task), userSynced: true });
    else if (entry.recurred) out.push({ line: entry.line, checkbox: entry.checkbox, task, effective: "done", userSynced: false });
    if (entry.recurring) continue;
    for (const child of entry.children) {
      if (child.task) out.push({ line: child.line, checkbox: child.checkbox, task: child.task, effective: projectCheckbox(child.task), userSynced: true });
    }
  }
  return out;
}

const syncedLinksOf = (scan: FocusScan): LinkedLine[] => linkedLinesOf(scan).filter((link) => link.task.scheduled !== null);

const isSameTask = (memo: MarkMemo, task: BoardTask): boolean => memo.task === fingerprint(task) || memo.id === task.id;

function memoMarks(content: string, scan: FocusScan): Record<string, MarkMemo> {
  const keys = lineKeys(splitLines(content));
  const marks: Record<string, MarkMemo> = {};
  for (const link of linkedLinesOf(scan)) {
    const key = keys[link.line];
    if (key === undefined || link.effective === null) continue;
    marks[key] = { checkbox: link.effective, task: fingerprint(link.task), id: link.task.id };
  }
  return marks;
}

function linkedTasks(scan: FocusScan): BoardTask[] {
  const out: BoardTask[] = [];
  for (const entry of scan.entries) {
    if (entry.match.task) out.push(entry.match.task);
    for (const child of entry.children) if (child.task) out.push(child.task);
  }
  return out;
}

const seenKey = (item: SeenTask): string => `${item.projectId}${KEY_SEPARATOR}${item.title}`;

function mergeSeen(seen: SeenTask[], tasks: BoardTask[]): SeenTask[] {
  const out = [...seen];
  const keys = new Set(out.map(seenKey));
  for (const task of tasks) {
    const item: SeenTask = { projectId: task.projectId, title: normalizeText(task.title) };
    const key = seenKey(item);
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(item);
  }
  return out.slice(-SEEN_LIMIT);
}

function focusMemory(focus: TodayEntry[]): SeenTask[] {
  return mergeSeen(
    [],
    focus.flatMap((entry) => flattenTasks([entry.task])),
  );
}

function adoptBaseline(settings: DelegationSettings, date: string, path: string, content: string, data: BoardData): Baseline {
  const scan = scanDaily(settings, date, content, data.projects, data.tasks);
  const state: BaselineState = { marks: memoMarks(content, scan), seen: mergeSeen([], linkedTasks(scan)), focus: focusMemory(computeFocus(settings, data, date)) };
  const baseline: Baseline = { content, state };
  storeBaseline(date, path, baseline);
  return baseline;
}

function isKnown(task: BoardTask, seen: SeenTask[], existing: ReadonlySet<string>): boolean {
  const title = normalizeText(task.title);
  return seen.some((item) => item.title === title && (item.projectId === task.projectId || !existing.has(seenKey(item))));
}

function renameBudget(memory: SeenTask[], data: BoardData, existing: ReadonlySet<string>): Map<string, number> {
  const titles = new Set(flattenTasks(data.tasks).map((task) => normalizeText(task.title)));
  const budget = new Map<string, number>();
  for (const item of memory) {
    if (existing.has(seenKey(item)) || titles.has(item.title)) continue;
    budget.set(item.projectId, (budget.get(item.projectId) ?? 0) + 1);
  }
  return budget;
}

interface Presence {
  lines: Map<string, number[]>;
  unclear: Set<string>;
  recurred: Set<string>;
}

function presenceOf(scan: FocusScan): Presence {
  const presence: Presence = { lines: new Map(), unclear: new Set(), recurred: new Set() };
  const add = (id: string, line: number): void => {
    presence.lines.set(id, [...(presence.lines.get(id) ?? []), line]);
  };
  for (const entry of scan.entries) {
    const task = entry.match.task;
    if (task) {
      add(task.id, entry.line);
      if (entry.recurred) presence.recurred.add(fingerprint(task));
    } else {
      for (const candidate of entry.match.candidates) presence.unclear.add(candidate);
    }
    for (const child of entry.children) if (child.task) add(child.task.id, child.line);
  }
  return presence;
}

function isPresent(presence: Presence, task: BoardTask): boolean {
  if ((presence.lines.get(task.id)?.length ?? 0) > 0) return true;
  return isOccurrence(task) && presence.recurred.has(fingerprint(task));
}

function linkedAt(scan: FocusScan): Map<number, string | null> {
  const map = new Map<number, string | null>();
  for (const entry of scan.entries) {
    map.set(entry.line, entry.match.task?.id ?? null);
    for (const child of entry.children) map.set(child.line, child.task?.id ?? null);
  }
  return map;
}

interface TreeLine {
  text: string;
  taskId: string;
  depth: number;
}

function treeLines(task: BoardTask, depth: number, prefix: (depth: number) => string, skip: (task: BoardTask) => boolean): TreeLine[] {
  return [
    { text: `${prefix(depth)}- [${markOf(task)}] ${task.title}`, taskId: task.id, depth },
    ...task.subtasks.filter((subtask) => !skip(subtask)).flatMap((subtask) => treeLines(subtask, depth + 1, prefix, skip)),
  ];
}

function withoutLine(lines: TreeLine[], index: number): TreeLine[] {
  const depth = (lines[index] as TreeLine).depth;
  let end = index + 1;
  while (end < lines.length && (lines[end] as TreeLine).depth > depth) end += 1;
  return [...lines.slice(0, index), ...lines.slice(end)];
}

function leadOf(text: string): string {
  return text.match(/^\s*/)?.[0] ?? "";
}

function indentWidth(text: string): number {
  let width = 0;
  for (const ch of leadOf(text)) width += ch === "\t" ? 4 : 1;
  return width;
}

function canonicalHead(settings: DelegationSettings, project: TodayProject, task: BoardTask): string {
  const label = settings.daily.wikilinks ? `[[${project.name}|${project.title}]]` : project.title;
  return `- [${markOf(task)}] ${label} - ${task.title}`;
}

function projectOfFocusLine(text: string | undefined, board: ComposeBoard): string | null {
  const match = text?.match(FOCUS_LINE_RE);
  const rest = match ? (match[1] as string).trim() : "";
  return rest === "" ? null : board.projectOfLine(rest);
}

interface InsertSpot {
  at: number;
  prefix: string[];
  suffix: string[];
}

function insertionSpot(settings: DelegationSettings, texts: string[], board: ComposeBoard, first: string | undefined): InsertSpot {
  const range = focusRange(texts, settings);
  if (!range) {
    let last = texts.length - 1;
    while (last >= 0 && isBlankText(texts[last])) last -= 1;
    return { at: last + 1, prefix: [...(last >= 0 ? [""] : []), `## ${settings.daily.headings.focus}`, ""], suffix: [] };
  }
  let last = range.end - 1;
  while (last > range.heading && isBlankText(texts[last])) last -= 1;
  if (last === range.heading) {
    const at = range.heading + 1;
    if (at < texts.length && isBlankText(texts[at])) return { at: at + 1, prefix: [], suffix: at + 1 < texts.length && !isBlankText(texts[at + 1]) ? [""] : [] };
    return { at, prefix: [""], suffix: at < texts.length ? [""] : [] };
  }
  let top = last;
  while (top > range.heading && (isBlankText(texts[top]) || indentWidth(texts[top] as string) > 0)) top -= 1;
  const lastText = top > range.heading ? (texts[top] as string) : undefined;
  if (lastText !== undefined && isPlaceholderLine(lastText)) return { at: last + 1, prefix: [], suffix: [] };
  const lastProject = projectOfFocusLine(lastText, board);
  const firstProject = projectOfFocusLine(first, board);
  const separate = lastProject === null || firstProject === null || lastProject !== firstProject;
  return { at: last + 1, prefix: separate ? [""] : [], suffix: [] };
}

interface InsertResult {
  inserted: BoardTask[];
  renamed: BoardTask[];
  ambiguous: TodayAmbiguous[];
}

interface InsertMemory {
  seen: SeenTask[];
  focus: SeenTask[];
}

interface TopItem {
  task: BoardTask;
  lines: TreeLine[];
}

function layoutOf(rendered: string[], items: TopItem[]): (TreeLine | null)[] | null {
  const owners: (TreeLine | null)[] = [];
  const used = new Set<number>();
  let index = 0;
  while (index < rendered.length) {
    const text = rendered[index] as string;
    const match = items.findIndex(
      (item, position) => !used.has(position) && item.lines.every((line, offset) => rendered[index + offset] === line.text),
    );
    if (match === -1) {
      if (text !== "") return null;
      owners.push(null);
      index += 1;
      continue;
    }
    used.add(match);
    const item = items[match] as TopItem;
    owners.push(...item.lines);
    index += item.lines.length;
  }
  return used.size === items.length ? owners : null;
}

function insertMissing(
  settings: DelegationSettings,
  date: string,
  doc: ParsedDoc,
  data: BoardData,
  focus: TodayEntry[],
  memory: InsertMemory,
  hints: ReadonlySet<string>,
): InsertResult {
  const result: InsertResult = { inserted: [], renamed: [], ambiguous: [] };
  const parents = parentMap(data.tasks);
  const byId = new Map(flattenTasks(data.tasks).map((task) => [task.id, task]));
  const projects = new Map(data.projects.map((project) => [project.id, project]));
  const existing = new Set(flattenTasks(data.tasks).map((task) => `${task.projectId}${KEY_SEPARATOR}${normalizeText(task.title)}`));
  const budget = renameBudget(memory.focus, data, existing);
  const board = composeBoardFrom(settings, data.projects);
  const textsOf = (): string[] => doc.lines.map((line) => line.text);
  const scanOf = (texts: string[]): FocusScan => scanDaily(settings, date, texts.join("\n"), data.projects, data.tasks);
  let presence = presenceOf(scanOf(textsOf()));
  const refresh = (): void => {
    presence = presenceOf(scanOf(textsOf()));
  };
  const reported = new Set<string>();
  const ambiguous = (task: BoardTask, reason: AmbiguityReason): void => {
    if (reported.has(task.id)) return;
    reported.add(task.id);
    const project = projects.get(task.projectId);
    result.ambiguous.push({ kind: "task", text: project ? `${project.title} - ${task.title}` : task.title, line: null, taskId: task.id, reason });
  };
  const known = (task: BoardTask): boolean => {
    if (hints.has(task.id)) return false;
    if (isKnown(task, memory.seen, existing)) return true;
    const left = budget.get(task.projectId) ?? 0;
    if (left === 0) return false;
    budget.set(task.projectId, left - 1);
    result.renamed.push(task);
    return true;
  };
  const skip = (task: BoardTask): boolean => isPresent(presence, task) || presence.unclear.has(task.id) || known(task);
  const settle = (lines: TreeLine[], check: (lines: TreeLine[]) => number[]): TreeLine[] | null => {
    let current = lines;
    for (;;) {
      if (current.length === 0) return null;
      const failing = check(current);
      if (failing.length === 0) return current;
      if (failing.includes(0)) return null;
      const index = failing[0] as number;
      ambiguous(byId.get((current[index] as TreeLine).taskId) as BoardTask, "same-title");
      current = withoutLine(current, index);
    }
  };
  const record = (lines: TreeLine[]): void => {
    for (const line of lines) {
      const task = byId.get(line.taskId);
      if (task) result.inserted.push(task);
    }
  };
  const placeUnder = (parent: BoardTask, task: BoardTask): void => {
    const at = presence.lines.get(parent.id) ?? [];
    if (at.length !== 1) {
      ambiguous(task, "several-lines");
      return;
    }
    const texts = textsOf();
    const start = at[0] as number;
    const last = start + taskBlock(texts.join("\n"), start).split(LINE_SPLIT_RE).length - 1;
    const parentLead = leadOf(texts[start] as string);
    let childLead: string | null = null;
    for (let index = start + 1; index <= last; index += 1) {
      const text = texts[index] as string;
      if (FOCUS_LINE_RE.test(text) && indentWidth(text) > indentWidth(texts[start] as string)) {
        childLead = leadOf(text);
        break;
      }
    }
    const unit = parentLead.includes("\t") ? "\t" : SUBTASK_INDENT;
    const lead = childLead ?? `${parentLead}${unit}`;
    const step = lead.length > parentLead.length && lead.startsWith(parentLead) ? lead.slice(parentLead.length) : unit;
    const lines = treeLines(task, 1, (depth) => `${lead}${step.repeat(depth - 1)}`, skip);
    const accepted = settle(lines, (candidate) => {
      const copy = [...texts];
      copy.splice(last + 1, 0, ...candidate.map((line) => line.text));
      const linked = linkedAt(scanOf(copy));
      return candidate.flatMap((line, offset) => (linked.get(last + 1 + offset) === line.taskId ? [] : [offset]));
    });
    if (accepted === null) {
      ambiguous(task, "same-title");
      return;
    }
    doc.lines.splice(last + 1, 0, ...accepted.map((line) => docLine(line.text)));
    record(accepted);
    refresh();
  };
  const visitChildren = (task: BoardTask): void => {
    if ((presence.lines.get(task.id)?.length ?? 0) === 0) return;
    for (const subtask of task.subtasks) {
      if (isPresent(presence, subtask)) {
        visitChildren(subtask);
        continue;
      }
      if (presence.unclear.has(subtask.id)) {
        ambiguous(subtask, "unclear-line");
        continue;
      }
      if (known(subtask)) continue;
      placeUnder(task, subtask);
    }
  };
  let tops: TopItem[] = [];
  for (const entry of focus) {
    const task = entry.task;
    if (isPresent(presence, task)) {
      visitChildren(task);
      continue;
    }
    if (presence.unclear.has(task.id)) {
      ambiguous(task, "unclear-line");
      continue;
    }
    if (known(task)) continue;
    const parent = parents.get(task.id) ?? null;
    if (parent !== null && (presence.lines.get(parent.id)?.length ?? 0) > 0) {
      placeUnder(parent, task);
      continue;
    }
    const subtree = task.subtasks.filter((subtask) => !skip(subtask)).flatMap((subtask) => treeLines(subtask, 1, (depth) => SUBTASK_INDENT.repeat(depth), skip));
    tops.push({ task, lines: [{ text: canonicalHead(settings, entry.project, task), taskId: task.id, depth: 0 }, ...subtree] });
  }
  while (tops.length > 0) {
    const items: ComposeFocusItem[] = tops.map((item) => ({ project: null, text: "", block: item.lines.map((line) => line.text).join("\n"), keepMark: true }));
    const rendered = renderFocusLines(items, settings.daily.wikilinks, board);
    const owners = layoutOf(rendered, tops);
    if (owners === null) {
      for (const item of tops) ambiguous(item.task, "same-title");
      break;
    }
    const texts = textsOf();
    const spot = insertionSpot(settings, texts, board, rendered[0]);
    const block = [...spot.prefix, ...rendered, ...spot.suffix];
    const copy = [...texts];
    copy.splice(spot.at, 0, ...block);
    const linked = linkedAt(scanOf(copy));
    const failing = new Set<TreeLine>();
    owners.forEach((owner, offset) => {
      if (owner !== null && linked.get(spot.at + spot.prefix.length + offset) !== owner.taskId) failing.add(owner);
    });
    if (failing.size === 0) {
      doc.lines.splice(spot.at, 0, ...block.map((text) => docLine(text)));
      for (const item of tops) record(item.lines);
      break;
    }
    tops = tops.flatMap((item) => {
      const head = item.lines[0] as TreeLine;
      if (failing.has(head)) {
        ambiguous(item.task, "same-title");
        return [];
      }
      const index = item.lines.findIndex((line) => failing.has(line));
      if (index === -1) return [item];
      ambiguous(byId.get((item.lines[index] as TreeLine).taskId) as BoardTask, "same-title");
      return [{ task: item.task, lines: withoutLine(item.lines, index) }];
    });
  }
  return result;
}

const pending = new Map<string, MirrorSource>();
const timers = new Map<string, NodeJS.Timeout>();

export function forgetTodayState(): void {
  pending.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface UserTick {
  task: BoardTask;
  targets: Set<BoardCheckbox>;
  keys: string[];
}

function runMirror(settings: DelegationSettings, date: string, options: MirrorOptions = {}): MirrorResult {
  const skip = (skipped: MirrorSkip, applied = 0): MirrorResult => ({ changed: false, skipped, applied });
  if (!settings.features.daily || !settings.features.tasks) return skip("disabled");
  if (focusSourceOf(settings) !== "scheduled") return skip("list");
  if (!isCurrentOrFuture(date)) return skip("past");
  let applied = 0;
  try {
    const daily = readDailySafe(settings, date);
    if (daily === null || !daily.exists) return skip("no-daily");
    let data = loadBoardData(settings);
    if (data === null) return skip("no-board");
    const baseline = loadBaseline(date, daily.path) ?? adoptBaseline(settings, date, daily.path, daily.content, data);
    const keys = lineKeys(splitLines(daily.content));
    const before = checkboxesByKey(splitLines(baseline.content));
    let scan = scanDaily(settings, date, daily.content, data.projects, data.tasks);
    const touched = new Set<string>();
    const ticks = new Map<string, UserTick>();
    for (const link of syncedLinksOf(scan)) {
      const key = keys[link.line];
      const old = key === undefined ? undefined : before.get(key);
      if (key === undefined || old === undefined || old === link.checkbox || !link.userSynced) continue;
      touched.add(key);
      const memo = baseline.state.marks[key];
      const projectMoved = memo !== undefined && isSameTask(memo, link.task) && link.effective !== null && link.effective !== memo.checkbox;
      if (projectMoved && link.effective !== link.checkbox) continue;
      const tick = ticks.get(link.task.id) ?? { task: link.task, targets: new Set<BoardCheckbox>(), keys: [] };
      tick.targets.add(link.checkbox);
      tick.keys.push(key);
      ticks.set(link.task.id, tick);
    }
    const retry = new Map<string, BoardCheckbox>();
    for (const tick of ticks.values()) {
      const [target] = [...tick.targets];
      const keepOld = (): void => {
        for (const key of tick.keys) retry.set(key, before.get(key) as BoardCheckbox);
      };
      if (tick.targets.size !== 1 || target === undefined) {
        keepOld();
        continue;
      }
      const status = statusFromCheckbox(tick.task.status, target);
      if (status === null) continue;
      try {
        applyStatusChange(settings, { task: tick.task, status });
        applied += 1;
      } catch (err) {
        console.error(`focus mirror could not apply a tick for ${tick.task.id}: ${errorText(err)}`);
        keepOld();
      }
    }
    if (applied > 0) {
      data = loadBoardData(settings) ?? data;
      scan = scanDaily(settings, date, daily.content, data.projects, data.tasks);
    }
    const doc = openDoc(daily.content);
    const retryLines = new Map<DocLine, { checkbox: BoardCheckbox; key: string }>();
    keys.forEach((key, index) => {
      const checkbox = retry.get(key);
      const line = doc.lines[index];
      if (checkbox !== undefined && line) retryLines.set(line, { checkbox, key });
    });
    for (const link of syncedLinksOf(scan)) {
      const key = keys[link.line];
      if (key === undefined || touched.has(key) || link.effective === null) continue;
      const old = before.get(key);
      const memo = baseline.state.marks[key];
      if (old === undefined || memo === undefined || old !== link.checkbox) continue;
      if (!isSameTask(memo, link.task) || link.effective === memo.checkbox || link.effective === link.checkbox) continue;
      const line = doc.lines[link.line];
      if (line) line.text = withCheckbox(line.text, link.effective);
    }
    const insertion = insertMissing(settings, date, doc, data, computeFocus(settings, data, date), baseline.state, options.hints ?? new Set<string>());
    const next = renderDoc(doc);
    if (!keepsEveryLine(daily.content, next)) {
      console.error(`focus mirror refused a change that would lose a line of ${date}`);
      return skip("refused", applied);
    }
    const changed = next !== daily.content;
    if (changed) writeDaily(settings, date, next, daily.updatedAt ?? undefined, `mirror-${randomUUID().slice(0, 8)}`, "server");
    const finalScan = scanDaily(settings, date, next, data.projects, data.tasks);
    const marks = memoMarks(next, finalScan);
    const finalKeys = lineKeys(splitLines(next));
    const baseDoc: ParsedDoc = {
      ...doc,
      lines: doc.lines.map((line, index) => {
        const retried = retryLines.get(line);
        if (retried === undefined) return { text: line.text, eol: line.eol };
        const oldMemo = baseline.state.marks[retried.key];
        const finalKey = finalKeys[index] as string;
        if (oldMemo) marks[finalKey] = oldMemo;
        else delete marks[finalKey];
        return { text: withCheckbox(line.text, retried.checkbox), eol: line.eol };
      }),
    };
    storeBaseline(date, daily.path, {
      content: renderDoc(baseDoc),
      state: {
        marks,
        seen: mergeSeen(baseline.state.seen, [...linkedTasks(finalScan), ...insertion.inserted, ...insertion.renamed]),
        focus: focusMemory(computeFocus(settings, data, date)),
      },
    });
    return { changed, skipped: null, applied };
  } catch (err) {
    if (err instanceof DailyConflictError) return skip("conflict", applied);
    console.error(`focus mirror failed for ${date}: ${errorText(err)}`);
    return skip("failed", applied);
  }
}

function delayFor(source: MirrorSource): number {
  return source === "disk" ? DISK_DELAY_MS : source === "client" ? CLIENT_DELAY_MS : BOARD_DELAY_MS;
}

function scheduleMirror(date: string, source: MirrorSource): void {
  if (!isCurrentOrFuture(date)) return;
  pending.set(date, source);
  const existing = timers.get(date);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(date);
    const queued = pending.get(date);
    pending.delete(date);
    if (queued !== undefined) runMirror(getSettings(), date, { source: queued });
  }, delayFor(source));
  timer.unref();
  timers.set(date, timer);
}

export function flushMirrors(settings: DelegationSettings = getSettings()): boolean {
  let changed = false;
  for (const [date, source] of [...pending]) {
    const timer = timers.get(date);
    if (timer) clearTimeout(timer);
    timers.delete(date);
    pending.delete(date);
    if (runMirror(settings, date, { source }).changed) changed = true;
  }
  return changed;
}

function scheduledDatesIn(text: string): string[] {
  return [...new Set([...text.matchAll(SCHEDULED_DATE_RE)].map((match) => match[1] as string))];
}

function queueScheduledDates(...texts: string[]): void {
  if (!isScheduledMode(getSettings())) return;
  const dates = new Set(texts.flatMap((text) => scheduledDatesIn(text)));
  dates.add(localDate());
  for (const date of dates) scheduleMirror(date, "board");
}

export function queueDailyDiskChange(date: string): void {
  if (isScheduledMode(getSettings())) scheduleMirror(date, "disk");
}

function transferHubMarks(date: string, path: string, previous: string, content: string): void {
  const baseline = loadBaseline(date, path);
  if (!baseline) return;
  const before = checkboxesByKey(splitLines(previous));
  const moved = new Map<string, BoardCheckbox>();
  for (const [key, checkbox] of checkboxesByKey(splitLines(content))) {
    const old = before.get(key);
    if (old !== undefined && old !== checkbox) moved.set(key, checkbox);
  }
  if (moved.size === 0) return;
  const doc = openDoc(baseline.content);
  const marks = { ...baseline.state.marks };
  let touched = false;
  lineKeys(splitLines(baseline.content)).forEach((key, index) => {
    const checkbox = moved.get(key);
    const line = doc.lines[index];
    if (checkbox === undefined || !line) return;
    line.text = withCheckbox(line.text, checkbox);
    delete marks[key];
    touched = true;
  });
  if (touched) storeBaseline(date, path, { content: renderDoc(doc), state: { ...baseline.state, marks } });
}

function onDailyWritten(settings: DelegationSettings, date: string, content: string, origin: DailyWriteOrigin, previous: string | null): void {
  if (!isScheduledMode(settings) || !isCurrentOrFuture(date)) return;
  if (origin === "client") {
    scheduleMirror(date, "client");
    return;
  }
  const path = dailyFile(settings, date);
  if (path === null) return;
  if (previous !== null) {
    transferHubMarks(date, path, previous, content);
    return;
  }
  const data = loadBoardData(settings);
  if (data !== null) adoptBaseline(settings, date, path, content, data);
}

function isExactTitle(settings: DelegationSettings, text: string, task: BoardTask): boolean {
  const needle = taskNeedle(text, settings.tasks);
  return needle === normalizeText(task.title) || needle === normalizeText(joinReason(task.title, task.reason, settings.tasks.reasonSeparator));
}

function onDailyComposed(settings: DelegationSettings, date: string, content: string, heads: string[]): void {
  if (!isScheduledMode(settings) || !isCurrentOrFuture(date)) return;
  const path = dailyFile(settings, date);
  const data = loadBoardData(settings);
  if (path === null || data === null) return;
  adoptBaseline(settings, date, path, content, data);
  const scan = scanDaily(settings, date, content, data.projects, data.tasks);
  const counts = new Map<string, number>();
  for (const task of linkedTasks(scan)) counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
  const wanted = new Set(heads);
  const hints = new Set<string>();
  for (const entry of scan.entries) {
    const task = entry.match.task;
    if (task === null || entry.held || entry.projectId === null || !wanted.has(entry.raw)) continue;
    if (!isOpenTask(task) || counts.get(task.id) !== 1 || !isExactTitle(settings, entry.text, task)) continue;
    hints.add(task.id);
    if (task.scheduled === date) continue;
    try {
      writeBoardTask(settings, { projectId: task.projectId, line: task.line, raw: task.raw, scheduled: date });
    } catch (err) {
      console.error(`could not schedule the picked task ${task.id}: ${errorText(err)}`);
    }
  }
  runMirror(settings, date, { source: "api", hints });
}

export function installTodayHooks(): void {
  setDailyHooks({
    written: onDailyWritten,
    diskChanged: queueDailyDiskChange,
    composed: onDailyComposed,
  });
  setBoardHooks({
    committed: (previous: string, next: string) => queueScheduledDates(previous, next),
    diskChanged: (content: string) => queueScheduledDates(content),
    taskWritten: (settings: DelegationSettings) => isScheduledMode(settings) && flushMirrors(settings),
  });
}

export function removeTodayHooks(): void {
  setDailyHooks({});
  setBoardHooks({});
}

function dailySections(lines: string[], heading: string): { heading: number; end: number } | null {
  const index = findHeadingIndex(lines, heading);
  if (index === -1) return null;
  for (let at = index + 1; at < lines.length; at += 1) if (SECTION_RE.test(lines[at] as string)) return { heading: index, end: at };
  return { heading: index, end: lines.length };
}

function capturesHeading(settings: DelegationSettings): string {
  const configured = settings.daily.headings.captures?.trim();
  if (configured) return configured;
  for (const line of dailyTemplateText(settings).split(LINE_SPLIT_RE)) {
    const match = line.match(/^##\s+(.*)$/);
    if (match && /^captur/i.test((match[1] as string).trim())) return (match[1] as string).trim();
  }
  return "Captures";
}

function bulletsOf(lines: string[], range: { heading: number; end: number } | null): { line: number; raw: string; text: string }[] {
  if (!range) return [];
  const out: { line: number; raw: string; text: string }[] = [];
  for (let index = range.heading + 1; index < range.end; index += 1) {
    const raw = lines[index] as string;
    const match = raw.match(BULLET_RE);
    const text = match ? (match[1] as string).trim() : "";
    if (text === "" || text === "[ ]") continue;
    out.push({ line: index, raw, text });
  }
  return out;
}

function capturesOf(settings: DelegationSettings, lines: string[]): TodayCapture[] {
  return bulletsOf(lines, dailySections(lines, capturesHeading(settings))).map((item) => {
    const promoted = item.text.match(PROMOTED_RE);
    const target = promoted ? ((promoted[1] as string).split("|")[0] as string).trim() : null;
    return { line: item.line, raw: item.raw, text: promoted ? item.text.replace(PROMOTED_RE, "").trim() : item.text, promotedTo: target === "" ? null : target };
  });
}

function meetingsOf(settings: DelegationSettings, lines: string[]): string[] {
  return bulletsOf(lines, dailySections(lines, settings.daily.headings.meetings)).map((item) => item.text);
}

function summaryOf(lines: string[]): string | null {
  let start = 0;
  if ((lines[0] ?? "").replace(/^\uFEFF/, "").trim() === "---") {
    const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (close !== -1) start = close + 1;
  }
  const firstSection = lines.findIndex((line, index) => index >= start && SECTION_RE.test(line));
  const limit = firstSection === -1 ? lines.length : firstSection;
  const quoted: string[] = [];
  let gap = false;
  for (let index = start; index < limit; index += 1) {
    const line = lines[index] as string;
    if (BQUOTE_RE.test(line)) {
      if (gap && quoted.length > 0) quoted.push("");
      gap = false;
      quoted.push(line.replace(BQUOTE_RE, ""));
    } else if (quoted.length > 0) {
      gap = true;
    }
  }
  const text = quoted.join("\n").trim();
  return text === "" ? null : text;
}

function parentMap(tasks: BoardTask[]): Map<string, BoardTask | null> {
  const map = new Map<string, BoardTask | null>();
  const visit = (task: BoardTask, parent: BoardTask | null): void => {
    map.set(task.id, parent);
    for (const subtask of task.subtasks) visit(subtask, task);
  };
  for (const task of tasks) visit(task, null);
  return map;
}

function listModeFocus(settings: DelegationSettings, date: string, daily: DailyReadResult, data: BoardData): TodayEntry[] {
  const projects = new Map(data.projects.map((project) => [project.id, project]));
  const parents = parentMap(data.tasks);
  const seen = new Set<string>();
  const out: TodayEntry[] = [];
  for (const entry of scanDaily(settings, date, daily.content, data.projects, data.tasks).entries) {
    const task = entry.match.task;
    const project = task ? projects.get(task.projectId) : undefined;
    if (!task || !project || seen.has(task.id)) continue;
    seen.add(task.id);
    out.push({ task, project: { id: project.id, title: project.title, name: project.name }, parentTitle: parents.get(task.id)?.title ?? null });
  }
  return out;
}

interface NoteView {
  inNote: string[];
  unlinked: string[];
  ambiguous: TodayAmbiguous[];
}

function noteView(settings: DelegationSettings, date: string, daily: DailyReadResult, data: BoardData, focus: TodayEntry[], scheduled: boolean): NoteView {
  const content = daily.content;
  const texts = splitLines(content);
  const scan = scanDaily(settings, date, content, data.projects, data.tasks);
  const ambiguous: TodayAmbiguous[] = scan.entries
    .filter((entry) => entry.match.task === null && entry.match.candidates.length >= 2)
    .map((entry): TodayAmbiguous => ({ kind: "line", text: entry.raw, line: entry.line, taskId: null, reason: "several-tasks" }));
  if (scheduled && isCurrentOrFuture(date)) {
    const memory: InsertMemory = loadBaseline(date, daily.path)?.state ?? { seen: mergeSeen([], linkedTasks(scan)), focus: focusMemory(focus) };
    ambiguous.push(...insertMissing(settings, date, openDoc(content), data, focus, memory, new Set<string>()).ambiguous);
  }
  const range = focusRange(texts, settings);
  if (!range) return { inNote: [], unlinked: [], ambiguous };
  const focusIds = new Set(focus.flatMap((entry) => flattenTasks([entry.task]).map((task) => task.id)));
  const occurrences = new Set(focus.filter((entry) => isOccurrence(entry.task)).map((entry) => fingerprint(entry.task)));
  const entries = new Map(scan.entries.map((entry) => [entry.line, entry]));
  const inNote: string[] = [];
  const unlinked: string[] = [];
  let index = range.heading + 1;
  while (index < range.end) {
    if (isBlankText(texts[index])) {
      index += 1;
      continue;
    }
    const length = Math.max(1, taskBlock(content, index).split(LINE_SPLIT_RE).length);
    const end = Math.min(index + length, range.end);
    const entry = entries.get(index);
    const task = entry?.match.task ?? null;
    const focused = task !== null && (focusIds.has(task.id) || (entry?.recurred === true && occurrences.has(fingerprint(task))));
    if (!focused) {
      const lines = texts.slice(index, end).filter((text) => !isBlankText(text) && !isPlaceholderLine(text));
      inNote.push(...lines);
      if (task === null) unlinked.push(...lines);
    }
    index = end;
  }
  return { inNote, unlinked, ambiguous };
}

function validateDate(date: string): void {
  if (!isValidDailyDate(date)) throw new BadRequestError("date must be YYYY-MM-DD");
}

function requireDailyFeature(settings: DelegationSettings): void {
  if (!settings.features.daily) throw new BadRequestError("the daily feature is disabled");
}

function validateLine(text: unknown): string {
  if (typeof text !== "string" || text.trim() === "" || /[\r\n]/.test(text)) throw new BadRequestError("text must be a single non-empty line");
  if (text.length > CAPTURE_MAX) throw new BadRequestError(`text must have at most ${CAPTURE_MAX} characters`);
  return text.trim();
}

function initialContent(settings: DelegationSettings, date: string): string {
  const content = renderTemplate(dailyTemplateText(settings), date);
  if (!isScheduledMode(settings) || !isCurrentOrFuture(date)) return content;
  const data = loadBoardData(settings);
  const focus = computeFocus(settings, data, date);
  if (data === null || focus.length === 0) return content;
  const doc = openDoc(content);
  const range = focusRange(
    doc.lines.map((line) => line.text),
    settings,
  );
  if (range) {
    const filled: number[] = [];
    for (let index = range.heading + 1; index < range.end; index += 1) if (!isBlankText((doc.lines[index] as DocLine).text)) filled.push(index);
    if (filled.length > 0 && filled.every((index) => isPlaceholderLine((doc.lines[index] as DocLine).text))) {
      for (const index of [...filled].reverse()) doc.lines.splice(index, 1);
    }
  }
  insertMissing(settings, date, doc, data, focus, { seen: [], focus: [] }, new Set<string>());
  return renderDoc(doc);
}

function createDailyFile(settings: DelegationSettings, date: string): DailyReadResult {
  const daily = readDaily(settings, date);
  if (daily.exists) return daily;
  writeDaily(settings, date, initialContent(settings, date), undefined, `create-${randomUUID().slice(0, 8)}`, "server");
  return readDaily(settings, date);
}

function migratedKey(date: string): string {
  return `${MIGRATED_KEY}${date}`;
}

function createToday(settings: DelegationSettings, date: string): { dailyExists: true } {
  requireDailyFeature(settings);
  validateDate(date);
  const daily = readDaily(settings, date);
  if (!daily.exists) createDailyFile(settings, date);
  if (isScheduledMode(settings) && isCurrentOrFuture(date)) {
    runMirror(settings, date, { source: "api" });
    if (date === localDate()) setSetting(migratedKey(date), "1");
  }
  return { dailyExists: true };
}

function appendBullet(settings: DelegationSettings, date: string, heading: string, text: string): string[] {
  const daily = createDailyFile(settings, date);
  const doc = openDoc(daily.content);
  const texts = doc.lines.map((line) => line.text);
  const line = docLine(`- ${text}`);
  const range = dailySections(texts, heading);
  if (!range) {
    let last = texts.length - 1;
    while (last >= 0 && isBlankText(texts[last])) last -= 1;
    doc.lines.splice(last + 1, 0, ...(last >= 0 ? [docLine("")] : []), docLine(`## ${heading}`), line);
  } else {
    const content: number[] = [];
    for (let index = range.heading + 1; index < range.end; index += 1) if (!isBlankText(texts[index])) content.push(index);
    if (content.length > 0 && content.every((index) => isPlaceholderLine(texts[index] as string))) {
      const first = content[0] as number;
      const last = content[content.length - 1] as number;
      doc.lines.splice(first, last - first + 1, line);
    } else if (content.length > 0) {
      doc.lines.splice((content[content.length - 1] as number) + 1, 0, line);
    } else {
      doc.lines.splice(range.heading + 1, 0, line);
    }
  }
  writeDaily(settings, date, renderDoc(doc), daily.updatedAt ?? undefined, `append-${randomUUID().slice(0, 8)}`, "server");
  return doc.lines.map((entry) => entry.text);
}

function appendCapture(settings: DelegationSettings, date: string, text: string): TodayCapture[] {
  requireDailyFeature(settings);
  validateDate(date);
  const lines = appendBullet(settings, date, capturesHeading(settings), validateLine(text));
  return capturesOf(settings, lines);
}

function appendMeeting(settings: DelegationSettings, date: string, text: string): string[] {
  requireDailyFeature(settings);
  validateDate(date);
  const lines = appendBullet(settings, date, settings.daily.headings.meetings, validateLine(text));
  return meetingsOf(settings, lines);
}

function promoteCapture(settings: DelegationSettings, date: string, input: PromoteInput): { task: BoardTask } {
  requireDailyFeature(settings);
  validateDate(date);
  if (!Number.isInteger(input.line) || input.line < 0) throw new BadRequestError("line must be a non-negative integer");
  if (typeof input.raw !== "string") throw new BadRequestError("raw required");
  if (typeof input.projectId !== "string" || input.projectId === "") throw new BadRequestError("projectId required");
  const daily = readDaily(settings, date);
  if (!daily.exists) throw new NotFoundError("daily not found");
  const lines = daily.content.split(LINE_SPLIT_RE);
  const range = dailySections(lines, capturesHeading(settings));
  if (!range || input.line <= range.heading || input.line >= range.end) throw new BadRequestError("line is not inside the captures section");
  if (lines[input.line] !== input.raw) throw new StaleCaptureError();
  const bullet = input.raw.match(BULLET_RE);
  const text = bullet ? (bullet[1] as string).trim() : "";
  if (text === "") throw new BadRequestError("the line is not a capture");
  if (PROMOTED_RE.test(text)) throw new BadRequestError("the capture was already promoted");
  const data = loadBoardData(settings);
  const project = data?.projects.find((candidate) => candidate.id === input.projectId);
  if (!project) throw new NotFoundError("project not found");
  const created = createBoardTask(settings, {
    projectId: input.projectId,
    title: text.replace(LEADING_CHECKBOX_RE, ""),
    status: "todo",
    ...(input.schedule === true ? { scheduled: date } : {}),
  });
  const fresh = readDaily(settings, date);
  const doc = openDoc(fresh.content);
  const target = doc.lines[input.line];
  if (!target || target.text !== input.raw) throw new StaleCaptureError();
  target.text = `${input.raw} ${PROMOTE_ARROW} [[${project.name}]]`;
  writeDaily(settings, date, renderDoc(doc), fresh.updatedAt ?? undefined, `promote-${randomUUID().slice(0, 8)}`, "server");
  if (input.schedule === true) runMirror(settings, date, { source: "api", hints: new Set([created.task.id]) });
  return { task: created.task };
}

function schedule(settings: DelegationSettings, input: ScheduleInput): { task: BoardTask } {
  if (input.date !== null) validateDate(input.date);
  const before = loadBoardData(settings);
  const old = before ? flattenTasks(before.tasks).find((task) => task.projectId === input.projectId && task.line === input.line) : undefined;
  const result = writeBoardTask(settings, { projectId: input.projectId, line: input.line, raw: input.raw, scheduled: input.date });
  const hints = new Set(input.date === null ? [] : [result.task.id]);
  const dates = new Set([old?.scheduled ?? null, input.date].filter((date): date is string => date !== null && isCurrentOrFuture(date)));
  for (const date of dates) runMirror(settings, date, { source: "api", hints: date === input.date ? hints : new Set<string>() });
  return { task: result.task };
}

function migrateFocus(settings: DelegationSettings, date: string): MigrationResult {
  requireDailyFeature(settings);
  validateDate(date);
  if (!isCurrentOrFuture(date)) throw new BadRequestError("past dailies are never migrated");
  const daily = readDaily(settings, date);
  if (!daily.exists) throw new NotFoundError("create the daily first");
  const data = loadBoardData(settings);
  if (data === null) throw new BadRequestError("the tasks board is not available");
  if (loadBaseline(date, daily.path) === null) adoptBaseline(settings, date, daily.path, daily.content, data);
  const result: MigrationResult = { scheduled: 0, synced: 0, skipped: [], failed: [], ambiguous: [] };
  const linked = new Map<string, BoardTask>();
  for (const entry of scanDaily(settings, date, daily.content, data.projects, data.tasks).entries) {
    const task = entry.match.task;
    if (task !== null) {
      if (!entry.held) linked.set(task.id, task);
    } else if (entry.match.candidates.length >= 2) {
      result.ambiguous.push({ kind: "line", text: entry.raw, line: entry.line, taskId: null, reason: "several-tasks" });
    }
  }
  for (const task of linked.values()) {
    if (task.scheduled === date) continue;
    const skipped = (reason: MigrationSkip["reason"]): void => {
      result.skipped.push({ taskId: task.id, title: task.title, scheduled: task.scheduled, reason });
    };
    if (task.scheduled !== null) skipped("scheduled-elsewhere");
    else if (task.status === "archived") skipped("archived");
    else if (task.status === "done" && task.doneAt !== null && task.doneAt !== date) skipped("finished-earlier");
    else {
      try {
        writeBoardTask(settings, { projectId: task.projectId, line: task.line, raw: task.raw, scheduled: date });
        result.scheduled += 1;
      } catch (err) {
        result.failed.push({ taskId: task.id, error: errorText(err) });
      }
    }
  }
  setSetting(migratedKey(date), "1");
  runMirror(settings, date, { source: "migrate" });
  return result;
}

function regenerateFocusMirror(settings: DelegationSettings, date: string, options?: MirrorOptions): MirrorResult {
  validateDate(date);
  return runMirror(settings, date, options);
}

export function readToday(settings: DelegationSettings, date: string): TodayPayload {
  validateDate(date);
  const focusSource = focusSourceOf(settings);
  let daily = readDailySafe(settings, date);
  if (
    focusSource === "scheduled" &&
    settings.features.daily &&
    settings.features.tasks &&
    date === localDate() &&
    daily?.exists === true &&
    getSetting(migratedKey(date)) === null
  ) {
    try {
      migrateFocus(settings, date);
    } catch (err) {
      console.error(`focus migration failed for ${date}: ${errorText(err)}`);
    }
    daily = readDailySafe(settings, date);
  }
  const data = loadBoardData(settings);
  const exists = daily?.exists === true;
  const content = exists ? (daily as DailyReadResult).content : "";
  const lines = exists ? content.split(LINE_SPLIT_RE) : [];
  const scheduledFocus = focusSource === "scheduled";
  const focus = scheduledFocus ? computeFocus(settings, data, date) : exists && data ? listModeFocus(settings, date, daily as DailyReadResult, data) : [];
  const view: NoteView = exists && data ? noteView(settings, date, daily as DailyReadResult, data, focus, scheduledFocus) : { inNote: [], unlinked: [], ambiguous: [] };
  return {
    date,
    focusSource,
    focus,
    carriedOver: scheduledFocus ? computeCarried(settings, data, date) : [],
    meetings: meetingsOf(settings, lines),
    captures: capturesOf(settings, lines),
    unlinked: view.unlinked,
    inNote: view.inNote,
    ambiguous: view.ambiguous,
    summary: summaryOf(lines),
    dailyExists: exists,
    dailyUpdatedAt: exists ? ((daily as DailyReadResult).updatedAt ?? null) : null,
  };
}

export const todayApi: TodayApi = {
  focusOf: (settings, date) => computeFocus(settings, loadBoardData(settings), date),
  carriedOver: (settings, date) => computeCarried(settings, loadBoardData(settings), date),
  schedule,
  regenerateFocusMirror,
  migrateFocus,
  appendCapture,
  promoteCapture,
  appendMeeting,
  createToday,
};
