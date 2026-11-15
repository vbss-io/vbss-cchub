export const SHELL_PREFS_SCREEN = "shell";
export const SIDEBAR_COLLAPSED_KEY = "sidebarCollapsed";
export const SIDEBAR_HINT_KEY = "hub.sidebar.collapsed";
export const SIDEBAR_TOGGLE_COMBO = "ctrl+b";
export const SIDEBAR_RAIL_QUERY = "(min-width: 900px)";

type LayoutPrefs = Readonly<Record<string, Readonly<Record<string, number>>>>;

export function storedSidebarCollapsed(layout: LayoutPrefs | undefined): boolean | null {
  if (!layout || !Object.hasOwn(layout, SHELL_PREFS_SCREEN)) return null;
  const screen = layout[SHELL_PREFS_SCREEN];
  if (!screen || !Object.hasOwn(screen, SIDEBAR_COLLAPSED_KEY)) return null;
  return screen[SIDEBAR_COLLAPSED_KEY] === 1;
}

export function withSidebarCollapsed(layout: LayoutPrefs | undefined, collapsed: boolean): { layout: Record<string, Record<string, number>> } {
  const current = layout && Object.hasOwn(layout, SHELL_PREFS_SCREEN) ? (layout[SHELL_PREFS_SCREEN] ?? {}) : {};
  return { layout: { [SHELL_PREFS_SCREEN]: { ...current, [SIDEBAR_COLLAPSED_KEY]: collapsed ? 1 : 0 } } };
}

export const parseSidebarHint = (raw: string | null | undefined): boolean => raw === "1";

export const sidebarHintValue = (collapsed: boolean): string => (collapsed ? "1" : "0");

export const resolveSidebarCollapsed = (layout: LayoutPrefs | undefined, hint: boolean): boolean => storedSidebarCollapsed(layout) ?? hint;

export const sidebarToggleLabel = (collapsed: boolean): string => (collapsed ? "Expand sidebar" : "Collapse sidebar");

export const railItemTitle = (label: string, badge: number): string => (badge > 0 ? `${label} (${badge})` : label);
