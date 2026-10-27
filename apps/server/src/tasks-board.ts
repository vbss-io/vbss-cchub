import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import {
  findHeadingIndex,
  isPlaceholderLine,
  isValidDailyDate,
  parseTaskLines,
  readDaily,
  taskBlock,
  writeDaily,
  writeFileAtomic,
  type ComposeBoard,
  type DailyReadResult,
} from "./daily.js";
import { BadRequestError, delegateTask, NotFoundError } from "./delegation-launch.js";
import { TASKS_DATE_TOKEN, type DelegationSettings, type Runner, type TasksFeatureSettings } from "./delegation-types.js";
import { localDate } from "./second-brain.js";
import { broadcast } from "./sse.js";
import { isDirectory } from "./workspaces.js";

export const BOARD_STATUSES = ["blocked", "hold", "todo", "doing", "done", "archived"] as const;

export type BoardStatus = (typeof BOARD_STATUSES)[number];

export type BoardCheckbox = "todo" | "doing" | "done";

export type BoardSection = "open" | "done";

export interface BoardNoteItem {
  line: number;
  raw: string;
  text: string;
}

export interface BoardTask {
  id: string;
  projectId: string;
  line: number;
  raw: string;
  depth: number;
  checkbox: BoardCheckbox;
  prefix: string | null;
  status: BoardStatus;
  title: string;
  reason: string | null;
  section: BoardSection;
  doneAt: string | null;
  group: string | null;
  priority: number | null;
  start: string | null;
  scheduled: string | null;
  due: string | null;
  repeat: string | null;
  notes: string[];
  noteItems: BoardNoteItem[];
  subtasks: BoardTask[];
}

export interface BoardProject {
  id: string;
  name: string;
  title: string;
  parent: string | null;
  depth: number;
  path: string;
  workspace: string | null;
  workspaceSource: "own" | "inherited" | null;
}

export interface BoardToday {
  date: string;
  exists: boolean;
  taskIds: string[];
  states: Record<string, BoardCheckbox>;
  mismatch: string[];
}

export interface BoardPayload {
  enabled: boolean;
  root: string | null;
  configured: boolean;
  delegatePrompt: string;
  projects: BoardProject[];
  tasks: BoardTask[];
  errors: { path: string; error: string }[];
  today: BoardToday | null;
}

export interface BoardDates {
  start: string | null;
  scheduled: string | null;
  due: string | null;
  repeat: string | null;
}

export interface BoardChange {
  status?: BoardStatus;
  title?: string;
  reason?: string | null;
  priority?: number | null;
  start?: string | null;
  scheduled?: string | null;
  due?: string | null;
  repeat?: string | null;
}

export interface BoardWriteInput extends BoardChange {
  projectId: string;
  line: number;
  raw: string;
}

export interface BoardWriteResult {
  task: BoardTask;
  updatedAt: number;
  moved: boolean;
  recurred: boolean;
}

export interface BoardSyncedWriteResult extends BoardWriteResult {
  dailySynced: boolean;
}

export interface BoardCreateInput {
  projectId: string;
  title: string;
  status?: BoardStatus;
  reason?: string | null;
  priority?: number | null;
  start?: string | null;
  scheduled?: string | null;
  due?: string | null;
  repeat?: string | null;
  parentLine?: number;
  parentRaw?: string;
}

export interface BoardCreateResult {
  task: BoardTask;
  updatedAt: number;
}

export interface BoardNoteInput {
  projectId: string;
  line: number;
  raw: string;
  text: string;
}

export interface BoardNoteRemoveInput {
  projectId: string;
  line: number;
  raw: string;
}

export interface BoardNoteResult {
  task: BoardTask;
}

export interface BoardSweepResult {
  moved: number;
  projects: string[];
}

export type MoveDirection = "up" | "down";

export interface BoardItemRef {
  line: number;
  raw: string;
}

export interface BoardMoveInput {
  projectId: string;
  line: number;
  raw: string;
  direction: MoveDirection;
}

export interface BoardReparentInput {
  projectId: string;
  line: number;
  raw: string;
  parent: BoardItemRef | null;
}

export interface BoardMoveToProjectInput {
  projectId: string;
  line: number;
  raw: string;
  targetProjectId: string;
  parent: BoardItemRef | null;
}

export interface BoardOrganizeResult {
  task: BoardTask;
}

export interface DailyLinkChild {
  line: number;
  depth: number;
  raw: string;
  checkbox: BoardCheckbox;
  text: string;
  taskId: string | null;
  taskStatus: BoardStatus | null;
  mismatch: boolean;
}

export interface DailyLinkItem {
  line: number;
  raw: string;
  checkbox: BoardCheckbox;
  label: string | null;
  projectId: string | null;
  text: string;
  taskId: string | null;
  candidates: string[];
  taskStatus: BoardStatus | null;
  taskPriority: number | null;
  mismatch: boolean;
  recurredToday: boolean;
  children: DailyLinkChild[];
}

export interface DailyLinksResult {
  date: string;
  exists: boolean;
  path: string;
  items: DailyLinkItem[];
  taskIds: string[];
}

export interface AddToDailyInput {
  projectId: string;
  line: number;
  raw: string;
  date: string | null;
}

export interface AddToDailyResult {
  date: string;
  line: number;
  raw: string;
  subtasks: number;
}

export interface SyncDailyInput {
  projectId: string;
  line: number;
  raw: string;
  date: string | null;
}

export interface SyncFromDailyInput {
  line: number;
  date: string | null;
}

export interface SyncDailyResult {
  date: string;
  updated: number;
}

export interface SyncFailure {
  taskId: string;
  error: string;
}

export interface SyncFromDailyResult extends SyncDailyResult {
  failed: SyncFailure[];
}

export interface BoardDelegateInput {
  projectId: string;
  line: number;
  raw: string;
  workspace: string | null;
  prompt: string | null;
  repo: string | null;
  runner: Runner | null;
}

export interface BoardDelegateResult {
  taskId: string;
  task: BoardTask;
  warning?: string;
}

export const DEFAULT_TASK_DELEGATE_PROMPT =
  'You are working on a task tracked in the project "{{project}}" (notes file: {{projectPath}}).\n\n' +
  "Task: {{task}}\nCurrent status: {{status}}\n\nSubtasks:\n{{subtasks}}\n\nNotes:\n{{notes}}\n\n" +
  "Do the work this task describes inside this workspace and keep the changes focused on it. " +
  "Leave the project notes file untouched, the hub keeps its status in sync. " +
  "When you finish, summarize what you did and what is left.";

export class TaskConflictError extends Error {
  constructor(public readonly current: BoardTask | null) {
    super("changed on disk");
  }
}

export class AlreadyInDailyError extends Error {
  constructor() {
    super("already in the daily");
  }
}

const WATCH_DEBOUNCE_MS = 300;
const LINE_SPLIT_RE = /\r\n|\n/;
const TASK_LINE_RE = /^(\s*)[-*]\s+\[([ xX-])\]\s?(.*)$/;
const TASK_PARTS_RE = /^(\s*[-*]\s+\[)([ xX-])(\])(\s*)(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const BOM = "\uFEFF";
const MARKDOWN_RE = /\.md$/i;
const PREFIX_STATUSES = ["blocked", "hold", "archived"] as const;
const DATE_PATTERN = "(\\d{4}-\\d{2}-\\d{2})";
const MIN_PREFIX_MATCH = 12;
const MAX_CANDIDATES = 5;
const MAX_PRIORITY = 9;
const NOTE_FORBIDDEN_RE = /^(```|~~~|([-*+]|\d+[.)])\s+\[[ xX-]\]|\[[ xX-]\])/;
const NOTE_SHAPE_ERROR = "text must not look like a task or a code fence";
const NOTE_FENCE_ERROR = "the note has a code fence that is not closed inside it";
const NO_TITLE_ERROR = "task has no title";
const FENCE_BLOCK_ERROR = "the block has a code fence that is not closed inside it";
const MIXED_INDENT_ERROR = "mixed indentation in the block";
const STRUCTURE_ERROR = "the change would alter other items of the file, nothing was written";
const PARENT_TASK_ERROR = "parent must be a task in the configured section";

type PrefixStatus = (typeof PREFIX_STATUSES)[number];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indentDepth(raw: string): number {
  let spaces = 0;
  for (const ch of raw) {
    if (ch === "\t") spaces += 4;
    else if (ch === " ") spaces += 1;
    else break;
  }
  return Math.floor(spaces / 2);
}

function globToRegExp(pattern: string): RegExp {
  const source = [...pattern].map((ch) => (ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : escapeRegExp(ch))).join("");
  return new RegExp(`^${source}$`, "i");
}

function isExcludedName(name: string, patterns: string[]): boolean {
  if (name.startsWith(".")) return true;
  const bare = name.replace(MARKDOWN_RE, "");
  return patterns.some((pattern) => {
    const re = globToRegExp(pattern);
    return re.test(name) || re.test(bare);
  });
}

export function tasksRoot(settings: DelegationSettings): string | null {
  const configured = settings.tasks.root;
  const brain = settings.secondBrainRoot;
  if (configured) {
    if (isAbsolute(configured)) return configured;
    return brain ? join(brain, configured) : null;
  }
  return brain ? join(brain, "projects") : null;
}

interface PrefixMatch {
  word: string;
  status: PrefixStatus;
  span: string;
  title: string;
}

function matchPrefix(text: string, config: TasksFeatureSettings): PrefixMatch | null {
  const words = new Map<string, PrefixStatus>();
  for (const status of PREFIX_STATUSES) {
    for (const word of config.prefixes[status]) if (!words.has(word)) words.set(word, status);
  }
  if (words.size === 0) return null;
  const alternatives = [...words.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const match = text.match(new RegExp(`^(${alternatives.join("|")})(\\s*[-:\\u2013])(\\s+|$)(.*)$`));
  if (!match) return null;
  const word = match[1] as string;
  const gap = match[3] === "" ? " " : (match[3] as string);
  return { word, status: words.get(word) as PrefixStatus, span: `${word}${match[2] as string}${gap}`, title: match[4] ?? "" };
}

interface PrioritySplit {
  text: string;
  priority: number | null;
  token: string | null;
}

function priorityRegExp(config: TasksFeatureSettings): RegExp {
  return new RegExp(`(\\s*)(?<![^\\s])#${escapeRegExp(config.priorityTag)}(\\d)(?![^\\s])(\\s*)`, "gi");
}

const CODE_SPAN_RE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
const WIKILINK_SPAN_RE = /!?\[\[[^\]\r\n]*\]\]/g;
const LINK_SPAN_RE = /!?\[[^\]\r\n]*\]\([^)\r\n]*\)/g;
const URL_SPAN_RE = /\bhttps?:\/\/[^\s<>]+/gi;
const PROTECTED_SPAN_RES = [CODE_SPAN_RE, WIKILINK_SPAN_RE, LINK_SPAN_RE, URL_SPAN_RE];

function protectedSpans(text: string): [number, number][] {
  return PROTECTED_SPAN_RES.flatMap((re) => [...text.matchAll(re)].map((span): [number, number] => [span.index ?? 0, (span.index ?? 0) + span[0].length]));
}

function priorityMatches(text: string, config: TasksFeatureSettings): RegExpMatchArray[] {
  const spans = protectedSpans(text);
  return [...text.matchAll(priorityRegExp(config))].filter((match) => {
    const at = (match.index ?? 0) + (match[1] ?? "").length;
    return !spans.some(([from, to]) => at >= from && at < to);
  });
}

function stripPriorityMatches(text: string, matches: RegExpMatchArray[]): string {
  let out = "";
  let position = 0;
  for (const match of matches) {
    const at = match.index ?? 0;
    out += text.slice(position, at) + ((match[1] ?? "") !== "" && (match[3] ?? "") !== "" ? " " : "");
    position = at + match[0].length;
  }
  return (out + text.slice(position)).trim();
}

function removePriorityTokens(text: string, config: TasksFeatureSettings): string {
  return stripPriorityMatches(text, priorityMatches(text, config));
}

function splitPriority(text: string, config: TasksFeatureSettings): PrioritySplit {
  const matches = priorityMatches(text, config);
  const first = matches[0];
  if (!first) return { text, priority: null, token: null };
  const stripped = stripPriorityMatches(text, matches);
  if (stripped === "") return { text, priority: null, token: null };
  return { text: stripped, priority: Number(first[2]), token: first[0].trim() };
}

function formatPriority(config: TasksFeatureSettings, priority: number): string {
  return `#${config.priorityTag}${priority}`;
}

function priorityOf(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_PRIORITY) {
    throw new BadRequestError("priority must be an integer from 0 to 9 or null");
  }
  return value;
}

const START_MARK = "\u{1F6EB}";
const SCHEDULED_MARK = "\u23F3";
const DUE_MARK = "\u{1F4C5}";
const REPEAT_MARK = "\u{1F501}";
const DATE_FIELDS = ["start", "scheduled", "due"] as const;
const STOP_MARKS = [START_MARK, SCHEDULED_MARK, DUE_MARK, REPEAT_MARK, "\u2705", "\u2795", "\u23EB", "\u{1F53C}", "\u{1F53D}", "\u23EC", "\u{1F53A}", "\u274C", "\u{1F194}", "\u26D4", "\u{1F3C1}"];
const STOP_SOURCE = `(?:${STOP_MARKS.join("|")})\\uFE0F?`;
const LOOSE_DATE_SOURCE = "\\d{4}-\\d{2}-\\d{2}";
const signifierPatterns = new Map<string, RegExp>();

function signifierRegExp(config: TasksFeatureSettings): RegExp {
  const template = config.doneStamp.trim();
  const stamp = template.includes(TASKS_DATE_TOKEN) ? template.split(TASKS_DATE_TOKEN).map(escapeRegExp).join(LOOSE_DATE_SOURCE) : null;
  const key = stamp ?? "";
  const cached = signifierPatterns.get(key);
  if (cached) return cached;
  const stop = stamp === null ? STOP_SOURCE : `(?:${STOP_SOURCE}|${stamp})`;
  const pattern = new RegExp(
    `(\\s*)(?:(${START_MARK}|${SCHEDULED_MARK}|${DUE_MARK})\\uFE0F?\\s*(\\d{4}-\\d{2}-\\d{2})(?!\\d)|${REPEAT_MARK}\\uFE0F?[ \\t]*(.*?)(?=\\s*${stop}|\\s+#[^\\s#]|\\s*$))(\\s*)`,
    "gu",
  );
  signifierPatterns.set(key, pattern);
  return pattern;
}
const CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const MIN_BOARD_YEAR = 2000;
const MAX_BOARD_YEAR = 2100;
const CHANGE_REQUIRED_ERROR = "status, title, reason or priority required (or start, scheduled, due, repeat)";
const REPEAT_ERROR = "repeat must be a single line without task signifiers, # tags or backticks, or null";
const SIGNIFIER_TEXT_ERROR = "must not contain dates or a repeat rule, use start, scheduled, due and repeat";

type DateField = (typeof DATE_FIELDS)[number];

const DATE_MARKS: Record<DateField, string> = { start: START_MARK, scheduled: SCHEDULED_MARK, due: DUE_MARK };

