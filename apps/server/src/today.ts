import { randomUUID } from "node:crypto";
import {
  DailyConflictError,
  dailyFile,
  dailyTemplateText,
  findHeadingIndex,
  isPlaceholderLine,
  isValidDailyDate,
  organizeDailyFocus,
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
  type DailyWriteResult,
  type OrganizeDailyFocusResult,
} from "./daily.js";
import { BadRequestError, NotFoundError } from "./delegation-launch.js";
import { getSetting, getSettings, getTodayBaseline, saveTodayBaseline, setSetting } from "./delegation-store.js";
import type { DelegationSettings, FocusSource } from "./delegation-types.js";
import { localDate } from "./second-brain.js";
import {
  addTaskToDaily,
  applyStatusChange,
  BOARD_STATUSES,
  checkboxForStatus,
  collectBoard,
  composeBoardFrom,
  createBoardTask,
  dailySyncBaseline,
  docLine,
  effectiveProjectOrder,
  flattenTasks,
  focusRange,
  joinReason,
  matchText,
  mirrorsFocus,
  normalizeText,
  openDoc,
  renderDoc,
  requireBoardRoot,
  scanDaily,
  setBoardHooks,
  statusFromCheckbox,
  syncTaskFromDaily,
  syncTasksFromDaily,
  syncTaskToDaily,
  taskNeedle,
  TaskConflictError,
  writeBoardTask,
  type AddToDailyInput,
  type AddToDailyResult,
  type BoardCheckbox,
  type BoardProject,
  type BoardStatus,
  type BoardTask,
  type DocLine,
  type FocusScan,
  type ParsedDoc,
  type SyncDailyInput,
  type SyncDailyResult,
  type SyncFromDailyInput,
  type SyncFromDailyResult,
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

export type AmbiguityReason = "same-title" | "unclear-line" | "several-lines" | "several-tasks" | "duplicate-line";

export type OutOfSyncReason = "recurring-done";

export interface TodayOutOfSync {
  line: string;
  taskTitle: string;
  projectId: string;
  dailyCheckbox: BoardCheckbox;
  projectStatus: BoardStatus;
  reason?: OutOfSyncReason;
}

export interface TodayAmbiguous {
  kind: "task" | "line";
  text: string;
  line: number | null;
  taskId: string | null;
  reason: AmbiguityReason;
}

export interface TodayUnmatchedCandidate {
  projectId: string;
  line: number;
  raw: string;
  title: string;
}

export interface TodayUnmatched {
  line: string;
  lineIndex: number;
  section: string;
  checkbox: BoardCheckbox;
  candidates: TodayUnmatchedCandidate[];
}

export type LinkTickAction = "apply" | "dismiss";

export interface LinkTickTarget {
  projectId: string;
  line: number;
  raw: string;
}

export interface LinkTickInput {
  lineIndex: number;
  raw: string;
  target: LinkTickTarget | null;
  action: LinkTickAction;
}

export interface LinkTickResult {
  task: BoardTask | null;
  unmatched: TodayUnmatched[];
}

export interface TodayNoteLine {
  line: string;
  taskId: string | null;
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
  inNoteLinks: TodayNoteLine[];
  ambiguous: TodayAmbiguous[];
  outOfSync?: TodayOutOfSync[];
  unmatched?: TodayUnmatched[];
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
  linkTick(settings: DelegationSettings, date: string, input: LinkTickInput): LinkTickResult;
}

export class StaleCaptureError extends Error {
  constructor() {
    super("the capture changed on disk");
  }
}

export class StaleTodayLineError extends Error {
  constructor() {
    super("the daily line changed on disk");
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
const WORD_RE = /[\p{L}\p{N}]{3,}/gu;
const WIKILINK_RE = /\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
const LEAD_WIKILINK_RE = /^\[\[[^\]]*\]\]\s*(?:-\s+)?/;
const HEADING_RE = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const TITLE_HINT_MIN = 12;
const CANDIDATE_LIMIT = 3;
const SIMILAR_MIN = 0.6;
const CANDIDATE_MIN = 0.5;
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
  return mirrorsFocus(settings);
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

const identityText = (text: string): string => unmarkedText(text).trim();

function lineKeys(texts: string[]): string[] {
  const counts = new Map<string, number>();
  return texts.map((text) => {
    const base = unmarkedText(text);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return `${base}${KEY_SEPARATOR}${seen}`;
  });
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
  title?: string;
  line?: number;
  parent?: string;
  index?: number;
  loose?: boolean;
  pinned?: boolean;
}

interface SeenTask {
  projectId: string;
  title: string;
}

interface StoredOutOfSync {
  line: string;
  task: string;
  checkbox: BoardCheckbox;
  title?: string;
  status?: BoardStatus;
  reason?: OutOfSyncReason;
}

interface StoredDuplicate {
  text: string;
  lines: string[];
}

interface StoredUnmatched {
  line: string;
  index: number;
  checkbox: BoardCheckbox;
  hint: string | null;
}

interface BaselineState {
  marks: Record<string, MarkMemo>;
  seen: SeenTask[];
  focus: SeenTask[];
  outOfSync: StoredOutOfSync[];
  duplicates: StoredDuplicate[];
  known: string[];
  unresolved: string[];
  unmatched: StoredUnmatched[];
  dismissed: string[];
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

function isStatus(value: unknown): value is BoardStatus {
  return typeof value === "string" && (BOARD_STATUSES as readonly string[]).includes(value);
}

function memoExtras(memo: Record<string, unknown>): Partial<MarkMemo> {
  return {
    ...(typeof memo.title === "string" ? { title: memo.title } : {}),
    ...(typeof memo.line === "number" ? { line: memo.line } : {}),
    ...(typeof memo.parent === "string" ? { parent: memo.parent } : {}),
    ...(typeof memo.index === "number" ? { index: memo.index } : {}),
    ...(memo.loose === true ? { loose: true } : {}),
    ...(memo.pinned === true ? { pinned: true } : {}),
  };
}

function parseStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item: unknown): item is string => typeof item === "string") : [];
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
        marks[key] = { checkbox: memo.checkbox, task: memo.task, id: memo.id, ...memoExtras(memo) };
      }
    }
  }
  return {
    marks,
    seen: parseSeen(value.seen),
    focus: parseSeen(value.focus),
    outOfSync: parseOutOfSync(value.outOfSync),
    duplicates: parseDuplicates(value.duplicates),
    known: parseStrings(value.known),
    unresolved: parseStrings(value.unresolved),
    unmatched: parseUnmatched(value.unmatched),
    dismissed: parseStrings(value.dismissed),
  };
}

function parseUnmatched(value: unknown): StoredUnmatched[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) =>
    isRecord(item) && typeof item.line === "string" && typeof item.index === "number" && isCheckbox(item.checkbox)
      ? [
          {
            line: item.line,
            index: item.index,
            checkbox: item.checkbox,
            hint: typeof item.hint === "string" ? item.hint : null,
          },
        ]
      : [],
  );
}

function parseOutOfSync(value: unknown): StoredOutOfSync[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) =>
    isRecord(item) && typeof item.line === "string" && typeof item.task === "string" && isCheckbox(item.checkbox)
      ? [
          {
            line: item.line,
            task: item.task,
            checkbox: item.checkbox,
            ...(typeof item.title === "string" ? { title: item.title } : {}),
            ...(isStatus(item.status) ? { status: item.status } : {}),
            ...(item.reason === "recurring-done" ? { reason: item.reason } : {}),
          },
        ]
      : [],
  );
}

function parseDuplicates(value: unknown): StoredDuplicate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) =>
    isRecord(item) && typeof item.text === "string" && Array.isArray(item.lines) && item.lines.every((line: unknown) => typeof line === "string")
      ? [{ text: item.text, lines: item.lines as string[] }]
      : [],
  );
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

const isSameTask = (memo: MarkMemo, task: BoardTask): boolean => memo.task === fingerprint(task) || memo.id === task.id;

interface Lineage {
  parents: Map<string, BoardTask | null>;
  siblings: Map<string, number>;
}

