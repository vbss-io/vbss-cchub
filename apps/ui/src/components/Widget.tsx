import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { fetchSessions, focusSession, reportUiError, subscribe } from "../api";
import { sessionClient, isHubRun } from "../clients";
import {
  fetchLimits,
  fetchUsageSummary,
  getSettings,
  listTasks,
  type DelegationSettings,
  type LimitsSnapshot,
  type ProviderUsage,
  type TaskRecord,
  type TaskStatus,
  type UsageSummary,
  type WidgetEdge,
  type WidgetPanel,
} from "../delegation";
import { taskBranch, taskIsolation } from "../delegation-actions";
import { IconChevron, IconCode, IconCodex, IconStar } from "../icons";
import { isMock, MOCK_SESSIONS } from "../mock";
import { folderPeers } from "../peers";
import { isEmpty, isStale } from "../stale";
import type { SessionRecord } from "../types";
import {
  clampPercent,
  dockRect,
  formatTokens,
  offsetFromPosition,
  resetCountdown,
  ringTone,
  urgencyTone,
  type Rect,
} from "../widget-layout";
import { BrandMark } from "./BrandMark";
import { inFlight, needsYou } from "./TaskCard";
import "../widget.css";

const inTauri = (): boolean => "__TAURI_INTERNALS__" in window;

interface WidgetConfig {
  edge: WidgetEdge;
  rings: { claude: boolean; codex: boolean };
  panel: WidgetPanel;
  autostart: boolean;
  refreshMinutes: number;
  usageFeature: boolean;
  limitsFeature: boolean;
}

const DEFAULT_CONFIG: WidgetConfig = {
  edge: "right",
  rings: { claude: false, codex: false },
  panel: "sessions",
  autostart: true,
  refreshMinutes: 5,
  usageFeature: false,
  limitsFeature: false,
};

interface SettingsLike {
  widget?: Partial<Omit<DelegationSettings["widget"], "rings">> & { rings?: Partial<DelegationSettings["widget"]["rings"]> };
  limits?: Partial<DelegationSettings["limits"]>;
  features?: Partial<DelegationSettings["features"]>;
}

const EDGES: readonly WidgetEdge[] = ["left", "right", "top"];

function configOf(settings: SettingsLike): WidgetConfig {
  const widget = settings.widget;
  const edge = EDGES.find((value) => value === widget?.edge) ?? DEFAULT_CONFIG.edge;
  const refresh = settings.limits?.refreshMinutes;
  return {
    edge,
    rings: { claude: widget?.rings?.claude === true, codex: widget?.rings?.codex === true },
    panel: widget?.panel === "usage" ? "usage" : "sessions",
    autostart: widget?.autostart !== false,
    refreshMinutes: typeof refresh === "number" && refresh >= 1 && refresh <= 60 ? refresh : DEFAULT_CONFIG.refreshMinutes,
    usageFeature: settings.features?.usage === true,
    limitsFeature: settings.features?.limits === true,
  };
}

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

interface MonitorLike {
  position: { x: number; y: number };
  size: { width: number; height: number };
  scaleFactor: number;
  workArea?: { position: { x: number; y: number }; size: { width: number; height: number } };
}

const TASKBAR_GUESS = 48;
const FALLBACK_AREA: Rect = { x: 0, y: 0, width: 1280, height: 720 };

function workAreaOf(monitor: MonitorLike | null): Rect {
  if (!monitor) return FALLBACK_AREA;
  const scale = monitor.scaleFactor || 1;
  if (monitor.workArea) {
    return {
      x: monitor.workArea.position.x / scale,
      y: monitor.workArea.position.y / scale,
      width: monitor.workArea.size.width / scale,
      height: monitor.workArea.size.height / scale,
    };
  }
  return {
    x: monitor.position.x / scale,
    y: monitor.position.y / scale,
    width: monitor.size.width / scale,
    height: monitor.size.height / scale - TASKBAR_GUESS,
  };
}

const monitorKey = (monitor: MonitorLike | null): string => {
  if (!monitor) return "none";
  const area = workAreaOf(monitor);
  return [monitor.position.x, monitor.position.y, monitor.scaleFactor, area.x, area.y, area.width, area.height].join(":");
};

const offsetKey = (edge: WidgetEdge): string => `widget.offset.${edge}`;

