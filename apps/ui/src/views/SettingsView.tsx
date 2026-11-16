import { useCallback, useEffect, useMemo, useRef } from "react";
import "../settings.css";
import type { HooksStatus } from "../api";
import type { AutostartStatus, ConnectStatus, DelegationSettings, McpClient, SettingsPatch, ShellKind, TunnelStatus } from "../delegation";
import type { PluginId } from "../plugins/types";
import { isPluginPageSection, resolveSettingsLocation } from "../settings-model";
import { coreSettingsTabs } from "../settings-sections";
import type { GroupRecord, HistoryIndexStatus } from "../types";
import { AboutTab } from "./settings/AboutTab";
import { AppearanceTab, type ThemeName } from "./settings/AppearanceTab";
import { ConnectionsTab } from "./settings/ConnectionsTab";
import { GeneralTab } from "./settings/GeneralTab";
import { GroupsTab } from "./settings/GroupsTab";
import { HealthTab } from "./settings/HealthTab";
import { MemoryTab } from "./settings/MemoryTab";
import { NotificationsTab, type NotifSettings } from "./settings/NotificationsTab";
import { PluginPage } from "./settings/PluginPage";
import { PluginsTab } from "./settings/PluginsTab";

export type { NotifSettings, ThemeName };
export type { SettingsSection } from "../settings-model";

interface Props {
  enabled: boolean;
  hubUrl: string;
  version: string;
  section: string | null;
  settings: DelegationSettings | null;
  connect: ConnectStatus | null;
  hooks: HooksStatus | null;
  hooksBusy: boolean;
  notif: NotifSettings;
  groups: GroupRecord[];
  subscribeHistory: (listener: (status: HistoryIndexStatus) => void) => () => void;
  onToggleHooks: () => void;
  onSaveSettings: (patch: SettingsPatch) => Promise<void>;
  onShell: (kind: ShellKind, action: "install" | "uninstall") => Promise<void>;
  onMcp: (client: McpClient, action: "install" | "uninstall") => Promise<void>;
  onCodexHooks: (action: "install" | "uninstall") => Promise<void>;
  tunnel: TunnelStatus | null;
  onTunnelSettings: (patch: { authtoken?: string | null; domain?: string | null }) => Promise<void>;
  autostart: AutostartStatus | null;
  onAutostart: (enabled: boolean) => Promise<void>;
  theme: ThemeName;
  onTheme: (theme: ThemeName) => void;
  onNotif: (next: NotifSettings) => void;
  onWhatsNew: () => void;
  onCreateGroup: (name: string, match: string) => void;
  onUpdateGroup: (id: string, fields: { name?: string; match?: string }) => void;
  onDeleteGroup: (id: string) => void;
  onMoveGroup: (id: string, direction: -1 | 1) => void;
}

export function SettingsView(props: Props) {
  const { enabled, hubUrl, version, section, settings } = props;
  const features = settings?.features ?? null;
  const tabs = useMemo(() => coreSettingsTabs(), []);
  const location = resolveSettingsLocation(section, features);
  const active = location.tab;
  const loadingPage = enabled && settings === null && isPluginPageSection(section);
  const navRef = useRef<HTMLElement>(null);
  const returnTo = useRef<PluginId | null>(null);
  const tabProps = { enabled, settings, onSaveSettings: props.onSaveSettings };
  const onFocusRestored = useCallback(() => {
    returnTo.current = null;
  }, []);

  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [active]);

  useEffect(() => {
    if (location.pluginId !== null) returnTo.current = location.pluginId;
    else if (active !== "plugins" && !loadingPage) returnTo.current = null;
  }, [location.pluginId, active, loadingPage]);

  return (
    <div className="view view--settings">
      <nav className="settings-tabs" aria-label="Settings sections" ref={navRef}>
        {tabs.map((tab) => (
          <a key={tab.key} className={`pill ${active === tab.key ? "pill--on" : ""}`} href={`#/settings/${tab.key}`} aria-current={active === tab.key ? "page" : undefined}>
            {tab.label}
          </a>
        ))}
      </nav>

      <div className="settings-panel" data-tab={location.page ? location.page.key : active}>
        {active === "general" && <GeneralTab {...tabProps} autostart={props.autostart} onAutostart={props.onAutostart} />}
        {active === "appearance" && <AppearanceTab settings={settings} theme={props.theme} onTheme={props.onTheme} />}
        {loadingPage && <p className="hint" role="status">Loading your plugin settings...</p>}
        {!loadingPage && active === "plugins" && location.page === null && <PluginsTab {...tabProps} restoreFocus={returnTo.current} onFocusRestored={onFocusRestored} />}
        {!loadingPage && location.page !== null && location.pluginId !== null && (
          <PluginPage {...tabProps} page={location.page} pluginId={location.pluginId} features={features} tunnel={props.tunnel} onTunnelSettings={props.onTunnelSettings} />
        )}
        {active === "memory" && <MemoryTab {...tabProps} subscribeHistory={props.subscribeHistory} />}
        {active === "connections" && (
          <ConnectionsTab
            enabled={enabled}
            hubUrl={hubUrl}
            connect={props.connect}
            hooks={props.hooks}
            hooksBusy={props.hooksBusy}
            onToggleHooks={props.onToggleHooks}
            onShell={props.onShell}
            onMcp={props.onMcp}
            settings={settings}
            onSaveSettings={props.onSaveSettings}
            onCodexHooks={props.onCodexHooks}
          />
        )}
        {active === "health" && <HealthTab {...tabProps} />}
        {active === "notifications" && <NotificationsTab notif={props.notif} onNotif={props.onNotif} />}
        {active === "groups" && (
          <GroupsTab groups={props.groups} onCreateGroup={props.onCreateGroup} onUpdateGroup={props.onUpdateGroup} onDeleteGroup={props.onDeleteGroup} onMoveGroup={props.onMoveGroup} />
        )}
        {active === "about" && <AboutTab hubUrl={hubUrl} version={version} onWhatsNew={props.onWhatsNew} />}
      </div>
    </div>
  );
}
