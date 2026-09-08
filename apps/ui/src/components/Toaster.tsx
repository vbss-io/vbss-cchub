import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { focusSession, reportUiError, requestNavigate, subscribe, type ShareRequestEvent } from "../api";
import { getTask, listTasks, type TaskStatus } from "../delegation";
import { IconClose, IconSessions, IconShare, IconTasks } from "../icons";
import { createNotifier, loadNotifEventConfig, type FiredEvent, type NotifEventKind, type NotifEventPayload } from "../notifications";
import type { SessionClient, SessionRecord } from "../types";

const inTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const MAX_VISIBLE = 4;
const AUTO_MS = 6_000;
const ATTENTION_MS = 10_000;
const TICK_MS = 250;
const WIDTH = 380;
const MARGIN = 16;
const TASKBAR_GUESS = 48;

const ATTENTION: ReadonlySet<NotifEventKind> = new Set(["sessionNeedsYou", "taskNeedsYou", "taskFailed"]);
const lifetimeOf = (kind: NotifEventKind): number => (ATTENTION.has(kind) ? ATTENTION_MS : AUTO_MS);

const TONE: Record<NotifEventKind, string> = {
  sessionNeedsYou: "pend",
  sessionFinished: "ok",
  taskCompleted: "ok",
  taskFailed: "hold",
  taskNeedsYou: "pend",
  shareAsk: "brand",
  shareImplement: "brand",
};

function iconFor(kind: NotifEventKind): ReactElement {
  if (kind === "shareAsk" || kind === "shareImplement") return <IconShare size={16} />;
  if (kind === "sessionNeedsYou" || kind === "sessionFinished") return <IconSessions size={16} />;
  return <IconTasks size={16} />;
}

function hashFor(kind: NotifEventKind, id: string): string {
  if (kind === "shareAsk" || kind === "shareImplement") return `#/share/${id}`;
  if (kind === "sessionNeedsYou" || kind === "sessionFinished") return "#/sessions";
  return `#/tasks/${id}`;
}

function relTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function loadClients(): Record<string, boolean> {
  try {
    const stored = JSON.parse(localStorage.getItem("hub.notifications") ?? "{}") as { clients?: Record<string, boolean> };
    return stored.clients ?? {};
  } catch {
    return {};
  }
}

interface Card {
  key: number;
  kind: NotifEventKind;
  id: string;
  title: string;
  body: string;
  at: number;
  lifetime: number;
  elapsed: number;
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
}

