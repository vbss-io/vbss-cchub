import type { DailyYesterdayTask } from "./delegation";

export interface DailyFocusDraftItem {
  project: string | null;
  text: string;
  block?: string;
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

export function parseMeetings(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function focusPreviewLines(items: DailyFocusDraftItem[], wikilinks: boolean): string[] {
  return items.map((item) => {
    if (!item.project) return `- [ ] ${item.text}`;
    const label = wikilinks ? `[[${item.project}]]` : item.project;
    return `- [ ] ${label} - ${item.text}`;
  });
}

export function carryOverFromYesterday(
  tasks: DailyYesterdayTask[],
  doneStates: Record<number, boolean>,
  carryStates: Record<number, boolean>,
): DailyFocusDraftItem[] {
  return tasks
    .filter((task) => {
      if (task.line in carryStates) return carryStates[task.line] === true;
      return !(doneStates[task.line] ?? task.checked);
    })
    .map((task) => ({ project: null, text: task.text, block: task.block }));
}
