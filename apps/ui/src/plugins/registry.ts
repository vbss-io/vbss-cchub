import type { SidebarPrefs } from "../delegation";
import { delegatedPlugin } from "./delegated";
import { flowPlugin } from "./flow";
import { limitsPlugin } from "./limits";
import { reportsPlugin } from "./reports";
import { sessionsPlugin } from "./sessions";
import { sharePlugin } from "./share";
import { tasksPlugin } from "./tasks";
import { todayPlugin } from "./today";
import { trailPlugin } from "./trail";
import type { FeatureFlags, FeatureKey, HubPlugin, PaletteContext, PluginCommandActions, PluginId, PluginViewKey, View, ViewItem } from "./types";
import { usagePlugin } from "./usage";
import { widgetPlugin } from "./widget";
import { workspacesPlugin } from "./workspaces";

export const PLUGINS: readonly HubPlugin[] = [
  sessionsPlugin,
  todayPlugin,
  tasksPlugin,
  flowPlugin,
  delegatedPlugin,
  usagePlugin,
  limitsPlugin,
  workspacesPlugin,
  reportsPlugin,
  sharePlugin,
  trailPlugin,
  widgetPlugin,
];

const FALLBACK_PINNED: PluginViewKey = "sessions";

export const DEFAULT_PINNED: readonly PluginViewKey[] = ["sessions", "daily", "board", "flow"];

const OFF_WHEN_MISSING: ReadonlySet<FeatureKey> = new Set<FeatureKey>(["daily", "trail", "usage", "limits", "tasks"]);

export interface SidebarModel {
  pinned: ViewItem[];
  more: ViewItem[];
}

export interface PluginSettingsTabEntry {
  key: string;
  label: string;
  pluginIds: PluginId[];
}

export const pluginById = (id: PluginId): HubPlugin | undefined => PLUGINS.find((plugin) => plugin.id === id);

export const featureOn = (features: FeatureFlags, key: FeatureKey): boolean => {
  const value = features?.[key];
  return typeof value === "boolean" ? value : !OFF_WHEN_MISSING.has(key);
};

const pluginOn = (plugin: HubPlugin, features: FeatureFlags, visiting: ReadonlySet<PluginId>): boolean => {
  if (plugin.core) return true;
  if (visiting.has(plugin.id)) return false;
  if (plugin.featureKey !== null && !featureOn(features, plugin.featureKey)) return false;
  const next = new Set(visiting).add(plugin.id);
  return (plugin.dependsOn ?? []).every((id) => {
    const dependency = pluginById(id);
    return dependency !== undefined && pluginOn(dependency, features, next);
  });
};

export const isPluginEnabled = (id: PluginId, features: FeatureFlags): boolean => {
  const plugin = pluginById(id);
  return plugin !== undefined && pluginOn(plugin, features, new Set());
};

export const enabledPlugins = (features: FeatureFlags): HubPlugin[] => PLUGINS.filter((plugin) => pluginOn(plugin, features, new Set()));

const viewsOf = (plugins: readonly HubPlugin[]): ViewItem[] => plugins.flatMap((plugin) => plugin.views.map((view) => ({ ...view, pluginId: plugin.id })));

export const allViews = (): ViewItem[] => viewsOf(PLUGINS);

export const enabledViews = (features: FeatureFlags): ViewItem[] => viewsOf(enabledPlugins(features));

export const navViews = (features: FeatureFlags): ViewItem[] => enabledViews(features).filter((view) => view.inSidebar !== false);

export const viewItem = (key: string): ViewItem | undefined => allViews().find((view) => view.key === key);

export const parseView = (key: string | undefined): View | null => {
  if (key === "settings") return "settings";
  return key === undefined ? null : (viewItem(key)?.key ?? null);
};

export const isViewEnabled = (view: string, features: FeatureFlags): boolean => {
  if (view === "settings") return true;
  const item = viewItem(view);
  return item !== undefined && isPluginEnabled(item.pluginId, features);
};

export const defaultSidebarPrefs = (): SidebarPrefs => ({ order: allViews().filter((view) => view.inSidebar !== false).map((view) => view.key), pinned: [...DEFAULT_PINNED] });

export const sidebarModel = (features: FeatureFlags, prefs: SidebarPrefs | null | undefined): SidebarModel => {
  const views = navViews(features);
  const source = prefs ?? defaultSidebarPrefs();
  const byKey = new Map(views.map((view) => [view.key as string, view]));
  const ordered: ViewItem[] = [];
  const placed = new Set<string>();
  for (const key of [...source.order, ...source.pinned]) {
    const view = byKey.get(key);
    if (!view || placed.has(key)) continue;
    placed.add(key);
    ordered.push(view);
  }
  const pinnedKeys = new Set(source.pinned);
  const resolved = ordered.filter((view) => pinnedKeys.has(view.key));
  const pinned = resolved.length > 0 ? resolved : views.filter((view) => view.key === FALLBACK_PINNED);
  const pinnedNow = new Set<string>(pinned.map((view) => view.key));
  const more = [...ordered, ...views.filter((view) => !placed.has(view.key))].filter((view) => !pinnedNow.has(view.key));
  return { pinned, more };
};

export const pluginSettingsTabs = (features: FeatureFlags): PluginSettingsTabEntry[] => {
  const tabs: PluginSettingsTabEntry[] = [];
  for (const plugin of enabledPlugins(features)) {
    if (!plugin.settingsTab) continue;
    const existing = tabs.find((tab) => tab.key === plugin.settingsTab?.key);
    if (existing) existing.pluginIds.push(plugin.id);
    else tabs.push({ key: plugin.settingsTab.key, label: plugin.settingsTab.label, pluginIds: [plugin.id] });
  }
  return tabs;
};

export const pluginCommandActions = (features: FeatureFlags, context: PaletteContext): PluginCommandActions => {
  let actions: PluginCommandActions = {};
  for (const plugin of enabledPlugins(features)) {
    if (plugin.paletteCommands) actions = { ...actions, ...plugin.paletteCommands(context) };
  }
  return actions;
};
