import { formatClock } from "./routine-model";
import type { LimitsForecast, WindowForecast } from "./types";

export function windowLine(window: WindowForecast | null | undefined, label: string, now: number): string | null {
  if (!window || !window.exhaustsBeforeReset) return null;
  if (!Number.isFinite(window.exhaustsAt) || window.exhaustsAt <= now) return null;
  return `At this pace the ${label} window runs out at ${formatClock(window.exhaustsAt)}`;
}

export const claudeForecastLine = (forecast: LimitsForecast | null | undefined, now: number): string | null => windowLine(forecast?.claude.fiveHour, "5h", now);

export const codexForecastLine = (forecast: LimitsForecast | null | undefined, now: number): string | null => windowLine(forecast?.codex.primary, "5h", now);

export const providerForecastLine = (provider: "claude" | "codex", forecast: LimitsForecast | null | undefined, now: number): string | null =>
  provider === "claude" ? claudeForecastLine(forecast, now) : codexForecastLine(forecast, now);
