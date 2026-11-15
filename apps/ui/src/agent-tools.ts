export interface HubPluginInfo {
  id: string;
  name: string;
  enabled: boolean;
  tools: string[];
}

const HUB_PLUGIN_IDS: Readonly<Record<string, string>> = { sessions: "core" };

export const hubPluginId = (uiPluginId: string): string => HUB_PLUGIN_IDS[uiPluginId] ?? uiPluginId;

export const agentToolsFor = (pluginIds: readonly string[], plugins: readonly HubPluginInfo[] | null): string[] | null => {
  if (plugins === null) return null;
  const known = pluginIds.map((id) => plugins.find((plugin) => plugin.id === hubPluginId(id))).filter((plugin): plugin is HubPluginInfo => plugin !== undefined);
  if (known.length === 0) return null;
  return [...new Set(known.flatMap((plugin) => plugin.tools))];
};

export const agentToolsCountText = (tools: readonly string[] | null): string | null => {
  if (tools === null || tools.length === 0) return null;
  return tools.length === 1 ? "1 agent tool" : `${tools.length} agent tools`;
};