async function openTarget(kind: NotifEventKind, id: string): Promise<void> {
  const hash = hashFor(kind, id);
  if (!inTauri()) {
    window.open(`${location.origin}${location.pathname}${hash}`, "_blank", "noopener");
    return;
  }
  if (kind === "sessionNeedsYou" || kind === "sessionFinished") {
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

export function Toaster(): ReactElement {
  const [cards, setCards] = useState<Card[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const configRef = useRef(loadNotifEventConfig());
  const clientsRef = useRef<Record<string, boolean>>(loadClients());
  const hoveringRef = useRef(false);
  const seq = useRef(0);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const applied = useRef<{ count: number; height: number }>({ count: -1, height: -1 });

  const pushCard = useCallback((record: FiredEvent) => {
    if (configRef.current.style === "windows") return;
    setCards((prev) => [
      ...prev,
      {
        key: seq.current++,
        kind: record.kind,
        id: record.id,
        title: record.title,
        body: record.body,
        at: record.at,
        lifetime: lifetimeOf(record.kind),
        elapsed: 0,
      },
    ]);
  }, []);

  const notifier = useMemo(
    () =>
      createNotifier({
        getConfig: () => configRef.current,
        send: () => {},
        sound: () => {},
        now: () => Date.now(),
        onFired: pushCard,
      }),
    [pushCard],
  );

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "hub.notifications") {
        configRef.current = loadNotifEventConfig();
        clientsRef.current = loadClients();
      } else if (event.key === "hub.toast.test") {
        notifier.notifyEvent("taskCompleted", {
          id: `test-${event.newValue ?? Date.now()}`,
          title: "Test notification",
          detail: "This is a CC Hub toast.",
        });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [notifier]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __cchubToaster: unknown }).__cchubToaster = {
      push: (kind: NotifEventKind, payload: NotifEventPayload) => notifier.notifyEvent(kind, payload),
      clear: () => setCards([]),
    };
  }, [notifier]);

  useEffect(() => {
    let lastTick = Date.now();
    const tick = () => {
      const current = Date.now();
      const delta = Math.min(current - lastTick, ATTENTION_MS);
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

  useEffect(() => {
    const sessionStatus = new Map<string, string>();
    const taskStatus = new Map<string, TaskStatus>();
    let mounted = true;

    void listTasks()
      .then((list) => {
        for (const task of list) taskStatus.set(task.id, task.status);
      })
      .catch(() => undefined);

    const reloadTasks = () => {
      void listTasks()
        .then((list) => {
          if (!mounted) return;
          for (const task of list) {
            const before = taskStatus.get(task.id);
            taskStatus.set(task.id, task.status);
            if (before === undefined || before === task.status) continue;
            if (task.status === "completed") {
              void getTask(task.id)
                .then((detail) => {
                  const result = [...detail.runs].reverse().find((run) => run.result)?.result ?? null;
                  notifier.notifyEvent("taskCompleted", { id: task.id, title: task.title, detail: result });
                })
                .catch(() => notifier.notifyEvent("taskCompleted", { id: task.id, title: task.title, detail: null }));
            } else if (task.status === "failed") {
              notifier.notifyEvent("taskFailed", { id: task.id, title: task.title, detail: task.lastError });
            } else if (task.status === "attention") {
              notifier.notifyEvent("taskNeedsYou", { id: task.id, title: task.title, detail: task.lastError });
            }
          }
        })
        .catch(() => undefined);
    };

    const unsubscribe = subscribe({
      onSession: (session: SessionRecord) => {
        const before = sessionStatus.get(session.sessionId);
        sessionStatus.set(session.sessionId, session.status);
        const clientOn = clientsRef.current[(session.client ?? "terminal") as SessionClient] ?? true;
        if (!clientOn || session.archivedAt != null || before === session.status) return;
        const label = session.customTitle ?? session.title ?? session.sessionId.slice(0, 8);
        if (session.status === "waiting" || session.status === "idle") {
          notifier.notifyEvent("sessionNeedsYou", {
            id: session.sessionId,
            name: label,
            detail: session.status === "waiting" ? "needs a decision" : "paused",
          });
        } else if (session.status === "ended" && before) {
          notifier.notifyEvent("sessionFinished", { id: session.sessionId, name: label });
        }
      },
      onDelegation: reloadTasks,
      onShareRequest: (request: ShareRequestEvent) => {
        if (request.status !== "running") return;
        notifier.notifyEvent(request.kind === "ask" ? "shareAsk" : "shareImplement", {
          id: request.id,
          label: request.label,
          asker: request.asker,
          detail: request.prompt,
        });
      },
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [notifier]);

  useLayoutEffect(() => {
    const height = (stackRef.current?.offsetHeight ?? 0) + MARGIN;
    if (applied.current.count === cards.length && applied.current.height === height) return;
    applied.current = { count: cards.length, height };
    void applyWindow(cards.length, Math.max(height, 1));
  }, [cards]);

  const onCardClick = useCallback((card: Card) => {
    void openTarget(card.kind, card.id);
    setCards((prev) => prev.filter((item) => item.key !== card.key));
  }, []);

  const dismiss = useCallback((key: number) => setCards((prev) => prev.filter((item) => item.key !== key)), []);

  const hidden = Math.max(0, cards.length - MAX_VISIBLE);
  const visible = cards.slice(hidden);
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
        {visible.map((card) => (
          <div
            key={card.key}
            className={`tcard tcard--${TONE[card.kind]}`}
            role="button"
            tabIndex={0}
            onClick={() => onCardClick(card)}
          >
            <span className="tcard__icon">{iconFor(card.kind)}</span>
            <div className="tcard__main">
              <div className="tcard__title">{card.title}</div>
              {card.body && <div className="tcard__ctx">{card.body}</div>}
              <div className="tcard__time">{relTime(card.at, now)}</div>
            </div>
            <button
              className="tcard__close"
              onMouseDown={stop}
              onClick={(event) => {
                event.stopPropagation();
                dismiss(card.key);
              }}
              aria-label="Dismiss"
            >
              <IconClose size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
