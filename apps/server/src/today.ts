import { createHash, randomUUID } from "node:crypto";
import { relative, sep } from "node:path";
import {
  DailyConflictError,
  dailyFile,
  dailyRoot,
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
import { deleteTodayBaseline, getSetting, getSettings, getTodayBaseline, saveTodayBaseline, setSetting } from "./delegation-store.js";
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
  anyFold,
  firstFold,
  joinReason,
  mirrorsFocus,
  normalizeText,
  openDoc,
  renderDoc,
  requireBoardRoot,
  restoreTaskLine,
  scanDaily,
  setBoardHooks,
  statusFromCheckbox,
  syncTaskFromDaily,
  syncTasksFromDaily,
  syncTaskToDaily,
  taskNeedle,
  TaskConflictError,
  readProjectState,
  replaceProjectFile,
  writeBoardTask,
  isScheduledManual,
  scheduledManualReason,
  scheduledTokenOf,
  writeScheduledToken,
  writeScheduledTokenText,
  type AddToDailyInput,
  type AddToDailyResult,
  type BoardCheckbox,
  type BoardProject,
  type BoardStatus,
  type TextFold,
  type BoardTask,
  type DocLine,
  type FocusEntry,
  type FocusScan,
  type ParsedDoc,
  type ProjectFileState,
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

export interface TodayNoteBlock {
  line: string;
  lineIndex: number;
  taskId: string | null;
  projectId: string | null;
  text: string | null;
  children: string[];
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
  noteBlocks?: TodayNoteBlock[];
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
  from?: string;
}

export type ReorderDirection = "up" | "down";

export interface ReorderInput {
  projectId: string;
  line: number;
  raw: string;
  direction: ReorderDirection;
}

export interface ReorderResult {
  moved: boolean;
}

export interface ClearTodayResult {
  token: string;
  lines: number;
  unscheduled: number;
}

export interface UndoClearResult {
  restored: true;
}

export interface PromoteInput {
  line: number;
  raw: string;
  projectId: string;
  schedule?: boolean;
}

export type MirrorSource = "api" | "board" | "disk" | "client" | "migrate";

export type MirrorSkip = "disabled" | "list" | "past" | "no-daily" | "no-board" | "unsettled" | "refused" | "conflict" | "failed";

export interface MirrorOptions {
  source?: MirrorSource;
  hints?: ReadonlySet<string>;
  stable?: string;
}

export type DailyReread = (settings: DelegationSettings, date: string) => string | null;

export interface FocusStabilityOptions {
  delayMs?: number;
  reread?: DailyReread | null;
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
  clearToday(settings: DelegationSettings, date: string): ClearTodayResult;
  undoClear(settings: DelegationSettings, date: string, token: string): UndoClearResult;
  reorderFocus(settings: DelegationSettings, date: string, input: ReorderInput): ReorderResult;
}

export class StaleCaptureError extends Error {
  constructor() {
    super("the capture changed on disk");
  }
}

export class StaleTodayLineError extends Error {
  constructor(message = "the daily line changed on disk") {
    super(message);
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
const GONE_KEY = "today.gone";
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

function goneDates(): string[] {
  const raw = getSetting(GONE_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function isGone(date: string): boolean {
  return goneDates().includes(date);
}

function setGone(date: string, gone: boolean): void {
  const current = goneDates();
  if (current.includes(date) === gone) return;
  const next = current.filter((item) => item !== date && isCurrentOrFuture(item));
  if (gone) next.push(date);
  setSetting(GONE_KEY, next.length === 0 ? null : JSON.stringify(next));
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
  sync?: SyncSets;
  inserted?: string[];
}

interface StoredHold {
  print: string;
  line: string;
}

interface StoredYield {
  print: string;
  to: string;
}

interface StoredMove {
  print: string;
  from: string | null;
  token?: string;
}

interface SyncSets {
  linked: string[];
  dated: string[];
  held?: StoredHold[];
  yielded?: StoredYield[];
  moved?: StoredMove[];
  adopted?: boolean;
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
  const sync = parseSync(value.sync);
  const inserted = parseStrings(value.inserted);
  return {
    ...(inserted.length > 0 ? { inserted } : {}),
    marks,
    seen: parseSeen(value.seen),
    focus: parseSeen(value.focus),
    outOfSync: parseOutOfSync(value.outOfSync),
    duplicates: parseDuplicates(value.duplicates),
    known: parseStrings(value.known),
    unresolved: parseStrings(value.unresolved),
    unmatched: parseUnmatched(value.unmatched),
    dismissed: parseStrings(value.dismissed),
    ...(sync === null ? {} : { sync }),
  };
}

function parseSync(value: unknown): SyncSets | null {
  if (!isRecord(value) || !Array.isArray(value.linked) || !Array.isArray(value.dated)) return null;
  const held = Array.isArray(value.held)
    ? value.held.flatMap((item: unknown): StoredHold[] => (isRecord(item) && typeof item.print === "string" && typeof item.line === "string" ? [{ print: item.print, line: item.line }] : []))
    : [];
  const yielded = Array.isArray(value.yielded)
    ? value.yielded.flatMap((item: unknown): StoredYield[] => (isRecord(item) && typeof item.print === "string" && typeof item.to === "string" && isValidDailyDate(item.to) ? [{ print: item.print, to: item.to }] : []))
    : [];
  const moved = Array.isArray(value.moved) ? value.moved.flatMap(parseMove) : [];
  return {
    linked: parseStrings(value.linked),
    dated: parseStrings(value.dated),
    ...(held.length > 0 ? { held } : {}),
    ...(yielded.length > 0 ? { yielded } : {}),
    ...(moved.length > 0 ? { moved } : {}),
    ...(value.adopted === true ? { adopted: true } : {}),
  };
}

function parseMove(item: unknown): StoredMove[] {
  if (!isRecord(item) || typeof item.print !== "string") return [];
  const token = typeof item.token === "string" ? item.token : undefined;
  const from = typeof item.from === "string" && isValidDailyDate(item.from) ? item.from : null;
  if (from === null && (item.from !== null || token === undefined)) return [];
  return [{ print: item.print, from, ...(token !== undefined ? { token } : {}) }];
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

function adoptBaseline(settings: DelegationSettings, date: string, path: string, content: string, data: BoardData, outside = false): Baseline {
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
    sync: { linked: outside ? [] : printsOf(withChildren(memberLines(settings, date, scan, null, new Set<string>()), date).map((member) => member.task)), dated: [], adopted: true },
  };
  const baseline: Baseline = { content, state };
  storeBaseline(date, path, baseline);
  setGone(date, false);
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

function insertionSpot(settings: DelegationSettings, texts: string[], board: ComposeBoard, first: string | undefined, allowHeading: boolean): InsertSpot | null {
  const range = focusRange(texts, settings);
  if (!range) {
    if (!allowHeading) return null;
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
  const top = lineBlocks(texts, range.heading + 1, last + 1).at(-1)?.[0];
  const lastText = top !== undefined && indentWidth(texts[top] as string) === 0 ? (texts[top] as string) : undefined;
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
  allowHeading = false,
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
    const last = start + blockLength(texts.join("\n"), start) - 1;
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
  const placeTops = (batch: TopItem[], grouped: string | null): void => {
    let tops = batch;
    while (tops.length > 0) {
      const items: ComposeFocusItem[] = tops.map((item) => ({ project: null, text: "", block: item.lines.map((line) => line.text).join("\n"), keepMark: true }));
      const rendered = renderFocusLines(items, settings.daily.wikilinks, board);
      const owners = layoutOf(rendered, tops);
      if (owners === null) {
        for (const item of tops) ambiguous(item.task, "same-title");
        return;
      }
      const texts = textsOf();
      const groupEnd = grouped === null ? null : projectGroupEnd(settings, texts, board, grouped);
      const spot = groupEnd === null ? insertionSpot(settings, texts, board, rendered[0], allowHeading) : { at: groupEnd + 1, prefix: [], suffix: [] };
      if (spot === null) return;
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
        refresh();
        return;
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
  };
  const tops: TopItem[] = [];
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
  let pending = tops;
  while (pending.length > 0) {
    const texts = textsOf();
    const grouped = pending.find((item) => projectGroupEnd(settings, texts, board, item.task.projectId) !== null)?.task.projectId ?? null;
    placeTops(grouped === null ? pending : pending.filter((item) => item.task.projectId === grouped), grouped);
    pending = grouped === null ? [] : pending.filter((item) => item.task.projectId !== grouped);
  }
  return result;
}

function projectGroupEnd(settings: DelegationSettings, texts: string[], board: ComposeBoard, projectId: string): number | null {
  const range = focusRange(texts, settings);
  if (!range) return null;
  let end: number | null = null;
  for (const [start, stop] of lineBlocks(texts, range.heading + 1, range.end)) {
    const text = texts[start] as string;
    if (indentWidth(text) === 0 && projectOfFocusLine(text, board) === projectId) end = stop - 1;
  }
  return end;
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
  date: string;
}

function resolveMemo(memo: MarkMemo, context: ResolveContext): BoardTask | null {
  const found = taskOfPrint(context.prints, memo.task);
  if (found !== null) return found;
  if (context.known.size === 0) return null;
  const projectId = projectOfPrint(memo.task);
  const unseen = (task: BoardTask): boolean => !context.known.has(fingerprint(task)) && !context.claimed.has(task.id);
  if (memo.line !== undefined && memo.parent !== undefined && memo.index !== undefined) {
    const candidates = flattenTasks(context.data.tasks).filter(
      (task) =>
        task.projectId === projectId &&
        unseen(task) &&
        parentPrint(task, context.lineage) === memo.parent &&
        (task.line === memo.line || context.lineage.siblings.get(task.id) === memo.index),
    );
    if (candidates.length > 1) return null;
    if (candidates.length === 1) return candidates[0] as BoardTask;
  }
  const title = memo.task.slice(projectId.length + KEY_SEPARATOR.length);
  const moved = flattenTasks(context.data.tasks).filter((task) => task.projectId !== projectId && task.scheduled === context.date && normalizeText(task.title) === title && unseen(task));
  return moved.length === 1 ? (moved[0] as BoardTask) : null;
}

function coversTitle(needle: string, title: string, fold: TextFold): boolean {
  const words = new Set(fold(title).match(WORD_RE) ?? []);
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
    date,
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
    const memoProject = before.memo === null ? null : projectOfPrint(before.memo.task);
    const sameProject = openLine.projectId === null || openLine.projectId === task.projectId || (same && memoProject !== null && (memoProject === task.projectId || memoProject === openLine.projectId));
    const loose = before.memo?.loose === true;
    const plausible =
      sameProject &&
      (same
        ? !loose
        : anyFold((fold) => {
            const needle = taskNeedle(openLine.text, settings.tasks, fold);
            return needle.startsWith(fold(task.title)) || coversTitle(needle, task.title, fold);
          }));
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
  return anyFold((fold) => {
    const wanted = fold(label);
    return wanted !== "" && projects.some((project) => [project.id, project.name, project.title].some((name) => fold(name) === wanted));
  });
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
    const hits = firstFold((fold) => {
      const wanted = fold(label);
      if (wanted === "") return undefined;
      const ids = projects.filter((project) => [project.id, project.name, project.title].some((name) => fold(name) === wanted)).map((project) => project.id);
      return ids.length > 0 ? ids : undefined;
    });
    for (const id of hits ?? []) out.add(id);
  }
  return out;
}

function namesTask(text: string, data: BoardData, seen: SeenTask[]): boolean {
  const body = bodyText(text, data.projects);
  const seenTitle = normalizeText(body);
  if (seenTitle !== "" && seen.some((item) => item.title === seenTitle)) return true;
  const open = flattenTasks(data.tasks).filter(isOpenTask);
  return anyFold((fold) => {
    const needle = fold(body);
    if (needle === "") return false;
    return open.some((task) => {
      const title = fold(task.title);
      return (title.length >= TITLE_HINT_MIN && needle.includes(title)) || (needle.length >= TITLE_HINT_MIN && title.includes(needle));
    });
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

interface ScoredTask {
  task: BoardTask;
  score: number;
}

function scoredCandidates(text: string, linked: BoardTask | null, hint: string | null, data: BoardData): ScoredTask[] {
  const words = wordsOf(bodyText(text, data.projects));
  const projectIds = projectLinksOf(text, data.projects);
  const scored = flattenTasks(data.tasks).flatMap((task): ScoredTask[] => {
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
  return scored.sort((a, b) => b.score - a.score);
}

function candidatesFor(text: string, linked: BoardTask | null, hint: string | null, data: BoardData): TodayUnmatchedCandidate[] {
  return scoredCandidates(text, linked, hint, data)
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
  for (const wait of stableWaits.values()) clearTimeout(wait.timer);
  stableWaits.clear();
  hubWrites.clear();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface MemberLine {
  line: number;
  task: BoardTask;
  entry: FocusEntry;
  child?: boolean;
}

const printsOf = (tasks: BoardTask[]): string[] => [...new Set(tasks.map(fingerprint))];

const isRecurringTask = (task: BoardTask): boolean => task.repeat !== null;

const isHistory = (task: BoardTask): boolean => task.status === "done" || task.status === "archived";

function isConfident(settings: DelegationSettings, date: string, entry: FocusEntry, task: BoardTask, known: ReadonlySet<string>): boolean {
  return entry.projectId !== null || task.scheduled === date || known.has(fingerprint(task)) || isExactTitle(settings, entry.text, task);
}

function memberLines(settings: DelegationSettings, date: string, scan: FocusScan, plan: TickPlan | null, known: ReadonlySet<string>): MemberLine[] {
  const out: MemberLine[] = [];
  for (const entry of scan.entries) {
    const pinned = plan !== null && plan.pinned.has(entry.line) ? (plan.continued.get(entry.line) ?? null) : null;
    if (pinned !== null) {
      out.push({ line: entry.line, task: pinned, entry });
      continue;
    }
    const task = entry.match.task;
    if (task !== null) {
      if (isConfident(settings, date, entry, task, known)) out.push({ line: entry.line, task, entry });
      continue;
    }
    const carried = plan?.continued.get(entry.line);
    if (carried !== undefined) out.push({ line: entry.line, task: carried, entry });
  }
  return out;
}

function withChildren(members: MemberLine[], date: string): MemberLine[] {
  const out = [...members];
  const lines = new Set(members.map((member) => member.line));
  for (const member of members) {
    if (member.child === true || member.entry.recurring) continue;
    for (const child of member.entry.children) {
      const task = child.task;
      if (task === null || lines.has(child.line) || task.scheduled !== date || isRecurringTask(task)) continue;
      lines.add(child.line);
      out.push({ line: child.line, task, entry: member.entry, child: true });
    }
  }
  return out;
}

function datedTasks(data: BoardData, date: string): BoardTask[] {
  return flattenTasks(data.tasks).filter((task) => task.status !== "archived" && inFocus(task, date));
}

function legacySets(settings: DelegationSettings, date: string, baseline: Baseline, data: BoardData, members: MemberLine[], dated: BoardTask[]): SyncSets {
  const baseScan = scanDaily(settings, date, baseline.content, data.projects, data.tasks);
  const linked = new Set(printsOf(withChildren(memberLines(settings, date, baseScan, null, new Set<string>()), date).map((member) => member.task)));
  const present = new Set(printsOf(members.map((member) => member.task)));
  const existing = new Set(flattenTasks(data.tasks).map((task) => `${task.projectId}${KEY_SEPARATOR}${normalizeText(task.title)}`));
  for (const task of dated) {
    const print = fingerprint(task);
    if (!present.has(print) && isKnown(task, baseline.state.seen, existing)) linked.add(print);
  }
  return { linked: [...linked], dated: printsOf(dated.filter((task) => linked.has(fingerprint(task)))) };
}

interface Restore {
  task: BoardTask;
  to: string | null;
  token?: string;
}

interface Reconciled {
  schedule: BoardTask[];
  unschedule: BoardTask[];
  restore: Restore[];
  removed: number;
  drop: number[];
  insert: Set<string>;
  yielded: StoredYield[];
  projects: Set<string>;
}

interface RenameCredit {
  projects: Map<string, number>;
  titles: Map<string, string[]>;
}

function renameCredit(base: ReadonlySet<string>, now: ReadonlySet<string>, prints: PrintIndex): RenameCredit {
  const credit: RenameCredit = { projects: new Map(), titles: new Map() };
  for (const print of base) {
    if (now.has(print) || prints.has(print)) continue;
    const projectId = projectOfPrint(print);
    const title = print.slice(projectId.length + KEY_SEPARATOR.length);
    credit.projects.set(projectId, (credit.projects.get(projectId) ?? 0) + 1);
    credit.titles.set(title, [...(credit.titles.get(title) ?? []), projectId]);
  }
  return credit;
}

function take(credit: RenameCredit, projectId: string): void {
  credit.projects.set(projectId, Math.max(0, (credit.projects.get(projectId) ?? 0) - 1));
}

function spend(credit: RenameCredit, task: BoardTask): boolean {
  const title = normalizeText(task.title);
  const moved = credit.titles.get(title) ?? [];
  const from = moved[0];
  if (from !== undefined) {
    credit.titles.set(title, moved.slice(1));
    take(credit, from);
    return true;
  }
  if ((credit.projects.get(task.projectId) ?? 0) === 0) return false;
  take(credit, task.projectId);
  return true;
}

function groupByPrint(members: MemberLine[]): Map<string, MemberLine[]> {
  const out = new Map<string, MemberLine[]>();
  for (const member of members) {
    const print = fingerprint(member.task);
    out.set(print, [...(out.get(print) ?? []), member]);
  }
  return out;
}

function datedChildren(member: MemberLine, date: string): BoardTask[] {
  if (member.entry.recurring) return [];
  return member.entry.children.flatMap((child) => (child.task !== null && child.task.scheduled === date && !isRecurringTask(child.task) && !isHistory(child.task) ? [child.task] : []));
}

function schedulesFromLine(task: BoardTask, found: MemberLine[], date: string): boolean {
  if (isRecurringTask(task) || found.some((member) => member.entry.recurring || member.entry.checkbox === "done")) return false;
  return task.section === "open" && task.status !== "done" && task.status !== "archived" && task.scheduled !== date;
}

const isHoldingText = (text: string): boolean => text.trim() !== "" && !isPlaceholderLine(text) && !HEADING_RE.test(text);

function ownerOf(entry: FocusEntry, data: BoardData): BoardTask | null {
  if (entry.match.task !== null) return entry.match.task;
  const [first, second] = scoredCandidates(entry.raw, null, null, data);
  if (first === undefined || (second !== undefined && second.score === first.score)) return null;
  return first.task;
}

function closestPrint(entry: FocusEntry, vanished: ReadonlySet<string>, prints: PrintIndex, data: BoardData): string | null {
  const projects = projectLinksOf(entry.raw, data.projects);
  if (entry.projectId !== null) projects.add(entry.projectId);
  const words = wordsOf(bodyText(entry.raw, data.projects));
  let best: string | null = null;
  let bestScore = 0;
  let tied = false;
  for (const print of vanished) {
    const task = taskOfPrint(prints, print);
    if (task === null || (projects.size > 0 && !projects.has(task.projectId))) continue;
    const score = overlap(words, wordsOf(task.title));
    if (score < SIMILAR_MIN || score < bestScore) continue;
    tied = score === bestScore;
    if (score > bestScore) {
      best = print;
      bestScore = score;
    }
  }
  return tied ? null : best;
}

function heldPrints(scan: FocusScan, members: MemberLine[], data: BoardData, plan: TickPlan, texts: string[], stored: StoredHold[], vanished: ReadonlySet<string>): Map<string, string> {
  const linked = new Set(members.map((member) => member.line));
  const prints = printIndex(data);
  const out = new Map<string, string>();
  const holding = new Set<number>();
  const hold = (print: string | null, index: number): void => {
    if (print === null || !vanished.has(print) || out.has(print) || holding.has(index)) return;
    out.set(print, unmarkedText(texts[index] as string));
    holding.add(index);
  };
  const pairedPrint = (index: number): string | null => {
    const base = plan.pairs.get(index);
    const identity = base === undefined ? null : plan.identityAt(base);
    if (identity?.task) return fingerprint(identity.task);
    return identity?.memo?.task ?? null;
  };
  const entryLines = new Set<number>();
  for (const entry of scan.entries) {
    entryLines.add(entry.line);
    if (linked.has(entry.line) || entry.text.trim() === "" || !isHoldingText(texts[entry.line] as string)) continue;
    const owner = ownerOf(entry, data);
    const ownerPrint = owner === null ? null : fingerprint(owner);
    const paired = pairedPrint(entry.line);
    if (ownerPrint !== null) hold(ownerPrint, entry.line);
    else if (paired !== null && vanished.has(paired)) hold(paired, entry.line);
    else hold(closestPrint(entry, vanished, prints, data), entry.line);
  }
  texts.forEach((text, index) => {
    if (linked.has(index) || entryLines.has(index) || !isHoldingText(text)) return;
    hold(pairedPrint(index), index);
  });
  const current = texts.map(unmarkedText);
  const baseIndex = new Map<number, number>();
  for (const [index, base] of plan.pairs) baseIndex.set(base, index);
  for (const item of stored) {
    const same = current.findIndex((text, index) => text === item.line && !linked.has(index));
    if (same !== -1) {
      hold(item.print, same);
      continue;
    }
    const base = plan.baseTexts.findIndex((text) => unmarkedText(text) === item.line);
    const index = base === -1 ? undefined : baseIndex.get(base);
    if (index !== undefined && !linked.has(index) && isHoldingText(texts[index] as string)) hold(item.print, index);
  }
  return out;
}

function reconcile(
  date: string,
  base: SyncSets,
  members: MemberLine[],
  dated: BoardTask[],
  data: BoardData,
  hints: ReadonlySet<string>,
  held: ReadonlySet<string>,
  resolve: (print: string) => BoardTask | null,
): Reconciled {
  const prints = printIndex(data);
  const lines = groupByPrint(members);
  const datedNow = new Map<string, BoardTask>();
  for (const task of dated) if (!datedNow.has(fingerprint(task))) datedNow.set(fingerprint(task), task);
  const linkedBase = new Set(base.linked);
  const datedBase = new Set(base.dated);
  const adopted = base.adopted === true;
  const movedFrom = new Map((base.moved ?? []).map((item) => [item.print, item]));
  const lineCredit = renameCredit(linkedBase, new Set(lines.keys()), prints);
  const dateCredit = renameCredit(datedBase, new Set(datedNow.keys()), prints);
  const out: Reconciled = { schedule: [], unschedule: [], restore: [], removed: 0, drop: [], insert: new Set<string>(), yielded: [], projects: new Set<string>() };
  const yields = new Set((base.yielded ?? []).map((item) => item.print));
  const leaving = new Set<string>();
  for (const [print, found] of lines) {
    const task = (found[0] as MemberLine).task;
    if (found.every((member) => member.child === true)) continue;
    if (yields.has(print)) {
      const scheduled = task.scheduled;
      if (scheduled === null || scheduled === date || isHistory(task) || isRecurringTask(task)) continue;
      if (scheduled >= localDate()) out.yielded.push({ print, to: scheduled });
      else if (schedulesFromLine(task, found, date)) out.schedule.push(task);
      continue;
    }
    if (linkedBase.has(print)) continue;
    if (spend(lineCredit, task)) continue;
    if (adopted && task.scheduled !== null) continue;
    if (schedulesFromLine(task, found, date)) out.schedule.push(task);
  }
  for (const print of linkedBase) {
    if (lines.has(print) || held.has(print)) continue;
    const own = taskOfPrint(prints, print);
    const task = own ?? resolve(print);
    if (task === null || leaving.has(task.id) || isRecurringTask(task) || isHistory(task) || task.scheduled !== date) continue;
    if (own === null && (lines.has(fingerprint(task)) || linkedBase.has(fingerprint(task)) || held.has(fingerprint(task)))) continue;
    leaving.add(task.id);
    const move = movedFrom.get(print);
    if (move === undefined) out.unschedule.push(task);
    else out.restore.push({ task, to: move.from, ...(move.token !== undefined ? { token: move.token } : {}) });
    out.removed += 1;
  }
  for (const print of datedBase) {
    if (datedNow.has(print) || !linkedBase.has(print)) continue;
    const found = lines.get(print);
    if (found === undefined || found.length !== 1) continue;
    const member = found[0] as MemberLine;
    if (member.child === true || isRecurringTask(member.task) || member.entry.recurring || member.task.scheduled === date || isHistory(member.task) || member.entry.checkbox === "done") continue;
    out.drop.push(member.line);
    out.projects.add(member.task.projectId);
    for (const child of datedChildren(member, date)) {
      out.unschedule.push(child);
      leaving.add(child.id);
    }
  }
  for (const [print, task] of datedNow) {
    if (lines.has(print) || linkedBase.has(print) || leaving.has(task.id)) continue;
    const fresh = !datedBase.has(print) && !spend(dateCredit, task);
    if (!fresh && !hints.has(task.id)) continue;
    out.insert.add(task.id);
    if (fresh && !hints.has(task.id) && !adopted) out.projects.add(task.projectId);
  }
  return out;
}

function yieldTo(settings: DelegationSettings, date: string, print: string, to: string): void {
  const path = dailyFile(settings, date);
  const baseline = path === null ? null : loadBaseline(date, path);
  const sync = baseline?.state.sync;
  if (path === null || baseline === null || sync === undefined) return;
  const others = (sync.yielded ?? []).filter((item) => item.print !== print);
  const yielded = sync.linked.includes(print) ? [...others, { print, to }] : others;
  const next: SyncSets = {
    linked: sync.linked,
    dated: sync.dated.filter((item) => item !== print),
    ...(sync.held !== undefined ? { held: sync.held } : {}),
    ...(yielded.length > 0 ? { yielded } : {}),
    ...(sync.moved !== undefined ? { moved: sync.moved } : {}),
    ...(sync.adopted === true ? { adopted: true } : {}),
  };
  storeBaseline(date, path, { content: baseline.content, state: { ...baseline.state, sync: next } });
}

function writeScheduled(settings: DelegationSettings, task: BoardTask, scheduled: string | null, moves = false): BoardTask {
  const written = writeScheduledToken(settings, { projectId: task.projectId, line: task.line, raw: task.raw, scheduled });
  const from = task.scheduled;
  if (moves && scheduled !== null && from !== null && from !== scheduled && isCurrentOrFuture(from)) yieldTo(settings, from, fingerprint(task), scheduled);
  return written.task;
}

let committingFor: string | null = null;

function applyDates(settings: DelegationSettings, date: string, plan: Reconciled): number {
  let written = 0;
  const restoreToken = (task: BoardTask, token: string): boolean => {
    if (isScheduledManual(task.raw, settings.tasks)) return true;
    try {
      writeScheduledTokenText(settings, { projectId: task.projectId, line: task.line, raw: task.raw, token });
      written += 1;
      return true;
    } catch (err) {
      console.error(`focus mirror could not restore the scheduled token of ${task.id} from the daily of ${date}: ${errorText(err)}`);
      return false;
    }
  };
  const write = (task: BoardTask, scheduled: string | null, moves: boolean): void => {
    if (isScheduledManual(task.raw, settings.tasks)) return;
    try {
      writeScheduled(settings, task, scheduled, moves);
      written += 1;
    } catch (err) {
      console.error(`focus mirror could not ${scheduled === null ? "unschedule" : "schedule"} ${task.id} from the daily of ${date}: ${errorText(err)}`);
    }
  };
  committingFor = date;
  try {
    for (const task of plan.schedule) write(task, date, true);
    for (const task of plan.unschedule) write(task, null, true);
    for (const item of plan.restore) if (item.token === undefined || !restoreToken(item.task, item.token)) write(item.task, item.to, false);
  } finally {
    committingFor = null;
  }
  return written;
}

function movesAfter(settings: DelegationSettings, base: SyncSets, plan: Reconciled, data: BoardData, date: string): StoredMove[] {
  const prints = printIndex(data);
  const restored = new Set(plan.restore.map((item) => fingerprint(item.task)));
  const fresh = plan.schedule.flatMap((task): StoredMove[] => {
    const token = scheduledTokenOf(task.raw, settings.tasks);
    const from = task.scheduled !== null && task.scheduled !== date ? task.scheduled : null;
    if (token === null && from === null) return [];
    return [{ print: fingerprint(task), from, ...(token !== null ? { token } : {}) }];
  });
  const kept = (base.moved ?? []).filter((item) => !restored.has(item.print) && !fresh.some((other) => other.print === item.print));
  return [...kept, ...fresh].filter((item) => taskOfPrint(prints, item.print)?.scheduled === date);
}

function blockLength(content: string, line: number): number {
  return Math.max(1, taskBlock(content, line).split(LINE_SPLIT_RE).length);
}

function lineBlocks(texts: readonly string[], from: number, to: number): [number, number][] {
  const content = texts.join("\n");
  const blocks: [number, number][] = [];
  let index = from;
  while (index < to) {
    if (isBlankText(texts[index])) {
      index += 1;
      continue;
    }
    const end = Math.min(index + blockLength(content, index), to);
    blocks.push([index, end]);
    index = end;
  }
  return blocks;
}

function dropBlocks(doc: ParsedDoc, content: string, starts: number[], mirrors: ReadonlyMap<number, ReadonlySet<number>> | null = null): number {
  const originals = [...doc.lines];
  const doomed = new Set<DocLine>();
  for (const start of starts) {
    const length = blockLength(content, start);
    const own = mirrors?.get(start) ?? null;
    const headLead = leadOf(originals[start]?.text ?? "");
    const freed: { width: number; lead: string; prefix: string }[] = [];
    for (let index = start; index < start + length; index += 1) {
      const line = originals[index];
      if (!line) continue;
      if (own === null || index === start || own.has(index)) {
        doomed.add(line);
        continue;
      }
      if (isBlankText(line.text)) continue;
      const lead = leadOf(line.text);
      const width = indentWidth(line.text);
      while (freed.length > 0 && (freed[freed.length - 1] as { width: number }).width >= width) freed.pop();
      const parent = freed[freed.length - 1];
      const prefix = parent === undefined ? headLead : parent.prefix + (lead.length > parent.lead.length ? lead.slice(parent.lead.length) : SUBTASK_INDENT);
      freed.push({ width, lead, prefix });
      line.text = prefix + line.text.slice(lead.length);
    }
  }
  if (doomed.size === 0) return 0;
  const kept: DocLine[] = [];
  let cut = false;
  for (const line of originals) {
    if (doomed.has(line)) {
      cut = true;
      continue;
    }
    const previous = kept[kept.length - 1];
    if (cut && previous !== undefined && isBlankText(previous.text) && isBlankText(line.text)) {
      cut = false;
      continue;
    }
    cut = false;
    kept.push(line);
  }
  doc.lines.splice(0, doc.lines.length, ...kept);
  return doomed.size;
}

function hubCopies(content: string, texts: string[], plan: TickPlan, members: MemberLine[], inserted: readonly string[]): number[] {
  if (inserted.length === 0) return [];
  const written = new Set(inserted);
  const fresh = new Set(members.filter((member) => plan.pairs.get(member.line) === undefined).map((member) => member.task.id));
  const taken = new Set<string>();
  const out: number[] = [];
  for (const member of members) {
    const text = texts[member.line] as string;
    const base = plan.pairs.get(member.line);
    if (base === undefined || plan.baseTexts[base] !== text || !written.has(text)) continue;
    if (!fresh.has(member.task.id) || taken.has(member.task.id) || out.includes(member.line) || blockLength(content, member.line) !== 1) continue;
    taken.add(member.task.id);
    out.push(member.line);
  }
  return out;
}

function userTouched(content: string, finalTexts: readonly string[], candidates: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  finalTexts.forEach((text, index) => {
    if (!candidates.has(text)) return;
    const block = taskBlock(content, index).split(LINE_SPLIT_RE).slice(1);
    if (block.some((line) => line.trim() !== "" && !candidates.has(line))) out.add(text);
  });
  return out;
}

function hubInserted(previous: readonly string[], pruned: readonly string[], added: readonly string[], finalTexts: readonly string[], touched: ReadonlySet<string>): string[] {
  const left = new Map<string, number>();
  for (const text of finalTexts) left.set(text, (left.get(text) ?? 0) + 1);
  const removed = [...pruned];
  const out: string[] = [];
  for (const text of [...previous, ...added]) {
    const at = removed.indexOf(text);
    if (at !== -1) {
      removed.splice(at, 1);
      continue;
    }
    const count = left.get(text) ?? 0;
    if (count === 0 || touched.has(text)) continue;
    left.set(text, count - 1);
    out.push(text);
  }
  return out;
}

function mirrorLines(members: MemberLine[], starts: number[]): Map<number, ReadonlySet<number>> {
  const out = new Map<number, ReadonlySet<number>>();
  for (const start of starts) {
    const member = members.find((item) => item.line === start);
    out.set(start, new Set((member?.entry.children ?? []).filter((child) => child.task !== null && !isHistory(child.task)).map((child) => child.line)));
  }
  return out;
}

function syncSetsAfter(
  settings: DelegationSettings,
  date: string,
  content: string,
  data: BoardData,
  kept: ReadonlySet<string>,
  held: ReadonlyMap<string, string>,
  yielded: StoredYield[],
  moved: StoredMove[],
): SyncSets {
  const scan = scanDaily(settings, date, content, data.projects, data.tasks);
  const linked = new Set([...kept, ...printsOf(withChildren(memberLines(settings, date, scan, null, kept), date).map((member) => member.task)), ...held.keys()]);
  const holds = [...held].map(([print, line]): StoredHold => ({ print, line }));
  const yields = yielded.filter((item) => linked.has(item.print));
  const moves = moved.filter((item) => linked.has(item.print));
  return {
    linked: [...linked],
    dated: printsOf(datedTasks(data, date)),
    ...(holds.length > 0 ? { held: holds } : {}),
    ...(yields.length > 0 ? { yielded: yields } : {}),
    ...(moves.length > 0 ? { moved: moves } : {}),
  };
}

const BOM_CHAR = "\uFEFF";
const DEFAULT_STABLE_MS = 3000;

interface StableWait {
  content: string;
  timer: NodeJS.Timeout;
}

let stableDelayMs = DEFAULT_STABLE_MS;
let stableReread: DailyReread | null = null;
const stableWaits = new Map<string, StableWait>();

export function setFocusStability(options: FocusStabilityOptions): void {
  if (options.delayMs !== undefined) stableDelayMs = Math.max(0, options.delayMs);
  if (options.reread !== undefined) stableReread = options.reread;
}

function rereadDaily(settings: DelegationSettings, date: string): string | null {
  const daily = readDailySafe(settings, date);
  return daily !== null && daily.exists ? daily.content : null;
}

function waitForStable(date: string, content: string, source: MirrorSource): void {
  const current = stableWaits.get(date);
  if (current !== undefined && current.content === content) return;
  if (current !== undefined) clearTimeout(current.timer);
  const timer = setTimeout(() => {
    stableWaits.delete(date);
    runMirror(getSettings(), date, { source, stable: content });
  }, stableDelayMs);
  timer.unref();
  stableWaits.set(date, { content, timer });
}

function isStable(settings: DelegationSettings, date: string, content: string, options: MirrorOptions): boolean {
  if (options.source === "client" || options.stable === content) return true;
  if (stableDelayMs > 0) {
    waitForStable(date, content, options.source ?? "api");
    return false;
  }
  return (stableReread ?? rereadDaily)(settings, date) === content;
}

function isFirstSightStable(settings: DelegationSettings, date: string, content: string, options: MirrorOptions): boolean {
  const source = options.source ?? "api";
  if (source === "client" || options.stable === content) return true;
  if (source === "api") return (stableReread ?? rereadDaily)(settings, date) === content;
  return isStable(settings, date, content, options);
}

const HUB_WRITE_LIMIT = 64;
const STABLE_SEPARATOR = `${KEY_SEPARATOR}${KEY_SEPARATOR}`;
const MISSING_DAILY_KEY = `${STABLE_SEPARATOR}missing`;
const hubWrites = new Set<string>();

function isGoneForGood(settings: DelegationSettings, date: string, options: MirrorOptions): boolean {
  if (options.stable === MISSING_DAILY_KEY) return true;
  if (stableDelayMs > 0) {
    waitForStable(date, MISSING_DAILY_KEY, options.source ?? "api");
    return false;
  }
  return (stableReread ?? rereadDaily)(settings, date) === null;
}

const contentHash = (content: string): string => createHash("sha1").update(content).digest("hex");

function rememberHubWrite(content: string): void {
  const hash = contentHash(content);
  hubWrites.delete(hash);
  hubWrites.add(hash);
  while (hubWrites.size > HUB_WRITE_LIMIT) {
    const oldest = hubWrites.values().next().value;
    if (oldest === undefined) break;
    hubWrites.delete(oldest);
  }
}

function projectsKey(settings: DelegationSettings, projectIds: ReadonlySet<string>): string | null {
  const parts: string[] = [];
  for (const projectId of [...projectIds].sort()) {
    let state: ProjectFileState;
    try {
      state = readProjectState(settings, projectId);
    } catch {
      return null;
    }
    const body = state.content.startsWith(BOM_CHAR) ? state.content.slice(BOM_CHAR.length) : state.content;
    if (body.trim() === "") return null;
    if (hubWrites.has(contentHash(state.content))) continue;
    parts.push(`${state.rel}${KEY_SEPARATOR}${state.content}`);
  }
  return parts.join(KEY_SEPARATOR);
}

function isSettled(settings: DelegationSettings, date: string, content: string, plan: Reconciled, projectPart: string, options: MirrorOptions, pruning: boolean): boolean {
  const removal = plan.removed > 0 || pruning;
  if (projectPart === "" && !removal && plan.schedule.length === 0) return true;
  const key = projectPart === "" ? content : `${content}${STABLE_SEPARATOR}${projectPart}`;
  if (options.stable === key) return true;
  const source = options.source ?? "api";
  if (projectPart === "" && source === "client") return true;
  if (projectPart === "" && !removal && source === "api") return (stableReread ?? rereadDaily)(settings, date) === content;
  if (stableDelayMs > 0) {
    waitForStable(date, key, source);
    return false;
  }
  const daily = source === "client" ? content : (stableReread ?? rereadDaily)(settings, date);
  return daily === content && (projectPart === "" || projectsKey(settings, plan.projects) === projectPart);
}

const hasFrontmatter = (content: string): boolean => (splitLines(content.startsWith(BOM_CHAR) ? content.slice(BOM_CHAR.length) : content)[0] ?? "").trim() === "---";

function isSaneDaily(settings: DelegationSettings, content: string, previous: string | null): boolean {
  if (content.trim() === "" || content.trim() === BOM_CHAR) return false;
  if (focusRange(splitLines(content), settings) === null) return false;
  return previous === null || !hasFrontmatter(previous) || hasFrontmatter(content);
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
    if (daily !== null && !daily.exists && getTodayBaseline(date) !== null && isGoneForGood(settings, date, options)) {
      deleteTodayBaseline(date);
      setGone(date, true);
    }
    if (daily === null || !daily.exists) return skip("no-daily");
    let data = loadBoardData(settings);
    if (data === null) return skip("no-board");
    const stored = isGone(date) ? null : loadBaseline(date, daily.path);
    if (!isSaneDaily(settings, daily.content, stored?.content ?? null)) return skip("unsettled");
    if (stored === null && !isFirstSightStable(settings, date, daily.content, options)) return skip("unsettled");
    const baseline = stored ?? adoptBaseline(settings, date, daily.path, daily.content, data, true);
    const texts = splitLines(daily.content);
    let scan = scanDaily(settings, date, daily.content, data.projects, data.tasks);
    const firstPlan = planTicks(settings, date, baseline, texts, scan, data);
    const members = memberLines(settings, date, scan, firstPlan, new Set(baseline.state.sync?.linked ?? []));
    const synced = withChildren(members, date);
    const datedNow = datedTasks(data, date);
    const base = baseline.state.sync ?? legacySets(settings, date, baseline, data, synced, datedNow);
    const memberPrints = new Set(printsOf(synced.map((member) => member.task)));
    const vanished = new Set(base.linked.filter((print) => !memberPrints.has(print)));
    const held = heldPrints(scan, synced, data, firstPlan, texts, base.held ?? [], vanished);
    const resolver: ResolveContext = { data, lineage: lineageOf(data), prints: printIndex(data), known: new Set(baseline.state.known), claimed: new Set(scan.links.map((link) => link.task.id)), date };
    const memos = new Map<string, MarkMemo>();
    for (const memo of Object.values(baseline.state.marks)) if (!memos.has(memo.task)) memos.set(memo.task, memo);
    const resolve = (print: string): BoardTask | null => {
      const memo = memos.get(print);
      return memo === undefined ? null : resolveMemo(memo, resolver);
    };
    const reconciled = reconcile(date, base, synced, datedNow, data, options.hints ?? new Set<string>(), new Set(held.keys()), resolve);
    const pruned = hubCopies(daily.content, texts, firstPlan, synced, baseline.state.inserted ?? []).filter((line) => !reconciled.drop.includes(line));
    const projectPart = reconciled.projects.size === 0 ? "" : projectsKey(settings, reconciled.projects);
    if (projectPart === null || !isSettled(settings, date, daily.content, reconciled, projectPart, options, pruned.length > 0)) return skip("unsettled");
    if (applyDates(settings, date, reconciled) > 0) {
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
    const drops = [...reconciled.drop, ...pruned];
    dropBlocks(doc, daily.content, drops, mirrorLines(members, drops));
    const allowed = renderDoc(doc);
    const present = presenceOf(scanDaily(settings, date, allowed, data.projects, data.tasks)).lines;
    const wanted = computeFocus(settings, data, date).filter((entry) => reconciled.insert.has(entry.task.id) || present.has(entry.task.id));
    const prior = new Set(doc.lines);
    const insertion = insertMissing(settings, date, doc, data, wanted, baseline.state, reconciled.insert);
    const added = doc.lines.filter((line) => !prior.has(line)).map((line) => line.text);
    const next = renderDoc(doc);
    if (!keepsEveryLine(allowed, next)) {
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
    const candidates = new Set([...(baseline.state.inserted ?? []), ...added]);
    const inserted = hubInserted(baseline.state.inserted ?? [], pruned.map((line) => texts[line] as string), added, finalTexts, userTouched(next, finalTexts, candidates));
    storeBaseline(date, daily.path, {
      content: renderDoc(baseDoc),
      state: {
        ...(inserted.length > 0 ? { inserted } : {}),
        marks,
        seen: mergeSeen(baseline.state.seen, [...linkedTasks(finalScan), ...insertion.inserted, ...insertion.renamed]),
        focus: focusMemory(computeFocus(settings, data, date)),
        outOfSync,
        duplicates,
        known: knownPrints(data, marks),
        unresolved,
        unmatched: nextUnmatched(baseline.state.unmatched, found, finalTexts, unmatchedFilter(finalTexts, finalScan, data, { outOfSync, duplicates, unresolved, dismissed })),
        dismissed,
        sync: syncSetsAfter(
          settings,
          date,
          next,
          data,
          new Set(printsOf(synced.filter((member) => !reconciled.drop.includes(member.entry.line)).map((member) => member.task))),
          held,
          reconciled.yielded,
          movesAfter(settings, base, reconciled, data, date),
        ),
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
  for (const date of dates) if (date !== committingFor) scheduleMirror(date, "board");
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
  return anyFold((fold) => {
    const needle = taskNeedle(text, settings.tasks, fold);
    return needle === fold(task.title) || needle === fold(joinReason(task.title, task.reason, settings.tasks.reasonSeparator));
  });
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
      writeScheduled(settings, task, date, true);
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
    committed: (previous: string, next: string) => {
      rememberHubWrite(next);
      queueScheduledDates(previous, next);
    },
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

interface PlacedEntry {
  entry: TodayEntry;
  line: number;
}

function memberEntries(settings: DelegationSettings, data: BoardData, date: string, members: MemberLine[]): PlacedEntry[] {
  const projects = new Map(data.projects.map((project) => [project.id, project]));
  const parents = parentMap(data.tasks);
  const rank = new Map(effectiveProjectOrder(data.projects, settings.daily.projectOrder).map((id, index) => [id, index]));
  const occurrences = flattenTasks(data.tasks).filter((task) => isOccurrence(task) && task.doneAt === date);
  const ids = new Set(members.map((member) => member.task.id));
  const seen = new Set<string>();
  const out: { placed: PlacedEntry; rank: number }[] = [];
  for (const member of members) {
    let covered = false;
    for (let parent = parents.get(member.task.id) ?? null; parent !== null; parent = parents.get(parent.id) ?? null) if (ids.has(parent.id)) covered = true;
    if (covered) continue;
    const task = member.entry.recurred ? (occurrences.find((item) => fingerprint(item) === fingerprint(member.task)) ?? member.task) : member.task;
    const project = projects.get(task.projectId);
    if (seen.has(task.id) || !project) continue;
    seen.add(task.id);
    out.push({
      placed: { entry: { task, project: { id: project.id, title: project.title, name: project.name }, parentTitle: parents.get(task.id)?.title ?? null }, line: member.line },
      rank: rank.get(task.projectId) ?? Number.POSITIVE_INFINITY,
    });
  }
  return out.sort((a, b) => (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1)).map(({ placed }) => placed);
}

interface DailyFocus {
  entries: TodayEntry[];
  lines: Set<number>;
}

function dailyFocus(settings: DelegationSettings, date: string, daily: DailyReadResult, data: BoardData): DailyFocus {
  const members = dayMembers(settings, date, daily, data).members;
  return { entries: memberEntries(settings, data, date, members).map((item) => item.entry), lines: new Set(members.map((member) => member.line)) };
}

function focusFor(settings: DelegationSettings, date: string): TodayEntry[] {
  const data = loadBoardData(settings);
  if (data !== null && usesMirror(settings, date)) {
    const daily = readDailySafe(settings, date);
    if (daily !== null && daily.exists) return dailyFocus(settings, date, daily, data).entries;
  }
  return computeFocus(settings, data, date);
}

interface NoteView {
  inNote: string[];
  inNoteLinks: TodayNoteLine[];
  noteBlocks: TodayNoteBlock[];
  unlinked: string[];
  ambiguous: TodayAmbiguous[];
}

function noteView(settings: DelegationSettings, date: string, daily: DailyReadResult, data: BoardData, focus: TodayEntry[], scheduled: boolean, memberAt: ReadonlySet<number>): NoteView {
  const content = daily.content;
  const texts = splitLines(content);
  const scan = scanDaily(settings, date, content, data.projects, data.tasks);
  const ambiguous: TodayAmbiguous[] = scan.entries
    .filter((entry) => entry.match.task === null && entry.match.candidates.length >= 2)
    .map((entry): TodayAmbiguous => ({ kind: "line", text: entry.raw, line: entry.line, taskId: null, reason: "several-tasks" }));
  if (scheduled && isCurrentOrFuture(date)) {
    const dated = computeFocus(settings, data, date);
    const memory: InsertMemory = loadBaseline(date, daily.path)?.state ?? { seen: mergeSeen([], linkedTasks(scan)), focus: focusMemory(dated) };
    ambiguous.push(...insertMissing(settings, date, openDoc(content), data, dated, memory, new Set<string>()).ambiguous);
  }
  const range = focusRange(texts, settings);
  if (!range) return { inNote: [], inNoteLinks: [], noteBlocks: [], unlinked: [], ambiguous };
  const focusIds = new Set(focus.flatMap((entry) => flattenTasks([entry.task]).map((task) => task.id)));
  const occurrences = new Set(focus.filter((entry) => isOccurrence(entry.task)).map((entry) => fingerprint(entry.task)));
  const entries = new Map(scan.entries.map((entry) => [entry.line, entry]));
  const inNote: string[] = [];
  const inNoteLinks: TodayNoteLine[] = [];
  const noteBlocks: TodayNoteBlock[] = [];
  const unlinked: string[] = [];
  let index = range.heading + 1;
  while (index < range.end) {
    if (isBlankText(texts[index])) {
      index += 1;
      continue;
    }
    const length = blockLength(content, index);
    const end = Math.min(index + length, range.end);
    const entry = entries.get(index);
    const task = entry?.match.task ?? null;
    const focused = memberAt.has(index) || (task !== null && (focusIds.has(task.id) || (entry?.recurred === true && occurrences.has(fingerprint(task)))));
    if (!focused) {
      const head = index;
      const linkedId = task !== null && entry?.held !== true ? task.id : null;
      const kept = texts.slice(index, end).flatMap((text, offset) => (isBlankText(text) || isPlaceholderLine(text) ? [] : [{ text, at: head + offset }]));
      const lines = kept.map((item) => item.text);
      inNote.push(...lines);
      inNoteLinks.push(...kept.map((item): TodayNoteLine => ({ line: item.text, taskId: item.at === head ? linkedId : null })));
      const first = kept[0];
      if (first !== undefined) {
        const ownHead = first.at === head;
        noteBlocks.push({
          line: first.text,
          lineIndex: first.at,
          taskId: ownHead ? linkedId : null,
          projectId: ownHead ? (entry?.projectId ?? null) : null,
          text: ownHead ? (entry?.text ?? null) : null,
          children: kept.slice(1).map((item) => item.text),
        });
      }
      if (task === null) unlinked.push(...lines);
    }
    index = end;
  }
  return { inNote, inNoteLinks, noteBlocks, unlinked, ambiguous };
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
  insertMissing(settings, date, doc, data, focus, { seen: [], focus: [] }, new Set<string>(), true);
  return renderDoc(doc);
}

function createDailyFile(settings: DelegationSettings, date: string): DailyReadResult {
  const daily = readDaily(settings, date);
  if (daily.exists) return daily;
  writeDaily(settings, date, initialContent(settings, date), undefined, `create-${randomUUID().slice(0, 8)}`, "server");
  const created = readDaily(settings, date);
  const data = created.exists && usesMirror(settings, date) && loadBaseline(date, created.path) === null ? loadBoardData(settings) : null;
  if (data !== null) adoptBaseline(settings, date, created.path, created.content, data);
  return created;
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

interface DayMembers {
  scan: FocusScan;
  members: MemberLine[];
}

function dayMembers(settings: DelegationSettings, date: string, daily: DailyReadResult, data: BoardData): DayMembers {
  const baseline = loadBaseline(date, daily.path);
  const scan = scanDaily(settings, date, daily.content, data.projects, data.tasks);
  const plan = baseline === null ? null : planTicks(settings, date, baseline, splitLines(daily.content), scan, data);
  return { scan, members: memberLines(settings, date, scan, plan, new Set(baseline?.state.sync?.linked ?? [])) };
}

function membersOf(members: MemberLine[], task: BoardTask): MemberLine[] {
  const own = members.filter((member) => member.task.id === task.id);
  if (own.length > 0) return own;
  return members.filter((member) => fingerprint(member.task) === fingerprint(task));
}

function writeFocusDoc(settings: DelegationSettings, date: string, daily: DailyReadResult, next: string, tag: string): void {
  if (next === daily.content) return;
  writeDaily(settings, date, next, daily.updatedAt ?? undefined, `${tag}-${randomUUID().slice(0, 8)}`, "server");
}

function leaveDaily(settings: DelegationSettings, date: string, task: BoardTask, keepNotes: boolean): BoardTask[] | null {
  const daily = readDailySafe(settings, date);
  const data = loadBoardData(settings);
  if (daily === null || !daily.exists || data === null) return null;
  const own = membersOf(dayMembers(settings, date, daily, data).members, task);
  if (own.length === 0) return null;
  const doc = openDoc(daily.content);
  const starts = own.map((member) => member.line);
  dropBlocks(doc, daily.content, starts, keepNotes ? mirrorLines(own, starts) : null);
  writeFocusDoc(settings, date, daily, renderDoc(doc), "leave");
  return own.flatMap((member) => datedChildren(member, date)).filter((child) => child.id !== task.id);
}

function entryOf(data: BoardData, task: BoardTask): TodayEntry | null {
  const project = data.projects.find((candidate) => candidate.id === task.projectId);
  if (!project) return null;
  return { task, project: { id: project.id, title: project.title, name: project.name }, parentTitle: parentMap(data.tasks).get(task.id)?.title ?? null };
}

function enterDaily(settings: DelegationSettings, date: string, task: BoardTask): void {
  const daily = readDailySafe(settings, date);
  const data = loadBoardData(settings);
  if (daily === null || !daily.exists || data === null) return;
  const fresh = flattenTasks(data.tasks).find((candidate) => candidate.id === task.id && candidate.raw === task.raw);
  if (fresh === undefined) return;
  if (presenceOf(scanDaily(settings, date, daily.content, data.projects, data.tasks)).lines.has(fresh.id)) return;
  const entry = entryOf(data, fresh);
  if (entry === null) return;
  const doc = openDoc(daily.content);
  insertMissing(settings, date, doc, data, [entry], { seen: [], focus: [] }, new Set([fresh.id]));
  const next = renderDoc(doc);
  if (keepsEveryLine(daily.content, next)) writeFocusDoc(settings, date, daily, next, "enter");
}

function schedule(settings: DelegationSettings, input: ScheduleInput): { task: BoardTask } {
  if (input.date !== null) validateDate(input.date);
  if (input.from !== undefined) validateDate(input.from);
  const manual = scheduledManualReason(input.raw, settings.tasks);
  if (manual !== null) throw new BadRequestError(manual);
  const before = loadBoardData(settings);
  const old = before ? flattenTasks(before.tasks).find((task) => task.projectId === input.projectId && task.line === input.line) : undefined;
  const from = input.from ?? old?.scheduled ?? null;
  let left: BoardTask[] | null = null;
  if (old !== undefined && old.raw === input.raw) {
    if (from !== null && from !== input.date && usesMirror(settings, from)) left = leaveDaily(settings, from, old, input.date !== null);
    if (input.date !== null && usesMirror(settings, input.date)) enterDaily(settings, input.date, old);
  }
  const keepDate = old !== undefined && left !== null && input.date === null && old.scheduled !== from;
  const task = keepDate ? old : writeScheduledToken(settings, { projectId: input.projectId, line: input.line, raw: input.raw, scheduled: input.date }).task;
  for (const child of left ?? []) {
    try {
      writeScheduled(settings, child, input.date);
    } catch (err) {
      console.error(`could not move the subtask ${child.id} with its parent: ${errorText(err)}`);
    }
  }
  const hints = new Set(input.date === null ? [] : [task.id]);
  const dates = new Set([old?.scheduled ?? null, from, input.date].filter((date): date is string => date !== null && isCurrentOrFuture(date)));
  for (const date of dates) runMirror(settings, date, { source: "api", hints: date === input.date ? hints : new Set<string>() });
  return { task };
}

interface ClearedFile {
  projectId: string;
  rel: string;
  before: string;
  after: string;
}

interface ClearUndo {
  date: string;
  path: string;
  before: string;
  after: string;
  files: ClearedFile[];
  baseline: { content: string; state: string } | null;
  at: number;
}

const CLEAR_KEEP_MS = 30 * 60 * 1000;
const CLEAR_LIMIT = 20;
const CLEAR_UNDO_KEY = "today.clearUndo";

function isClearedFile(value: unknown): value is ClearedFile {
  return isRecord(value) && typeof value.projectId === "string" && typeof value.rel === "string" && typeof value.before === "string" && typeof value.after === "string";
}

function parseClearUndo(value: unknown): ClearUndo | null {
  if (!isRecord(value) || typeof value.date !== "string" || typeof value.path !== "string" || typeof value.before !== "string" || typeof value.after !== "string") return null;
  if (typeof value.at !== "number" || !Array.isArray(value.files) || !value.files.every(isClearedFile)) return null;
  const baseline = isRecord(value.baseline) && typeof value.baseline.content === "string" && typeof value.baseline.state === "string" ? { content: value.baseline.content, state: value.baseline.state } : null;
  return { date: value.date, path: value.path, before: value.before, after: value.after, files: value.files, baseline, at: value.at };
}

function loadClearUndos(): Map<string, ClearUndo> {
  const out = new Map<string, ClearUndo>();
  const raw = getSetting(CLEAR_UNDO_KEY);
  if (raw === null) return out;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!isRecord(value)) return out;
  const now = Date.now();
  for (const [token, item] of Object.entries(value)) {
    const undo = parseClearUndo(item);
    if (undo !== null && now - undo.at <= CLEAR_KEEP_MS) out.set(token, undo);
  }
  return out;
}

function saveClearUndos(undos: Map<string, ClearUndo>): void {
  setSetting(CLEAR_UNDO_KEY, undos.size === 0 ? null : JSON.stringify(Object.fromEntries(undos)));
}

function requireMirrorDay(settings: DelegationSettings, date: string): void {
  requireDailyFeature(settings);
  validateDate(date);
  if (!usesMirror(settings, date)) throw new BadRequestError("only the scheduled focus of today or a later day can be changed here");
}

function rememberClear(undo: ClearUndo): string {
  const undos = loadClearUndos();
  while (undos.size >= CLEAR_LIMIT) {
    const oldest = undos.keys().next().value;
    if (oldest === undefined) break;
    undos.delete(oldest);
  }
  const token = randomUUID();
  undos.set(token, undo);
  saveClearUndos(undos);
  return token;
}

function projectStates(settings: DelegationSettings, projectIds: Iterable<string>): Map<string, ProjectFileState> {
  const out = new Map<string, ProjectFileState>();
  for (const projectId of projectIds) {
    try {
      out.set(projectId, readProjectState(settings, projectId));
    } catch (err) {
      console.error(`clear could not read the project ${projectId}: ${errorText(err)}`);
    }
  }
  return out;
}

function clearToday(settings: DelegationSettings, date: string): ClearTodayResult {
  requireMirrorDay(settings, date);
  const existing = readDaily(settings, date);
  if (!existing.exists) throw new NotFoundError("daily not found");
  runMirror(settings, date, { source: "api" });
  const daily = readDaily(settings, date);
  const data = loadBoardData(settings);
  if (data === null) throw new BadRequestError("the tasks board is not available");
  const baseline = loadBaseline(date, daily.path);
  const members = dayMembers(settings, date, daily, data).members.filter((member) => !isHistory(member.task));
  const doc = openDoc(daily.content);
  dropBlocks(doc, daily.content, [...new Set(members.map((member) => member.line))]);
  writeFocusDoc(settings, date, daily, renderDoc(doc), "clear");
  const doomed = flattenTasks(data.tasks).filter((task) => task.scheduled === date && !isRecurringTask(task) && !isHistory(task) && !isScheduledManual(task.raw, settings.tasks));
  const before = projectStates(settings, new Set(doomed.map((task) => task.projectId)));
  let unscheduled = 0;
  for (const task of doomed) {
    try {
      writeScheduled(settings, task, null);
      unscheduled += 1;
    } catch (err) {
      console.error(`clear could not unschedule ${task.id}: ${errorText(err)}`);
    }
  }
  runMirror(settings, date, { source: "api" });
  const settled = readDaily(settings, date);
  const after = projectStates(settings, before.keys());
  const files: ClearedFile[] = [...before.values()].flatMap((state) => {
    const now = after.get(state.projectId);
    return now === undefined || now.content === state.content ? [] : [{ projectId: state.projectId, rel: state.rel, before: state.content, after: now.content }];
  });
  const stored = baseline === null ? null : { content: baseline.content, state: JSON.stringify(baseline.state) };
  const token = rememberClear({ date, path: daily.path, before: daily.content, after: settled.content, files, baseline: stored, at: Date.now() });
  return { token, lines: members.length, unscheduled };
}

function undoClear(settings: DelegationSettings, date: string, token: string): UndoClearResult {
  requireMirrorDay(settings, date);
  const undos = loadClearUndos();
  const undo = undos.get(token);
  if (undo === undefined || undo.date !== date) throw new NotFoundError("nothing to undo");
  const daily = readDaily(settings, date);
  const vault = dailyRoot(settings);
  const dailyName = vault === null ? undo.path : relative(vault, undo.path).split(sep).join("/");
  if (!daily.exists || daily.path !== undo.path || daily.content !== undo.after) throw new StaleTodayLineError(`${dailyName} changed after Clear today, nothing was restored`);
  for (const file of undo.files) {
    let current: string | null = null;
    try {
      current = readProjectState(settings, file.projectId).content;
    } catch {
      current = null;
    }
    if (current !== file.after) throw new StaleTodayLineError(`${file.rel} changed after Clear today, nothing was restored`);
  }
  writeDaily(settings, date, undo.before, daily.updatedAt ?? undefined, `undo-${randomUUID().slice(0, 8)}`, "server");
  for (const file of undo.files) replaceProjectFile(settings, file.projectId, file.after, file.before);
  undos.delete(token);
  saveClearUndos(undos);
  const state = undo.baseline === null ? null : parseState(undo.baseline.state);
  if (undo.baseline !== null && state !== null) storeBaseline(date, undo.path, { content: undo.baseline.content, state });
  runMirror(settings, date, { source: "api" });
  return { restored: true };
}

function blockRange(content: string, line: number): [number, number] {
  return [line, line + blockLength(content, line)];
}

function reorderFocus(settings: DelegationSettings, date: string, input: ReorderInput): ReorderResult {
  requireMirrorDay(settings, date);
  if (input.direction !== "up" && input.direction !== "down") throw new BadRequestError("direction must be up or down");
  const daily = readDaily(settings, date);
  if (!daily.exists) throw new NotFoundError("daily not found");
  const data = loadBoardData(settings);
  if (data === null) throw new BadRequestError("the tasks board is not available");
  const task = flattenTasks(data.tasks).find((candidate) => candidate.projectId === input.projectId && candidate.line === input.line);
  if (!task || task.raw !== input.raw) throw new TaskConflictError(task ?? null);
  const placed = memberEntries(settings, data, date, dayMembers(settings, date, daily, data).members).filter((item) => item.entry.project.id === task.projectId);
  const at = placed.findIndex((item) => item.entry.task.id === task.id);
  const other = at === -1 ? undefined : placed[input.direction === "up" ? at - 1 : at + 1];
  if (at === -1 || other === undefined) return { moved: false };
  const own = placed[at] as PlacedEntry;
  const [ownStart, ownEnd] = blockRange(daily.content, own.line);
  const [otherStart, otherEnd] = blockRange(daily.content, other.line);
  const doc = openDoc(daily.content);
  const lines = [...doc.lines];
  const block = lines.slice(ownStart, ownEnd);
  const rest = [...lines.slice(0, ownStart), ...lines.slice(ownEnd)];
  const anchor = input.direction === "up" ? lines[otherStart] : lines[otherEnd - 1];
  const index = anchor === undefined ? -1 : rest.indexOf(anchor);
  if (index === -1 || block.length === 0) return { moved: false };
  rest.splice(input.direction === "up" ? index : index + 1, 0, ...block);
  doc.lines.splice(0, doc.lines.length, ...rest);
  writeFocusDoc(settings, date, daily, renderDoc(doc), "reorder");
  return { moved: true };
}

function migrationSkipOf(task: BoardTask, date: string): MigrationSkip["reason"] | null {
  if (task.scheduled !== null && isHistory(task)) return "scheduled-elsewhere";
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
  if (loadBaseline(date, daily.path) === null) adoptBaseline(settings, date, daily.path, daily.content, data, true);
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
    if (task.scheduled === date || task.repeat !== null) continue;
    const reason = migrationSkipOf(task, date);
    if (reason !== null) result.skipped.push({ taskId: task.id, title: task.title, scheduled: task.scheduled, reason });
    else {
      try {
        writeScheduled(settings, task, date, true);
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
  if (task !== null) scheduleMirror(date, "board");
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
  const mirrored = exists && data !== null && usesMirror(settings, date) ? dailyFocus(settings, date, daily as DailyReadResult, data) : null;
  const focus = mirrored !== null ? mirrored.entries : scheduledFocus ? computeFocus(settings, data, date) : exists && data ? listModeFocus(settings, date, daily as DailyReadResult, data) : [];
  const view: NoteView =
    exists && data ? noteView(settings, date, daily as DailyReadResult, data, focus, scheduledFocus, mirrored?.lines ?? new Set<number>()) : { inNote: [], inNoteLinks: [], noteBlocks: [], unlinked: [], ambiguous: [] };
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
    ...(view.noteBlocks.length > 0 ? { noteBlocks: view.noteBlocks } : {}),
    ambiguous: [...view.ambiguous, ...report.duplicates, ...report.unresolved],
    ...(report.outOfSync.length > 0 ? { outOfSync: report.outOfSync } : {}),
    ...(report.unmatched.length > 0 ? { unmatched: report.unmatched } : {}),
    summary: summaryOf(lines),
    dailyExists: exists,
    dailyUpdatedAt: exists ? ((daily as DailyReadResult).updatedAt ?? null) : null,
  };
}

export const todayApi: TodayApi = {
  focusOf: focusFor,
  carriedOver: (settings, date) => computeCarried(settings, loadBoardData(settings), date),
  schedule,
  regenerateFocusMirror,
  migrateFocus,
  appendCapture,
  promoteCapture,
  appendMeeting,
  createToday,
  linkTick,
  clearToday,
  undoClear,
  reorderFocus,
};