interface SignifierSplit extends BoardDates {
  text: string;
  conflict: keyof BoardDates | null;
}

function isCalendarDate(text: string): boolean {
  const match = text.match(CALENDAR_DATE_RE);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = utcDate(year, month - 1, day);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isBoardDate(text: string): boolean {
  if (!isCalendarDate(text)) return false;
  const year = Number(text.slice(0, 4));
  return year >= MIN_BOARD_YEAR && year <= MAX_BOARD_YEAR;
}

function signifierMatches(text: string, config: TasksFeatureSettings): RegExpMatchArray[] {
  const spans = protectedSpans(text);
  return [...text.matchAll(signifierRegExp(config))].filter((match) => {
    const at = (match.index ?? 0) + (match[1] ?? "").length;
    if (spans.some(([from, to]) => at >= from && at < to)) return false;
    if (match[2] !== undefined) return isBoardDate(match[3] ?? "");
    return (match[4] ?? "").trim() !== "";
  });
}

function stripSignifiers(text: string, matches: RegExpMatchArray[]): string {
  let out = "";
  let position = 0;
  for (const match of matches) {
    const at = match.index ?? 0;
    out += text.slice(position, at);
    if (out !== "" && !/\s$/.test(out)) out += " ";
    position = at + match[0].length;
  }
  return (out + text.slice(position)).trim();
}

function signifierField(match: RegExpMatchArray): keyof BoardDates {
  const mark = match[2];
  if (mark === undefined) return "repeat";
  return DATE_FIELDS.find((field) => DATE_MARKS[field] === mark) ?? "due";
}

function splitSignifiers(text: string, config: TasksFeatureSettings): SignifierSplit {
  const split: SignifierSplit = { text, start: null, scheduled: null, due: null, repeat: null, conflict: null };
  const matches = signifierMatches(text, config);
  if (matches.length === 0) return split;
  const stripped = stripSignifiers(text, matches);
  if (stripped === "") return split;
  split.text = stripped;
  for (const match of matches) {
    const field = signifierField(match);
    const value = field === "repeat" ? (match[4] ?? "").trim() : (match[3] ?? "");
    const current = split[field];
    if (current === null) split[field] = value;
    else if (current !== value && split.conflict === null) split.conflict = field;
  }
  return split;
}

function withoutSignifiers(text: string, config: TasksFeatureSettings): string {
  return stripSignifiers(text, signifierMatches(text, config));
}

function formatSignifiers(dates: BoardDates): string {
  const parts: string[] = [];
  if (dates.repeat !== null) parts.push(`${REPEAT_MARK} ${dates.repeat}`);
  for (const field of DATE_FIELDS) {
    const value = dates[field];
    if (value !== null) parts.push(`${DATE_MARKS[field]} ${value}`);
  }
  return parts.join(" ");
}

function dateValueOf(value: unknown, field: DateField): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !isCalendarDate(value)) throw new BadRequestError(`${field} must be a YYYY-MM-DD date or null`);
  if (!isBoardDate(value)) throw new BadRequestError(`${field} must be a date between ${MIN_BOARD_YEAR} and ${MAX_BOARD_YEAR}`);
  return value;
}

function repeatValueOf(value: unknown, config: TasksFeatureSettings): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || /[\r\n`]/.test(value)) throw new BadRequestError(REPEAT_ERROR);
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const probe = splitSignifiers(`x ${REPEAT_MARK} ${trimmed}`, config);
  if (probe.text !== "x" || probe.repeat !== trimmed || probe.conflict !== null) throw new BadRequestError(REPEAT_ERROR);
  return trimmed;
}

function datesOf(input: Partial<BoardDates>, config: TasksFeatureSettings): BoardDates {
  return {
    start: dateValueOf(input.start, "start"),
    scheduled: dateValueOf(input.scheduled, "scheduled"),
    due: dateValueOf(input.due, "due"),
    repeat: repeatValueOf(input.repeat, config),
  };
}

function touchesDates(change: BoardChange): boolean {
  return DATE_FIELDS.some((field) => change[field] !== undefined) || change.repeat !== undefined;
}

function mergeDates(current: BoardDates, change: BoardChange, config: TasksFeatureSettings): BoardDates {
  const next = datesOf(change, config);
  return {
    start: change.start === undefined ? current.start : next.start,
    scheduled: change.scheduled === undefined ? current.scheduled : next.scheduled,
    due: change.due === undefined ? current.due : next.due,
    repeat: change.repeat === undefined ? current.repeat : next.repeat,
  };
}

function ensureNoSignifiers(text: string, label: string, config: TasksFeatureSettings): void {
  if (signifierMatches(text, config).length > 0) throw new BadRequestError(`${label} ${SIGNIFIER_TEXT_ERROR}`);
}

type RepeatUnit = "day" | "week" | "month" | "year" | "weekday";

interface RepeatRule {
  unit: RepeatUnit;
  count: number;
}

function parseRepeatRule(rule: string): RepeatRule | null {
  const text = rule.trim().toLowerCase().replace(/\s+/g, " ");
  if (text === "every weekday") return { unit: "weekday", count: 1 };
  const match = text.match(/^every (?:(\d{1,4}) )?(day|week|month|year)s?$/);
  if (!match) return null;
  const count = match[1] === undefined ? 1 : Number(match[1]);
  return count >= 1 ? { unit: match[2] as RepeatUnit, count } : null;
}

function utcDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function formatUtcDate(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function advanceDate(date: string, rule: string): string | null {
  const parsed = parseRepeatRule(rule);
  const match = date.match(CALENDAR_DATE_RE);
  if (!parsed || !match || !isBoardDate(date)) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  let next: Date;
  if (parsed.unit === "weekday") {
    next = utcDate(year, month, day + 1);
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next = new Date(next.getTime() + DAY_MS);
  } else if (parsed.unit === "day" || parsed.unit === "week") {
    next = utcDate(year, month, day + parsed.count * (parsed.unit === "week" ? 7 : 1));
  } else {
    const first = utcDate(year, month + parsed.count * (parsed.unit === "year" ? 12 : 1), 1);
    const last = utcDate(first.getUTCFullYear(), first.getUTCMonth() + 1, 0).getUTCDate();
    next = utcDate(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last));
  }
  const formatted = formatUtcDate(next);
  return isBoardDate(formatted) ? formatted : null;
}

function advancedDates(task: BoardDates): Partial<BoardDates> {
  if (task.repeat === null) return {};
  const change: Partial<BoardDates> = {};
  for (const field of DATE_FIELDS) {
    const value = task[field];
    const next = value === null ? null : advanceDate(value, task.repeat);
    if (next !== null) change[field] = next;
  }
  return change;
}

function checkboxOf(char: string): BoardCheckbox {
  if (char === "-") return "doing";
  return char === " " ? "todo" : "done";
}

function carriesReason(status: BoardStatus): boolean {
  return (PREFIX_STATUSES as readonly string[]).includes(status);
}

function splitReason(text: string, status: BoardStatus, separator: string): { title: string; reason: string | null } {
  if (!carriesReason(status)) return { title: text, reason: null };
  const index = text.lastIndexOf(separator);
  if (index === -1) return { title: text, reason: null };
  const title = text.slice(0, index).trim();
  const reason = text.slice(index + separator.length).trim();
  if (title === "" || reason === "") return { title: text, reason: null };
  return { title, reason };
}

function joinReason(title: string, reason: string | null, separator: string): string {
  return reason ? `${title}${separator}${reason}` : title;
}

function doneSectionName(config: TasksFeatureSettings): string | null {
  const name = config.doneSection.trim().toLowerCase();
  const section = config.section.trim().toLowerCase();
  if (name === "" || section === "" || name === section) return null;
  return name;
}

function stampRegExp(stampSource: string, config: TasksFeatureSettings): RegExp {
  const tag = [...config.priorityTag].map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : escapeRegExp(ch))).join("");
  return new RegExp(`(?<stamp>\\s*${stampSource})(?<tags>(?:\\s*#${tag}\\d)*)\\s*$`);
}

const DEFAULT_STAMP_MARK = "\u2705";
const DEFAULT_STAMP_SOURCE = `${DEFAULT_STAMP_MARK}\\s*${DATE_PATTERN}`;

function configuredStampSource(config: TasksFeatureSettings): string | null {
  const template = config.doneStamp.trim();
  if (!template.includes(TASKS_DATE_TOKEN)) return null;
  return template.split(TASKS_DATE_TOKEN).map(escapeRegExp).join(DATE_PATTERN);
}

function doneStampRegExp(config: TasksFeatureSettings): RegExp | null {
  const source = configuredStampSource(config);
  return source === null ? null : stampRegExp(source, config);
}

function defaultStampRegExp(config: TasksFeatureSettings): RegExp {
  return stampRegExp(DEFAULT_STAMP_SOURCE, config);
}

interface StampSplit {
  text: string;
  doneAt: string | null;
  tail: string;
  tags: string;
}

function noStamp(text: string): StampSplit {
  return { text, doneAt: null, tail: "", tags: "" };
}

function matchStamp(text: string, re: RegExp | null, normalise: boolean): StampSplit | null {
  const match = re ? text.match(re) : null;
  if (!match || match.index === undefined) return null;
  const tags = (match.groups?.tags ?? "").trim().split(/\s*(?=#)/).filter((token) => token !== "").join(" ");
  const doneAt = match[2] ?? null;
  const before = text.slice(0, match.index);
  const stamp = normalise && doneAt !== null ? ` ${DEFAULT_STAMP_MARK} ${doneAt}` : (match.groups?.stamp ?? "");
  if (tags === "") return { text: before, doneAt, tail: normalise ? stamp : match[0], tags };
  return { text: `${before} ${tags}`, doneAt, tail: stamp, tags };
}

function matchEmbeddedStamp(text: string, config: TasksFeatureSettings): StampSplit | null {
  const sources = [configuredStampSource(config), DEFAULT_STAMP_SOURCE];
  for (const source of sources) {
    const match = source === null ? null : text.match(new RegExp(`(?<![^\\s])${source}(?![^\\s#])`));
    if (match) return { text, doneAt: match[1] ?? null, tail: "", tags: "" };
  }
  return null;
}

function splitStamp(text: string, config: TasksFeatureSettings, guarded = false): StampSplit {
  const split = matchStamp(text, doneStampRegExp(config), false) ?? matchStamp(text, defaultStampRegExp(config), true);
  if (!split) return matchEmbeddedStamp(text, config) ?? noStamp(text);
  const kept = split.text.trim();
  return guarded && (kept === "" || kept === split.tags) ? noStamp(text) : split;
}

function splitAnyStamp(text: string, config: TasksFeatureSettings): StampSplit {
  return splitStamp(text, config, true);
}

function formatStamp(config: TasksFeatureSettings, date: string): string {
  return config.doneStamp.split(TASKS_DATE_TOKEN).join(date);
}

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

function frontmatterEnd(lines: string[]): number {
  if ((lines[0] ?? "").trim() !== "---") return -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === "---") return i;
  }
  return -1;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if (trimmed.length >= 2 && (quote === '"' || quote === "'") && trimmed.endsWith(quote)) return trimmed.slice(1, -1).trim();
  return trimmed;
}

function frontmatterValue(lines: string[], end: number, key: string): string | null {
  if (end === -1) return null;
  const re = new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`);
  for (let i = 1; i < end; i += 1) {
    const match = (lines[i] ?? "").match(re);
    if (!match) continue;
    const inline = stripQuotes(match[1] ?? "");
    if (inline) return inline;
    const next = (lines[i + 1] ?? "").match(/^\s*-\s+(.*)$/);
    return next && i + 1 < end ? stripQuotes(next[1] ?? "") || null : null;
  }
  return null;
}

function closesFence(fenceMatch: RegExpMatchArray | null, fence: string): boolean {
  if (!fenceMatch) return false;
  const marker = fenceMatch[1] as string;
  return marker[0] === fence[0] && marker.length >= fence.length && (fenceMatch[2] as string).trim() === "";
}

function firstHeading(lines: string[], from: number): string | null {
  let fence: string | null = null;
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const fenceMatch = line.match(FENCE_RE);
    if (fence) {
      if (closesFence(fenceMatch, fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] as string;
      continue;
    }
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match) return (match[1] as string).trim();
  }
  return null;
}

function headingOf(line: string): { level: number; text: string } | null {
  const heading = line.match(HEADING_RE);
  if (!heading) return null;
  return { level: (heading[1] as string).length, text: (heading[2] as string).replace(/\s+#+$/, "").trim() };
}

export function parseBoardTasks(markdown: string, projectId: string, config: TasksFeatureSettings): BoardTask[] {
  const lines = stripBom(markdown).split(LINE_SPLIT_RE);
  const section = config.section.trim().toLowerCase();
  const doneName = doneSectionName(config);
  const wholeDocument = section === "";
  const end = frontmatterEnd(lines);
  const tasks: BoardTask[] = [];
  const stack: { task: BoardTask; depth: number }[] = [];
  let current: BoardSection | null = wholeDocument ? "open" : null;
  let sectionLevel = 0;
  let group: string | null = null;
  let fence: string | null = null;
  for (let index = end + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(FENCE_RE);
    if (fence) {
      if (closesFence(fenceMatch, fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] as string;
      continue;
    }
    const heading = headingOf(line);
    if (heading) {
      stack.length = 0;
      if (current !== null && !wholeDocument && heading.level <= sectionLevel) current = null;
      const lowered = heading.text.toLowerCase();
      if (!wholeDocument && doneName !== null && lowered === doneName && current !== "done") {
        current = "done";
        sectionLevel = heading.level;
        group = null;
      } else if (current === null && !wholeDocument && lowered === section) {
        current = "open";
        sectionLevel = heading.level;
        group = null;
      } else if (current !== null) {
        group = heading.text;
      }
      continue;
    }
    if (current === null || line.trim() === "") continue;
    const depth = indentDepth(line);
    const match = line.match(TASK_LINE_RE);
    const rest = match ? (match[3] as string).trim() : "";
    if (match && rest !== "") {
      const signified = splitSignifiers(rest, config);
      const stamped = current === "done" || signified.repeat !== null ? splitStamp(signified.text, config) : { text: signified.text, doneAt: null, tail: "" };
      const prioritized = splitPriority(stamped.text, config);
      const body = prioritized.text.trim();
      const prefix = matchPrefix(body, config);
      const checkbox = checkboxOf(match[2] as string);
      const status: BoardStatus = prefix?.status ?? checkbox;
      const split = splitReason((prefix ? prefix.title : body).trim(), status, config.reasonSeparator);
      const task: BoardTask = {
        id: `${projectId}#${index}`,
        projectId,
        line: index,
        raw: line,
        depth,
        checkbox,
        prefix: prefix?.word ?? null,
        status,
        title: split.title,
        reason: split.reason,
        section: current,
        doneAt: stamped.doneAt,
        group,
        priority: prioritized.priority,
        start: signified.start,
        scheduled: signified.scheduled,
        due: signified.due,
        repeat: signified.repeat,
        notes: [],
        noteItems: [],
        subtasks: [],
      };
      while (stack.length > 0 && (stack[stack.length - 1] as { depth: number }).depth >= depth) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) parent.task.subtasks.push(task);
      else tasks.push(task);
      stack.push({ task, depth });
      continue;
    }
    if (match) {
      while (stack.length > 0 && (stack[stack.length - 1] as { depth: number }).depth >= depth) stack.pop();
      continue;
    }
    while (stack.length > 0 && (stack[stack.length - 1] as { depth: number }).depth >= depth) stack.pop();
    const owner = stack[stack.length - 1];
    const note = line.trim().replace(/^[-*+]\s+/, "");
    if (owner && note !== "") {
      owner.task.notes.push(note);
      owner.task.noteItems.push({ line: index, raw: line, text: note });
    }
  }
  return tasks;
}

