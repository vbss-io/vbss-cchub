import type { ReactElement } from "react";
import type { CommandActions } from "../palette-items";
import type { HubFeatures } from "../delegation";

export type PluginId = "sessions" | "today" | "tasks" | "flow" | "delegated" | "usage" | "limits" | "workspaces" | "reports" | "share" | "trail" | "widget";

export type PluginViewKey = "sessions" | "daily" | "board" | "flow" | "tasks" | "usage" | "workspaces" | "reports" | "share";

export type View = PluginViewKey | "settings";

export type FeatureKey = keyof HubFeatures;

export type FeatureFlags = Partial<HubFeatures> | null | undefined;

export interface PluginViewDef {
  key: PluginViewKey;
  label: string;
  subtitle: string;
  icon: ReactElement;
}

export interface ViewItem extends PluginViewDef {
  pluginId: PluginId;
}

export interface PluginSettingsTab {
  key: string;
  label: string;
}

export interface PaletteContext {
  dispatch: (view: PluginViewKey, event: string) => void;
  startCapture: () => void;
  toggleWidget: (() => void) | null;
}

export type PluginCommandActions = Pick<CommandActions, "newTask" | "startDay" | "planToday" | "refreshDaily" | "startCapture" | "toggleWidget">;

export interface HubPlugin {
  id: PluginId;
  name: string;
  description: string;
  core: boolean;
  featureKey: FeatureKey | null;
  dependsOn?: PluginId[];
  views: PluginViewDef[];
  settingsTab?: PluginSettingsTab;
  paletteCommands?: (context: PaletteContext) => PluginCommandActions;
}