function readOffset(edge: WidgetEdge): number {
  try {
    const value = Number(localStorage.getItem(offsetKey(edge)));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeOffset(edge: WidgetEdge, offset: number): void {
  try {
    localStorage.setItem(offsetKey(edge), String(offset));
  } catch {
    return;
  }
}

const TAB_KEY = "widget.tab";

function readTab(): WidgetPanel | null {
  try {
    const value = localStorage.getItem(TAB_KEY);
    return value === "sessions" || value === "usage" ? value : null;
  } catch {
    return null;
  }
}

function writeTab(tab: WidgetPanel | null): void {
  try {
    if (tab === null) localStorage.removeItem(TAB_KEY);
    else localStorage.setItem(TAB_KEY, tab);
  } catch {
    return;
  }
}

const logWidget = (step: string, err: unknown): void => {
  void reportUiError("widget", err instanceof Error ? new Error(`${step}: ${err.message}`) : new Error(`${step}: ${String(err)}`), null);
};

async function currentMonitorLike(): Promise<MonitorLike | null> {
  const { currentMonitor } = await import("@tauri-apps/api/window");
  return (await currentMonitor()) as unknown as MonitorLike | null;
}

async function applyDock(edge: WidgetEdge, collapsed: boolean, showNow: boolean): Promise<string> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");
  const win = getCurrentWindow();
  const monitor = await currentMonitorLike();
  const rect = dockRect(edge, collapsed, workAreaOf(monitor), readOffset(edge));
  const attempt = async (step: () => Promise<unknown>): Promise<void> => {
    try {
      await step();
    } catch {
      return;
    }
  };
  await attempt(() => win.setSize(new LogicalSize(rect.width, rect.height)));
  await attempt(() => win.setPosition(new LogicalPosition(rect.x, rect.y)));
  await attempt(() => win.setAlwaysOnTop(true));
  await attempt(() => win.setFocusable(!collapsed));
  if (showNow) await attempt(() => win.show());
  return monitorKey(monitor);
}

const OPEN_ROTATION: Record<WidgetEdge, number> = { left: 0, right: 180, top: 90 };

function Arrow({ edge, closing }: { edge: WidgetEdge; closing: boolean }) {
  const rotation = (OPEN_ROTATION[edge] + (closing ? 180 : 0)) % 360;
  return (
    <span className="wgd-arrow" style={{ transform: `rotate(${rotation}deg)` }}>
      <IconChevron size={14} />
    </span>
  );
}

const PROVIDER_NAME = { claude: "Claude", codex: "Codex" } as const;

interface RingProps {
  provider: "claude" | "codex";
  percent: number;
  resetsAt: number | null;
  now: number;
}

function Ring({ provider, percent, resetsAt, now }: RingProps) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const shown = clampPercent(percent);
  const reset = resetCountdown(resetsAt, now);
  const title = `${PROVIDER_NAME[provider]} 7d: ${Math.round(shown)}%${reset ? ` · resets in ${reset}` : ""}`;
  return (
    <span className={`wgd-ring wgd-ring--${ringTone(percent)}`} title={title}>
      <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden="true">
        <circle className="wgd-ring-track" cx={9} cy={9} r={radius} />
        <circle
          className="wgd-ring-arc"
          cx={9}
          cy={9}
          r={radius}
          strokeDasharray={`${(circumference * shown) / 100} ${circumference}`}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="wgd-ring-ico">{provider === "claude" ? <IconCode size={8} /> : <IconCodex size={8} />}</span>
    </span>
  );
}

interface GaugeProps {
  label: string;
  percent: number;
  resetsAt: number | null;
  now: number;
}

function Gauge({ label, percent, resetsAt, now }: GaugeProps) {
  const shown = clampPercent(percent);
  const reset = resetCountdown(resetsAt, now);
  return (
    <div className="wgd-gauge">
      <span className="wgd-gauge-l">{label}</span>
      <span className="wgd-bar">
        <span className={`wgd-bar-fill wgd-bar-fill--${ringTone(percent)}`} style={{ width: `${shown}%` }} />
      </span>
      <span className="wgd-gauge-v">{Math.round(shown)}%</span>
      <span className="wgd-gauge-r">{reset ? `resets ${reset}` : ""}</span>
    </div>
  );
}

interface ProviderCardProps {
  provider: "claude" | "codex";
  usageEnabled: boolean;
  usage: UsageSummary | null | undefined;
  limitsEnabled: boolean;
  limits: LimitsSnapshot | null | undefined;
  now: number;
}

function tokenLine(read: number, output: number): string {
  return `read ${formatTokens(read)} · out ${formatTokens(output)}`;
}

