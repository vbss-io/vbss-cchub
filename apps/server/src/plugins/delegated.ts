import { tasksRouter } from "../tasks-routes.js";
import type { ServerPlugin } from "./types.js";

export const delegatedPlugin: ServerPlugin = {
  id: "delegated",
  name: "Delegated",
  featureKey: "delegated",
  tools: [
    "hub_delegate",
    "hub_task",
    "hub_tasks",
    "hub_continue",
    "hub_cancel",
    "hub_task_archive",
    "hub_task_merge",
    "hub_task_events",
  ],
  routes: [{ order: 130, mount: "/delegation", router: tasksRouter }],
};
