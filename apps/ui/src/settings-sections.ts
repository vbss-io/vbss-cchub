import type { SettingsSection } from "./views/SettingsView";

export const SETTINGS_SECTIONS: { key: SettingsSection; label: string }[] = [
  { key: "support", label: "Support" },
  { key: "general", label: "General" },
  { key: "appearance", label: "Appearance" },
  { key: "paths", label: "Paths" },
  { key: "hooks", label: "Hooks" },
  { key: "connect", label: "Connections" },
  { key: "sharing", label: "Sharing" },
  { key: "features", label: "Features" },
  { key: "widget", label: "Widget" },
  { key: "notifications", label: "Notifications" },
  { key: "groups", label: "Groups" },
  { key: "about", label: "About" },
];
