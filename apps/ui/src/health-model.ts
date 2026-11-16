import { formatLocalTime } from "./routine-model";
import type { HealthFix, HealthItem, HealthReport, HealthState } from "./types";

export const HEALTH_STATE_LABEL: Readonly<Record<HealthState, string>> = {
  ok: "OK",
  warn: "Attention",
  off: "Off",
  error: "Error",
};

export type FixPlan =
  | { kind: "api"; label: string; method: "POST"; path: string; body: Record<string, string> | null }
  | { kind: "navigate"; label: string; hash: string };

export interface HealthRow {
  id: HealthItem["id"];
  label: string;
  state: HealthState;
  stateLabel: string;
  detail: string;
  fix: FixPlan | null;
}

export function fixPlan(fix: HealthFix | null): FixPlan | null {
  if (fix === null) return null;
  if (fix.kind === "api") return { kind: "api", label: fix.label, method: fix.method, path: fix.path, body: fix.body ?? null };
  return { kind: "navigate", label: fix.label, hash: fix.hash };
}

export const healthRows = (report: HealthReport | null): HealthRow[] =>
  (report?.items ?? []).map((item) => ({
    id: item.id,
    label: item.label,
    state: item.state,
    stateLabel: HEALTH_STATE_LABEL[item.state],
    detail: item.detail,
    fix: fixPlan(item.fixAction),
  }));

export function healthSummary(report: HealthReport | null): string {
  if (report === null) return "Checking";
  const bad = report.items.filter((item) => item.state === "warn" || item.state === "error").length;
  if (bad > 0) return `${bad} need${bad === 1 ? "s" : ""} attention`;
  const off = report.items.filter((item) => item.state === "off").length;
  return off > 0 ? `Everything that is on works, ${off} off` : "Everything works";
}

export const checkedLine = (report: HealthReport | null, now: number): string | null => (report === null ? null : `Checked ${formatLocalTime(report.checkedAt, now)}`);

export const canRunFix = (fix: FixPlan | null, busyId: string | null): boolean => fix !== null && busyId === null;

export const countByState = (report: HealthReport | null): Record<HealthState, number> => {
  const counts: Record<HealthState, number> = { ok: 0, warn: 0, off: 0, error: 0 };
  for (const item of report?.items ?? []) counts[item.state] += 1;
  return counts;
};
