import type { WidgetEdge } from "./delegation";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Tone = "go" | "pend" | "hold" | "muted";

export const TAB_THICKNESS = 28;
export const TAB_LENGTH = 132;
export const PANEL_LONG = 520;
export const PANEL_SHORT = 340;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

const isVertical = (edge: WidgetEdge): boolean => edge !== "top";

const collapsedSize = (edge: WidgetEdge): { width: number; height: number } =>
  isVertical(edge) ? { width: TAB_THICKNESS, height: TAB_LENGTH } : { width: TAB_LENGTH, height: TAB_THICKNESS };

const expandedSize = (edge: WidgetEdge, area: Rect): { width: number; height: number } =>
  isVertical(edge)
    ? { width: Math.min(PANEL_SHORT, area.width), height: Math.min(PANEL_LONG, area.height) }
    : { width: Math.min(PANEL_LONG, area.width), height: Math.min(PANEL_SHORT, area.height) };

export function clampOffset(edge: WidgetEdge, area: Rect, offset: number): number {
  const size = collapsedSize(edge);
  const slack = isVertical(edge) ? area.height - size.height : area.width - size.width;
  const half = Math.floor(Math.max(0, slack) / 2);
  return Math.round(clamp(offset, -half, half));
}

export function dockRect(edge: WidgetEdge, collapsed: boolean, area: Rect, offset: number): Rect {
  const size = collapsed ? collapsedSize(edge) : expandedSize(edge, area);
  const shift = collapsed ? clampOffset(edge, area, offset) : 0;
  if (edge === "top") {
    return {
      x: Math.round(area.x + (area.width - size.width) / 2 + shift),
      y: Math.round(area.y),
      width: size.width,
      height: size.height,
    };
  }
  return {
    x: Math.round(edge === "left" ? area.x : area.x + area.width - size.width),
    y: Math.round(area.y + (area.height - size.height) / 2 + shift),
    width: size.width,
    height: size.height,
  };
}

export function offsetFromPosition(edge: WidgetEdge, area: Rect, position: { x: number; y: number }): number {
  const centered = dockRect(edge, true, area, 0);
  const raw = isVertical(edge) ? position.y - centered.y : position.x - centered.x;
  return clampOffset(edge, area, raw);
}

export function ringTone(utilization: number): Exclude<Tone, "muted"> {
  if (!Number.isFinite(utilization)) return "go";
  if (utilization > 90) return "hold";
  if (utilization >= 70) return "pend";
  return "go";
}

export interface UrgencyCounts {
  needYou: number;
  delegated: number;
  live: number;
}

export function urgencyTone(counts: UrgencyCounts): Tone {
  if (counts.needYou > 0) return "hold";
  if (counts.delegated > 0) return "pend";
  if (counts.live > 0) return "go";
  return "muted";
}

export const clampPercent = (value: number): number => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0);

export function resetsAtMs(resetsAt: number | null): number | null {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return null;
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
}

export function resetCountdown(resetsAt: number | null, now: number): string | null {
  const at = resetsAtMs(resetsAt);
  if (at == null) return null;
  const minutes = Math.max(0, Math.floor((at - now) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 > 0 ? `${days}d ${hours % 24}h` : `${days}d`;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}
