import type { SidebarPrefs, UiLayoutPrefs, UiPrefs, UiPrefsPatch } from "../delegation";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = (value: unknown): string[] | null => (Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : null);

export const emptyUiPrefs = (): UiPrefs => ({ sidebar: null, layout: {} });

const normalizeSidebar = (value: unknown): SidebarPrefs | null => {
  if (!isRecord(value)) return null;
  const order = stringList(value.order);
  const pinned = stringList(value.pinned);
  return order && pinned ? { order, pinned } : null;
};

const normalizeLayout = (value: unknown): UiLayoutPrefs => {
  if (!isRecord(value)) return {};
  const layout: UiLayoutPrefs = {};
  for (const [screen, sizes] of Object.entries(value)) {
    if (!isRecord(sizes)) continue;
    const parsed: Record<string, number> = {};
    for (const [key, size] of Object.entries(sizes)) {
      if (typeof size === "number" && Number.isFinite(size)) parsed[key] = size;
    }
    layout[screen] = parsed;
  }
  return layout;
};

export const normalizeUiPrefs = (value: unknown): UiPrefs => {
  if (!isRecord(value)) return emptyUiPrefs();
  return { sidebar: normalizeSidebar(value.sidebar), layout: normalizeLayout(value.layout) };
};

export const applyUiPrefsPatch = (prefs: UiPrefs, patch: UiPrefsPatch): UiPrefs => {
  const layout: UiLayoutPrefs = { ...prefs.layout };
  for (const [screen, sizes] of Object.entries(patch.layout ?? {})) {
    layout[screen] = { ...(Object.hasOwn(layout, screen) ? layout[screen] : {}), ...sizes };
  }
  return { sidebar: patch.sidebar === undefined ? prefs.sidebar : patch.sidebar, layout };
};
