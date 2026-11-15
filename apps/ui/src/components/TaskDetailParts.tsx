import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { RunRecord } from "../delegation";
import type { WorktreeStatus } from "../delegation-actions";
import { Markdown } from "../markdown";
import { runStatusTone } from "../runs-model";
import { relativeTime } from "../time";
import type { LogLine } from "../use-task-detail";
import { TASK_STATUS_LABEL } from "./TaskCard";
import { LOG_WINDOW, countLines, logWindow } from "../show-more";
import { ClampText, ShowMoreButtons, useShowMore } from "./ShowMore";

export function LiveLog({ lines, running, resetKey = "log" }: { lines: LogLine[]; running: boolean; resetKey?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const fromBottom = useRef<number | null>(null);
  const totalLines = useMemo(() => lines.reduce((sum, line) => sum + countLines(line.text), 0), [lines]);
  const paging = useShowMore(totalLines, resetKey, LOG_WINDOW);
  const shownLines = paging.view.shown;
  const windowed = useMemo(() => logWindow(lines, shownLines).items, [lines, shownLines]);
  const keepPosition = (action: () => void) => () => {
    const element = ref.current;
    if (element) fromBottom.current = element.scrollHeight - element.scrollTop;
    action();
  };
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || fromBottom.current === null) return;
    element.scrollTop = element.scrollHeight - fromBottom.current;
    fromBottom.current = null;
  }, [shownLines]);
  useEffect(() => {
    const element = ref.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [lines]);
  return (
    <div
      className="log"
      ref={ref}
      onScroll={(event) => {
        const element = event.currentTarget;
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
    >
      {lines.length === 0 && <p className="muted">{running ? "Waiting for the first output…" : "No output was captured for this run."}</p>}
      <ShowMoreButtons paging={{ ...paging, more: keepPosition(paging.more), all: keepPosition(paging.all) }} from="end" unit="lines" />
      {windowed.map((line) => (
        <div key={line.key} className={`log__line log__line--${line.kind}`}>
          {line.kind === "tool" && <span className="log__badge">tool</span>}
          {line.kind === "status" && <span className="log__badge log__badge--status">status</span>}
          <span className="log__text">{line.text}</span>
        </div>
      ))}
      {running && <div className="log__cursor" />}
    </div>
  );
}

export function RunCard({ run }: { run: RunRecord }) {
  return (
    <article className="run">
      <header className="run__head">
        <span className="muted">
          #{run.seq} · {run.kind}
        </span>
        <span className={`tag tag--${runStatusTone(run.status)}`} data-status={run.status}>{TASK_STATUS_LABEL[run.status]}</span>
        <span className="chip">{run.runner}</span>
        {run.effectiveModel && <span className="chip">{run.effectiveModel}</span>}
        {run.permissionMode && <span className="chip">{run.permissionMode}</span>}
        <time className="muted run__time">{relativeTime(run.finishedAt ?? run.startedAt)}</time>
      </header>
      <ClampText className="run__prompt" lines={4} scopeKey={`run-prompt:${run.id}`}>
        {run.prompt}
      </ClampText>
      {run.result && (
        <ClampText className="run__result" markdown scopeKey={`run-result:${run.id}`}>
          <Markdown text={run.result} />
        </ClampText>
      )}
      {run.error && (
        <ClampText className="run__error" lines={4} scopeKey={`run-error:${run.id}`}>
          {run.error}
        </ClampText>
      )}
    </article>
  );
}

interface WorktreePanelProps {
  worktree: WorktreeStatus | null;
  busy: boolean;
  running: boolean;
  canMerge: boolean;
  confirmDiscard: boolean;
  onConfirmDiscard: (confirming: boolean) => void;
  onDiscard: () => void;
  onMerge: () => void;
}

export function mergeHint(worktree: WorktreeStatus, running: boolean): string {
  if (running) return "Wait for the run to finish";
  if (worktree.mergedAt !== null) return "Already merged";
  if (worktree.dirty) return "Commit the pending changes first";
  if (worktree.commits.length === 0) return "Nothing to merge";
  return `git merge --no-ff ${worktree.branch} into ${worktree.baseBranch}`;
}

export function WorktreePanel({ worktree, busy, running, canMerge, confirmDiscard, onConfirmDiscard, onDiscard, onMerge }: WorktreePanelProps) {
  if (worktree === null) return <p className="muted">Worktree status unavailable.</p>;
  return (
    <div className="worktree">
      <p className="muted small">
        branch <code>{worktree.branch}</code> from <code>{worktree.baseBranch}</code>
        {worktree.path && !worktree.exists && " · folder removed"}
        {!worktree.path && " · worktree discarded"}
      </p>
      {worktree.hint && worktree.mergedAt === null && <p className="muted small">{worktree.hint}</p>}
      {worktree.mergedAt !== null && (
        <p className="worktree__state worktree__state--ok">
          Merged into {worktree.baseBranch} {relativeTime(worktree.mergedAt)}.{worktree.path ? " Discard the worktree when you no longer need the folder." : ""}
        </p>
      )}
      {worktree.dirty && (
        <p className="worktree__state worktree__state--warn">
          Uncommitted changes in the worktree: the agent did not commit everything. Open the folder and commit, or continue the task asking it to commit.
        </p>
      )}
      {worktree.exists && worktree.commits.length === 0 && worktree.mergedAt === null && <p className="muted">No commits on the branch yet.</p>}
      {worktree.commits.length > 0 && (
        <ul className="worktree__commits">
          {worktree.commits.map((commit) => (
            <li key={commit.sha}>
              <code>{commit.sha.slice(0, 7)}</code> {commit.subject}
            </li>
          ))}
        </ul>
      )}
      {worktree.diffStat && <pre className="worktree__diff">{worktree.diffStat}</pre>}
      <div className="actions">
        {worktree.exists && !confirmDiscard && (
          <button className="act act--danger" disabled={busy || running} onClick={() => onConfirmDiscard(true)}>
            Discard worktree
          </button>
        )}
        {worktree.exists && confirmDiscard && (
          <>
            <span className="muted small">Removes the folder and the branch{worktree.mergedAt === null ? ", losing unmerged work" : ""}.</span>
            <button className="act act--ghost" disabled={busy} onClick={() => onConfirmDiscard(false)}>
              Keep
            </button>
            <button className="act act--danger" disabled={busy || running} onClick={onDiscard}>
              Discard
            </button>
          </>
        )}
        <button className="act act--focus" disabled={busy || !canMerge} title={mergeHint(worktree, running)} onClick={onMerge}>
          Merge into {worktree.baseBranch}
        </button>
      </div>
    </div>
  );
}
