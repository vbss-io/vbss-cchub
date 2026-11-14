import { pluginSettingsTabs } from "./plugins/registry";
import type { FeatureFlags } from "./plugins/types";
import { buildSettingsTabs, type SettingsTabEntry } from "./settings-model";

export const settingsTabs = (features: FeatureFlags): SettingsTabEntry[] => buildSettingsTabs(pluginSettingsTabs(features));
