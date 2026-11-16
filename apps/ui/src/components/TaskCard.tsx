import type { TaskRecord, TaskStatus } from "../delegation";
import { taskArchivedAt, taskBranch, taskIsolation, taskMergedAt } from "../delegation-actions";
import { IconCode, IconCodex } from "../icons";
import { creatorLabel } from "../routine-model";
import { humanizeDuration, taskInFlight, taskNeedsYou, taskReadyToMerge, taskStatusTone } from "../runs-model";
import { relativeTime } from "../time";
import type { SessionRecord } from "../types";
import type { RetryMode } from "../use-task-detail";
import { CardMenu, useCardMenu, type CardMenuItem } from "./CardMenu";
import type { ClientLabel } from "../clients";
import { CtxMeter, RunFoot, RunMeta, RunStatus, RunWhy, type MetaPart } from "./RunChips";
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
  return { label: `via ${creatorLabel(task.createdBy, task.originClient ?? "mcp")}`, sessionId: null };
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

export function durationLabel(task: TaskRecord): string {
  const end = inFlight(task.status) ? Date.now() : task.updatedAt;
  const label = humanizeDuration(Math.max(0, end - task.createdAt));
  return inFlight(task.status) ? `running ${label}` : label;
}

export const taskStatusLabel = (task: TaskRecord): string => (taskReadyToMerge(task) && taskArchivedAt(task) == null ? "Ready to merge" : TASK_STATUS_LABEL[task.status]);

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
  cost?: string | null;
  costTitle?: string;
  archiveSupported: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onOpenSession: (sessionId: string) => void;
  onCancel: (id: string) => void;
  onArchive: (id: string) => void;
  onRetry: (task: TaskRecord, mode: RetryMode) => void;
  peers?: number;
}

export function TaskCard({ task, origin, runSession, selected, cost = null, costTitle, archiveSupported, busy, peers = 0, onSelect, onOpenSession, onCancel, onArchive, onRetry }: Props) {
  const menu = useCardMenu();
  const isolated = taskIsolation(task) === "worktree";
  const running = inFlight(task.status);
  const archived = taskArchivedAt(task) != null;
  const why = whyOf(task);
  const runnerInfo: ClientLabel = task.runner === "codex" ? { label: "Codex runner", family: "codex", icon: <IconCodex /> } : { label: "Claude runner", family: "claude", icon: <IconCode /> };
  const workspaceLabel = `${task.workspace}${task.repo ? ` / ${task.repo}` : ""}`;
  const worktree = worktreeLabel(task);
  const tone = taskStatusTone(task);
  const context = runSession && typeof runSession.contextTokens === "number" ? runSession.contextTokens : null;
  const pct = context !== null && runSession ? Math.min(100, Math.round((context / contextLimitFor(context, runSession.model)) * 100)) : null;
  const branch = taskBranch(task);
  const metaParts: MetaPart[] = [
    { key: "ws", text: task.repo ?? task.workspace, title: `${workspaceLabel}\n${task.cwd}` },
    ...(worktree ? [{ key: "wt", text: branch ?? "worktree", title: `${worktree}\nWorks in its own git worktree and branch; merge it from the task panel` }] : []),
  ];
  const runs = `${task.runsCount} run${task.runsCount === 1 ? "" : "s"}`;

  const extras: string[] = [
    origin.label,
    ...(task.portBase != null && task.portEnd != null ? [`ports ${task.portBase}–${task.portEnd}`] : []),
    ...(!isolated && peers > 0 ? [`${peers} more here: other live agents work in this folder`] : []),
    ...(runSession ? [`hub session ${runSession.sessionId.slice(0, 8)} · ${runSession.status}`] : []),
  ];

  const menuItems: CardMenuItem[] = [
    { key: "open", label: "Open", onSelect: () => onSelect(task.id) },
    ...(why ? [{ key: "retry", label: why.retry === "autonomous" ? "Retry autonomous" : "Retry", disabled: busy, onSelect: () => onRetry(task, why.retry) }] : []),
    ...(why && why.retry === "autonomous" ? [{ key: "retry-plain", label: "Retry", disabled: busy, onSelect: () => onRetry(task, "plain") }] : []),
    ...(running ? [{ key: "cancel", label: "Cancel", danger: true, disabled: busy, onSelect: () => onCancel(task.id) }] : []),
    ...(!running && !archived && archiveSupported ? [{ key: "archive", label: "Archive", disabled: busy, onSelect: () => onArchive(task.id) }] : []),
    ...(runSession ? [{ key: "session", label: "Open session", onSelect: () => onOpenSession(runSession.sessionId) }] : []),
    ...(origin.sessionId ? [{ key: "origin", label: "Open delegating session", onSelect: () => onOpenSession(origin.sessionId ?? "") }] : []),
  ];

  return (
    <article
      className={`card card--run card--task card--tone-${tone} ${selected ? "card--sel" : ""} ${archived ? "card--archived" : ""} ${task.status === "cancelled" ? "card--task-cancelled" : ""} card--clickable`}
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
        <RunStatus tone={tone} label={taskStatusLabel(task)} />
        <CardMenu menu={menu} items={menuItems} label={`Actions for ${task.title}`} />
      </div>

      <RunMeta client={runnerInfo} parts={metaParts} extras={extras} />

      {why && <RunWhy tone={tone} headline={why.headline} detail={why.detail} />}

      <RunFoot>
        <span className="rc__dur">
          {durationLabel(task)} · {runs}
          {cost !== null && <span title={costTitle}> · {cost}</span>}
        </span>
        {pct !== null && <CtxMeter pct={pct} title={`hub session context ${context?.toLocaleString("en-US") ?? ""} tokens`} />}
        <time className="rc__time">{relativeTime(task.updatedAt)}</time>
      </RunFoot>
    </article>
  );
}
