export interface ShowMoreOptions {
  initial: number;
  step: number;
  showAllUnder: number;
}

export const LIST_WINDOW: ShowMoreOptions = { initial: 20, step: 50, showAllUnder: 25 };
export const LOG_WINDOW: ShowMoreOptions = { initial: 500, step: 1000, showAllUnder: 500 };

export type ShowMoreFrom = "start" | "end";

export interface ShowMoreState {
  key: string;
  visible: number;
  clicks: number;
}

export interface ShowMoreView {
  shown: number;
  hidden: number;
  next: number;
  all: number;
}

export interface ShowMoreLabel {
  action: "more" | "all";
  label: string;
  count: number;
}

export const showMoreStart = (key: string, options: ShowMoreOptions): ShowMoreState => ({ key, visible: options.initial, clicks: 0 });

export const showMoreSync = (state: ShowMoreState, key: string, options: ShowMoreOptions): ShowMoreState => (state.key === key ? state : showMoreStart(key, options));

export function showMoreView(state: ShowMoreState, total: number, options: ShowMoreOptions): ShowMoreView {
  const shown = Math.min(total, Math.max(0, state.visible));
  const hidden = total - shown;
  if (hidden === 0) return { shown, hidden, next: 0, all: 0 };
  if (hidden <= options.showAllUnder) return { shown, hidden, next: 0, all: hidden };
  return { shown, hidden, next: Math.min(options.step, hidden), all: state.clicks > 0 ? hidden : 0 };
}

export const showMoreAll = (state: ShowMoreState): ShowMoreState => ({ ...state, visible: Number.POSITIVE_INFINITY, clicks: state.clicks + 1 });

export function showMoreNext(state: ShowMoreState, total: number, options: ShowMoreOptions): ShowMoreState {
  const view = showMoreView(state, total, options);
  if (view.next === 0) return showMoreAll(state);
  return { ...state, visible: view.shown + view.next, clicks: state.clicks + 1 };
}

export function visibleRange(total: number, shown: number, from: ShowMoreFrom): { start: number; end: number } {
  const count = Math.min(total, Math.max(0, shown));
  return from === "start" ? { start: 0, end: count } : { start: total - count, end: total };
}

export function showMoreReveal(state: ShowMoreState, index: number, total: number, from: ShowMoreFrom): ShowMoreState {
  if (index < 0 || index >= total) return state;
  const needed = from === "start" ? index + 1 : total - index;
  return state.visible >= needed ? state : { ...state, visible: needed };
}

export function newItemIndex(previous: readonly string[], next: readonly string[]): number {
  const seen = new Map<string, number>();
  for (const key of previous) seen.set(key, (seen.get(key) ?? 0) + 1);
  let found = -1;
  next.forEach((key, index) => {
    const left = seen.get(key) ?? 0;
    if (left > 0) seen.set(key, left - 1);
    else found = index;
  });
  return found;
}

export interface RowRange {
  start: number;
  end: number;
}

export function revealedOffset(before: RowRange, after: RowRange, from: ShowMoreFrom): number | null {
  if (from === "start") return after.end > before.end ? before.end - after.start : null;
  return after.start < before.start ? 0 : null;
}

export function showMoreLabels(view: ShowMoreView, from: ShowMoreFrom, unit?: string): ShowMoreLabel[] {
  const suffix = unit ? ` ${unit}` : "";
  const labels: ShowMoreLabel[] = [];
  if (view.next > 0) labels.push({ action: "more", label: `${from === "end" ? "Show earlier" : "Show more"} (+${view.next}${suffix})`, count: view.next });
  if (view.all > 0) labels.push({ action: "all", label: `Show all (+${view.all}${suffix})`, count: view.all });
  return labels;
}

export function countLines(text: string): number {
  let count = 1;
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) count += 1;
  return count;
}

export interface LogWindow<T extends { text: string }> {
  items: T[];
  hiddenLines: number;
  totalLines: number;
}

export function logWindow<T extends { text: string }>(lines: readonly T[], limit: number): LogWindow<T> {
  const counts = lines.map((line) => countLines(line.text));
  const totalLines = counts.reduce((sum, count) => sum + count, 0);
  if (totalLines <= limit) return { items: [...lines], hiddenLines: 0, totalLines };
  const items: T[] = [];
  let remaining = limit;
  for (let index = lines.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const line = lines[index] as T;
    const count = counts[index] ?? 1;
    if (count <= remaining) {
      items.push(line);
      remaining -= count;
    } else {
      const parts = line.text.split("\n");
      items.push({ ...line, text: parts.slice(parts.length - remaining).join("\n") });
      remaining = 0;
    }
  }
  return { items: items.reverse(), hiddenLines: totalLines - limit, totalLines };
}

export const clampOverflows = (scrollHeight: number, clientHeight: number): boolean => scrollHeight > clientHeight + 1;

export function toggleKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(keys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
