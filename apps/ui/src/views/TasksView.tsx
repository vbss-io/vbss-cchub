import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelTask,
  continueTask,
  getTask,
  getTaskEvents,
  type RunEventRecord,
  type RunRecord,
  type TaskDetail,
  type TaskRecord,
  type TaskStatus,
} from "../delegation";
import {
  archiveTask,
  discardTaskWorktree,
  getTaskWorktree,
  listArchivedTasks,
  mergeTaskWorktree,
  probeArchiveSupport,
  retryTask,
  taskArchivedAt,
  taskIsolation,
  unarchiveTask,
  type WorktreeStatus,
} from "../delegation-actions";
import { folderPeers } from "../peers";
import { inFlight, needsYou, TASK_STATUS_LABEL, TaskCard, taskOrigin, whyOf, type RetryMode } from "../components/TaskCard";
import { relativeTime } from "../time";
import type { RunEventMessage, SessionRecord } from "../types";
import { Markdown } from "../markdown";
import { ReportRow } from "./ReportsView";

const STATUS_TONE: Record<TaskStatus, string> = {
  pending: "pend",
  running: "pend",
  attention: "pend",
  completed: "go",
  failed: "hold",
  interrupted: "hold",
  cancelled: "muted",
};

type Filter = "active" | "running" | "attention" | "done" | "all" | "archived";

const DAY = 24 * 3_600_000;
const isActive = (status: TaskStatus): boolean => inFlight(status) || needsYou(status);
const isDone = (status: TaskStatus): boolean => status === "completed" || status === "cancelled";

interface LogLine {
  key: string;
  kind: RunEventRecord["kind"];
  text: string;
}

