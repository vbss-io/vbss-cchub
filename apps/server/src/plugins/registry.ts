import type { DelegationFeatures } from "../delegation-types.js";
import type { PluginManifest, PluginRoute, PluginView, ServerPlugin } from "./types.js";

export const isPluginOn = (plugin: PluginManifest, features: DelegationFeatures): boolean =>
  plugin.featureKey === null || features[plugin.featureKey];

export const enabledPlugins = <T extends PluginManifest>(plugins: readonly T[], features: DelegationFeatures): T[] =>
  plugins.filter((plugin) => isPluginOn(plugin, features));

export const allowedTools = (plugins: readonly PluginManifest[], features: DelegationFeatures): string[] =>
  enabledPlugins(plugins, features).flatMap((plugin) => [...plugin.tools]);

export const pluginOfTool = <T extends PluginManifest>(plugins: readonly T[], tool: string): T | undefined =>
  plugins.find((plugin) => plugin.tools.includes(tool));

export const pluginViews = (plugins: readonly PluginManifest[], features: DelegationFeatures): PluginView[] =>
  plugins.map((plugin) => ({ id: plugin.id, name: plugin.name, enabled: isPluginOn(plugin, features), tools: [...plugin.tools] }));

export const orderedRoutes = (plugins: readonly ServerPlugin[]): PluginRoute[] =>
  plugins.flatMap((plugin) => [...plugin.routes]).sort((a, b) => a.order - b.order);
