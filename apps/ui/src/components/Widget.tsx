import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { fetchSessions, focusSession, subscribe } from "../api";
import { sessionClient, isHubRun } from "../clients";
import { listTasks, type TaskRecord, type TaskStatus } from "../delegation";
import { taskBranch, taskIsolation } from "../delegation-actions";
import { IconCode, IconCodex, IconStar } from "../icons";
import { isMock, MOCK_SESSIONS } from "../mock";
import { folderPeers } from "../peers";
import { isEmpty, isStale } from "../stale";
import type { SessionRecord } from "../types";
import { BrandMark } from "./BrandMark";
import { inFlight, needsYou } from "./TaskCard";
import "../widget.css";

const inTauri = (): boolean => "__TAURI_INTERNALS__" in window;

const nameOf = (session: SessionRecord): string =>
  session.customTitle ?? session.title ?? session.sessionId.slice(0, 8);

const liveSession = (session: SessionRecord): boolean =>
  session.archivedAt == null && session.status !== "ended" && !isStale(session) && !isEmpty(session) && !isHubRun(session.client);

const elapsedLabel = (ms: number): string => {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest > 0 ? `${hours}h${rest}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

const taskDotTone = (status: TaskStatus): string => {
  if (status === "attention") return "pend";
  if (status === "failed" || status === "interrupted") return "hold";
  if (status === "completed") return "ok";
  return "go";
};

const TASK_ATTENTION_SUB: Record<string, string> = {
  attention: "needs you",
  failed: "failed",
  interrupted: "interrupted",
};

async function hideWidget(): Promise<void> {
  if (!inTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().hide();
}

async function openMain(hash: string | null): Promise<void> {
  if (!inTauri()) {
    const url = `${location.origin}${location.pathname}${hash ?? "#/sessions"}`;
    window.open(url, "_blank", "noopener");
    return;
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const main = await WebviewWindow.getByLabel("main");
  if (main) {
    await main.show();
    await main.setFocus();
  }
  if (hash) {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("hub:navigate", hash);
  }
}

const HEADER_H = 40;

async function currentHeight(): Promise<number | null> {
  if (!inTauri()) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const size = await win.innerSize();
  const scale = await win.scaleFactor();
  return Math.round(size.height / scale);
}

async function resizeHeight(height: number): Promise<void> {
  if (!inTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { LogicalSize } = await import("@tauri-apps/api/dpi");
  const win = getCurrentWindow();
  const size = await win.innerSize();
  const scale = await win.scaleFactor();
  await win.setSize(new LogicalSize(Math.round(size.width / scale), height));
}

const stop = (event: MouseEvent) => event.stopPropagation();

export function Widget() {
  const [sessions, setSessions] = useState<Record<string, SessionRecord>>({});
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("widget.collapsed") === "1");
  const [tick, setTick] = useState(0);
  const expandedHeight = useRef(Number(localStorage.getItem("widget.height")) || 440);
  const dragWindow = useRef<(() => void) | null>(null);

  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!inTauri()) return;
    void import("@tauri-apps/api/window").then((api) => {
      dragWindow.current = () => void api.getCurrentWindow().startDragging();
    });
  }, []);

  useEffect(() => {
    if (collapsed) void resizeHeight(HEADER_H);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startDrag = (event: MouseEvent) => {
    if (event.button !== 0) return;
    dragWindow.current?.();
  };

  const toggleCollapse = async () => {
    if (!collapsed) {
      const height = await currentHeight();
      if (height && height > HEADER_H) {
        expandedHeight.current = height;
        localStorage.setItem("widget.height", String(height));
      }
      await resizeHeight(HEADER_H);
      setCollapsed(true);
      localStorage.setItem("widget.collapsed", "1");
    } else {
      await resizeHeight(expandedHeight.current);
      setCollapsed(false);
      localStorage.setItem("widget.collapsed", "0");
    }
  };

  useEffect(() => {
    if (isMock) {
      setSessions(Object.fromEntries(MOCK_SESSIONS.map((s) => [s.sessionId, s])));
      return;
    }
    let mounted = true;
    const reloadTasks = () => {
      void listTasks().then((list) => {
        if (mounted) setTasks(list);
      }).catch(() => undefined);
    };
    void fetchSessions().then((list) => {
      if (mounted) setSessions(Object.fromEntries(list.map((s) => [s.sessionId, s])));
    });
    reloadTasks();
    const unsubscribe = subscribe({
      onSession: (session) => setSessions((prev) => ({ ...prev, [session.sessionId]: session })),
      onRemoved: (sessionId) =>
        setSessions((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        }),
      onDelegation: reloadTasks,
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const model = useMemo(() => {
    const all = Object.values(sessions);
    const live = all.filter(liveSession);
    const waiting = live.filter((s) => s.status === "waiting").sort((a, b) => b.updatedAt - a.updatedAt);
    const running = live
      .filter((s) => s.status === "active")
      .sort((a, b) => Number(b.favoriteAt != null) - Number(a.favoriteAt != null) || b.updatedAt - a.updatedAt);
    const attentionTasks = tasks.filter((t) => t.archivedAt == null && needsYou(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
    const delegated = tasks.filter((t) => t.archivedAt == null && inFlight(t.status)).sort((a, b) => a.createdAt - b.createdAt);
    const doneRecent = tasks
      .filter((t) => t.archivedAt == null && t.status === "completed" && Date.now() - t.updatedAt < 3_600_000)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3);
    return {
      all,
      live,
      waiting,
      running,
      attentionTasks,
      delegated,
      doneRecent,
      needYou: waiting.length + attentionTasks.length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, tasks, tick]);

  const sessionRow = (session: SessionRecord, tone: string, sub: string) => {
    const peers = folderPeers(session.cwd, model.all, tasks, { sessionId: session.sessionId });
    return (
      <button
        key={session.sessionId}
        className="wg-row"
        title={session.cwd ?? nameOf(session)}
        onClick={() => void focusSession(session.sessionId)}
      >
        <span className="wg-ico">{sessionClient(session).icon}</span>
        <span className={`wg-dot wg-dot--${tone}`} />
        {session.favoriteAt != null && <IconStar size={12} filled />}
        <span className="wg-title">{nameOf(session)}</span>
        {(session.agentsRunning ?? 0) > 0 && (
          <span className="wg-pill wg-pill--agents" title="Subagents running">
            {session.agentsRunning} sub
          </span>
        )}
        {peers > 0 && (
          <span className="wg-pill wg-pill--peers" title="Other agents in the same folder">
            +{peers} here
          </span>
        )}
        <span className="wg-sub">{sub}</span>
      </button>
    );
  };

  const taskRow = (task: TaskRecord, tone: string, sub: string, pill?: ReactNode) => (
    <button
      key={task.id}
      className="wg-row"
      title={task.title}
      onClick={() => void openMain(`#/tasks/${task.id}`)}
    >
      <span className="wg-ico">{task.runner === "codex" ? <IconCodex /> : <IconCode />}</span>
      <span className={`wg-dot wg-dot--${tone}`} />
      <span className="wg-title">{task.title}</span>
      {pill}
      <span className="wg-sub">{sub}</span>
    </button>
  );

  const hasRows =
    model.waiting.length + model.attentionTasks.length + model.running.length + model.delegated.length + model.doneRecent.length > 0;

  return (
    <div className="wg">
      <div className="wg-head" onMouseDown={startDrag}>
        <span className="wg-brand">
          <BrandMark size={15} />
        </span>
        <span className="wg-state">
          <b>{model.live.length}</b> live
          {" · "}
          <span className={model.needYou > 0 ? "wg-state-attn" : undefined}>
            <b>{model.needYou}</b> need you
          </span>
          {" · "}
          <b>{model.delegated.length}</b> delegated running
        </span>
        <span className="wg-ctrls">
          <button
            className="wg-btn"
            onMouseDown={stop}
            onClick={() => void toggleCollapse()}
            title={collapsed ? "Expand" : "Collapse"}
            aria-label={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? "▴" : "▾"}
          </button>
          <button className="wg-btn" onMouseDown={stop} onClick={() => void hideWidget()} title="Hide" aria-label="Hide widget">
            –
          </button>
        </span>
      </div>

      {!collapsed && (
        <>
          <div className="wg-body">
            {model.waiting.length + model.attentionTasks.length > 0 && (
              <section className="wg-sec wg-sec--needs">
                <div className="wg-sec-h">
                  Needs you <span className="wg-sec-n">{model.needYou}</span>
                </div>
                {model.waiting.map((session) => sessionRow(session, "pend", "input"))}
                {model.attentionTasks.map((task) => taskRow(task, taskDotTone(task.status), TASK_ATTENTION_SUB[task.status] ?? "needs you"))}
              </section>
            )}

            {model.running.length > 0 && (
              <section className="wg-sec">
                <div className="wg-sec-h">
                  Running <span className="wg-sec-n">{model.running.length}</span>
                </div>
                {model.running.map((session) => sessionRow(session, "go", "active"))}
              </section>
            )}

            {model.delegated.length > 0 && (
              <section className="wg-sec">
                <div className="wg-sec-h">
                  Delegated <span className="wg-sec-n">{model.delegated.length}</span>
                </div>
                {model.delegated.map((task) => {
                  const branch = taskIsolation(task) === "worktree" ? taskBranch(task) : null;
                  const pill = branch ? (
                    <span className="wg-pill wg-pill--branch" title={`worktree · ${branch}`}>
                      {branch}
                    </span>
                  ) : undefined;
                  return taskRow(task, "go", elapsedLabel(Date.now() - task.createdAt), pill);
                })}
              </section>
            )}

            {model.doneRecent.length > 0 && (
              <section className="wg-sec">
                <div className="wg-sec-h">
                  Recently done <span className="wg-sec-n">{model.doneRecent.length}</span>
                </div>
                {model.doneRecent.map((task) => taskRow(task, "ok", elapsedLabel(Date.now() - task.updatedAt)))}
              </section>
            )}

            {!hasRows && (
              <div className="wg-empty">
                <b>All quiet</b>
                Nothing running right now.
              </div>
            )}
          </div>

          <div className="wg-foot">
            <button className="wg-open" onClick={() => void openMain(null)}>
              Open hub
            </button>
          </div>
        </>
      )}
    </div>
  );
}
