import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  fetchLimits,
  fetchUsage,
  isScanning,
  refreshLimits,
  rescanUsage,
  type ClaudeLimits,
  type CodexLimits,
  type DelegationSettings,
  type LimitsSnapshot,
  type UsageModelRow,
  type UsageProjectRow,
  type UsageProvider,
  type UsageReport,
  type UsageScanning,
  type UsageSessionRow,
} from "../delegation";
import { BoardActionsMenu, type BoardMenuItem } from "../components/BoardActionsMenu";
import { Toggletip } from "../components/Toggletip";
import { claudeForecastLine, codexForecastLine } from "../forecast-model";
import { IconClaude, IconOpenAI } from "../icons";
import type { LimitsForecast, SessionRecord } from "../types";
import { useLimitsForecast } from "../use-ops";
import {
  CONTEXT_WARN,
  USAGE_TABS,
  contextTone,
  dayBarHeights,
  parseUsageTab,
  resetLabel,
  sharePercent,
  shortProject,
  sortRows,
  sourceNote,
  stepUsageTab,
  timeAgo,
  type LimitWindowKind,
  type SortDirection,
  type UsageTab,
} from "../usage-format";
import { clampPercent, formatTokens, ringTone } from "../widget-layout";
import "../usage.css";

export type UsageEvent = "usage" | "limits";

interface Props {
  settings: DelegationSettings | null;
  sessions: Record<string, SessionRecord>;
  onOpenSession: (sessionId: string) => void;
  subscribeUsage: (listener: (event: UsageEvent) => void) => () => void;
}

const DAY_OPTIONS: readonly number[] = [7, 14, 30];
const STORAGE_KEY = "hub.usage.days";
const TAB_STORAGE_KEY = "hub.usage.tab";
const PROVIDER_NAME: Record<UsageProvider, string> = { claude: "Claude", codex: "Codex" };
const TAB_LABEL: Record<UsageTab, string> = { model: "By model", project: "By project", session: "By session" };
const ROW_LIMIT = 12;
const BAR_MIN_WIDTH = 20;
const SCAN_POLL_MS = 3000;

function readStoredDays(): number | null {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return DAY_OPTIONS.includes(value) ? value : null;
  } catch {
    return null;
  }
}

function storeDays(days: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(days));
  } catch {
    return;
  }
}

function readStoredTab(): UsageTab {
  try {
    return parseUsageTab(localStorage.getItem(TAB_STORAGE_KEY));
  } catch {
    return parseUsageTab(null);
  }
}

function storeTab(tab: UsageTab): void {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    return;
  }
}

function defaultDays(configured: number | undefined): number {
  if (configured == null || !Number.isFinite(configured)) return DAY_OPTIONS[0] ?? 7;
  return DAY_OPTIONS.find((option) => option >= configured) ?? DAY_OPTIONS[DAY_OPTIONS.length - 1] ?? 30;
}

const pad = (value: number): string => String(value).padStart(2, "0");

function formatWhen(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "request failed");

function ProviderIcon({ provider, size }: { provider: UsageProvider; size: number }) {
  return (
    <span className={`usage__ico usage__ico--${provider}`} aria-hidden="true">
      {provider === "claude" ? <IconClaude size={size} /> : <IconOpenAI size={size} />}
    </span>
  );
}

function ProviderLabel({ provider, size = 14 }: { provider: UsageProvider; size?: number }) {
  return (
    <span className="usage__prov">
      <ProviderIcon provider={provider} size={size} />
      {PROVIDER_NAME[provider]}
    </span>
  );
}

interface GaugeProps {
  label: string;
  percent: number;
  resetsAt: number | null;
  window: LimitWindowKind;
  requireReset?: boolean;
  reset?: boolean;
  now: number;
}

