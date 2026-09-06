import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelTask,
  continueTask,
  createReport,
  getTask,
  getTaskEvents,
  type RunEventRecord,
  type RunRecord,
  type TaskDetail,
  type TaskRecord,
  type TaskStatus,
} from "../delegation";
import { relativeTime } from "../time";
import type { RunEventMessage } from "../types";
import { ReportRow } from "./ReportsView";

type Tone = "go" | "pend" | "hold" | "muted";

const STATUS_TONE: Record<TaskStatus, Tone> = {
  pending: "pend",
  running: "pend",
  attention: "pend",
  completed: "go",
  failed: "hold",
  interrupted: "hold",
  cancelled: "muted",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Pending",
  running: "Running",
  attention: "Needs you",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

type Filter = "all" | "live" | "attention" | "done";

const inFlight = (status: TaskStatus): boolean => status === "pending" || status === "running";
const needsYou = (status: TaskStatus): boolean => status === "attention" || status === "failed" || status === "interrupted";

const cliSnippet = (taskId: string): string =>
  `echo '${JSON.stringify({ action: "continue", taskId, prompt: "..." })}' | node apps/server/dist/cli.js`;

const copyText = (text: string): void => {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
};

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
        <span className={`tag tag--${STATUS_TONE[run.status]} tag--${run.status}`}>{STATUS_LABEL[run.status]}</span>
        <span className="chip">{run.runner}</span>
        {run.effectiveModel && <span className="chip">{run.effectiveModel}</span>}
        {run.permissionMode && <span className="chip">{run.permissionMode}</span>}
        <time className="muted run__time">{relativeTime(run.finishedAt ?? run.startedAt)}</time>
      </header>
      <p className="run__prompt">{run.prompt}</p>
      {run.result && <pre className="run__result">{run.result}</pre>}
      {run.error && <p className="run__error">{run.error}</p>}
    </article>
  );
}

interface Props {
  tasks: TaskRecord[];
  enabled: boolean;
  selectedId: string | null;
  tick: number;
  onSelect: (taskId: string | null) => void;
  subscribeRunEvents: (listener: (event: RunEventMessage) => void) => () => void;
  onRefresh: () => Promise<void>;
  onOpenSettings: () => void;
  onError: (text: string) => void;
}

