import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { focusSession, reportUiDiag, reportUiError, requestNavigate, subscribe, type ToastCard } from "../api";
import { IconClose, IconSessions, IconShare, IconTasks } from "../icons";
import type { NotifEventKind } from "../notifications";

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
  sessionIdle: "ok",
  sessionFinished: "ok",
  taskCompleted: "ok",
  taskFailed: "hold",
  taskNeedsYou: "pend",
  shareAsk: "brand",
  shareImplement: "brand",
};

const SESSION_KINDS: ReadonlySet<NotifEventKind> = new Set(["sessionNeedsYou", "sessionIdle", "sessionFinished"]);

function iconFor(kind: NotifEventKind): ReactElement {
  if (kind === "shareAsk" || kind === "shareImplement") return <IconShare size={16} />;
  if (SESSION_KINDS.has(kind)) return <IconSessions size={16} />;
  return <IconTasks size={16} />;
}

function hashFor(kind: NotifEventKind, id: string): string {
  if (kind === "shareAsk" || kind === "shareImplement") return `#/share/${id}`;
  if (SESSION_KINDS.has(kind)) return "#/sessions";
  return `#/tasks/${id}`;
}

function relTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

interface Card extends ToastCard {
  key: number;
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
  void reportUiDiag({ window: "toast", shownAt: new Date().toISOString(), position: { x, y }, height, count });
}

async function openTarget(kind: NotifEventKind, id: string): Promise<void> {
  const hash = hashFor(kind, id);
  if (!inTauri()) {
    window.open(`${location.origin}${location.pathname}${hash}`, "_blank", "noopener");
    return;
  }
  if (SESSION_KINDS.has(kind)) {
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
  const hoveringRef = useRef(false);
  const seq = useRef(0);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const applied = useRef<{ count: number; height: number }>({ count: -1, height: -1 });

  const pushCard = useCallback((toast: ToastCard) => {
    void reportUiDiag({ window: "toast", lastToast: toast.title, lastToastAt: new Date().toISOString() });
    setCards((prev) => [...prev, { ...toast, key: seq.current++, lifetime: lifetimeOf(toast.kind), elapsed: 0 }]);
  }, []);

  useEffect(() => subscribe({ onSession: () => undefined, onToast: pushCard }), [pushCard]);

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
          <div key={card.key} className={`tcard tcard--${TONE[card.kind]}`} role="button" tabIndex={0} onClick={() => onCardClick(card)}>
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
