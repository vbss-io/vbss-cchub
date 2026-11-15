import { useEffect, useRef, useState } from "react";
import type { TaskRecord } from "../delegation";
import { taskArchivedAt, taskIsolation } from "../delegation-actions";
import { IconClose, IconCode, IconCodex, IconExpand } from "../icons";
import { Markdown } from "../markdown";
import { taskInFlight, taskNeedsYou, taskPrimaryAction, taskStatusTone, taskTiming, worktreeMergeable } from "../runs-model";
import { relativeTime } from "../time";
import type { CodexSessionRecord, RunEventMessage, SessionRecord } from "../types";
import { useTaskDetail } from "../use-task-detail";
import { DRAWER_WIDTH, useDrawerWidth } from "../use-layout-size";
import { ReportRow } from "../views/ReportsView";
import { CardMenu, useCardMenu, type CardMenuItem } from "./CardMenu";
import { ResizableDrawerEdge } from "./ResizableDrawerEdge";
import { LiveLog, RunCard, WorktreePanel } from "./TaskDetailParts";
import { ClampScope, ClampText, ShowMoreList } from "./ShowMore";
import { taskOrigin, taskStatusLabel, whyOf, worktreeLabel } from "./TaskCard";

type Tab = "live" | "asked" | "runs" | "worktree" | "reports" | "details";

const ASKED_LINES = 12;

interface Props {
  taskId: string;
  tasks: TaskRecord[];
  sessions: Record<string, SessionRecord>;
  codexSessions: CodexSessionRecord[];
  workspace: string | null;
  tick: number;
  subscribeRunEvents: (listener: (event: RunEventMessage) => void) => () => void;
  onRefresh: () => Promise<void>;
  onError: (text: string) => void;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenCodex: (threadId: string) => void;
}