function UsageLines({ data, days }: { data: ProviderUsage | null; days: number }) {
  if (!data) return <div className="wgd-note">No usage recorded.</div>;
  return (
    <>
      <div className="wgd-kv">
        <span>Today</span>
        <b>{tokenLine(data.today.read, data.today.output)}</b>
        <em>{data.today.messages} msgs</em>
      </div>
      <div className="wgd-kv">
        <span>{days}d</span>
        <b>{tokenLine(data.week.read, data.week.output)}</b>
        <em />
      </div>
    </>
  );
}

function ProviderCard({ provider, usageEnabled, usage, limitsEnabled, limits, now }: ProviderCardProps) {
  const providerUsage = usage ? usage.providers[provider] : null;
  const claude = provider === "claude" ? limits?.claude ?? null : null;
  const codex = provider === "codex" ? limits?.codex ?? null : null;
  return (
    <section className="wgd-card">
      <div className="wgd-card-h">
        <span className="wgd-card-ico">{provider === "claude" ? <IconCode size={13} /> : <IconCodex size={13} />}</span>
        {PROVIDER_NAME[provider]}
      </div>
      {!usageEnabled ? (
        <div className="wgd-note">Turn on Usage in Settings to see tokens.</div>
      ) : usage === undefined ? (
        <div className="wgd-note">Loading usage...</div>
      ) : usage === null ? (
        <div className="wgd-note">Usage needs a newer hub.</div>
      ) : (
        <UsageLines data={providerUsage} days={usage.days} />
      )}
      {!limitsEnabled ? (
        <div className="wgd-note">Turn on Limits in Settings to see the quota.</div>
      ) : limits === undefined ? (
        <div className="wgd-note">Loading limits...</div>
      ) : limits === null ? (
        <div className="wgd-note">Limits need a newer hub.</div>
      ) : claude ? (
        <>
          <Gauge label="5 h" percent={claude.fiveHour.utilization} resetsAt={claude.fiveHour.resetsAt} now={now} />
          <Gauge label="7 d" percent={claude.sevenDay.utilization} resetsAt={claude.sevenDay.resetsAt} now={now} />
          {claude.models.length > 0 && (
            <div className="wgd-models">
              {claude.models.map((model) => (
                <span key={model.name} className={`wgd-chip wgd-chip--${ringTone(model.utilization)}`}>
                  {model.name} {Math.round(clampPercent(model.utilization))}%
                </span>
              ))}
            </div>
          )}
        </>
      ) : codex ? (
        <>
          <Gauge label="5 h" percent={codex.primary.usedPercent} resetsAt={codex.primary.resetsAt} now={now} />
          <Gauge label="7 d" percent={codex.secondary.usedPercent} resetsAt={codex.secondary.resetsAt} now={now} />
        </>
      ) : (
        <div className="wgd-note">Limits are not tracked for {PROVIDER_NAME[provider]}.</div>
      )}
    </section>
  );
}