function flattenTasks(tasks: BoardTask[]): BoardTask[] {
  return tasks.flatMap((task) => [task, ...flattenTasks(task.subtasks)]);
}

function findTaskAt(tasks: BoardTask[], line: number): BoardTask | null {
  return flattenTasks(tasks).find((task) => task.line === line) ?? null;
}

function isFinished(task: BoardTask): boolean {
  return task.status === "done" && task.subtasks.every(isFinished);
}

function validateTitle(title: unknown): string {
  if (typeof title !== "string" || title.trim() === "" || /[\r\n]/.test(title)) {
    throw new BadRequestError("title must be a single non-empty line");
  }
  return title.trim();
}

function validateReason(reason: unknown): string | null {
  if (reason === null || reason === undefined) return null;
  if (typeof reason !== "string" || /[\r\n]/.test(reason)) throw new BadRequestError("reason must be a single line");
  const trimmed = reason.trim();
  return trimmed === "" ? null : trimmed;
}

function validateChange(change: BoardChange, config: TasksFeatureSettings): void {
  if (change.status === undefined && change.title === undefined && change.reason === undefined && change.priority === undefined && !touchesDates(change)) {
    throw new BadRequestError(CHANGE_REQUIRED_ERROR);
  }
  priorityOf(change.priority);
  datesOf(change, config);
  if (change.status !== undefined && !(BOARD_STATUSES as readonly string[]).includes(change.status)) {
    throw new BadRequestError(`status must be one of: ${BOARD_STATUSES.join(", ")}`);
  }
  if (change.title !== undefined) validateTitle(change.title);
  if (change.reason !== undefined) validateReason(change.reason);
}

function cleanTitle(title: string, config: TasksFeatureSettings): string {
  const cleaned = removePriorityTokens(title.trim(), config);
  if (cleaned === "") throw new BadRequestError(NO_TITLE_ERROR);
  ensureNoSignifiers(cleaned, "title", config);
  return cleaned;
}

function cleanReason(reason: unknown, config: TasksFeatureSettings): string | null {
  const valid = validateReason(reason);
  if (valid === null) return null;
  const cleaned = removePriorityTokens(valid, config);
  ensureNoSignifiers(cleaned, "reason", config);
  return cleaned === "" ? null : cleaned;
}

function ensureReasonFits(reason: string | null, config: TasksFeatureSettings): void {
  if (reason !== null && reason.includes(config.reasonSeparator)) {
    throw new BadRequestError(`reason must not contain the separator "${config.reasonSeparator}"`);
  }
}

export type StampMode = "none" | "keep" | "drop";

export function rewriteTaskLine(raw: string, config: TasksFeatureSettings, change: BoardChange, stampMode: StampMode = "none"): string {
  validateChange(change, config);
  const parts = raw.match(TASK_PARTS_RE);
  if (!parts) throw new BadRequestError("not a task line");
  const [, head, box, close, gap, restRaw] = parts as unknown as [string, string, string, string, string, string];
  const signified = splitSignifiers(restRaw, config);
  if (signified.conflict !== null) throw new BadRequestError(`the task has two different ${signified.conflict} values, fix the line in the file first`);
  const dates = mergeDates(signified, change, config);
  const stamped = splitAnyStamp(signified.text, config);
  const prioritized = splitPriority(stamped.text, config);
  const prefix = matchPrefix(prioritized.text, config);
  const currentStatus: BoardStatus = prefix?.status ?? checkboxOf(box);
  let checkbox = box;
  let span = prefix?.span ?? "";
  let text = prefix ? prefix.title : prioritized.text;
  const status = change.status;
  const targetStatus: BoardStatus = status ?? currentStatus;
  if (change.reason !== undefined) {
    const carried = validateReason(change.reason) !== null ? carriesReason(targetStatus) : carriesReason(currentStatus) || carriesReason(targetStatus);
    if (!carried) throw new BadRequestError("reason only applies to blocked, hold and archived tasks");
  }
  const reshapes = change.priority !== undefined || change.reason !== undefined || touchesDates(change) || (status !== undefined && carriesReason(status));
  if (change.title === undefined && reshapes && removePriorityTokens(text, config) === "") throw new BadRequestError(NO_TITLE_ERROR);
  if (status === "todo" || status === "doing" || status === "done") {
    checkbox = status === "todo" ? " " : status === "doing" ? "-" : "x";
    span = "";
  } else if (status !== undefined) {
    const words = config.prefixes[status];
    const first = words[0];
    if (first === undefined) throw new BadRequestError(`no prefix configured for ${status}`);
    if (prefix?.status !== status) span = `${first}${config.separator}`;
    if (status !== "archived" && /[xX]/.test(box)) checkbox = " ";
  }
  if (change.title !== undefined || change.reason !== undefined) {
    const split = splitReason(text.trim(), currentStatus, config.reasonSeparator);
    const title = change.title !== undefined ? cleanTitle(change.title, config) : split.title;
    const reason = change.reason !== undefined ? cleanReason(change.reason, config) : split.reason;
    ensureReasonFits(reason, config);
    text = joinReason(title, reason, config.reasonSeparator);
  }
  const priority = change.priority === undefined ? prioritized.priority : change.priority;
  let token = "";
  if (priority !== null) token = priority === prioritized.priority && prioritized.token ? prioritized.token : formatPriority(config, priority);
  const tail = stampMode === "drop" ? "" : stamped.tail;
  const content = text === "" ? token : `${text}${token === "" ? "" : ` ${token}`}`;
  const signifiers = formatSignifiers(dates);
  if (signifiers === "") return `${head}${checkbox}${close}${gap || " "}${span}${content}${tail}`;
  if (removePriorityTokens(withoutSignifiers(text, config), config) === "") throw new BadRequestError(NO_TITLE_ERROR);
  return `${head}${checkbox}${close}${gap || " "}${span}${content} ${signifiers}${tail}`;
}

interface WalkedFile {
  id: string;
  rel: string;
  abs: string;
}

function walkProjects(root: string, exclude: string[]): WalkedFile[] {
  const found: WalkedFile[] = [];
  const visit = (dirAbs: string, dirRel: string): void => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (isExcludedName(entry.name, exclude)) continue;
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(dirAbs, entry.name), rel);
      else if (entry.isFile() && MARKDOWN_RE.test(entry.name)) found.push({ id: rel.replace(MARKDOWN_RE, ""), rel, abs: join(dirAbs, entry.name) });
    }
  };
  visit(root, "");
  return found;
}

function dirOf(id: string): string {
  const index = id.lastIndexOf("/");
  return index === -1 ? "" : id.slice(0, index);
}

function normalizeRef(value: string): string {
  let ref = stripQuotes(value);
  const wiki = ref.match(/^\[\[(.*)\]\]$/);
  if (wiki) ref = wiki[1] as string;
  ref = (ref.split("|")[0] as string).split("#")[0] as string;
  return ref.replace(/\\/g, "/").replace(MARKDOWN_RE, "").replace(/^\/+|\/+$/g, "").trim();
}

function resolveRef(ref: string, files: WalkedFile[]): string | null {
  if (!ref) return null;
  const byId = files.find((file) => file.id === ref);
  if (byId) return byId.id;
  if (ref.includes("/")) {
    const suffix = files.filter((file) => file.id.endsWith(`/${ref}`));
    return suffix.length === 1 ? (suffix[0] as WalkedFile).id : null;
  }
  const exact = files.filter((file) => basename(file.id) === ref);
  if (exact.length === 1) return (exact[0] as WalkedFile).id;
  if (exact.length > 1) return null;
  const loose = files.filter((file) => basename(file.id).toLowerCase() === ref.toLowerCase());
  return loose.length === 1 ? (loose[0] as WalkedFile).id : null;
}

interface LoadedBoard {
  projects: BoardProject[];
  contents: Map<string, string>;
  errors: { path: string; error: string }[];
}

function loadBoard(root: string, config: TasksFeatureSettings): LoadedBoard {
  const errors: { path: string; error: string }[] = [];
  const contents = new Map<string, string>();
  const files: WalkedFile[] = [];
  for (const file of walkProjects(root, config.exclude)) {
    try {
      contents.set(file.id, readFileSync(file.abs, "utf8"));
      files.push(file);
    } catch (err) {
      errors.push({ path: file.abs, error: err instanceof Error ? err.message : "read failed" });
    }
  }
  const folderProjects = new Map<string, string>();
  for (const file of files) {
    const dir = dirOf(file.id);
    if (dir !== "" && basename(file.id) === basename(dir)) folderProjects.set(dir, file.id);
  }
  const ancestorFolderProject = (startDir: string): string | null => {
    let dir = startDir;
    while (dir !== "") {
      const found = folderProjects.get(dir);
      if (found) return found;
      dir = dirOf(dir);
    }
    return null;
  };
  const parents = new Map<string, string | null>();
  const meta = new Map<string, { title: string; workspace: string | null; parentRef: string | null }>();
  for (const file of files) {
    const dir = dirOf(file.id);
    const isFolderFile = dir !== "" && basename(file.id) === basename(dir);
    parents.set(file.id, ancestorFolderProject(isFolderFile ? dirOf(dir) : dir));
    const lines = stripBom(contents.get(file.id) as string).split(LINE_SPLIT_RE);
    const end = frontmatterEnd(lines);
    meta.set(file.id, {
      title: frontmatterValue(lines, end, "title") ?? firstHeading(lines, end + 1) ?? basename(file.id),
      workspace: frontmatterValue(lines, end, config.workspaceKey),
      parentRef: frontmatterValue(lines, end, config.parentKey),
    });
  }
  for (const file of files) {
    const ref = meta.get(file.id)?.parentRef;
    if (!ref) continue;
    const target = resolveRef(normalizeRef(ref), files);
    if (!target || target === file.id) continue;
    let cursor: string | null | undefined = target;
    let cyclic = false;
    while (cursor) {
      if (cursor === file.id) {
        cyclic = true;
        break;
      }
      cursor = parents.get(cursor);
    }
    if (!cyclic) parents.set(file.id, target);
  }
  const ancestors = (id: string): string[] => {
    const chain: string[] = [];
    let cursor = parents.get(id);
    while (cursor) {
      chain.push(cursor);
      cursor = parents.get(cursor);
    }
    return chain;
  };
  const projectOf = (file: WalkedFile): BoardProject => {
    const info = meta.get(file.id) as { title: string; workspace: string | null };
    const chain = ancestors(file.id);
    let workspace = info.workspace;
    let workspaceSource: BoardProject["workspaceSource"] = workspace ? "own" : null;
    if (!workspace) {
      for (const ancestor of chain) {
        const inherited = meta.get(ancestor)?.workspace;
        if (inherited) {
          workspace = inherited;
          workspaceSource = "inherited";
          break;
        }
      }
    }
    return {
      id: file.id,
      name: basename(file.id),
      title: info.title,
      parent: parents.get(file.id) ?? null,
      depth: chain.length,
      path: file.abs,
      workspace: workspace ?? null,
      workspaceSource,
    };
  };
  const built = new Map(files.map((file) => [file.id, projectOf(file)]));
  const children = new Map<string | null, string[]>();
  for (const file of files) {
    const parent = parents.get(file.id) ?? null;
    children.set(parent, [...(children.get(parent) ?? []), file.id]);
  }
  const ordered: BoardProject[] = [];
  const emit = (id: string): void => {
    ordered.push(built.get(id) as BoardProject);
    for (const child of children.get(id) ?? []) emit(child);
  };
  for (const id of children.get(null) ?? []) emit(id);
  return { projects: ordered, contents, errors };
}

function effectivePrompt(settings: DelegationSettings): string {
  return settings.tasks.delegatePrompt ?? DEFAULT_TASK_DELEGATE_PROMPT;
}

function collectBoard(root: string, config: TasksFeatureSettings): { loaded: LoadedBoard; tasks: BoardTask[] } {
  const loaded = loadBoard(root, config);
  const tasks = loaded.projects.flatMap((project) => parseBoardTasks(loaded.contents.get(project.id) as string, project.id, config));
  return { loaded, tasks };
}

export function readBoard(settings: DelegationSettings): BoardPayload {
  const empty = (root: string | null): BoardPayload => ({
    enabled: settings.features.tasks,
    root,
    configured: false,
    delegatePrompt: effectivePrompt(settings),
    projects: [],
    tasks: [],
    errors: [],
    today: null,
  });
  if (!settings.features.tasks) return empty(null);
  const root = tasksRoot(settings);
  if (!root) return empty(null);
  if (!isDirectory(root)) return empty(root);
  const { loaded, tasks } = collectBoard(root, settings.tasks);
  return {
    enabled: true,
    root,
    configured: true,
    delegatePrompt: effectivePrompt(settings),
    projects: loaded.projects,
    tasks,
    errors: loaded.errors,
    today: todayBlock(settings, loaded.projects, tasks),
  };
}

const knownHash = new Map<string, string>();

