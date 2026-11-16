import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { fetchSessions, focusSession, reportUiDiag, reportUiError, requestNavigate, subscribe, type ToastCard } from "../api";
import { ApprovalsProvider, useApprovalsStore, type ApprovalsStore } from "../approvals-context";
import { approvalKind, approvalToastsOn, toastQueue } from "../approvals-model";
import { sessionClient } from "../clients";
import { getTask } from "../delegation";
import { IconClose, IconSessions, IconShare, IconTasks } from "../icons";
import { loadNotifEventConfig, type NotifEventKind } from "../notifications";
import {
  ageToasts,
  hideBehindApprovals,
  hoverAfter,
  pruneToasts,
  sessionToastContext,
  taskToastContext,
  TOAST_AUTO_MS,
  TOAST_LOOK,
  toastLifetime,
  toastStack,
  toastTarget,
  toastView,
  toastWaitsOnReason,
  upsertToast,
  type ToastContext,
  type ToastFact,
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
  lifetime: number | null;
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

async function applyWindow(count: number, height: number, keyboard: boolean): Promise<void> {
  if (!inTauri()) return;
  try {
    await applyWindowUnsafe(count, height, keyboard);
  } catch (err) {
    logToaster(count === 0 ? "hide" : "show", err);
  }
}

async function allowKeyboard(element: HTMLElement): Promise<void> {
  if (!inTauri()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.setFocusable(true);
    await win.setFocus();
    element.focus();
  } catch (err) {
    logToaster("keyboard", err);
  }
}

async function applyWindowUnsafe(count: number, height: number, keyboard: boolean): Promise<void> {
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
    await win.setFocusable(keyboard);
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

interface CardFacts {
  context: ToastContext | null;
  fact: ToastFact | null;
}

async function sessionContext(id: string, cache: Map<string, SessionRecord>): Promise<CardFacts> {
  if (!cache.has(id)) for (const session of await fetchSessions()) cache.set(session.sessionId, session);
  const session = cache.get(id);
  if (!session) return { context: null, fact: null };
  const client = sessionClient(session);
  return { context: sessionToastContext(session, shortClientName(client), client.label), fact: { type: "session", id, status: session.status } };
}

async function contextFor(toast: ToastCard, cache: Map<string, SessionRecord>): Promise<CardFacts> {
  const source = TOAST_LOOK[toast.kind].source;
  if (source === "session") return sessionContext(toast.id, cache);
  if (source === "share") return { context: null, fact: null };
  const { task } = await getTask(toast.id);
  return {
    context: taskToastContext({ workspace: task.workspace, cwd: task.cwd, runner: task.runner, isolation: task.isolation, branch: task.branch }),
    fact: { type: "task", id: toast.id, status: task.status, archived: task.archivedAt != null },
  };
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
  const [cards, setCards] = useState<readonly Card[]>([]);
  const [dismissedApprovals, setDismissedApprovals] = useState<ReadonlySet<string>>(() => new Set());
  const approvalHandlers = approvalsStore.handlers;
  const [now, setNow] = useState(() => Date.now());
  const hoveringRef = useRef(false);
  const shownCountRef = useRef(0);
  const keyboardRef = useRef(false);
  const cardsRef = useRef<readonly Card[]>([]);
  cardsRef.current = cards;
  const seq = useRef(0);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const applied = useRef<{ count: number; height: number }>({ count: -1, height: -1 });
  const sessionsRef = useRef(new Map<string, SessionRecord>());

  const applyFact = useCallback((fact: ToastFact) => setCards((prev) => pruneToasts(prev, fact)), []);

  const pushCard = useCallback(
    (toast: ToastCard) => {
      void reportUiDiag({ window: "toast", lastToast: toast.title, lastToastAt: new Date().toISOString() });
      const key = seq.current++;
      setCards((prev) => upsertToast(prev, { ...toast, key, lifetime: toastLifetime(toast.kind), elapsed: 0, context: null }));
      void contextFor(toast, sessionsRef.current)
        .then(({ context, fact }) => {
          if (context) setCards((prev) => prev.map((card) => (card.key === key ? { ...card, context } : card)));
          if (fact) applyFact(fact);
        })
        .catch(() => undefined);
    },
    [applyFact],
  );

  const rememberSession = useCallback(
    (session: SessionRecord) => {
      sessionsRef.current.set(session.sessionId, session);
      applyFact({ type: "session", id: session.sessionId, status: session.status });
    },
    [applyFact],
  );

  const forgetSession = useCallback(
    (sessionId: string) => {
      sessionsRef.current.delete(sessionId);
      applyFact({ type: "session", id: sessionId, status: null });
    },
    [applyFact],
  );

  const checkTask = useCallback(
    (taskId: string) => {
      if (!cardsRef.current.some((card) => card.id === taskId && TOAST_LOOK[card.kind].source === "task" && toastWaitsOnReason(card))) return;
      void getTask(taskId)
        .then(({ task }) => applyFact({ type: "task", id: taskId, status: task.status, archived: task.archivedAt != null }))
        .catch(() => undefined);
    },
    [applyFact],
  );

  const revalidate = useCallback(() => {
    const waiting = cardsRef.current.filter(toastWaitsOnReason);
    if (waiting.some((card) => TOAST_LOOK[card.kind].source === "session")) {
      void fetchSessions()
        .then((list) => {
          const byId = new Map(list.map((session) => [session.sessionId, session]));
          for (const card of waiting) {
            if (TOAST_LOOK[card.kind].source === "session") applyFact({ type: "session", id: card.id, status: byId.get(card.id)?.status ?? null });
          }
        })
        .catch(() => undefined);
    }
    for (const card of waiting) if (TOAST_LOOK[card.kind].source === "task") checkTask(card.id);
  }, [applyFact, checkTask]);

  const onOpen = useCallback(() => {
    approvalHandlers.reload();
    revalidate();
  }, [approvalHandlers, revalidate]);

  useEffect(
    () =>
      subscribe({
        onSession: rememberSession,
        onRemoved: forgetSession,
        onDelegation: checkTask,
        onToast: pushCard,
        onOpen,
        onPermissionRequest: approvalHandlers.onPermissionRequest,
        onPermissionResolved: approvalHandlers.onPermissionResolved,
      }),
    [pushCard, rememberSession, forgetSession, checkTask, onOpen, approvalHandlers],
  );

  const approvalsShown = approvalToastsOn(loadNotifEventConfig());
  const approvalCards = useMemo(() => (approvalsShown ? toastQueue(approvalsStore.list, dismissedApprovals) : []), [approvalsShown, approvalsStore.list, dismissedApprovals]);
  const approvalSessions = useMemo(
    () => new Set(approvalsShown ? approvalsStore.list.filter((item) => item.agent === "claude").map((item) => item.sessionId) : []),
    [approvalsShown, approvalsStore.list],
  );
  const typing = approvalCards.some((request) => approvalKind(request) !== "tool");
  const onTextFocus = useCallback((element: HTMLElement) => {
    keyboardRef.current = true;
    void allowKeyboard(element);
  }, []);
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
      const delta = Math.min(current - lastTick, TOAST_AUTO_MS);
      lastTick = current;
      setNow(current);
      setCards((prev) => ageToasts(prev, delta, hoveringRef.current));
    };
    const id = setInterval(tick, TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === "hidden") hoveringRef.current = hoverAfter("hidden");
      tick();
    };
    const onBlur = () => {
      hoveringRef.current = hoverAfter("blur");
    };
    const onLeave = () => {
      hoveringRef.current = hoverAfter("leave");
    };
    document.addEventListener("visibilitychange", onVisible);
    document.documentElement.addEventListener("mouseleave", onLeave);
    window.addEventListener("focus", onVisible);
    window.addEventListener("blur", onBlur);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const shownCards = useMemo(() => hideBehindApprovals(cards, approvalSessions), [cards, approvalSessions]);

  useLayoutEffect(() => {
    const height = (stackRef.current?.offsetHeight ?? 0) + MARGIN;
    const count = shownCards.length + approvalCards.length;
    if (count === 0 || shownCards.length < shownCountRef.current) hoveringRef.current = hoverAfter("removed");
    shownCountRef.current = shownCards.length;
    if (!typing) keyboardRef.current = false;
    if (applied.current.count === count && applied.current.height === height) return;
    applied.current = { count, height };
    void applyWindow(count, Math.max(height, 1), keyboardRef.current);
  }, [shownCards, approvalCards, typing]);

  const onCardClick = useCallback((card: Card) => {
    void openTarget(card.kind, card.id);
    setCards((prev) => prev.filter((item) => item.key !== card.key));
  }, []);

  const dismiss = useCallback((key: number) => setCards((prev) => prev.filter((item) => item.key !== key)), []);

  const { hidden, visible } = toastStack(shownCards);
  const stop = (event: MouseEvent) => event.stopPropagation();

  return (
    <div className="toaster">
      <div
        className="toaster__stack"
        ref={stackRef}
        onMouseEnter={() => {
          hoveringRef.current = hoverAfter("enter");
        }}
        onMouseMove={() => {
          hoveringRef.current = hoverAfter("move");
        }}
        onMouseLeave={() => {
          hoveringRef.current = hoverAfter("leave");
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
            <ApprovalRequest request={request} compact reasonField={false} onOpenSession={openApprovalSession} onTextFocus={onTextFocus} />
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
