import { IconFlow } from "../icons";
import type { HubPlugin } from "./types";

export const flowPlugin: HubPlugin = {
  id: "flow",
  name: "Flow",
  description: "A live map of workspaces, sessions, subagents and delegated tasks.",
  core: false,
  featureKey: "flow",
  views: [{ key: "flow", label: "Flow", icon: <IconFlow />, subtitle: "Workspaces, sessions, subagents and delegated tasks as a live map" }],
};
