import { reportsRouter } from "../reports-routes.js";
import type { ServerPlugin } from "./types.js";

export const reportsPlugin: ServerPlugin = {
  id: "reports",
  name: "Reports",
  featureKey: "reports",
  tools: ["hub_report", "hub_reports"],
  routes: [{ order: 140, mount: "/delegation", router: reportsRouter }],
};
