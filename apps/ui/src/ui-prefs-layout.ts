export type UiLayout = Record<string, Record<string, number>>;

export interface UiLayoutPatch {
  layout: UiLayout;
}

export function layoutSize(
  layout: UiLayout | undefined,
  screen: string,
  key: string,
  fallback: number,
): number {
  if (!layout || !Object.hasOwn(layout, screen)) return fallback;
  const sizes = layout[screen];
  if (!sizes || !Object.hasOwn(sizes, key)) return fallback;
  const value = sizes[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function withLayoutSize(
  layout: UiLayout | undefined,
  screen: string,
  key: string,
  size: number,
): UiLayoutPatch {
  const current = layout && Object.hasOwn(layout, screen) ? (layout[screen] ?? {}) : {};
  if (!Number.isFinite(size) || size <= 0) return { layout: { [screen]: { ...current } } };
  return { layout: { [screen]: { ...current, [key]: Math.round(size) } } };
}

export function mergeLayoutPatch(layout: UiLayout | undefined, patch: UiLayoutPatch): UiLayout {
  const merged: UiLayout = { ...(layout ?? {}) };
  for (const [screen, sizes] of Object.entries(patch.layout)) {
    const existing = Object.hasOwn(merged, screen) ? merged[screen] : undefined;
    merged[screen] = { ...(existing ?? {}), ...sizes };
  }
  return merged;
}
