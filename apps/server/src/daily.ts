import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { listSessions } from "./db.js";
import { BadRequestError, createInternalTask, NotFoundError, startRun } from "./delegation-launch.js";
import { activeDailyTask, getSettings } from "./delegation-store.js";
import type { DailyHeadings, DelegationSettings, TaskRecord } from "./delegation-types.js";
import { localDate, readAllBlockBullets, trailFilePath } from "./second-brain.js";
import { broadcast } from "./sse.js";
import type { SessionStatus } from "./types.js";
import { trailDir } from "./trail.js";
import { isDirectory } from "./workspaces.js";

const DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const DAILY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WATCH_DEBOUNCE_MS = 300;

export function isValidDailyDate(text: string): boolean {
  if (!DAILY_DATE_RE.test(text)) return false;
  const [yearStr, monthStr, dayStr] = text.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (year < 2000 || year > 2100) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export const BUILT_IN_TEMPLATE = `---
type: daily
created: {{date}}
updated: {{date}}
tags: [daily]
---

# {{date}}

## Focus
- [ ]

## Meetings
-

## Captures
-

## Sessions
-
`;

export const DEFAULT_DAILY_PROMPT =
  "You are working inside the second brain at {{root}}. Today is {{date}}. Create or refresh the daily diary {{file}}: " +
  "when {{template}} is a file, start from it; when the diary already exists, keep everything the user wrote. Fill in: " +
  "a briefing of what happened on {{yesterday}} in at most 3 lines (read the previous diary and any notes of that day you can find in the vault); today's focus as task items in the form `- [ ] Project - item`, " +
  "taken from this input: {{focus}}, plus open items touched in the last two days; items written as `- [-]` are in progress (started, not finished): carry them over keeping `- [-]`; meetings when you can find them; " +
  "an empty captures section; and a sessions section listing today's sessions so far: {{sessions}}. Write the file, " +
  "do not ask questions, do not create or edit any other file, then stop.";

export function renderTemplate(text: string, date: string): string {
  return text.split("{{date}}").join(date);
}

const LINE_SPLIT_RE = /\r\n|\n/;
const TASK_LINE_RE = /^(\s*)[-*]\s+\[([ xX-])\]\s?(.*)$/;
const TASK_MARKER_RE = /^(\s*[-*]\s+)\[([ xX-])\]/;

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

export type TaskState = "todo" | "doing" | "done";

export interface TaskLine {
  line: number;
  depth: number;
  state: TaskState;
  checked: boolean;
  text: string;
  raw: string;
}

function taskStateOf(marker: string): TaskState {
  if (marker === "-") return "doing";
  return marker.toLowerCase() === "x" ? "done" : "todo";
}

export function parseTaskLines(markdown: string): TaskLine[] {
  const lines = markdown.split(LINE_SPLIT_RE);
  const tasks: TaskLine[] = [];
  lines.forEach((raw, index) => {
    const match = raw.match(TASK_LINE_RE);
    if (!match) return;
    const state = taskStateOf(match[2]!);
    tasks.push({
      line: index,
      depth: indentDepth(raw),
      state,
      checked: state === "done",
      text: match[3] ?? "",
      raw,
    });
  });
  return tasks;
}

export function taskBlock(markdown: string, line: number): string {
  const lines = markdown.split(LINE_SPLIT_RE);
  const start = lines[line];
  if (start === undefined) return "";
  const baseDepth = indentDepth(start);
  const collected = [start];
  let pendingBlank: string[] = [];
  let index = line + 1;
  while (index < lines.length) {
    const current = lines[index]!;
    if (current.trim() === "") {
      pendingBlank.push(current);
      index += 1;
      continue;
    }
    if (indentDepth(current) > baseDepth) {
      collected.push(...pendingBlank, current);
      pendingBlank = [];
      index += 1;
      continue;
    }
    break;
  }
  return collected.join("\n");
}

export function setTaskChecked(markdown: string, line: number, checked: boolean): string {
  const parts = markdown.split(/(\r\n|\n)/);
  let counter = 0;
  for (let i = 0; i < parts.length; i += 2) {
    if (counter === line) {
      parts[i] = (parts[i] ?? "").replace(TASK_MARKER_RE, (whole, lead: string, marker: string) => {
        if (checked) return `${lead}[x]`;
        return marker.toLowerCase() === "x" ? `${lead}[ ]` : whole;
      });
      break;
    }
    counter += 1;
  }
  return parts.join("");
}

export function readFrontmatterKey(markdown: string, key: string): string | null {
  const lines = markdown.split(LINE_SPLIT_RE);
  if ((lines[0] ?? "").trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  const re = new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`);
  for (let i = 1; i < end; i += 1) {
    const match = (lines[i] ?? "").match(re);
    if (match) return (match[1] ?? "").trim();
  }
  return null;
}

export function setFrontmatterKey(markdown: string, key: string, value: string): string {
  const parts = markdown.split(/(\r\n|\n)/);
  const lineAt = (i: number): string => parts[i * 2] ?? "";
  const totalLines = Math.ceil(parts.length / 2);
  const eol = parts[1] ?? "\n";
  if (lineAt(0).trim() !== "---") {
    return `---${eol}${key}: ${value}${eol}---${eol}${eol}${markdown}`;
  }
  let end = -1;
  for (let i = 1; i < totalLines; i += 1) {
    if (lineAt(i).trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return `---${eol}${key}: ${value}${eol}---${eol}${eol}${markdown}`;
  }
  const re = new RegExp(`^${escapeRegExp(key)}:\\s*(.*)$`);
  for (let i = 1; i < end; i += 1) {
    if (re.test(lineAt(i))) {
      parts[i * 2] = `${key}: ${value}`;
      return parts.join("");
    }
  }
  parts.splice(end * 2, 0, `${key}: ${value}`, eol);
  return parts.join("");
}

export interface ComposeFocusItem {
  project: string | null;
  text: string;
  block?: string;
}

export interface ComposeInput {
  briefing?: string;
  focus: ComposeFocusItem[];
  meetings: string[];
  sessions: DailySessionSummary[];
}

export interface ComposeBoardProject {
  id: string;
  name: string;
  title: string;
}

export interface ComposeBoard {
  projects: ComposeBoardProject[];
  order: string[];
  projectOfLabel: (label: string) => string | null;
  projectOfLine: (text: string) => string | null;
}

export interface ComposeOptions {
  date: string;
  headings: DailyHeadings;
  wikilinks: boolean;
  board?: ComposeBoard | null;
}

export function isPlaceholderLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "-" || trimmed === "- [ ]";
}

export function findHeadingIndex(lines: string[], heading: string): number {
  const target = heading.trim().toLowerCase();
  return lines.findIndex((entry) => {
    const match = entry.match(/^##\s+(.*)$/);
    return match ? match[1]!.trim().toLowerCase() === target : false;
  });
}

function insertSection(lines: string[], heading: string, content: string[]): string[] {
  const idx = findHeadingIndex(lines, heading);
  if (idx === -1) {
    const out = [...lines];
    while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
    out.push("", `## ${heading}`, ...content);
    return out;
  }
  let boundary = lines.length;
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i]!)) {
      boundary = i;
      break;
    }
  }
  let placeholderIndex = -1;
  for (let i = idx + 1; i < boundary; i += 1) {
    if (isPlaceholderLine(lines[i]!)) {
      placeholderIndex = i;
      break;
    }
  }
  const out = [...lines];
  if (placeholderIndex !== -1) {
    out.splice(placeholderIndex, 1, ...content);
  } else {
    out.splice(idx + 1, 0, ...content);
  }
  return out;
}

