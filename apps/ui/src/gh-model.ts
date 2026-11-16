import type { GhChecks, GhRun, GhStatus } from "./types";

export type GhTone = "go" | "pend" | "hold" | "muted";

export const ghVisible = (status: GhStatus | null | undefined): status is Extract<GhStatus, { available: true }> => status !== null && status !== undefined && status.available;

export function checksLine(checks: GhChecks): string {
  if (checks.total === 0) return "No checks";
  if (checks.failing > 0) return `${checks.failing} of ${checks.total} checks failing`;
  if (checks.pending > 0) return `${checks.pending} of ${checks.total} checks running`;
  return `All ${checks.total} checks passing`;
}

export const checksTone = (checks: GhChecks): GhTone => {
  if (checks.state === "failing") return "hold";
  if (checks.state === "pending") return "pend";
  if (checks.state === "passing") return "go";
  return "muted";
};

export function prState(state: string, isDraft: boolean): string {
  if (isDraft && state.toUpperCase() === "OPEN") return "Draft";
  const lower = state.toLowerCase();
  return lower.length > 0 ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : "Unknown";
}

export function runState(run: Pick<GhRun, "status" | "conclusion">): string {
  if (run.status !== null && run.status !== "completed") return run.status.replace(/_/g, " ");
  return run.conclusion ? run.conclusion.replace(/_/g, " ") : "unknown";
}

export const runTone = (run: Pick<GhRun, "status" | "conclusion">): GhTone => {
  if (run.status !== null && run.status !== "completed") return "pend";
  if (run.conclusion === "success") return "go";
  if (run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "startup_failure") return "hold";
  return "muted";
};

export const runTitle = (run: Pick<GhRun, "title" | "workflow">): string => (run.workflow && run.workflow !== run.title ? `${run.workflow}: ${run.title}` : run.title);

export function safeUrl(url: string | null): string | null {
  if (url === null) return null;
  return /^https:\/\//i.test(url) ? url : null;
}

export const noPrLine = (branch: string): string => `No pull request for ${branch}`;
