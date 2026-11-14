import { IconSessions } from "../icons";
import type { HubPlugin } from "./types";

export const sessionsPlugin: HubPlugin = {
  id: "sessions",
  name: "Sessions",
  description: "Every Claude Code session and Codex thread on this machine.",
  core: true,
  featureKey: null,
  views: [{ key: "sessions", label: "Sessions", icon: <IconSessions />, subtitle: "Every Claude Code session on this machine, plus Codex threads" }],
};
