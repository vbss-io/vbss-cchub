import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { fetchSessions, focusSession, reportUiDiag, reportUiError, requestNavigate, subscribe, type ToastCard } from "../api";
import { ApprovalsProvider, useApprovalsStore, type ApprovalsStore } from "../approvals-context";
import { approvalToastsOn, toastQueue } from "../approvals-model";
import { sessionClient } from "../clients";
import { getTask } from "../delegation";
import { IconClose, IconSessions, IconShare, IconTasks } from "../icons";
import { loadNotifEventConfig, type NotifEventKind } from "../notifications";
import {
  sessionToastContext,
  taskToastContext,
  TOAST_ATTENTION_MS,
  TOAST_LOOK,
  toastLifetime,
  toastStack,
  toastTarget,
  toastView,
  type ToastContext,
  type ToastSource,
} from "../toast-model";
import type { PermissionRequestRecord, SessionRecord } from "../types";
import { ApprovalRequest } from "./ApprovalRequest";
import { shortClientName } from "./RunChips";

const inTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const TICK_MS = 250;
const WIDTH = 380;
const MARGIN = 16;
const TASKBAR_GUESS = 48;

const SOURCE_ICON: Readonly<Record<ToastSource, () => ReactElement>> = {
  session: () => <IconSessions size={14} />,
  task: () => <IconTasks size={14} />,
  share: () => <IconShare size={14} />,
};

interface Card extends ToastCard {
  key: number;
  lifetime: number;
  elapsed: number;
  context: ToastContext | null;
}

interface MonitorLike {
  position: { x: number; y: number };
  size: { width: number; height: number };
  scaleFactor: number;
  workArea?: { position: { x: number; y: number }; size: { width: number; height: number } };
}

const logToaster = (step: string, err: unknown): void => {
  void reportUiError("toaster", err instanceof Error ? new Error(`${step}: ${err.message}`) : new Error(`${step}: ${String(err)}`), null);
};

async function applyWindow(count: number, height: number): Promise<void> {
  if (!inTauri()) return;
  try {
    await applyWindowUnsafe(count, height);
  } catch (err) {
    logToaster(count === 0 ? "hide" : "show", err);
  }
}

async function applyWindowUnsafe(count: number, height: number): Promise<void> {
  const { getCurrentWindow, currentMonitor } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  if (count === 0) {
    await win.hide();
    return;
  }
  const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");
  const monitor = (await currentMonitor()) as unknown as MonitorLike | null;
  const scale = monitor?.scaleFactor ?? 1;
  let areaX = 0;
  let areaY = 0;
  let areaW = 1280;
  let areaH = 720;
  if (monitor?.workArea) {
    areaX = monitor.workArea.position.x / scale;
    areaY = monitor.workArea.position.y / scale;
    areaW = monitor.workArea.size.width / scale;
    areaH = monitor.workArea.size.height / scale;
  } else if (monitor) {
    areaX = monitor.position.x / scale;
    areaY = monitor.position.y / scale;
    areaW = monitor.size.width / scale;
    areaH = monitor.size.height / scale - TASKBAR_GUESS;
  }
  const x = Math.round(areaX + areaW - WIDTH - MARGIN);
  const y = Math.round(areaY + areaH - height - MARGIN);
  await win.setSize(new LogicalSize(WIDTH, height));
  await win.setPosition(new LogicalPosition(x, y));
  await win.setAlwaysOnTop(true);
  try {
    await win.setFocusable(false);
  } catch {
    /* older webview: focus:false in the window config already prevents focus steal */
  }
  await win.show();
  void reportUiDiag({ window: "toast", shownAt: new Date().toISOString(), position: { x, y }, height, count });
}

async function openTarget(kind: NotifEventKind, id: string): Promise<void> {
  const { hash, focus } = toastTarget(kind, id);
  if (!inTauri()) {
    window.open(`${location.origin}${location.pathname}${hash}`, "_blank", "noopener");
    return;
  }
  if (focus) {
    try {
      const result = await focusSession(id);
      if (result.ok) return;
      logToaster("focus session", new Error(result.reason ?? "focus refused"));
    } catch (err) {
      logToaster("focus session", err);
    }
  }
  await requestNavigate(hash);
}

