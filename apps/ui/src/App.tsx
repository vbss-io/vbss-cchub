import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { archiveCodexThread, archiveSession, createGroup, deleteCodexThread, deleteGroup, deleteSession, fetchCodexSessions, fetchGroups, fetchRuntimes, fetchSessions, focusSession, getHooks, hubBase, renameCodexThread, renameSession, reorderGroups, setHooks, setSessionFavorite, subscribe, unarchiveCodexThread, updateGroup, type HooksStatus, type ShareStreamEvent } from "./api";
import { isHubRun } from "./clients";
import { BrandMark, Wordmark } from "./components/BrandMark";
import { CodexDrawer } from "./components/CodexDrawer";
import { RuntimeBar } from "./components/RuntimeBar";
import { SessionDrawer } from "./components/SessionDrawer";
import { WhatsNew } from "./components/WhatsNew";
import { configureMcp, configureShell, DelegationDisabledError, getConnect, getSettings, listReports, listTasks, listWorkspaces, openWorkspace, updateSettings, type ConnectStatus, type DelegationSettings, type McpClient, type ReportRecord, type ShellKind, type TaskRecord, type WorkspaceRecord, getTunnel, updateTunnelSettings, type TunnelStatus, getAutostart, setAutostart, type AutostartStatus } from "./delegation";
import { IconFlow, IconReports, IconSessions, IconSettings, IconShare, IconTasks, IconWorkspaces } from "./icons";
import { isMock, MOCK_GROUPS, MOCK_SESSIONS } from "./mock";
import { notify, playSound, unlockAudio } from "./notify";
import { isEmpty, isStale } from "./stale";
import type { CodexSessionRecord, GroupRecord, RunEventMessage, RuntimeSnapshot, SessionRecord, SessionClient } from "./types";
import { FlowView } from "./views/FlowView";
import { ReportsView } from "./views/ReportsView";
import { SessionsView } from "./views/SessionsView";
import { SettingsView, type NotifSettings, type SettingsSection, type ThemeName } from "./views/SettingsView";
import { ShareView } from "./views/ShareView";
import { TasksView } from "./views/TasksView";
import { WorkspacesView } from "./views/WorkspacesView";
import { workspaceOf } from "./wsmatch";

type View = "sessions" | "flow" | "tasks" | "workspaces" | "reports" | "share" | "settings";

interface Route {
  view: View;
  param: string | null;
}

const VIEWS: { key: View; label: string; icon: ReactElement; subtitle: string }[] = [
  { key: "sessions", label: "Sessions", icon: <IconSessions />, subtitle: "Every Claude Code session on this machine, plus Codex threads" },
  { key: "flow", label: "Flow", icon: <IconFlow />, subtitle: "Workspaces, sessions, subagents and delegated tasks as a live map" },
  { key: "tasks", label: "Delegated", icon: <IconTasks />, subtitle: "Work handed to the hub by agents: follow, steer, cancel" },
  { key: "workspaces", label: "Workspaces", icon: <IconWorkspaces />, subtitle: "The same registry your wk alias uses" },
  { key: "reports", label: "Reports", icon: <IconReports />, subtitle: "What agents reported back" },
  { key: "share", label: "Share", icon: <IconShare />, subtitle: "Links so other people and their assistants can ask your Claude, on the LAN or through ngrok" },
  { key: "settings", label: "Settings", icon: <IconSettings />, subtitle: "Paths, hooks, connections, notifications, groups" },
];

const DEFAULT_NOTIF: NotifSettings = {
  attention: true,
  finished: true,
  desktop: true,
  sound: true,
  shares: true,
  clients: { terminal: true, vscode: true, wsl: true, "claude-desktop": false, headless: false, hub: false, share: false },
};

