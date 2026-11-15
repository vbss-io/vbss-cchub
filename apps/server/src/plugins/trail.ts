import { trailRouter } from "../trail-routes.js";
import type { ServerPlugin } from "./types.js";

export const trailPlugin: ServerPlugin = {
  id: "trail",
  name: "Session trail",
  featureKey: "trail",
  tools: [],
  routes: [{ order: 100, mount: "/delegation", router: trailRouter }],
};
