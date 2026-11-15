import { limitsRouter } from "../limits-routes.js";
import type { ServerPlugin } from "./types.js";

export const limitsPlugin: ServerPlugin = {
  id: "limits",
  name: "Limits",
  featureKey: "limits",
  tools: [],
  routes: [{ order: 160, mount: "/delegation/limits", router: limitsRouter }],
};
