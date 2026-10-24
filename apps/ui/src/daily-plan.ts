import type { BoardCheckbox, BoardProject, BoardStatus, DailyLinkItem, DailyYesterdayTask } from "./delegation";

export interface DailyFocusDraftItem {
  project: string | null;
  text: string;
  block?: string;
}

export function shouldPersistWizardDraft(wizardDate: string | null, currentDate: string | null, hydrated: boolean): wizardDate is string {
  return wizardDate !== null && wizardDate === currentDate && hydrated;
}

export function parseNewItems(text: string): DailyFocusDraftItem[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const sep = line.indexOf(" - ");
      if (sep === -1) return { project: null, text: line };
      const project = line.slice(0, sep).trim();
      const rest = line.slice(sep + 3).trim();
      return { project, text: rest };
    });
}

export function formatNewItemLine(item: DailyFocusDraftItem): string {
  if (!item.project) return item.text;
  const project = item.project.replace(/\s+-\s+/g, " ").trim();
  return project ? `${project} - ${item.text}` : item.text;
}

export function appendNewItem(text: string, item: DailyFocusDraftItem): string {
  const line = formatNewItemLine(item);
  if (text.split("\n").some((existing) => existing.trim() === line)) return text;
  const base = text.replace(/\s+$/, "");
  return base ? `${base}\n${line}\n` : `${line}\n`;
}

export function parseMeetings(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const DOING_BLOCK_RE = /^\s*[-*]\s+\[-\]/;

export function isDoingBlock(block: string | undefined): boolean {
  if (!block) return false;
  return DOING_BLOCK_RE.test(block.split(/\r?\n/)[0] ?? "");
}

function projectLabel(project: string | null, wikilinks: boolean): string | null {
  if (!project) return null;
  return wikilinks ? `[[${project}]]` : project;
}

export function doingFocusItem(item: DailyFocusDraftItem, wikilinks: boolean): DailyFocusDraftItem {
  const label = projectLabel(item.project, wikilinks);
  const block = label ? `- [-] ${label} - ${item.text}` : `- [-] ${item.text}`;
  return { project: null, text: item.text, block };
}

export function hasFocusItem(items: DailyFocusDraftItem[], item: DailyFocusDraftItem): boolean {
  return items.some((existing) => existing.block !== undefined && existing.block === item.block);
}

export function focusPreviewLines(items: DailyFocusDraftItem[], wikilinks: boolean): string[] {
  return items.map((item) => {
    if (item.block && isDoingBlock(item.block)) return (item.block.split(/\r?\n/)[0] ?? "").trim();
    const label = projectLabel(item.project, wikilinks);
    return label ? `- [ ] ${label} - ${item.text}` : `- [ ] ${item.text}`;
  });
}

export function defaultYesterdayDone(task: DailyYesterdayTask): boolean {
  return task.state === "done";
}

export function defaultYesterdayCarry(task: DailyYesterdayTask): boolean {
  return task.state !== "done";
}

export function carryOverFromYesterday(
  tasks: DailyYesterdayTask[],
  doneStates: Record<number, boolean>,
  carryStates: Record<number, boolean>,
): DailyFocusDraftItem[] {
  return tasks
    .filter((task) => {
      if (task.line in carryStates) return carryStates[task.line] === true;
      return !(doneStates[task.line] ?? defaultYesterdayDone(task));
    })
    .map((task) => ({ project: null, text: task.text, block: task.block }));
}

export function keepPickedDoingItems(
  computed: DailyFocusDraftItem[],
  previous: DailyFocusDraftItem[],
  yesterdayTasks: DailyYesterdayTask[],
): DailyFocusDraftItem[] {
  const fromYesterday = new Set(yesterdayTasks.map((task) => task.block).filter((block): block is string => block !== undefined));
  const kept = [...computed];
  for (const item of previous) {
    if (!isDoingBlock(item.block)) continue;
    if (item.block !== undefined && fromYesterday.has(item.block)) continue;
    if (hasFocusItem(kept, item)) continue;
    kept.push(item);
  }
  return kept;
}

export function mergeTrailIntoSummary(current: string, bullets: string[], max = 3): string {
  const present = new Set(current.split("\n").map((line) => line.trim()));
  const picked = bullets
    .map((bullet) => bullet.trim())
    .filter((bullet) => bullet.length > 0 && !present.has(bullet))
    .slice(0, max);
  if (picked.length === 0) return current;
  const base = current.trim();
  const joined = picked.join("\n");
  return base ? `${base}\n${joined}` : joined;
}

export type DailyLinkState = "linked" | "ambiguous" | "missing";

export function dailyLinkState(item: DailyLinkItem): DailyLinkState {
  if (item.taskId !== null) return "linked";
  return item.candidates.length > 0 ? "ambiguous" : "missing";
}

export function syncStatusFor(checkbox: BoardCheckbox): BoardStatus {
  return checkbox;
}

export function addToTasksDefaults(item: DailyLinkItem, projects: BoardProject[]): { projectId: string; title: string; status: BoardStatus } {
  const known = item.projectId !== null && projects.some((project) => project.id === item.projectId);
  return { projectId: known ? (item.projectId as string) : "", title: item.text, status: syncStatusFor(item.checkbox) };
}