export function Widget() {
  const [sessions, setSessions] = useState<Record<string, SessionRecord>>({});
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [tick, setTick] = useState(0);
  const [config, setConfig] = useState<WidgetConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [tabPref, setTabPref] = useState<WidgetPanel | null>(readTab);
  const [limits, setLimits] = useState<LimitsSnapshot | null | undefined>(undefined);
  const [limitsTick, setLimitsTick] = useState(0);
  const [usage, setUsage] = useState<UsageSummary | null | undefined>(undefined);
  const openRef = useRef(false);
  const shown = useRef(false);
  const applying = useRef(false);
  const applyTimer = useRef<number | undefined>(undefined);
  const leaveTimer = useRef<number | undefined>(undefined);
  const lastMonitor = useRef("");
  const lastPanel = useRef<WidgetPanel | null>(null);
  const dragApi = useRef<(() => void) | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  const tab: WidgetPanel = tabPref ?? config.panel;
  const now = Date.now();

  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (lastPanel.current !== null && lastPanel.current !== config.panel) {
      writeTab(null);
      setTabPref(null);
    }
    lastPanel.current = config.panel;
  }, [config.panel]);

  const dock = useCallback(async (collapsed: boolean): Promise<void> => {
    if (!inTauri()) return;
    window.clearTimeout(applyTimer.current);
    applying.current = true;
    try {
      const first = !shown.current;
      lastMonitor.current = await applyDock(configRef.current.edge, collapsed, first && configRef.current.autostart);
      shown.current = true;
    } catch (err) {
      logWidget("dock", err);
    } finally {
      applyTimer.current = window.setTimeout(() => {
        applying.current = false;
      }, 600);
    }
  }, []);

  const expand = useCallback(async (): Promise<void> => {
    await dock(false);
    openRef.current = true;
    setOpen(true);
  }, [dock]);

  const collapse = useCallback(async (): Promise<void> => {
    window.clearTimeout(leaveTimer.current);
    openRef.current = false;
    setOpen(false);
    await dock(true);
  }, [dock]);

  useEffect(() => {
    if (isMock) {
      setSessions(Object.fromEntries(MOCK_SESSIONS.map((s) => [s.sessionId, s])));
      setLoaded(true);
      return;
    }
    let mounted = true;
    const reloadTasks = () => {
      void listTasks().then((list) => {
        if (mounted) setTasks(list);
      }).catch(() => undefined);
    };
    const reloadConfig = () => {
      void getSettings()
        .then((settings) => {
          if (!mounted) return;
          setConfig(configOf(settings));
          setLoaded(true);
        })
        .catch(() => undefined);
    };
    const fallback = window.setTimeout(() => {
      if (mounted) setLoaded(true);
    }, 4000);
    void fetchSessions().then((list) => {
      if (mounted) setSessions(Object.fromEntries(list.map((s) => [s.sessionId, s])));
    }).catch(() => undefined);
    reloadTasks();
    reloadConfig();
    const unsubscribe = subscribe({
      onOpen: reloadConfig,
      onSession: (session) => setSessions((prev) => ({ ...prev, [session.sessionId]: session })),
      onRemoved: (sessionId) =>
        setSessions((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        }),
      onDelegation: reloadTasks,
      onSettings: (settings) => setConfig(configOf(settings)),
      onLimits: () => setLimitsTick((value) => value + 1),
    });
    return () => {
      mounted = false;
      window.clearTimeout(fallback);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    void dock(!openRef.current);
  }, [loaded, config.edge, dock]);

  useEffect(() => {
    if (!inTauri() || !loaded) return;
    const id = window.setInterval(() => {
      void currentMonitorLike()
        .then((monitor) => {
          if (lastMonitor.current !== "" && monitorKey(monitor) !== lastMonitor.current) void dock(!openRef.current);
        })
        .catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(id);
  }, [loaded, dock]);

  useEffect(() => {
    if (!inTauri()) return;
    void import("@tauri-apps/api/window").then((api) => {
      dragApi.current = () => void api.getCurrentWindow().startDragging();
    });
  }, []);

  useEffect(() => {
    if (!inTauri() || !loaded) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    const edge = config.edge;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const off = await getCurrentWindow().onMoved(({ payload }) => {
        if (applying.current || openRef.current) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          void currentMonitorLike()
            .then(async (monitor) => {
              const scale = monitor?.scaleFactor ?? 1;
              const offset = offsetFromPosition(edge, workAreaOf(monitor), { x: payload.x / scale, y: payload.y / scale });
              writeOffset(edge, offset);
              await dock(true);
            })
            .catch((err: unknown) => logWidget("drop", err));
        }, 300);
      });
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [loaded, config.edge, dock]);

  const wantLimits = config.limitsFeature && (config.rings.claude || config.rings.codex || (open && tab === "usage"));
  const refreshMs = config.refreshMinutes * 60_000;

  useEffect(() => {
    if (!wantLimits) {
      setLimits(undefined);
      return;
    }
    let alive = true;
    const load = () => {
      void fetchLimits().then((snapshot) => {
        if (alive) setLimits(snapshot);
      });
    };
    load();
    const id = window.setInterval(load, refreshMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [wantLimits, refreshMs, limitsTick, open]);

  const wantUsage = config.usageFeature && open && tab === "usage";

  useEffect(() => {
    if (!wantUsage) return;
    let alive = true;
    const load = () => {
      void fetchUsageSummary().then((summary) => {
        if (alive) setUsage(summary);
      });
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [wantUsage]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void collapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, collapse]);

  useEffect(() => {
    if (!open) return;
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => void collapse(), 3000);
    return () => window.clearTimeout(leaveTimer.current);
  }, [open, collapse]);

  const onPanelEnter = () => window.clearTimeout(leaveTimer.current);

  const onPanelLeave = () => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => void collapse(), 1500);
  };

  const onTabDown = (event: MouseEvent) => {
    if (event.button !== 0 || !dragApi.current) return;
    const startX = event.screenX;
    const startY = event.screenY;
    const move = (next: globalThis.MouseEvent) => {
      if (Math.abs(next.screenX - startX) + Math.abs(next.screenY - startY) < 5) return;
      cleanup();
      dragApi.current?.();
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", cleanup);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", cleanup);
  };

  const pickTab = (next: WidgetPanel) => {
    writeTab(next);
    setTabPref(next);
  };

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

  const goSession = (sessionId: string) => {
    void focusSession(sessionId);
    void collapse();
  };

  const goMain = (hash: string | null) => {
    void openMain(hash);
    void collapse();
  };

  const sessionRow = (session: SessionRecord, tone: string, sub: string) => {
    const peers = folderPeers(session.cwd, model.all, tasks, { sessionId: session.sessionId });
    return (
      <button
        key={session.sessionId}
        className="wg-row"
        title={session.cwd ?? nameOf(session)}
        onClick={() => goSession(session.sessionId)}
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
    <button key={task.id} className="wg-row" title={task.title} onClick={() => goMain(`#/tasks/${task.id}`)}>
      <span className="wg-ico">{task.runner === "codex" ? <IconCodex /> : <IconCode />}</span>
      <span className={`wg-dot wg-dot--${tone}`} />
      <span className="wg-title">{task.title}</span>
      {pill}
      <span className="wg-sub">{sub}</span>
    </button>
  );

  const hasRows =
    model.waiting.length + model.attentionTasks.length + model.running.length + model.delegated.length + model.doneRecent.length > 0;

  const tone = urgencyTone({ needYou: model.needYou, delegated: model.delegated.length, live: model.live.length });
  const claudeWeek = config.rings.claude ? limits?.claude?.sevenDay ?? null : null;
  const codexWeek = config.rings.codex ? limits?.codex?.secondary ?? null : null;

  const sessionsBody = (
    <>
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
    </>
  );

  const usageBody = (
    <>
      <ProviderCard
        provider="claude"
        usageEnabled={config.usageFeature}
        usage={usage}
        limitsEnabled={config.limitsFeature}
        limits={limits}
        now={now}
      />
      <ProviderCard
        provider="codex"
        usageEnabled={config.usageFeature}
        usage={usage}
        limitsEnabled={config.limitsFeature}
        limits={limits}
        now={now}
      />
    </>
  );

  return (
    <div className="wgd" data-edge={config.edge} data-open={open ? "1" : "0"}>
      {open ? (
        <section className="wgd-panel" onMouseEnter={onPanelEnter} onMouseMove={onPanelEnter} onMouseLeave={onPanelLeave}>
          <header className="wgd-head">
            <span className="wgd-brand">
              <BrandMark size={15} />
            </span>
            <span className="wgd-state">
              <b>{model.live.length}</b> live
              {" · "}
              <span className={model.needYou > 0 ? "wgd-state-attn" : undefined}>
                <b>{model.needYou}</b> need you
              </span>
              {" · "}
              <b>{model.delegated.length}</b> delegated
            </span>
            <button className="wgd-collapse" onClick={() => void collapse()} title="Collapse" aria-label="Collapse widget">
              <Arrow edge={config.edge} closing />
            </button>
          </header>
          <div className="wgd-tabs" role="tablist">
            <button className="wgd-tabbtn" role="tab" aria-selected={tab === "sessions"} onClick={() => pickTab("sessions")}>
              Sessions
              {model.needYou > 0 && <span className="wgd-tabn">{model.needYou}</span>}
            </button>
            <button className="wgd-tabbtn" role="tab" aria-selected={tab === "usage"} onClick={() => pickTab("usage")}>
              Usage
            </button>
          </div>
          <div className="wgd-body">{tab === "sessions" ? sessionsBody : usageBody}</div>
          <footer className="wgd-foot">
            <button className="wg-open" onClick={() => goMain(null)}>
              Open hub
            </button>
            <button className="wgd-link" onClick={() => goMain("#/usage")}>
              Usage
            </button>
          </footer>
        </section>
      ) : (
        <button
          className="wgd-tab"
          onMouseDown={onTabDown}
          onClick={() => void expand()}
          aria-label="Open CC Hub widget"
        >
          <Arrow edge={config.edge} closing={false} />
          <span className={`wgd-pip wgd-pip--${tone}`} title={model.needYou > 0 ? `${model.needYou} need you` : "CC Hub"}>
            {model.needYou > 0 ? model.needYou : null}
          </span>
          {(claudeWeek || codexWeek) && (
            <span className="wgd-rings">
              {claudeWeek && <Ring provider="claude" percent={claudeWeek.utilization} resetsAt={claudeWeek.resetsAt} now={now} />}
              {codexWeek && <Ring provider="codex" percent={codexWeek.usedPercent} resetsAt={codexWeek.resetsAt} now={now} />}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
