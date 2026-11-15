import { useEffect, useRef, useState } from "react";
import { agentToolsFor, type HubPluginInfo } from "../../agent-tools";
import { Toggletip } from "../../components/Toggletip";
import { fetchPlugins, type TunnelStatus } from "../../delegation";
import { isPluginEnabled } from "../../plugins/registry";
import type { FeatureFlags, PluginId } from "../../plugins/types";
import type { SettingsPageEntry } from "../../settings-model";
import { SessionsTab } from "./SessionsTab";
import { ShareTab } from "./ShareTab";
import { TasksTab } from "./TasksTab";
import { TodayTab } from "./TodayTab";
import { TrailTab } from "./TrailTab";
import type { SettingsTabProps } from "./types";
import { UsageTab } from "./UsageTab";
import { WidgetTab } from "./WidgetTab";

interface Props extends SettingsTabProps {
  page: SettingsPageEntry;
  pluginId: PluginId;
  features: FeatureFlags;
  tunnel: TunnelStatus | null;
  onTunnelSettings: (patch: { authtoken?: string | null; domain?: string | null }) => Promise<void>;
}

const backToPlugins = () => {
  window.location.hash = "#/settings/plugins";
};

export function PluginPage({ page, pluginId, features, tunnel, onTunnelSettings, ...tabProps }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [hubPlugins, setHubPlugins] = useState<HubPluginInfo[] | null>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [page.key]);

  useEffect(() => {
    let alive = true;
    void fetchPlugins().then((list) => {
      if (alive) setHubPlugins(list);
    });
    return () => {
      alive = false;
    };
  }, [page.key]);

  const agentTools = agentToolsFor(page.pluginIds, hubPlugins);

  return (
    <>
      <header className="plugin-page__head">
        <button type="button" className="act plugin-page__back" onClick={backToPlugins}>
          <span aria-hidden="true">←</span> Plugins
        </button>
        <span className="plugin-page__sep" aria-hidden="true">/</span>
        <h2 className="plugin-page__title" tabIndex={-1} ref={headingRef}>
          {page.label}
        </h2>
      </header>
      {agentTools !== null && (
        <p className="hint plugin-page__tools">
          <span>Agent tools</span>
          {agentTools.length === 0 ? <span>None</span> : agentTools.map((tool) => <code key={tool}>{tool}</code>)}
          <Toggletip label="About agent tools">
            The MCP tools this plugin gives Claude Code and Codex sessions. Turning the plugin on or off applies to new sessions; a session already open keeps the list it started with.
          </Toggletip>
        </p>
      )}
      <div className="plugin-page__body" data-plugin-page={pluginId}>
        {page.pluginIds.some((id) => id === "sessions") && <SessionsTab />}
        {page.pluginIds.some((id) => id === "today") && <TodayTab {...tabProps} />}
        {page.pluginIds.some((id) => id === "tasks") && <TasksTab {...tabProps} />}
        {page.pluginIds.some((id) => id === "trail") && <TrailTab {...tabProps} />}
        {page.pluginIds.some((id) => id === "usage" || id === "limits") && (
          <UsageTab {...tabProps} usageOn={isPluginEnabled("usage", features)} limitsOn={isPluginEnabled("limits", features)} />
        )}
        {page.pluginIds.some((id) => id === "widget") && <WidgetTab {...tabProps} />}
        {page.pluginIds.some((id) => id === "share") && <ShareTab {...tabProps} tunnel={tunnel} onTunnelSettings={onTunnelSettings} />}
      </div>
    </>
  );
}
