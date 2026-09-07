import { type MouseEvent } from "react";
import type { TaskRecord, TaskStatus } from "../delegation";
import { taskArchivedAt } from "../delegation-actions";
import { IconCode, IconCodex } from "../icons";
import { relativeTime } from "../time";
import type { SessionRecord } from "../types";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Pending",
  running: "Running",
  attention: "Needs you",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

export const inFlight = (status: TaskStatus): boolean => status === "pending" || status === "running";
export const needsYou = (status: TaskStatus): boolean =>
  status === "attention" || status === "failed" || status === "interrupted";

export interface TaskOrigin {
  label: string;
  sessionId: string | null;
}

export function taskOrigin(task: TaskRecord, sessions: Record<string, SessionRecord>): TaskOrigin {
  if (task.originSessionId) {
    const session = sessions[task.originSessionId];
    const name = session ? (session.customTitle ?? session.title ?? task.originSessionId.slice(0, 8)) : task.originSessionId.slice(0, 8);
    return { label: `delegated by ${name}`, sessionId: session ? task.originSessionId : null };
  }
  if (task.originClient === "share") return { label: "via share", sessionId: null };
  return { label: `via ${task.createdBy ?? task.originClient ?? "mcp"}`, sessionId: null };
}

export type RetryMode = "autonomous" | "plain";

export interface TaskWhy {
  headline: string;
  detail: string | null;
  retry: RetryMode;
}

export function whyOf(task: TaskRecord): TaskWhy | null {
  if (task.status === "attention")
    return { headline: "Ran in safe mode and hit a permission it could not grant", detail: task.lastError, retry: "autonomous" };
  if (task.status === "failed") return { headline: "The run failed", detail: task.lastError, retry: "plain" };
  if (task.status === "interrupted") return { headline: "The hub restarted mid-run", detail: task.lastError, retry: "plain" };
  return null;
}

function humanizeDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function durationLabel(task: TaskRecord): string {
  const end = inFlight(task.status) ? Date.now() : task.updatedAt;
  const label = humanizeDuration(Math.max(0, end - task.createdAt));
  return inFlight(task.status) ? `running ${label}` : label;
}

interface Props {
  task: TaskRecord;
  origin: TaskOrigin;
  selected: boolean;
  archiveSupported: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onOpenSession: (sessionId: string) => void;
  onCancel: (id: string) => void;
  onArchive: (id: string) => void;
  onRetry: (task: TaskRecord, mode: RetryMode) => void;
}

export function TaskCard({ task, origin, selected, archiveSupported, busy, onSelect, onOpenSession, onCancel, onArchive, onRetry }: Props) {
  const stop = (event: MouseEvent) => event.stopPropagation();
  const running = inFlight(task.status);
  const archived = taskArchivedAt(task) != null;
  const why = whyOf(task);
  const runnerLabel = task.runner === "codex" ? "Codex" : "Claude";
  const runnerFamily = task.runner === "codex" ? "codex" : "claude";
  const chip = `${task.workspace}${task.repo ? ` / ${task.repo}` : ""}`;

  return (
    <article
      className={`card card--task card--task-${task.status} ${selected ? "card--sel" : ""} ${archived ? "card--archived" : ""} card--clickable`}
      onClick={() => onSelect(task.id)}
    >
      <div className="card__head">
        <span className="card__name" title={task.title}>
          {task.title}
        </span>
        <span className={`tag tag--${task.status}`}>{TASK_STATUS_LABEL[task.status]}</span>
      </div>

      <div className="card__badges">
        <span className={`client client--${runnerFamily}`} title={`${runnerLabel} runner`}>
          {task.runner === "codex" ? <IconCodex /> : <IconCode />}
          <span>{runnerLabel}</span>
        </span>
        <span className="chip chip--ws" title={task.cwd}>
          {chip}
        </span>
        {origin.sessionId ? (
          <button
            className="chip chip--origin chip--link"
            title="Open the session that delegated this"
            onClick={(event) => {
              stop(event);
              onOpenSession(origin.sessionId!);
            }}
          >
            {origin.label}
          </button>
        ) : (
          <span className="chip chip--origin">{origin.label}</span>
        )}
      </div>

      {why && (
        <div className="why" onClick={stop}>
          <span className="why__headline">{why.headline}</span>
          {why.detail && <span className="why__detail">{why.detail}</span>}
          <div className="why__actions">
            <button className="act act--focus" disabled={busy} onClick={() => onRetry(task, why.retry)}>
              {why.retry === "autonomous" ? "Retry autonomous" : "Retry"}
            </button>
            <button
              className="act"
              disabled={busy || !archiveSupported}
              title={archiveSupported ? undefined : "archive arrives with the server update"}
              onClick={() => onArchive(task.id)}
            >
              Archive
            </button>
          </div>
        </div>
      )}

      <div className="card__line">
        <span>started {relativeTime(task.createdAt)}</span>
        <span className="card__dur">{durationLabel(task)}</span>
        <span className="card__folder">
          {task.runsCount} run{task.runsCount === 1 ? "" : "s"}
        </span>
      </div>

      <div className="card__actions">
        <div className="card__open">
          <button
            className="act act--focus"
            onClick={(event) => {
              stop(event);
              onSelect(task.id);
            }}
          >
            Open
          </button>
        </div>
        <div className="card__manage">
          {running && (
            <button className="act act--danger" disabled={busy} onClick={(event) => { stop(event); onCancel(task.id); }}>
              Cancel
            </button>
          )}
          {!running && (
            <button
              className="act"
              disabled={busy || !archiveSupported}
              title={archiveSupported ? undefined : "archive arrives with the server update"}
              onClick={(event) => { stop(event); onArchive(task.id); }}
            >
              Archive
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