export function TasksView({ tasks, enabled, selectedId, tick, onSelect, subscribeRunEvents, onRefresh, onOpenSettings, onError }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<RunEventRecord[]>([]);
  const [liveText, setLiveText] = useState<{ runId: string; lines: LogLine[] } | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const loadDetail = useCallback(async (id: string) => {
    const [nextDetail, nextEvents] = await Promise.all([getTask(id), getTaskEvents(id)]);
    setDetail(nextDetail);
    setEvents(nextEvents);
    setLiveText(null);
  }, []);

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

  const shown = useMemo(
    () =>
      tasks.filter((task) => {
        if (filter === "live") return inFlight(task.status);
        if (filter === "attention") return needsYou(task.status);
        if (filter === "done") return task.status === "completed" || task.status === "cancelled";
        return true;
      }),
    [tasks, filter],
  );

  const running = detail ? inFlight(detail.task.status) : false;
  const lastRun = detail?.runs[detail.runs.length - 1] ?? null;
  const logLines = useMemo<LogLine[]>(() => {
    if (liveText && lastRun && liveText.runId === lastRun.id) return liveText.lines;
    if (!lastRun) return [];
    return events.filter((event) => event.runId === lastRun.id).map((event) => ({ key: String(event.id), kind: event.kind, text: event.text }));
  }, [liveText, events, lastRun]);

  const act = async (action: () => Promise<void>) => {
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
  };

  return (
    <div className="view view--split">
      <section className="pane pane--list">
        <div className="filters filters--tight">
          {(["all", "live", "attention", "done"] as Filter[]).map((item) => (
            <button key={item} className={`pill ${filter === item ? "pill--on" : ""}`} onClick={() => setFilter(item)}>
              {item === "all" ? "All" : item === "live" ? "Running" : item === "attention" ? "Needs you" : "Done"}
              <span className="pill__count">
                {item === "all" ? tasks.length : item === "live" ? tasks.filter((t) => inFlight(t.status)).length : item === "attention" ? tasks.filter((t) => needsYou(t.status)).length : tasks.filter((t) => t.status === "completed" || t.status === "cancelled").length}
              </span>
            </button>
          ))}
        </div>
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
        <ul className="tasklist">
          {shown.map((task) => (
            <li key={task.id}>
              <button className={`taskrow ${selectedId === task.id ? "taskrow--on" : ""}`} onClick={() => onSelect(task.id)}>
                <span className="taskrow__title">{task.title}</span>
                <span className="taskrow__meta">
                  {task.workspace}
                  {task.repo ? `/${task.repo}` : ""} · {task.runner}
                  {task.createdBy ? ` · via ${task.createdBy}` : ""}
                </span>
                <span className="taskrow__foot">
                  <span className={`tag tag--${STATUS_TONE[task.status]} tag--${task.status}`}>{STATUS_LABEL[task.status]}</span>
                  <time className="muted">{relativeTime(task.updatedAt)}</time>
                </span>
                {needsYou(task.status) && task.lastError && <span className="taskrow__error">{task.lastError}</span>}
              </button>
            </li>
          ))}
          {enabled && tasks.length > 0 && shown.length === 0 && <li className="empty">Nothing in this filter.</li>}
        </ul>
      </section>

      <section className="pane pane--detail">
        {!detail && <p className="empty">Select a task to follow it.</p>}
        {detail && (
          <>
            <header className="detail__head">
              <div>
                <h2>{detail.task.title}</h2>
                <p className="muted small">
                  {detail.task.workspace}
                  {detail.task.repo ? ` / ${detail.task.repo}` : ""} · {detail.task.runner}
                  {detail.task.createdBy ? ` · via ${detail.task.createdBy}` : ""} · runs in <span className="path">{detail.task.cwd}</span>
                  {detail.task.addDirs.length > 0 ? ` (+${detail.task.addDirs.length} repos attached)` : ""}
                </p>
              </div>
              <div className="detail__actions">
                <span className={`tag tag--${STATUS_TONE[detail.task.status]} tag--${detail.task.status}`}>{STATUS_LABEL[detail.task.status]}</span>
                {running && (
                  <button className="act act--danger" disabled={busy} onClick={() => void act(async () => void (await cancelTask(detail.task.id)))}>
                    Cancel run
                  </button>
                )}
              </div>
            </header>

            <section className="panel">
              <h3>{running ? "Live output" : "Last run output"}</h3>
              <LiveLog lines={logLines} running={running} />
            </section>

            <section className="panel">
              <h3>Continue</h3>
              <textarea
                className="in area"
                placeholder={running ? "running… wait for it to finish" : "send a follow-up into the same session"}
                value={followUp}
                onChange={(event) => setFollowUp(event.target.value)}
                disabled={running}
              />
              <div className="actions">
                <button
                  className="act act--focus"
                  disabled={busy || running || followUp.trim().length === 0}
                  onClick={() =>
                    void act(async () => {
                      await continueTask(detail.task.id, { prompt: followUp.trim() });
                      setFollowUp("");
                    })
                  }
                >
                  Continue
                </button>
              </div>
            </section>

            <section className="panel">
              <h3>Runs</h3>
              <div className="runs">
                {detail.runs.map((run) => (
                  <RunCard key={run.id} run={run} />
                ))}
              </div>
            </section>

            <section className="panel">
              <h3>Reports and notes</h3>
              <ul className="reports">
                {detail.reports.map((report) => (
                  <ReportRow key={report.id} report={report} />
                ))}
                {detail.reports.length === 0 && <li className="muted">No reports on this task yet.</li>}
              </ul>
              <div className="row">
                <input className="in" placeholder="leave a note on this task" value={note} onChange={(event) => setNote(event.target.value)} />
                <button
                  className="act"
                  disabled={busy || note.trim().length === 0}
                  onClick={() =>
                    void act(async () => {
                      await createReport({ text: note.trim(), kind: "note", taskId: detail.task.id });
                      setNote("");
                    })
                  }
                >
                  Note
                </button>
              </div>
            </section>

            <section className="panel">
              <h3>Ids</h3>
              <dl className="details">
                <dt>Task id</dt>
                <dd>
                  <code>{detail.task.id}</code>
                  <button className="act act--ghost" onClick={() => copyText(detail.task.id)}>
                    Copy
                  </button>
                </dd>
                <dt>Session</dt>
                <dd>
                  <code>{detail.task.sessionId ?? "not started"}</code>
                </dd>
                <dt>From another conversation</dt>
                <dd>
                  <pre className="snippet">{cliSnippet(detail.task.id)}</pre>
                </dd>
              </dl>
            </section>
          </>
        )}
      </section>
    </div>
  );
}
