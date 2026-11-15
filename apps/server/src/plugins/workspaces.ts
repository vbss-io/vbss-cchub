import { workspacesRouter } from "../workspaces-routes.js";
import type { ServerPlugin } from "./types.js";

export const workspacesPlugin: ServerPlugin = {
  id: "workspaces",
  name: "Workspaces",
  featureKey: "workspaces",
  tools: ["hub_open_workspace", "hub_create_workspace", "hub_delete_workspace"],
  routes: [{ order: 60, mount: "/delegation", router: workspacesRouter }],
};
