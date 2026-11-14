import { START_DAY_EVENT } from "../today-model";
import type { HubPlugin } from "./types";

function IconDaily({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="15" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
      <path d="m8.5 14 2 2 4-4" />
    </svg>
  );
}

export const todayPlugin: HubPlugin = {
  id: "today",
  name: "Today",
  description: "Your daily note as a plan: focus, backlog, meetings and captures.",
  core: false,
  featureKey: "daily",
  views: [{ key: "daily", label: "Today", icon: <IconDaily />, subtitle: "Your day: focus, backlog, meetings and captures" }],
  settingsTab: { key: "today", label: "Today" },
  paletteCommands: ({ dispatch, startCapture }) => ({
    startDay: () => dispatch("daily", START_DAY_EVENT),
    planToday: () => dispatch("daily", "cchub:daily-plan-today"),
    refreshDaily: () => dispatch("daily", "cchub:daily-refresh"),
    startCapture,
  }),
};
