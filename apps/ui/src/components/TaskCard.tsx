import type { TaskRecord, TaskStatus } from "../delegation";
import { taskArchivedAt, taskBranch, taskIsolation, taskMergedAt } from "../delegation-actions";
import { IconCode, IconCodex } from "../icons";
import { taskInFlight, taskNeedsYou, taskReadyToMerge } from "../runs-model";
import { relativeTime } from "../time";
import type { SessionRecord } from "../types";
import type { RetryMode } from "../use-task-detail";
import { CardMenu, useCardMenu, type CardMenuItem } from "./CardMenu";
import { MoreChip } from "./RunChips";
import { contextLimitFor } from "./SessionCard";

export type { RetryMode };

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Pending",
  running: "Running",
  attention: "Needs you",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

export const inFlight = taskInFlight;
export const needsYou = taskNeedsYou;

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

export function durationLabel(task: TaskRecord): string {
  const end = inFlight(task.status) ? Date.now() : task.updatedAt;
  const label = humanizeDuration(Math.max(0, end - task.createdAt));
  return inFlight(task.status) ? `running ${label}` : label;
}

export function worktreeLabel(task: TaskRecord): string | null {
  if (taskIsolation(task) !== "worktree") return null;
  const branch = taskBranch(task);
  const base = taskMergedAt(task) != null ? "merged" : task.isolationReason === "busy-repo" ? "worktree · auto" : "worktree";
  return branch ? `${base} · ${branch}` : base;
}

interface Props {
  task: TaskRecord;
  origin: TaskOrigin;
  runSession: SessionRecord | null;
  selected: boolean;
  archiveSupported: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onOpenSession: (sessionId: string) => void;
  onCancel: (id: string) => void;
  onArchive: (id: string) => void;
  onRetry: (task: TaskRecord, mode: RetryMode) => void;
  peers?: number;
}

export function TaskCard({ task, origin, runSession, selected, archiveSupported, busy, peers = 0, onSelect, onOpenSession, onCancel, onArchive, onRetry }: Props) {
  const menu = useCardMenu();
  const isolated = taskIsolation(task) === "worktree";
  const running = inFlight(task.status);
  const archived = taskArchivedAt(task) != null;
  const why = whyOf(task);
  const runnerLabel = task.runner === "codex" ? "Codex" : "Claude";
  const runnerFamily = task.runner === "codex" ? "codex" : "claude";
  const workspaceLabel = `${task.workspace}${task.repo ? ` / ${task.repo}` : ""}`;
  const worktree = worktreeLabel(task);
  const ready = taskReadyToMerge(task);
  const context = runSession && typeof runSession.contextTokens === "number" ? runSession.contextTokens : null;
  const pct = context !== null && runSession ? Math.min(100, Math.round((context / contextLimitFor(context, runSession.model)) * 100)) : null;

  const extras: string[] = [
    origin.label,
    `${task.runsCount} run${task.runsCount === 1 ? "" : "s"}`,
    ...(task.portBase != null && task.portEnd != null ? [`ports ${task.portBase}–${task.portEnd}`] : []),
    ...(!isolated && peers > 0 ? [`${peers} more here: other live agents work in this folder`] : []),
    ...(runSession ? [`hub session ${runSession.sessionId.slice(0, 8)} · ${runSession.status}`] : []),
  ];

  const menuItems: CardMenuItem[] = [
    { key: "open", label: "Open", onSelect: () => onSelect(task.id) },
    ...(why ? [{ key: "retry", label: why.retry === "autonomous" ? "Retry autonomous" : "Retry", onSelect: () => onRetry(task, why.retry) }] : []),
    ...(why && why.retry === "autonomous" ? [{ key: "retry-plain", label: "Retry", onSelect: () => onRetry(task, "plain") }] : []),
    ...(running ? [{ key: "cancel", label: "Cancel", danger: true, onSelect: () => onCancel(task.id) }] : []),
    ...(!running && !archived && archiveSupported ? [{ key: "archive", label: "Archive", onSelect: () => onArchive(task.id) }] : []),
    ...(runSession ? [{ key: "session", label: "Open session", onSelect: () => onOpenSession(runSession.sessionId) }] : []),
    ...(origin.sessionId ? [{ key: "origin", label: "Open delegating session", onSelect: () => onOpenSession(origin.sessionId ?? "") }] : []),
  ];

  return (
    <article
      className={`card card--task card--task-${task.status} ${selected ? "card--sel" : ""} ${archived ? "card--archived" : ""} card--clickable`}
      onClick={() => onSelect(task.id)}
      aria-busy={busy}
      onContextMenu={(event) => {
        event.preventDefault();
        menu.openAt(event.clientX, event.clientY);
      }}
    >
      <div className="card__head">
        <span className="card__name" title={task.title}>
          {task.title}
        </span>
        <span className={`tag tag--${ready ? "unread" : task.status}`}>{ready ? "Ready to merge" : TASK_STATUS_LABEL[task.status]}</span>
        <CardMenu menu={menu} items={menuItems} label={`Actions for ${task.title}`} />
      </div>

      <div className="card__badges">
        <span className={`client client--${runnerFamily}`} title={`${runnerLabel} runner`}>
          {task.runner === "codex" ? <IconCodex /> : <IconCode />}
          <span>{runnerLabel}</span>
        </span>
        <span className="chip chip--ws" title={task.cwd}>
          {workspaceLabel}
        </span>
        {worktree && (
          <span className={`chip chip--worktree ${taskMergedAt(task) != null ? "chip--worktree-merged" : ""}`} title="Works in its own git worktree and branch; merge it from the task panel">
            {worktree}
          </span>
        )}
        <MoreChip extras={extras} />
      </div>

      {why && (
        <div className="why why--compact">
          <span className="why__headline">{why.headline}</span>
          {why.detail && <span className="why__detail">{why.detail}</span>}
        </div>
      )}

      <div className="card__line">
        <span className="card__dur">{durationLabel(task)}</span>
        {pct !== null && (
          <span className="card__ctx" title={`hub session context ${context?.toLocaleString("en-US") ?? ""} tokens`}>
            ctx {pct}%
          </span>
        )}
        <time>{relativeTime(task.updatedAt)}</time>
      </div>
    </article>
  );
}