function hashOf(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

function requireBoardRoot(settings: DelegationSettings): string {
  if (!settings.features.tasks) throw new BadRequestError("the tasks feature is disabled");
  const root = tasksRoot(settings);
  if (!root || !isDirectory(root)) throw new BadRequestError("tasks root not set");
  return root;
}

function locateProject(settings: DelegationSettings, projectId: string): WalkedFile {
  const root = requireBoardRoot(settings);
  const file = walkProjects(root, settings.tasks.exclude).find((candidate) => candidate.id === projectId);
  if (!file) throw new NotFoundError("project not found");
  return file;
}

function readProjectFile(file: WalkedFile): string {
  try {
    return readFileSync(file.abs, "utf8");
  } catch {
    throw new NotFoundError("project not found");
  }
}

function checkFresh(content: string, file: WalkedFile, config: TasksFeatureSettings, line: number, raw: string): BoardTask {
  const lines = stripBom(content).split(LINE_SPLIT_RE);
  const tasks = parseBoardTasks(content, file.id, config);
  const current = findTaskAt(tasks, line);
  if (lines[line] !== raw) throw new TaskConflictError(current);
  if (!current) throw new BadRequestError("line is not a task line in the configured section");
  return current;
}

interface DocLine {
  text: string;
  eol: string;
}

interface ParsedDoc {
  bom: string;
  lines: DocLine[];
  eol: string;
  endsWithEol: boolean;
}

function openDoc(content: string): ParsedDoc {
  const bom = content.startsWith(BOM) ? BOM : "";
  const parts = stripBom(content).split(/(\r\n|\n)/);
  const endsWithEol = parts.length > 1 && parts[parts.length - 1] === "";
  if (endsWithEol) parts.pop();
  const lines: DocLine[] = [];
  for (let i = 0; i < parts.length; i += 2) lines.push({ text: parts[i] as string, eol: parts[i + 1] ?? "" });
  const firstEol = lines.find((line) => line.eol !== "")?.eol ?? "\n";
  return { bom, lines, eol: firstEol, endsWithEol };
}

function renderDoc(doc: ParsedDoc): string {
  const last = doc.lines.length - 1;
  let out = doc.bom;
  doc.lines.forEach((line, index) => {
    out += line.text;
    if (index < last || doc.endsWithEol) out += line.eol || doc.eol;
  });
  return out;
}

const docLine = (text: string): DocLine => ({ text, eol: "" });

const isBlank = (line: DocLine | undefined): boolean => line !== undefined && line.text.trim() === "";

const textsOf = (doc: ParsedDoc): string[] => doc.lines.map((line) => line.text);

function blockLength(doc: ParsedDoc, start: number): number {
  return taskBlock(textsOf(doc).join("\n"), start).split("\n").length;
}

interface SectionRange {
  heading: number;
  level: number;
  end: number;
}

interface SectionScan {
  open: SectionRange | null;
  done: SectionRange | null;
}

function scanSections(lines: string[], config: TasksFeatureSettings): SectionScan {
  const section = config.section.trim().toLowerCase();
  const start = frontmatterEnd(lines);
  if (section === "") return { open: { heading: start, level: 0, end: lines.length }, done: null };
  const doneName = doneSectionName(config);
  let open: SectionRange | null = null;
  let done: SectionRange | null = null;
  let active: SectionRange | null = null;
  let fence: string | null = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(FENCE_RE);
    if (fence) {
      if (closesFence(fenceMatch, fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] as string;
      continue;
    }
    const heading = headingOf(line);
    if (!heading) continue;
    const lowered = heading.text.toLowerCase();
    const isDoneHeading = doneName !== null && lowered === doneName;
    if (active && (heading.level <= active.level || (isDoneHeading && active === open))) {
      active.end = index;
      active = null;
    }
    if (active) continue;
    if (lowered === section && !open) {
      open = { heading: index, level: heading.level, end: lines.length };
      active = open;
    } else if (isDoneHeading && !done) {
      done = { heading: index, level: heading.level, end: lines.length };
      active = done;
    }
  }
  return { open, done };
}

function lastContentIndex(doc: ParsedDoc, section: SectionRange): number {
  for (let index = section.end - 1; index > section.heading; index -= 1) {
    if (!isBlank(doc.lines[index])) return index;
  }
  return -1;
}

function replaceSolePlaceholder(doc: ParsedDoc, section: SectionRange, block: DocLine[]): number | null {
  let found = -1;
  for (let index = section.heading + 1; index < section.end; index += 1) {
    const line = doc.lines[index];
    if (isBlank(line)) continue;
    if (found !== -1 || !isPlaceholderLine((line as DocLine).text)) return null;
    found = index;
  }
  if (found === -1) return null;
  doc.lines.splice(found, 1, ...block);
  return found;
}

function appendToSection(doc: ParsedDoc, section: SectionRange, block: DocLine[]): number {
  const replaced = replaceSolePlaceholder(doc, section, block);
  if (replaced !== null) return replaced;
  const last = lastContentIndex(doc, section);
  let at = last + 1;
  if (last === -1) {
    at = section.heading + 1;
    if (at < section.end && isBlank(doc.lines[at])) {
      at += 1;
    } else if (section.heading >= 0) {
      doc.lines.splice(at, 0, docLine(""));
      at += 1;
    }
  }
  doc.lines.splice(at, 0, ...block);
  const next = doc.lines[at + block.length];
  if (last === -1 && next !== undefined && !isBlank(next)) doc.lines.splice(at + block.length, 0, docLine(""));
  return at;
}

function lastNonBlank(doc: ParsedDoc): number {
  for (let index = doc.lines.length - 1; index >= 0; index -= 1) {
    if (!isBlank(doc.lines[index])) return index;
  }
  return -1;
}

function insertIntoOpenEnd(doc: ParsedDoc, block: DocLine[], config: TasksFeatureSettings): number {
  const { open, done } = scanSections(textsOf(doc), config);
  if (open) return appendToSection(doc, open, block);
  const heading = docLine(`## ${config.section.trim()}`);
  if (done) {
    const preBlank = done.heading > 0 && !isBlank(doc.lines[done.heading - 1]);
    doc.lines.splice(done.heading, 0, ...(preBlank ? [docLine("")] : []), heading, docLine(""), ...block, docLine(""));
    return done.heading + (preBlank ? 1 : 0) + 2;
  }
  const last = lastNonBlank(doc);
  const at = last + 1;
  const preBlank = last >= 0;
  doc.lines.splice(at, 0, ...(preBlank ? [docLine("")] : []), heading, docLine(""), ...block);
  return at + (preBlank ? 1 : 0) + 2;
}

function insertIntoDone(doc: ParsedDoc, block: DocLine[], config: TasksFeatureSettings): number {
  const { open, done } = scanSections(textsOf(doc), config);
  if (done) {
    const replaced = replaceSolePlaceholder(doc, done, block);
    if (replaced !== null) return replaced;
    if (lastContentIndex(doc, done) === -1) return appendToSection(doc, done, block);
    let at = done.heading + 1;
    if (isBlank(doc.lines[at])) at += 1;
    doc.lines.splice(at, 0, ...block);
    return at;
  }
  const level = open && open.level > 0 ? open.level : 2;
  const heading = docLine(`${"#".repeat(level)} ${config.doneSection.trim()}`);
  let at: number;
  if (open) {
    const last = lastContentIndex(doc, open);
    at = last === -1 ? open.end : last + 1;
  } else {
    at = lastNonBlank(doc) + 1;
  }
  const preBlank = at > 0 && !isBlank(doc.lines[at - 1]);
  const insert = [...(preBlank ? [docLine("")] : []), heading, docLine(""), ...block];
  const next = doc.lines[at];
  if (next !== undefined && !isBlank(next) && headingOf(next.text)) insert.push(docLine(""));
  doc.lines.splice(at, 0, ...insert);
  return at + (preBlank ? 1 : 0) + 2;
}

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s/;

const isListItem = (line: DocLine | undefined): boolean => line !== undefined && LIST_ITEM_RE.test(line.text);

const isTightLead = (line: DocLine | undefined): boolean => line !== undefined && !isBlank(line) && !headingOf(line.text);

function extractBlock(doc: ParsedDoc, start: number): DocLine[] {
  const before = doc.lines[start - 1];
  const block = doc.lines.splice(start, blockLength(doc, start));
  if (start > 0 && isBlank(before) && isBlank(doc.lines[start])) doc.lines.splice(start, 1);
  else if (isTightLead(before) && isBlank(doc.lines[start]) && isListItem(doc.lines[start + 1])) doc.lines.splice(start, 1);
  return block;
}

function moveBlockToDone(doc: ParsedDoc, config: TasksFeatureSettings, start: number, date: string): number {
  const block = extractBlock(doc, start);
  const first = block[0] as DocLine;
  const stamp = splitAnyStamp(first.text, config);
  if (stamp.doneAt === null) first.text = `${first.text.trimEnd()}${formatStamp(config, date)}`;
  else if (stamp.tags !== "") first.text = `${stamp.text}${stamp.tail}`;
  return insertIntoDone(doc, block, config);
}

function moveBlockToOpen(doc: ParsedDoc, config: TasksFeatureSettings, start: number): number {
  const block = extractBlock(doc, start);
  const first = block[0] as DocLine;
  first.text = splitStamp(first.text, config).text.trimEnd();
  const { done } = scanSections(textsOf(doc), config);
  if (done && lastContentIndex(doc, done) === -1) appendToSection(doc, done, [docLine("-")]);
  return insertIntoOpenEnd(doc, block, config);
}

const TASK_MARK_RE = /^(\s*[-*]\s+\[)([ xX-])(\])/;

function setTaskMark(text: string, mark: string): string {
  return text.replace(TASK_MARK_RE, (_whole, open: string, _mark: string, close: string) => `${open}${mark}${close}`);
}

function isPendingRecurrence(task: BoardTask): boolean {
  return task.section === "open" && task.repeat !== null && task.status === "done" && task.doneAt === null;
}

const OCCURRENCE_MESSAGE = "this is a finished occurrence of a recurring task - edit it in Obsidian";

function isFinishedOccurrence(task: BoardTask, config: TasksFeatureSettings): boolean {
  if (task.repeat === null || task.doneAt === null) return false;
  return task.section === "done" || doneSectionName(config) === null;
}

function holdsLine(task: BoardTask, line: number): boolean {
  return flattenTasks([task]).some((member) => member.line === line || member.noteItems.some((note) => note.line === line));
}

function ensureNotOccurrence(tasks: BoardTask[], line: number, config: TasksFeatureSettings): void {
  const top = tasks.find((task) => holdsLine(task, line));
  if (top && isFinishedOccurrence(top, config)) throw new BadRequestError(OCCURRENCE_MESSAGE);
}

function recurBlock(doc: ParsedDoc, config: TasksFeatureSettings, task: BoardTask, date: string): number {
  const length = blockLength(doc, task.line);
  const block = doc.lines.slice(task.line, task.line + length);
  const nested = new Set(flattenTasks(task.subtasks).map((subtask) => subtask.line));
  const original = block[0] as DocLine;
  const copy = block.map((line, offset) => {
    if (offset === 0) return docLine(`${rewriteTaskLine(line.text, config, { status: "done" }).trimEnd()}${formatStamp(config, date)}`);
    return docLine(nested.has(task.line + offset) ? setTaskMark(line.text, "x") : line.text);
  });
  original.text = rewriteTaskLine(original.text, config, { status: "todo", ...advancedDates(task) });
  block.forEach((line, offset) => {
    if (offset > 0 && nested.has(task.line + offset)) line.text = setTaskMark(line.text, " ");
  });
  if (doneSectionName(config) !== null) insertIntoDone(doc, copy, config);
  else doc.lines.splice(task.line + length, 0, ...copy);
  return doc.lines.indexOf(original);
}

function topLevelOf(tasks: BoardTask[], line: number): BoardTask | null {
  return tasks.find((task) => findTaskAt([task], line) !== null) ?? null;
}

function commitFile(file: WalkedFile, next: string): number {
  writeFileAtomic(file.abs, next);
  knownHash.set(file.abs, hashOf(next));
  broadcast("tasks", { source: "hub", projectId: file.id });
  return statSync(file.abs).mtimeMs;
}

export function writeBoardTask(settings: DelegationSettings, input: BoardWriteInput): BoardWriteResult {
  validateChange(input, settings.tasks);
  const file = locateProject(settings, input.projectId);
  const content = readProjectFile(file);
  const config = settings.tasks;
  const current = checkFresh(content, file, config, input.line, input.raw);
  ensureNotOccurrence(parseBoardTasks(content, file.id, config), input.line, config);
  const updatedLine = rewriteTaskLine(input.raw, config, input, current.section === "done" ? "keep" : "none");
  const doc = openDoc(content);
  (doc.lines[input.line] as DocLine).text = updatedLine;
  let moved = false;
  let recurred = false;
  let line = input.line;
  if (input.status === "done") {
    const top = parseBoardTasks(renderDoc(doc), file.id, config).find((task) => task.line === input.line);
    if (top && isPendingRecurrence(top)) {
      line = recurBlock(doc, config, top, localDate());
      recurred = true;
      moved = true;
    }
  }
  if (!recurred && input.status !== undefined && doneSectionName(config) !== null) {
    const top = topLevelOf(parseBoardTasks(renderDoc(doc), file.id, config), input.line);
    if (top && current.section === "open" && !isPendingRecurrence(top) && isFinished(top)) {
      line = moveBlockToDone(doc, config, top.line, localDate()) + (input.line - top.line);
      moved = true;
    } else if (top && current.section === "done" && input.status !== "done" && current.status !== input.status) {
      line = moveBlockToOpen(doc, config, top.line) + (input.line - top.line);
      moved = true;
    }
  }
  const next = renderDoc(doc);
  let updatedAt = statSync(file.abs).mtimeMs;
  if (next !== content) updatedAt = commitFile(file, next);
  const task = findTaskAt(parseBoardTasks(next, file.id, config), line) as BoardTask;
  return { task, updatedAt, moved, recurred };
}

const leadingSpace = (text: string): string => text.match(/^\s*/)?.[0] ?? "";

function documentIndentUnit(doc: ParsedDoc): string {
  let unit: string | null = null;
  for (const line of doc.lines) {
    if (!TASK_LINE_RE.test(line.text)) continue;
    const indent = leadingSpace(line.text);
    if (indent !== "" && (unit === null || indent.length < unit.length)) unit = indent;
  }
  if (unit === null) return "  ";
  return unit.includes("\t") ? "\t" : unit;
}

function childIndent(doc: ParsedDoc, parentLine: number): string {
  const parentIndent = leadingSpace((doc.lines[parentLine] as DocLine).text);
  const end = parentLine + blockLength(doc, parentLine);
  let shallowest: string | null = null;
  for (let index = parentLine + 1; index < end; index += 1) {
    const text = (doc.lines[index] as DocLine).text;
    if (!TASK_LINE_RE.test(text)) continue;
    const indent = leadingSpace(text);
    if (shallowest === null || indentDepth(indent) < indentDepth(shallowest)) shallowest = indent;
  }
  if (shallowest !== null) return shallowest;
  return `${parentIndent}${parentIndent.includes("\t") ? "\t" : documentIndentUnit(doc)}`;
}

function noteIndent(doc: ParsedDoc, parentLine: number): string {
  const end = parentLine + blockLength(doc, parentLine);
  let first: string | null = null;
  let fence: string | null = null;
  for (let index = parentLine + 1; index < end; index += 1) {
    const text = (doc.lines[index] as DocLine).text;
    const fenceMatch = text.match(FENCE_RE);
    if (fence !== null) {
      if (closesFence(fenceMatch, fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] as string;
      continue;
    }
    if (text.trim() === "") continue;
    const indent = leadingSpace(text);
    if (first === null || indentDepth(indent) < indentDepth(first)) first = indent;
  }
  return first ?? childIndent(doc, parentLine);
}

function composeTaskLine(indent: string, status: BoardStatus, title: string, reason: string | null, priority: number | null, dates: BoardDates, config: TasksFeatureSettings): string {
  const checkbox = status === "doing" ? "-" : status === "done" ? "x" : " ";
  let span = "";
  if (carriesReason(status)) {
    const first = config.prefixes[status as PrefixStatus][0];
    if (first === undefined) throw new BadRequestError(`no prefix configured for ${status}`);
    span = `${first}${config.separator}`;
  }
  const token = priority === null ? "" : ` ${formatPriority(config, priority)}`;
  const signifiers = formatSignifiers(dates);
  return `${indent}- [${checkbox}] ${span}${joinReason(title, reason, config.reasonSeparator)}${token}${signifiers === "" ? "" : ` ${signifiers}`}`;
}

export function createBoardTask(settings: DelegationSettings, input: BoardCreateInput): BoardCreateResult {
  const title = cleanTitle(validateTitle(input.title), settings.tasks);
  const status = input.status ?? "todo";
  if (!(BOARD_STATUSES as readonly string[]).includes(status)) throw new BadRequestError(`status must be one of: ${BOARD_STATUSES.join(", ")}`);
  const reason = cleanReason(input.reason, settings.tasks);
  const priority = priorityOf(input.priority);
  const dates = datesOf(input, settings.tasks);
  if (reason !== null && !carriesReason(status)) throw new BadRequestError("reason only applies to blocked, hold and archived tasks");
  ensureReasonFits(reason, settings.tasks);
  if (input.parentLine !== undefined && input.parentRaw === undefined) throw new BadRequestError("parentRaw required with parentLine");
  const file = locateProject(settings, input.projectId);
  const content = readProjectFile(file);
  const config = settings.tasks;
  const doc = openDoc(content);
  let at: number;
  if (input.parentLine !== undefined) {
    const parent = checkFresh(content, file, config, input.parentLine, input.parentRaw as string);
    ensureNotOccurrence(parseBoardTasks(content, file.id, config), parent.line, config);
    const indent = childIndent(doc, parent.line);
    at = parent.line + blockLength(doc, parent.line);
    doc.lines.splice(at, 0, docLine(composeTaskLine(indent, status, title, reason, priority, dates, config)));
  } else if (status === "done" && doneSectionName(config) !== null) {
    const line = `${composeTaskLine("", status, title, reason, priority, dates, config)}${formatStamp(config, localDate())}`;
    at = insertIntoDone(doc, [docLine(line)], config);
  } else {
    at = insertIntoOpenEnd(doc, [docLine(composeTaskLine("", status, title, reason, priority, dates, config))], config);
  }
  const next = renderDoc(doc);
  const updatedAt = commitFile(file, next);
  const task = findTaskAt(parseBoardTasks(next, file.id, config), at);
  if (!task) throw new BadRequestError("the new task is outside the configured sections");
  return { task, updatedAt };
}

function validateNoteText(text: unknown): string {
  if (typeof text !== "string" || text.trim() === "" || /[\r\n]/.test(text)) throw new BadRequestError("text must be a single non-empty line");
  const trimmed = text.trim();
  if (NOTE_FORBIDDEN_RE.test(trimmed)) throw new BadRequestError(NOTE_SHAPE_ERROR);
  return trimmed;
}

function ensureNoteShape(line: string): void {
  if (TASK_LINE_RE.test(line) || FENCE_RE.test(line)) throw new BadRequestError(NOTE_SHAPE_ERROR);
}

function locateNote(content: string, file: WalkedFile, config: TasksFeatureSettings, line: number, raw: string): { owner: BoardTask; note: BoardNoteItem } {
  const lines = stripBom(content).split(LINE_SPLIT_RE);
  const owner = flattenTasks(parseBoardTasks(content, file.id, config)).find((task) => task.noteItems.some((note) => note.line === line)) ?? null;
  if (lines[line] !== raw) throw new TaskConflictError(owner);
  const note = owner?.noteItems.find((candidate) => candidate.line === line);
  if (!owner || !note) throw new BadRequestError("line is not a note of a task in the configured section");
  return { owner, note };
}

function freshOwner(next: string, file: WalkedFile, config: TasksFeatureSettings, line: number): BoardNoteResult {
  const task = findTaskAt(parseBoardTasks(next, file.id, config), line);
  if (!task) throw new BadRequestError("the task is outside the configured sections");
  return { task };
}

export function addBoardNote(settings: DelegationSettings, input: BoardNoteInput): BoardNoteResult {
  const text = validateNoteText(input.text);
  const file = locateProject(settings, input.projectId);
  const content = readProjectFile(file);
  const config = settings.tasks;
  const parent = checkFresh(content, file, config, input.line, input.raw);
  ensureNotOccurrence(parseBoardTasks(content, file.id, config), parent.line, config);
  const doc = openDoc(content);
  const line = `${noteIndent(doc, parent.line)}- ${text}`;
  ensureNoteShape(line);
  const at = parent.line + blockLength(doc, parent.line);
  doc.lines.splice(at, 0, docLine(line));
  const next = renderDoc(doc);
  const result = freshOwner(next, file, config, parent.line);
  if (!result.task.noteItems.some((note) => note.line === at)) throw new BadRequestError("the new note would fall outside the task");
  commitFile(file, next);
  return result;
}

export function editBoardNote(settings: DelegationSettings, input: BoardNoteInput): BoardNoteResult {
  const text = validateNoteText(input.text);
  const file = locateProject(settings, input.projectId);
  const content = readProjectFile(file);
  const config = settings.tasks;
  const { owner, note } = locateNote(content, file, config, input.line, input.raw);
  ensureNotOccurrence(parseBoardTasks(content, file.id, config), note.line, config);
  const lead = note.raw.match(/^(\s*)([-*+]\s+)?/) as RegExpMatchArray;
  const line = `${lead[1] ?? ""}${lead[2] ?? ""}${text}`;
  ensureNoteShape(line);
  const doc = openDoc(content);
  (doc.lines[note.line] as DocLine).text = line;
  const next = renderDoc(doc);
  if (next !== content) commitFile(file, next);
  return freshOwner(next, file, config, owner.line);
}

function noteRemoval(doc: ParsedDoc, start: number): Set<number> {
  const end = start + blockLength(doc, start);
  const removed = new Set<number>([start]);
  let fence: string | null = null;
  let fenceKept = false;
  let keptUntil = start;
  for (let index = start + 1; index < end; index += 1) {
    const text = (doc.lines[index] as DocLine).text;
    const kept = index < keptUntil;
    const fenceMatch = text.match(FENCE_RE);
    if (fence !== null) {
      if (kept !== fenceKept) throw new BadRequestError(NOTE_FENCE_ERROR);
      if (closesFence(fenceMatch, fence)) fence = null;
    } else if (fenceMatch) {
      fence = fenceMatch[1] as string;
      fenceKept = kept;
    } else if (!kept && TASK_LINE_RE.test(text)) {
      keptUntil = index + blockLength(doc, index);
      continue;
    }
    if (!kept) removed.add(index);
  }
  if (fence !== null) throw new BadRequestError(NOTE_FENCE_ERROR);
  return removed;
}

function settleNoteBlanks(doc: ParsedDoc, removed: Set<number>, start: number, ownerEnd: number): void {
  let from = start;
  while (from > 0 && isBlank(doc.lines[from - 1])) from -= 1;
  let to = Math.max(...removed) + 1;
  while (to < doc.lines.length && isBlank(doc.lines[to])) to += 1;
  let blanks: number[] = [];
  let trailing: number[] = [];
  let dirty = false;
  for (let index = from; index <= to; index += 1) {
    if (index < to && isBlank(doc.lines[index])) {
      blanks.push(index);
      trailing.push(index);
      continue;
    }
    if (index < to && removed.has(index)) {
      dirty = true;
      trailing = [];
      continue;
    }
    const keep = !dirty ? blanks : index >= ownerEnd ? trailing : [];
    for (const blank of blanks) {
      if (keep.includes(blank)) removed.delete(blank);
      else removed.add(blank);
    }
    blanks = [];
    trailing = [];
    dirty = false;
  }
}

export function deleteBoardNote(settings: DelegationSettings, input: BoardNoteRemoveInput): BoardNoteResult {
  const file = locateProject(settings, input.projectId);
  const content = readProjectFile(file);
  const config = settings.tasks;
  const { owner, note } = locateNote(content, file, config, input.line, input.raw);
  ensureNotOccurrence(parseBoardTasks(content, file.id, config), note.line, config);
  const doc = openDoc(content);
  const removed = noteRemoval(doc, note.line);
  settleNoteBlanks(doc, removed, note.line, owner.line + blockLength(doc, owner.line));
  doc.lines = doc.lines.filter((_line, position) => !removed.has(position));
  const next = renderDoc(doc);
  commitFile(file, next);
  return freshOwner(next, file, config, owner.line);
}

interface LocatedItem {
  tasks: BoardTask[];
  task: BoardTask | null;
  owner: BoardTask | null;
}

function parentTaskOf(tasks: BoardTask[], line: number): BoardTask | null {
  return flattenTasks(tasks).find((task) => task.subtasks.some((child) => child.line === line)) ?? null;
}

function locateItem(content: string, file: WalkedFile, config: TasksFeatureSettings, line: number, raw: string): LocatedItem {
  const lines = stripBom(content).split(LINE_SPLIT_RE);
  const tasks = parseBoardTasks(content, file.id, config);
  const task = findTaskAt(tasks, line);
  const owner = task ? parentTaskOf(tasks, line) : (flattenTasks(tasks).find((candidate) => candidate.noteItems.some((note) => note.line === line)) ?? null);
  if (lines[line] !== raw) throw new TaskConflictError(task ?? owner);
  if (!task && !owner) throw new BadRequestError("line is not a task or a note in the configured section");
  return { tasks, task, owner };
}

function resolveParent(content: string, tasks: BoardTask[], ref: BoardItemRef): BoardTask {
  const parent = findTaskAt(tasks, ref.line);
  if (stripBom(content).split(LINE_SPLIT_RE)[ref.line] !== ref.raw) throw new TaskConflictError(parent);
  if (!parent) throw new BadRequestError(PARENT_TASK_ERROR);
  return parent;
}

function fencedBlockLength(doc: ParsedDoc, start: number): number {
  const length = blockLength(doc, start);
  let fence: string | null = null;
  for (let index = start + 1; index < start + length; index += 1) {
    const fenceMatch = (doc.lines[index] as DocLine).text.match(FENCE_RE);
    if (fence !== null) {
      if (closesFence(fenceMatch, fence)) fence = null;
    } else if (fenceMatch) {
      fence = fenceMatch[1] as string;
    }
  }
  if (fence !== null) throw new BadRequestError(FENCE_BLOCK_ERROR);
  return length;
}

interface ItemRelation {
  kind: "task" | "note";
  parent: DocLine | null;
  section: BoardSection;
  group: string | null;
}

type Relations = Map<DocLine, ItemRelation>;

interface Placement {
  parent: DocLine | null;
  section: BoardSection;
  group: string | null;
}

function relationsOf(doc: ParsedDoc, projectId: string, config: TasksFeatureSettings): Relations {
  const rendered = renderDoc(doc);
  if (openDoc(rendered).lines.length !== doc.lines.length) throw new BadRequestError(STRUCTURE_ERROR);
  const relations: Relations = new Map();
  const visit = (tasks: BoardTask[], parent: DocLine | null): void => {
    for (const task of tasks) {
      const self = doc.lines[task.line] as DocLine;
      relations.set(self, { kind: "task", parent, section: task.section, group: task.group });
      for (const note of task.noteItems) relations.set(doc.lines[note.line] as DocLine, { kind: "note", parent: self, section: task.section, group: task.group });
      visit(task.subtasks, self);
    }
  };
  visit(parseBoardTasks(rendered, projectId, config), null);
  return relations;
}

function ensureRelations(actual: Relations, expected: Relations): void {
  if (actual.size !== expected.size) throw new BadRequestError(STRUCTURE_ERROR);
  for (const [line, want] of expected) {
    const got = actual.get(line);
    if (!got || got.kind !== want.kind || got.parent !== want.parent || got.section !== want.section || got.group !== want.group) {
      throw new BadRequestError(STRUCTURE_ERROR);
    }
  }
}

function withoutBlock(relations: Relations, block: Set<DocLine>): Relations {
  return new Map([...relations].filter(([line]) => !block.has(line)));
}

function relocated(before: Relations, block: DocLine[], place: Placement, rename: (line: DocLine) => DocLine | undefined): Relations {
  const expected: Relations = new Map();
  const root = block[0];
  for (const line of block) {
    const relation = before.get(line);
    if (!relation) continue;
    const key = rename(line);
    const parent = line === root ? place.parent : relation.parent === null ? undefined : rename(relation.parent);
    if (key === undefined || parent === undefined) throw new BadRequestError(STRUCTURE_ERROR);
    expected.set(key, { kind: relation.kind, parent, section: place.section, group: place.group });
  }
  return expected;
}

interface LineSnapshot {
  line: DocLine;
  text: string;
}

function snapshotLines(doc: ParsedDoc): LineSnapshot[] {
  return doc.lines.filter((line) => !isBlank(line)).map((line) => ({ line, text: line.text }));
}

function ensureLinesKept(before: LineSnapshot[], doc: ParsedDoc, rewritten: Map<DocLine, string>, gone: Set<DocLine>, added: Set<DocLine>, placeholderMayGo: boolean): void {
  const counts = new Map<DocLine, number>();
  for (const line of doc.lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const known = new Set<DocLine>();
  for (const { line, text } of before) {
    known.add(line);
    const count = counts.get(line) ?? 0;
    if (gone.has(line)) {
      if (count !== 0) throw new BadRequestError(STRUCTURE_ERROR);
      continue;
    }
    if (count === 0 && placeholderMayGo && isPlaceholderLine(text)) continue;
    if (count !== 1 || line.text !== (rewritten.get(line) ?? text)) throw new BadRequestError(STRUCTURE_ERROR);
  }
  for (const line of doc.lines) {
    if (known.has(line) || isBlank(line)) continue;
    if (added.has(line) ? counts.get(line) !== 1 : !headingOf(line.text)) throw new BadRequestError(STRUCTURE_ERROR);
  }
}

function cutBlock(doc: ParsedDoc, start: number, length: number): void {
  const end = start + length;
  let after = end;
  while (after < doc.lines.length && isBlank(doc.lines[after])) after += 1;
  let before = start;
  while (before > 0 && isBlank(doc.lines[before - 1])) before -= 1;
  const next = doc.lines[after];
  const continues = isListItem(next) && indentDepth((next as DocLine).text) >= indentDepth((doc.lines[start] as DocLine).text);
  if (continues) doc.lines.splice(start, after - start);
  else doc.lines.splice(before, end - before);
}

function rebaseBlock(block: DocLine[], indent: string): Map<DocLine, string> {
  const base = leadingSpace((block[0] as DocLine).text);
  const texts = new Map<DocLine, string>();
  for (const line of block) {
    if (isBlank(line)) continue;
    if (!line.text.startsWith(base)) throw new BadRequestError(MIXED_INDENT_ERROR);
    texts.set(line, `${indent}${line.text.slice(base.length)}`);
  }
  return texts;
}

function applyTexts(texts: Map<DocLine, string>): void {
  for (const [line, text] of texts) line.text = text;
}

function freshTask(next: string, file: WalkedFile, config: TasksFeatureSettings, line: number): BoardTask {
  const task = findTaskAt(parseBoardTasks(next, file.id, config), line);
  if (!task) throw new BadRequestError("the task is outside the configured sections");
  return task;
}

function headingBetween(doc: ParsedDoc, from: number, to: number): boolean {
  const [low, high] = from < to ? [from, to] : [to, from];
  let fence: string | null = null;
  for (let index = low + 1; index < high; index += 1) {
    const text = (doc.lines[index] as DocLine).text;
    const fenceMatch = text.match(FENCE_RE);
    if (fence) {
      if (closesFence(fenceMatch, fence)) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] as string;
      continue;
    }
    if (headingOf(text)) return true;
  }
  return false;
}

function siblingLines(doc: ParsedDoc, located: LocatedItem, line: number): number[] {
  const { tasks, task, owner } = located;
  if (owner) {
    return [...owner.subtasks.map((child) => child.line), ...owner.noteItems.map((note) => note.line)].filter((start) => start !== line).sort((a, b) => a - b);
  }
  const self = task as BoardTask;
  return tasks.filter((candidate) => candidate !== self && candidate.section === self.section && candidate.group === self.group && !headingBetween(doc, candidate.line, self.line)).map((candidate) => candidate.line);
}

function neighbourOf(doc: ParsedDoc, located: LocatedItem, line: number, length: number, direction: MoveDirection): number {
  const ends = new Map<number, number>();
  const endOf = (start: number): number => {
    const known = ends.get(start);
    if (known !== undefined) return known;
    const end = start + blockLength(doc, start);
    ends.set(start, end);
    return end;
  };
  const outside = siblingLines(doc, located, line).filter((start) => !(start > line && start < line + length));
  const containers = outside.filter((start) => start < line && line < endOf(start));
  const inner = containers[containers.length - 1];
  const scoped = outside.filter((start) => !containers.includes(start) && (inner === undefined || (start > inner && start < endOf(inner))));
  const pool = scoped.filter((start) => !scoped.some((other) => other < start && start < endOf(other)));
  const found = direction === "up" ? pool.filter((start) => start < line).pop() : pool.find((start) => start >= line + length);
  if (found === undefined) throw new BadRequestError(direction === "up" ? "already first" : "already last");
  return found;
}

export function moveBoardItem(settings: DelegationSettings, input: BoardMoveInput): BoardOrganizeResult {
  if (input.direction !== "up" && input.direction !== "down") throw new BadRequestError("direction must be up or down");
  const file = locateProject(settings, input.projectId);
  const content = readProjectFile(file);
  const config = settings.tasks;
  const located = locateItem(content, file, config, input.line, input.raw);
  ensureNotOccurrence(located.tasks, input.line, config);
  const doc = openDoc(content);
  const length = fencedBlockLength(doc, input.line);
  const neighbour = neighbourOf(doc, located, input.line, length, input.direction);
  const neighbourLength = fencedBlockLength(doc, neighbour);
  const [first, firstLength, second, secondLength]: [number, number, number, number] =
    input.direction === "up" ? [neighbour, neighbourLength, input.line, length] : [input.line, length, neighbour, neighbourLength];
  if (first + firstLength > second) throw new BadRequestError(STRUCTURE_ERROR);
  const gap = doc.lines.slice(first + firstLength, second);
  if (!gap.every((line) => isBlank(line))) throw new BadRequestError("other content sits between the two items");
  if (leadingSpace((doc.lines[first] as DocLine).text) !== leadingSpace((doc.lines[second] as DocLine).text)) {
    throw new BadRequestError("the two items do not share the same indentation");
  }
  const before = relationsOf(doc, file.id, config);
  const snapshot = snapshotLines(doc);
  const anchor = doc.lines[located.task ? input.line : (located.owner as BoardTask).line] as DocLine;
  const firstBlock = doc.lines.slice(first, first + firstLength);
  const secondBlock = doc.lines.slice(second, second + secondLength);
  doc.lines.splice(first, second + secondLength - first, ...secondBlock, ...gap, ...firstBlock);
  ensureLinesKept(snapshot, doc, new Map(), new Set(), new Set(), false);
  ensureRelations(relationsOf(doc, file.id, config), before);
  const next = renderDoc(doc);
  const task = freshTask(next, file, config, doc.lines.indexOf(anchor));
  if (next !== content) commitFile(file, next);
  return { task };
}

function promoteBlock(doc: ParsedDoc, located: LocatedItem, line: number, length: number, block: DocLine[], texts: Map<DocLine, string>): Placement {
  const top = topLevelOf(located.tasks, line) as BoardTask;
  fencedBlockLength(doc, top.line);
  const topLine = doc.lines[top.line] as DocLine;
  cutBlock(doc, line, length);
  applyTexts(texts);
  const topAt = doc.lines.indexOf(topLine);
  let at = topAt + blockLength(doc, topAt);
  const loose = isBlank(doc.lines[at]) && isListItem(doc.lines[at + 1]);
  if (loose) at += 1;
  doc.lines.splice(at, 0, ...block, ...(loose ? [docLine("")] : []));
  return { parent: null, section: top.section, group: top.group };
}

export function reparentBoardTask(settings: DelegationSettings, input: BoardReparentInput): BoardOrganizeResult {
  const file = locateProject(settings, input.projectId);
  const content = readProjectFile(file);
  const config = settings.tasks;
  const located = locateItem(content, file, config, input.line, input.raw);
  const self = located.task;
  if (!self) throw new BadRequestError("notes cannot be reparented");
  ensureNotOccurrence(located.tasks, input.line, config);
  const doc = openDoc(content);
  const length = fencedBlockLength(doc, input.line);
  const block = doc.lines.slice(input.line, input.line + length);
  const root = block[0] as DocLine;
  let parent: BoardTask | null = null;
  if (input.parent === null && !located.owner) throw new BadRequestError("the task is already top-level");
  if (input.parent !== null) {
    parent = resolveParent(content, located.tasks, input.parent);
    ensureNotOccurrence(located.tasks, parent.line, config);
    if (parent.line === input.line) throw new BadRequestError("a task cannot become its own subtask");
    const parentLine = parent.line;
    if ((parentLine > input.line && parentLine < input.line + length) || flattenTasks(self.subtasks).some((task) => task.line === parentLine)) {
      throw new BadRequestError("a task cannot move under its own subtask");
    }
    const parentLength = fencedBlockLength(doc, parentLine);
    if (located.owner?.line === parentLine && input.line + length === parentLine + parentLength) return { task: self };
  }
  const before = relationsOf(doc, file.id, config);
  const snapshot = snapshotLines(doc);
  const texts = rebaseBlock(block, parent === null ? "" : childIndent(doc, parent.line));
  let place: Placement;
  if (parent === null) {
    place = promoteBlock(doc, located, input.line, length, block, texts);
  } else {
    const parentLine = doc.lines[parent.line] as DocLine;
    cutBlock(doc, input.line, length);
    applyTexts(texts);
    const parentAt = doc.lines.indexOf(parentLine);
    doc.lines.splice(parentAt + blockLength(doc, parentAt), 0, ...block);
    place = { parent: parentLine, section: parent.section, group: parent.group };
  }
  ensureLinesKept(snapshot, doc, texts, new Set(), new Set(), false);
  ensureRelations(relationsOf(doc, file.id, config), new Map([...withoutBlock(before, new Set(block)), ...relocated(before, block, place, (line) => line)]));
  const next = renderDoc(doc);
  const task = freshTask(next, file, config, doc.lines.indexOf(root));
  if (next !== content) commitFile(file, next);
  return { task };
}

function locateTargetProject(settings: DelegationSettings, projectId: string): WalkedFile {
  try {
    return locateProject(settings, projectId);
  } catch (err) {
    if (err instanceof NotFoundError) throw new NotFoundError("target project not found");
    throw err;
  }
}

export function moveTaskToProject(settings: DelegationSettings, input: BoardMoveToProjectInput): BoardOrganizeResult {
  const file = locateProject(settings, input.projectId);
  if (input.targetProjectId === input.projectId) throw new BadRequestError("the task is already in this project, use reparent to move it inside the file");
  const target = locateTargetProject(settings, input.targetProjectId);
  const content = readProjectFile(file);
  const targetContent = readProjectFile(target);
  const config = settings.tasks;
  const located = locateItem(content, file, config, input.line, input.raw);
  const self = located.task;
  if (!self) throw new BadRequestError("only tasks can be moved to another project");
  ensureNotOccurrence(located.tasks, input.line, config);
  const doc = openDoc(content);
  const length = fencedBlockLength(doc, input.line);
  const targetDoc = openDoc(targetContent);
  const targetTasks = parseBoardTasks(targetContent, target.id, config);
  const parent = input.parent ? resolveParent(targetContent, targetTasks, input.parent) : null;
  if (parent) ensureNotOccurrence(targetTasks, parent.line, config);
  if (parent) fencedBlockLength(targetDoc, parent.line);
  const stamped = parent === null && located.owner === null && self.section === "done" && self.doneAt !== null && doneSectionName(config) !== null;
  const block = doc.lines.slice(input.line, input.line + length);
  const texts = rebaseBlock(block, parent ? childIndent(targetDoc, parent.line) : "");
  const copies = new Map(block.map((line): [DocLine, DocLine] => [line, docLine(texts.get(line) ?? line.text)]));
  const moved = block.map((line) => copies.get(line) as DocLine);
  const root = moved[0] as DocLine;
  const sourceBefore = relationsOf(doc, file.id, config);
  const sourceSnapshot = snapshotLines(doc);
  const targetBefore = relationsOf(targetDoc, target.id, config);
  const targetSnapshot = snapshotLines(targetDoc);
  const parentLine = parent ? (targetDoc.lines[parent.line] as DocLine) : null;
  cutBlock(doc, input.line, length);
  if (parentLine) {
    const parentAt = targetDoc.lines.indexOf(parentLine);
    targetDoc.lines.splice(parentAt + blockLength(targetDoc, parentAt), 0, ...moved);
  } else if (stamped) {
    insertIntoDone(targetDoc, moved, config);
  } else {
    insertIntoOpenEnd(targetDoc, moved, config);
  }
  const blockSet = new Set(block);
  ensureLinesKept(sourceSnapshot, doc, new Map(), blockSet, new Set(), false);
  ensureRelations(relationsOf(doc, file.id, config), withoutBlock(sourceBefore, blockSet));
  ensureLinesKept(targetSnapshot, targetDoc, new Map(), new Set(), new Set(moved), parentLine === null);
  const targetAfter = relationsOf(targetDoc, target.id, config);
  const place: Placement = parent
    ? { parent: parentLine, section: parent.section, group: parent.group }
    : { parent: null, section: stamped ? "done" : "open", group: targetAfter.get(root)?.group ?? null };
  ensureRelations(targetAfter, new Map([...targetBefore, ...relocated(sourceBefore, block, place, (line) => copies.get(line))]));
  const nextSource = renderDoc(doc);
  const nextTarget = renderDoc(targetDoc);
  const task = freshTask(nextTarget, target, config, targetDoc.lines.indexOf(root));
  commitFile(target, nextTarget);
  try {
    commitFile(file, nextSource);
  } catch (err) {
    try {
      commitFile(target, targetContent);
    } catch {
    }
    throw err;
  }
  return { task };
}

function sweepDocument(doc: ParsedDoc, config: TasksFeatureSettings, projectId: string, date: string): number {
  let moved = 0;
  let previous = Number.POSITIVE_INFINITY;
  let previousRecurring = Number.POSITIVE_INFINITY;
  const skipped = new Set<string>();
  for (;;) {
    const parsed = parseBoardTasks(renderDoc(doc), projectId, config);
    const recurring = parsed.filter((task) => isPendingRecurrence(task) && !skipped.has(task.raw));
    const occurrence = recurring[recurring.length - 1];
    if (occurrence) {
      if (recurring.length >= previousRecurring) return moved;
      previousRecurring = recurring.length;
      try {
        recurBlock(doc, config, occurrence, date);
        moved += 1;
      } catch (err) {
        if (!(err instanceof BadRequestError)) throw err;
        skipped.add(occurrence.raw);
      }
      continue;
    }
    const eligible = parsed.filter((task) => task.section === "open" && !isPendingRecurrence(task) && isFinished(task));
    const target = eligible[eligible.length - 1];
    if (!target || eligible.length >= previous) return moved;
    previous = eligible.length;
    moveBlockToDone(doc, config, target.line, date);
    moved += 1;
  }
}

export function sweepDoneTasks(settings: DelegationSettings, projectId: string | null): BoardSweepResult {
  const root = requireBoardRoot(settings);
  const config = settings.tasks;
  if (doneSectionName(config) === null) throw new BadRequestError("the done section is not configured");
  const files = projectId ? [locateProject(settings, projectId)] : walkProjects(root, config.exclude);
  const date = localDate();
  const projects: string[] = [];
  let moved = 0;
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file.abs, "utf8");
    } catch {
      continue;
    }
    const doc = openDoc(content);
    const count = sweepDocument(doc, config, file.id, date);
    if (count === 0) continue;
    commitFile(file, renderDoc(doc));
    moved += count;
    projects.push(file.id);
  }
  return { moved, projects };
}

