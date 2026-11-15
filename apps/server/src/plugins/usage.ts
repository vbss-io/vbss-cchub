import { usageRouter } from "../usage-routes.js";
import type { ServerPlugin } from "./types.js";

export const usagePlugin: ServerPlugin = {
  id: "usage",
  name: "Usage",
  featureKey: "usage",
  tools: [],
  routes: [{ order: 150, mount: "/delegation/usage", router: usageRouter }],
};
