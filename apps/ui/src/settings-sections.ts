import type { FeatureFlags } from "./plugins/types";
import { buildSettingsTabs, coreSettingsTabs, pluginSettingsPages, type SettingsTabEntry } from "./settings-model";

export const settingsTabs = (features: FeatureFlags): SettingsTabEntry[] => buildSettingsTabs(pluginSettingsPages(features));

export { coreSettingsTabs };