export interface TaskDelegatePromptVars {
  project: string;
  projectPath: string;
  task: string;
  subtasks: string;
  notes: string;
  status: string;
  reason: string;
  priority: string;
}

export function renderTaskDelegatePrompt(template: string, vars: TaskDelegatePromptVars): string {
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

function subtaskLines(tasks: BoardTask[], level: number): string[] {
  return tasks.flatMap((task) => {
    const mark = task.checkbox === "done" ? "x" : task.checkbox === "doing" ? "-" : " ";
    const base = task.prefix ? `${task.prefix} - ${task.title}` : task.title;
    const label = task.reason ? `${base} - ${task.reason}` : base;
    return [`${"  ".repeat(level)}- [${mark}] ${label}`, ...subtaskLines(task.subtasks, level + 1)];
  });
}

export function taskPromptVars(project: BoardProject, task: BoardTask): TaskDelegatePromptVars {
  const subtasks = subtaskLines(task.subtasks, 0);
  return {
    project: project.title,
    projectPath: project.path,
    task: task.title,
    subtasks: subtasks.length > 0 ? subtasks.join("\n") : "none",
    notes: task.notes.length > 0 ? task.notes.map((note) => `- ${note}`).join("\n") : "none",
    status: task.status,
    reason: task.reason ?? "none",
    priority: task.priority === null ? "none" : `P${task.priority}`,
  };
}

export function delegateBoardTask(settings: DelegationSettings, input: BoardDelegateInput): BoardDelegateResult {
  const file = locateProject(settings, input.projectId);
  const content = readProjectFile(file);
  const task = checkFresh(content, file, settings.tasks, input.line, input.raw);
  ensureNotOccurrence(parseBoardTasks(content, file.id, settings.tasks), task.line, settings.tasks);
  const detail = delegateTask({
    prompt: input.prompt,
    workspace: input.workspace,
    repo: input.repo,
    runner: input.runner,
    model: null,
    permissionMode: null,
    sandbox: null,
    title: task.title,
    source: "tasks-board",
  });
  if (!settings.tasks.markDoingOnDelegate || task.status !== "todo") return { taskId: detail.task.id, task };
  try {
    const written = writeBoardTask(settings, { projectId: input.projectId, line: input.line, raw: input.raw, status: "doing" });
    syncTodayAfterTaskWrite(settings, written.task, false);
    return { taskId: detail.task.id, task: written.task };
  } catch (err) {
    const warning = err instanceof Error ? err.message : "could not mark the task as doing";
    if (err instanceof TaskConflictError && err.current) return { taskId: detail.task.id, task: err.current, warning };
    return { taskId: detail.task.id, task, warning };
  }
}

const WIKILINK_LEAD_RE = /^\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/;
const LABEL_TAIL_RE = /^\s*(?:[-–—]\s+|:\s*)?/;
const LABEL_SPLIT = " - ";

function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.,;:!?]+$/, "");
}

