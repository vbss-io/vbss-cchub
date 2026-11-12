import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { archiveCodexThread, archiveSession, createGroup, deleteCodexThread, deleteGroup, deleteSession, fetchClaims, fetchCodexSessions, fetchGroups, fetchRuntimes, fetchSessions, focusCodexApp, focusSession, getHooks, hubBase, releaseClaim, renameCodexThread, renameSession, reorderGroups, reportUiDiag, setHooks, setSessionFavorite, subscribe, unarchiveCodexThread, updateGroup, type ClaimRecord, type DailyStreamEvent, type HooksStatus, type ShareStreamEvent, type TasksBoardStreamEvent } from "./api";
import { attentionCount } from "./attention";
import { isHubRun } from "./clients";
import { BrandMark, Wordmark } from "./components/BrandMark";
import { CodexDrawer } from "./components/CodexDrawer";
import { CommandPalette } from "./components/CommandPalette";
import { SessionDrawer } from "./components/SessionDrawer";
import { StatusBar } from "./components/StatusBar";
import { WhatsNew } from "./components/WhatsNew";
import { configureMcp, configureShell, createBackup, DelegationDisabledError, getConnect, getSettings, getTask, getTasksBoard, listReports, listTasks, listWorkspaces, openWorkspace, updateSettings, type BoardPayload, type ConnectStatus, type DelegationSettings, type McpClient, type ReportRecord, type SettingsPatch, type ShellKind, type TaskRecord, type TaskStatus, type WorkspaceRecord, getTunnel, updateTunnelSettings, type TunnelStatus, getAutostart, setAutostart, type AutostartStatus, fetchLimits, type LimitsSnapshot } from "./delegation";
import { IconBoard, IconChevron, IconClose, IconFlow, IconMore, IconReports, IconSearch, IconSessions, IconSettings, IconShare, IconTasks, IconUsage, IconWorkspaces } from "./icons";
import { isMock, MOCK_GROUPS, MOCK_SESSIONS } from "./mock";
import { unlockAudio } from "./notify";
import { buildCommandItems, buildSessionItems, buildTaskItems, buildViewItems, buildWorkspaceItems } from "./palette-items";
import { useHotkeys } from "./use-hotkeys";
import { HubOfflineBanner } from "./components/HubOfflineBanner";
import { useHubConnection } from "./use-hub-connection";
import { DEFAULT_NOTIF_EVENTS, firedEvents, notifyEvent, resetFired, setNotifConfig } from "./notifications";
import { isEmpty, isStale } from "./stale";
import type { CodexSessionRecord, GroupRecord, RunEventMessage, RuntimeSnapshot, SessionRecord, SessionClient } from "./types";
import { BoardView } from "./views/BoardView";
import { DailyView } from "./views/DailyView";
import { FlowView } from "./views/FlowView";
import { ReportsView } from "./views/ReportsView";
import { SessionsView } from "./views/SessionsView";
import { SettingsView, type NotifSettings, type SettingsSection, type ThemeName } from "./views/SettingsView";
import { ShareView } from "./views/ShareView";
import { TasksView } from "./views/TasksView";
import { UsageView, type UsageEvent } from "./views/UsageView";
import { WorkspacesView } from "./views/WorkspacesView";
import { canToggleWidget, toggleWidgetWindow } from "./widget-toggle";
import { workspaceOf } from "./wsmatch";

type View = "sessions" | "daily" | "board" | "usage" | "flow" | "tasks" | "workspaces" | "reports" | "share" | "settings";

function IconDaily({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="15" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
      <path d="m8.5 14 2 2 4-4" />
    </svg>
  );
}

interface ToastAction {
  label: string;
  run: () => void;
}

interface Route {
  view: View;
  param: string | null;
}

const VIEWS: { key: View; label: string; icon: ReactElement; subtitle: string }[] = [
  { key: "sessions", label: "Sessions", icon: <IconSessions />, subtitle: "Every Claude Code session on this machine, plus Codex threads" },
  { key: "daily", label: "Daily", icon: <IconDaily />, subtitle: "Your day in the second brain: briefing, focus, meetings, sessions" },
  { key: "board", label: "Tasks", icon: <IconBoard />, subtitle: "Tasks from your second brain as a board: filter by project, move them, hand one to an agent" },
  { key: "usage", label: "Usage", icon: <IconUsage />, subtitle: "What burns your tokens on this machine, and how much of your plan is left" },
  { key: "flow", label: "Flow", icon: <IconFlow />, subtitle: "Workspaces, sessions, subagents and delegated tasks as a live map" },
  { key: "tasks", label: "Delegated", icon: <IconTasks />, subtitle: "Work handed to the hub by agents: follow, steer, cancel" },
  { key: "workspaces", label: "Workspaces", icon: <IconWorkspaces />, subtitle: "The same registry your wk alias uses" },
  { key: "reports", label: "Reports", icon: <IconReports />, subtitle: "What agents reported back" },
  { key: "share", label: "Share", icon: <IconShare />, subtitle: "Links so other people and their assistants can ask your Claude, on the LAN or through ngrok" },
  { key: "settings", label: "Settings", icon: <IconSettings />, subtitle: "Paths, hooks, connections, notifications, groups" },
];

