import type { DailyYesterdayTask } from "./delegation";

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

export function mergeTrailIntoSummary(current: string, bullets: string[], max = 3): string {
  const picked = bullets
    .map((bullet) => bullet.trim())
    .filter((bullet) => bullet.length > 0)
    .slice(0, max)
    .join("\n");
  const base = current.trim();
  if (!picked) return current;
  return base ? `${base}\n${picked}` : picked;
}
