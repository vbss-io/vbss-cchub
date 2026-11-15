import type { BoardCheckbox, BoardProject, BoardTask, TodayAmbiguous, TodayData, TodayUnmatched, TodayUnmatchedCandidate } from "./delegation";
import { ambiguityHint, BACKLOG_STATUSES, flattenBoardTasks, parseQuickAdd, plainLineText, type QuickAdd } from "./today-model";

export interface NoteBlockItem {
  line: string;
  lineIndex: number | null;
  taskId: string | null;
  projectId: string | null;
  text: string | null;
  children: string[];
}

export interface LinkedNoteItem {
  key: string;
  block: NoteBlockItem;
  task: BoardTask;
}

export interface NoMatchItem {
  key: string;
  line: string;
  lineIndex: number | null;
  section: string | null;
  checkbox: BoardCheckbox | null;
  candidates: TodayUnmatchedCandidate[];
  projectId: string | null;
  text: string;
  children: string[];
  hint: string | null;
  tick: TodayUnmatched | null;
}

export interface NoteSections {
  linked: LinkedNoteItem[];
  noMatch: NoMatchItem[];
  ambiguous: TodayAmbiguous[];
}

const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const CHECKBOX_RE = /^\[([ xX-])\]\s*/;
const LEAD_WIKILINK_RE = /^\[\[([^\]|]*)(?:\|([^\]]*))?\]\]\s*(?:-\s+)?/;

export function lineCheckbox(line: string): BoardCheckbox | null {
  const bullet = BULLET_RE.exec(line);
  if (bullet === null) return null;
  const box = CHECKBOX_RE.exec(line.slice(bullet[0].length));
  if (box === null) return null;
  const mark = box[1] ?? " ";
  return mark === "-" ? "doing" : mark.toLowerCase() === "x" ? "done" : "todo";
}

export function lineContent(line: string): string {
  const bullet = BULLET_RE.exec(line);
  if (bullet === null) return line.trim();
  const rest = line.slice(bullet[0].length);
  return rest.replace(CHECKBOX_RE, "").trim();
}

const fold = (text: string): string =>
  plainLineText(text)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

function projectOfLabel(label: string, projects: readonly BoardProject[]): string | null {
  const wanted = fold(((label.split("/").pop() ?? "").replace(/\.md$/i, "")) || label);
  if (wanted === "") return null;
  const hits = projects.filter((project) => [project.id, project.name, project.title].some((name) => fold(name) === wanted || fold(name.split("/").pop() ?? "") === wanted));
  return hits.length === 1 ? (hits[0] as BoardProject).id : null;
}

export function splitNoteLine(line: string, projects: readonly BoardProject[]): { projectId: string | null; text: string } {
  const content = lineContent(line);
  const wiki = LEAD_WIKILINK_RE.exec(content);
  if (wiki !== null) {
    const target = wiki[1] ?? "";
    const projectId = projectOfLabel(target.trim() === "" ? (wiki[2] ?? "") : target, projects);
    if (projectId !== null) return { projectId, text: content.slice(wiki[0].length).trim() };
  }
  const split = content.indexOf(" - ");
  if (split > 0) {
    const projectId = projectOfLabel(content.slice(0, split), projects);
    if (projectId !== null) return { projectId, text: content.slice(split + 3).trim() };
  }
  return { projectId: null, text: content };
}

const isIndented = (line: string): boolean => /^\s/.test(line);

export function noteBlocksOf(data: Pick<TodayData, "noteBlocks" | "inNoteLinks" | "inNote" | "unlinked">): NoteBlockItem[] {
  if (data.noteBlocks !== undefined) return data.noteBlocks.map((block) => ({ ...block, children: [...block.children] }));
  const links = data.inNoteLinks ?? (data.inNote ?? data.unlinked).map((line) => ({ line, taskId: null }));
  const out: NoteBlockItem[] = [];
  for (const item of links) {
    const last = out[out.length - 1];
    if (last !== undefined && isIndented(item.line) && item.taskId === null) {
      last.children.push(item.line);
      continue;
    }
    out.push({ line: item.line, lineIndex: null, taskId: item.taskId, projectId: null, text: null, children: [] });
  }
  return out;
}

const findTask = (tasks: readonly BoardTask[], id: string): BoardTask | null => flattenBoardTasks(tasks).find((task) => task.id === id) ?? null;