function resolveProjectLabel(label: string, projects: BoardProject[]): string | null {
  const wanted = normalizeText(label);
  if (wanted === "") return null;
  const hits = projects.filter((project) => normalizeText(project.name) === wanted || normalizeText(project.title) === wanted);
  return hits.length === 1 ? (hits[0] as BoardProject).id : null;
}

interface LabelSplit {
  label: string | null;
  projectId: string | null;
  text: string;
}

function splitLabel(text: string, projects: BoardProject[]): LabelSplit {
  const wiki = text.match(WIKILINK_LEAD_RE);
  if (wiki) {
    const target = (wiki[1] ?? "").trim();
    const name = (target.split("/").pop() ?? "").replace(MARKDOWN_RE, "").trim();
    const alias = (wiki[2] ?? "").trim();
    const rest = text.slice(wiki[0].length).replace(LABEL_TAIL_RE, "").trim();
    const projectId = resolveProjectLabel(name, projects) ?? (alias === "" ? null : resolveProjectLabel(alias, projects));
    return { label: name === "" ? null : name, projectId, text: rest };
  }
  let found: LabelSplit | null = null;
  let index = text.indexOf(LABEL_SPLIT);
  while (index !== -1) {
    const label = text.slice(0, index).trim();
    const projectId = index > 0 ? resolveProjectLabel(label, projects) : null;
    if (projectId) found = { label, projectId, text: text.slice(index + LABEL_SPLIT.length).trim() };
    index = text.indexOf(LABEL_SPLIT, index + 1);
  }
  return found ?? { label: null, projectId: null, text: text.trim() };
}

