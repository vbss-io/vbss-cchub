export interface HubPluginInfo {
  id: string;
  name: string;
  enabled: boolean;
  tools: string[];
}

export const agentToolsFor = (pluginIds: readonly string[], plugins: readonly HubPluginInfo[] | null): string[] | null => {
  if (plugins === null) return null;
  const known = pluginIds.map((id) => plugins.find((plugin) => plugin.id === id)).filter((plugin): plugin is HubPluginInfo => plugin !== undefined);
  if (known.length === 0) return null;
  return [...new Set(known.flatMap((plugin) => plugin.tools))];
};