export function TaskDrawer({ taskId, tasks, sessions, codexSessions, workspace, tick, subscribeRunEvents, onRefresh, onError, onClose, onOpenSession, onOpenCodex }: Props) {
  const state = useTaskDetail(taskId, tick, subscribeRunEvents, onRefresh, onError);
  const [tab, setTab] = useState<Tab>("live");
  const [composing, setComposing] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [full, setFull] = useState(false);
  const menu = useCardMenu();
  const drawerWidth = useDrawerWidth("delegated", full, true);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setTab("live");
    setComposing(false);
    setFollowUp("");
    setConfirmDiscard(false);
  }, [taskId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (full) setFull(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, full]);

  useEffect(() => {
    if (full) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panelRef.current?.contains(target) || target.closest(".card-menu")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [full, onClose]);

  const listed = tasks.find((task) => task.id === taskId) ?? null;
  const task = state.detail?.task ?? listed;
  const running = task ? taskInFlight(task.status) : false;
  const archived = task ? taskArchivedAt(task) != null : false;
  const isolated = task ? taskIsolation(task) === "worktree" : false;
  const canMerge = worktreeMergeable(state.worktree, running);
  const primary = task ? taskPrimaryAction({ status: task.status, archived, mergeable: canMerge }) : null;
  const why = task ? whyOf(task) : null;
  const origin = task ? taskOrigin(task, sessions) : null;
  const thread = codexSessions.find((item) => item.hubTaskId === taskId) ?? null;
  const runs = state.detail?.runs ?? [];
  const reports = state.detail?.reports ?? [];
  const baseBranch = state.worktree?.baseBranch ?? task?.baseBranch ?? "base";
  const name = task?.title ?? "Task";
  const tone = task ? taskStatusTone(task) : "muted";
  const timing = task ? taskTiming(task, Date.now()) : null;

  const startContinue = () => {
    setComposing(true);
    setTab("live");
  };
  const mergeNow = () => state.merge();
  const askDiscard = () => {
    setTab("worktree");
    setConfirmDiscard(true);
  };
  const send = async () => {
    const prompt = followUp.trim();
    if (!prompt) return;
    if (await state.sendContinue(prompt)) {
      setFollowUp("");
      setComposing(false);
    }
  };

  const menuItems: CardMenuItem[] = task
    ? [
        ...(primary !== "continue" && !running ? [{ key: "continue", label: "Continue", disabled: state.busy || composing, onSelect: startContinue }] : []),
        ...(primary !== "merge" && canMerge ? [{ key: "merge", label: `Merge into ${baseBranch}`, disabled: state.busy, onSelect: mergeNow }] : []),
        ...(why ? [{ key: "retry", label: why.retry === "autonomous" ? "Retry autonomous" : "Retry", disabled: state.busy, onSelect: () => state.retry(why.retry) }] : []),
        ...(why && why.retry === "autonomous" ? [{ key: "retry-plain", label: "Retry", disabled: state.busy, onSelect: () => state.retry("plain") }] : []),
        ...(task.sessionId && sessions[task.sessionId] ? [{ key: "session", label: "Open session", onSelect: () => onOpenSession(task.sessionId ?? "") }] : []),
        ...(thread ? [{ key: "thread", label: "Open Codex thread", onSelect: () => onOpenCodex(thread.id) }] : []),
        ...(origin?.sessionId ? [{ key: "origin", label: "Open delegating session", onSelect: () => onOpenSession(origin.sessionId ?? "") }] : []),
        { key: "large", label: full ? "Back to the side panel" : "Open in a large view", onSelect: () => setFull((value) => !value) },
        ...(archived
          ? [{ key: "unarchive", label: "Unarchive", disabled: state.busy, onSelect: state.unarchive }]
          : !running && state.archiveSupported
            ? [{ key: "archive", label: "Archive", disabled: state.busy, onSelect: state.archive }]
            : []),
        ...(isolated && state.worktree?.exists && !running ? [{ key: "discard", label: "Discard worktree", danger: true, disabled: state.busy, onSelect: askDiscard }] : []),
      ]
    : [];

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "live", label: "Live output" },
    { key: "asked", label: "What was asked" },
    { key: "runs", label: "Runs", count: runs.length },
    ...(isolated ? [{ key: "worktree" as const, label: "Worktree" }] : []),
    ...(reports.length > 0 ? [{ key: "reports" as const, label: "Reports", count: reports.length }] : []),
    { key: "details", label: "Details" },
  ];

  return (
    <>
      {full && <div className="drawer__backdrop" onClick={() => setFull(false)} />}
      <aside ref={panelRef} className={`drawer drawer--task ${full ? "drawer--full" : ""}`} style={drawerWidth.style} role="dialog" aria-label={name}>
        <header className="drawer__header">
          <div className="drawer__title">
            <div className="drawer__name">
              <button className="act act--icon drawer__expand" onClick={() => setFull((value) => !value)} aria-label={full ? "Back to the side panel" : "Open in a large view"} title={full ? "Back to the side panel" : "Open in a large view"}>
                <IconExpand />
              </button>
              <h2 title={name}>{name}</h2>
            </div>
            {task && (
              <div className="card__badges">
                <span className={`tag tag--${tone}`} data-status={task.status}>{taskStatusLabel(task)}</span>
                <span className={`client client--${task.runner === "codex" ? "codex" : "claude"}`} title={`${task.runner === "codex" ? "Codex" : "Claude"} runner`}>
                  {task.runner === "codex" ? <IconCodex /> : <IconCode />}
                  <span>{task.runner === "codex" ? "Codex" : "Claude"}</span>
                </span>
                <span className="chip chip--ws">{workspace ?? task.workspace}{task.repo ? ` / ${task.repo}` : ""}</span>
                {archived && <span className="tag tag--muted">archived</span>}
              </div>
            )}
            {timing && (
              <p className="muted small task-timing">
                started {relativeTime(timing.startedAt)} · {timing.duration} · {timing.runs}
              </p>
            )}
          </div>
          <div className="drawer__actions">
            {primary === "cancel" && task && (
              <button className="act act--danger" disabled={state.busy} onClick={state.cancel}>
                Cancel
              </button>
            )}
            {primary === "continue" && (
              <button className="act act--focus" disabled={state.busy || composing} onClick={startContinue}>
                Continue
              </button>
            )}
            {primary === "merge" && (
              <button className="act act--focus" disabled={state.busy} onClick={mergeNow} title={`git merge --no-ff into ${baseBranch}`}>
                Merge into {baseBranch}
              </button>
            )}
            {menuItems.length > 0 && <CardMenu menu={menu} items={menuItems} label={`Actions for ${name}`} />}
            <button className="act act--icon" onClick={onClose} aria-label="Close">
              <IconClose />
            </button>
          </div>
        </header>

        {why && task && taskNeedsYou(task.status) && (
          <div className={`why why--drawer why--${tone}`}>
            <span className="why__headline">{why.headline}</span>
            {why.detail && <span className="why__detail">{why.detail}</span>}
          </div>
        )}

        {composing && (
          <section className="task-compose">
            <textarea
              className="in area"
              autoFocus
              placeholder={running ? "running… wait for it to finish" : "send a follow-up into the same session"}
              value={followUp}
              onChange={(event) => setFollowUp(event.target.value)}
              disabled={running}
            />
            <div className="actions">
              <button
                className="act act--ghost"
                onClick={() => {
                  setComposing(false);
                  setFollowUp("");
                }}
              >
                Cancel
              </button>
              <button className="act act--focus" disabled={state.busy || running || followUp.trim().length === 0} onClick={() => void send()}>
                Send
              </button>
            </div>
          </section>
        )}

        <div className="drawer__tabs" role="tablist">
          {tabs.map((item) => (
            <button key={item.key} role="tab" aria-selected={tab === item.key} className={`pill ${tab === item.key ? "pill--on" : ""}`} onClick={() => setTab(item.key)}>
              {item.label}
              {item.count !== undefined && <span className="pill__count">{item.count}</span>}
            </button>
          ))}
        </div>

        <div className="drawer__body">
          <ClampScope resetKey={taskId}>
            {!state.detail && <p className="hint">Loading the task…</p>}
            {state.detail && tab === "live" && <LiveLog lines={state.logLines} running={running} resetKey={`${taskId}:${runs[runs.length - 1]?.id ?? "none"}`} />}
            {state.detail && tab === "asked" && (
              <ClampText className="askbox__body" markdown lines={ASKED_LINES} scopeKey="asked">
                <Markdown text={state.detail.task.prompt} />
              </ClampText>
            )}
            {state.detail && tab === "runs" && (
              <div className="runs">
                <ShowMoreList items={runs} resetKey={`runs:${taskId}`} from="end" noun="runs" render={(run) => <RunCard key={run.id} run={run} />} />
                {runs.length === 0 && <p className="muted">No runs recorded yet.</p>}
              </div>
            )}
            {state.detail && tab === "worktree" && (
              <WorktreePanel
                worktree={state.worktree}
                busy={state.busy}
                running={running}
                canMerge={canMerge}
                confirmDiscard={confirmDiscard}
                onConfirmDiscard={setConfirmDiscard}
                onDiscard={state.discard}
                onMerge={mergeNow}
              />
            )}
            {state.detail && tab === "reports" && (
              <ShowMoreList
                items={reports}
                resetKey={`reports:${taskId}`}
                noun="reports"
                wrap={(rows) => <ul className="reports">{rows}</ul>}
                render={(report) => <ReportRow key={report.id} report={report} />}
              />
            )}
            {state.detail && tab === "details" && task && (
              <dl className="details">
                <dt>Task id</dt>
                <dd>
                  <code>{task.id}</code>
                </dd>
                <dt>Workspace</dt>
                <dd>
                  {task.workspace}
                  {task.repo ? ` / ${task.repo}` : ""}
                </dd>
                <dt>Runner</dt>
                <dd>
                  {task.runner}
                  {task.requestedModel ? ` · ${task.requestedModel}` : ""}
                  {task.permissionMode ? ` · ${task.permissionMode}` : ""}
                </dd>
                <dt>Runs in</dt>
                <dd className="path">{task.cwd}</dd>
                <dt>Repos attached</dt>
                <dd className="path">{task.addDirs.length > 0 ? task.addDirs.join(", ") : "—"}</dd>
                <dt>Worktree</dt>
                <dd className="path">{isolated ? `${worktreeLabel(task) ?? "worktree"}${state.worktree?.path ? ` · ${state.worktree.path}` : ""}` : "shared checkout"}</dd>
                <dt>Ports</dt>
                <dd>{task.portBase != null && task.portEnd != null ? `${task.portBase}–${task.portEnd}` : "—"}</dd>
                <dt>Origin</dt>
                <dd>
                  {origin?.sessionId ? (
                    <button className="linklike" onClick={() => onOpenSession(origin.sessionId ?? "")}>
                      {origin.label}
                    </button>
                  ) : (
                    (origin?.label ?? "—")
                  )}
                </dd>
                <dt>Hub session</dt>
                <dd>
                  {task.sessionId ? (
                    <button className="linklike" onClick={() => onOpenSession(task.sessionId ?? "")}>
                      <code>{task.sessionId}</code>
                    </button>
                  ) : (
                    "—"
                  )}
                </dd>
                <dt>Started</dt>
                <dd>{new Date(task.createdAt).toLocaleString()}</dd>
                <dt>Duration</dt>
                <dd>{timing?.duration ?? "—"}</dd>
                <dt>Runs</dt>
                <dd>{timing?.runs ?? "—"}</dd>
                <dt>Updated</dt>
                <dd>{new Date(task.updatedAt).toLocaleString()}</dd>
              </dl>
            )}
          </ClampScope>
        </div>
        {drawerWidth.resizable && (
          <ResizableDrawerEdge
            width={drawerWidth.width}
            minWidth={DRAWER_WIDTH.min}
            maxWidth={drawerWidth.maxWidth}
            defaultWidth={DRAWER_WIDTH.default}
            onWidthChange={drawerWidth.setWidth}
            ariaLabel="Resize task panel"
          />
        )}
      </aside>
    </>
  );
}