function resetText(resetsAt: number | null, now: number, window: LimitWindowKind, requireReset: boolean): string {
  const label = resetLabel(resetsAt, now, window, requireReset);
  if (label.kind === "countdown") return `resets in ${label.text}`;
  return label.kind === "unknown" ? "reset time unknown" : "";
}

function Gauge({ label, percent, resetsAt, window, requireReset = false, reset, now }: GaugeProps) {
  if (reset) {
    return (
      <div className="usage__gauge usage__gauge--reset">
        <span className="usage__gauge-l">{label}</span>
        <span className="usage__meter" />
        <span className="usage__gauge-v">reset · 0%</span>
        <span className="usage__gauge-r" />
      </div>
    );
  }
  const shown = clampPercent(percent);
  return (
    <div className="usage__gauge">
      <span className="usage__gauge-l">{label}</span>
      <span className="usage__meter">
        <span className={`usage__meter-fill usage__meter-fill--${ringTone(percent)}`} style={{ width: `${shown}%` }} />
      </span>
      <span className="usage__gauge-v">{Math.round(shown)}%</span>
      <span className="usage__gauge-r">{resetText(resetsAt, now, window, requireReset)}</span>
    </div>
  );
}

interface FreshnessProps {
  source: string | undefined;
  fetchedAt: number | null | undefined;
  error: string | null | undefined;
  now: number;
}

function Freshness({ source, fetchedAt, error, now }: FreshnessProps) {
  const note = sourceNote(source);
  return (
    <>
      {source !== "none" && fetchedAt != null && <span className="usage__note">as of {timeAgo(fetchedAt, now)}</span>}
      {note && <span className="usage__note">{note}</span>}
      {error && source !== "none" && <span className="usage__warn">{error}</span>}
    </>
  );
}

function NoData({ message }: { message: string | null | undefined }) {
  return <p className="usage__warn">{message ?? ""}</p>;
}

function ClaudeCard({ data, now, forecastLine }: { data: ClaudeLimits; now: number; forecastLine: string | null }) {
  const none = data.source === "none";
  return (
    <section className="usage__card">
      <header className="usage__card-h">
        <ProviderLabel provider="claude" size={20} />
        <Freshness source={data.source} fetchedAt={data.fetchedAt} error={data.error} now={now} />
      </header>
      {none ? (
        <NoData message={data.error || "no Claude Code login found"} />
      ) : (
        <>
          <Gauge label="5 h" percent={data.fiveHour.utilization} resetsAt={data.fiveHour.resetsAt} window="fiveHour" reset={data.fiveHour.reset} now={now} />
          <Gauge label="7 d" percent={data.sevenDay.utilization} resetsAt={data.sevenDay.resetsAt} window="sevenDay" reset={data.sevenDay.reset} now={now} />
          {data.models.length > 0 && (
            <div className="usage__chips">
              {data.models.map((model) => {
                const countdown = resetLabel(model.resetsAt, now, "sevenDay");
                return (
                  <span
                    key={model.name}
                    className={`chip usage__tone usage__tone--${ringTone(model.utilization)}`}
                    title={countdown.kind === "countdown" ? `${model.name} resets in ${countdown.text}` : model.name}
                  >
                    {model.name} {Math.round(clampPercent(model.utilization))}%
                  </span>
                );
              })}
            </div>
          )}
          {data.extra?.enabled && (
            <div className="usage__note">
              Extra usage on
              {data.extra.utilization != null && Number.isFinite(data.extra.utilization) ? `: ${Math.round(clampPercent(data.extra.utilization))}% used` : ""}
            </div>
          )}
          {forecastLine !== null && <div className="usage__note">{forecastLine}</div>}
        </>
      )}
    </section>
  );
}

