import type { SidebarPrefs } from "./delegation";
import { PLUGINS, type SidebarModel } from "./plugins/registry";
import type { HubPlugin, PluginViewKey } from "./plugins/types";

export interface SettingsTabEntry {
  key: string;
  label: string;
}

export type SettingsSection = string;

const TABS_BEFORE_PLUGINS: SettingsTabEntry[] = [
  { key: "general", label: "General" },
  { key: "appearance", label: "Appearance" },
  { key: "plugins", label: "Plugins" },
];

const TABS_AFTER_PLUGINS: SettingsTabEntry[] = [
  { key: "connections", label: "Connections" },
  { key: "notifications", label: "Notifications" },
  { key: "groups", label: "Groups" },
  { key: "about", label: "About" },
];

export const DEFAULT_SETTINGS_TAB = "general";

export const LEGACY_SECTION_TAB: Readonly<Record<string, string>> = {
  support: "about",
  paths: "general",
  hooks: "connections",
  connect: "connections",
  features: "plugins",
  sharing: "sharing",
};

export const SETTINGS_TAB_KEYWORDS: Readonly<Record<string, string[]>> = {
  general: ["paths", "autostart", "startup", "windows", "autonomy", "timeout", "editor", "workspaces root", "second brain", "vault"],
  appearance: ["theme", "dracula", "midnight", "sidebar", "navigation", "pinned", "more"],
  plugins: ["features", "plugins", "enable", "disable", "toggle", "flow", "delegated", "workspaces", "reports"],
  today: ["daily", "diary", "template", "advanced"],
  tasks: ["board", "projects folder", "priority", "prefixes", "advanced"],
  trail: ["session trail", "summaries", "diary"],
  usage: ["limits", "quota", "tokens"],
  widget: ["tray", "overlay", "edge", "rings"],
  sharing: ["share", "ngrok", "tunnel", "identity"],
  connections: ["hooks", "mcp", "shell", "alias", "wk", "claude code", "codex"],
  notifications: ["alerts", "toast", "sound"],
  groups: ["sessions", "workspace"],
  about: ["support", "version", "backups", "data", "whats new", "sponsor"],
};

export const buildSettingsTabs = (pluginTabs: readonly SettingsTabEntry[]): SettingsTabEntry[] => [
  ...TABS_BEFORE_PLUGINS,
  ...pluginTabs.map(({ key, label }) => ({ key, label })),
  ...TABS_AFTER_PLUGINS,
];

const pluginTabKeys = (): Set<string> => new Set(PLUGINS.flatMap((plugin) => (plugin.settingsTab ? [plugin.settingsTab.key] : [])));

export const resolveSettingsTab = (section: string | null | undefined, tabs: readonly SettingsTabEntry[]): string => {
  if (!section) return DEFAULT_SETTINGS_TAB;
  const mapped = Object.hasOwn(LEGACY_SECTION_TAB, section) ? (LEGACY_SECTION_TAB[section] ?? section) : section;
  if (tabs.some((tab) => tab.key === mapped)) return mapped;
  return pluginTabKeys().has(mapped) ? "plugins" : DEFAULT_SETTINGS_TAB;
};

export const needsVault = (plugin: HubPlugin): boolean => plugin.id === "today" || plugin.id === "tasks" || plugin.id === "trail";

export const pluginHints = (plugin: HubPlugin, isEnabled: (id: HubPlugin["id"]) => boolean, hasVault: boolean): string[] => {
  const hints: string[] = [];
  for (const id of plugin.dependsOn ?? []) {
    if (isEnabled(id)) continue;
    const dependency = PLUGINS.find((candidate) => candidate.id === id);
    hints.push(`Needs ${dependency?.name ?? id}`);
  }
  if (needsVault(plugin) && !hasVault) hints.push("Needs a vault folder");
  return hints;
};

export interface SidebarRow {
  key: PluginViewKey;
  label: string;
  pinned: boolean;
}

export const sidebarRows = (model: SidebarModel): SidebarRow[] => [
  ...model.pinned.map((view) => ({ key: view.key, label: view.label, pinned: true })),
  ...model.more.map((view) => ({ key: view.key, label: view.label, pinned: false })),
];

const regroup = (rows: readonly SidebarRow[]): SidebarRow[] => [...rows.filter((row) => row.pinned), ...rows.filter((row) => !row.pinned)];

export const pinnedCount = (rows: readonly SidebarRow[]): number => rows.filter((row) => row.pinned).length;

export const canMoveRow = (rows: readonly SidebarRow[], key: PluginViewKey, delta: -1 | 1): boolean => {
  const index = rows.findIndex((row) => row.key === key);
  const neighbour = rows[index + delta];
  return index >= 0 && neighbour !== undefined && neighbour.pinned === rows[index]?.pinned;
};

export const moveRow = (rows: readonly SidebarRow[], key: PluginViewKey, delta: -1 | 1): SidebarRow[] => {
  if (!canMoveRow(rows, key, delta)) return [...rows];
  const index = rows.findIndex((row) => row.key === key);
  const next = [...rows];
  const moved = next[index];
  const other = next[index + delta];
  if (!moved || !other) return next;
  next[index] = other;
  next[index + delta] = moved;
  return next;
};

export const canSetPinned = (rows: readonly SidebarRow[], key: PluginViewKey, pinned: boolean): boolean => {
  const row = rows.find((candidate) => candidate.key === key);
  if (!row || row.pinned === pinned) return false;
  return pinned || pinnedCount(rows) > 1;
};

export const setRowPinned = (rows: readonly SidebarRow[], key: PluginViewKey, pinned: boolean): SidebarRow[] => {
  if (!canSetPinned(rows, key, pinned)) return [...rows];
  return regroup(rows.map((row) => (row.key === key ? { ...row, pinned } : row)));
};

export const dropRow = (rows: readonly SidebarRow[], key: PluginViewKey, targetKey: PluginViewKey): SidebarRow[] => {
  const from = rows.findIndex((row) => row.key === key);
  const target = rows.findIndex((row) => row.key === targetKey);
  const source = rows[from];
  const destination = rows[target];
  if (from < 0 || target < 0 || from === target || !source || !destination) return [...rows];
  if (source.pinned && !destination.pinned && pinnedCount(rows) <= 1) return [...rows];
  const remaining = rows.filter((row) => row.key !== key);
  const targetIndex = remaining.findIndex((row) => row.key === targetKey);
  const at = from < target ? targetIndex + 1 : targetIndex;
  remaining.splice(at, 0, { ...source, pinned: destination.pinned });
  return regroup(remaining);
};

export const sameRows = (a: readonly SidebarRow[], b: readonly SidebarRow[]): boolean =>
  a.length === b.length && a.every((row, index) => row.key === b[index]?.key && row.pinned === b[index]?.pinned);

export const commitSidebar = (rows: readonly SidebarRow[], previous: SidebarPrefs): SidebarPrefs => {
  const shown = new Set<string>(rows.map((row) => row.key));
  return {
    order: [...rows.map((row) => row.key), ...previous.order.filter((key) => !shown.has(key))],
    pinned: [...rows.filter((row) => row.pinned).map((row) => row.key), ...previous.pinned.filter((key) => !shown.has(key))],
  };
};