function LiveLog({ lines, running }: { lines: LogLine[]; running: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
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
      {lines.map((line) => (
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

function RunCard({ run }: { run: RunRecord }) {
  return (
    <article className="run">
      <header className="run__head">
        <span className="muted">
          #{run.seq} · {run.kind}
        </span>
        <span className={`tag tag--${STATUS_TONE[run.status]} tag--${run.status}`}>{TASK_STATUS_LABEL[run.status]}</span>
        <span className="chip">{run.runner}</span>
        {run.effectiveModel && <span className="chip">{run.effectiveModel}</span>}
        {run.permissionMode && <span className="chip">{run.permissionMode}</span>}
        <time className="muted run__time">{relativeTime(run.finishedAt ?? run.startedAt)}</time>
      </header>
      <p className="run__prompt">{run.prompt}</p>
      {run.result && (
        <div className="run__result">
          <Markdown text={run.result} />
        </div>
      )}
      {run.error && <p className="run__error">{run.error}</p>}
    </article>
  );
}

interface Props {
  tasks: TaskRecord[];
  sessions: Record<string, SessionRecord>;
  enabled: boolean;
  selectedId: string | null;
  tick: number;
  onSelect: (taskId: string | null) => void;
  onOpenSession: (sessionId: string) => void;
  subscribeRunEvents: (listener: (event: RunEventMessage) => void) => () => void;
  onRefresh: () => Promise<void>;
  onOpenSettings: () => void;
  onError: (text: string) => void;
}

export function TasksView({ tasks, sessions, enabled, selectedId, tick, onSelect, onOpenSession, subscribeRunEvents, onRefresh, onOpenSettings, onError }: Props) {
  const [filter, setFilter] = useState<Filter>("active");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<RunEventRecord[]>([]);
  const [liveText, setLiveText] = useState<{ runId: string; lines: LogLine[] } | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [showContinue, setShowContinue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [archived, setArchived] = useState<TaskRecord[]>([]);
  const [archiveSupported, setArchiveSupported] = useState(true);
  const [worktree, setWorktree] = useState<WorktreeStatus | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const loadDetail = useCallback(async (id: string) => {
    const [nextDetail, nextEvents] = await Promise.all([getTask(id), getTaskEvents(id)]);
    setDetail(nextDetail);
    setEvents(nextEvents);
    setConfirmDiscard(false);
    if (taskIsolation(nextDetail.task) === "worktree") {
      setWorktree(await getTaskWorktree(id).catch(() => null));
    } else {
      setWorktree(null);
    }
    setLiveText(null);
    setShowContinue(false);
    setFollowUp("");
  }, []);

  useEffect(() => {
    void probeArchiveSupport().then(setArchiveSupported);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void listArchivedTasks()
      .then(setArchived)
      .catch(() => setArchived([]));
  }, [enabled, tick]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setEvents([]);
      setLiveText(null);
      return;
    }
    let mounted = true;
    loadDetail(selectedId).catch((err: unknown) => {
      if (mounted) onError(err instanceof Error ? err.message : "failed to load task");
    });
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, tick]);

  useEffect(() => {
    if (!selectedId) return;
    return subscribeRunEvents((event) => {
      if (event.taskId !== selectedId) return;
      setLiveText((current) => {
        const lines = current && current.runId === event.runId ? [...current.lines] : [];
        const last = lines[lines.length - 1];
        if (event.kind === "text" && last && last.kind === "text") {
          lines[lines.length - 1] = { ...last, text: last.text + event.text };
        } else {
          lines.push({ key: `${event.runId}-${lines.length}`, kind: event.kind, text: event.text });
        }
        return { runId: event.runId, lines };
      });
    });
  }, [selectedId, subscribeRunEvents]);

  const live = useMemo(() => tasks.filter((task) => taskArchivedAt(task) == null), [tasks]);
  const counts = useMemo(() => {
    const running = live.filter((task) => inFlight(task.status)).length;
    const needYou = live.filter((task) => needsYou(task.status)).length;
    const doneToday = live.filter((task) => task.status === "completed" && Date.now() - task.updatedAt < DAY).length;
    const failed = live.filter((task) => task.status === "failed").length;
    return { running, needYou, doneToday, failed };
  }, [live]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const source = filter === "archived" ? archived : live;
    const matchesQuery = (task: TaskRecord): boolean =>
      needle.length === 0 || `${task.title} ${task.workspace} ${task.repo ?? ""}`.toLowerCase().includes(needle);
    return source.filter((task) => {
      if (!matchesQuery(task)) return false;
      if (filter === "active") return isActive(task.status);
      if (filter === "running") return inFlight(task.status);
      if (filter === "attention") return needsYou(task.status);
      if (filter === "done") return isDone(task.status);
      return true;
    });
  }, [filter, query, live, archived]);

  const running = detail ? inFlight(detail.task.status) : false;
  const detailArchived = detail ? taskArchivedAt(detail.task) != null : false;
  const detailWhy = detail ? whyOf(detail.task) : null;
  const lastRun = detail?.runs[detail.runs.length - 1] ?? null;
  const logLines = useMemo<LogLine[]>(() => {
    if (liveText && lastRun && liveText.runId === lastRun.id) return liveText.lines;
    if (!lastRun) return [];
    return events.filter((event) => event.runId === lastRun.id).map((event) => ({ key: String(event.id), kind: event.kind, text: event.text }));
  }, [liveText, events, lastRun]);

  const act = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
        await onRefresh();
        if (selectedId) await loadDetail(selectedId);
      } catch (err) {
        onError(err instanceof Error ? err.message : "action failed");
      } finally {
        setBusy(false);
      }
    },
    [onRefresh, selectedId, loadDetail, onError],
  );

  const doArchive = useCallback((id: string) => void act(async () => await archiveTask(id)), [act]);
  const doUnarchive = useCallback((id: string) => void act(async () => await unarchiveTask(id)), [act]);
  const doCancel = useCallback((id: string) => void act(async () => void (await cancelTask(id))), [act]);
  const doMerge = useCallback((id: string) => void act(async () => await mergeTaskWorktree(id)), [act]);
  const doDiscard = useCallback((id: string) => void act(async () => await discardTaskWorktree(id)), [act]);
  const doRetry = useCallback(
    (task: TaskRecord, mode: RetryMode) => void act(async () => await retryTask(task.id, mode === "autonomous" ? "bypassPermissions" : null)),
    [act],
  );

  const filters: { key: Filter; label: string; count: number }[] = [
    { key: "active", label: "Active", count: live.filter((task) => isActive(task.status)).length },
    { key: "running", label: "Running", count: counts.running },
    { key: "attention", label: "Needs you", count: counts.needYou },
    { key: "done", label: "Done", count: live.filter((task) => isDone(task.status)).length },
    { key: "all", label: "All", count: live.length },
    { key: "archived", label: "Archived", count: archived.length },
  ];

  const detailOrigin = detail ? taskOrigin(detail.task, sessions) : null;
  const sessionList = useMemo(() => Object.values(sessions), [sessions]);
  const peersOf = useCallback((task: TaskRecord) => folderPeers(task.cwd, sessionList, live, { taskId: task.id }), [sessionList, live]);
  const canMerge = worktree !== null && worktree.exists && !worktree.dirty && worktree.commits.length > 0 && worktree.mergedAt === null && !running;

  return (
    <div className="view view--split view--tasks">
      <section className="pane pane--list">
        <p className="tasks__summary">
          <strong>{counts.running}</strong> running · <strong>{counts.needYou}</strong> need you · <strong>{counts.doneToday}</strong> done today ·{" "}
          <strong>{counts.failed}</strong> failed
        </p>
        <div className="filters filters--tight">
          {filters.map((item) => (
            <button key={item.key} className={`pill ${filter === item.key ? "pill--on" : ""}`} onClick={() => setFilter(item.key)}>
              {item.label}
              <span className="pill__count">{item.count}</span>
            </button>
          ))}
        </div>
        <input className="in" placeholder="search title or workspace" value={query} onChange={(event) => setQuery(event.target.value)} />

        {!enabled && <p className="callout">The hub surface is off on this server. See Settings › Hooks and connections.</p>}
        {enabled && tasks.length === 0 && (
          <p className="callout">
            Nothing delegated yet. Any connected agent can hand work to the hub with <code>hub_delegate</code> (Claude Code, Claude Desktop, Codex).{" "}
            <button className="link" onClick={onOpenSettings}>
              Connect the clients
            </button>
            .
          </p>
        )}

        <div className="taskcards">
          {shown.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              origin={taskOrigin(task, sessions)}
              selected={selectedId === task.id}
              archiveSupported={archiveSupported}
              busy={busy}
              peers={peersOf(task)}
              onSelect={onSelect}
              onOpenSession={onOpenSession}
              onCancel={doCancel}
              onArchive={doArchive}
              onRetry={doRetry}
            />
          ))}
          {enabled && shown.length === 0 && <p className="empty">Nothing in this filter.</p>}
        </div>
      </section>

      <section className="pane pane--detail">
        {!detail && <p className="empty">Select a task to see what it is doing.</p>}
        {detail && (
          <>
            <header className="detail__head">
              <div>
                <h2>{detail.task.title}</h2>
                <p className="muted small">
                  {detail.task.workspace}
                  {detail.task.repo ? ` / ${detail.task.repo}` : ""} · {detail.task.runner} · runs in <span className="path">{detail.task.cwd}</span>
                  {detail.task.addDirs.length > 0 ? ` (+${detail.task.addDirs.length} repos attached)` : ""}
                </p>
                {detailOrigin && (
                  <p className="muted small">
                    {detailOrigin.sessionId ? (
                      <button className="link" onClick={() => onOpenSession(detailOrigin.sessionId!)}>
                        {detailOrigin.label}
                      </button>
                    ) : (
                      detailOrigin.label
                    )}
                  </p>
                )}
              </div>
              <span className={`tag tag--${detail.task.status}`}>{TASK_STATUS_LABEL[detail.task.status]}</span>
            </header>

            {detailWhy && (
              <div className="why why--pane">
                <span className="why__headline">{detailWhy.headline}</span>
                {detailWhy.detail && <span className="why__detail">{detailWhy.detail}</span>}
                <div className="why__actions">
                  <button className="act act--focus" disabled={busy} onClick={() => doRetry(detail.task, detailWhy.retry)}>
                    {detailWhy.retry === "autonomous" ? "Retry autonomous" : "Retry"}
                  </button>
                  <button
                    className="act"
                    disabled={busy || !archiveSupported}
                    title={archiveSupported ? undefined : "archive arrives with the server update"}
                    onClick={() => doArchive(detail.task.id)}
                  >
                    Archive
                  </button>
                </div>
              </div>
            )}

            <div className="detail__actionbar">
              {!showContinue && (
                <button className="act" disabled={running} onClick={() => setShowContinue(true)}>
                  Continue
                </button>
              )}
              {running && (
                <button className="act act--danger" disabled={busy} onClick={() => doCancel(detail.task.id)}>
                  Cancel
                </button>
              )}
              {detailArchived ? (
                <button className="act" disabled={busy} onClick={() => doUnarchive(detail.task.id)}>
                  Unarchive
                </button>
              ) : (
                <button
                  className="act"
                  disabled={busy || running || !archiveSupported}
                  title={archiveSupported ? undefined : "archive arrives with the server update"}
                  onClick={() => doArchive(detail.task.id)}
                >
                  Archive
                </button>
              )}
              {detail.task.sessionId && (
                <button className="act" onClick={() => onOpenSession(detail.task.sessionId!)}>
                  Open session
                </button>
              )}
            </div>

            {showContinue && (
              <section className="panel">
                <h3>Continue</h3>
                <textarea
                  className="in area"
                  autoFocus
                  placeholder={running ? "running… wait for it to finish" : "send a follow-up into the same session"}
                  value={followUp}
                  onChange={(event) => setFollowUp(event.target.value)}
                  disabled={running}
                />
                <div className="actions">
                  <button className="act act--ghost" onClick={() => { setShowContinue(false); setFollowUp(""); }}>
                    Cancel
                  </button>
                  <button
                    className="act act--focus"
                    disabled={busy || running || followUp.trim().length === 0}
                    onClick={() =>
                      void act(async () => {
                        await continueTask(detail.task.id, { prompt: followUp.trim() });
                        setFollowUp("");
                        setShowContinue(false);
                      })
                    }
                  >
                    Send
                  </button>
                </div>
              </section>
            )}

            {taskIsolation(detail.task) === "worktree" && (
              <section className="panel worktree">
                <h3>Worktree</h3>
                {worktree === null && <p className="muted">Worktree status unavailable.</p>}
                {worktree && (
                  <>
                    <p className="muted small">
                      branch <code>{worktree.branch}</code> from <code>{worktree.baseBranch}</code>
                      {worktree.path && <> · <span className="path">{worktree.path}</span></>}
                      {worktree.path && !worktree.exists && " · folder removed"}
                      {!worktree.path && " · worktree discarded"}
                    </p>
                    {worktree.hint && worktree.mergedAt === null && <p className="muted small">{worktree.hint}</p>}
                    {worktree.mergedAt !== null && (
                      <p className="worktree__state worktree__state--ok">
                        Merged into {worktree.baseBranch} {relativeTime(worktree.mergedAt)}.{worktree.path ? " Discard the worktree when you no longer need the folder." : ""}
                      </p>
                    )}
                    {worktree.dirty && <p className="worktree__state worktree__state--warn">Uncommitted changes in the worktree: the agent did not commit everything. Open the folder and commit, or continue the task asking it to commit.</p>}
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
                        <button className="act act--danger" disabled={busy || running} onClick={() => setConfirmDiscard(true)}>
                          Discard worktree
                        </button>
                      )}
                      {worktree.exists && confirmDiscard && (
                        <>
                          <span className="muted small">Removes the folder and the branch{worktree.mergedAt === null ? ", losing unmerged work" : ""}.</span>
                          <button className="act act--ghost" disabled={busy} onClick={() => setConfirmDiscard(false)}>
                            Keep
                          </button>
                          <button className="act act--danger" disabled={busy} onClick={() => doDiscard(detail.task.id)}>
                            Discard
                          </button>
                        </>
                      )}
                      <button
                        className="act act--focus"
                        disabled={busy || !canMerge}
                        title={
                          running
                            ? "Wait for the run to finish"
                            : worktree.mergedAt !== null
                              ? "Already merged"
                              : worktree.dirty
                                ? "Commit the pending changes first"
                                : worktree.commits.length === 0
                                  ? "Nothing to merge"
                                  : `git merge --no-ff ${worktree.branch} into ${worktree.baseBranch}`
                        }
                        onClick={() => doMerge(detail.task.id)}
                      >
                        Merge into {worktree.baseBranch}
                      </button>
                    </div>
                  </>
                )}
              </section>
            )}

            <details className="panel askbox">
              <summary>What was asked</summary>
              <div className="askbox__body">
                <Markdown text={detail.task.prompt} />
              </div>
            </details>

            {running && (
              <section className="panel">
                <h3>Live output</h3>
                <LiveLog lines={logLines} running={running} />
              </section>
            )}

            <section className="panel">
              <h3>Runs</h3>
              <div className="runs">
                {detail.runs.map((run) => (
                  <RunCard key={run.id} run={run} />
                ))}
                {detail.runs.length === 0 && <p className="muted">No runs recorded yet.</p>}
              </div>
            </section>

            {detail.reports.length > 0 && (
              <section className="panel">
                <h3>Reports</h3>
                <ul className="reports">
                  {detail.reports.map((report) => (
                    <ReportRow key={report.id} report={report} />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </section>
    </div>
  );
}
