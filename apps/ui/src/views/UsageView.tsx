import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  fetchLimits,
  fetchUsage,
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
  type UsageSessionRow,
} from "../delegation";
import type { SessionRecord } from "../types";
import { CONTEXT_WARN, contextTone, dayBarHeights, sharePercent, shortProject, sortRows, timeAgo, type SortDirection } from "../usage-format";
import { clampPercent, formatTokens, resetCountdown, ringTone } from "../widget-layout";

export type UsageEvent = "usage" | "limits";

interface Props {
  settings: DelegationSettings | null;
  sessions: Record<string, SessionRecord>;
  onOpenSession: (sessionId: string) => void;
  subscribeUsage: (listener: (event: UsageEvent) => void) => () => void;
}

const DAY_OPTIONS: readonly number[] = [7, 14, 30];
const STORAGE_KEY = "hub.usage.days";
const PROVIDER_NAME: Record<UsageProvider, string> = { claude: "Claude", codex: "Codex" };
const ROW_LIMIT = 12;

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

function ProviderDot({ provider }: { provider: UsageProvider }) {
  return <span className={`usage__dot usage__dot--${provider}`} aria-hidden="true" />;
}

function ProviderLabel({ provider }: { provider: UsageProvider }) {
  return (
    <span className="usage__prov">
      <ProviderDot provider={provider} />
      {PROVIDER_NAME[provider]}
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
    <div className="usage__gauge">
      <span className="usage__gauge-l">{label}</span>
      <span className="usage__meter">
        <span className={`usage__meter-fill usage__meter-fill--${ringTone(percent)}`} style={{ width: `${shown}%` }} />
      </span>
      <span className="usage__gauge-v">{Math.round(shown)}%</span>
      <span className="usage__gauge-r">{reset ? `resets in ${reset}` : ""}</span>
    </div>
  );
}

interface FreshnessProps {
  stale: boolean | undefined;
  fetchedAt: number | null | undefined;
  cached: boolean;
  error: string | null | undefined;
  now: number;
}

function Freshness({ stale, fetchedAt, cached, error, now }: FreshnessProps) {
  return (
    <>
      {stale && fetchedAt != null && <span className="usage__note">as of {timeAgo(fetchedAt, now)}</span>}
      {cached && <span className="usage__note">from local cache</span>}
      {error && <span className="usage__warn">{error}</span>}
    </>
  );
}

