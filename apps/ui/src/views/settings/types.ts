import type { DelegationSettings, SettingsPatch } from "../../delegation";

export interface SettingsTabProps {
  enabled: boolean;
  settings: DelegationSettings | null;
  onSaveSettings: (patch: SettingsPatch) => Promise<void>;
}
