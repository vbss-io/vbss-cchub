import { comparePriority, formatDayMonth, groupTasksByProject, isIsoDay, taskDates, type TimelineZoom } from "./board-model";
import type { BoardProject, BoardTask } from "./delegation";

const DAY_MS = 86_400_000;
const WEEK = 7;

export const TIMELINE_MAX_BEHIND_DAYS = 730;

export const TIMELINE_MAX_AHEAD_DAYS = 1095;

export const ZOOM_LABEL: Record<TimelineZoom, string> = { week: "Week", month: "Month", quarter: "Quarter" };

export const ZOOM_DAY_WIDTH: Record<TimelineZoom, number> = { week: 64, month: 24, quarter: 8 };

const ZOOM_MIN_DAYS: Record<TimelineZoom, number> = { week: 28, month: 91, quarter: 182 };

const ZOOM_PAD_DAYS: Record<TimelineZoom, number> = { week: 7, month: 14, quarter: 28 };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function parseDay(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !isIsoDay(value)) return null;
  return Math.round(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10))) / DAY_MS);
}

const toDate = (day: number): Date => new Date(day * DAY_MS);

const pad2 = (value: number): string => String(value).padStart(2, "0");

export function formatDay(day: number): string {
  const date = toDate(day);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export const localDayKey = (date: Date): string => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const weekdayIndex = (day: number): number => (((day + 3) % WEEK) + WEEK) % WEEK;

export const weekStart = (day: number): number => day - weekdayIndex(day);

export type TimelineSpanKind = "bar" | "open" | "milestone";

export interface TimelineSpan {
  kind: TimelineSpanKind;
  start: number;
  end: number;
}

export function taskSpan(task: BoardTask): TimelineSpan | null {
  const dates = taskDates(task);
  const begin = parseDay(dates.start) ?? parseDay(dates.scheduled);
  const due = parseDay(dates.due);
  if (begin !== null && due !== null) return { kind: "bar", start: Math.min(begin, due), end: Math.max(begin, due) };
  if (due !== null) return { kind: "milestone", start: due, end: due };
  if (begin !== null) return { kind: "open", start: begin, end: begin + 1 };
  return null;
}

export function spanLabel(span: TimelineSpan): string {
  const from = formatDayMonth(formatDay(span.start));
  if (span.kind === "milestone") return `Due ${from}`;
  if (span.kind === "open") return `From ${from}`;
  return `${from} - ${formatDayMonth(formatDay(span.end))}`;
}

export function isTaskOverdue(task: BoardTask, today: number): boolean {
  if (task.status === "done" || task.status === "archived") return false;
  const due = parseDay(task.due ?? null);
  return due !== null && due < today;
}

export interface TimelineRange {
  start: number;
  end: number;
  dayCount: number;
  dayWidth: number;
}

export function timelineRange(spans: readonly TimelineSpan[], today: number, zoom: TimelineZoom): TimelineRange {
  const padding = ZOOM_PAD_DAYS[zoom];
  const floor = today - TIMELINE_MAX_BEHIND_DAYS;
  const ceiling = today + TIMELINE_MAX_AHEAD_DAYS;
  const low = Math.max(floor, Math.min(today, ...spans.map((span) => span.start))) - padding;
  const high = Math.min(ceiling, Math.max(today, ...spans.map((span) => span.end))) + padding;
  const start = weekStart(low);
  const dayCount = Math.max(ZOOM_MIN_DAYS[zoom], weekStart(high) + WEEK - start);
  return { start, end: start + dayCount - 1, dayCount, dayWidth: ZOOM_DAY_WIDTH[zoom] };
}

export type TimelineClip = "none" | "before" | "after" | "both";

export interface ClampedSpan {
  span: TimelineSpan;
  clip: TimelineClip;
}

export function clampSpanToRange(span: TimelineSpan, range: TimelineRange): ClampedSpan {
  const before = span.start < range.start;
  const after = span.end > range.end;
  if (!before && !after) return { span, clip: "none" };
  const clip: TimelineClip = before && after ? "both" : before ? "before" : "after";
  if (span.end < range.start) return { span: { kind: span.kind, start: range.start, end: range.start }, clip };
  if (span.start > range.end) return { span: { kind: span.kind, start: range.end, end: range.end }, clip };
  return { span: { kind: span.kind, start: Math.max(span.start, range.start), end: Math.min(span.end, range.end) }, clip };
}

export const dayToX = (day: number, range: TimelineRange): number => (day - range.start) * range.dayWidth;

export const xToDay = (x: number, range: TimelineRange): number => range.start + Math.floor(x / range.dayWidth);

export interface BarGeometry {
  left: number;
  width: number;
}

export function barGeometry(span: TimelineSpan, range: TimelineRange): BarGeometry {
  return { left: dayToX(span.start, range), width: (span.end - span.start + 1) * range.dayWidth };
}

export interface TimelineTick {
  label: string;
  title: string;
  left: number;
  width: number;
  weekend: boolean;
}

export interface TimelineScale {
  top: TimelineTick[];
  bottom: TimelineTick[];
}

interface Bucket {
  key: string;
  label: string;
}

function bucketsOf(range: TimelineRange, bucketOf: (day: number) => Bucket): TimelineTick[] {
  const ticks: TimelineTick[] = [];
  let current: { bucket: Bucket; from: number } | null = null;
  const close = (until: number): void => {
    if (current === null) return;
    ticks.push({
      label: current.bucket.label,
      title: current.bucket.label,
      left: (current.from - range.start) * range.dayWidth,
      width: (until - current.from) * range.dayWidth,
      weekend: false,
    });
  };
  for (let day = range.start; day <= range.end; day += 1) {
    const bucket = bucketOf(day);
    if (current === null || current.bucket.key !== bucket.key) {
      close(day);
      current = { bucket, from: day };
    }
  }
  close(range.end + 1);
  return ticks;
}

const monthBucket = (day: number): Bucket => {
  const date = toDate(day);
  return { key: `${date.getUTCFullYear()}-${date.getUTCMonth()}`, label: `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}` };
};

const quarterBucket = (day: number): Bucket => {
  const date = toDate(day);
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return { key: `${date.getUTCFullYear()}-${quarter}`, label: `Q${quarter} ${date.getUTCFullYear()}` };
};

const shortMonthBucket = (day: number): Bucket => {
  const date = toDate(day);
  return { key: `${date.getUTCFullYear()}-${date.getUTCMonth()}`, label: MONTHS[date.getUTCMonth()] ?? "" };
};

function dayTicks(range: TimelineRange, weeklyOnly: boolean): TimelineTick[] {
  const ticks: TimelineTick[] = [];
  for (let day = range.start; day <= range.end; day += 1) {
    if (weeklyOnly && weekdayIndex(day) !== 0) continue;
    const date = toDate(day);
    const width = weeklyOnly ? Math.min(WEEK, range.end - day + 1) * range.dayWidth : range.dayWidth;
    ticks.push({
      label: String(date.getUTCDate()),
      title: `${WEEKDAYS[weekdayIndex(day)]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`,
      left: (day - range.start) * range.dayWidth,
      width,
      weekend: weekdayIndex(day) >= 5,
    });
  }
  return ticks;
}

export function timelineScale(range: TimelineRange, zoom: TimelineZoom): TimelineScale {
  if (zoom === "week") return { top: bucketsOf(range, monthBucket), bottom: dayTicks(range, false) };
  if (zoom === "month") return { top: bucketsOf(range, monthBucket), bottom: dayTicks(range, true) };
  return { top: bucketsOf(range, quarterBucket), bottom: bucketsOf(range, shortMonthBucket) };
}

export interface TimelineRow {
  task: BoardTask;
  depth: number;
  span: TimelineSpan | null;
  visible: TimelineSpan | null;
  clip: TimelineClip;
  overdue: boolean;
}

export interface TimelineGroup {
  project: BoardProject;
  rows: TimelineRow[];
}

export interface TimelineLayout {
  groups: TimelineGroup[];
  undated: BoardTask[];
  range: TimelineRange;
  todayX: number;
}

const subtreeSpans = (task: BoardTask): TimelineSpan[] => [taskSpan(task), ...task.subtasks.flatMap(subtreeSpans)].filter((span): span is TimelineSpan => span !== null);

const earliest = (task: BoardTask): number => Math.min(...subtreeSpans(task).map((span) => span.start));

function rowsOf(task: BoardTask, depth: number, today: number): TimelineRow[] {
  const children = task.subtasks
    .filter((child) => subtreeSpans(child).length > 0)
    .sort((a, b) => earliest(a) - earliest(b) || a.line - b.line)
    .flatMap((child) => rowsOf(child, depth + 1, today));
  return [{ task, depth, span: taskSpan(task), visible: null, clip: "none", overdue: isTaskOverdue(task, today) }, ...children];
}

function compareTopLevel(a: BoardTask, b: BoardTask): number {
  return earliest(a) - earliest(b) || comparePriority(a.priority, b.priority) || a.line - b.line;
}

function withVisible(row: TimelineRow, range: TimelineRange): TimelineRow {
  if (row.span === null) return row;
  const clamped = clampSpanToRange(row.span, range);
  return { ...row, visible: clamped.span, clip: clamped.clip };
}

export function clipLabel(row: TimelineRow): string {
  if (row.span === null || row.clip === "none") return "";
  return `out of range (${formatDay(row.span.start)} - ${formatDay(row.span.end)})`;
}

export function buildTimeline(tasks: BoardTask[], projects: BoardProject[], order: readonly string[], todayKey: string, zoom: TimelineZoom): TimelineLayout {
  const today = parseDay(todayKey) ?? 0;
  const dated = tasks.filter((task) => subtreeSpans(task).length > 0);
  const undated = tasks.filter((task) => subtreeSpans(task).length === 0);
  const range = timelineRange(dated.flatMap(subtreeSpans), today, zoom);
  const groups = groupTasksByProject([...dated].sort(compareTopLevel), projects, order).map((group) => ({
    project: group.project,
    rows: group.tasks.flatMap((task) => rowsOf(task, 0, today)).map((row) => withVisible(row, range)),
  }));
  return { groups, undated, range, todayX: dayToX(today, range) + range.dayWidth / 2 };
}