function lineageOf(data: BoardData): Lineage {
  const siblings = new Map<string, number>();
  const tops = new Map<string, number>();
  const visit = (task: BoardTask, index: number): void => {
    siblings.set(task.id, index);
    task.subtasks.forEach((subtask, at) => visit(subtask, at));
  };
  for (const task of data.tasks) {
    const index = tops.get(task.projectId) ?? 0;
    tops.set(task.projectId, index + 1);
    visit(task, index);
  }
  return { parents: parentMap(data.tasks), siblings };
}

function parentPrint(task: BoardTask, lineage: Lineage): string {
  const parent = lineage.parents.get(task.id) ?? null;
  return parent === null ? "" : fingerprint(parent);
}

function memoFor(task: BoardTask, checkbox: BoardCheckbox, lineage: Lineage, loose = false): MarkMemo {
  return {
    checkbox,
    task: fingerprint(task),
    id: task.id,
    title: task.title,
    line: task.line,
    parent: parentPrint(task, lineage),
    index: lineage.siblings.get(task.id) ?? 0,
    ...(loose ? { loose: true } : {}),
  };
}

function inScope(task: BoardTask, date: string, lineage: Lineage): boolean {
  for (let current: BoardTask | null = task; current !== null; current = lineage.parents.get(current.id) ?? null) {
    if (current.scheduled === date || inFocus(current, date)) return true;
  }
  return false;
}

const projectOfPrint = (print: string): string => print.split(KEY_SEPARATOR)[0] as string;

function knownPrints(data: BoardData, marks: Record<string, MarkMemo>): string[] {
  const projects = new Set(Object.values(marks).map((memo) => projectOfPrint(memo.task)));
  return [...new Set(flattenTasks(data.tasks).filter((task) => projects.has(task.projectId)).map(fingerprint))];
}

function memoMarks(content: string, scan: FocusScan, date: string, lineage: Lineage): Record<string, MarkMemo> {
  const keys = lineKeys(splitLines(content));
  const marks: Record<string, MarkMemo> = {};
  for (const link of linkedLinesOf(scan)) {
    const key = keys[link.line];
    if (key === undefined || link.effective === null || !inScope(link.task, date, lineage)) continue;
    marks[key] = memoFor(link.task, link.effective, lineage);
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
  const marks = memoMarks(content, scan, date, lineageOf(data));
  const state: BaselineState = {
    marks,
    seen: mergeSeen([], linkedTasks(scan)),
    focus: focusMemory(computeFocus(settings, data, date)),
    outOfSync: [],
    duplicates: [],
    known: knownPrints(data, marks),
    unresolved: [],
    unmatched: [],
    dismissed: [],
  };
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

function commonPairs(before: string[], after: string[]): [number, number][] {
  const width = after.length + 1;
  const table = new Int32Array((before.length + 1) * width);
  const at = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

const restOf = (text: string): string => (text.match(FOCUS_LINE_RE)?.[1] ?? "").trim();

function continues(before: string, after: string): boolean {
  if (restOf(before) === "" || restOf(after) === "") return false;
  const a = unmarkedText(before);
  const b = unmarkedText(after);
  return a !== b && (b.startsWith(a) || a.startsWith(b));
}

function pairGap(before: string[], after: string[], gapBefore: number[], gapAfter: number[], pairs: Map<number, number>): void {
  const boxedBefore = gapBefore.filter((index) => checkboxOfLine(before[index] as string) !== null);
  const boxedAfter = gapAfter.filter((index) => checkboxOfLine(after[index] as string) !== null);
  const used = new Set<number>();
  let from = 0;
  for (const index of boxedBefore) {
    for (let k = from; k < boxedAfter.length; k += 1) {
      const candidate = boxedAfter[k] as number;
      if (!continues(before[index] as string, after[candidate] as string)) continue;
      pairs.set(candidate, index);
      used.add(index);
      used.add(-1 - candidate);
      from = k + 1;
      break;
    }
  }
  const restBefore = boxedBefore.filter((index) => !used.has(index));
  const restAfter = boxedAfter.filter((index) => !used.has(-1 - index));
  if (restBefore.length !== restAfter.length) return;
  restBefore.forEach((index, k) => {
    const candidate = restAfter[k] as number;
    if (leadOf(before[index] as string) === leadOf(after[candidate] as string)) pairs.set(candidate, index);
  });
}

const isMovable = (text: string): boolean => checkboxOfLine(text) !== null && restOf(text) !== "";

function groupMovable(texts: string[], indexes: Iterable<number>): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const index of indexes) {
    const text = texts[index] as string;
    if (!isMovable(text)) continue;
    const key = identityText(text);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  }
  return groups;
}

function movedCandidates(before: string[], after: string[], freeBefore: number[], freeAfter: number[]): Set<number> {
  const was = groupMovable(before, freeBefore);
  const now = groupMovable(after, freeAfter);
  const held = new Set<number>();
  for (const [key, lines] of now) {
    const bases = was.get(key);
    if (bases === undefined) continue;
    for (const index of bases) held.add(index);
    for (const index of lines) held.add(-1 - index);
  }
  return held;
}

function alignLines(before: string[], after: string[], holdMoves = false): Map<number, number> {
  const a = before.map(unmarkedText);
  const b = after.map(unmarkedText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const pairs = new Map<number, number>();
  for (let index = 0; index < head; index += 1) pairs.set(index, index);
  for (let k = 0; k < tail; k += 1) pairs.set(b.length - 1 - k, a.length - 1 - k);
  const endA = a.length - tail;
  const endB = b.length - tail;
  const anchors = commonPairs(a.slice(head, endA), b.slice(head, endB)).map(([i, j]): [number, number] => [i + head, j + head]);
  const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from) }, (_unused, k) => from + k);
  const anchoredA = new Set(anchors.map(([i]) => i));
  const anchoredB = new Set(anchors.map(([, j]) => j));
  const held = holdMoves
    ? movedCandidates(
        before,
        after,
        range(head, endA).filter((index) => !anchoredA.has(index)),
        range(head, endB).filter((index) => !anchoredB.has(index)),
      )
    : new Set<number>();
  let previousA = head - 1;
  let previousB = head - 1;
  for (const [i, j] of [...anchors, [endA, endB] as [number, number]]) {
    pairGap(
      before,
      after,
      range(previousA + 1, i).filter((index) => !held.has(index)),
      range(previousB + 1, j).filter((index) => !held.has(-1 - index)),
      pairs,
    );
    if (i < endA) pairs.set(j, i);
    previousA = i;
    previousB = j;
  }
  return pairs;
}

function checkboxLineCounts(texts: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const text of texts) {
    if (checkboxOfLine(text) === null) continue;
    const base = unmarkedText(text);
    out.set(base, [...(out.get(base) ?? []), text]);
  }
  return out;
}

function changedCopies(before: string[], after: string[]): Set<string> {
  const was = checkboxLineCounts(before);
  const now = checkboxLineCounts(after);
  const out = new Set<string>();
  for (const [base, lines] of now) {
    const count = was.get(base)?.length ?? 0;
    if (count >= 1 && count !== lines.length && Math.max(count, lines.length) >= 2) out.add(base);
  }
  return out;
}

type PrintIndex = Map<string, BoardTask | null>;

function printIndex(data: BoardData): PrintIndex {
  const map: PrintIndex = new Map();
  for (const task of flattenTasks(data.tasks)) {
    const key = fingerprint(task);
    map.set(key, map.has(key) ? null : task);
  }
  return map;
}

const taskOfPrint = (index: PrintIndex, print: string): BoardTask | null => index.get(print) ?? null;

interface OpenLine {
  text: string;
  projectId: string | null;
}

function openLinesOf(scan: FocusScan): Map<number, OpenLine> {
  const out = new Map<number, OpenLine>();
  for (const entry of scan.entries) {
    if (entry.match.task === null && entry.match.candidates.length === 0 && entry.text.trim() !== "") out.set(entry.line, { text: entry.text, projectId: entry.projectId });
    if (entry.recurring) continue;
    for (const child of entry.children) if (child.task === null) out.set(child.line, { text: child.text, projectId: null });
  }
  return out;
}

interface SyncLink extends LinkedLine {
  base: number | undefined;
  tracked: boolean;
  remembered: boolean;
}

interface PendingOutOfSync {
  line: number;
  task: BoardTask | null;
  memo: MarkMemo | null;
  checkbox: BoardCheckbox;
  reason?: OutOfSyncReason;
}

