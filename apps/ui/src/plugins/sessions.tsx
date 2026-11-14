import { IconSessions } from "../icons";
import type { HubPlugin } from "./types";

export const sessionsPlugin: HubPlugin = {
  id: "sessions",
  name: "Sessions",
  description: "Every Claude Code session and Codex thread on this machine.",
  core: true,
  featureKey: null,
  settingsTab: { key: "sessions", label: "Sessions" },
  views: [{ key: "sessions", label: "Sessions", icon: <IconSessions />, subtitle: "Everything running on this machine: Claude, Codex and delegated work" }],
};