function loadNotif(): NotifSettings {
  try {
    const stored = JSON.parse(localStorage.getItem("hub.notifications") ?? "{}") as Partial<NotifSettings>;
    return { ...DEFAULT_NOTIF, ...stored, clients: { ...DEFAULT_NOTIF.clients, ...(stored.clients ?? {}) } };
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

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [sessions, setSessions] = useState<Record<string, SessionRecord>>({});
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
  const [theme, setTheme] = useState<ThemeName>(() => (localStorage.getItem("hub.theme") === "midnight" ? "midnight" : "dracula"));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("hub.theme", theme);
  }, [theme]);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const notifRef = useRef(notifSettings);
  const runListeners = useRef(new Set<(event: RunEventMessage) => void>());
  const shareListeners = useRef(new Set<(event: ShareStreamEvent) => void>());

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
  }, [notifSettings]);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(id);
  }, [notice]);

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
    void fetchSessions().then((list) => {
      if (mounted) setSessions(Object.fromEntries(list.map((session) => [session.sessionId, session])));
    });
    void fetchGroups().then((list) => {
      if (mounted) setGroups(list);
    });
    const unsubscribe = subscribe({
      onSession: (session) => {
        setSessions((prev) => {
          const before = prev[session.sessionId];
          const cfg = notifRef.current;
          const quiet = !(cfg.clients[(session.client ?? "terminal") as SessionClient] ?? true) || session.archivedAt != null;
          if (!quiet && (!before || before.status !== session.status)) {
            const label = session.customTitle ?? session.title ?? projectOf(session);
            if ((session.status === "waiting" || session.status === "idle") && cfg.attention) {
              if (cfg.desktop) void notify("VBSS CCHUB", `${label} • ${session.status === "waiting" ? "needs a decision" : "paused"}`);
              if (cfg.sound) {
                void playSound(session.status === "idle" ? "idle" : "attention");
                navigator.vibrate?.(session.status === "waiting" ? [90, 60, 90] : 160);
              }
            } else if (session.status === "ended" && before && cfg.finished) {
              if (cfg.desktop) void notify("VBSS CCHUB", `${label} • finished`);
              if (cfg.sound) void playSound("finished");
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
      onShareRequest: (request) => {
        if (mounted) setShareTick((value) => value + 1);
        const cfg = notifRef.current;
        if (request.status === "running" && cfg.shares) {
          const text = `${request.asker ?? request.label} • ${request.kind === "ask" ? "asked" : "requested"}: ${request.prompt.slice(0, 90)}`;
          if (cfg.desktop) void notify("VBSS CCHUB", text);
          if (cfg.sound) void playSound("attention");
        }
      },
      onTunnel: (status) => {
        if (mounted) setTunnel(status);
      },
      onShareStream: (event) => {
        for (const listener of shareListeners.current) listener(event);
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

  const liveSessions = useMemo(
    () => Object.values(sessions).filter((s) => s.archivedAt == null && s.status !== "ended" && !isStale(s) && !isEmpty(s) && !isHubRun(s.client)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, tick],
  );
  const attention = liveSessions.filter((s) => s.status === "waiting" || s.status === "idle").length;
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

  const ok = useCallback((text: string) => setNotice({ kind: "ok", text }), []);
  const fail = useCallback((text: string) => setNotice({ kind: "error", text }), []);

  const saveSettings = async (patch: Partial<DelegationSettings>) => {
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

  const current = VIEWS.find((item) => item.key === route.view) ?? VIEWS[0]!;
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

  return (
    <div className={`shell ${drawerSession || codexDrawerThread ? "shell--panel" : ""}`}>
      <nav className="nav" aria-label="Main">
        <div className="nav__brand">
          <BrandMark size={30} />
          <span className="nav__wm">
            <Wordmark />
            <span className="nav__slogan">Run many. Forget none.</span>
          </span>
        </div>
        <ul className="nav__list">
          {VIEWS.map((item) => {
            const badge =
              item.key === "sessions" ? attention : item.key === "tasks" ? hubRunning + hubAttention : item.key === "reports" ? 0 : 0;
            return (
              <li key={item.key}>
                <a className={`nav__item ${route.view === item.key ? "nav__item--on" : ""}`} href={`#/${item.key}`} title={item.label}>
                  <span className="nav__icon">{item.icon}</span>
                  <span className="nav__label">{item.label}</span>
                  {badge > 0 && <span className={`nav__badge ${item.key === "sessions" ? "nav__badge--attn" : ""}`}>{badge}</span>}
                </a>
              </li>
            );
          })}
        </ul>
        <div className="nav__foot">
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
          {!isMock && (
            <RuntimeBar
              runtimes={runtimes}
              claudeSessions={liveSessions.length}
              codexSessions={codexSessions.filter((session) => session.status !== "ended").length}
              hubRunning={hubRunning}
              hubAttention={hubAttention}
              onOpenHub={() => navigate("tasks")}
            />
          )}
        </header>

        {notice && <p className={`toast toast--${notice.kind}`}>{notice.text}</p>}

        <div className="content">
          {route.view === "sessions" && (
            <SessionsView
              sessions={sessions}
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
          {route.view === "flow" && (
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
          {route.view === "tasks" && (
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
          {route.view === "workspaces" && (
            <WorkspacesView
              workspaces={workspaces}
              settings={settings}
              enabled={hubEnabled}
              onChanged={loadHub}
              onOpenSettings={() => navigate("settings", "paths")}
              onNotice={ok}
              onError={fail}
            />
          )}
          {route.view === "reports" && <ReportsView reports={reports} enabled={hubEnabled} onOpenTask={(id) => navigate("tasks", id)} />}
          {route.view === "share" && (
            <ShareView
              enabled={hubEnabled}
              workspaces={workspaces}
              sessions={sessions}
              param={route.param}
              tick={shareTick}
              tunnel={tunnel}
              onTunnelChanged={setTunnel}
              subscribeShareStream={subscribeShareStream}
              ownerName={settings?.ownerName ?? ""}
              onOpenSettings={() => navigate("settings", "sharing")}
              onOpenTask={(id) => navigate("tasks", id)}
              onNotice={ok}
              onError={fail}
            />
          )}
          {route.view === "settings" && (
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
      </div>

      {drawerSession && (
        <SessionDrawer
          session={drawerSession}
          workspace={workspaceOf(workspaces, drawerSession.cwd)}
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
    </div>
  );
}