interface TickPlan {
  baseTexts: string[];
  baseKeys: string[];
  links: SyncLink[];
  continued: Map<number, BoardTask>;
  carried: Map<number, MarkMemo>;
  outOfSync: PendingOutOfSync[];
  copies: Set<string>;
  unresolved: Set<number>;
  pairs: Map<number, number>;
  pinned: Set<number>;
  owned: Set<number>;
  identityAt: (index: number) => Identity | null;
}

interface Identity {
  task: BoardTask | null;
  memo: MarkMemo | null;
}

interface MovedLines {
  moved: Set<number>;
  unresolved: Set<number>;
}

const identityKey = (identity: Identity | null): string | null => identity?.task?.id ?? identity?.memo?.task ?? null;

function isFree(identity: Identity | null, claimed: ReadonlySet<string>): boolean {
  return identity !== null && (identity.task === null || !claimed.has(identity.task.id));
}

function pairMoved(
  baseTexts: string[],
  texts: string[],
  pairs: Map<number, number>,
  linkedTask: (line: number) => BoardTask | null,
  identityAt: (index: number) => Identity | null,
  claimed: ReadonlySet<string>,
): MovedLines {
  const result: MovedLines = { moved: new Set(), unresolved: new Set() };
  const used = new Set(pairs.values());
  const freeBase = groupMovable(
    baseTexts,
    baseTexts.flatMap((_text, index) => (used.has(index) ? [] : [index])),
  );
  const freeAfter = groupMovable(
    texts,
    texts.flatMap((_text, index) => (pairs.has(index) ? [] : [index])),
  );
  const pair = (line: number, base: number): void => {
    pairs.set(line, base);
    result.moved.add(line);
  };
  for (const [key, lines] of freeAfter) {
    const bases = freeBase.get(key);
    if (bases === undefined) continue;
    if (lines.length === 1 && bases.length === 1) {
      pair(lines[0] as number, bases[0] as number);
      continue;
    }
    if (bases.every((base) => identityAt(base) === null)) continue;
    const left = [...bases];
    for (const line of lines) {
      const task = linkedTask(line);
      const owners = left.filter((base) => (task === null ? isFree(identityAt(base), claimed) : identityAt(base)?.task?.id === task.id));
      if (owners.length === 1) {
        const owner = owners[0] as number;
        pair(line, owner);
        left.splice(left.indexOf(owner), 1);
        continue;
      }
      const checkbox = checkboxOfLine(texts[line] as string);
      if (task === null || bases.some((base) => checkboxOfLine(baseTexts[base] as string) !== checkbox)) result.unresolved.add(line);
    }
  }
  return result;
}

interface ResolveContext {
  data: BoardData;
  lineage: Lineage;
  prints: PrintIndex;
  known: ReadonlySet<string>;
  claimed: ReadonlySet<string>;
}

function resolveMemo(memo: MarkMemo, context: ResolveContext): BoardTask | null {
  const found = taskOfPrint(context.prints, memo.task);
  if (found !== null) return found;
  if (memo.line === undefined || memo.parent === undefined || memo.index === undefined || context.known.size === 0) return null;
  const projectId = projectOfPrint(memo.task);
  const candidates = flattenTasks(context.data.tasks).filter(
    (task) =>
      task.projectId === projectId &&
      !context.known.has(fingerprint(task)) &&
      !context.claimed.has(task.id) &&
      parentPrint(task, context.lineage) === memo.parent &&
      (task.line === memo.line || context.lineage.siblings.get(task.id) === memo.index),
  );
  return candidates.length === 1 ? (candidates[0] as BoardTask) : null;
}

function coversTitle(needle: string, title: string): boolean {
  const words = new Set(normalizeText(title).match(WORD_RE) ?? []);
  if (words.size === 0) return false;
  const have = new Set(needle.match(WORD_RE) ?? []);
  return [...words].every((word) => have.has(word));
}

function planTicks(settings: DelegationSettings, date: string, baseline: Baseline, texts: string[], scan: FocusScan, data: BoardData): TickPlan {
  const baseTexts = splitLines(baseline.content);
  const baseKeys = lineKeys(baseTexts);
  const lineage = lineageOf(data);
  const context: ResolveContext = {
    data,
    lineage,
    prints: printIndex(data),
    known: new Set(baseline.state.known),
    claimed: new Set(scan.links.map((link) => link.task.id)),
  };
  const baseScan = scanDaily(settings, date, baseline.content, data.projects, data.tasks);
  const baseLinked = new Map(
    linkedLinesOf(baseScan)
      .filter((link) => link.userSynced)
      .map((link) => [link.line, link.task]),
  );
  const memoAt = (index: number): MarkMemo | null => baseline.state.marks[baseKeys[index] as string] ?? null;
  const identities = new Map<number, Identity | null>();
  const identityAt = (index: number): Identity | null => {
    if (identities.has(index)) return identities.get(index) ?? null;
    const memo = memoAt(index);
    const linked = baseLinked.get(index);
    const remembered = memo === null ? null : { task: resolveMemo(memo, context), memo };
    const identity = memo?.pinned === true ? remembered : linked ? { task: linked, memo } : remembered;
    identities.set(index, identity);
    return identity;
  };
  const twinCounts = new Map<string, number>();
  for (const text of baseTexts) if (isMovable(text)) twinCounts.set(identityText(text), (twinCounts.get(identityText(text)) ?? 0) + 1);
  const isTwinned = (base: number, own: Identity): boolean => {
    const key = identityText(baseTexts[base] as string);
    if ((twinCounts.get(key) ?? 0) < 2) return false;
    const owners = new Set<string>();
    baseTexts.forEach((text, index) => {
      if (!isMovable(text) || identityText(text) !== key) return;
      const identity = identityAt(index);
      const id = isFree(identity, context.claimed) ? identityKey(identity) : null;
      if (id !== null) owners.add(id);
    });
    return !(owners.size === 1 && owners.has(identityKey(own) ?? ""));
  };
  const pairs = alignLines(baseTexts, texts, true);
  const scanLinks = new Map(linkedLinesOf(scan).map((link) => [link.line, link]));
  const open = openLinesOf(scan);
  const moves = pairMoved(baseTexts, texts, pairs, (line) => scanLinks.get(line)?.task ?? null, identityAt, context.claimed);
  const plan: TickPlan = {
    baseTexts,
    baseKeys,
    links: [],
    continued: new Map(),
    carried: new Map(),
    outOfSync: [],
    copies: new Set(),
    unresolved: moves.unresolved,
    pairs,
    pinned: new Set(),
    owned: new Set(),
    identityAt,
  };
  const pin = (line: number, checkbox: BoardCheckbox, task: BoardTask, base: number): void => {
    plan.links.push({ line, checkbox, task, effective: projectCheckbox(task), userSynced: true, base, tracked: true, remembered: true });
    plan.continued.set(line, task);
    plan.pinned.add(line);
  };
  const pinnedAt = (base: number | undefined): Identity | null => {
    if (base === undefined) return null;
    const identity = identityAt(base);
    return identity !== null && identity.memo?.pinned === true ? identity : null;
  };
  texts.forEach((text, line) => {
    const base = pairs.get(line);
    const baseText = base === undefined ? undefined : (baseTexts[base] as string);
    const same = baseText !== undefined && unmarkedText(baseText) === unmarkedText(text);
    const checkbox = checkboxOfLine(text);
    const ticked = baseText !== undefined && checkbox !== null && checkboxOfLine(baseText) !== checkbox;
    const link = scanLinks.get(line);
    const pinned = pinnedAt(base);
    if (pinned !== null && base !== undefined && checkbox !== null && (link === undefined || pinned.task?.id !== link.task.id)) {
      if (same && pinned.task !== null && pinned.task.repeat === null && !isTwinned(base, pinned)) pin(line, checkbox, pinned.task, base);
      return;
    }
    if (link) {
      const memo = base === undefined ? null : memoAt(base);
      const scoped = inScope(link.task, date, lineage);
      const remembered = memo !== null && isSameTask(memo, link.task);
      const tracked = scoped || remembered;
      if (remembered && !scoped) plan.continued.set(line, link.task);
      if (!link.userSynced && link.effective === "done" && ticked && checkbox !== "done") {
        plan.outOfSync.push({ line, task: link.task, memo: null, checkbox: checkbox as BoardCheckbox, reason: "recurring-done" });
      }
      if (base === undefined || (same && !moves.moved.has(line))) {
        plan.links.push({ ...link, base, tracked, remembered });
        return;
      }
      const before = identityAt(base);
      if (before !== null && before.task !== null && before.task.id === link.task.id) {
        plan.links.push({ ...link, base, tracked, remembered: remembered || before.memo !== null });
        return;
      }
      plan.links.push({ ...link, base: undefined, tracked, remembered: false });
      if (ticked && tracked && link.userSynced && link.effective !== null && link.effective !== checkbox) {
        plan.outOfSync.push({ line, task: link.task, memo: null, checkbox: checkbox as BoardCheckbox });
      }
      return;
    }
    const openLine = open.get(line);
    if (openLine === undefined || base === undefined || checkbox === null) return;
    const before = identityAt(base);
    if (before === null) return;
    if (isTwinned(base, before)) {
      plan.unresolved.add(line);
      return;
    }
    if (before.task === null) {
      if (before.memo === null) return;
      plan.carried.set(line, before.memo);
      if (ticked) plan.outOfSync.push({ line, task: null, memo: before.memo, checkbox });
      return;
    }
    const task = before.task;
    if (task.repeat !== null || (before.memo === null && !inScope(task, date, lineage))) return;
    const sameProject = openLine.projectId === null || openLine.projectId === task.projectId;
    const needle = taskNeedle(openLine.text, settings.tasks);
    const loose = before.memo?.loose === true;
    const plausible = sameProject && (same ? !loose : needle.startsWith(matchText(task.title)) || coversTitle(needle, task.title));
    if (plausible) {
      plan.links.push({ line, checkbox, task, effective: projectCheckbox(task), userSynced: true, base, tracked: true, remembered: before.memo !== null });
      plan.continued.set(line, task);
      return;
    }
    plan.carried.set(line, memoFor(task, projectCheckbox(task) ?? before.memo?.checkbox ?? checkbox, lineage, true));
    if (ticked) plan.outOfSync.push({ line, task, memo: null, checkbox });
  });
  const linkedBases = new Set<string>();
  for (const link of plan.links) linkedBases.add(unmarkedText(texts[link.line] as string));
  baseTexts.forEach((text, index) => {
    if (identityAt(index) !== null) linkedBases.add(unmarkedText(text));
  });
  for (const base of changedCopies(baseTexts, texts)) if (linkedBases.has(base)) plan.copies.add(base);
  for (const link of plan.links) {
    if (link.tracked && link.base !== undefined && (link.userSynced || link.effective === link.checkbox)) plan.owned.add(link.line);
  }
  for (const item of plan.outOfSync) plan.owned.add(item.line);
  for (const line of plan.unresolved) plan.owned.add(line);
  texts.forEach((text, line) => {
    if (plan.copies.has(unmarkedText(text))) plan.owned.add(line);
  });
  return plan;
}

