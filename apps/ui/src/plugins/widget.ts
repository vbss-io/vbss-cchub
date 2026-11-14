import type { HubPlugin } from "./types";

export const widgetPlugin: HubPlugin = {
  id: "widget",
  name: "Widget",
  description: "A small tab docked to a screen edge with your sessions and usage.",
  core: false,
  featureKey: "widget",
  views: [],
  settingsTab: { key: "widget", label: "Widget" },
  paletteCommands: ({ toggleWidget }) => (toggleWidget ? { toggleWidget } : {}),
};
