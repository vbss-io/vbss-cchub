import { IconWorkspaces } from "../icons";
import type { HubPlugin } from "./types";

export const workspacesPlugin: HubPlugin = {
  id: "workspaces",
  name: "Workspaces",
  description: "The workspace registry your wk alias uses.",
  core: false,
  featureKey: "workspaces",
  views: [{ key: "workspaces", label: "Workspaces", icon: <IconWorkspaces />, subtitle: "The same registry your wk alias uses" }],
};
