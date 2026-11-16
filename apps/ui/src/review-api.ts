import { hubRequest, HubRequestError } from "./hub-request";
import type { CostTotals, DiffResult, GhStatus, ReviewComment, ReviewSendResult } from "./types";

export type ReviewSubject = { kind: "task"; id: string } | { kind: "session"; id: string };

const pathOf = (subject: ReviewSubject): string => `/delegation/${subject.kind === "task" ? "tasks" : "sessions"}/${encodeURIComponent(subject.id)}`;

export const fetchDiff = (subject: ReviewSubject, options: { file?: string; runId?: string } = {}, signal?: AbortSignal): Promise<DiffResult> => {
  const query = new URLSearchParams();
  if (options.runId) query.set("runId", options.runId);
  if (options.file) query.set("file", options.file);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return hubRequest("GET", `${pathOf(subject)}/diff${suffix}`, undefined, signal);
};

export const sendReview = (subject: ReviewSubject, comments: ReviewComment[]): Promise<ReviewSendResult> => hubRequest("POST", `${pathOf(subject)}/review`, { comments });

export const fetchGh = (subject: ReviewSubject, signal?: AbortSignal): Promise<GhStatus> => hubRequest("GET", `${pathOf(subject)}/gh`, undefined, signal);

export const isBusyError = (err: unknown): boolean => err instanceof HubRequestError && err.status === 409;

export const fetchTaskCosts = async (ids: readonly string[]): Promise<Record<string, CostTotals>> => {
  if (ids.length === 0) return {};
  const result = await hubRequest<{ tasks: Record<string, CostTotals> }>("GET", `/delegation/costs?taskIds=${ids.map(encodeURIComponent).join(",")}`);
  return result.tasks;
};

export const fetchTaskCost = (id: string): Promise<CostTotals> => hubRequest("GET", `/delegation/tasks/${encodeURIComponent(id)}/cost`);
