import { BOARD_STATUS_LABEL, findTaskAfterRefetch, priorityLabel } from "./board-model";
import type { BoardChange, BoardStatus, BoardTarget, BoardTask } from "./delegation";

export type BulkAction =
  | { kind: "status"; status: BoardStatus }
  | { kind: "priority"; priority: number | null }
  | { kind: "move"; projectId: string }
  | { kind: "archive" };

export interface BulkSkip {
  task: BoardTask;
  reason: string;
}

export interface BulkPlan {
  steps: BoardTask[];
  unchanged: BoardTask[];
  skipped: BulkSkip[];
}

export interface BulkReport {
  applied: BoardTask[];
  skipped: BulkSkip[];
  conflicts: number;
}

export interface BulkIo {
  patch: (target: BoardTarget, change: BoardChange) => Promise<{ task: BoardTask; moved: boolean; recurred?: boolean }>;
  move: (target: BoardTarget, projectId: string) => Promise<unknown>;
  reload: () => Promise<BoardTask[] | null>;
  isConflict: (error: unknown) => boolean;
}

export const LOCKED_REASON = "finished occurrence, edit it in Obsidian";
export const CONFLICT_REASON = "changed on disk";
export const MISSING_REASON = "no longer found";
export const REFRESH_FAILED_REASON = "the board could not be refreshed";

const NAMES_SHOWN = 3;

const targetOf = (task: BoardTask): BoardTarget => ({ projectId: task.projectId, line: task.line, raw: task.raw });

export function changeFor(action: BulkAction): BoardChange | null {
  if (action.kind === "status") return { status: action.status };
  if (action.kind === "priority") return { priority: action.priority };
  if (action.kind === "archive") return { status: "archived" };
  return null;
}

function isNoop(task: BoardTask, action: BulkAction): boolean {
  if (action.kind === "status") return task.status === action.status;
  if (action.kind === "priority") return task.priority === action.priority;
  if (action.kind === "archive") return task.status === "archived";
  return task.projectId === action.projectId;
}

export function planBulk(tasks: readonly BoardTask[], action: BulkAction, locked: ReadonlySet<string>): BulkPlan {
  const plan: BulkPlan = { steps: [], unchanged: [], skipped: [] };
  for (const task of tasks) {
    if (locked.has(task.id)) plan.skipped.push({ task, reason: LOCKED_REASON });
    else if (isNoop(task, action)) plan.unchanged.push(task);
    else plan.steps.push(task);
  }
  return plan;
}

async function rebind(rest: BoardTask[], io: BulkIo, skipped: BulkSkip[]): Promise<BoardTask[]> {
  const fresh = await io.reload();
  if (fresh === null) {
    for (const task of rest) skipped.push({ task, reason: REFRESH_FAILED_REASON });
    return [];
  }
  const bound: BoardTask[] = [];
  for (const task of rest) {
    const found = findTaskAfterRefetch(fresh, task);
    if (found) bound.push(found);
    else skipped.push({ task, reason: MISSING_REASON });
  }
  return bound;
}

async function applyOne(task: BoardTask, action: BulkAction, io: BulkIo): Promise<boolean> {
  if (action.kind === "move") {
    await io.move(targetOf(task), action.projectId);
    return true;
  }
  const result = await io.patch(targetOf(task), changeFor(action) as BoardChange);
  return result.moved || result.recurred === true;
}

export async function runBulk(steps: readonly BoardTask[], action: BulkAction, io: BulkIo): Promise<BulkReport> {
  const report: BulkReport = { applied: [], skipped: [], conflicts: 0 };
  let queue = [...steps];
  while (queue.length > 0) {
    const [task, ...rest] = queue as [BoardTask, ...BoardTask[]];
    let shifted = false;
    try {
      shifted = await applyOne(task, action, io);
      report.applied.push(task);
    } catch (error) {
      if (io.isConflict(error)) {
        report.conflicts += 1;
        report.skipped.push({ task, reason: CONFLICT_REASON });
        shifted = true;
      } else report.skipped.push({ task, reason: error instanceof Error ? error.message : "could not update the task" });
    }
    queue = shifted && rest.length > 0 ? await rebind(rest, io, report.skipped) : rest;
  }
  return report;
}

const plural = (count: number): string => (count === 1 ? "task" : "tasks");

export function bulkActionNotice(action: BulkAction, count: number, projectLabel: string): string {
  const noun = `${count} ${plural(count)}`;
  if (action.kind === "status") return `Set ${BOARD_STATUS_LABEL[action.status]} on ${noun}`;
  if (action.kind === "priority") return action.priority === null ? `Cleared the priority of ${noun}` : `Set ${priorityLabel(action.priority)} on ${noun}`;
  if (action.kind === "archive") return `Archived ${noun}`;
  return `Moved ${noun} to ${projectLabel}`;
}

export function skippedMessage(skipped: readonly BulkSkip[], refreshed: boolean): string | null {
  if (skipped.length === 0) return null;
  const shown = skipped.slice(0, NAMES_SHOWN).map((item) => `"${item.task.title}" (${item.reason})`);
  const more = skipped.length > NAMES_SHOWN ? ` and ${skipped.length - NAMES_SHOWN} more` : "";
  const tail = refreshed ? " The board was refreshed." : "";
  return `Skipped ${skipped.length} ${plural(skipped.length)}: ${shown.join(", ")}${more}.${tail}`;
}

export interface BulkSummary {
  notice: string | null;
  error: string | null;
}

export function bulkSummary(action: BulkAction, projectLabel: string, plan: BulkPlan, report: BulkReport): BulkSummary {
  const skipped = [...plan.skipped, ...report.skipped];
  const error = skippedMessage(skipped, report.conflicts > 0);
  if (report.applied.length > 0) return { notice: bulkActionNotice(action, report.applied.length, projectLabel), error };
  if (skipped.length === 0) return { notice: "Nothing to change on the selected tasks", error: null };
  return { notice: null, error };
}

export type SelectionState = "none" | "some" | "all";

export function selectionState(rows: readonly BoardTask[], selected: ReadonlySet<string>): SelectionState {
  const count = rows.filter((task) => selected.has(task.id)).length;
  if (count === 0) return "none";
  return count === rows.length ? "all" : "some";
}

export function toggleSelected(selected: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function toggleSelectAll(rows: readonly BoardTask[], selected: ReadonlySet<string>): ReadonlySet<string> {
  return selectionState(rows, selected) === "all" ? new Set() : new Set(rows.map((task) => task.id));
}

export const selectedRows = (rows: readonly BoardTask[], selected: ReadonlySet<string>): BoardTask[] => rows.filter((task) => selected.has(task.id));
