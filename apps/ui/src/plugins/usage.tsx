import { IconUsage } from "../icons";
import type { HubPlugin } from "./types";

export const usagePlugin: HubPlugin = {
  id: "usage",
  name: "Usage",
  description: "Token usage on this machine, by model, project and session.",
  core: false,
  featureKey: "usage",
  views: [{ key: "usage", label: "Usage", icon: <IconUsage />, subtitle: "What burns your tokens on this machine, and how much of your plan is left" }],
  settingsTab: { key: "usage", label: "Usage" },
};