function prefixMatches(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  const shorter = a.length <= b.length ? a : b;
  return shorter.length >= MIN_PREFIX_MATCH && (a.startsWith(b) || b.startsWith(a));
}

interface TaskMatch {
  task: BoardTask | null;
  candidates: string[];
}

function taskNeedle(text: string, config: TasksFeatureSettings): string {
  const clean = removePriorityTokens(splitSignifiers(text.trim(), config).text, config);
  return normalizeText(matchPrefix(clean, config)?.title ?? clean);
}

function matchTask(text: string, projectId: string | null, pool: BoardTask[], config: TasksFeatureSettings): TaskMatch {
  const needle = taskNeedle(text, config);
  if (needle === "") return { task: null, candidates: [] };
  let bestRank = Number.POSITIVE_INFINITY;
  let best: BoardTask[] = [];
  for (const task of pool) {
    if (projectId !== null && task.projectId !== projectId) continue;
    const title = normalizeText(task.title);
    const full = normalizeText(joinReason(task.title, task.reason, config.reasonSeparator));
    let rank = Number.POSITIVE_INFINITY;
    if (needle === full || needle === title) rank = 0;
    else if (prefixMatches(needle, full) || prefixMatches(needle, title)) rank = 1;
    if (rank === Number.POSITIVE_INFINITY || rank > bestRank) continue;
    if (rank < bestRank) {
      bestRank = rank;
      best = [];
    }
    best.push(task);
  }
  if (best.length === 1) return { task: best[0] as BoardTask, candidates: [] };
  return { task: null, candidates: best.slice(0, MAX_CANDIDATES).map((task) => task.id) };
}

const SYNCED_STATUSES: ReadonlySet<BoardStatus> = new Set<BoardStatus>(["todo", "doing", "done"]);

const isSyncedStatus = (status: BoardStatus): boolean => SYNCED_STATUSES.has(status);

function isMismatch(checkbox: BoardCheckbox, status: BoardStatus): boolean {
  return isSyncedStatus(status) && checkbox !== checkboxForStatus(status);
}

const CHECKBOX_MARK: Record<BoardCheckbox, string> = { todo: " ", doing: "-", done: "x" };
const DAILY_MARK_RE = /^(\s*[-*]\s+\[)([ xX-])(\])/;
const DAILY_SUBTASK_INDENT = "  ";

export function checkboxForStatus(status: BoardStatus): BoardCheckbox {
  if (status === "done" || status === "archived") return "done";
  return status === "doing" ? "doing" : "todo";
}

export function effectiveProjectOrder(projects: BoardProject[], order: string[]): string[] {
  const known = new Set(projects.map((project) => project.id));
  const head = [...new Set(order)].filter((id) => known.has(id));
  const listed = new Set(head);
  return [...head, ...projects.map((project) => project.id).filter((id) => !listed.has(id))];
}

export function composeBoardFor(settings: DelegationSettings): ComposeBoard | null {
  if (!settings.features.daily || !settings.features.tasks) return null;
  const root = tasksRoot(settings);
  if (!root) return null;
  try {
    const { projects } = loadBoard(root, settings.tasks);
    if (projects.length === 0) return null;
    return {
      projects: projects.map((project) => ({ id: project.id, name: project.name, title: project.title })),
      order: effectiveProjectOrder(projects, settings.daily.projectOrder),
      projectOfLabel: (label) => resolveProjectLabel(label, projects),
      projectOfLine: (text) => splitLabel(text, projects).projectId,
    };
  } catch {
    return null;
  }
}

interface FocusRange {
  heading: number;
  end: number;
}

function focusRange(lines: string[], settings: DelegationSettings): FocusRange | null {
  const heading = findHeadingIndex(lines, settings.daily.headings.focus);
  if (heading === -1) return null;
  for (let index = heading + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index] ?? "")) return { heading, end: index };
  }
  return { heading, end: lines.length };
}

interface RecurrenceIndex {
  pool: BoardTask[];
  roots: Map<string, BoardTask>;
  originals: BoardTask[];
  occurrences: BoardTask[];
}

const isRecurringOriginal = (task: BoardTask): boolean => task.section === "open" && task.repeat !== null && task.doneAt === null;

function recurrenceIndex(tasks: BoardTask[]): RecurrenceIndex {
  const roots = new Map<string, BoardTask>();
  const excluded = new Set<string>();
  const occurrences: BoardTask[] = [];
  for (const task of tasks) {
    const members = flattenTasks([task]);
    for (const member of members) roots.set(member.id, task);
    if (task.repeat === null || task.doneAt === null) continue;
    occurrences.push(task);
    for (const member of members) excluded.add(member.id);
  }
  return { pool: flattenTasks(tasks).filter((task) => !excluded.has(task.id)), roots, originals: tasks.filter(isRecurringOriginal), occurrences };
}

function occurrenceOf(index: RecurrenceIndex, original: BoardTask, needle: string, copy: BoardTask): boolean {
  const title = normalizeText(copy.title);
  const own = normalizeText(original.title);
  if (title === own) return true;
  if (index.originals.some((other) => other.id !== original.id && other.projectId === copy.projectId && normalizeText(other.title) === title)) return false;
  return title === needle || prefixMatches(title, own) || prefixMatches(title, needle);
}

function recurringRoot(index: RecurrenceIndex, task: BoardTask | null): BoardTask | null {
  const original = task === null ? undefined : index.roots.get(task.id);
  return original && isRecurringOriginal(original) ? original : null;
}

function recurredOn(index: RecurrenceIndex, original: BoardTask | null, needle: string, date: string): boolean {
  if (!original) return false;
  return index.occurrences.some((copy) => copy.projectId === original.projectId && copy.doneAt === date && occurrenceOf(index, original, needle, copy));
}

interface FocusChild {
  line: number;
  depth: number;
  raw: string;
  checkbox: BoardCheckbox;
  text: string;
  task: BoardTask | null;
}

interface FocusEntry {
  line: number;
  raw: string;
  checkbox: BoardCheckbox;
  label: string | null;
  projectId: string | null;
  text: string;
  match: TaskMatch;
  recurred: boolean;
  recurring: boolean;
  held: boolean;
  children: FocusChild[];
}

interface DailyLineLink {
  line: number;
  depth: number;
  raw: string;
  checkbox: BoardCheckbox;
  task: BoardTask;
  held: boolean;
}

interface FocusScan {
  entries: FocusEntry[];
  links: DailyLineLink[];
}

function focusEntries(settings: DelegationSettings, date: string, content: string, projects: BoardProject[], index: RecurrenceIndex): FocusEntry[] {
  const range = focusRange(content.split(LINE_SPLIT_RE), settings);
  if (!range) return [];
  const entries: FocusEntry[] = [];
  let current: FocusEntry | null = null;
  let blockEnd = -1;
  let stack: { depth: number; task: BoardTask | null }[] = [];
  for (const entry of parseTaskLines(content)) {
    if (entry.line <= range.heading || entry.line >= range.end) continue;
    if (entry.depth === 0 || entry.line >= blockEnd) {
      current = null;
      stack = [];
      blockEnd = -1;
      if (entry.depth !== 0 || entry.text.trim() === "") continue;
      const split = splitLabel(entry.text.trim(), projects);
      const match = matchTask(split.text, split.projectId, index.pool, settings.tasks);
      blockEnd = entry.line + taskBlock(content, entry.line).split(LINE_SPLIT_RE).length;
      const root = recurringRoot(index, match.task);
      const recurred = recurredOn(index, root, taskNeedle(split.text, settings.tasks), date);
      const held = root !== null && (date !== localDate() || match.task?.id !== root.id || recurred);
      current = { line: entry.line, raw: entry.raw, checkbox: entry.state, label: split.label, projectId: split.projectId, text: split.text, match, recurred, recurring: root !== null, held, children: [] };
      entries.push(current);
      stack.push({ depth: 0, task: match.task });
      continue;
    }
    if (!current) continue;
    while (stack.length > 1 && (stack[stack.length - 1] as { depth: number }).depth >= entry.depth) stack.pop();
    const parent = stack[stack.length - 1]?.task ?? null;
    const text = entry.text.trim();
    const task = parent && text !== "" ? matchTask(text, null, parent.subtasks, settings.tasks).task : null;
    stack.push({ depth: entry.depth, task });
    if (text !== "") current.children.push({ line: entry.line, depth: entry.depth, raw: entry.raw, checkbox: entry.state, text, task });
  }
  return entries;
}

function scanDaily(settings: DelegationSettings, date: string, content: string, projects: BoardProject[], tasks: BoardTask[]): FocusScan {
  const index = recurrenceIndex(tasks);
  const entries = focusEntries(settings, date, content, projects, index);
  const links: DailyLineLink[] = [];
  for (const entry of entries) {
    if (entry.match.task) links.push({ line: entry.line, depth: 0, raw: entry.raw, checkbox: entry.checkbox, task: entry.match.task, held: entry.held });
    if (entry.recurring) continue;
    for (const child of entry.children) {
      if (child.task) links.push({ line: child.line, depth: child.depth, raw: child.raw, checkbox: child.checkbox, task: child.task, held: false });
    }
  }
  return { entries, links };
}

function computeDailyLinks(
  settings: DelegationSettings,
  date: string,
  projects: BoardProject[],
  tasks: BoardTask[],
  daily: DailyReadResult = readDaily(settings, date),
  scan: FocusScan | null = null,
): DailyLinksResult {
  const result: DailyLinksResult = { date, exists: daily.exists, path: daily.path, items: [], taskIds: [] };
  if (!daily.exists) return result;
  const { entries } = scan ?? scanDaily(settings, date, daily.content, projects, tasks);
  const ids = new Set<string>();
  for (const entry of entries) {
    const task = entry.match.task;
    if (task) ids.add(task.id);
    result.items.push({
      line: entry.line,
      raw: entry.raw,
      checkbox: entry.checkbox,
      label: entry.label,
      projectId: entry.projectId,
      text: entry.text,
      taskId: task?.id ?? null,
      candidates: entry.match.candidates,
      taskStatus: task?.status ?? null,
      taskPriority: task?.priority ?? null,
      mismatch: task !== null && !entry.held && isMismatch(entry.checkbox, task.status),
      recurredToday: entry.recurred,
      children: entry.children.map((child) => ({
        line: child.line,
        depth: child.depth,
        raw: child.raw,
        checkbox: child.checkbox,
        text: child.text,
        taskId: child.task?.id ?? null,
        taskStatus: child.task?.status ?? null,
        mismatch: child.task !== null && !entry.recurring && isMismatch(child.checkbox, child.task.status),
      })),
    });
  }
  result.taskIds = [...ids];
  return result;
}

function todayBlock(settings: DelegationSettings, projects: BoardProject[], tasks: BoardTask[]): BoardToday | null {
  if (!settings.features.daily || !settings.features.tasks) return null;
  const date = localDate();
  try {
    const daily = readDaily(settings, date);
    const scan = daily.exists ? scanDaily(settings, date, daily.content, projects, tasks) : null;
    const links = computeDailyLinks(settings, date, projects, tasks, daily, scan);
    const states: Record<string, BoardCheckbox> = {};
    for (const item of links.items) {
      if (item.taskId && states[item.taskId] === undefined) states[item.taskId] = item.checkbox;
    }
    const mismatch = new Set<string>();
    for (const link of scan?.links ?? []) {
      if (states[link.task.id] === undefined) states[link.task.id] = link.checkbox;
      if (!link.held && isMismatch(link.checkbox, link.task.status)) mismatch.add(link.task.id);
    }
    return { date, exists: links.exists, taskIds: links.taskIds, states, mismatch: [...mismatch] };
  } catch {
    return null;
  }
}

function requireBothFeatures(settings: DelegationSettings): string {
  if (!settings.features.daily || !settings.features.tasks) throw new BadRequestError("the daily and tasks features must both be enabled");
  return requireBoardRoot(settings);
}

function requireDailyDate(date: string): void {
  if (!isValidDailyDate(date)) throw new BadRequestError("date must be YYYY-MM-DD");
}

export function dailyTaskLinks(settings: DelegationSettings, date: string): DailyLinksResult {
  const root = requireBothFeatures(settings);
  requireDailyDate(date);
  const { loaded, tasks } = collectBoard(root, settings.tasks);
  return computeDailyLinks(settings, date, loaded.projects, tasks);
}

function subtaskDailyLines(subtasks: BoardTask[], level: number): string[] {
  return subtasks.flatMap((subtask) => [
    `${DAILY_SUBTASK_INDENT.repeat(level)}- [${CHECKBOX_MARK[checkboxForStatus(subtask.status)]}] ${subtask.title}`,
    ...subtaskDailyLines(subtask.subtasks, level + 1),
  ]);
}

interface FocusItem {
  start: number;
  last: number;
  projectId: string | null;
}

function focusItems(doc: ParsedDoc, range: FocusRange, projects: BoardProject[]): FocusItem[] {
  const items: FocusItem[] = [];
  let index = range.heading + 1;
  while (index < range.end) {
    const line = doc.lines[index] as DocLine;
    if (isBlank(line)) {
      index += 1;
      continue;
    }
    const last = Math.min(index + blockLength(doc, index), range.end) - 1;
    const match = indentDepth(line.text) === 0 ? line.text.match(TASK_LINE_RE) : null;
    const text = match ? (match[3] as string).trim() : "";
    items.push({ start: index, last, projectId: text === "" ? null : splitLabel(text, projects).projectId });
    index = last + 1;
  }
  return items;
}

