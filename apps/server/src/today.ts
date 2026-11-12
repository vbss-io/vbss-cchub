import { randomUUID } from "node:crypto";
import {
  DailyConflictError,
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
  type ComposeFocusItem,
  type DailyReadResult,
  type DailyWriteOrigin,
} from "./daily.js";
import { BadRequestError, NotFoundError } from "./delegation-launch.js";
import { getSetting, getSettings, setSetting } from "./delegation-store.js";
import type { DelegationSettings, FocusSource } from "./delegation-types.js";
import { localDate } from "./second-brain.js";
import {
  checkboxForStatus,
  collectBoard,
  composeBoardFrom,
  createBoardTask,
  docLine,
  effectiveProjectOrder,
  flattenTasks,
  focusRange,
  normalizeText,
  openDoc,
  renderDoc,
  requireBoardRoot,
  scanDaily,
  setBoardHooks,
  syncTaskFromDaily,
  syncTasksFromDaily,
  writeBoardTask,
  type BoardCheckbox,
  type BoardProject,
  type BoardStatus,
  type BoardTask,
  type DocLine,
  type FocusChild,
  type FocusEntry,
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

export interface TodayPayload {
  date: string;
  focusSource: FocusSource;
  focus: TodayEntry[];
  carriedOver: TodayEntry[];
  meetings: string[];
  captures: TodayCapture[];
  unlinked: string[];
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
const BULLET_RE = /^[-*+]\s+(.*)$/;
const LEADING_CHECKBOX_RE = /^\[[ xX-]\]\s*/;
const PROMOTED_RE = /\s*(?:\u2192|->)\s*\[\[([^\]]+)\]\]\s*$/;
const BQUOTE_RE = /^\s{0,3}>\s?/;
const SCHEDULED_DATE_RE = /\u23F3\uFE0F?\s*(\d{4}-\d{2}-\d{2})/g;
const SCHEDULED_MARK = "\u23F3";
const PROMOTE_ARROW = "\u2192";
const SUBTASK_INDENT = "  ";
const CAPTURE_MAX = 2000;
const MIGRATED_KEY = "today.migrated.";
const BOARD_DELAY_MS = 50;
const CLIENT_DELAY_MS = 400;
const DISK_DELAY_MS = 1200;
const OPEN_STATUSES: ReadonlySet<BoardStatus> = new Set<BoardStatus>(["todo", "doing", "blocked", "hold"]);
const SYNCED_STATUSES: ReadonlySet<BoardStatus> = new Set<BoardStatus>(["todo", "doing", "done"]);
const MARKS = { todo: " ", doing: "-", done: "x" } as const;
const CHECKBOX_RANK: Record<BoardCheckbox, number> = { todo: 0, doing: 1, done: 2 };

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

function markOf(task: BoardTask): string {
  return MARKS[checkboxForStatus(task.status)];
}

function withMark(raw: string, task: BoardTask): string {
  if (!SYNCED_STATUSES.has(task.status)) return raw;
  const match = raw.match(MARK_RE);
  if (!match) return raw;
  const wanted = markOf(task);
  const current = match[2] === "-" ? "-" : match[2] === " " ? " " : "x";
  if (current === wanted) return raw;
  return raw.replace(MARK_RE, (_whole, open: string, _mark: string, close: string) => `${open}${wanted}${close}`);
}

function canonicalHead(settings: DelegationSettings, project: TodayProject, task: BoardTask): string {
  const label = settings.daily.wikilinks ? `[[${project.name}|${project.title}]]` : project.title;
  return `- [${markOf(task)}] ${label} - ${task.title}`;
}

interface BlockLine {
  text: string;
  origin: number | null;
}

function childLines(subtasks: BoardTask[], level: number, pool: FocusChild[], claimed: Set<number>): BlockLine[] {
  const out: BlockLine[] = [];
  for (const subtask of subtasks) {
    const open = pool.filter((child) => !claimed.has(child.line) && child.task !== null);
    const reused =
      open.find((child) => child.task?.id === subtask.id) ??
      open.find((child) => normalizeText((child.task as BoardTask).title) === normalizeText(subtask.title));
    if (reused) {
      claimed.add(reused.line);
      out.push({ text: withMark(reused.raw, subtask), origin: reused.line });
    } else {
      out.push({ text: `${SUBTASK_INDENT.repeat(level)}- [${markOf(subtask)}] ${subtask.title}`, origin: null });
    }
    out.push(...childLines(subtask.subtasks, level + 1, pool, claimed));
  }
  return out;
}

function withForeign(elements: BlockLine[], start: number, linked: Set<number>, foreign: number[], texts: string[]): string[] {
  const placed = new Map<number, string[]>();
  const orphans: string[] = [];
  for (const index of foreign) {
    let owner = start;
    for (const line of linked) if (line < index && line > owner) owner = line;
    const text = texts[index] as string;
    if (elements.some((element) => element.origin === owner)) placed.set(owner, [...(placed.get(owner) ?? []), text]);
    else orphans.push(text);
  }
  return [...elements.flatMap((element) => [element.text, ...(element.origin === null ? [] : (placed.get(element.origin) ?? []))]), ...orphans];
}

interface FocusPlan {
  content: string;
  changed: boolean;
  unlinked: string[];
  generated: string[];
  refused: boolean;
}

const isBlankText = (text: string): boolean => text.trim() === "";

function leadingBlanks(lines: DocLine[]): number {
  let count = 0;
  while (count < lines.length && isBlankText((lines[count] as DocLine).text)) count += 1;
  return count;
}

function trailingBlanks(lines: DocLine[], leading: number): number {
  if (leading === lines.length) return 0;
  let count = 0;
  while (isBlankText((lines[lines.length - 1 - count] as DocLine).text)) count += 1;
  return count;
}

function recurrenceTarget(entry: FocusEntry, task: BoardTask, focus: TodayEntry[]): TodayEntry | undefined {
  if (!entry.recurring || !entry.recurred) return undefined;
  const title = normalizeText(task.title);
  return focus.find(
    (candidate) =>
      candidate.task.repeat !== null &&
      candidate.task.doneAt !== null &&
      candidate.task.projectId === task.projectId &&
      normalizeText(candidate.task.title) === title,
  );
}

function containsAll(output: string[], kept: string[]): boolean {
  const counts = new Map<string, number>();
  for (const line of output) if (!isBlankText(line)) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of kept) {
    const left = counts.get(line) ?? 0;
    if (left === 0) return false;
    counts.set(line, left - 1);
  }
  return true;
}

