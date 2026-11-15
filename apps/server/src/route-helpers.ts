import { BadRequestError, NotFoundError } from "./delegation-launch.js";
import { WorktreeError } from "./worktrees.js";
import { portRangeOf } from "./task-ports.js";
import type { TaskRecord } from "./delegation-types.js";

export const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

export const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T | null {
  const text = asString(value);
  if (!text) return null;
  if (!(allowed as readonly string[]).includes(text)) {
    throw new BadRequestError(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return text as T;
}

export const sendError = (res: { status: (code: number) => { json: (body: unknown) => void } }, err: unknown): void => {
  if (err instanceof WorktreeError) {
    res.status(err.status).json(err.files ? { error: err.message, files: err.files } : { error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "request failed";
  res.status(err instanceof BadRequestError ? 400 : err instanceof NotFoundError ? 404 : 500).json({ error: message });
};

export const clipText = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export const taskJson = (task: TaskRecord): TaskRecord & { portEnd: number | null } => ({
  ...task,
  portEnd: task.portBase != null ? portRangeOf(task.portBase).end : null,
});
