import { useEffect, useMemo, useRef } from "react";
import "../settings.css";
import type { HooksStatus } from "../api";
import type { AutostartStatus, ConnectStatus, DelegationSettings, McpClient, SettingsPatch, ShellKind, TunnelStatus } from "../delegation";
import { isPluginEnabled } from "../plugins/registry";
import { resolveSettingsTab } from "../settings-model";
import { settingsTabs } from "../settings-sections";
import type { GroupRecord } from "../types";
import { AboutTab } from "./settings/AboutTab";
import { AppearanceTab, type ThemeName } from "./settings/AppearanceTab";
import { ConnectionsTab } from "./settings/ConnectionsTab";
import { GeneralTab } from "./settings/GeneralTab";
import { GroupsTab } from "./settings/GroupsTab";
import { NotificationsTab, type NotifSettings } from "./settings/NotificationsTab";
import { PluginsTab } from "./settings/PluginsTab";
import { ShareTab } from "./settings/ShareTab";
import { TasksTab } from "./settings/TasksTab";
import { TodayTab } from "./settings/TodayTab";
import { TrailTab } from "./settings/TrailTab";
import { UsageTab } from "./settings/UsageTab";
import { WidgetTab } from "./settings/WidgetTab";

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
  onToggleHooks: () => void;
  onSaveSettings: (patch: SettingsPatch) => Promise<void>;
  onShell: (kind: ShellKind, action: "install" | "uninstall") => Promise<void>;
  onMcp: (client: McpClient, action: "install" | "uninstall") => Promise<void>;
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
  const tabs = useMemo(() => settingsTabs(features), [features]);
  const active = resolveSettingsTab(section, tabs);
  const navRef = useRef<HTMLElement>(null);
  const tabProps = { enabled, settings, onSaveSettings: props.onSaveSettings };

  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [active]);

  return (
    <div className="view view--settings">
      <nav className="settings-tabs" aria-label="Settings sections" ref={navRef}>
        {tabs.map((tab) => (
          <a key={tab.key} className={`pill ${active === tab.key ? "pill--on" : ""}`} href={`#/settings/${tab.key}`} aria-current={active === tab.key ? "page" : undefined}>
            {tab.label}
          </a>
        ))}
      </nav>

      <div className="settings-panel" data-tab={active}>
        {active === "general" && <GeneralTab {...tabProps} autostart={props.autostart} onAutostart={props.onAutostart} />}
        {active === "appearance" && <AppearanceTab settings={settings} theme={props.theme} onTheme={props.onTheme} />}
        {active === "plugins" && <PluginsTab {...tabProps} />}
        {active === "today" && <TodayTab {...tabProps} />}
        {active === "tasks" && <TasksTab {...tabProps} />}
        {active === "trail" && <TrailTab {...tabProps} />}
        {active === "usage" && <UsageTab {...tabProps} usageOn={isPluginEnabled("usage", features)} limitsOn={isPluginEnabled("limits", features)} />}
        {active === "widget" && <WidgetTab {...tabProps} />}
        {active === "sharing" && <ShareTab {...tabProps} tunnel={props.tunnel} onTunnelSettings={props.onTunnelSettings} />}
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
          />
        )}
        {active === "notifications" && <NotificationsTab notif={props.notif} onNotif={props.onNotif} />}
        {active === "groups" && (
          <GroupsTab groups={props.groups} onCreateGroup={props.onCreateGroup} onUpdateGroup={props.onUpdateGroup} onDeleteGroup={props.onDeleteGroup} onMoveGroup={props.onMoveGroup} />
        )}
        {active === "about" && <AboutTab hubUrl={hubUrl} version={version} onWhatsNew={props.onWhatsNew} />}
      </div>
    </div>
  );
}