const NAV_FIXED: View[] = ["sessions", "daily", "board", "flow"];
const NAV_MORE: View[] = ["tasks", "usage", "workspaces", "reports", "share"];
const LIMITS_REFRESH_MS = 300_000;

const NOTIF_VERSION = 3;

const DEFAULT_NOTIF: NotifSettings = {
  version: NOTIF_VERSION,
  enabled: true,
  desktop: true,
  sound: true,
  style: "cchub",
  events: { ...DEFAULT_NOTIF_EVENTS },
  clients: { terminal: true, vscode: true, wsl: true, "claude-desktop": false, headless: false, hub: false, share: false },
};

function loadNotif(): NotifSettings {
  try {
    const stored = JSON.parse(localStorage.getItem("hub.notifications") ?? "{}") as Partial<NotifSettings>;
    const storedEvents = stored.events ?? {};
    const events = stored.version === NOTIF_VERSION ? storedEvents : { ...storedEvents, sessionIdle: true, sessionFinished: true };
    return {
      ...DEFAULT_NOTIF,
      ...stored,
      version: NOTIF_VERSION,
      events: { ...DEFAULT_NOTIF.events, ...events },
      clients: { ...DEFAULT_NOTIF.clients, ...(stored.clients ?? {}) },
    };
  } catch {
    return DEFAULT_NOTIF;
  }
}

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const view = VIEWS.find((item) => item.key === parts[0])?.key ?? "sessions";
  return { view, param: parts[1] ?? null };
}

const projectOf = (session: SessionRecord): string => {
  if (!session.cwd) return session.sessionId.slice(0, 8);
  const parts = session.cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? session.cwd;
};

interface NavMoreItem {
  key: View;
  label: string;
  icon: ReactElement;
  badge: number;
}

