export type OutlineStatus = "todo" | "doing" | "done" | "blocked" | "hold" | "archived";

export interface OutlineNote {
  line: number;
  raw: string;
  text: string;
}

export interface OutlineNode {
  id: string;
  projectId: string;
  line: number;
  raw: string;
  title: string;
  status: OutlineStatus;
  priority: number | null;
  due: string | null;
  notes: OutlineNote[];
  children: OutlineNode[];
  depth: number;
}

export interface OutlineGroup {
  project: { id: string; title: string };
  items: OutlineNode[];
}

export interface InlineTokens {
  title: string;
  priority: number | null | undefined;
  due: string | null | undefined;
}

export type OutlineIntent =
  | "edit"
  | "save"
  | "save-and-new"
  | "cancel"
  | "indent"
  | "outdent"
  | "move-up"
  | "move-down"
  | "toggle-done"
  | "add-note"
  | "open"
  | "next"
  | "prev"
  | "tomorrow"
  | "unschedule";

export type OutlineMode = "view" | "edit";

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const PRIORITY_TOKEN = /^#p([0-9])$/i;
const DUE_TOKEN = /^due:(.+)$/i;
const TODAY_WORDS = new Set(["today", "hoje"]);
const TOMORROW_WORDS = new Set(["tomorrow", "amanha", "amanhã"]);

export function isValidDay(value: string): boolean {
  const match = ISO_DAY.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function addDays(day: string, amount: number): string {
  const match = ISO_DAY.exec(day);
  if (match === null) return day;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + amount));
  return date.toISOString().slice(0, 10);
}

function resolveDue(value: string, today: string): string | null {
  const word = value.toLowerCase();
  if (isValidDay(today)) {
    if (TODAY_WORDS.has(word)) return today;
    if (TOMORROW_WORDS.has(word)) return addDays(today, 1);
  }
  return isValidDay(value) ? value : null;
}

export function parseInlineTokens(text: string, today: string): InlineTokens {
  const words = text.trim().split(/\s+/).filter((word) => word !== "");
  const kept: string[] = [];
  let priority: number | null | undefined;
  let due: string | null | undefined;
  let removed = false;
  for (const word of words) {
    const priorityMatch = PRIORITY_TOKEN.exec(word);
    if (priorityMatch !== null) {
      priority = Number(priorityMatch[1]);
      removed = true;
      continue;
    }
    const dueMatch = DUE_TOKEN.exec(word);
    const resolved = dueMatch === null ? null : resolveDue(dueMatch[1] ?? "", today);
    if (resolved !== null) {
      due = resolved;
      removed = true;
      continue;
    }
    kept.push(word);
  }
  return { title: removed ? kept.join(" ") : text.trim(), priority, due };
}

export function flattenNodes(items: readonly OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  const walk = (list: readonly OutlineNode[]) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(items);
  return out;
}

export function flattenVisible(groups: readonly OutlineGroup[]): OutlineNode[] {
  return groups.flatMap((group) => flattenNodes(group.items));
}

export function findNode(groups: readonly OutlineGroup[], id: string): OutlineNode | null {
  return flattenVisible(groups).find((node) => node.id === id) ?? null;
}

export function nextNode(groups: readonly OutlineGroup[], id: string): OutlineNode | null {
  const flat = flattenVisible(groups);
  const index = flat.findIndex((node) => node.id === id);
  if (index === -1) return flat[0] ?? null;
  return flat[index + 1] ?? null;
}

export function prevNode(groups: readonly OutlineGroup[], id: string): OutlineNode | null {
  const flat = flattenVisible(groups);
  const index = flat.findIndex((node) => node.id === id);
  if (index === -1) return flat[0] ?? null;
  return index > 0 ? (flat[index - 1] ?? null) : null;
}

export function siblingsOf(groups: readonly OutlineGroup[], node: OutlineNode): OutlineNode[] {
  for (const group of groups) {
    if (group.project.id !== node.projectId) continue;
    const found = siblingsIn(group.items, node.id);
    if (found !== null) return found;
  }
  return [node];
}

function siblingsIn(items: readonly OutlineNode[], id: string): OutlineNode[] | null {
  if (items.some((item) => item.id === id)) return [...items];
  for (const item of items) {
    const found = siblingsIn(item.children, id);
    if (found !== null) return found;
  }
  return null;
}

export function previousSibling(groups: readonly OutlineGroup[], node: OutlineNode): OutlineNode | null {
  const siblings = siblingsOf(groups, node);
  const index = siblings.findIndex((item) => item.id === node.id);
  return index > 0 ? (siblings[index - 1] ?? null) : null;
}

export function nextSibling(groups: readonly OutlineGroup[], node: OutlineNode): OutlineNode | null {
  const siblings = siblingsOf(groups, node);
  const index = siblings.findIndex((item) => item.id === node.id);
  return index >= 0 ? (siblings[index + 1] ?? null) : null;
}

export function canIndent(groups: readonly OutlineGroup[], node: OutlineNode): boolean {
  return previousSibling(groups, node) !== null;
}

export function canOutdent(node: OutlineNode): boolean {
  return node.depth > 0;
}

export function canMove(groups: readonly OutlineGroup[], node: OutlineNode, dir: "up" | "down"): boolean {
  return (dir === "up" ? previousSibling(groups, node) : nextSibling(groups, node)) !== null;
}

export function subtreeEnd(nodes: readonly OutlineNode[], index: number): number {
  const root = nodes[index];
  if (root === undefined) return index;
  let end = index + 1;
  while (end < nodes.length && (nodes[end]?.depth ?? 0) > root.depth) end += 1;
  return end;
}

export function keyIntent(event: KeyEventLike, mode: OutlineMode): OutlineIntent | null {
  const mod = event.ctrlKey || event.metaKey;
  const { key, altKey, shiftKey } = event;
  if (key === "Tab") {
    if (mod || altKey) return null;
    return shiftKey ? "outdent" : "indent";
  }
  if (key === "Enter") {
    if (altKey) return null;
    if (mod) return shiftKey ? null : "toggle-done";
    if (shiftKey) return "add-note";
    return mode === "edit" ? "save-and-new" : "edit";
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    if (mod || shiftKey) return null;
    if (altKey) return key === "ArrowUp" ? "move-up" : "move-down";
    if (mode === "edit") return null;
    return key === "ArrowUp" ? "prev" : "next";
  }
  if (mode === "edit") {
    if (key === "Escape" && !mod && !altKey && !shiftKey) return "cancel";
    if ((key === "s" || key === "S") && mod && !altKey && !shiftKey) return "save";
    return null;
  }
  if (mod || altKey || shiftKey) return null;
  if (key === "j") return "next";
  if (key === "k") return "prev";
  if (key === "o") return "open";
  if (key === "m") return "tomorrow";
  if (key === "Delete" || key === "Backspace") return "unschedule";
  return null;
}