async function sessionContext(id: string, cache: Map<string, SessionRecord>): Promise<ToastContext | null> {
  if (!cache.has(id)) for (const session of await fetchSessions()) cache.set(session.sessionId, session);
  const session = cache.get(id);
  if (!session) return null;
  const client = sessionClient(session);
  return sessionToastContext(session, shortClientName(client), client.label);
}

async function contextFor(toast: ToastCard, cache: Map<string, SessionRecord>): Promise<ToastContext | null> {
  const source = TOAST_LOOK[toast.kind].source;
  if (source === "session") return sessionContext(toast.id, cache);
  if (source === "share") return null;
  const { task } = await getTask(toast.id);
  return taskToastContext({ workspace: task.workspace, cwd: task.cwd, runner: task.runner, isolation: task.isolation, branch: task.branch });
}

export function Toaster(): ReactElement {
  const approvalsStore = useApprovalsStore();
  return (
    <ApprovalsProvider store={approvalsStore}>
      <ToasterStack approvalsStore={approvalsStore} />
    </ApprovalsProvider>
  );
}

function ToasterStack({ approvalsStore }: { approvalsStore: ApprovalsStore }): ReactElement {
  const [cards, setCards] = useState<Card[]>([]);
  const [dismissedApprovals, setDismissedApprovals] = useState<ReadonlySet<string>>(() => new Set());
  const approvalHandlers = approvalsStore.handlers;
  const [now, setNow] = useState(() => Date.now());
  const hoveringRef = useRef(false);
  const seq = useRef(0);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const applied = useRef<{ count: number; height: number }>({ count: -1, height: -1 });
  const sessionsRef = useRef(new Map<string, SessionRecord>());

  const pushCard = useCallback((toast: ToastCard) => {
    void reportUiDiag({ window: "toast", lastToast: toast.title, lastToastAt: new Date().toISOString() });
    const key = seq.current++;
    setCards((prev) => [...prev, { ...toast, key, lifetime: toastLifetime(toast.kind), elapsed: 0, context: null }]);
    void contextFor(toast, sessionsRef.current)
      .then((context) => {
        if (context) setCards((prev) => prev.map((card) => (card.key === key ? { ...card, context } : card)));
      })
      .catch(() => undefined);
  }, []);

  const rememberSession = useCallback((session: SessionRecord) => {
    sessionsRef.current.set(session.sessionId, session);
  }, []);

  useEffect(
    () =>
      subscribe({
        onSession: rememberSession,
        onToast: pushCard,
        onOpen: approvalHandlers.reload,
        onPermissionRequest: approvalHandlers.onPermissionRequest,
        onPermissionResolved: approvalHandlers.onPermissionResolved,
      }),
    [pushCard, rememberSession, approvalHandlers],
  );

  const approvalCards = useMemo(() => (approvalToastsOn(loadNotifEventConfig()) ? toastQueue(approvalsStore.list, dismissedApprovals) : []), [approvalsStore.list, dismissedApprovals]);
  const dismissApproval = useCallback((id: string) => setDismissedApprovals((prev) => new Set(prev).add(id)), []);
  const openApprovalSession = useCallback((request: PermissionRequestRecord) => {
    if (request.agent === "claude") void openTarget("sessionNeedsYou", request.sessionId);
    else void requestNavigate("#/sessions");
  }, []);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __cchubToaster: unknown }).__cchubToaster = {
      push: (toast: ToastCard) => pushCard(toast),
      clear: () => setCards([]),
    };
  }, [pushCard]);

  useEffect(() => {
    let lastTick = Date.now();
    const tick = () => {
      const current = Date.now();
      const delta = Math.min(current - lastTick, TOAST_ATTENTION_MS);
      lastTick = current;
      setNow(current);
      setCards((prev) => {
        if (hoveringRef.current || prev.length === 0) return prev;
        return prev.map((card) => ({ ...card, elapsed: card.elapsed + delta })).filter((card) => card.elapsed < card.lifetime);
      });
    };
    const id = setInterval(tick, TICK_MS);
    const onVisible = () => tick();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  useLayoutEffect(() => {
    const height = (stackRef.current?.offsetHeight ?? 0) + MARGIN;
    const count = cards.length + approvalCards.length;
    if (applied.current.count === count && applied.current.height === height) return;
    applied.current = { count, height };
    void applyWindow(count, Math.max(height, 1));
  }, [cards, approvalCards]);

  const onCardClick = useCallback((card: Card) => {
    void openTarget(card.kind, card.id);
    setCards((prev) => prev.filter((item) => item.key !== card.key));
  }, []);

  const dismiss = useCallback((key: number) => setCards((prev) => prev.filter((item) => item.key !== key)), []);

  const { hidden, visible } = toastStack(cards);
  const stop = (event: MouseEvent) => event.stopPropagation();

  return (
    <div className="toaster">
      <div
        className="toaster__stack"
        ref={stackRef}
        onMouseEnter={() => {
          hoveringRef.current = true;
        }}
        onMouseLeave={() => {
          hoveringRef.current = false;
        }}
      >
        {hidden > 0 && <div className="toaster__more">+{hidden} more</div>}
        {approvalCards.map((request) => (
          <div key={request.id} className="tcard tcard--pend tcard--approval" role="group" aria-label={`Permission request: ${request.toolName}`}>
            <div className="tcard__head">
              <span className="tcard__title" title={request.title ?? request.sessionId}>
                {request.title ?? request.sessionId.slice(0, 8)}
              </span>
              <span className="tcard__status tcard__status--pend">Needs you</span>
              <button className="tcard__close" onClick={() => dismissApproval(request.id)} aria-label="Dismiss" title="Dismiss, the request stays in the hub">
                <IconClose size={14} />
              </button>
            </div>
            <ApprovalRequest request={request} compact reasonField={false} />
            <button type="button" className="show-more__btn tcard__open" onClick={() => openApprovalSession(request)}>
              Open session
            </button>
          </div>
        ))}
        {visible.map((card) => {
          const view = toastView(card, card.context, now);
          const [source, ...rest] = view.parts;
          return (
            <div
              key={card.key}
              className={`tcard tcard--${view.tone}`}
              role="button"
              tabIndex={0}
              aria-label={`${view.label}: ${view.title}`}
              onClick={() => onCardClick(card)}
            >
              <div className="tcard__head">
                <span className="tcard__title" title={view.title}>
                  {view.title}
                </span>
                <span className={`tcard__status tcard__status--${view.tone}`}>{view.label}</span>
                <button
                  className="tcard__close"
                  onMouseDown={stop}
                  onClick={(event) => {
                    event.stopPropagation();
                    dismiss(card.key);
                  }}
                  aria-label="Dismiss"
                  title="Dismiss"
                >
                  <IconClose size={14} />
                </button>
              </div>
              <div className="tcard__meta">
                {source && (
                  <span className="tcard__source" title={source.title}>
                    <span className="tcard__icon" aria-hidden="true">
                      {SOURCE_ICON[view.source]()}
                    </span>
                    <span className="tcard__part">{source.text}</span>
                  </span>
                )}
                {rest.map((part) => (
                  <Fragment key={part.key}>
                    <span className="tcard__sep" aria-hidden="true">
                      ·
                    </span>
                    <span className={part.key === "time" ? "tcard__part tcard__part--time" : "tcard__part"} title={part.title}>
                      {part.text}
                    </span>
                  </Fragment>
                ))}
                {view.extras.length > 0 && (
                  <span className="tcard__more" title={view.extras.join("\n")} aria-label={`${view.extras.length} more: ${view.extras.join(", ")}`} role="note">
                    +{view.extras.length}
                  </span>
                )}
              </div>
              {view.reason && (
                <div className={`tcard__why tcard__why--${view.tone}`} title={view.reason}>
                  <span className="tcard__why-text">{view.reason}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