function ClaudeCard({ data, now }: { data: ClaudeLimits; now: number }) {
  return (
    <section className="usage__card">
      <header className="usage__card-h">
        <ProviderLabel provider="claude" />
        <Freshness stale={data.stale} fetchedAt={data.fetchedAt} cached={data.source === "cache"} error={data.error} now={now} />
      </header>
      <Gauge label="5 h" percent={data.fiveHour.utilization} resetsAt={data.fiveHour.resetsAt} now={now} />
      <Gauge label="7 d" percent={data.sevenDay.utilization} resetsAt={data.sevenDay.resetsAt} now={now} />
      {data.models.length > 0 && (
        <div className="usage__chips">
          {data.models.map((model) => {
            const reset = resetCountdown(model.resetsAt, now);
            return (
              <span
                key={model.name}
                className={`chip usage__tone usage__tone--${ringTone(model.utilization)}`}
                title={reset ? `${model.name} resets in ${reset}` : model.name}
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
    </section>
  );
}

function CodexCard({ data, now }: { data: CodexLimits; now: number }) {
  return (
    <section className="usage__card">
      <header className="usage__card-h">
        <ProviderLabel provider="codex" />
        {data.planType && <span className="chip">{data.planType}</span>}
        <Freshness stale={data.stale} fetchedAt={data.fetchedAt} cached={data.source === "rollout"} error={data.error} now={now} />
      </header>
      <Gauge label="5 h" percent={data.primary.usedPercent} resetsAt={data.primary.resetsAt} now={now} />
      <Gauge label="7 d" percent={data.secondary.usedPercent} resetsAt={data.secondary.resetsAt} now={now} />
    </section>
  );
}

interface LimitsPanelProps {
  enabled: boolean;
  limits: LimitsSnapshot | null | undefined;
  busy: boolean;
  error: string | null;
  now: number;
  onRefresh: () => void;
}

function LimitsPanel({ enabled, limits, busy, error, now, onRefresh }: LimitsPanelProps) {
  if (!enabled) {
    return (
      <section className="panel">
        <h3>Plan limits</h3>
        <p className="hint">Turn on Limits in Settings › Features to see how much of your plan is left</p>
      </section>
    );
  }
  return (
    <section className="panel">
      <div className="usage__panel-h">
        <h3>Plan limits</h3>
        <span className="spacer" />
        {limits && limits.updatedAt != null && <span className="muted small">checked {timeAgo(limits.updatedAt, now)}</span>}
        <button type="button" className="act" disabled={busy || limits === null} onClick={onRefresh}>
          {busy ? "Refreshing..." : "Refresh"}
        </button>
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
          {limits.claude && <ClaudeCard data={limits.claude} now={now} />}
          {limits.codex && <CodexCard data={limits.codex} now={now} />}
        </div>
      )}
    </section>
  );
}

function DayBars({ report }: { report: UsageReport }) {
  const bars = dayBarHeights(report.byDay);
  return (
    <div className="usage__chart">
      <div className="usage__bars" style={{ gridTemplateColumns: `repeat(${Math.max(1, bars.length)}, minmax(0, 1fr))` }}>
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
      <div className="usage__legend">
        <ProviderLabel provider="claude" />
        <ProviderLabel provider="codex" />
        <span className="muted small">tokens read per day</span>
      </div>
    </div>
  );
}

interface TileProps {
  label: string;
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

function WhereItGoes({ report }: { report: UsageReport }) {
  const { totals, byProvider, context } = report;
  const tone = contextTone(context.p90);
  return (
    <section className="panel">
      <h3>Where it goes</h3>
      <DayBars report={report} />
      <div className="usage__tiles">
        <Tile
          label="Read"
          value={formatTokens(totals.read)}
          sub={`Claude ${formatTokens(byProvider.claude.read)} · Codex ${formatTokens(byProvider.codex.read)}`}
        />
        <Tile label="Output" value={formatTokens(totals.output)} sub={`fresh input ${formatTokens(totals.fresh)}`} />
        <Tile label="Messages" value={totals.messages.toLocaleString()} sub={`subagents: ${sharePercent(report.sidechainShare)} %`} />
        <Tile
          label="Context per message"
          value={`${formatTokens(context.p50)} · ${formatTokens(context.p90)} · ${formatTokens(context.max)}`}
          sub="p50 · p90 · max"
          tone={tone}
        />
      </div>
      <p className={`hint usage__explain ${tone !== "go" ? `usage__explain--${tone}` : ""}`}>
        Every message re-reads the whole context; long sessions above {formatTokens(CONTEXT_WARN)} tokens are the main cost driver. Compact or start a new
        session when p90 gets there.
      </p>
      <p className="muted small">
        {context.over300k.toLocaleString()} messages above 300k · {context.over600k.toLocaleString()} above 600k
      </p>
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

interface UsageTableProps<T> {
  title: string;
  rows: readonly T[];
  columns: readonly Column<T>[];
  initialKey: string;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  isClickable?: (row: T) => boolean;
}

function UsageTable<T>({ title, rows, columns, initialKey, rowKey, onRowClick, isClickable }: UsageTableProps<T>) {
  const [sort, setSort] = useState<SortState>({ key: initialKey, direction: "desc" });
  const [all, setAll] = useState(false);
  const column = columns.find((item) => item.key === sort.key) ?? columns[0];
  const sorted = column ? sortRows(rows, column.value, sort.direction) : [...rows];
  const shown = all ? sorted : sorted.slice(0, ROW_LIMIT);
  const toggle = (key: string) =>
    setSort((current) => (current.key === key ? { key, direction: current.direction === "desc" ? "asc" : "desc" } : { key, direction: "desc" }));
  return (
    <section className="panel">
      <div className="usage__panel-h">
        <h3>{title}</h3>
        <span className="muted small">{rows.length}</span>
      </div>
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
                    <button type="button" className="usage__sort" onClick={() => toggle(item.key)}>
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
        <button type="button" className="act usage__more" onClick={() => setAll((value) => !value)}>
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </section>
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

export function UsageView({ settings, sessions, onOpenSession, subscribeUsage }: Props) {
  const [storedDays, setStoredDays] = useState<number | null>(readStoredDays);
  const days = storedDays ?? defaultDays(settings?.usage?.days);
  const limitsEnabled = settings?.features.limits === true;
  const [report, setReport] = useState<UsageReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [limits, setLimits] = useState<LimitsSnapshot | null | undefined>(undefined);
  const [limitsBusy, setLimitsBusy] = useState(false);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requestId = useRef(0);

  const loadReport = useCallback(async (): Promise<void> => {
    const id = ++requestId.current;
    try {
      const next = await fetchUsage(days);
      if (id !== requestId.current) return;
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
    } catch (error) {
      setLimitsError(errorMessage(error));
    } finally {
      setLimitsBusy(false);
      setNow(Date.now());
    }
  };

  const openable = (row: UsageSessionRow): boolean => row.provider === "claude" && sessions[row.sessionId] != null;
  const missingHub = reportError != null && reportError.includes("(404)");

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
        <button type="button" className="act" disabled={rescanning} onClick={() => void rescan()}>
          {rescanning ? "Rescanning..." : "Rescan"}
        </button>
        <span className="spacer" />
        {report && <span className="muted small">scanned {timeAgo(report.to, now)}</span>}
      </div>

      <LimitsPanel enabled={limitsEnabled} limits={limits} busy={limitsBusy} error={limitsError} now={now} onRefresh={() => void refresh()} />

      {reportError && <p className="error">{missingHub ? "Usage needs a newer hub." : `Could not load usage: ${reportError}`}</p>}
      {!report && !reportError && <p className="hint">Scanning transcripts...</p>}
      {report && report.totals.messages === 0 && <p className="empty">No transcripts in the last {days} days</p>}
      {report && report.totals.messages > 0 && (
        <>
          <WhereItGoes report={report} />
          <UsageTable title="By model" rows={report.byModel} columns={MODEL_COLUMNS} initialKey="read" rowKey={(row) => `${row.provider}:${row.model}`} />
          <UsageTable title="By project" rows={report.byProject} columns={PROJECT_COLUMNS} initialKey="read" rowKey={(row) => `${row.provider}:${row.project}`} />
          <UsageTable
            title="By session"
            rows={report.bySession}
            columns={SESSION_COLUMNS}
            initialKey="read"
            rowKey={(row) => `${row.provider}:${row.sessionId}`}
            isClickable={openable}
            onRowClick={(row) => onOpenSession(row.sessionId)}
          />
        </>
      )}
    </div>
  );
}