function isCopied(plan: TickPlan, texts: string[], link: SyncLink): boolean {
  if (plan.copies.has(unmarkedText(texts[link.line] as string))) return true;
  return link.base !== undefined && plan.copies.has(unmarkedText(plan.baseTexts[link.base] as string));
}

function syncableLinks(plan: TickPlan, texts: string[]): SyncLink[] {
  return plan.links.filter((link) => link.tracked && !isCopied(plan, texts, link));
}

function nextOutOfSync(stored: StoredOutOfSync[], found: StoredOutOfSync[], texts: string[], prints: PrintIndex): StoredOutOfSync[] {
  const present = new Set(texts);
  const seen = new Set<string>();
  const out: StoredOutOfSync[] = [];
  for (const item of [...found, ...stored]) {
    const key = `${item.line}${KEY_SEPARATOR}${item.task}`;
    if (seen.has(key) || !present.has(item.line)) continue;
    seen.add(key);
    if (item.reason === undefined) {
      const task = taskOfPrint(prints, item.task);
      if (task !== null && projectCheckbox(task) === item.checkbox) continue;
      if (task === null && item.title === undefined) continue;
    }
    out.push(item);
  }
  return out;
}

function reportOutOfSync(items: StoredOutOfSync[], prints: PrintIndex): TodayOutOfSync[] {
  return items.flatMap((item): TodayOutOfSync[] => {
    if (item.reason !== undefined) {
      return [{ line: item.line, taskTitle: item.title ?? "", projectId: projectOfPrint(item.task), dailyCheckbox: item.checkbox, projectStatus: item.status ?? "done", reason: item.reason }];
    }
    const task = taskOfPrint(prints, item.task);
    if (task === null) {
      if (item.title === undefined) return [];
      return [{ line: item.line, taskTitle: item.title, projectId: projectOfPrint(item.task), dailyCheckbox: item.checkbox, projectStatus: item.status ?? "todo" }];
    }
    if (projectCheckbox(task) === item.checkbox) return [];
    return [{ line: item.line, taskTitle: task.title, projectId: task.projectId, dailyCheckbox: item.checkbox, projectStatus: task.status }];
  });
}

function storedOutOfSync(line: string, task: BoardTask | null, memo: MarkMemo | null, checkbox: BoardCheckbox, reason?: OutOfSyncReason): StoredOutOfSync | null {
  if (task !== null && reason !== undefined) return { line, task: fingerprint(task), checkbox, title: task.title, status: "done", reason };
  if (task !== null) return { line, task: fingerprint(task), checkbox, title: task.title, status: task.status };
  if (memo === null) return null;
  return { line, task: memo.task, checkbox, title: memo.title ?? memo.task.split(KEY_SEPARATOR)[1] ?? "", status: memo.checkbox };
}

function storedFound(plan: TickPlan, texts: string[]): StoredOutOfSync[] {
  return plan.outOfSync.flatMap((item) => {
    const stored = storedOutOfSync(texts[item.line] as string, item.task, item.memo, item.checkbox, item.reason);
    return stored === null ? [] : [stored];
  });
}

function nextDuplicates(stored: StoredDuplicate[], copies: Set<string>, texts: string[]): StoredDuplicate[] {
  const now = checkboxLineCounts(texts);
  const out: StoredDuplicate[] = [];
  const seen = new Set<string>();
  for (const text of copies) {
    const lines = now.get(text);
    if (!lines || seen.has(text)) continue;
    seen.add(text);
    out.push({ text, lines });
  }
  for (const item of stored) {
    const lines = now.get(item.text);
    if (seen.has(item.text) || !lines || lines.join("\n") !== item.lines.join("\n")) continue;
    seen.add(item.text);
    out.push(item);
  }
  return out;
}

function reportDuplicates(items: StoredDuplicate[], texts: string[], scan: FocusScan): TodayAmbiguous[] {
  const linked = linkedAt(scan);
  return items.flatMap((item) => {
    const line = texts.findIndex((text) => checkboxOfLine(text) !== null && unmarkedText(text) === item.text);
    if (line === -1) return [];
    return [{ kind: "line" as const, text: texts[line] as string, line, taskId: linked.get(line) ?? null, reason: "duplicate-line" as const }];
  });
}

function unresolvedLines(texts: string[], scan: FocusScan, key: string): { line: number; open: boolean }[] {
  const links = new Map(linkedLinesOf(scan).map((link) => [link.line, link]));
  return texts.flatMap((text, line) => {
    if (checkboxOfLine(text) === null || unmarkedText(text) !== key) return [];
    const link = links.get(line);
    return [{ line, open: link === undefined || link.effective !== link.checkbox }];
  });
}

function nextUnresolved(stored: string[], found: Set<number>, texts: string[], scan: FocusScan, foundTexts: string[] = texts): string[] {
  const keys = [...[...found].map((line) => unmarkedText(foundTexts[line] as string)), ...stored];
  return [...new Set(keys)].filter((key) => unresolvedLines(texts, scan, key).some((item) => item.open));
}

function reportUnresolved(keys: string[], texts: string[], scan: FocusScan): TodayAmbiguous[] {
  const linked = linkedAt(scan);
  return keys.flatMap((key) =>
    unresolvedLines(texts, scan, key)
      .filter((item) => item.open)
      .map((item): TodayAmbiguous => ({ kind: "line", text: texts[item.line] as string, line: item.line, taskId: linked.get(item.line) ?? null, reason: "several-lines" })),
  );
}

