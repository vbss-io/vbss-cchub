import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { fetchSessions, focusSession, reportUiError, subscribe } from "../api";
import { ApprovalsProvider, useApprovalsStore, type ApprovalsStore } from "../approvals-context";
import { pendingLabel } from "../approvals-model";
import { sessionClient, isHubRun } from "../clients";
import {
  fetchLimits,
  fetchUsageSummary,
  isScanning,
  getSettings,
  listTasks,
  updateSettings,
  type DelegationSettings,
  type LimitsSnapshot,
  type ProviderUsage,
  type TaskRecord,
  type UsageSummary,
  type WidgetEdge,
  type WidgetPanel,
} from "../delegation";
import { taskBranch, taskIsolation } from "../delegation-actions";
import { IconChevron, IconClaude, IconCode, IconCodex, IconOpenAI, IconStar } from "../icons";
import { isMock, MOCK_SESSIONS } from "../mock";
import { folderPeers } from "../peers";
import { isPluginEnabled } from "../plugins/registry";
import { isEmpty, isStale } from "../stale";
import type { SessionRecord } from "../types";
import { turnOnOptimistically } from "../widget-turn-on";
import { clampPercent, compactRect, dockRect, offsetFromPosition, ringTone, type Rect } from "../widget-layout";
import {
  gaugeResetText,
  headline,
  moreLabel,
  periodLabel,
  pipTone,
  planSections,
  sessionRowMeta,
  sessionTone,
  splitSessions,
  taskRowMeta,
  taskTone,
  tokenLine,
  widgetSurface,
  type RowMeta,
  type SectionPlan,
  type WidgetTone,
} from "../widget-model";
import { ApprovalList } from "./ApprovalRequest";
import { BrandMark } from "./BrandMark";
import { inFlight, needsYou } from "./TaskCard";
import "../widget.css";

const inTauri = (): boolean => "__TAURI_INTERNALS__" in window;

interface WidgetConfig {
  enabled: boolean;
  edge: WidgetEdge;
  rings: { claude: boolean; codex: boolean };
  panel: WidgetPanel;
  autostart: boolean;
  refreshMinutes: number;
  usageFeature: boolean;
  limitsFeature: boolean;
  delegated: boolean;
}

const DEFAULT_CONFIG: WidgetConfig = {
  enabled: false,
  edge: "right",
  rings: { claude: false, codex: false },
  panel: "sessions",
  autostart: true,
  refreshMinutes: 5,
  usageFeature: false,
  limitsFeature: false,
  delegated: false,
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
    enabled: settings.features?.widget !== false,
    edge,
    rings: { claude: widget?.rings?.claude === true, codex: widget?.rings?.codex === true },
    panel: widget?.panel === "usage" ? "usage" : "sessions",
    autostart: widget?.autostart !== false,
    refreshMinutes: typeof refresh === "number" && refresh >= 1 && refresh <= 60 ? refresh : DEFAULT_CONFIG.refreshMinutes,
    usageFeature: settings.features?.usage === true,
    limitsFeature: settings.features?.limits === true,
    delegated: isPluginEnabled("delegated", settings.features),
  };
}

const nameOf = (session: SessionRecord): string =>
  session.customTitle ?? session.title ?? session.sessionId.slice(0, 8);

const liveSession = (session: SessionRecord): boolean =>
  session.archivedAt == null && session.status !== "ended" && !isStale(session) && !isEmpty(session) && !isHubRun(session.client);

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

async function applyDock(edge: WidgetEdge, collapsed: boolean, showNow: boolean, rings: number, compact = false): Promise<string> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");
  const win = getCurrentWindow();
  const monitor = await currentMonitorLike();
  const area = workAreaOf(monitor);
  const rect = compact ? compactRect(edge, area) : dockRect(edge, collapsed, area, readOffset(edge), rings);
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

async function hideWindow(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().hide();
}

const OPEN_ROTATION: Record<WidgetEdge, number> = { left: 0, right: 180, top: 90 };

