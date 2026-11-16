import { db } from "./db.js";
import type { LimitsPayload } from "./limits.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS hub_limit_samples (
    series     TEXT NOT NULL,
    at         INTEGER NOT NULL,
    used       REAL NOT NULL,
    resets_at  INTEGER,
    PRIMARY KEY (series, at)
  );
`);

export const FORECAST_SERIES = ["claude.fiveHour", "claude.sevenDay", "codex.primary", "codex.secondary"] as const;
export type ForecastSeries = (typeof FORECAST_SERIES)[number];

export const FORECAST_MIN_SAMPLES = 3;
export const FORECAST_MIN_SPAN_MS = 10 * 60_000;
const RESET_TOLERANCE_MS = 5 * 60_000;
const SAMPLE_RETENTION_MS = 8 * 24 * 3_600_000;
const MAX_SAMPLES_PER_SERIES = 400;
const HOUR_MS = 3_600_000;

export interface LimitSample {
  at: number;
  used: number;
  resetsAt: number | null;
}

export interface WindowForecast {
  series: ForecastSeries;
  usedPercent: number;
  ratePerHour: number;
  exhaustsAt: number;
  resetsAt: number | null;
  exhaustsBeforeReset: boolean;
  samples: number;
  spanMinutes: number;
}

export interface LimitsForecast {
  claude: { fiveHour: WindowForecast | null; sevenDay: WindowForecast | null };
  codex: { primary: WindowForecast | null; secondary: WindowForecast | null };
}

export function currentWindowSamples(samples: readonly LimitSample[]): LimitSample[] {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const latest = sorted[sorted.length - 1];
  if (!latest) return [];
  const sameWindow = sorted.filter((sample) => {
    if (latest.resetsAt === null || sample.resetsAt === null) return latest.resetsAt === sample.resetsAt;
    return Math.abs(sample.resetsAt - latest.resetsAt) <= RESET_TOLERANCE_MS;
  });
  let start = 0;
  for (let index = 1; index < sameWindow.length; index += 1) {
    const previous = sameWindow[index - 1];
    const current = sameWindow[index];
    if (previous && current && current.used < previous.used) start = index;
  }
  return sameWindow.slice(start);
}

export function forecastWindow(series: ForecastSeries, samples: readonly LimitSample[], now: number = Date.now()): WindowForecast | null {
  const window = currentWindowSamples(samples).filter((sample) => sample.at <= now);
  if (window.length < FORECAST_MIN_SAMPLES) return null;
  const first = window[0];
  const last = window[window.length - 1];
  if (!first || !last) return null;
  const span = last.at - first.at;
  if (span < FORECAST_MIN_SPAN_MS) return null;
  const meanAt = window.reduce((sum, sample) => sum + sample.at, 0) / window.length;
  const meanUsed = window.reduce((sum, sample) => sum + sample.used, 0) / window.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of window) {
    numerator += (sample.at - meanAt) * (sample.used - meanUsed);
    denominator += (sample.at - meanAt) ** 2;
  }
  if (denominator === 0) return null;
  const ratePerMs = numerator / denominator;
  if (!(ratePerMs > 0)) return null;
  const remaining = Math.max(100 - last.used, 0);
  const exhaustsAt = Math.round(last.at + remaining / ratePerMs);
  const resetsAt = last.resetsAt;
  return {
    series,
    usedPercent: last.used,
    ratePerHour: Math.round(ratePerMs * HOUR_MS * 100) / 100,
    exhaustsAt,
    resetsAt,
    exhaustsBeforeReset: resetsAt === null || exhaustsAt < resetsAt,
    samples: window.length,
    spanMinutes: Math.round(span / 60_000),
  };
}

const insertSampleStmt = db.prepare(`INSERT OR IGNORE INTO hub_limit_samples (series, at, used, resets_at) VALUES (?, ?, ?, ?)`);
const listSamplesStmt = db.prepare(`SELECT at, used, resets_at AS resetsAt FROM hub_limit_samples WHERE series = ? ORDER BY at DESC LIMIT ?`);
const pruneSamplesStmt = db.prepare(`DELETE FROM hub_limit_samples WHERE at < ?`);

export function recordLimitSample(series: ForecastSeries, sample: LimitSample): void {
  if (!Number.isFinite(sample.at) || !Number.isFinite(sample.used)) return;
  insertSampleStmt.run(series, Math.round(sample.at), sample.used, sample.resetsAt);
}

export function listLimitSamples(series: ForecastSeries): LimitSample[] {
  return (listSamplesStmt.all(series, MAX_SAMPLES_PER_SERIES) as LimitSample[]).reverse();
}

export function samplesFromPayload(payload: LimitsPayload): { series: ForecastSeries; sample: LimitSample }[] {
  const out: { series: ForecastSeries; sample: LimitSample }[] = [];
  const claude = payload.claude;
  if (claude && claude.source !== "none" && claude.source !== "cache" && claude.error === null && claude.fetchedAt !== null) {
    if (!claude.fiveHour.reset) out.push({ series: "claude.fiveHour", sample: { at: claude.fetchedAt, used: claude.fiveHour.utilization, resetsAt: claude.fiveHour.resetsAt } });
    if (!claude.sevenDay.reset) out.push({ series: "claude.sevenDay", sample: { at: claude.fetchedAt, used: claude.sevenDay.utilization, resetsAt: claude.sevenDay.resetsAt } });
  }
  const codex = payload.codex;
  if (codex && codex.source !== "none" && codex.fetchedAt !== null && codex.error === null) {
    if (!codex.primary.reset) out.push({ series: "codex.primary", sample: { at: codex.fetchedAt, used: codex.primary.usedPercent, resetsAt: codex.primary.resetsAt } });
    if (!codex.secondary.reset) out.push({ series: "codex.secondary", sample: { at: codex.fetchedAt, used: codex.secondary.usedPercent, resetsAt: codex.secondary.resetsAt } });
  }
  return out;
}

export function recordLimitsPayload(payload: LimitsPayload, now: number = Date.now()): number {
  const samples = samplesFromPayload(payload);
  for (const item of samples) recordLimitSample(item.series, item.sample);
  pruneSamplesStmt.run(now - SAMPLE_RETENTION_MS);
  return samples.length;
}

export function limitsForecast(payload: LimitsPayload, now: number = Date.now()): LimitsForecast {
  const of = (series: ForecastSeries, on: boolean): WindowForecast | null => (on ? forecastWindow(series, listLimitSamples(series), now) : null);
  return {
    claude: { fiveHour: of("claude.fiveHour", payload.claude !== null), sevenDay: of("claude.sevenDay", payload.claude !== null) },
    codex: { primary: of("codex.primary", payload.codex !== null), secondary: of("codex.secondary", payload.codex !== null) },
  };
}
