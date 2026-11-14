import type { HubPlugin } from "./types";

export const limitsPlugin: HubPlugin = {
  id: "limits",
  name: "Limits",
  description: "Your 5-hour and weekly plan limits in the status bar and the widget.",
  core: false,
  featureKey: "limits",
  dependsOn: ["usage"],
  views: [],
  settingsTab: { key: "usage", label: "Usage" },
};