function placeInFocus(doc: ParsedDoc, settings: DelegationSettings, block: DocLine[], projectId: string, projects: BoardProject[]): number {
  const texts = textsOf(doc);
  const range = focusRange(texts, settings);
  if (!range) {
    const last = lastNonBlank(doc);
    const at = last + 1;
    doc.lines.splice(at, 0, ...(last >= 0 ? [docLine("")] : []), docLine(`## ${settings.daily.headings.focus}`), docLine(""), ...block);
    return at + (last >= 0 ? 1 : 0) + 2;
  }
  const contentIndexes: number[] = [];
  for (let index = range.heading + 1; index < range.end; index += 1) if (!isBlank(doc.lines[index])) contentIndexes.push(index);
  if (contentIndexes.length === 0) return appendToSection(doc, { heading: range.heading, level: 2, end: range.end }, block);
  if (contentIndexes.every((index) => isPlaceholderLine(texts[index] ?? ""))) {
    const at = contentIndexes[0] as number;
    const lastPlaceholder = contentIndexes[contentIndexes.length - 1] as number;
    doc.lines.splice(at, lastPlaceholder - at + 1, ...block);
    return at;
  }
  const items = focusItems(doc, range, projects);
  const own = items.filter((item) => item.projectId === projectId).pop();
  if (own) {
    doc.lines.splice(own.last + 1, 0, ...block);
    return own.last + 1;
  }
  const order = effectiveProjectOrder(projects, settings.daily.projectOrder);
  const rank = (id: string | null): number => {
    const position = id === null ? -1 : order.indexOf(id);
    return position === -1 ? Number.POSITIVE_INFINITY : position;
  };
  const wanted = rank(projectId);
  const nextIndex = items.findIndex((item) => rank(item.projectId) > wanted);
  if (nextIndex === -1) {
    const last = (items[items.length - 1] as FocusItem).last;
    doc.lines.splice(last + 1, 0, docLine(""), ...block);
    return last + 2;
  }
  const next = items[nextIndex] as FocusItem;
  if (nextIndex === 0) {
    doc.lines.splice(next.start, 0, ...block, docLine(""));
    return next.start;
  }
  const previousLast = (items[nextIndex - 1] as FocusItem).last;
  doc.lines.splice(previousLast + 1, next.start - previousLast - 1, docLine(""), ...block, docLine(""));
  return previousLast + 2;
}

export function addTaskToDaily(settings: DelegationSettings, input: AddToDailyInput): AddToDailyResult {
  const root = requireBothFeatures(settings);
  const date = input.date ?? localDate();
  requireDailyDate(date);
  const file = locateProject(settings, input.projectId);
  const content = readProjectFile(file);
  const task = checkFresh(content, file, settings.tasks, input.line, input.raw);
  const parsed = parseBoardTasks(content, file.id, settings.tasks);
  ensureNotOccurrence(parsed, task.line, settings.tasks);
  const topLevel = parentTaskOf(parsed, task.line) === null;
  const daily = readDaily(settings, date);
  if (!daily.exists) throw new NotFoundError("create the daily first");
  const { loaded, tasks } = collectBoard(root, settings.tasks);
  const project = loaded.projects.find((candidate) => candidate.id === input.projectId);
  if (!project) throw new NotFoundError("project not found");
  const listed = computeDailyLinks(settings, date, loaded.projects, tasks, daily);
  if (listed.items.some((item) => item.taskId === task.id || item.candidates.includes(task.id))) throw new AlreadyInDailyError();
  const label = settings.daily.wikilinks ? `[[${project.name}|${project.title}]]` : project.title;
  const line = `- [${CHECKBOX_MARK[checkboxForStatus(task.status)]}] ${label} - ${task.title}`;
  const children = topLevel ? subtaskDailyLines(task.subtasks, 1) : [];
  const doc = openDoc(daily.content);
  const at = placeInFocus(doc, settings, [line, ...children].map(docLine), project.id, loaded.projects);
  writeDaily(settings, date, renderDoc(doc), daily.updatedAt ?? undefined);
  return { date, line: at, raw: line, subtasks: children.length };
}

interface DailyMark {
  line: number;
  checkbox: BoardCheckbox;
  wanted: BoardCheckbox;
}

const syncedMark = (link: DailyLineLink): DailyMark => ({ line: link.line, checkbox: link.checkbox, wanted: checkboxForStatus(link.task.status) });

function writeDailyMarks(settings: DelegationSettings, daily: DailyReadResult, marks: DailyMark[]): number {
  const doc = openDoc(daily.content);
  let updated = 0;
  for (const { line: at, checkbox, wanted } of marks) {
    const line = doc.lines[at];
    if (checkbox === wanted || !line) continue;
    line.text = line.text.replace(DAILY_MARK_RE, (_whole, open: string, _mark: string, close: string) => `${open}${CHECKBOX_MARK[wanted]}${close}`);
    updated += 1;
  }
  if (updated > 0) writeDaily(settings, daily.date, renderDoc(doc), daily.updatedAt ?? undefined);
  return updated;
}

function linksOfTask(links: DailyLineLink[], task: BoardTask, withDescendants: boolean): DailyLineLink[] {
  const descendants = new Set(withDescendants ? flattenTasks(task.subtasks).map((subtask) => subtask.id) : []);
  return links.filter((link) => !link.held && (link.task.id === task.id || (link.depth > 0 && descendants.has(link.task.id))));
}

function recurredItemMarks(entries: FocusEntry[], task: BoardTask): DailyMark[] {
  return entries.filter((entry) => entry.recurred && entry.match.task?.id === task.id).map((entry) => ({ line: entry.line, checkbox: entry.checkbox, wanted: "done" }));
}

function syncTodayAfterTaskWrite(settings: DelegationSettings, task: BoardTask, recurred: boolean): boolean {
  if (!settings.features.daily || !settings.features.tasks) return false;
  try {
    const root = requireBoardRoot(settings);
    const date = localDate();
    const daily = readDaily(settings, date);
    if (!daily.exists) return false;
    const { loaded, tasks } = collectBoard(root, settings.tasks);
    const scan = scanDaily(settings, date, daily.content, loaded.projects, tasks);
    const marks = recurred ? recurredItemMarks(scan.entries, task) : linksOfTask(scan.links, task, false).map(syncedMark);
    return writeDailyMarks(settings, daily, marks) > 0;
  } catch (err) {
    console.error(`daily sync after a task write failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function writeBoardTaskSynced(settings: DelegationSettings, input: BoardWriteInput): BoardSyncedWriteResult {
  const result = writeBoardTask(settings, input);
  const dailySynced = input.status !== undefined && syncTodayAfterTaskWrite(settings, result.task, result.recurred);
  return { ...result, dailySynced };
}

export function syncTaskToDaily(settings: DelegationSettings, input: SyncDailyInput): SyncDailyResult {
  const root = requireBothFeatures(settings);
  const date = input.date ?? localDate();
  requireDailyDate(date);
  const file = locateProject(settings, input.projectId);
  const task = checkFresh(readProjectFile(file), file, settings.tasks, input.line, input.raw);
  const daily = readDaily(settings, date);
  if (!daily.exists) throw new NotFoundError("create the daily first");
  const { loaded, tasks } = collectBoard(root, settings.tasks);
  const scan = scanDaily(settings, date, daily.content, loaded.projects, tasks);
  if (!scan.links.some((link) => link.task.id === task.id)) throw new NotFoundError("the task is not in the daily");
  return { date, updated: writeDailyMarks(settings, daily, linksOfTask(scan.links, task, true).map(syncedMark)) };
}

interface DailyStatusChange {
  task: BoardTask;
  status: BoardStatus;
}

const unmarkedLine = (raw: string): string => raw.replace(DAILY_MARK_RE, "$1$3");

function statusFromCheckbox(current: BoardStatus, checkbox: BoardCheckbox): BoardStatus | null {
  if (!isSyncedStatus(current)) return null;
  if (checkbox === "done") return current === "done" ? null : "done";
  if (checkbox === "doing") return current === "doing" ? null : "doing";
  return current === "done" || current === "doing" ? "todo" : null;
}

function statusChange(task: BoardTask, checkbox: BoardCheckbox): DailyStatusChange | null {
  const status = statusFromCheckbox(task.status, checkbox);
  return status === null ? null : { task, status };
}

function relocatedTask(settings: DelegationSettings, task: BoardTask): BoardTask {
  const file = locateProject(settings, task.projectId);
  const candidates = flattenTasks(parseBoardTasks(readProjectFile(file), file.id, settings.tasks)).filter((candidate) => candidate.raw === task.raw);
  const found = candidates.find((candidate) => candidate.line === task.line) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!found) throw new TaskConflictError(null);
  return found;
}

function applyStatusChange(settings: DelegationSettings, change: DailyStatusChange): void {
  const task = relocatedTask(settings, change.task);
  writeBoardTask(settings, { projectId: task.projectId, line: task.line, raw: task.raw, status: change.status });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dailyStatusChanges(settings: DelegationSettings, date: string, before: string, after: string, projects: BoardProject[], tasks: BoardTask[]): DailyStatusChange[] {
  const previous = new Map<string, BoardCheckbox[]>();
  for (const link of scanDaily(settings, date, before, projects, tasks).links) {
    const key = `${link.task.id}\u0000${unmarkedLine(link.raw)}`;
    previous.set(key, [...(previous.get(key) ?? []), link.checkbox]);
  }
  const afterScan = scanDaily(settings, date, after, projects, tasks);
  const wanted = new Map<string, { task: BoardTask; targets: Set<BoardCheckbox> }>();
  for (const link of afterScan.links) {
    if (link.held) continue;
    const old = previous.get(`${link.task.id}\u0000${unmarkedLine(link.raw)}`)?.shift();
    if (old === undefined || old === link.checkbox) continue;
    const entry = wanted.get(link.task.id) ?? { task: link.task, targets: new Set<BoardCheckbox>() };
    entry.targets.add(link.checkbox);
    wanted.set(link.task.id, entry);
  }
  const changes: DailyStatusChange[] = [];
  for (const { task, targets } of wanted.values()) {
    const [target] = [...targets];
    if (targets.size !== 1 || target === undefined) continue;
    const change = statusChange(task, target);
    if (change) changes.push(change);
  }
  return changes;
}

function syncsDaily(settings: DelegationSettings, date: string): boolean {
  return settings.features.daily && settings.features.tasks && date === localDate();
}

export function dailySyncBaseline(settings: DelegationSettings, date: string): string | null {
  if (!syncsDaily(settings, date)) return null;
  try {
    return readDaily(settings, date).content;
  } catch {
    return null;
  }
}

export function syncTasksFromDaily(settings: DelegationSettings, date: string, before: string, after: string): number {
  if (!syncsDaily(settings, date)) return 0;
  let applied = 0;
  try {
    const { loaded, tasks } = collectBoard(requireBoardRoot(settings), settings.tasks);
    for (const change of dailyStatusChanges(settings, date, before, after, loaded.projects, tasks)) {
      try {
        applyStatusChange(settings, change);
        applied += 1;
      } catch (err) {
        console.error(`task sync from the daily failed for ${change.task.id}: ${errorMessage(err)}`);
      }
    }
  } catch (err) {
    console.error(`task sync from the daily failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return applied;
}

function entryStatusChanges(entry: FocusEntry): DailyStatusChange[] {
  if (entry.held || !entry.match.task) return [];
  const lines: { task: BoardTask; checkbox: BoardCheckbox }[] = [
    ...(entry.recurring ? [] : entry.children.flatMap((child) => (child.task ? [{ task: child.task, checkbox: child.checkbox }] : []))),
    { task: entry.match.task, checkbox: entry.checkbox },
  ];
  const seen = new Set<string>();
  const changes: DailyStatusChange[] = [];
  for (const line of lines) {
    if (seen.has(line.task.id)) continue;
    seen.add(line.task.id);
    const change = statusChange(line.task, line.checkbox);
    if (change) changes.push(change);
  }
  return changes;
}

export function syncTaskFromDaily(settings: DelegationSettings, input: SyncFromDailyInput): SyncFromDailyResult {
  const root = requireBothFeatures(settings);
  const date = input.date ?? localDate();
  requireDailyDate(date);
  if (!Number.isInteger(input.line) || input.line < 0) throw new BadRequestError("line must be a non-negative integer");
  const daily = readDaily(settings, date);
  if (!daily.exists) throw new NotFoundError("create the daily first");
  const { loaded, tasks } = collectBoard(root, settings.tasks);
  const scan = scanDaily(settings, date, daily.content, loaded.projects, tasks);
  const entry = scan.entries.find((candidate) => candidate.line === input.line);
  if (!entry) throw new NotFoundError("no focus item at that line of the daily");
  if (!entry.match.task) throw new NotFoundError("the daily item links to no task");
  const failed: SyncFailure[] = [];
  const errors: unknown[] = [];
  let updated = 0;
  for (const change of entryStatusChanges(entry)) {
    try {
      applyStatusChange(settings, change);
      updated += 1;
    } catch (err) {
      failed.push({ taskId: change.task.id, error: errorMessage(err) });
      errors.push(err);
    }
  }
  if (updated === 0 && errors.length > 0) throw errors[0];
  return { date, updated, failed };
}

let currentWatcher: FSWatcher | null = null;
let currentWatchedRoot: string | null = null;
let currentWatchSettings: DelegationSettings | null = null;
const debounceTimers = new Map<string, NodeJS.Timeout>();

export function stopTasksBoardWatch(): void {
  if (currentWatcher) {
    currentWatcher.close();
    currentWatcher = null;
  }
  currentWatchedRoot = null;
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
}

function handleBoardFsEvent(root: string, rel: string): void {
  const abs = join(root, rel);
  const projectId = rel.replace(MARKDOWN_RE, "");
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    knownHash.delete(abs);
    broadcast("tasks", { source: "disk", projectId });
    return;
  }
  const hash = hashOf(content);
  if (knownHash.get(abs) === hash) return;
  knownHash.set(abs, hash);
  broadcast("tasks", { source: "disk", projectId });
}

export function watchTasksBoard(settings: DelegationSettings): void {
  currentWatchSettings = settings;
  const root = settings.features.tasks ? tasksRoot(settings) : null;
  if (!root || !isDirectory(root)) {
    stopTasksBoardWatch();
    return;
  }
  if (currentWatchedRoot === root && currentWatcher) return;
  stopTasksBoardWatch();
  try {
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString().replace(/\\/g, "/");
      if (!MARKDOWN_RE.test(rel)) return;
      const exclude = currentWatchSettings?.tasks.exclude ?? [];
      if (rel.split("/").some((segment) => isExcludedName(segment, exclude))) return;
      const existing = debounceTimers.get(rel);
      if (existing) clearTimeout(existing);
      debounceTimers.set(
        rel,
        setTimeout(() => {
          debounceTimers.delete(rel);
          handleBoardFsEvent(root, rel);
        }, WATCH_DEBOUNCE_MS),
      );
    });
    watcher.on("error", () => stopTasksBoardWatch());
    currentWatcher = watcher;
    currentWatchedRoot = root;
  } catch {
    currentWatcher = null;
    currentWatchedRoot = null;
  }
}