export function noteSections(data: Pick<TodayData, "noteBlocks" | "inNoteLinks" | "inNote" | "unlinked" | "unmatched" | "ambiguous">, tasks: readonly BoardTask[], projects: readonly BoardProject[]): NoteSections {
  const blocks = noteBlocksOf(data);
  const linked: LinkedNoteItem[] = [];
  const loose: NoteBlockItem[] = [];
  for (const block of blocks) {
    const task = block.taskId === null ? null : findTask(tasks, block.taskId);
    if (task !== null) linked.push({ key: `linked:${block.lineIndex ?? ""}:${block.line}`, block, task });
    else loose.push(block);
  }
  const ambiguous: TodayAmbiguous[] = [];
  const noMatch: NoMatchItem[] = [];
  const used = new Set<NoteBlockItem>();
  const blockFor = (tick: TodayUnmatched): NoteBlockItem | undefined =>
    loose.find((block) => !used.has(block) && block.line === tick.line && (block.lineIndex === null || block.lineIndex === tick.lineIndex));
  for (const tick of data.unmatched ?? []) {
    const block = blockFor(tick);
    if (block !== undefined) used.add(block);
    const split = splitNoteLine(tick.line, projects);
    noMatch.push({
      key: `tick:${tick.lineIndex}:${tick.line}`,
      line: tick.line,
      lineIndex: tick.lineIndex,
      section: tick.section,
      checkbox: tick.checkbox,
      candidates: tick.candidates,
      projectId: block?.projectId ?? split.projectId,
      text: block?.text ?? split.text,
      children: block?.children ?? [],
      hint: null,
      tick,
    });
  }
  for (const block of loose) {
    if (used.has(block)) continue;
    const split = splitNoteLine(block.line, projects);
    noMatch.push({
      key: `block:${block.lineIndex ?? ""}:${block.line}`,
      line: block.line,
      lineIndex: block.lineIndex,
      section: null,
      checkbox: lineCheckbox(block.line),
      candidates: [],
      projectId: block.text === null ? split.projectId : block.projectId,
      text: block.text ?? split.text,
      children: block.children,
      hint: null,
      tick: null,
    });
  }
  for (const item of data.ambiguous ?? []) {
    const owner = noMatch.find((entry) => entry.line === item.text && (item.line === null || entry.lineIndex === null || entry.lineIndex === item.line));
    if (owner === undefined) ambiguous.push(item);
    else if (owner.hint === null) owner.hint = ambiguityHint(item);
  }
  return { linked, noMatch, ambiguous };
}

export const canLinkNoMatch = (item: Pick<NoMatchItem, "lineIndex" | "checkbox">): boolean => item.lineIndex !== null && item.checkbox !== null;

export const canCreateFromNoMatch = (item: Pick<NoMatchItem, "text">): boolean => plainLineText(item.text) !== "";

export const isFocusable = (task: Pick<BoardTask, "section" | "status">): boolean => task.section === "open" && (BACKLOG_STATUSES as readonly string[]).includes(task.status);

export type FocusAddPlan =
  | { kind: "schedule"; task: BoardTask }
  | { kind: "already"; task: BoardTask }
  | { kind: "create"; projectId: string; input: QuickAdd };

export const titleKey = (text: string): string =>
  fold(text)
    .replace(/[*`~]/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();

export function matchingOpenTasks(tasks: readonly BoardTask[], projectId: string, title: string): BoardTask[] {
  const wanted = titleKey(title);
  if (wanted === "") return [];
  return flattenBoardTasks(tasks).filter((task) => task.projectId === projectId && isFocusable(task) && titleKey(task.title) === wanted);
}

export function planFocusAdd(tasks: readonly BoardTask[], projectId: string, text: string, today: string, date: string, focusIds: ReadonlySet<string>): FocusAddPlan | null {
  const parsed = parseQuickAdd(text, today);
  if (parsed === null || projectId === "") return null;
  const matches = matchingOpenTasks(tasks, projectId, parsed.title);
  const inFocus = matches.find((task) => focusIds.has(task.id) || (task.scheduled ?? null) === date);
  if (inFocus !== undefined) return { kind: "already", task: inFocus };
  const pick = matches.find((task) => (task.scheduled ?? null) === null) ?? matches[0];
  if (pick !== undefined) return { kind: "schedule", task: pick };
  return { kind: "create", projectId, input: parsed };
}

export const createTitleOf = (item: Pick<NoMatchItem, "text">): string => item.text.trim();
