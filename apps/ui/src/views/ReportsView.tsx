import { useState } from "react";
import type { ReportRecord } from "../delegation";
import { relativeTime } from "../time";

type Tone = "go" | "pend" | "hold" | "muted";

const REPORT_TONE: Record<ReportRecord["kind"], Tone> = { progress: "pend", result: "go", blocked: "hold", note: "muted" };
const KINDS: ReportRecord["kind"][] = ["result", "progress", "blocked", "note"];

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

export function ReportsView({ reports, enabled, onOpenTask }: Props) {
  const [kind, setKind] = useState<ReportRecord["kind"] | "all">("all");
  const shown = reports.filter((report) => kind === "all" || report.kind === kind);
  return (
    <div className="view">
      <div className="toolbar">
        <div className="filters">
          <button className={`pill ${kind === "all" ? "pill--on" : ""}`} onClick={() => setKind("all")}>
            All <span className="pill__count">{reports.length}</span>
          </button>
          {KINDS.map((item) => (
            <button key={item} className={`pill ${kind === item ? "pill--on" : ""}`} onClick={() => setKind(item)}>
              {item} <span className="pill__count">{reports.filter((report) => report.kind === item).length}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="hint">
        Everything agents report back through <code>hub_report</code> (Claude Code, Claude Desktop, Codex, the CLI) lands here, and inside the task it belongs to.
      </p>
      {!enabled && <p className="callout">The hub surface is off on this server, so nothing can report yet. See Settings › Hooks and connections.</p>}
      <ul className="reports">
        {shown.map((report) => (
          <ReportRow key={report.id} report={report} onOpenTask={onOpenTask} />
        ))}
        {shown.length === 0 && <li className="empty">No reports yet.</li>}
      </ul>
    </div>
  );
}