function planFocus(
  settings: DelegationSettings,
  date: string,
  content: string,
  data: BoardData,
  focus: TodayEntry[],
  hints: ReadonlySet<string>,
  previous: ReadonlySet<string> | null,
): FocusPlan {
  const unchanged: FocusPlan = { content, changed: false, unlinked: [], generated: [], refused: false };
  const doc = openDoc(content);
  const texts = doc.lines.map((line) => line.text);
  let range = focusRange(texts, settings);
  const existing = range !== null;
  if (!range) {
    if (focus.length === 0) return unchanged;
    let last = texts.length - 1;
    while (last >= 0 && isBlankText(texts[last] as string)) last -= 1;
    doc.lines.push(...(last >= 0 ? [docLine("")] : []), docLine(`## ${settings.daily.headings.focus}`), docLine(""));
    range = focusRange(
      doc.lines.map((line) => line.text),
      settings,
    );
    if (!range) return unchanged;
  }
  const scan = existing ? scanDaily(settings, date, content, data.projects, data.tasks) : { entries: [], links: [] };
  const byTask = new Map(focus.map((entry) => [entry.task.id, entry]));
  const shown = new Set(focus.flatMap((entry) => flattenTasks([entry.task]).map((task) => task.id)));
  const claimed = new Set<string>();
  const consumed = new Set<number>();
  const blocks = new Map<string, string[]>();
  const generatedOnly: string[] = [];
  const keptBlocks: { start: number; end: number }[] = [];
  const attached: string[] = [];
  let dropped = 0;
  for (const entry of scan.entries) {
    const task = entry.match.task;
    const start = entry.line;
    const end = start + taskBlock(content, start).split(LINE_SPLIT_RE).length;
    const linkedChildren = entry.children.filter((child) => child.task !== null);
    const linkedLines = new Set(linkedChildren.map((child) => child.line));
    const foreign: number[] = [];
    for (let index = start + 1; index < end; index += 1) {
      if (!isBlankText(texts[index] as string) && !linkedLines.has(index)) foreign.push(index);
    }
    const target = task === null ? undefined : (byTask.get(task.id) ?? recurrenceTarget(entry, task, focus));
    if (task !== null && target !== undefined && !claimed.has(target.task.id)) {
      claimed.add(target.task.id);
      const reuse = entry.projectId === null || entry.projectId === target.task.projectId;
      const head = reuse ? withMark(entry.raw, target.task) : canonicalHead(settings, target.project, target.task);
      const elements: BlockLine[] = [{ text: head, origin: reuse ? start : null }, ...childLines(target.task.subtasks, 1, linkedChildren, new Set<number>())];
      blocks.set(target.task.id, withForeign(elements, start, linkedLines, foreign, texts));
      generatedOnly.push(...elements.map((element) => element.text));
      attached.push(...foreign.map((index) => texts[index] as string));
      consumed.add(start);
      for (const child of linkedChildren) consumed.add(child.line);
      for (const index of foreign) consumed.add(index);
    } else if (task !== null && target === undefined && !entry.held && (shown.has(task.id) || task.scheduled !== null || hints.has(task.id))) {
      dropped += 1;
      consumed.add(start);
      for (const child of linkedChildren) consumed.add(child.line);
    } else {
      keptBlocks.push({ start, end });
    }
  }
  for (const entry of focus) {
    if (claimed.has(entry.task.id)) continue;
    const elements: BlockLine[] = [
      { text: canonicalHead(settings, entry.project, entry.task), origin: null },
      ...childLines(entry.task.subtasks, 1, [], new Set<number>()),
    ];
    blocks.set(entry.task.id, elements.map((element) => element.text));
    generatedOnly.push(...elements.map((element) => element.text));
  }
  if (blocks.size === 0 && dropped === 0) {
    const everything = texts.slice(range.heading + 1, range.end).filter((text) => !isBlankText(text) && !isPlaceholderLine(text));
    return { ...unchanged, unlinked: everything };
  }
  if (previous !== null) {
    for (const block of keptBlocks) {
      const blockTexts = texts.slice(block.start, block.end).filter((text) => !isBlankText(text));
      if (blockTexts.length === 0 || !blockTexts.every((text) => previous.has(text))) continue;
      for (let index = block.start; index < block.end; index += 1) consumed.add(index);
    }
  }
  const remaining = new Map<string, number>();
  for (const block of blocks.values()) remaining.set(block.join("\n"), (remaining.get(block.join("\n")) ?? 0) + 1);
  for (const block of keptBlocks) {
    const key = texts.slice(block.start, block.end).join("\n");
    const left = remaining.get(key) ?? 0;
    if (left === 0) continue;
    remaining.set(key, left - 1);
    for (let index = block.start; index < block.end; index += 1) consumed.add(index);
  }
  const items: ComposeFocusItem[] = focus.map((entry) => ({ project: null, text: "", block: (blocks.get(entry.task.id) as string[]).join("\n"), keepMark: true }));
  const generated = renderFocusLines(items, settings.daily.wikilinks, composeBoardFrom(settings, data.projects));
  const from = range.heading + 1;
  const sectionLines = doc.lines.slice(from, range.end);
  const keptSeq: (DocLine | null)[] = [];
  const keptTexts: string[] = [];
  const unlinked: string[] = [];
  const placeholders: string[] = [];
  for (let index = from; index < range.end; index += 1) {
    if (consumed.has(index) || index >= texts.length) continue;
    const line = doc.lines[index] as DocLine;
    if (isBlankText(line.text)) {
      if (keptSeq.length > 0 && keptSeq[keptSeq.length - 1] !== null) keptSeq.push(null);
      continue;
    }
    if (generated.length > 0 && isPlaceholderLine(line.text)) {
      placeholders.push(line.text);
      continue;
    }
    keptSeq.push(line);
    keptTexts.push(line.text);
    if (!isPlaceholderLine(line.text)) unlinked.push(line.text);
  }
  while (keptSeq.length > 0 && keptSeq[keptSeq.length - 1] === null) keptSeq.pop();
  const body: DocLine[] = [
    ...generated.map((text) => docLine(text)),
    ...(generated.length > 0 && keptSeq.length > 0 ? [docLine("")] : []),
    ...keptSeq.map((line) => line ?? docLine("")),
  ];
  if (body.length === 0) body.push(docLine(placeholders[0] ?? "- [ ]"));
  const leading = leadingBlanks(sectionLines);
  const trailing = trailingBlanks(sectionLines, leading);
  const lead = sectionLines.slice(0, leading);
  const trail = trailing > 0 ? sectionLines.slice(sectionLines.length - trailing) : [];
  const nextSection = [...lead, ...body, ...trail];
  const preserved = [...keptTexts, ...attached];
  const outputTexts = nextSection.map((line) => line.text);
  const expected = preserved.length + generatedOnly.length;
  if (!containsAll(outputTexts, preserved) || outputTexts.filter((text) => !isBlankText(text)).length < expected) {
    return { ...unchanged, unlinked, refused: true };
  }
  doc.lines.splice(from, range.end - from, ...nextSection);
  const next = renderDoc(doc);
  return { content: next, changed: next !== content, unlinked, generated: generated.filter((text) => !isBlankText(text)), refused: false };
}

