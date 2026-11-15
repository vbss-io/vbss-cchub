export type PanelSide = "start" | "end";

export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;
export const DEFAULT_COLLAPSE_BELOW = 900;

export function clampSize(size: number, min: number, max: number): number {
  const high = Math.max(min, max);
  if (!Number.isFinite(size)) return min;
  return Math.min(high, Math.max(min, Math.round(size)));
}

export const PANEL_NAV_WIDTH = 232;
export const PANEL_MAIN_MIN = 240;
export const DRAWER_VIEWPORT_RESERVE = 96;

export function drawerReserve(inGrid: boolean, navWidth: number | null): number {
  if (!inGrid) return DRAWER_VIEWPORT_RESERVE;
  const nav = navWidth !== null && Number.isFinite(navWidth) && navWidth > 0 ? Math.round(navWidth) : PANEL_NAV_WIDTH;
  return nav + PANEL_MAIN_MIN;
}

export function effectiveMax(min: number, max: number, containerSize: number, reserve: number): number {
  if (!Number.isFinite(containerSize) || containerSize <= 0) return Math.max(min, max);
  return Math.max(min, Math.min(max, containerSize - reserve));
}

export function sizeFromDelta(startSize: number, delta: number, side: PanelSide, min: number, max: number): number {
  const signed = side === "start" ? delta : -delta;
  return clampSize(startSize + signed, min, max);
}

export function keyboardSize(
  size: number,
  key: string,
  shift: boolean,
  side: PanelSide,
  min: number,
  max: number,
): number | null {
  const step = shift ? KEY_STEP_LARGE : KEY_STEP;
  if (key === "Home") return clampSize(min, min, max);
  if (key === "End") return clampSize(max, min, max);
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const rightward = key === "ArrowRight" ? step : -step;
  return sizeFromDelta(size, rightward, side, min, max);
}

export function resetSize(defaultSize: number, min: number, max: number): number {
  return clampSize(defaultSize, min, max);
}

export function isStacked(viewportWidth: number, collapseBelow: number): boolean {
  return viewportWidth < collapseBelow;
}

export const SPLIT_SIDE_MIN = 240;
export const SPLIT_NARROW_RATIO = 0.2;
export const SPLIT_UNMEASURED_MAX = 4000;

export function splitSideMin(containerSize: number): number {
  if (!Number.isFinite(containerSize) || containerSize <= 0) return SPLIT_SIDE_MIN;
  return Math.max(1, Math.min(SPLIT_SIDE_MIN, Math.round(containerSize * SPLIT_NARROW_RATIO)));
}

export function sharedSplitBounds(containerSize: number, dividerSize = 1): { min: number; max: number } {
  const min = splitSideMin(containerSize);
  if (!Number.isFinite(containerSize) || containerSize <= 0) return { min, max: SPLIT_UNMEASURED_MAX };
  return { min, max: Math.max(min, Math.floor(containerSize - min - Math.max(0, dividerSize))) };
}