const wordsOf = (text: string): Set<string> => new Set(normalizeText(text).match(WORD_RE) ?? []);

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const word of a) if (b.has(word)) hit += 1;
  return hit / Math.min(a.size, b.size);
}

function isProjectLabel(label: string, projects: BoardProject[]): boolean {
  const wanted = matchText(label);
  return wanted !== "" && projects.some((project) => [project.id, project.name, project.title].some((name) => matchText(name) === wanted));
}

function bodyText(text: string, projects: BoardProject[]): string {
  const rest = restOf(text);
  const stripped = rest.replace(LEAD_WIKILINK_RE, "");
  if (stripped !== rest) return stripped.trim();
  const split = rest.indexOf(" - ");
  return split > 0 && isProjectLabel(rest.slice(0, split), projects) ? rest.slice(split + 3).trim() : rest;
}

function projectLinksOf(text: string, projects: BoardProject[]): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(WIKILINK_RE)) {
    const target = ((match[1] ?? "").split("/").pop() ?? "").replace(/\.md$/i, "");
    const label = target.trim() === "" ? (match[2] ?? "") : target;
    const wanted = matchText(label);
    for (const project of projects) {
      if (wanted !== "" && [project.id, project.name, project.title].some((name) => matchText(name) === wanted)) out.add(project.id);
    }
  }
  return out;
}

function namesTask(text: string, data: BoardData, seen: SeenTask[]): boolean {
  const body = bodyText(text, data.projects);
  const needle = matchText(body);
  if (needle === "") return false;
  const seenTitle = normalizeText(body);
  if (seen.some((item) => item.title === seenTitle)) return true;
  return flattenTasks(data.tasks).some((task) => {
    if (!isOpenTask(task)) return false;
    const title = matchText(task.title);
    return (title.length >= TITLE_HINT_MIN && needle.includes(title)) || (needle.length >= TITLE_HINT_MIN && title.includes(needle));
  });
}

function sectionOf(texts: string[], index: number): string {
  for (let at = index - 1; at >= 0; at -= 1) {
    const match = (texts[at] as string).match(HEADING_RE);
    if (match) return (match[1] as string).trim();
  }
  return "";
}

function closestVanished(text: string, linked: BoardTask | null, vanished: number[], plan: TickPlan, projects: BoardProject[]): number | undefined {
  const key = identityText(text);
  const words = wordsOf(bodyText(text, projects));
  let best: number | undefined;
  let bestScore = 0;
  for (const index of vanished) {
    const other = plan.baseTexts[index] as string;
    let score = 0;
    if (identityText(other) === key) score = 3;
    else if (linked !== null && plan.identityAt(index)?.task?.id === linked.id) score = 2;
    else {
      const similar = overlap(words, wordsOf(bodyText(other, projects)));
      if (similar >= SIMILAR_MIN) score = similar;
    }
    if (score > bestScore) {
      best = index;
      bestScore = score;
    }
  }
  return best;
}

function findUnmatched(plan: TickPlan, owned: ReadonlySet<number>, texts: string[], scan: FocusScan, data: BoardData, state: BaselineState): StoredUnmatched[] {
  const used = new Set(plan.pairs.values());
  const vanished = plan.baseTexts.flatMap((text, index) => (!used.has(index) && isMovable(text) ? [index] : []));
  const links = new Map(linkedLinesOf(scan).map((link) => [link.line, link.task]));
  const hints = new Map(state.unmatched.map((item) => [unmarkedText(item.line), item.hint]));
  const dismissed = new Set(state.dismissed);
  const out: StoredUnmatched[] = [];
  texts.forEach((text, line) => {
    const checkbox = checkboxOfLine(text);
    if (checkbox === null || restOf(text) === "" || owned.has(line) || dismissed.has(text)) return;
    const linked = links.get(line) ?? null;
    let base = plan.pairs.get(line);
    if (base === undefined) {
      base = closestVanished(text, linked, vanished, plan, data.projects);
      if (base !== undefined) vanished.splice(vanished.indexOf(base), 1);
    }
    const from = base === undefined ? null : checkboxOfLine(plan.baseTexts[base] as string);
    if (from === null ? checkbox === "todo" : from === checkbox) return;
    const identity = base === undefined ? null : plan.identityAt(base);
    const carried = hints.get(unmarkedText(text)) ?? null;
    const taskLike = linked !== null || identity !== null || carried !== null || projectLinksOf(text, data.projects).size > 0 || namesTask(text, data, state.seen);
    if (!taskLike) return;
    const known = identity?.task ?? linked;
    out.push({ line: text, index: line, checkbox, hint: known !== null ? fingerprint(known) : (identity?.memo?.task ?? carried) });
  });
  return out;
}

interface UnmatchedReports {
  outOfSync: StoredOutOfSync[];
  duplicates: StoredDuplicate[];
  unresolved: string[];
  dismissed: string[];
}

function unmatchedFilter(texts: string[], scan: FocusScan, data: BoardData, reports: UnmatchedReports): (item: StoredUnmatched, index: number) => boolean {
  const exact = new Set([...reports.outOfSync.map((item) => item.line), ...reports.dismissed]);
  const keys = new Set([...reports.duplicates.map((item) => item.text), ...reports.unresolved]);
  const several = new Set(scan.entries.filter((entry) => entry.match.task === null && entry.match.candidates.length >= 2).map((entry) => entry.line));
  const links = new Map(linkedLinesOf(scan).map((link) => [link.line, link.task]));
  const prints = printIndex(data);
  return (item, index) => {
    const text = texts[index] as string;
    if (exact.has(text) || keys.has(unmarkedText(text)) || several.has(index)) return false;
    const target = links.get(index) ?? (item.hint === null ? null : taskOfPrint(prints, item.hint));
    return target === null || projectCheckbox(target) !== item.checkbox;
  };
}

function nextUnmatched(stored: StoredUnmatched[], found: StoredUnmatched[], texts: string[], keep: (item: StoredUnmatched, index: number) => boolean): StoredUnmatched[] {
  const seen = new Set<string>();
  const out: StoredUnmatched[] = [];
  for (const item of [...found, ...stored]) {
    if (seen.has(item.line)) continue;
    const index = texts[item.index] === item.line ? item.index : texts.indexOf(item.line);
    if (index === -1 || !keep(item, index)) continue;
    seen.add(item.line);
    out.push({ ...item, index });
  }
  return out;
}