const knownContent = new Map<string, string>();
const lastGenerated = new Map<string, Set<string>>();
const pending = new Map<string, MirrorSource>();
const timers = new Map<string, NodeJS.Timeout>();

export function forgetTodayState(): void {
  knownContent.clear();
  lastGenerated.clear();
  pending.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasStake(settings: DelegationSettings, date: string, content: string, data: BoardData, hints: ReadonlySet<string>): boolean {
  if (hints.size > 0 || (lastGenerated.get(date)?.size ?? 0) > 0) return true;
  if (computeFocus(settings, data, date).length > 0) return true;
  return scanDaily(settings, date, content, data.projects, data.tasks).entries.some((entry) => entry.match.task !== null && entry.match.task.scheduled !== null);
}

function runMirror(settings: DelegationSettings, date: string, options: MirrorOptions = {}): MirrorResult {
  const skip = (skipped: MirrorSkip, applied = 0): MirrorResult => ({ changed: false, skipped, applied });
  if (!settings.features.daily || !settings.features.tasks) return skip("disabled");
  if (focusSourceOf(settings) !== "scheduled") return skip("list");
  if (!isCurrentOrFuture(date)) return skip("past");
  try {
    const daily = readDailySafe(settings, date);
    if (daily === null || !daily.exists) return skip("no-daily");
    let data = loadBoardData(settings);
    if (data === null) return skip("no-board");
    const hints = options.hints ?? new Set<string>();
    if (!hasStake(settings, date, daily.content, data, hints)) {
      knownContent.set(date, daily.content);
      return { changed: false, skipped: null, applied: 0 };
    }
    let before = knownContent.get(date) ?? null;
    if (before === null && options.source === "disk") {
      const baseline = planFocus(settings, date, daily.content, data, computeFocus(settings, data, date), hints, lastGenerated.get(date) ?? null);
      before = baseline.refused ? null : baseline.content;
    }
    let applied = 0;
    if (before !== null && before !== daily.content) {
      applied = syncTasksFromDaily(settings, date, before, daily.content);
      if (applied > 0) data = loadBoardData(settings) ?? data;
    }
    const plan = planFocus(settings, date, daily.content, data, computeFocus(settings, data, date), hints, lastGenerated.get(date) ?? null);
    if (plan.refused) return skip("refused", applied);
    lastGenerated.set(date, new Set(plan.generated));
    if (!plan.changed) {
      knownContent.set(date, daily.content);
      return { changed: false, skipped: null, applied };
    }
    writeDaily(settings, date, plan.content, daily.updatedAt ?? undefined, `mirror-${randomUUID().slice(0, 8)}`, "server");
    knownContent.set(date, plan.content);
    return { changed: true, skipped: null, applied };
  } catch (err) {
    if (err instanceof DailyConflictError) return skip("conflict");
    console.error(`focus mirror failed for ${date}: ${errorText(err)}`);
    return skip("failed");
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
  const dates = new Set(texts.flatMap((text) => scheduledDatesIn(text)));
  if (!texts.some((text) => text.includes(SCHEDULED_MARK))) return;
  dates.add(localDate());
  for (const date of dates) scheduleMirror(date, "board");
}

export function queueDailyDiskChange(date: string): void {
  if (isScheduledMode(getSettings())) scheduleMirror(date, "disk");
}

export function installTodayHooks(): void {
  setDailyHooks({
    written: (settings: DelegationSettings, date: string, content: string, origin: DailyWriteOrigin) => {
      if (!isCurrentOrFuture(date)) return;
      knownContent.set(date, content);
      if (origin === "client" && isScheduledMode(settings)) scheduleMirror(date, "client");
    },
    diskChanged: queueDailyDiskChange,
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

function createDailyFile(settings: DelegationSettings, date: string): DailyReadResult {
  const daily = readDaily(settings, date);
  if (daily.exists) return daily;
  writeDaily(settings, date, renderTemplate(dailyTemplateText(settings), date), undefined, `create-${randomUUID().slice(0, 8)}`, "server");
  return readDaily(settings, date);
}

function migratedKey(date: string): string {
  return `${MIGRATED_KEY}${date}`;
}

function createToday(settings: DelegationSettings, date: string): { dailyExists: true } {
  requireDailyFeature(settings);
  validateDate(date);
  const daily = readDaily(settings, date);
  const created = !daily.exists;
  if (created) createDailyFile(settings, date);
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
    while (last >= 0 && isBlankText(texts[last] as string)) last -= 1;
    doc.lines.splice(last + 1, 0, ...(last >= 0 ? [docLine("")] : []), docLine(`## ${heading}`), line);
  } else {
    const content: number[] = [];
    for (let index = range.heading + 1; index < range.end; index += 1) if (!isBlankText(texts[index] as string)) content.push(index);
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
  if (input.schedule === true) runMirror(settings, date, { source: "api" });
  return { task: created.task };
}

function schedule(settings: DelegationSettings, input: ScheduleInput): { task: BoardTask } {
  if (input.date !== null) validateDate(input.date);
  const before = loadBoardData(settings);
  const old = before ? flattenTasks(before.tasks).find((task) => task.projectId === input.projectId && task.line === input.line) : undefined;
  const result = writeBoardTask(settings, { projectId: input.projectId, line: input.line, raw: input.raw, scheduled: input.date });
  const hints = new Set([result.task.id]);
  const dates = new Set([old?.scheduled ?? null, input.date].filter((date): date is string => date !== null && isCurrentOrFuture(date)));
  for (const date of dates) runMirror(settings, date, { source: "api", hints });
  return { task: result.task };
}

function isForward(checkbox: BoardCheckbox, task: BoardTask): boolean {
  return SYNCED_STATUSES.has(task.status) && CHECKBOX_RANK[checkbox] > CHECKBOX_RANK[checkboxForStatus(task.status)];
}

function hasForwardTick(entry: FocusEntry): boolean {
  const task = entry.match.task;
  if (!task || entry.held) return false;
  if (isForward(entry.checkbox, task)) return true;
  return !entry.recurring && entry.children.some((child) => child.task !== null && isForward(child.checkbox, child.task));
}

function migrateFocus(settings: DelegationSettings, date: string): MigrationResult {
  requireDailyFeature(settings);
  validateDate(date);
  if (!isCurrentOrFuture(date)) throw new BadRequestError("past dailies are never migrated");
  const daily = readDaily(settings, date);
  if (!daily.exists) throw new NotFoundError("create the daily first");
  let data = loadBoardData(settings);
  if (data === null) throw new BadRequestError("the tasks board is not available");
  const result: MigrationResult = { scheduled: 0, synced: 0, skipped: [], failed: [] };
  for (const entry of scanDaily(settings, date, daily.content, data.projects, data.tasks).entries.filter(hasForwardTick)) {
    try {
      if (syncTaskFromDaily(settings, { line: entry.line, date }).updated > 0) result.synced += 1;
    } catch (err) {
      result.failed.push({ taskId: (entry.match.task as BoardTask).id, error: errorText(err) });
    }
  }
  if (result.synced > 0) data = loadBoardData(settings) ?? data;
  const linked = new Map<string, BoardTask>();
  for (const entry of scanDaily(settings, date, daily.content, data.projects, data.tasks).entries) {
    if (entry.match.task && !entry.held) linked.set(entry.match.task.id, entry.match.task);
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
  const unlinked = exists && data ? planFocus(settings, date, content, data, focus, new Set<string>(), lastGenerated.get(date) ?? null).unlinked : [];
  return {
    date,
    focusSource,
    focus,
    carriedOver: scheduledFocus ? computeCarried(settings, data, date) : [],
    meetings: meetingsOf(settings, lines),
    captures: capturesOf(settings, lines),
    unlinked,
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