function renderProjectLabel(project: string | null, wikilinks: boolean): string | null {
  if (project === null) return null;
  return wikilinks ? `[[${project}]]` : project;
}

const BARE_WIKILINK_LABEL_RE = /^(\s*[-*]\s+\[[ xX-]\]\s+)\[\[([^\]|#]*)\]\]/;
const BLOCK_FIRST_LINE_RE = /^\s*[-*]\s+\[[ xX-]\]\s?(.*)$/;

function boardProject(board: ComposeBoard, id: string | null): ComposeBoardProject | null {
  return id === null ? null : (board.projects.find((project) => project.id === id) ?? null);
}

function blockProjectId(item: ComposeFocusItem, board: ComposeBoard | null): string | null {
  if (!board) return null;
  if (item.block) {
    const first = (item.block.split(LINE_SPLIT_RE)[0] ?? "").match(BLOCK_FIRST_LINE_RE);
    const text = first ? (first[1] ?? "").trim() : "";
    return text === "" ? null : board.projectOfLine(text);
  }
  return item.project === null ? null : board.projectOfLabel(item.project);
}

function renderFocusItem(item: ComposeFocusItem, wikilinks: boolean, board: ComposeBoard | null): string[] {
  if (item.block) {
    const blockLines = item.block.split(LINE_SPLIT_RE);
    blockLines[0] = (blockLines[0] ?? "").replace(TASK_MARKER_RE, (whole, lead: string, marker: string) =>
      marker === "-" ? whole : `${lead}[ ]`,
    );
    if (board && wikilinks) {
      blockLines[0] = (blockLines[0] ?? "").replace(BARE_WIKILINK_LABEL_RE, (whole, lead: string, target: string) => {
        const project = boardProject(board, board.projectOfLabel((target.split("/").pop() ?? "").replace(/\.md$/i, "")));
        return project ? `${lead}[[${target}|${project.title}]]` : whole;
      });
    }
    return blockLines;
  }
  const project = board ? boardProject(board, blockProjectId(item, board)) : null;
  const label = project ? (wikilinks ? `[[${project.name}|${project.title}]]` : project.title) : renderProjectLabel(item.project, wikilinks);
  return [label ? `- [ ] ${label} - ${item.text}` : `- [ ] ${item.text}`];
}

interface RankedFocusItem {
  item: ComposeFocusItem;
  key: string;
  rank: number;
}

function rankFocusItems(items: ComposeFocusItem[], board: ComposeBoard): RankedFocusItem[] {
  const ranked = items.map((item) => {
    const id = blockProjectId(item, board);
    const position = id === null ? -1 : board.order.indexOf(id);
    const resolved = id !== null && position !== -1;
    return {
      item,
      key: resolved ? `id:${id}` : `raw:${item.project ?? ""}`,
      rank: resolved ? position : Number.POSITIVE_INFINITY,
    };
  });
  return ranked
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.rank === b.entry.rank ? a.index - b.index : a.entry.rank < b.entry.rank ? -1 : 1))
    .map(({ entry }) => entry);
}

function renderFocusLines(items: ComposeFocusItem[], wikilinks: boolean, board: ComposeBoard | null): string[] {
  const out: string[] = [];
  const keyed = board ? rankFocusItems(items, board) : items.map((item) => ({ item, key: `raw:${item.project ?? ""}`, rank: 0 }));
  let prevKey: string | undefined;
  keyed.forEach((entry, index) => {
    if (index > 0 && entry.key !== prevKey) out.push("");
    out.push(...renderFocusItem(entry.item, wikilinks, board));
    prevKey = entry.key;
  });
  return out;
}

export function composeDaily(template: string, input: ComposeInput, opts: ComposeOptions): string {
  let lines = renderTemplate(template, opts.date).split(LINE_SPLIT_RE);
  const briefing = (input.briefing ?? "").trim();
  if (briefing) {
    const headingIndex = lines.findIndex((entry) => /^#\s+/.test(entry));
    if (headingIndex !== -1) {
      let skipTo = headingIndex + 1;
      while (skipTo < lines.length && lines[skipTo]!.trim() === "") skipTo += 1;
      const summaryLines = briefing
        .split(LINE_SPLIT_RE)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const block = ["", "> **Briefing:**", ">", ...summaryLines.map((entry) => `> ${entry}`), ""];
      lines.splice(headingIndex + 1, skipTo - (headingIndex + 1), ...block);
    }
  }
  const focusContent = input.focus.length > 0 ? renderFocusLines(input.focus, opts.wikilinks, opts.board ?? null) : ["- [ ]"];
  const meetingsContent = input.meetings.length > 0 ? input.meetings.map((entry) => `- ${entry}`) : ["-"];
  const sessionsContent =
    input.sessions.length > 0
      ? input.sessions.map((session) => `- ${session.title ?? "untitled"} · ${session.client ?? "unknown"}`)
      : ["-"];
  lines = insertSection(lines, opts.headings.focus, focusContent);
  lines = insertSection(lines, opts.headings.meetings, meetingsContent);
  lines = insertSection(lines, opts.headings.sessions, sessionsContent);
  return lines.join("\n");
}

export interface OrganizeFocusOptions {
  heading: string;
  wikilinks: boolean;
  board: ComposeBoard | null;
}

export interface OrganizeFocusResult {
  content: string;
  changed: boolean;
  groups: number;
}

const BOM = String.fromCharCode(0xfeff);
const SECTION_HEADING_RE = /^##\s+/;
const FOCUS_FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const LIST_ITEM_RE = /^[-*+](?:\s+(.*))?$/;
const LEADING_CHECKBOX_RE = /^\[[ xX-]\]\s*/;
const LEAD_WIKILINK_RE = /^\[\[([^\]|#]*)/;
const BARE_LABEL_ANY_ITEM_RE = /^([-*+]\s+(?:\[[ xX-]\]\s+)?)\[\[([^\]|#]*)\]\]/;
const ORGANIZE_UNSAFE_ERROR = "could not organize the focus safely";

interface FocusBlock {
  lines: string[];
  key: string;
  tier: number;
  rank: number;
  placeholder: boolean;
}

function fenceOpener(line: string): string | null {
  const match = line.match(FOCUS_FENCE_RE);
  return match ? (match[1] as string) : null;
}

function closesFenceLine(line: string, marker: string): boolean {
  const match = line.match(FOCUS_FENCE_RE);
  if (!match) return false;
  const found = match[1] as string;
  return found[0] === marker[0] && found.length >= marker.length && (match[2] ?? "").trim() === "";
}

function splitFocusBlocks(section: string[]): string[][] {
  const blocks: string[][] = [];
  let index = 0;
  while (index < section.length) {
    const first = section[index] as string;
    if (first.trim() === "") {
      index += 1;
      continue;
    }
    const base = indentDepth(first);
    const collected = [first];
    let fence = fenceOpener(first);
    index += 1;
    while (index < section.length) {
      const current = section[index] as string;
      if (fence !== null) {
        collected.push(current);
        index += 1;
        if (closesFenceLine(current, fence)) fence = null;
        continue;
      }
      if (current.trim() === "") {
        let next = index;
        while (next < section.length && (section[next] as string).trim() === "") next += 1;
        if (next < section.length && indentDepth(section[next] as string) > base) {
          collected.push(...section.slice(index, next));
          index = next;
          continue;
        }
        break;
      }
      if (indentDepth(current) <= base) break;
      collected.push(current);
      fence = fenceOpener(current);
      index += 1;
    }
    blocks.push(collected);
  }
  return blocks;
}

function labelTextOf(line: string): string | null {
  if (indentDepth(line) !== 0) return null;
  const match = line.trimStart().match(LIST_ITEM_RE);
  if (!match) return null;
  return (match[1] ?? "").replace(LEADING_CHECKBOX_RE, "").trim();
}

function literalLabelKey(text: string): string | null {
  const wiki = text.match(LEAD_WIKILINK_RE);
  const raw = wiki ? ((wiki[1] ?? "").split("/").pop() ?? "").replace(/\.md$/i, "") : text.indexOf(" - ") > 0 ? text.slice(0, text.indexOf(" - ")) : "";
  const key = raw.replace(/\s+/g, " ").trim().toLowerCase();
  return key === "" ? null : key;
}

function rewriteBareLabel(line: string, projectId: string, board: ComposeBoard): string {
  const lead = line.length - line.trimStart().length;
  const body = line.slice(lead).replace(BARE_LABEL_ANY_ITEM_RE, (whole, prefix: string, target: string) => {
    const name = (target.split("/").pop() ?? "").replace(/\.md$/i, "");
    if (board.projectOfLabel(name) !== projectId) return whole;
    const project = board.projects.find((entry) => entry.id === projectId);
    return project ? `${prefix}[[${target}|${project.title}]]` : whole;
  });
  return line.slice(0, lead) + body;
}

function lineCounts(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) if (line.trim() !== "") counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

export function focusLinesPreserved(before: string[], after: string[], rewrites: [string, string][], dropped: string[]): boolean {
  const expected = lineCounts(before);
  const adjust = (line: string, delta: number): void => {
    if (line.trim() === "") return;
    expected.set(line, (expected.get(line) ?? 0) + delta);
  };
  for (const line of dropped) adjust(line, -1);
  for (const [from, to] of rewrites) {
    adjust(from, -1);
    adjust(to, 1);
  }
  const actual = lineCounts(after);
  for (const [line, count] of expected) {
    if (count < 0) return false;
    if (count !== (actual.get(line) ?? 0)) return false;
  }
  for (const line of actual.keys()) if (!expected.has(line)) return false;
  return true;
}

export function organizeFocus(content: string, opts: OrganizeFocusOptions): OrganizeFocusResult {
  const bom = content.startsWith(BOM) ? BOM : "";
  const parts = content.slice(bom.length).split(/(\r\n|\n)/);
  const lines = parts.filter((_, index) => index % 2 === 0);
  const heading = findHeadingIndex(lines, opts.heading);
  if (heading === -1) throw new BadRequestError("the daily has no focus heading");
  let end = lines.length;
  for (let index = heading + 1; index < lines.length; index += 1) {
    if (SECTION_HEADING_RE.test(lines[index] as string)) {
      end = index;
      break;
    }
  }
  const section = lines.slice(heading + 1, end);
  const rawBlocks = splitFocusBlocks(section);
  if (rawBlocks.length === 0) return { content, changed: false, groups: 0 };
  const board = opts.board;
  const firstSeen = new Map<string, number>();
  const rewrites: [string, string][] = [];
  const blocks: FocusBlock[] = rawBlocks.map((blockLines) => {
    const first = blockLines[0] as string;
    const placeholder = blockLines.length === 1 && isPlaceholderLine(first);
    const text = labelTextOf(first);
    const projectId = board && text ? board.projectOfLine(text) : null;
    const position = projectId === null || !board ? -1 : board.order.indexOf(projectId);
    if (board && projectId !== null && position !== -1) {
      const linesOut = [...blockLines];
      if (opts.wikilinks) {
        const rewritten = rewriteBareLabel(first, projectId, board);
        if (rewritten !== first) {
          rewrites.push([first, rewritten]);
          linesOut[0] = rewritten;
        }
      }
      return { lines: linesOut, key: `id:${projectId}`, tier: 0, rank: position, placeholder };
    }
    const literal = text ? literalLabelKey(text) : null;
    if (literal !== null) {
      if (!firstSeen.has(literal)) firstSeen.set(literal, firstSeen.size);
      return { lines: blockLines, key: `raw:${literal}`, tier: 1, rank: firstSeen.get(literal) as number, placeholder };
    }
    return { lines: blockLines, key: "none", tier: 2, rank: 0, placeholder };
  });
  const hasContent = blocks.some((block) => !block.placeholder);
  const kept = hasContent ? blocks.filter((block) => !block.placeholder) : blocks;
  const dropped = hasContent ? blocks.filter((block) => block.placeholder).map((block) => block.lines[0] as string) : [];
  const sorted = kept
    .map((block, index) => ({ block, index }))
    .sort((a, b) => a.block.tier - b.block.tier || a.block.rank - b.block.rank || a.index - b.index)
    .map(({ block }) => block);
  const organized: string[] = [""];
  let groups = 0;
  let previousKey: string | null = null;
  for (const block of sorted) {
    if (block.key !== previousKey) {
      if (previousKey !== null) organized.push("");
      groups += 1;
    }
    organized.push(...block.lines);
    previousKey = block.key;
  }
  let lastContent = section.length - 1;
  while (lastContent >= 0 && (section[lastContent] as string).trim() === "") lastContent -= 1;
  if (lastContent < section.length - 1) organized.push("");
  if (!focusLinesPreserved(section, organized, rewrites, dropped)) throw new BadRequestError(ORGANIZE_UNSAFE_ERROR);
  const changed = organized.length !== section.length || organized.some((line, index) => line !== section[index]);
  if (!changed) return { content, changed: false, groups };
  const eol = parts[heading * 2 + 1] ?? "\n";
  const prefix = parts.slice(0, (heading + 1) * 2).join("");
  const suffix = end < lines.length ? parts.slice(end * 2).join("") : "";
  const body = end < lines.length ? organized.map((line) => line + eol).join("") : organized.join(eol);
  return { content: bom + prefix + body + suffix, changed: true, groups };
}

export interface DailyPromptVars {
  date: string;
  file: string;
  root: string;
  template: string;
  focus: string;
  sessions: string;
  yesterday: string;
}

export function renderDailyPrompt(template: string, vars: DailyPromptVars): string {
  return template
    .split("{{date}}")
    .join(vars.date)
    .split("{{file}}")
    .join(vars.file)
    .split("{{root}}")
    .join(vars.root)
    .split("{{template}}")
    .join(vars.template)
    .split("{{focus}}")
    .join(vars.focus)
    .split("{{sessions}}")
    .join(vars.sessions)
    .split("{{yesterday}}")
    .join(vars.yesterday);
}

function resolveAgainstRoot(root: string, value: string): string {
  return isAbsolute(value) ? value : join(root, value);
}

export function dailyRoot(settings: DelegationSettings): string | null {
  return settings.secondBrainRoot;
}

export function dailyDir(settings: DelegationSettings): string | null {
  const root = dailyRoot(settings);
  if (!root) return null;
  return settings.daily.dir ? resolveAgainstRoot(root, settings.daily.dir) : join(root, "daily");
}

export function dailyTemplatePath(settings: DelegationSettings): string | null {
  const root = dailyRoot(settings);
  if (!root) return null;
  if (settings.daily.template) return resolveAgainstRoot(root, settings.daily.template);
  const builtin = join(root, "_templates", "daily.md");
  return existsSync(builtin) ? builtin : null;
}

export function dailyTemplateText(settings: DelegationSettings): string {
  const path = dailyTemplatePath(settings);
  if (path && existsSync(path)) return readFileSync(path, "utf8");
  return BUILT_IN_TEMPLATE;
}

function findExistingDailyFile(dir: string, date: string): string | null {
  const flat = join(dir, `${date}.md`);
  if (existsSync(flat)) return flat;
  const archived = join(dir, date.slice(0, 7), `${date}.md`);
  if (existsSync(archived)) return archived;
  if (!isDirectory(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(dir, entry.name, `${date}.md`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function dailyFile(settings: DelegationSettings, date: string): string | null {
  const root = dailyRoot(settings);
  if (!root) return null;
  const dir = dailyDir(settings) ?? join(root, "daily");
  return findExistingDailyFile(dir, date) ?? join(dir, `${date}.md`);
}

export function listDiaryDates(settings: DelegationSettings): string[] {
  const dir = dailyDir(settings);
  if (!dir || !isDirectory(dir)) return [];
  const dates = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && DATE_FILE_RE.test(entry.name)) {
      const date = entry.name.slice(0, 10);
      if (isValidDailyDate(date)) dates.add(date);
    } else if (entry.isDirectory()) {
      const subDir = join(dir, entry.name);
      for (const sub of readdirSync(subDir, { withFileTypes: true })) {
        if (sub.isFile() && DATE_FILE_RE.test(sub.name)) {
          const date = sub.name.slice(0, 10);
          if (isValidDailyDate(date)) dates.add(date);
        }
      }
    }
  }
  return [...dates].sort().reverse();
}

export function findYesterday(settings: DelegationSettings, date: string): string | null {
  const before = listDiaryDates(settings).filter((candidate) => candidate < date);
  return before[0] ?? null;
}

const YESTERDAY_TRAIL_MAX = 40;

export function previousDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return localDate(new Date(year ?? 1970, (month ?? 1) - 1, (day ?? 1) - 1));
}

export function yesterdayTrail(settings: DelegationSettings, date: string): { path: string; bullets: string[] } | null {
  const root = dailyRoot(settings);
  if (!root) return null;
  const dir = settings.features.trail ? trailDir(settings) : join(root, "fontes", "sessions");
  if (!dir) return null;
  const path = trailFilePath(dir, date);
  if (!existsSync(path)) return null;
  return { path, bullets: readAllBlockBullets(readFileSync(path, "utf8")).slice(0, YESTERDAY_TRAIL_MAX) };
}

export interface DailySessionSummary {
  sessionId: string;
  title: string | null;
  client: string | null;
  cwd: string | null;
  status: SessionStatus;
  startedAt: number;
  updatedAt: number;
}

export function dailySessionsForDate(date: string): DailySessionSummary[] {
  return listSessions()
    .filter((session) => localDate(new Date(session.startedAt)) === date || localDate(new Date(session.updatedAt)) === date)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session) => ({
      sessionId: session.sessionId,
      title: session.customTitle ?? session.title,
      client: session.client,
      cwd: session.cwd,
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
    }));
}

function dailySessionsMarkdown(date: string): string {
  const sessions = dailySessionsForDate(date);
  if (sessions.length === 0) return "none yet";
  return sessions.map((session) => `- ${session.title ?? "untitled"} · ${session.client ?? "unknown"} · ${session.cwd ?? "unknown"}`).join("\n");
}

export interface DailyReadResult {
  date: string;
  path: string;
  exists: boolean;
  content: string;
  updatedAt: number | null;
}

export function readDaily(settings: DelegationSettings, date: string): DailyReadResult {
  const root = dailyRoot(settings);
  if (!root) throw new BadRequestError("second brain root not set");
  const path = dailyFile(settings, date) as string;
  if (!existsSync(path)) return { date, path, exists: false, content: "", updatedAt: null };
  const stat = statSync(path);
  return { date, path, exists: true, content: readFileSync(path, "utf8"), updatedAt: stat.mtimeMs };
}

const lastHubHash = new Map<string, string>();
const lastServerWriteAt = new Map<string, number>();

export type DailyWriteOrigin = "client" | "server";

export function hashDailyContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

const hashOf = hashDailyContent;

export class DailyConflictError extends Error {
  constructor(
    public readonly content: string,
    public readonly updatedAt: number,
  ) {
    super("changed on disk");
  }
}

export interface DailyWriteResult {
  date: string;
  path: string;
  updatedAt: number;
}

export interface AtomicWriteOps {
  writeFileSync: (path: string, data: string, encoding: "utf8") => void;
  renameSync: (from: string, to: string) => void;
  copyFileSync: (from: string, to: string) => void;
  unlinkSync: (path: string) => void;
}

const nodeAtomicOps: AtomicWriteOps = { writeFileSync, renameSync, copyFileSync, unlinkSync };
const LOCK_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRIES = 3;

function isLockError(err: unknown): boolean {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  return code !== undefined && LOCK_ERROR_CODES.has(code);
}

function removeQuietly(path: string, ops: AtomicWriteOps): void {
  try {
    ops.unlinkSync(path);
  } catch {
  }
}

function moveIntoPlace(tmpPath: string, target: string, ops: AtomicWriteOps): void {
  for (let attempt = 0; attempt <= RENAME_RETRIES; attempt += 1) {
    try {
      ops.renameSync(tmpPath, target);
      return;
    } catch (err) {
      if (!isLockError(err)) throw err;
    }
  }
  ops.copyFileSync(tmpPath, target);
  removeQuietly(tmpPath, ops);
}

export function writeFileAtomic(target: string, content: string, ops: AtomicWriteOps = nodeAtomicOps): void {
  const tmpPath = `${target}.${randomUUID()}.tmp`;
  try {
    ops.writeFileSync(tmpPath, content, "utf8");
    moveIntoPlace(tmpPath, target, ops);
  } catch (err) {
    removeQuietly(tmpPath, ops);
    throw err;
  }
}

export function writeDaily(
  settings: DelegationSettings,
  date: string,
  content: string,
  baseUpdatedAt?: number,
  writeId?: string | null,
  origin: DailyWriteOrigin = "server",
): DailyWriteResult {
  const root = dailyRoot(settings);
  if (!root) throw new BadRequestError("second brain root not set");
  const path = dailyFile(settings, date) as string;
  if (typeof baseUpdatedAt === "number" && existsSync(path)) {
    const currentStat = statSync(path);
    const serverWriteAt = lastServerWriteAt.get(path);
    if (origin === "client" && serverWriteAt !== undefined && baseUpdatedAt + 1 < serverWriteAt) {
      throw new DailyConflictError(readFileSync(path, "utf8"), currentStat.mtimeMs);
    }
    if (Math.abs(currentStat.mtimeMs - baseUpdatedAt) > 1) {
      const currentContent = readFileSync(path, "utf8");
      if (lastHubHash.get(path) !== hashOf(currentContent)) {
        throw new DailyConflictError(currentContent, currentStat.mtimeMs);
      }
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, content);
  const stat = statSync(path);
  lastHubHash.set(path, hashOf(content));
  if (origin === "server") lastServerWriteAt.set(path, stat.mtimeMs);
  broadcast("daily", { date, updatedAt: stat.mtimeMs, source: "hub", writeId: writeId ?? null });
  return { date, path, updatedAt: stat.mtimeMs };
}

export interface OrganizeDailyFocusResult {
  date: string;
  path: string;
  updatedAt: number | null;
  changed: boolean;
  groups: number;
}

export function organizeDailyFocus(
  settings: DelegationSettings,
  date: string,
  board: ComposeBoard | null,
  baseUpdatedAt?: number,
): OrganizeDailyFocusResult {
  if (!settings.features.daily) throw new BadRequestError("the daily feature is disabled");
  const daily = readDaily(settings, date);
  if (!daily.exists) throw new NotFoundError("daily not found");
  const result = organizeFocus(daily.content, { heading: settings.daily.headings.focus, wikilinks: settings.daily.wikilinks, board });
  if (!result.changed) return { date, path: daily.path, updatedAt: daily.updatedAt, changed: false, groups: result.groups };
  const written = writeDaily(settings, date, result.content, baseUpdatedAt ?? daily.updatedAt ?? undefined);
  return { date, path: written.path, updatedAt: written.updatedAt, changed: true, groups: result.groups };
}

export class DailyBusyError extends Error {
  constructor(public readonly taskId: string) {
    super("a daily generation is already running for this date");
  }
}

function combineFocus(focus: string | null, context: string | null): string {
  const parts: string[] = [];
  if (focus && focus.trim()) parts.push(focus.trim());
  if (context && context.trim()) parts.push(context.trim());
  return parts.length > 0 ? parts.join("\n\n") : "not provided";
}

export function generateDaily(date: string, focus: string | null, context?: string | null): { taskId: string } {
  const settings = getSettings();
  if (!settings.features.daily) throw new BadRequestError("the daily feature is disabled");
  const root = dailyRoot(settings);
  if (!root) throw new BadRequestError("second brain root not set");
  const busy = activeDailyTask(date);
  if (busy) throw new DailyBusyError(busy.id);
  const file = dailyFile(settings, date) as string;
  const templatePath = dailyTemplatePath(settings);
  const yesterday = findYesterday(settings, date);
  const promptTemplate = settings.daily.prompt ?? DEFAULT_DAILY_PROMPT;
  const prompt = renderDailyPrompt(promptTemplate, {
    date,
    file,
    root,
    template: templatePath ?? "none",
    focus: combineFocus(focus, context ?? null),
    sessions: dailySessionsMarkdown(date),
    yesterday: yesterday ?? "unknown",
  });
  const task: TaskRecord = createInternalTask({
    title: `Daily ${date}`,
    prompt,
    workspace: "second-brain",
    cwd: root,
    addDirs: [root],
    runner: settings.daily.runner,
    createdBy: "daily",
    dailyDate: date,
  });
  startRun(task, "launch", prompt, null, null);
  return { taskId: task.id };
}

let currentWatcher: FSWatcher | null = null;
let currentWatchedDir: string | null = null;
const debounceTimers = new Map<string, NodeJS.Timeout>();

export function stopDailyWatch(): void {
  if (currentWatcher) {
    currentWatcher.close();
    currentWatcher = null;
    currentWatchedDir = null;
  }
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
}

function handleDailyFsEvent(dir: string, date: string): void {
  const path = findExistingDailyFile(dir, date);
  if (!path) return;
  let content: string;
  let stat;
  try {
    content = readFileSync(path, "utf8");
    stat = statSync(path);
  } catch {
    return;
  }
  if (lastHubHash.get(path) === hashOf(content)) return;
  broadcast("daily", { date, updatedAt: stat.mtimeMs, source: "disk", writeId: null });
}

export function watchDaily(settings: DelegationSettings): void {
  const dir = dailyDir(settings);
  if (!dir || !isDirectory(dir)) {
    stopDailyWatch();
    return;
  }
  if (currentWatchedDir === dir && currentWatcher) return;
  stopDailyWatch();
  try {
    const watcher = watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith(".md")) return;
      const date = basename(filename, ".md");
      if (!isValidDailyDate(date)) return;
      const existingTimer = debounceTimers.get(date);
      if (existingTimer) clearTimeout(existingTimer);
      debounceTimers.set(
        date,
        setTimeout(() => {
          debounceTimers.delete(date);
          handleDailyFsEvent(dir, date);
        }, WATCH_DEBOUNCE_MS),
      );
    });
    watcher.on("error", () => stopDailyWatch());
    currentWatcher = watcher;
    currentWatchedDir = dir;
  } catch {
    currentWatcher = null;
    currentWatchedDir = null;
  }
}