function CodexCard({ data, now, forecastLine }: { data: CodexLimits; now: number; forecastLine: string | null }) {
  const none = data.source === "none";
  return (
    <section className="usage__card">
      <header className="usage__card-h">
        <ProviderLabel provider="codex" size={20} />
        {data.planType && <span className="chip">{data.planType}</span>}
        <Freshness source={data.source} fetchedAt={data.fetchedAt} error={data.error} now={now} />
      </header>
      {none ? (
        <NoData message={data.error || "no Codex session data found"} />
      ) : (
        <>
          <Gauge label="5 h" percent={data.primary.usedPercent} resetsAt={data.primary.resetsAt} window="fiveHour" requireReset reset={data.primary.reset} now={now} />
          <Gauge label="7 d" percent={data.secondary.usedPercent} resetsAt={data.secondary.resetsAt} window="sevenDay" requireReset reset={data.secondary.reset} now={now} />
          {forecastLine !== null && <div className="usage__note">{forecastLine}</div>}
        </>
      )}
    </section>
  );
}

interface LimitsPanelProps {
  enabled: boolean;
  limits: LimitsSnapshot | null | undefined;
  error: string | null;
  now: number;
  refreshedAt: number | null;
  forecast: LimitsForecast | null;
}

function LimitsPanel({ enabled, limits, error, now, refreshedAt, forecast }: LimitsPanelProps) {
  if (!enabled) {
    return (
      <section className="panel">
        <h3>Plan limits</h3>
        <p className="hint">
          Turn on Limits in <a href="#/settings/plugins">Settings › Plugins</a> to see how much of your plan is left
        </p>
      </section>
    );
  }
  return (
    <section className="panel">
      <div className="usage__panel-h">
        <h3>Plan limits</h3>
        <span className="spacer" />
        {refreshedAt != null && <span className="muted small">refreshed {timeAgo(refreshedAt, now)}</span>}
      </div>
      {error && <p className="usage__warn">{error}</p>}
      {limits === undefined ? (
        <p className="hint">Loading limits...</p>
      ) : limits === null ? (
        <p className="hint">Limits need a newer hub.</p>
      ) : limits.claude == null && limits.codex == null ? (
        <p className="hint">No plan limits available yet. Run a Claude Code or Codex session, then refresh.</p>
      ) : (
        <div className="usage__cards">
          {limits.claude && <ClaudeCard data={limits.claude} now={now} forecastLine={claudeForecastLine(forecast, now)} />}
          {limits.codex && <CodexCard data={limits.codex} now={now} forecastLine={codexForecastLine(forecast, now)} />}
        </div>
      )}
    </section>
  );
}

