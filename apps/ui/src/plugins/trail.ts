import type { HubPlugin } from "./types";

export const trailPlugin: HubPlugin = {
  id: "trail",
  name: "Session trail",
  description: "Summarizes each Claude Code session into a per-day file in your second brain.",
  core: false,
  featureKey: "trail",
  views: [],
  settingsTab: { key: "trail", label: "Session trail" },
};
