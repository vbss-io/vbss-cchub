import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReportRecord } from "../delegation";
import { Toggletip } from "../components/Toggletip";
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
      <p className="report__text">{report.text}</p>
    </li>
  );
}

function ReportText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const paragraph = useRef<HTMLParagraphElement>(null);
  const textId = useId();

  useLayoutEffect(() => {
    const element = paragraph.current;
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text, expanded]);

  return (
    <>
      <p ref={paragraph} id={textId} className={`rep-card__text ${expanded ? "" : "rep-card__text--clamped"}`}>
        {text}
      </p>
      {(overflowing || expanded) && (
        <button type="button" className="rep-card__more" aria-expanded={expanded} aria-controls={textId} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
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
      <ReportText text={report.text} />
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
      <ul className="reports">
        {shown.map((report) => (
          <ReportCard key={report.id} report={report} onOpenTask={onOpenTask} />
        ))}
        {shown.length === 0 && <li className="empty">{reports.length === 0 ? "No reports yet." : "No reports match these filters."}</li>}
      </ul>
    </div>
  );
}