function DayBars({ report }: { report: UsageReport }) {
  const bars = dayBarHeights(report.byDay);
  return (
    <div className="usage__chart">
      <div className="usage__scrollx">
        <div
          className="usage__bars"
          style={{ gridTemplateColumns: `repeat(${Math.max(1, bars.length)}, minmax(0, 1fr))`, minWidth: `${Math.max(1, bars.length) * BAR_MIN_WIDTH}px` }}
        >
          {bars.map((bar, index) => {
            const entry = report.byDay[index];
            const title = entry
              ? `${bar.day}\nClaude ${formatTokens(entry.claude.read)} read, ${entry.claude.messages} msgs\nCodex ${formatTokens(entry.codex.read)} read, ${entry.codex.messages} msgs`
              : bar.day;
            return (
              <div key={bar.day} className="usage__col" title={title}>
                <div className="usage__stack">
                  <span className="usage__seg usage__seg--codex" style={{ height: `${bar.codex}%` }} />
                  <span className="usage__seg usage__seg--claude" style={{ height: `${bar.claude}%` }} />
                </div>
                <span className="usage__day">{bar.day.slice(8)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="usage__legend">
        <ProviderLabel provider="claude" />
        <ProviderLabel provider="codex" />
        <span className="muted small">tokens read per day</span>
      </div>
    </div>
  );
}

interface TileProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "go" | "pend" | "hold";
}

function Tile({ label, value, sub, tone }: TileProps) {
  return (
    <div className={`usage__tile ${tone && tone !== "go" ? `usage__tile--${tone}` : ""}`}>
      <span className="usage__tile-l">{label}</span>
      <b className="usage__tile-v">{value}</b>
      {sub != null && <span className="usage__tile-s">{sub}</span>}
    </div>
  );
}

function Summary({ report }: { report: UsageReport }) {
  const { totals, byProvider, context } = report;
  const tone = contextTone(context.p90);
  return (
    <div className="usage__tiles">
      <Tile label="Read" value={formatTokens(totals.read)} sub={`Claude ${formatTokens(byProvider.claude.read)} · Codex ${formatTokens(byProvider.codex.read)}`} />
      <Tile label="Output" value={formatTokens(totals.output)} sub={`fresh input ${formatTokens(totals.fresh)}`} />
      <Tile label="Messages" value={totals.messages.toLocaleString()} sub={`subagents: ${sharePercent(report.sidechainShare)} %`} />
      <Tile
        label={
          <>
            Context per message
            <Toggletip label="About context per message" align="end">
              <span className={`usage__tip-main ${tone !== "go" ? `usage__tip-main--${tone}` : ""}`}>
                Every message re-reads the whole context; long sessions above {formatTokens(CONTEXT_WARN)} tokens are the main cost driver. Compact or start a
                new session when p90 gets there.
              </span>
              <span className="usage__tip-sub">
                {context.over300k.toLocaleString()} messages above 300k · {context.over600k.toLocaleString()} above 600k
              </span>
            </Toggletip>
          </>
        }
        value={`${formatTokens(context.p50)} · ${formatTokens(context.p90)} · ${formatTokens(context.max)}`}
        sub="p50 · p90 · max"
        tone={tone}
      />
    </div>
  );
}

function ChartPanel({ report }: { report: UsageReport }) {
  return (
    <section className="panel">
      <h3>Where it goes</h3>
      <DayBars report={report} />
    </section>
  );
}

interface Column<T> {
  key: string;
  label: string;
  numeric?: boolean;
  value: (row: T) => number | string;
  render: (row: T) => ReactNode;
}

interface SortState {
  key: string;
  direction: SortDirection;
}

interface DataTableProps<T> {
  rows: readonly T[];
  columns: readonly Column<T>[];
  sort: SortState;
  onSort: (key: string) => void;
  showAll: boolean;
  onToggleAll: () => void;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  isClickable?: (row: T) => boolean;
}

function DataTable<T>({ rows, columns, sort, onSort, showAll, onToggleAll, rowKey, onRowClick, isClickable }: DataTableProps<T>) {
  const column = columns.find((item) => item.key === sort.key) ?? columns[0];
  const sorted = column ? sortRows(rows, column.value, sort.direction) : [...rows];
  const shown = showAll ? sorted : sorted.slice(0, ROW_LIMIT);
  return (
    <>
      {rows.length === 0 ? (
        <p className="hint">Nothing to show.</p>
      ) : (
        <div className="usage__scroll">
          <table className="usage__table">
            <thead>
              <tr>
                {columns.map((item) => (
                  <th
                    key={item.key}
                    className={item.numeric ? "usage__num" : undefined}
                    aria-sort={sort.key === item.key ? (sort.direction === "desc" ? "descending" : "ascending") : "none"}
                  >
                    <button type="button" className="usage__sort" onClick={() => onSort(item.key)}>
                      {item.label}
                      <span className="usage__arrow" aria-hidden="true">
                        {sort.key === item.key ? (sort.direction === "desc" ? "▾" : "▴") : ""}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const clickable = onRowClick != null && isClickable?.(row) === true;
                return (
                  <tr
                    key={rowKey(row)}
                    className={clickable ? "usage__row usage__row--link" : "usage__row"}
                    onClick={clickable ? () => onRowClick(row) : undefined}
                  >
                    {columns.map((item) => (
                      <td key={item.key} className={item.numeric ? "usage__num" : undefined}>
                        {item.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > ROW_LIMIT && (
        <button type="button" className="act usage__more" onClick={onToggleAll}>
          {showAll ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </>
  );
}

const providerColumn = <T extends { provider: UsageProvider }>(): Column<T> => ({
  key: "provider",
  label: "Provider",
  value: (row) => row.provider,
  render: (row) => <ProviderLabel provider={row.provider} />,
});

const readColumn = <T extends { read: number }>(): Column<T> => ({
  key: "read",
  label: "Read",
  numeric: true,
  value: (row) => row.read,
  render: (row) => formatTokens(row.read),
});

const outputColumn = <T extends { output: number }>(): Column<T> => ({
  key: "output",
  label: "Output",
  numeric: true,
  value: (row) => row.output,
  render: (row) => formatTokens(row.output),
});

const messagesColumn = <T extends { messages: number }>(): Column<T> => ({
  key: "messages",
  label: "Messages",
  numeric: true,
  value: (row) => row.messages,
  render: (row) => row.messages.toLocaleString(),
});

const MODEL_COLUMNS: readonly Column<UsageModelRow>[] = [
  { key: "model", label: "Model", value: (row) => row.model, render: (row) => row.model },
  providerColumn(),
  readColumn(),
  { key: "fresh", label: "Fresh", numeric: true, value: (row) => row.fresh, render: (row) => formatTokens(row.fresh) },
  { key: "cacheRead", label: "Cache read", numeric: true, value: (row) => row.cacheRead, render: (row) => formatTokens(row.cacheRead) },
  outputColumn(),
  messagesColumn(),
];

const PROJECT_COLUMNS: readonly Column<UsageProjectRow>[] = [
  { key: "project", label: "Project", value: (row) => shortProject(row.project), render: (row) => <span title={row.project}>{shortProject(row.project)}</span> },
  providerColumn(),
  readColumn(),
  outputColumn(),
  messagesColumn(),
  { key: "sessions", label: "Sessions", numeric: true, value: (row) => row.sessions, render: (row) => row.sessions },
];

const sessionName = (row: UsageSessionRow): string => row.title?.trim() || row.sessionId.slice(0, 8);

const SESSION_COLUMNS: readonly Column<UsageSessionRow>[] = [
  {
    key: "title",
    label: "Session",
    value: (row) => sessionName(row),
    render: (row) => (
      <span className="usage__title" title={row.sessionId}>
        {sessionName(row)}
      </span>
    ),
  },
  providerColumn(),
  {
    key: "project",
    label: "Project",
    value: (row) => shortProject(row.project, row.cwd),
    render: (row) => <span title={row.cwd ?? row.project}>{shortProject(row.project, row.cwd)}</span>,
  },
  readColumn(),
  outputColumn(),
  messagesColumn(),
  {
    key: "context",
    label: "Context p50 / p90 / max",
    numeric: true,
    value: (row) => row.p90Context,
    render: (row) => (
      <span className="usage__ctx">
        <span>{formatTokens(row.p50Context)}</span>
        <span className={`chip usage__tone usage__tone--${contextTone(row.p90Context)}`}>{formatTokens(row.p90Context)}</span>
        <span>{formatTokens(row.maxContext)}</span>
      </span>
    ),
  },
  { key: "firstAt", label: "First", numeric: true, value: (row) => row.firstAt, render: (row) => formatWhen(row.firstAt) },
  { key: "lastAt", label: "Last", numeric: true, value: (row) => row.lastAt, render: (row) => formatWhen(row.lastAt) },
];

const INITIAL_SORT: SortState = { key: "read", direction: "desc" };
const INITIAL_SORTS: Record<UsageTab, SortState> = { model: INITIAL_SORT, project: INITIAL_SORT, session: INITIAL_SORT };
const INITIAL_EXPANDED: Record<UsageTab, boolean> = { model: false, project: false, session: false };

interface BreakdownProps {
  report: UsageReport;
  openable: (row: UsageSessionRow) => boolean;
  onOpenSession: (sessionId: string) => void;
}

function Breakdown({ report, openable, onOpenSession }: BreakdownProps) {
  const [tab, setTab] = useState<UsageTab>(readStoredTab);
  const [sorts, setSorts] = useState(INITIAL_SORTS);
  const [expanded, setExpanded] = useState(INITIAL_EXPANDED);
  const tabRefs = useRef<Partial<Record<UsageTab, HTMLButtonElement | null>>>({});
  const baseId = useId();
  const tabId = (value: UsageTab) => `${baseId}-tab-${value}`;
  const panelId = `${baseId}-panel`;
  const counts: Record<UsageTab, number> = { model: report.byModel.length, project: report.byProject.length, session: report.bySession.length };

  const choose = (next: UsageTab) => {
    storeTab(next);
    setTab(next);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = stepUsageTab(tab, event.key);
    if (next === null) return;
    event.preventDefault();
    choose(next);
    tabRefs.current[next]?.focus();
  };

  const sortBy = (key: string) =>
    setSorts((current) => {
      const active = current[tab];
      return { ...current, [tab]: active.key === key ? { key, direction: active.direction === "desc" ? "asc" : "desc" } : { key, direction: "desc" } };
    });
  const toggleAll = () => setExpanded((current) => ({ ...current, [tab]: !current[tab] }));
  const shared = { sort: sorts[tab], onSort: sortBy, showAll: expanded[tab], onToggleAll: toggleAll };

  return (
    <section className="panel">
      <div className="usage__tabs" role="tablist" aria-label="Usage breakdown" onKeyDown={onTabKeyDown}>
        {USAGE_TABS.map((value) => (
          <button
            key={value}
            ref={(element) => {
              tabRefs.current[value] = element;
            }}
            id={tabId(value)}
            type="button"
            role="tab"
            className="usage__tab"
            aria-selected={tab === value}
            aria-controls={panelId}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => choose(value)}
          >
            {TAB_LABEL[value]}
            <span className="usage__tab-n">{counts[value]}</span>
          </button>
        ))}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(tab)} className="usage__tabpanel">
        {tab === "model" && <DataTable rows={report.byModel} columns={MODEL_COLUMNS} rowKey={(row) => `${row.provider}:${row.model}`} {...shared} />}
        {tab === "project" && <DataTable rows={report.byProject} columns={PROJECT_COLUMNS} rowKey={(row) => `${row.provider}:${row.project}`} {...shared} />}
        {tab === "session" && (
          <DataTable
            rows={report.bySession}
            columns={SESSION_COLUMNS}
            rowKey={(row) => `${row.provider}:${row.sessionId}`}
            isClickable={openable}
            onRowClick={(row) => onOpenSession(row.sessionId)}
            {...shared}
          />
        )}
      </div>
    </section>
  );
}

export function UsageView({ settings, sessions, onOpenSession, subscribeUsage }: Props) {
  const [storedDays, setStoredDays] = useState<number | null>(readStoredDays);
  const days = storedDays ?? defaultDays(settings?.usage?.days);
  const limitsEnabled = settings?.features.limits === true;
  const [report, setReport] = useState<UsageReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [scanning, setScanning] = useState<UsageScanning | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [limits, setLimits] = useState<LimitsSnapshot | null | undefined>(undefined);
  const [limitsBusy, setLimitsBusy] = useState(false);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requestId = useRef(0);
  const forecast = useLimitsForecast(limitsEnabled, (limits?.updatedAt ?? 0) + (refreshedAt ?? 0));

  const loadReport = useCallback(async (): Promise<void> => {
    const id = ++requestId.current;
    try {
      const next = await fetchUsage(days);
      if (id !== requestId.current) return;
      if (isScanning(next)) {
        setScanning(next);
        setReportError(null);
        return;
      }
      setScanning(null);
      setReport(next);
      setReportError(null);
    } catch (error) {
      if (id !== requestId.current) return;
      setReportError(errorMessage(error));
    }
  }, [days]);

  const loadLimits = useCallback(async (): Promise<void> => {
    setLimits(await fetchLimits());
  }, []);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const isScanningNow = scanning != null;

  useEffect(() => {
    if (!isScanningNow) return;
    const timer = window.setInterval(() => void loadReport(), SCAN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [isScanningNow, loadReport]);

  useEffect(() => {
    if (limitsEnabled) void loadLimits();
  }, [limitsEnabled, loadLimits]);

  useEffect(
    () =>
      subscribeUsage((event) => {
        if (event === "usage") void loadReport();
        else if (limitsEnabled) void loadLimits();
      }),
    [subscribeUsage, loadReport, loadLimits, limitsEnabled],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const chooseDays = (value: number) => {
    storeDays(value);
    setStoredDays(value);
  };

  const rescan = async () => {
    setRescanning(true);
    try {
      await rescanUsage();
      await loadReport();
    } catch (error) {
      setReportError(errorMessage(error));
    } finally {
      setRescanning(false);
      setNow(Date.now());
    }
  };

  const refresh = async () => {
    setLimitsBusy(true);
    setLimitsError(null);
    try {
      setLimits(await refreshLimits());
      setRefreshedAt(Date.now());
    } catch (error) {
      setLimitsError(errorMessage(error));
    } finally {
      setLimitsBusy(false);
      setNow(Date.now());
    }
  };

  const openable = (row: UsageSessionRow): boolean => row.provider === "claude" && sessions[row.sessionId] != null;
  const missingHub = reportError != null && reportError.includes("(404)");

  const menuItems: BoardMenuItem[] = [
    {
      id: "rescan",
      label: rescanning ? "Rescanning..." : "Rescan transcripts",
      title: "Scan the transcripts again",
      disabled: rescanning,
      onSelect: () => void rescan(),
    },
    {
      id: "refresh-limits",
      label: limitsBusy ? "Refreshing..." : "Refresh plan limits",
      title: limitsEnabled ? "Fetch the plan limits again" : "Turn on Limits in Settings › Plugins first",
      disabled: limitsBusy || !limitsEnabled || limits === null,
      onSelect: () => void refresh(),
    },
  ];

  return (
    <div className="view usage">
      <div className="usage__head">
        <div className="seg" role="radiogroup" aria-label="Period">
          {DAY_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={days === option}
              className="seg__opt"
              onClick={() => chooseDays(option)}
            >
              {option} days
            </button>
          ))}
        </div>
        <span className="spacer" />
        {rescanning ? (
          <span className="muted small" role="status">
            Rescanning...
          </span>
        ) : (
          report && <span className="muted small">scanned {timeAgo(report.to, now)}</span>
        )}
        <BoardActionsMenu label="Usage actions" items={menuItems} />
      </div>

      <LimitsPanel enabled={limitsEnabled} limits={limits} error={limitsError} now={now} refreshedAt={refreshedAt} forecast={forecast} />

      {reportError && <p className="error">{missingHub ? "Usage needs a newer hub." : `Could not load usage: ${reportError}`}</p>}
      {scanning && (
        <p className="hint usage__scanning" role="status">
          Scanning transcripts… (first run after a hub restart takes a few seconds)
          {scanning.files != null ? ` · ${scanning.files.toLocaleString()} files` : ""}
        </p>
      )}
      {!report && !reportError && !scanning && <p className="hint">Scanning transcripts...</p>}
      {report && report.totals.messages === 0 && <p className="empty">No transcripts in the last {days} days</p>}
      {report && report.totals.messages > 0 && (
        <>
          <Summary report={report} />
          <ChartPanel report={report} />
          <Breakdown report={report} openable={openable} onOpenSession={onOpenSession} />
        </>
      )}
    </div>
  );
}