function candidatesFor(text: string, linked: BoardTask | null, hint: string | null, data: BoardData): TodayUnmatchedCandidate[] {
  const words = wordsOf(bodyText(text, data.projects));
  const projectIds = projectLinksOf(text, data.projects);
  const scored = flattenTasks(data.tasks).flatMap((task) => {
    if (task.status === "archived") return [];
    if (linked !== null && task.id === linked.id) return [{ task, score: 100 }];
    if (hint !== null && fingerprint(task) === hint) return [{ task, score: 50 }];
    const title = wordsOf(task.title);
    if (title.size === 0) return [];
    let hit = 0;
    for (const word of title) if (words.has(word)) hit += 1;
    const coverage = hit / title.size;
    if (coverage < CANDIDATE_MIN) return [];
    return [{ task, score: coverage * 10 + (projectIds.has(task.projectId) ? 1 : 0) + (isOpenTask(task) ? 0.5 : 0) }];
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_LIMIT)
    .map(({ task }) => ({ projectId: task.projectId, line: task.line, raw: task.raw, title: task.title }));
}

function reportUnmatched(items: StoredUnmatched[], texts: string[], scan: FocusScan, data: BoardData): TodayUnmatched[] {
  const links = new Map(linkedLinesOf(scan).map((link) => [link.line, link.task]));
  return items.map((item) => ({
    line: item.line,
    lineIndex: item.index,
    section: sectionOf(texts, item.index),
    checkbox: item.checkbox,
    candidates: candidatesFor(item.line, links.get(item.index) ?? null, item.hint, data),
  }));
}

const pending = new Map<string, MirrorSource>();
const timers = new Map<string, NodeJS.Timeout>();
let mirrorWriting = false;

export function forgetTodayState(): void {
  pending.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function focusIdentities(settings: DelegationSettings, content: string): Set<string> {
  const texts = splitLines(content);
  const range = focusRange(texts, settings);
  const out = new Set<string>();
  if (range === null) return out;
  for (let index = range.heading + 1; index < range.end; index += 1) out.add(identityText(texts[index] as string));
  return out;
}

function lateLineTasks(settings: DelegationSettings, date: string, baseline: Baseline, scan: FocusScan): BoardTask[] {
  if (date !== localDate()) return [];
  const before = focusIdentities(settings, baseline.content);
  const seen = new Set(baseline.state.seen.map(seenKey));
  const out = new Map<string, BoardTask>();
  for (const entry of scan.entries) {
    const task = entry.match.task;
    if (task === null || entry.held || before.has(identityText(entry.raw))) continue;
    if (seen.has(seenKey({ projectId: task.projectId, title: normalizeText(task.title) }))) continue;
    if (migrationSkipOf(task, date) === null) out.set(task.id, task);
  }
  return [...out.values()];
}

function scheduleLateLines(settings: DelegationSettings, date: string, tasks: BoardTask[]): number {
  let scheduled = 0;
  for (const task of tasks) {
    try {
      writeBoardTask(settings, { projectId: task.projectId, line: task.line, raw: task.raw, scheduled: date });
      scheduled += 1;
    } catch (err) {
      console.error(`focus mirror could not schedule ${task.id} from a new line of the daily: ${errorText(err)}`);
    }
  }
  return scheduled;
}

interface UserTick {
  task: BoardTask;
  targets: Set<BoardCheckbox>;
  lines: { line: number; checkbox: BoardCheckbox; key: string }[];
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
    const texts = splitLines(daily.content);
    let scan = scanDaily(settings, date, daily.content, data.projects, data.tasks);
    if (scheduleLateLines(settings, date, lateLineTasks(settings, date, baseline, scan)) > 0) {
      data = loadBoardData(settings) ?? data;
      scan = scanDaily(settings, date, daily.content, data.projects, data.tasks);
    }
    let plan = planTicks(settings, date, baseline, texts, scan, data);
    const oldCheckbox = (link: SyncLink): BoardCheckbox | null => (link.base === undefined ? null : checkboxOfLine(plan.baseTexts[link.base] as string));
    const baseMemo = (link: SyncLink): MarkMemo | undefined => (link.base === undefined ? undefined : baseline.state.marks[plan.baseKeys[link.base] as string]);
    const touched = new Set<number>();
    const ticks = new Map<string, UserTick>();
    const unsynced: StoredOutOfSync[] = [];
    const report = (line: number, task: BoardTask, checkbox: BoardCheckbox): void => {
      const stored = storedOutOfSync(texts[line] as string, task, null, checkbox);
      if (stored !== null) unsynced.push(stored);
    };
    for (const link of syncableLinks(plan, texts)) {
      const old = oldCheckbox(link);
      if (old === null || old === link.checkbox || !link.userSynced) continue;
      touched.add(link.line);
      const memo = baseMemo(link);
      const projectMoved = memo !== undefined && link.remembered && link.effective !== null && link.effective !== memo.checkbox;
      if (projectMoved && link.effective !== link.checkbox) {
        report(link.line, link.task, link.checkbox);
        continue;
      }
      const tick = ticks.get(link.task.id) ?? { task: link.task, targets: new Set<BoardCheckbox>(), lines: [] };
      tick.targets.add(link.checkbox);
      tick.lines.push({ line: link.line, checkbox: old, key: plan.baseKeys[link.base as number] as string });
      ticks.set(link.task.id, tick);
    }
    const retry = new Map<number, { checkbox: BoardCheckbox; key: string }>();
    for (const tick of ticks.values()) {
      const [target] = [...tick.targets];
      const keepOld = (): void => {
        for (const item of tick.lines) retry.set(item.line, { checkbox: item.checkbox, key: item.key });
      };
      if (tick.targets.size !== 1 || target === undefined) {
        keepOld();
        continue;
      }
      const status = statusFromCheckbox(tick.task.status, target);
      if (status === null) {
        if (!SYNCED_STATUSES.has(tick.task.status)) for (const item of tick.lines) report(item.line, tick.task, target);
        continue;
      }
      try {
        applyStatusChange(settings, { task: tick.task, status });
        applied += 1;
      } catch (err) {
        console.error(`focus mirror could not apply a tick for ${tick.task.id}: ${errorText(err)}`);
        keepOld();
      }
    }
    const owned = new Set(plan.owned);
    if (applied > 0) {
      data = loadBoardData(settings) ?? data;
      scan = scanDaily(settings, date, daily.content, data.projects, data.tasks);
      plan = planTicks(settings, date, baseline, texts, scan, data);
    }
    const doc = openDoc(daily.content);
    const originals = [...doc.lines];
    const retryLines = new Map<DocLine, { checkbox: BoardCheckbox; key: string }>();
    for (const [index, retried] of retry) {
      const line = originals[index];
      if (line) retryLines.set(line, retried);
    }
    for (const link of syncableLinks(plan, texts)) {
      if (touched.has(link.line) || link.effective === null) continue;
      const old = oldCheckbox(link);
      const memo = baseMemo(link);
      if (old === null || memo === undefined || old !== link.checkbox) continue;
      if (!link.remembered || link.effective === memo.checkbox || link.effective === link.checkbox) continue;
      const line = originals[link.line];
      if (line) line.text = withCheckbox(line.text, link.effective);
    }
    const insertion = insertMissing(settings, date, doc, data, computeFocus(settings, data, date), baseline.state, options.hints ?? new Set<string>());
    const next = renderDoc(doc);
    if (!keepsEveryLine(daily.content, next)) {
      console.error(`focus mirror refused a change that would lose a line of ${date}`);
      return skip("refused", applied);
    }
    const changed = next !== daily.content;
    if (changed) {
      mirrorWriting = true;
      try {
        writeDaily(settings, date, next, daily.updatedAt ?? undefined, `mirror-${randomUUID().slice(0, 8)}`, "server");
      } finally {
        mirrorWriting = false;
      }
    }
    const lineage = lineageOf(data);
    const finalScan = scanDaily(settings, date, next, data.projects, data.tasks);
    const finalTexts = splitLines(next);
    const marks = memoMarks(next, finalScan, date, lineage);
    const finalKeys = lineKeys(finalTexts);
    const prints = printIndex(data);
    const positions = new Map(doc.lines.map((line, index) => [line, index]));
    const finalKeyOf = (index: number): string | undefined => {
      const position = positions.get(originals[index] as DocLine);
      return position === undefined ? undefined : finalKeys[position];
    };
    for (const [index, task] of plan.continued) {
      const finalKey = finalKeyOf(index);
      const fresh = taskOfPrint(prints, fingerprint(task));
      const effective = fresh === null ? null : projectCheckbox(fresh);
      if (finalKey === undefined || fresh === null || effective === null) continue;
      if (plan.pinned.has(index)) marks[finalKey] = { ...memoFor(fresh, effective, lineage), pinned: true };
      else if (marks[finalKey] === undefined) marks[finalKey] = memoFor(fresh, effective, lineage);
    }
    for (const [index, memo] of plan.carried) {
      const finalKey = finalKeyOf(index);
      if (finalKey !== undefined && marks[finalKey] === undefined) marks[finalKey] = memo;
    }
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
    for (const line of plan.owned) owned.add(line);
    const outOfSync = nextOutOfSync(baseline.state.outOfSync, [...storedFound(plan, texts), ...unsynced], finalTexts, prints);
    const duplicates = nextDuplicates(baseline.state.duplicates, plan.copies, finalTexts);
    const unresolved = nextUnresolved(baseline.state.unresolved, plan.unresolved, finalTexts, finalScan, texts);
    const dismissed = baseline.state.dismissed.filter((line) => finalTexts.includes(line));
    const found = findUnmatched(plan, owned, texts, scan, data, baseline.state).flatMap((item) => {
      const at = positions.get(originals[item.index] as DocLine);
      return at === undefined ? [] : [{ ...item, index: at }];
    });
    storeBaseline(date, daily.path, {
      content: renderDoc(baseDoc),
      state: {
        marks,
        seen: mergeSeen(baseline.state.seen, [...linkedTasks(finalScan), ...insertion.inserted, ...insertion.renamed]),
        focus: focusMemory(computeFocus(settings, data, date)),
        outOfSync,
        duplicates,
        known: knownPrints(data, marks),
        unresolved,
        unmatched: nextUnmatched(baseline.state.unmatched, found, finalTexts, unmatchedFilter(finalTexts, finalScan, data, { outOfSync, duplicates, unresolved, dismissed })),
        dismissed,
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

interface RebasedLine {
  text: string;
  memo: MarkMemo | null;
}

function hubMemo(memo: MarkMemo | null, before: BoardCheckbox | null, after: BoardCheckbox | null): MarkMemo | null {
  if (memo === null || before === after) return memo;
  return after === null ? null : { ...memo, checkbox: after };
}

function rebasedLines(baseline: Baseline, previous: string, content: string): RebasedLine[] {
  const base = splitLines(baseline.content);
  const baseKeys = lineKeys(base);
  const prev = splitLines(previous);
  const next = splitLines(content);
  const memoAt = (index: number): MarkMemo | null => baseline.state.marks[baseKeys[index] as string] ?? null;
  if (baseline.content === previous) {
    const prevKeys = lineKeys(prev);
    const prevIndex = new Map(prevKeys.map((key, index) => [key, index]));
    return lineKeys(next).map((key, index) => {
      const text = next[index] as string;
      const at = prevIndex.get(key);
      if (at === undefined) return { text, memo: null };
      return { text, memo: hubMemo(memoAt(at), checkboxOfLine(prev[at] as string), checkboxOfLine(text)) };
    });
  }
  const prevOfNext = alignLines(prev, next);
  const baseOfPrev = alignLines(base, prev);
  const prevOfBase = new Map([...baseOfPrev].map(([p, b]) => [b, p]));
  const out: RebasedLine[] = [];
  let cursor = 0;
  const emitBase = (limit: number): void => {
    for (; cursor < limit; cursor += 1) {
      const paired = prevOfBase.get(cursor);
      if (paired === undefined) out.push({ text: base[cursor] as string, memo: memoAt(cursor) });
    }
  };
  next.forEach((text, index) => {
    const p = prevOfNext.get(index);
    if (p === undefined) {
      out.push({ text, memo: null });
      return;
    }
    const b = baseOfPrev.get(p);
    if (b === undefined || b < cursor) return;
    emitBase(b);
    const before = checkboxOfLine(prev[p] as string);
    const after = checkboxOfLine(text);
    const baseText = base[b] as string;
    out.push({ text: before !== after && after !== null ? withCheckbox(baseText, after) : baseText, memo: hubMemo(memoAt(b), before, after) });
    cursor = b + 1;
  });
  emitBase(base.length);
  return out;
}

function rebaseBaseline(baseline: Baseline, previous: string, content: string): Baseline {
  const lines = rebasedLines(baseline, previous, content);
  const keys = lineKeys(lines.map((line) => line.text));
  const marks: Record<string, MarkMemo> = {};
  lines.forEach((line, index) => {
    if (line.memo !== null) marks[keys[index] as string] = line.memo;
  });
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return { content: lines.map((line) => line.text).join(eol), state: { ...baseline.state, marks } };
}

function onDailyWritten(settings: DelegationSettings, date: string, content: string, origin: DailyWriteOrigin, previous: string | null, unseen = false): void {
  if (!isScheduledMode(settings) || !isCurrentOrFuture(date)) return;
  if (origin === "client") {
    scheduleMirror(date, "client");
    return;
  }
  if (mirrorWriting) return;
  const path = dailyFile(settings, date);
  if (path === null) return;
  if (previous !== null) {
    const baseline = loadBaseline(date, path);
    if (baseline !== null) storeBaseline(date, path, rebaseBaseline(baseline, previous, content));
    if (unseen) scheduleMirror(date, "board");
    return;
  }
  const data = loadBoardData(settings);
  if (data !== null) adoptBaseline(settings, date, path, content, data);
}

function isExactTitle(settings: DelegationSettings, text: string, task: BoardTask): boolean {
  const needle = taskNeedle(text, settings.tasks);
  return needle === matchText(task.title) || needle === matchText(joinReason(task.title, task.reason, settings.tasks.reasonSeparator));
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

export function usesMirror(settings: DelegationSettings, date: string): boolean {
  return isScheduledMode(settings) && isCurrentOrFuture(date);
}

export function saveDailyFromClient(settings: DelegationSettings, date: string, content: string, baseUpdatedAt?: number, writeId?: string | null): DailyWriteResult {
  const legacy = usesMirror(settings, date) ? null : dailySyncBaseline(settings, date);
  const written = writeDaily(settings, date, content, baseUpdatedAt, writeId, "client");
  if (legacy !== null) syncTasksFromDaily(settings, date, legacy, content);
  return written;
}

export function closeDailyTicks(settings: DelegationSettings, date: string, before: string, after: string): DailyWriteResult {
  if (usesMirror(settings, date)) return writeDaily(settings, date, after, undefined, null, "client");
  const written = writeDaily(settings, date, after);
  syncTasksFromDaily(settings, date, before, after);
  return written;
}

function unambiguousLines(date: string, path: string, scan: FocusScan, content: string): ReadonlySet<number> {
  const texts = splitLines(content);
  const counts = checkboxLineCounts(texts);
  const duplicated = new Set((loadBaseline(date, path)?.state.duplicates ?? []).map((item) => item.text));
  const perTask = presenceOf(scan).lines;
  const allowed = new Set<number>();
  for (const link of scan.links) {
    const text = unmarkedText(texts[link.line] as string);
    if ((counts.get(text)?.length ?? 0) !== 1 || duplicated.has(text) || (perTask.get(link.task.id)?.length ?? 0) !== 1) continue;
    allowed.add(link.line);
  }
  return allowed;
}

function guardedFilter(settings: DelegationSettings, date: string): (scan: FocusScan, content: string) => ReadonlySet<number> {
  const path = dailyFile(settings, date) ?? "";
  return (scan, content) => unambiguousLines(date, path, scan, content);
}

export function syncTaskToDailyChecked(settings: DelegationSettings, input: SyncDailyInput): SyncDailyResult {
  const date = input.date ?? localDate();
  if (!usesMirror(settings, date)) return syncTaskToDaily(settings, input);
  runMirror(settings, date, { source: "api" });
  const result = syncTaskToDaily(settings, input, guardedFilter(settings, date));
  if (result.updated > 0) runMirror(settings, date, { source: "api" });
  return result;
}

export function addTaskToDailyChecked(settings: DelegationSettings, input: AddToDailyInput): AddToDailyResult {
  const date = input.date ?? localDate();
  const result = addTaskToDaily(settings, input);
  if (!usesMirror(settings, date)) return result;
  const data = loadBoardData(settings);
  const task = data === null ? undefined : flattenTasks(data.tasks).find((item) => item.projectId === input.projectId && item.line === input.line && item.raw === input.raw);
  if (task === undefined || task.scheduled === date) {
    runMirror(settings, date, { source: "api" });
    return result;
  }
  schedule(settings, { projectId: task.projectId, line: task.line, raw: task.raw, date });
  return result;
}

export function syncTaskFromDailyChecked(settings: DelegationSettings, input: SyncFromDailyInput): SyncFromDailyResult {
  const date = input.date ?? localDate();
  if (!usesMirror(settings, date)) return syncTaskFromDaily(settings, input);
  runMirror(settings, date, { source: "api" });
  const result = syncTaskFromDaily(settings, input, guardedFilter(settings, date));
  if (result.updated > 0) runMirror(settings, date, { source: "api" });
  return result;
}

export function organizeFocusChecked(settings: DelegationSettings, date: string, board: ComposeBoard | null, baseUpdatedAt?: number): OrganizeDailyFocusResult {
  if (usesMirror(settings, date)) runMirror(settings, date, { source: "api" });
  return organizeDailyFocus(settings, date, board, baseUpdatedAt);
}

export function runStartupMirror(settings: DelegationSettings = getSettings()): MirrorResult | null {
  if (!isScheduledMode(settings)) return null;
  return runMirror(settings, localDate(), { source: "api" });
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
  inNoteLinks: TodayNoteLine[];
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
  if (!range) return { inNote: [], inNoteLinks: [], unlinked: [], ambiguous };
  const focusIds = new Set(focus.flatMap((entry) => flattenTasks([entry.task]).map((task) => task.id)));
  const occurrences = new Set(focus.filter((entry) => isOccurrence(entry.task)).map((entry) => fingerprint(entry.task)));
  const entries = new Map(scan.entries.map((entry) => [entry.line, entry]));
  const inNote: string[] = [];
  const inNoteLinks: TodayNoteLine[] = [];
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
      const head = index;
      const linkedId = task !== null && entry?.held !== true ? task.id : null;
      const kept = texts.slice(index, end).flatMap((text, offset) => (isBlankText(text) || isPlaceholderLine(text) ? [] : [{ text, at: head + offset }]));
      const lines = kept.map((item) => item.text);
      inNote.push(...lines);
      inNoteLinks.push(...kept.map((item): TodayNoteLine => ({ line: item.text, taskId: item.at === head ? linkedId : null })));
      if (task === null) unlinked.push(...lines);
    }
    index = end;
  }
  return { inNote, inNoteLinks, unlinked, ambiguous };
}

interface SyncReport {
  outOfSync: TodayOutOfSync[];
  duplicates: TodayAmbiguous[];
  unresolved: TodayAmbiguous[];
  unmatched: TodayUnmatched[];
}

const EMPTY_REPORT: SyncReport = { outOfSync: [], duplicates: [], unresolved: [], unmatched: [] };

function syncReport(settings: DelegationSettings, date: string, daily: DailyReadResult, data: BoardData): SyncReport {
  const baseline = isScheduledMode(settings) && isCurrentOrFuture(date) ? loadBaseline(date, daily.path) : null;
  if (baseline === null) return EMPTY_REPORT;
  const texts = splitLines(daily.content);
  const scan = scanDaily(settings, date, daily.content, data.projects, data.tasks);
  const plan = planTicks(settings, date, baseline, texts, scan, data);
  const prints = printIndex(data);
  const outOfSync = nextOutOfSync(baseline.state.outOfSync, storedFound(plan, texts), texts, prints);
  const duplicates = nextDuplicates(baseline.state.duplicates, plan.copies, texts);
  const unresolved = nextUnresolved(baseline.state.unresolved, plan.unresolved, texts, scan);
  const dismissed = baseline.state.dismissed.filter((line) => texts.includes(line));
  const found = findUnmatched(plan, plan.owned, texts, scan, data, baseline.state);
  const unmatched = nextUnmatched(baseline.state.unmatched, found, texts, unmatchedFilter(texts, scan, data, { outOfSync, duplicates, unresolved, dismissed }));
  return {
    outOfSync: reportOutOfSync(outOfSync, prints),
    duplicates: reportDuplicates(duplicates, texts, scan),
    unresolved: reportUnresolved(unresolved, texts, scan),
    unmatched: reportUnmatched(unmatched, texts, scan, data),
  };
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
      doc.lines.splice(content[0] as number, 1, line);
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

function migrationSkipOf(task: BoardTask, date: string): MigrationSkip["reason"] | null {
  if (task.scheduled !== null) return "scheduled-elsewhere";
  if (task.status === "archived") return "archived";
  if (task.status === "done" && task.doneAt !== null && task.doneAt !== date) return "finished-earlier";
  return null;
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
    const reason = migrationSkipOf(task, date);
    if (reason !== null) result.skipped.push({ taskId: task.id, title: task.title, scheduled: task.scheduled, reason });
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

function validateLinkTick(input: LinkTickInput): void {
  if (!Number.isInteger(input.lineIndex) || input.lineIndex < 0) throw new BadRequestError("lineIndex must be a non-negative integer");
  if (typeof input.raw !== "string") throw new BadRequestError("raw required");
  if (input.action !== "apply" && input.action !== "dismiss") throw new BadRequestError("action must be apply or dismiss");
  if (input.action === "apply" && input.target === null) throw new BadRequestError("apply needs a target task");
}

function explicitStatus(current: BoardStatus, checkbox: BoardCheckbox): BoardStatus | null {
  if (checkboxForStatus(current) === checkbox) return null;
  return checkbox === "done" ? "done" : checkbox === "doing" ? "doing" : "todo";
}

function locateLine(texts: string[], raw: string, hint: number): number {
  if (texts[hint] === raw) return hint;
  const hits = texts.flatMap((text, index) => (text === raw ? [index] : []));
  if (hits.length !== 1) throw new StaleTodayLineError();
  return hits[0] as number;
}

function currentUnmatched(settings: DelegationSettings, date: string): TodayUnmatched[] {
  const daily = readDailySafe(settings, date);
  const data = loadBoardData(settings);
  return daily === null || !daily.exists || data === null ? [] : syncReport(settings, date, daily, data).unmatched;
}

function linkTick(settings: DelegationSettings, date: string, input: LinkTickInput): LinkTickResult {
  requireDailyFeature(settings);
  validateDate(date);
  validateLinkTick(input);
  if (!settings.features.tasks || !usesMirror(settings, date)) throw new BadRequestError("ticks are linked only in the scheduled focus of today or a later date");
  const checkbox = checkboxOfLine(input.raw);
  if (checkbox === null) throw new BadRequestError("the line has no checkbox");
  const before = readDaily(settings, date);
  if (!before.exists) throw new NotFoundError("daily not found");
  if (splitLines(before.content)[input.lineIndex] !== input.raw) throw new StaleTodayLineError();
  runMirror(settings, date, { source: "api" });
  const daily = readDaily(settings, date);
  const index = locateLine(splitLines(daily.content), input.raw, input.lineIndex);
  const settled = loadBaseline(date, daily.path);
  if (settled === null) throw new StaleTodayLineError();
  const baseIndex = locateLine(splitLines(settled.content), input.raw, index);
  let task: BoardTask | null = null;
  if (input.action === "apply") {
    const data = loadBoardData(settings);
    if (data === null) throw new BadRequestError("the tasks board is not available");
    const target = input.target as LinkTickTarget;
    const found = flattenTasks(data.tasks).find((item) => item.projectId === target.projectId && item.line === target.line);
    if (!found || found.raw !== target.raw) throw new TaskConflictError(found ?? null);
    const status = explicitStatus(found.status, checkbox);
    task = status === null ? found : writeBoardTask(settings, { projectId: found.projectId, line: found.line, raw: found.raw, status }).task;
  }
  const baseline = loadBaseline(date, daily.path) ?? settled;
  const baseTexts = splitLines(baseline.content);
  const key = lineKeys(baseTexts)[locateLine(baseTexts, input.raw, baseIndex)] as string;
  const marks = { ...baseline.state.marks };
  const fresh = task === null ? null : loadBoardData(settings);
  if (task !== null && fresh !== null) marks[key] = { ...memoFor(task, checkbox, lineageOf(fresh)), pinned: true };
  const dismissed = baseline.state.dismissed.filter((line) => line !== input.raw);
  storeBaseline(date, daily.path, {
    content: baseline.content,
    state: {
      ...baseline.state,
      marks,
      known: fresh === null ? baseline.state.known : knownPrints(fresh, marks),
      unmatched: baseline.state.unmatched.filter((item) => item.line !== input.raw),
      dismissed: input.action === "dismiss" ? [...dismissed, input.raw] : dismissed,
    },
  });
  return { task, unmatched: currentUnmatched(settings, date) };
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
  const view: NoteView = exists && data ? noteView(settings, date, daily as DailyReadResult, data, focus, scheduledFocus) : { inNote: [], inNoteLinks: [], unlinked: [], ambiguous: [] };
  const report: SyncReport = exists && data ? syncReport(settings, date, daily as DailyReadResult, data) : EMPTY_REPORT;
  return {
    date,
    focusSource,
    focus,
    carriedOver: scheduledFocus ? computeCarried(settings, data, date) : [],
    meetings: meetingsOf(settings, lines),
    captures: capturesOf(settings, lines),
    unlinked: view.unlinked,
    inNote: view.inNote,
    inNoteLinks: view.inNoteLinks,
    ambiguous: [...view.ambiguous, ...report.duplicates, ...report.unresolved],
    ...(report.outOfSync.length > 0 ? { outOfSync: report.outOfSync } : {}),
    ...(report.unmatched.length > 0 ? { unmatched: report.unmatched } : {}),
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
  linkTick,
};
