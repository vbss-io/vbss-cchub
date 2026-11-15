import { useEffect, useMemo, useState } from "react";
import type { ReportRecord } from "../delegation";
import { Toggletip } from "../components/Toggletip";
import { ClampText, ShowMoreList } from "../components/ShowMore";
import { IconSearch } from "../icons";
import {
  ALL_WORKSPACES,
  REPORT_KINDS,
  filterReports,
  kindCounts,
  parseStoredReportFilters,
  reportMeta,
  resolveWorkspace,
  workspaceOptions,
  type KindFilter,
} from "../reports-model";
import { relativeTime } from "../time";
import "../reports.css";

type Tone = "go" | "pend" | "hold" | "muted";

const REPORT_TONE: Record<ReportRecord["kind"], Tone> = { progress: "pend", result: "go", blocked: "hold", note: "muted" };
const KIND_CHIPS: readonly KindFilter[] = ["all", ...REPORT_KINDS];
const STORAGE_KEY = "hub.reports.filters";

function readStoredFilters(): ReturnType<typeof parseStoredReportFilters> {
  try {
    return parseStoredReportFilters(localStorage.getItem(STORAGE_KEY));
  } catch {
    return parseStoredReportFilters(null);
  }
}

function storeFilters(kind: KindFilter, workspace: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ kind, workspace }));
  } catch {
    return;
  }
}

interface Props {
  reports: ReportRecord[];
  enabled: boolean;
  onOpenTask: (taskId: string) => void;
}

export function ReportRow({ report, onOpenTask }: { report: ReportRecord; onOpenTask?: (taskId: string) => void }) {
  return (
    <li className="report">
      <header className="report__head">
        <span className={`tag tag--${REPORT_TONE[report.kind]}`}>{report.kind}</span>
        {report.source && <span className="chip">{report.source}</span>}
        {report.workspace && <span className="chip chip--ws">{report.workspace}</span>}
        {report.taskId && onOpenTask && (
          <button className="act act--ghost" onClick={() => onOpenTask(report.taskId ?? "")}>
            task {report.taskId.slice(0, 8)}
          </button>
        )}
        {report.sessionId && <span className="muted">session {report.sessionId.slice(0, 8)}</span>}
        <time className="report__time">{relativeTime(report.createdAt)}</time>
      </header>
      <ClampText className="report__text" scopeKey={`report:${report.id}`}>
        {report.text}
      </ClampText>
    </li>
  );
}

function ReportCard({ report, onOpenTask }: { report: ReportRecord; onOpenTask: (taskId: string) => void }) {
  const meta = reportMeta(report);
  return (
    <li className="rep-card">
      <header className="rep-card__head">
        <span className={`tag tag--${REPORT_TONE[report.kind]}`}>{report.kind}</span>
        {report.workspace && <span className="chip chip--ws">{report.workspace}</span>}
        {report.taskId && (
          <button type="button" className="act act--ghost" onClick={() => onOpenTask(report.taskId ?? "")}>
            task {report.taskId.slice(0, 8)}
          </button>
        )}
        <time className="rep-card__time">{relativeTime(report.createdAt)}</time>
      </header>
      <ClampText className="rep-card__text" lines={2}>
        {report.text}
      </ClampText>
      {meta && <span className="rep-card__meta">{meta}</span>}
    </li>
  );
}

export function ReportsView({ reports, enabled, onOpenTask }: Props) {
  const [stored] = useState(readStoredFilters);
  const [kind, setKind] = useState<KindFilter>(stored.kind);
  const [workspaceChoice, setWorkspaceChoice] = useState(stored.workspace);
  const [query, setQuery] = useState("");
  const options = useMemo(() => workspaceOptions(reports), [reports]);
  const workspace = resolveWorkspace(options, workspaceChoice);
  const filters = { kind, workspace, query };
  const counts = kindCounts(reports, filters);
  const shown = filterReports(reports, filters);

  useEffect(() => {
    storeFilters(kind, workspace);
  }, [kind, workspace]);

  return (
    <div className="view reports-view">
      <div className="rep-bar">
        <div className="filters" role="group" aria-label="Report kind">
          {KIND_CHIPS.map((item) => (
            <button key={item} type="button" className={`pill ${kind === item ? "pill--on" : ""}`} aria-pressed={kind === item} onClick={() => setKind(item)}>
              {item === "all" ? "All" : item} <span className="pill__count">{counts[item]}</span>
            </button>
          ))}
        </div>
        <div className="rep-bar__right">
          <select className="select rep-bar__ws" aria-label="Workspace" value={workspace} onChange={(event) => setWorkspaceChoice(event.target.value)}>
            <option value={ALL_WORKSPACES}>All workspaces ({reports.length})</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} ({option.count})
              </option>
            ))}
          </select>
          <label className="search rep-bar__search">
            <IconSearch />
            <input className="in" aria-label="Search reports" placeholder="search reports" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <Toggletip label="About reports" align="end">
            Everything agents report back through <code>hub_report</code> (Claude Code, Claude Desktop, Codex, the CLI) lands here, and inside the task it belongs to.
          </Toggletip>
        </div>
      </div>
      {!enabled && <p className="callout">The hub surface is off on this server, so nothing can report yet. See Settings › Hooks and connections.</p>}
      <ShowMoreList
        items={shown}
        resetKey={`${kind}|${workspace}|${query}`}
        noun="reports"
        wrap={(rows) => (
          <ul className="reports">
            {rows}
            {shown.length === 0 && <li className="empty">{reports.length === 0 ? "No reports yet." : "No reports match these filters."}</li>}
          </ul>
        )}
        render={(report) => <ReportCard key={report.id} report={report} onOpenTask={onOpenTask} />}
      />
    </div>
  );
}