function NavMore({ items, activeKey }: { items: NavMoreItem[]; activeKey: View }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLLIElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocus = useRef<"first" | "last" | null>(null);
  const menuId = useId();
  const activeItem = items.find((item) => item.key === activeKey) ?? null;
  const collapsedBadge = items.reduce((total, item) => total + item.badge, 0);

  const menuItems = () => Array.from(rootRef.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (!open) return;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    const list = menuItems();
    if (target === "first") list[0]?.focus();
    if (target === "last") list[list.length - 1]?.focus();
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLLIElement>) => {
    const onButton = event.target === buttonRef.current;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if (onButton && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const target = event.key === "ArrowDown" ? "first" : "last";
      if (open) {
        const list = menuItems();
        (target === "first" ? list[0] : list[list.length - 1])?.focus();
      } else {
        pendingFocus.current = target;
        setOpen(true);
      }
      return;
    }
    if (onButton || !open) return;
    const list = menuItems();
    const index = list.findIndex((node) => node === document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      list[list.length - 1]?.focus();
    } else if (event.key === " ") {
      event.preventDefault();
      list[index]?.click();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <li className="nav__more" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className={`nav__item nav__item--button ${activeItem && !open ? "nav__item--on" : ""} ${open ? "nav__item--open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={activeItem ? `More: ${activeItem.label}` : "More"}
        onClick={(event) => {
          pendingFocus.current = !open && event.detail === 0 ? "first" : null;
          setOpen((value) => !value);
        }}
      >
        <span className="nav__icon">
          <IconMore size={20} />
        </span>
        <span className="nav__label nav__label--stack">
          <span>More</span>
          {activeItem && !open && <span className="nav__sub">{activeItem.label}</span>}
        </span>
        {!open && collapsedBadge > 0 && <span className="nav__badge">{collapsedBadge}</span>}
        <span className={`nav__chev ${open ? "nav__chev--open" : ""}`} aria-hidden="true">
          <IconChevron />
        </span>
      </button>
      {open && (
        <ul className="nav__menu" id={menuId} role="menu" aria-label="More views">
          {items.map((item) => (
            <li key={item.key} role="none">
              <a
                role="menuitem"
                tabIndex={-1}
                className={`nav__item nav__item--sub ${activeKey === item.key ? "nav__item--on" : ""}`}
                href={`#/${item.key}`}
                aria-current={activeKey === item.key ? "page" : undefined}
                onClick={() => setOpen(false)}
              >
                <span className="nav__icon">{item.icon}</span>
                <span className="nav__label">{item.label}</span>
                {item.badge > 0 && <span className="nav__badge">{item.badge}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [sessions, setSessions] = useState<Record<string, SessionRecord>>({});
  const [claims, setClaims] = useState<ClaimRecord[]>([]);
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [hooks, setHooksState] = useState<HooksStatus | null>(null);
  const [hooksBusy, setHooksBusy] = useState(false);
  const [runtimes, setRuntimes] = useState<RuntimeSnapshot | null>(null);
  const [codexSessions, setCodexSessions] = useState<CodexSessionRecord[]>([]);
  const [hubEnabled, setHubEnabled] = useState(true);
  const [settings, setSettings] = useState<DelegationSettings | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [connect, setConnect] = useState<ConnectStatus | null>(null);
  const [tick, setTick] = useState(0);
  const [hubTick, setHubTick] = useState(0);
  const [notifSettings, setNotifSettings] = useState<NotifSettings>(loadNotif);
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [seenVersion, setSeenVersion] = useState(() => localStorage.getItem("hub.seenVersion"));
  const [drawer, setDrawer] = useState<string | null>(null);
  const [codexDrawer, setCodexDrawer] = useState<string | null>(null);
  const [shareTick, setShareTick] = useState(0);
  const [tunnel, setTunnel] = useState<TunnelStatus | null>(null);
  const [autostart, setAutostartState] = useState<AutostartStatus | null>(null);
  const [limits, setLimits] = useState<LimitsSnapshot | null>(null);
  const [theme, setTheme] = useState<ThemeName>(() => (localStorage.getItem("hub.theme") === "midnight" ? "midnight" : "dracula"));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteBoard, setPaletteBoard] = useState<BoardPayload | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("hub.theme", theme);
  }, [theme]);
  const [toasts, setToasts] = useState<{ id: number; kind: "ok" | "error"; text: string; action?: ToastAction }[]>([]);
  const toastSeq = useRef(0);
  const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null);
  const notifRef = useRef(notifSettings);
  const runListeners = useRef(new Set<(event: RunEventMessage) => void>());
  const shareListeners = useRef(new Set<(event: ShareStreamEvent) => void>());
  const dailyListeners = useRef(new Set<(event: DailyStreamEvent) => void>());
  const boardListeners = useRef(new Set<(event: TasksBoardStreamEvent) => void>());
  const usageListeners = useRef(new Set<(event: UsageEvent) => void>());
  const taskStatusRef = useRef(new Map<string, TaskStatus>());

  const navigate = useCallback((view: View, param?: string | null) => {
    location.hash = param ? `#/${view}/${param}` : `#/${view}`;
  }, []);

  const openSession = useCallback((id: string) => {
    setCodexDrawer(null);
    setDrawer(id);
  }, []);

  const openCodex = useCallback((id: string) => {
    setDrawer(null);
    setCodexDrawer(id);
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    notifRef.current = notifSettings;
    localStorage.setItem("hub.notifications", JSON.stringify(notifSettings));
    setNotifConfig({ enabled: notifSettings.enabled, desktop: notifSettings.desktop, sound: notifSettings.sound, style: notifSettings.style, events: notifSettings.events });
    void reportUiDiag({ window: "main", notif: { enabled: notifSettings.enabled, desktop: notifSettings.desktop, sound: notifSettings.sound, style: notifSettings.style, events: notifSettings.events, clients: notifSettings.clients } });
  }, [notifSettings]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __cchubNotifications: unknown }).__cchubNotifications = {
      fired: firedEvents,
      reset: resetFired,
      setEnabled: (value: boolean) => setNotifSettings((prev) => ({ ...prev, enabled: value })),
      setEvent: (kind: keyof NotifSettings["events"], value: boolean) =>
        setNotifSettings((prev) => ({ ...prev, events: { ...prev.events, [kind]: value } })),
    };
  }, []);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const loadHub = useCallback(async () => {
    try {
      const [nextSettings, nextWorkspaces, nextTasks, nextReports] = await Promise.all([getSettings(), listWorkspaces(), listTasks(), listReports()]);
      setSettings(nextSettings);
      setWorkspaces(nextWorkspaces);
      setTasks(nextTasks);
      setReports(nextReports);
      setHubEnabled(true);
    } catch (err) {
      if (err instanceof DelegationDisabledError) setHubEnabled(false);
    }
  }, []);

  const refreshAfterOutage = useCallback(() => {
    void loadHub();
    for (const listener of boardListeners.current) listener({ source: "hub", projectId: "" });
    for (const listener of dailyListeners.current) listener({ date: "", updatedAt: null, source: "hub", writeId: null, recovered: true });
    for (const listener of usageListeners.current) {
      listener("usage");
      listener("limits");
    }
  }, [loadHub]);
  const connection = useHubConnection(refreshAfterOutage);

  const loadConnect = useCallback(async () => {
    try {
      setConnect(await getConnect());
    } catch {
      setConnect(null);
    }
  }, []);

  useEffect(() => {
    if (isMock) {
      setHooksState({ installed: true, events: [], wsl: [{ distro: "Ubuntu-24.04", installed: true }] });
      setHubEnabled(false);
      return;
    }
    void getHooks()
      .then(setHooksState)
      .catch(() => setHooksState({ installed: false, events: [] }));
    void loadHub();
  }, [loadHub]);

  useEffect(() => {
    if (isMock) return;
    void loadHub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubTick]);

  useEffect(() => {
    const seen = taskStatusRef.current;
    for (const task of tasks) {
      const before = seen.get(task.id);
      seen.set(task.id, task.status);
      if (before === undefined || before === task.status) continue;
      if (task.status === "completed") {
        void getTask(task.id)
          .then((detail) => {
            const result = [...detail.runs].reverse().find((run) => run.result)?.result ?? null;
            const detailText =
              detail.task.isolation === "worktree" && detail.task.mergedAt == null
                ? `Worktree ready to merge${result ? ` · ${result}` : ""}`
                : result;
            notifyEvent("taskCompleted", { id: task.id, title: task.title, detail: detailText });
          })
          .catch(() => notifyEvent("taskCompleted", { id: task.id, title: task.title, detail: null }));
      } else if (task.status === "failed") {
        notifyEvent("taskFailed", { id: task.id, title: task.title, detail: task.lastError });
      } else if (task.status === "attention") {
        notifyEvent("taskNeedsYou", { id: task.id, title: task.title, detail: task.lastError });
      }
    }
  }, [tasks]);

  useEffect(() => {
    if (isMock || route.view !== "settings" || !hubEnabled) return;
    void getAutostart()
      .then(setAutostartState)
      .catch(() => setAutostartState(null));
    void loadConnect();
  }, [route.view, hubEnabled, loadConnect]);

  useEffect(() => {
    if (isMock) return;
    let mounted = true;
    const poll = () => {
      void fetchRuntimes()
        .then((snapshot) => {
          if (mounted) setRuntimes(snapshot);
        })
        .catch(() => undefined);
      void fetchCodexSessions()
        .then((list) => {
          if (mounted) setCodexSessions(list);
        })
        .catch(() => undefined);
    };
    poll();
    const id = setInterval(poll, 10_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (isMock) {
      setSessions(Object.fromEntries(MOCK_SESSIONS.map((s) => [s.sessionId, s])));
      setGroups(MOCK_GROUPS);
      return;
    }
    let mounted = true;
    const loadCore = () => {
      void fetchSessions()
        .then((list) => {
          if (mounted) setSessions(Object.fromEntries(list.map((session) => [session.sessionId, session])));
        })
        .catch(() => undefined);
      void fetchGroups()
        .then((list) => {
          if (mounted) setGroups(list);
        })
        .catch(() => undefined);
      void fetchClaims()
        .then((list) => {
          if (mounted) setClaims(list);
        })
        .catch(() => undefined);
    };
    loadCore();
    const unsubscribe = subscribe({
      onError: () => {
        if (mounted) connection.streamError();
      },
      onOpen: () => {
        if (!mounted) return;
        connection.streamOpen();
        loadCore();
        void loadHub();
        void loadConnect();
        void getHooks()
          .then((next) => {
            if (mounted) setHooksState(next);
          })
          .catch(() => undefined);
      },
      onSession: (session) => {
        setSessions((prev) => {
          const before = prev[session.sessionId];
          const cfg = notifRef.current;
          const quiet = !(cfg.clients[(session.client ?? "terminal") as SessionClient] ?? true) || session.archivedAt != null;
          if (!quiet && (!before || before.status !== session.status)) {
            const label = session.customTitle ?? session.title ?? projectOf(session);
            if (session.status === "waiting") {
              notifyEvent("sessionNeedsYou", { id: session.sessionId, name: label, detail: session.lastMessage ?? "needs a decision", sound: "attention" });
            } else if (session.status === "idle") {
              notifyEvent("sessionIdle", { id: session.sessionId, name: label, detail: session.lastMessage ?? "finished answering", sound: "idle" });
            } else if (session.status === "ended" && before) {
              notifyEvent("sessionFinished", { id: session.sessionId, name: label });
            }
          }
          return { ...prev, [session.sessionId]: session };
        });
      },
      onCodex: (list) => {
        if (mounted) setCodexSessions(list);
      },
      onRemoved: (sessionId) =>
        setSessions((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        }),
      onGroups: (nextGroups) => {
        if (mounted) setGroups(nextGroups);
      },
      onHooks: (nextHooks) => {
        if (mounted) setHooksState(nextHooks);
      },
      onDelegation: () => {
        if (mounted) setHubTick((value) => value + 1);
      },
      onReport: () => {
        if (mounted) setHubTick((value) => value + 1);
      },
      onRunEvent: (event) => {
        for (const listener of runListeners.current) listener(event);
      },
      onNavigate: (hash) => {
        location.hash = hash;
        if (!("__TAURI_INTERNALS__" in window)) return;
        void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
          const current = getCurrentWindow();
          await current.show();
          await current.unminimize();
          await current.setFocus();
        }).catch(() => undefined);
      },
      onShareRequest: (request) => {
        if (mounted) setShareTick((value) => value + 1);
        if (request.status !== "running") return;
        notifyEvent(request.kind === "ask" ? "shareAsk" : "shareImplement", {
          id: request.id,
          label: request.label,
          asker: request.asker,
          detail: request.prompt,
        });
      },
      onTunnel: (status) => {
        if (mounted) setTunnel(status);
      },
      onShareStream: (event) => {
        for (const listener of shareListeners.current) listener(event);
      },
      onClaims: (list) => {
        if (mounted) setClaims(list);
      },
      onDaily: (event) => {
        for (const listener of dailyListeners.current) listener(event);
      },
      onTasksBoard: (event) => {
        for (const listener of boardListeners.current) listener(event);
      },
      onUsage: () => {
        for (const listener of usageListeners.current) listener("usage");
      },
      onLimits: () => {
        for (const listener of usageListeners.current) listener("limits");
      },
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!hubEnabled || isMock) return;
    void getTunnel()
      .then(setTunnel)
      .catch(() => setTunnel(null));
  }, [hubEnabled, shareTick]);

  const subscribeShareStream = useCallback((listener: (event: ShareStreamEvent) => void) => {
    shareListeners.current.add(listener);
    return () => {
      shareListeners.current.delete(listener);
    };
  }, []);

  const subscribeRunEvents = useCallback((listener: (event: RunEventMessage) => void) => {
    runListeners.current.add(listener);
    return () => {
      runListeners.current.delete(listener);
    };
  }, []);

  const subscribeDaily = useCallback((listener: (event: DailyStreamEvent) => void) => {
    dailyListeners.current.add(listener);
    return () => {
      dailyListeners.current.delete(listener);
    };
  }, []);

  const subscribeBoard = useCallback((listener: (event: TasksBoardStreamEvent) => void) => {
    boardListeners.current.add(listener);
    return () => {
      boardListeners.current.delete(listener);
    };
  }, []);

  const subscribeUsage = useCallback((listener: (event: UsageEvent) => void) => {
    usageListeners.current.add(listener);
    return () => {
      usageListeners.current.delete(listener);
    };
  }, []);

  const liveSessions = useMemo(
    () => Object.values(sessions).filter((s) => s.archivedAt == null && s.status !== "ended" && !isStale(s) && !isEmpty(s) && !isHubRun(s.client)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, tick],
  );
  const attention = attentionCount(liveSessions);
  const hubRunning = tasks.filter((t) => t.status === "running" || t.status === "pending").length;
  const hubAttention = tasks.filter((t) => t.status === "attention" || t.status === "failed" || t.status === "interrupted").length;

  useEffect(() => {
    document.title = attention > 0 ? `(${attention}) VBSS CCHUB` : "VBSS CCHUB";
    const nav = navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (attention > 0) nav.setAppBadge?.(attention)?.catch(() => {});
    else nav.clearAppBadge?.()?.catch(() => {});
  }, [attention]);

  const toggleHooks = async () => {
    if (!hooks || hooksBusy) return;
    setHooksBusy(true);
    try {
      setHooksState(await setHooks(!hooks.installed));
    } finally {
      setHooksBusy(false);
    }
  };

  const pushToast = useCallback((kind: "ok" | "error", text: string, action?: ToastAction) => {
    const id = (toastSeq.current += 1);
    setToasts((current) => [...current, { id, kind, text, ...(action ? { action } : {}) }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), kind === "error" || action ? 8_000 : 4_000);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const ok = useCallback((text: string) => pushToast("ok", text), [pushToast]);
  const fail = useCallback((text: string) => pushToast("error", text), [pushToast]);

  const saveSettings = async (patch: SettingsPatch) => {
    try {
      setSettings(await updateSettings(patch));
      await loadHub();
      setConnect(null);
      await loadConnect();
      ok("Settings saved.");
    } catch (err) {
      fail(err instanceof Error ? err.message : "could not save");
    }
  };

  const shell = async (kind: ShellKind, action: "install" | "uninstall") => {
    try {
      await configureShell(kind, action);
      await loadConnect();
      ok(action === "install" ? "Alias installed. Reopen the terminal." : "Alias removed.");
    } catch (err) {
      fail(err instanceof Error ? err.message : "could not change the alias");
    }
  };

  const mcp = async (client: McpClient, action: "install" | "uninstall") => {
    try {
      await configureMcp(client, action);
      await loadConnect();
      ok(action === "install" ? "Connected. Restart the client so it loads the hub tools." : "Disconnected.");
    } catch (err) {
      fail(err instanceof Error ? err.message : "could not change the connection");
    }
  };

  const moveGroup = (id: string, direction: -1 | 1) => {
    const index = groups.findIndex((group) => group.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= groups.length) return;
    const ids = groups.map((group) => group.id);
    const moved = ids[index];
    const swap = ids[target];
    if (moved === undefined || swap === undefined) return;
    ids[index] = swap;
    ids[target] = moved;
    void reorderGroups(ids);
  };

  const dailyEnabled = settings?.features.daily === true;
  const usageEnabled = settings?.features.usage === true;
  const limitsEnabled = settings?.features.limits === true;
  const boardEnabled = settings?.features.tasks === true;
  const effectiveView: View =
    (route.view === "daily" && !dailyEnabled) || (route.view === "board" && !boardEnabled) || (route.view === "usage" && !usageEnabled) ? "sessions" : route.view;
  const current = VIEWS.find((item) => item.key === effectiveView) ?? VIEWS[0]!;
  const drawerSession = drawer ? (sessions[drawer] ?? null) : null;
  const codexDrawerThread = codexDrawer ? (codexSessions.find((thread) => thread.id === codexDrawer) ?? null) : null;
  const headRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const head = headRef.current;
    if (!head) return;
    const apply = () => document.documentElement.style.setProperty("--head-h", `${head.offsetHeight}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(head);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (isMock || !limitsEnabled) {
      setLimits(null);
      return;
    }
    let alive = true;
    const load = () => {
      void fetchLimits()
        .then((snapshot) => {
          if (alive) setLimits(snapshot);
        })
        .catch(() => undefined);
    };
    load();
    const id = setInterval(load, LIMITS_REFRESH_MS);
    const unsubscribe = subscribeUsage((event) => {
      if (event === "limits") load();
    });
    return () => {
      alive = false;
      clearInterval(id);
      unsubscribe();
    };
  }, [limitsEnabled, subscribeUsage]);

  const sharePanel = route.view === "share" && route.param != null;
  const featureOn = (key: View): boolean => (key !== "daily" || dailyEnabled) && (key !== "board" || boardEnabled) && (key !== "usage" || usageEnabled);
  const navViews = (keys: View[]) => keys.filter(featureOn).flatMap((key) => VIEWS.filter((item) => item.key === key));
  const moreItems = navViews(NAV_MORE).map((item) => ({
    key: item.key,
    label: item.label,
    icon: item.icon,
    badge: item.key === "tasks" ? hubRunning + hubAttention : 0,
  }));

  const viewRef = useRef<View>(effectiveView);
  const pendingEvent = useRef<{ view: View; name: string } | null>(null);

  useEffect(() => {
    setDrawer(null);
    setCodexDrawer(null);
  }, [effectiveView]);

  useEffect(() => {
    viewRef.current = effectiveView;
    const pending = pendingEvent.current;
    pendingEvent.current = null;
    if (pending && pending.view === effectiveView) window.dispatchEvent(new CustomEvent(pending.name));
  }, [effectiveView]);

  const goThenDispatch = useCallback(
    (view: View, name: string) => {
      if (viewRef.current === view) {
        window.dispatchEvent(new CustomEvent(name));
        return;
      }
      pendingEvent.current = { view, name };
      navigate(view);
    },
    [navigate],
  );

  const consumeBoardParam = useCallback(() => {
    history.replaceState(null, "", "#/board");
    setRoute({ view: "board", param: null });
  }, []);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useHotkeys([
    { combo: "ctrl+k", allowInInputs: true, handler: () => setPaletteOpen((open) => !open) },
    { combo: "ctrl+1", handler: () => featureOn("sessions") && navigate("sessions") },
    { combo: "ctrl+2", handler: () => featureOn("daily") && navigate("daily") },
    { combo: "ctrl+3", handler: () => featureOn("board") && navigate("board") },
    { combo: "ctrl+4", handler: () => featureOn("flow") && navigate("flow") },
    { combo: "ctrl+,", handler: () => navigate("settings") },
  ]);

  useEffect(() => {
    if (!paletteOpen || !boardEnabled || isMock) return;
    let alive = true;
    void getTasksBoard()
      .then((payload) => {
        if (alive) setPaletteBoard(payload);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [paletteOpen, boardEnabled]);

  const backupNow = useCallback(async () => {
    try {
      const { backup } = await createBackup();
      ok(`Backup created: ${backup.file.split(/[\\/]/).pop() ?? backup.file}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : "could not back up");
    }
  }, [ok, fail]);

  const openWorkspaceInEditor = useCallback(
    async (name: string) => {
      try {
        const outcome = await openWorkspace(name);
        if (!outcome.ok) throw new Error(outcome.error ?? "could not open");
        ok(`Opening ${name} with ${outcome.command}.`);
      } catch (err) {
        fail(err instanceof Error ? err.message : "could not open the workspace");
      }
    },
    [ok, fail],
  );

  const focusFromPalette = useCallback(
    async (focus: () => Promise<{ ok: boolean; reason?: string }>) => {
      try {
        const result = await focus();
        if (!result.ok) fail(result.reason ?? "could not focus the window");
      } catch (err) {
        fail(err instanceof Error ? err.message : "could not focus the window");
      }
    },
    [fail],
  );

  const paletteItems = useMemo(() => {
    if (!paletteOpen) return [];
    const views = VIEWS.map((item) => ({ key: item.key, label: item.label, subtitle: item.subtitle, enabled: featureOn(item.key) }));
    const items = [
      ...buildCommandItems({
        ...(boardEnabled ? { newTask: () => goThenDispatch("board", "cchub:board-new-task") } : {}),
        ...(dailyEnabled
          ? {
              planToday: () => goThenDispatch("daily", "cchub:daily-plan-today"),
              refreshDaily: () => goThenDispatch("daily", "cchub:daily-refresh"),
            }
          : {}),
        backupNow: () => void backupNow(),
        toggleTheme: () => setTheme((previous) => (previous === "midnight" ? "dracula" : "midnight")),
        themeHint: theme === "midnight" ? "Switch to Dracula" : "Switch to Midnight",
        installHooks: () => navigate("settings", "hooks"),
        ...(canToggleWidget()
          ? { toggleWidget: () => void toggleWidgetWindow().catch((err: unknown) => fail(err instanceof Error ? err.message : "could not toggle the widget")) }
          : {}),
      }),
      ...buildViewItems(views, (view, param) => navigate(view as View, param)),
      ...buildSessionItems(Object.values(sessions), codexSessions, workspaces, {
        classify: (session) => {
          if (session.archivedAt != null || session.helperOf || isHubRun(session.client) || isEmpty(session)) return null;
          return session.status !== "ended" && !isStale(session) ? "live" : "recent";
        },
        focus: (id) => void focusFromPalette(() => focusSession(id)),
        open: openSession,
        focusCodex: () => void focusFromPalette(focusCodexApp),
        openCodex,
      }),
      ...buildWorkspaceItems(workspaces, {
        open: (name) => void openWorkspaceInEditor(name),
        show: (name) => navigate("workspaces", encodeURIComponent(name)),
      }),
      ...(boardEnabled && paletteBoard ? buildTaskItems(paletteBoard.tasks, paletteBoard.projects, (id) => navigate("board", encodeURIComponent(id))) : []),
    ];
    return items;
  }, [paletteOpen, sessions, codexSessions, workspaces, paletteBoard, boardEnabled, dailyEnabled, usageEnabled, theme, tick, navigate, goThenDispatch, backupNow, openWorkspaceInEditor, focusFromPalette, openSession, openCodex, fail]);

  return (
    <div className={`shell ${drawerSession || codexDrawerThread || sharePanel ? "shell--panel" : ""}`}>
      {connection.offline && !isMock && <HubOfflineBanner />}
      <nav className="nav" aria-label="Main">
        <div className="nav__brand">
          <BrandMark size={30} />
          <span className="nav__wm">
            <Wordmark />
            <span className="nav__slogan">Run many. Forget none.</span>
          </span>
        </div>
        <div className="nav__search-slot">
          <button type="button" className="nav__search" onClick={() => setPaletteOpen(true)} aria-label="Search" aria-keyshortcuts="Control+K" title="Search (Ctrl K)">
            <IconSearch size={16} />
            <span className="nav__search-label">Search</span>
            <kbd className="nav__search-key">Ctrl K</kbd>
          </button>
        </div>
        <ul className="nav__list">
          {navViews(NAV_FIXED).map((item) => (
            <li key={item.key}>
              <a
                className={`nav__item ${effectiveView === item.key ? "nav__item--on" : ""}`}
                href={`#/${item.key}`}
                title={item.label}
                aria-current={effectiveView === item.key ? "page" : undefined}
              >
                <span className="nav__icon">{item.icon}</span>
                <span className="nav__label">{item.label}</span>
                {item.key === "sessions" && attention > 0 && <span className="nav__badge nav__badge--attn">{attention}</span>}
              </a>
            </li>
          ))}
          <NavMore items={moreItems} activeKey={effectiveView} />
        </ul>
        <div className="nav__foot">
          <a
            className={`nav__item nav__item--foot ${effectiveView === "settings" ? "nav__item--on" : ""}`}
            href="#/settings"
            title="Settings"
            aria-current={effectiveView === "settings" ? "page" : undefined}
          >
            <span className="nav__icon">
              <IconSettings />
            </span>
            <span className="nav__label">Settings</span>
          </a>
          <button
            className={`version ${seenVersion !== __APP_VERSION__ ? "version--new" : ""}`}
            onClick={() => {
              localStorage.setItem("hub.seenVersion", __APP_VERSION__);
              setSeenVersion(__APP_VERSION__);
              setShowWhatsNew(true);
            }}
            title="What's new"
          >
            v{__APP_VERSION__}
          </button>
        </div>
      </nav>

      <div className="main">
        <header className="head" ref={headRef}>
          <div className="head__title">
            <h1>{current.label}</h1>
            <p className="head__sub">{current.subtitle}</p>
          </div>
        </header>

        <div className="content">
          {effectiveView === "sessions" && (
            <SessionsView
              sessions={sessions}
              claims={claims}
              groups={groups}
              workspaces={workspaces}
              codexSessions={codexSessions}
              codexAppRunning={runtimes?.codexApp.running ?? false}
              tick={tick}
              onOpen={openSession}
              onFocus={(id) => void focusSession(id)}
              onArchive={(id) => void archiveSession(id)}
              onDelete={(id) => void deleteSession(id)}
              onRename={(id, title) => void renameSession(id, title)}
              onFavorite={(id, favorite) => {
                setSessions((prev) => {
                  const before = prev[id];
                  if (!before) return prev;
                  return { ...prev, [id]: { ...before, favoriteAt: favorite ? Date.now() : null } };
                });
                void setSessionFavorite(id, favorite);
              }}
              onOpenCodex={openCodex}
              onRenameCodex={(id, title) => void renameCodexThread(id, title)}
              onArchiveCodex={(id) => void archiveCodexThread(id)}
              onUnarchiveCodex={(id) => void unarchiveCodexThread(id)}
              onDeleteCodex={(id) => void deleteCodexThread(id)}
            />
          )}
          {effectiveView === "daily" && dailyEnabled && (
            <DailyView
              settings={settings}
              onOpenSession={openSession}
              onOpenTask={(id) => navigate("tasks", id)}
              subscribeDaily={subscribeDaily}
              subscribeBoard={subscribeBoard}
            />
          )}
          {effectiveView === "board" && boardEnabled && (
            <BoardView
              workspaces={workspaces}
              settings={settings}
              subscribeBoard={subscribeBoard}
              subscribeDaily={subscribeDaily}
              onOpenSettings={() => navigate("settings", "features")}
              openTaskId={route.param}
              onOpenTaskHandled={consumeBoardParam}
              onDelegated={(taskId, title) => pushToast("ok", `Delegated "${title}".`, { label: "Open task", run: () => navigate("tasks", taskId) })}
              onNotice={ok}
              onError={fail}
            />
          )}
          {effectiveView === "usage" && usageEnabled && (
            <UsageView settings={settings} sessions={sessions} onOpenSession={openSession} subscribeUsage={subscribeUsage} />
          )}
          {effectiveView === "flow" && (
            <FlowView
              sessions={sessions}
              codexSessions={codexSessions}
              tasks={tasks}
              workspaces={workspaces}
              groups={groups}
              onOpenSession={openSession}
              onOpenTask={(id) => navigate("tasks", id)}
              onOpenCodex={openCodex}
              onFocus={(id) => void focusSession(id)}
              onOpenWorkspace={(name) => void openWorkspace(name)}
            />
          )}
          {effectiveView === "tasks" && (
            <TasksView
              tasks={tasks}
              sessions={sessions}
              enabled={hubEnabled}
              selectedId={route.param}
              tick={hubTick}
              onSelect={(id) => navigate("tasks", id)}
              onOpenSession={openSession}
              subscribeRunEvents={subscribeRunEvents}
              onRefresh={loadHub}
              onOpenSettings={() => navigate("settings", "connect")}
              onError={fail}
            />
          )}
          {effectiveView === "workspaces" && (
            <WorkspacesView
              workspaces={workspaces}
              settings={settings}
              enabled={hubEnabled}
              focusName={route.param}
              onChanged={loadHub}
              onOpenSettings={() => navigate("settings", "paths")}
              onNotice={ok}
              onError={fail}
            />
          )}
          {effectiveView === "reports" && <ReportsView reports={reports} enabled={hubEnabled} onOpenTask={(id) => navigate("tasks", id)} />}
          {effectiveView === "share" && (
            <ShareView
              enabled={hubEnabled}
              workspaces={workspaces}
              sessions={sessions}
              param={route.param}
              tick={shareTick}
              tunnel={tunnel}
              onTunnelChanged={setTunnel}
              subscribeShareStream={subscribeShareStream}
              onOpenSettings={() => navigate("settings", "sharing")}
              onOpenTask={(id) => navigate("tasks", id)}
              onNotice={ok}
              onError={fail}
              panelHost={slotEl}
            />
          )}
          {effectiveView === "settings" && (
            <SettingsView
              enabled={hubEnabled}
              hubUrl={hubBase}
              version={__APP_VERSION__}
              section={(route.param as SettingsSection | null) ?? null}
              settings={settings}
              connect={connect}
              hooks={hooks}
              hooksBusy={hooksBusy}
              notif={notifSettings}
              groups={groups}
              onToggleHooks={() => void toggleHooks()}
              onSaveSettings={saveSettings}
              onShell={shell}
              onMcp={mcp}
              autostart={autostart}
              onAutostart={async (enabled) => {
                try {
                  const status = await setAutostart(enabled);
                  setAutostartState(status);
                  if (status.error) fail(status.error);
                  else ok(enabled ? "The hub will start with Windows." : "Autostart removed.");
                } catch (err) {
                  fail(err instanceof Error ? err.message : "could not change autostart");
                }
              }}
              theme={theme}
              onTheme={setTheme}
              tunnel={tunnel}
              onTunnelSettings={async (patch) => {
                try {
                  setTunnel(await updateTunnelSettings(patch));
                  ok("ngrok settings saved");
                } catch (err) {
                  fail(err instanceof Error ? err.message : "could not save");
                }
              }}
              onNotif={setNotifSettings}
              onWhatsNew={() => setShowWhatsNew(true)}
              onCreateGroup={(name, match) => void createGroup(name, match)}
              onUpdateGroup={(id, fields) => void updateGroup(id, fields)}
              onDeleteGroup={(id) => void deleteGroup(id)}
              onMoveGroup={moveGroup}
            />
          )}
        </div>

        {!isMock && (
          <StatusBar
            runtimes={runtimes}
            claudeSessions={liveSessions.length}
            codexSessions={codexSessions.filter((session) => session.status !== "ended").length}
            hubRunning={hubRunning}
            hubAttention={hubAttention}
            onOpenHub={() => navigate("tasks")}
            limits={limits}
            limitsEnabled={limitsEnabled}
            onOpenUsage={usageEnabled ? () => navigate("usage") : undefined}
          />
        )}
      </div>

      <div className="shell__slot" ref={setSlotEl} />

      {drawerSession && (
        <SessionDrawer
          session={drawerSession}
          workspace={workspaceOf(workspaces, drawerSession.cwd)}
          claims={claims.filter((claim) => claim.sessionId === drawerSession.sessionId)}
          onReleaseClaim={(id) => void releaseClaim(id)}
          onClose={() => setDrawer(null)}
          onShare={(id) => {
            setDrawer(null);
            navigate("share", `new:${id}`);
          }}
          onOpenTask={(id) => {
            setDrawer(null);
            navigate("tasks", id);
          }}
        />
      )}
      {codexDrawerThread && (
        <CodexDrawer
          thread={codexDrawerThread}
          workspace={workspaceOf(workspaces, codexDrawerThread.cwd)}
          onClose={() => setCodexDrawer(null)}
          onOpenTask={(id) => {
            setCodexDrawer(null);
            navigate("tasks", id);
          }}
        />
      )}
      {showWhatsNew && <WhatsNew onClose={() => setShowWhatsNew(false)} />}
      <CommandPalette open={paletteOpen} items={paletteItems} onClose={closePalette} />

      {toasts.length > 0 && (
        <div className="toasts" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast--${toast.kind}`} role="status">
              <span className="toast__text">{toast.text}</span>
              {toast.action && (
                <button
                  className="act"
                  onClick={() => {
                    toast.action?.run();
                    dismissToast(toast.id);
                  }}
                >
                  {toast.action.label}
                </button>
              )}
              <button className="toast__close" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
                <IconClose />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
