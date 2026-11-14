import type { ReportRecord } from "./delegation";

export type ReportKind = ReportRecord["kind"];
export type KindFilter = ReportKind | "all";

export const REPORT_KINDS: readonly ReportKind[] = ["result", "progress", "blocked", "note"];
export const ALL_WORKSPACES = "";
export const NO_WORKSPACE = "__none__";

export interface ReportFilters {
  kind: KindFilter;
  workspace: string;
  query: string;
}

export const DEFAULT_REPORT_FILTERS: ReportFilters = { kind: "all", workspace: ALL_WORKSPACES, query: "" };

export interface WorkspaceOption {
  value: string;
  label: string;
  count: number;
}

const matchesWorkspace = (report: ReportRecord, workspace: string): boolean => {
  if (workspace === ALL_WORKSPACES) return true;
  if (workspace === NO_WORKSPACE) return report.workspace == null || report.workspace === "";
  return report.workspace === workspace;
};

export function matchesQuery(report: ReportRecord, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [report.text, report.source, report.workspace, report.sessionId, report.taskId, report.kind].some(
    (field) => field != null && field.toLowerCase().includes(needle),
  );
}

export function filterReports(reports: readonly ReportRecord[], filters: ReportFilters): ReportRecord[] {
  return reports.filter(
    (report) => (filters.kind === "all" || report.kind === filters.kind) && matchesWorkspace(report, filters.workspace) && matchesQuery(report, filters.query),
  );
}

export function kindCounts(reports: readonly ReportRecord[], filters: ReportFilters): Record<KindFilter, number> {
  const scoped = filterReports(reports, { ...filters, kind: "all" });
  const counts: Record<KindFilter, number> = { all: scoped.length, result: 0, progress: 0, blocked: 0, note: 0 };
  for (const report of scoped) counts[report.kind] += 1;
  return counts;
}

export function workspaceOptions(reports: readonly ReportRecord[]): WorkspaceOption[] {
  const counts = new Map<string, number>();
  let none = 0;
  for (const report of reports) {
    if (report.workspace) counts.set(report.workspace, (counts.get(report.workspace) ?? 0) + 1);
    else none += 1;
  }
  const named = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ value: name, label: name, count }));
  return none > 0 ? [...named, { value: NO_WORKSPACE, label: "No workspace", count: none }] : named;
}

export function resolveWorkspace(options: readonly WorkspaceOption[], workspace: string): string {
  return workspace === ALL_WORKSPACES || options.some((option) => option.value === workspace) ? workspace : ALL_WORKSPACES;
}

export function parseStoredReportFilters(raw: string | null): Pick<ReportFilters, "kind" | "workspace"> {
  const fallback = { kind: DEFAULT_REPORT_FILTERS.kind, workspace: DEFAULT_REPORT_FILTERS.workspace };
  if (raw == null) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return fallback;
    const { kind, workspace } = value as Record<string, unknown>;
    return {
      kind: kind === "all" || REPORT_KINDS.some((item) => item === kind) ? (kind as KindFilter) : fallback.kind,
      workspace: typeof workspace === "string" ? workspace : fallback.workspace,
    };
  } catch {
    return fallback;
  }
}

export function reportMeta(report: Pick<ReportRecord, "source" | "sessionId">): string {
  const parts: string[] = [];
  if (report.source) parts.push(report.source);
  if (report.sessionId) parts.push(`session ${report.sessionId.slice(0, 8)}`);
  return parts.join(" · ");
}