function Arrow({ edge, closing }: { edge: WidgetEdge; closing: boolean }) {
  const rotation = (OPEN_ROTATION[edge] + (closing ? 180 : 0)) % 360;
  return (
    <span className="wgd-arrow" style={{ transform: `rotate(${rotation}deg)` }}>
      <IconChevron size={22} />
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
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const shown = clampPercent(percent);
  const reset = gaugeResetText(resetsAt, now, "sevenDay", provider === "codex");
  const title = `${PROVIDER_NAME[provider]} 7 d: ${Math.round(shown)}%${reset ? ` · ${reset}` : ""}`;
  return (
    <span className={`wgd-ring wgd-ring--${ringTone(percent)}`} title={title}>
      <svg width={36} height={36} viewBox="0 0 36 36" aria-hidden="true">
        <circle className="wgd-ring-track" cx={18} cy={18} r={radius} />
        <circle
          className="wgd-ring-arc"
          cx={18}
          cy={18}
          r={radius}
          strokeDasharray={`${(circumference * shown) / 100} ${circumference}`}
          transform="rotate(-90 18 18)"
        />
      </svg>
      <span className="wgd-ring-ico">{provider === "claude" ? <IconClaude size={17} /> : <IconOpenAI size={17} />}</span>
    </span>
  );
}

interface GaugeProps {
  label: string;
  percent: number;
  resetsAt: number | null;
  window: "fiveHour" | "sevenDay";
  requireReset?: boolean;
  reset?: boolean;
  now: number;
}

function Gauge({ label, percent, resetsAt, window, requireReset = false, reset, now }: GaugeProps) {
  if (reset) {
    return (
      <div className="wgd-gauge">
        <span className="wgd-gauge-l">{label}</span>
        <span className="wgd-bar" />
        <span className="wgd-gauge-v wgd-gauge-v--muted">reset · 0%</span>
        <span className="wgd-gauge-r" />
      </div>
    );
  }
  const shown = clampPercent(percent);
  const resetText = gaugeResetText(resetsAt, now, window, requireReset);
  return (
    <div className="wgd-gauge">
      <span className="wgd-gauge-l">{label}</span>
      <span className="wgd-bar">
        <span className={`wgd-bar-fill wgd-bar-fill--${ringTone(percent)}`} style={{ width: `${shown}%` }} />
      </span>
      <span className="wgd-gauge-v">{Math.round(shown)}%</span>
      <span className="wgd-gauge-r" title={resetText}>
        {resetText}
      </span>
    </div>
  );
}

interface ProviderCardProps {
  provider: "claude" | "codex";
  usageEnabled: boolean;
  usage: UsageSummary | null | undefined;
  usageScanning: boolean;
  limitsEnabled: boolean;
  limits: LimitsSnapshot | null | undefined;
  now: number;
}

function UsageLines({ data, days }: { data: ProviderUsage | null; days: number }) {
  if (!data) return <div className="wgd-note">No usage recorded.</div>;
  return (
    <>
      <div className="wgd-kv">
        <span>Today</span>
        <b title={tokenLine(data.today.read, data.today.output)}>{tokenLine(data.today.read, data.today.output)}</b>
        <em>{data.today.messages.toLocaleString()} messages</em>
      </div>
      <div className="wgd-kv">
        <span>{periodLabel(days)}</span>
        <b title={tokenLine(data.week.read, data.week.output)}>{tokenLine(data.week.read, data.week.output)}</b>
        <em />
      </div>
    </>
  );
}

function ProviderCard({ provider, usageEnabled, usage, usageScanning, limitsEnabled, limits, now }: ProviderCardProps) {
  const providerUsage = usage?.providers ? usage.providers[provider] : null;
  const claude = provider === "claude" ? limits?.claude ?? null : null;
  const codex = provider === "codex" ? limits?.codex ?? null : null;
  return (
    <section className="wgd-card">
      <div className="wgd-card-h">
        <span className="wgd-card-ico">{provider === "claude" ? <IconClaude size={18} /> : <IconOpenAI size={18} />}</span>
        {PROVIDER_NAME[provider]}
      </div>
      {!usageEnabled ? (
        <div className="wgd-note">Turn on Usage in Settings › Plugins to see tokens.</div>
      ) : usage === undefined ? (
        <div className="wgd-note">{usageScanning ? "Scanning transcripts..." : "Loading usage..."}</div>
      ) : usage === null ? (
        <div className="wgd-note">Usage needs a newer hub.</div>
      ) : (
        <>
          <UsageLines data={providerUsage} days={usage.days} />
          {usageScanning && <div className="wgd-note">Scanning transcripts...</div>}
        </>
      )}
      {!limitsEnabled ? (
        <div className="wgd-note">Turn on Limits in Settings › Plugins to see how much of your plan is left.</div>
      ) : limits === undefined ? (
        <div className="wgd-note">Loading limits...</div>
      ) : limits === null ? (
        <div className="wgd-note">Limits need a newer hub.</div>
      ) : claude?.source === "none" ? (
        <div className="wgd-note wgd-note--warn">{claude.error || "no Claude Code login found"}</div>
      ) : codex?.source === "none" ? (
        <div className="wgd-note wgd-note--warn">{codex.error || "no Codex session data found"}</div>
      ) : claude ? (
        <>
          <Gauge label="5 h" percent={claude.fiveHour.utilization} resetsAt={claude.fiveHour.resetsAt} window="fiveHour" reset={claude.fiveHour.reset} now={now} />
          <Gauge label="7 d" percent={claude.sevenDay.utilization} resetsAt={claude.sevenDay.resetsAt} window="sevenDay" reset={claude.sevenDay.reset} now={now} />
          {claude.models.length > 0 && (
            <div className="wgd-models">
              {claude.models.map((model, index) => (
                <span key={model.name} className="wgd-model" title={`${model.name} ${gaugeResetText(model.resetsAt, now, "sevenDay")}`.trim()}>
                  {index > 0 && <span className="wgd-sep">·</span>}
                  {model.name} <span className={`wgd-model-v wgd-model-v--${ringTone(model.utilization)}`}>{Math.round(clampPercent(model.utilization))}%</span>
                </span>
              ))}
            </div>
          )}
        </>
      ) : codex ? (
        <>
          <Gauge label="5 h" percent={codex.primary.usedPercent} resetsAt={codex.primary.resetsAt} window="fiveHour" requireReset reset={codex.primary.reset} now={now} />
          <Gauge label="7 d" percent={codex.secondary.usedPercent} resetsAt={codex.secondary.resetsAt} window="sevenDay" requireReset reset={codex.secondary.reset} now={now} />
        </>
      ) : (
        <div className="wgd-note">Limits are not tracked for {PROVIDER_NAME[provider]}.</div>
      )}
    </section>
  );
}

function RowTail({ meta }: { meta: RowMeta }) {
  const more = moreLabel(meta.extras);
  return (
    <>
      <span className="wg-meta">{meta.text}</span>
      {more && (
        <span className="wg-extra" title={meta.extras.join("\n")} aria-label={`${meta.extras.length} more: ${meta.extras.join(", ")}`} role="note">
          {more}
        </span>
      )}
    </>
  );
}

export function Widget() {
  const approvalsStore = useApprovalsStore();
  return (
    <ApprovalsProvider store={approvalsStore}>
      <WidgetView approvalsStore={approvalsStore} />
    </ApprovalsProvider>
  );
}

function WidgetView({ approvalsStore }: { approvalsStore: ApprovalsStore }) {
  const approvalHandlers = approvalsStore.handlers;
  const approvals = approvalsStore.list;
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
  const [usageScanning, setUsageScanning] = useState(false);
  const [usageTick, setUsageTick] = useState(0);
  const [turningOn, setTurningOn] = useState(false);
  const [turnOnError, setTurnOnError] = useState<string | null>(null);
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
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const ringCount = (config.rings.claude && limits?.claude?.sevenDay ? 1 : 0) + (config.rings.codex && limits?.codex?.secondary ? 1 : 0);
  const ringsRef = useRef(ringCount);
  ringsRef.current = ringCount;
  const dockedRings = useRef(ringCount);

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
      if (!configRef.current.enabled) {
        const wasShown = shown.current;
        shown.current = false;
        openRef.current = false;
        setOpen(false);
        if (wasShown) await hideWindow();
        lastMonitor.current = await applyDock(configRef.current.edge, false, false, 0, true);
        return;
      }
      const first = !shown.current;
      dockedRings.current = ringsRef.current;
      lastMonitor.current = await applyDock(configRef.current.edge, collapsed, first && configRef.current.autostart, ringsRef.current);
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

  const revealCompact = useCallback(async (): Promise<void> => {
    window.clearTimeout(applyTimer.current);
    applying.current = true;
    try {
      lastMonitor.current = await applyDock(configRef.current.edge, false, false, 0, true);
    } catch (err) {
      logWidget("reveal", err);
    } finally {
      applyTimer.current = window.setTimeout(() => {
        applying.current = false;
      }, 600);
    }
  }, []);

  const dismiss = useCallback(async (): Promise<void> => {
    if (!inTauri()) return;
    try {
      await hideWindow();
    } catch (err) {
      logWidget("dismiss", err);
    }
  }, []);

  const collapse = useCallback(async (): Promise<void> => {
    window.clearTimeout(leaveTimer.current);
    openRef.current = false;
    setOpen(false);
    await dock(true);
  }, [dock]);

  useEffect(() => {
    if (isMock) {
      setSessions(Object.fromEntries(MOCK_SESSIONS.map((s) => [s.sessionId, s])));
      setConfig({ ...DEFAULT_CONFIG, enabled: true, delegated: true });
      setLoaded(true);
      return;
    }
    let mounted = true;
    const reloadTasks = () => {
      void listTasks().then((list) => {
        if (mounted) setTasks(list);
      }).catch(() => undefined);
    };
    let retry: number | undefined;
    const reloadConfig = () => {
      window.clearTimeout(retry);
      void getSettings()
        .then((settings) => {
          if (!mounted) return;
          setConfig(configOf(settings));
          setLoaded(true);
        })
        .catch(() => {
          if (mounted) retry = window.setTimeout(reloadConfig, 3000);
        });
    };
    void fetchSessions().then((list) => {
      if (mounted) setSessions(Object.fromEntries(list.map((s) => [s.sessionId, s])));
    }).catch(() => undefined);
    reloadTasks();
    reloadConfig();
    const unsubscribe = subscribe({
      onOpen: () => {
        reloadConfig();
        approvalHandlers.reload();
      },
      onPermissionRequest: approvalHandlers.onPermissionRequest,
      onPermissionResolved: approvalHandlers.onPermissionResolved,
      onSession: (session) => setSessions((prev) => ({ ...prev, [session.sessionId]: session })),
      onRemoved: (sessionId) =>
        setSessions((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        }),
      onDelegation: reloadTasks,
      onSettings: (settings) => {
        setConfig(configOf(settings));
        setLoaded(true);
      },
      onLimits: () => setLimitsTick((value) => value + 1),
      onUsage: () => setUsageTick((value) => value + 1),
    });
    return () => {
      mounted = false;
      window.clearTimeout(retry);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    void dock(!openRef.current);
  }, [loaded, config.edge, config.enabled, dock]);

  useEffect(() => {
    if (!loaded || openRef.current || dockedRings.current === ringCount) return;
    void dock(true);
  }, [loaded, ringCount, dock]);

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
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const off = await listen("widget:shown", () => {
        if (!configRef.current.enabled || !loadedRef.current) void revealCompact();
      });
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [revealCompact]);

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
        if (applying.current || openRef.current || !configRef.current.enabled) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          void currentMonitorLike()
            .then(async (monitor) => {
              const scale = monitor?.scaleFactor ?? 1;
              const offset = offsetFromPosition(edge, workAreaOf(monitor), { x: payload.x / scale, y: payload.y / scale }, ringsRef.current);
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
        if (!alive) return;
        if (isScanning(summary)) {
          setUsageScanning(true);
          return;
        }
        setUsageScanning(false);
        setUsage(summary);
      });
    };
    load();
    const id = window.setInterval(load, usageScanning ? 3000 : 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [wantUsage, usageScanning, usageTick]);

  const surface = widgetSurface({ loaded, enabled: config.enabled });

  useEffect(() => {
    if (surface === "on") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [surface, dismiss]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void collapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, collapse]);

  useEffect(() => {
    if (!open || surface !== "on") return;
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => void collapse(), 3000);
    return () => window.clearTimeout(leaveTimer.current);
  }, [open, surface, collapse]);

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
    const { needsYou: waiting, running, idle } = splitSessions(live);
    const visibleTasks = config.delegated ? tasks.filter((t) => t.archivedAt == null) : [];
    const attentionTasks = visibleTasks.filter((t) => needsYou(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
    const codexApprovalSessions = new Set(approvals.filter((item) => item.agent === "codex").map((item) => item.sessionId)).size;
    const delegated = visibleTasks.filter((t) => inFlight(t.status)).sort((a, b) => a.createdAt - b.createdAt);
    const doneRecent = visibleTasks
      .filter((t) => t.status === "completed" && Date.now() - t.updatedAt < 3_600_000)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3);
    return {
      all,
      live,
      waiting,
      running,
      idle,
      attentionTasks,
      delegated,
      doneRecent,
      needYou: waiting.length + attentionTasks.length + codexApprovalSessions,
      failed: attentionTasks.filter((t) => t.status === "failed" || t.status === "interrupted").length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, tasks, tick, config.delegated, approvals]);

  const goSession = (sessionId: string) => {
    void focusSession(sessionId);
    void collapse();
  };

  const goMain = (hash: string | null) => {
    void openMain(hash);
    void collapse();
  };

  const turnOn = async () => {
    setTurningOn(true);
    setTurnOnError(null);
    const result = await turnOnOptimistically(
      {
        open: () => {
          openRef.current = true;
          setOpen(true);
        },
        revert: () => {
          openRef.current = false;
          setOpen(false);
        },
      },
      () => updateSettings({ features: { widget: true } }),
    );
    if (result.ok) setConfig(configOf(result.value));
    else setTurnOnError(result.message);
    setTurningOn(false);
  };

  const openSettings = () => {
    void openMain("#/settings/plugins");
    void dismiss();
  };

  const rowClass = (tone: WidgetTone, muted: boolean): string => `wg-row wg-row--${tone}${muted ? " wg-row--muted" : ""}`;

  const sessionRow = (session: SessionRecord, muted = false) => {
    const peers = folderPeers(session.cwd, model.all, tasks, { sessionId: session.sessionId });
    const tone = sessionTone(session);
    const client = sessionClient(session);
    const name = nameOf(session);
    return (
      <button key={session.sessionId} className={rowClass(tone, muted)} title={session.cwd ? `${name}\n${session.cwd}` : name} onClick={() => goSession(session.sessionId)}>
        <span className={`wg-dot wg-dot--${tone}`} aria-hidden="true" />
        <span className="wg-ico" role="img" aria-label={client.label}>
          {client.icon}
        </span>
        {session.favoriteAt != null && (
          <span className="wg-star" role="img" aria-label="Favorite">
            <IconStar size={12} filled />
          </span>
        )}
        <span className="wg-title">{name}</span>
        <RowTail meta={sessionRowMeta(session, peers, now)} />
      </button>
    );
  };

  const taskRow = (task: TaskRecord, muted = false) => {
    const tone = taskTone(task.status);
    const branch = taskIsolation(task) === "worktree" ? taskBranch(task) : null;
    return (
      <button key={task.id} className={rowClass(tone, muted)} title={branch ? `${task.title}\nworktree · ${branch}` : task.title} onClick={() => goMain(`#/tasks/${task.id}`)}>
        <span className={`wg-dot wg-dot--${tone}`} aria-hidden="true" />
        <span className="wg-ico" role="img" aria-label={task.runner === "codex" ? "Codex task" : "Claude task"}>
          {task.runner === "codex" ? <IconCodex /> : <IconCode />}
        </span>
        <span className="wg-title">{task.title}</span>
        <RowTail meta={taskRowMeta(task, inFlight(task.status) ? branch : null, now)} />
      </button>
    );
  };

  const sections = planSections(
    {
      needs: model.needYou,
      running: model.running.length,
      idle: model.idle.length,
      delegated: model.delegated.length,
      done: model.doneRecent.length,
    },
    config.delegated,
  );

  const rowsOf = (section: SectionPlan) => {
    if (section.key === "needs") return [...model.waiting.map((session) => sessionRow(session)), ...model.attentionTasks.map((task) => taskRow(task))];
    if (section.key === "running") return model.running.map((session) => sessionRow(session));
    if (section.key === "idle") return model.idle.slice(0, section.shown).map((session) => sessionRow(session, true));
    if (section.key === "delegated") return model.delegated.map((task) => taskRow(task));
    return model.doneRecent.map((task) => taskRow(task, true));
  };

  const tone = pipTone({ failed: model.failed, needYou: model.needYou, running: model.running.length + model.delegated.length });
  const claudeWeek = config.rings.claude ? limits?.claude?.sevenDay ?? null : null;
  const codexWeek = config.rings.codex ? limits?.codex?.secondary ?? null : null;
  const liveCount = model.live.length - model.idle.length;

  const approvalsBlock =
    approvals.length > 0 ? (
      <section className="wg-sec wg-sec--approvals">
        <div className="wg-sec-h">
          {pendingLabel(approvals.length)} <span className="wg-sec-n">{approvals.length}</span>
        </div>
        <ApprovalList requests={approvals} compact showTitle reasonField={false} />
      </section>
    ) : null;

  const sessionsBody =
    sections.length > 0 || approvalsBlock ? (
      <>
        {approvalsBlock}
        {sections.map((section) => (
        <section key={section.key} className={`wg-sec wg-sec--${section.key}`}>
          <div className="wg-sec-h">
            {section.label} <span className="wg-sec-n">{section.count}</span>
          </div>
          {rowsOf(section)}
          {section.more > 0 && <div className="wg-more">+{section.more} more</div>}
        </section>
        ))}
      </>
    ) : (
      <div className="wg-empty">All quiet, nothing running right now.</div>
    );

  const usageBody = (
    <>
      <ProviderCard
        provider="claude"
        usageEnabled={config.usageFeature}
        usage={usage}
        usageScanning={usageScanning}
        limitsEnabled={config.limitsFeature}
        limits={limits}
        now={now}
      />
      <ProviderCard
        provider="codex"
        usageEnabled={config.usageFeature}
        usage={usage}
        usageScanning={usageScanning}
        limitsEnabled={config.limitsFeature}
        limits={limits}
        now={now}
      />
    </>
  );

  if (surface !== "on") {
    return (
      <div className="wgd" data-edge={config.edge} data-open="1" data-widget-enabled={surface === "off" ? "0" : "pending"}>
        <section className="wgd-panel wgd-panel--compact" aria-label="CC Hub widget">
          <header className="wgd-head">
            <span className="wgd-brand">
              <BrandMark size={22} />
            </span>
            <span className="wgd-state">CC Hub widget</span>
            {inTauri() && (
              <button className="wgd-collapse" onClick={() => void dismiss()} title="Hide" aria-label="Hide widget">
                <Arrow edge={config.edge} closing />
              </button>
            )}
          </header>
          {surface === "off" ? (
            <div className="wgd-off">
              <b className="wgd-off-t">Widget is off</b>
              {turnOnError && <span className="wgd-note wgd-note--hold">Could not turn it on: {turnOnError}</span>}
              <div className="wgd-off-acts">
                <button className="wg-open wgd-primary" onClick={() => void turnOn()} disabled={turningOn}>
                  {turningOn ? "Turning on..." : "Turn on"}
                </button>
                <button className="wgd-link" onClick={openSettings}>
                  Open settings
                </button>
              </div>
            </div>
          ) : (
            <div className="wgd-off">
              <span className="wgd-note">Connecting to the hub...</span>
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="wgd" data-edge={config.edge} data-open={open ? "1" : "0"} data-widget-enabled="1">
      {open ? (
        <section className="wgd-panel" onMouseEnter={onPanelEnter} onMouseMove={onPanelEnter} onMouseLeave={onPanelLeave}>
          <header className="wgd-head">
            <span className="wgd-brand">
              <BrandMark size={22} />
            </span>
            <span className="wgd-state" title={headline({ live: liveCount, idle: model.idle.length, needYou: model.needYou })}>
              <b>{liveCount}</b> live
              {" · "}
              <b>{model.idle.length}</b> idle
              {" · "}
              <span className={model.needYou > 0 ? "wgd-state-attn" : undefined}>
                <b>{model.needYou}</b> need you
              </span>
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
          <span className={`wgd-pip wgd-pip--${tone} ${model.needYou > 0 ? "wgd-pip--count" : ""}`} title={model.needYou > 0 ? `${model.needYou} need you` : "CC Hub"}>
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
