import { tasksBoardRouter } from "../tasks-board-routes.js";
import type { ServerPlugin } from "./types.js";

export const tasksPlugin: ServerPlugin = {
  id: "tasks",
  name: "Tasks",
  featureKey: "tasks",
  tools: [],
  routes: [{ order: 110, mount: "/delegation", router: tasksBoardRouter }],
};
