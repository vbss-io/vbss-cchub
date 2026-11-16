import type { SidebarPrefs } from "./delegation";
import { isPluginEnabled, PLUGINS, pluginSettingsTabs, type SidebarModel } from "./plugins/registry";
import type { FeatureFlags, HubPlugin, PluginId, PluginViewKey } from "./plugins/types";

export interface SettingsTabEntry {
  key: string;
  label: string;
}

export interface SettingsPageEntry extends SettingsTabEntry {
  pluginIds: PluginId[];
}

export interface SettingsLocation {
  tab: string;
  page: SettingsPageEntry | null;
  pluginId: PluginId | null;
}

export type SettingsSection = string;

const TABS_BEFORE_PLUGIN_PAGES: SettingsTabEntry[] = [
  { key: "general", label: "General" },
  { key: "appearance", label: "Appearance" },
  { key: "plugins", label: "Plugins" },
];

const TABS_AFTER_PLUGIN_PAGES: SettingsTabEntry[] = [
  { key: "memory", label: "Memory" },
  { key: "connections", label: "Connections" },
  { key: "notifications", label: "Notifications" },
  { key: "groups", label: "Groups" },
  { key: "about", label: "About" },
];

export const DEFAULT_SETTINGS_TAB = "general";

export const PLUGINS_TAB = "plugins";

const PLUGIN_PAGE_PREFIX = "plugin-";

export const LEGACY_SECTION_TAB: Readonly<Record<string, string>> = {
  support: "about",
  paths: "general",
  hooks: "connections",
  connect: "connections",
  features: PLUGINS_TAB,
};

const LEGACY_PLUGIN_SECTION: Readonly<Record<string, PluginId>> = {
  sessions: "sessions",
  today: "today",
  daily: "today",
  tasks: "tasks",
  usage: "usage",
  limits: "limits",
  sharing: "share",
  share: "share",
  trail: "trail",
  widget: "widget",
};

export const SETTINGS_TAB_KEYWORDS: Readonly<Record<string, string[]>> = {
  general: ["paths", "autostart", "startup", "windows", "autonomy", "timeout", "editor", "workspaces root", "second brain", "vault"],
  appearance: ["theme", "dracula", "midnight", "sidebar", "navigation", "pinned", "more"],
  plugins: ["features", "plugins", "enable", "disable", "toggle", "flow", "delegated", "workspaces", "reports"],
  "plugin-sessions": ["needs you", "on top", "band", "sessions", "plugin"],
  "plugin-today": ["daily", "diary", "template", "advanced", "plugin"],
  "plugin-tasks": ["board", "projects folder", "priority", "prefixes", "advanced", "plugin"],
  "plugin-trail": ["session trail", "summaries", "diary", "plugin"],
  "plugin-usage": ["limits", "quota", "tokens", "plugin"],
  "plugin-limits": ["usage", "quota", "tokens", "plugin"],
  "plugin-widget": ["tray", "overlay", "edge", "rings", "plugin"],
  "plugin-share": ["share", "sharing", "ngrok", "tunnel", "identity", "plugin"],
  memory: ["history", "search", "index", "rebuild", "clear", "day summary", "heading", "handoff", "context", "new sessions"],
  connections: ["hooks", "mcp", "shell", "alias", "wk", "claude code", "codex", "approvals", "permission", "allow", "deny", "codex hooks"],
  notifications: ["alerts", "toast", "sound"],
  groups: ["sessions", "workspace"],
  about: ["support", "version", "backups", "data", "whats new", "sponsor"],
};

export const pluginPageKey = (id: PluginId): string => `${PLUGIN_PAGE_PREFIX}${id}`;

export const hasPluginSettings = (plugin: HubPlugin): boolean => plugin.settingsTab !== undefined;

export const pluginSettingsPages = (features: FeatureFlags): SettingsPageEntry[] =>
  pluginSettingsTabs(features).flatMap((tab) => {
    const [first] = tab.pluginIds;
    return first === undefined ? [] : [{ key: pluginPageKey(first), label: tab.label, pluginIds: tab.pluginIds }];
  });

export const buildSettingsTabs = (pluginPages: readonly SettingsTabEntry[]): SettingsTabEntry[] => [
  ...TABS_BEFORE_PLUGIN_PAGES,
  ...pluginPages.map(({ key, label }) => ({ key, label })),
  ...TABS_AFTER_PLUGIN_PAGES,
];

export const coreSettingsTabs = (): SettingsTabEntry[] => buildSettingsTabs([]);

const sectionPluginId = (section: string): PluginId | null => {
  const id = section.startsWith(PLUGIN_PAGE_PREFIX) ? section.slice(PLUGIN_PAGE_PREFIX.length) : Object.hasOwn(LEGACY_PLUGIN_SECTION, section) ? LEGACY_PLUGIN_SECTION[section] : undefined;
  return PLUGINS.find((plugin) => plugin.id === id && hasPluginSettings(plugin))?.id ?? null;
};

export const isPluginPageSection = (section: string | null | undefined): boolean => Boolean(section) && sectionPluginId(section ?? "") !== null;

export const resolveSettingsLocation = (section: string | null | undefined, features: FeatureFlags): SettingsLocation => {
  const list: SettingsLocation = { tab: PLUGINS_TAB, page: null, pluginId: null };
  if (!section) return { ...list, tab: DEFAULT_SETTINGS_TAB };
  const pluginId = sectionPluginId(section);
  if (pluginId !== null) {
    const page = isPluginEnabled(pluginId, features) ? pluginSettingsPages(features).find((candidate) => candidate.pluginIds.includes(pluginId)) : undefined;
    return page ? { tab: PLUGINS_TAB, page, pluginId } : list;
  }
  if (section.startsWith(PLUGIN_PAGE_PREFIX)) return list;
  const mapped = Object.hasOwn(LEGACY_SECTION_TAB, section) ? (LEGACY_SECTION_TAB[section] ?? section) : section;
  const known = coreSettingsTabs().some((tab) => tab.key === mapped);
  return { tab: known ? mapped : DEFAULT_SETTINGS_TAB, page: null, pluginId: null };
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
