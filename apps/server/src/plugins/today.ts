import { brainRouter } from "../brain-routes.js";
import { dailyRouter } from "../daily-routes.js";
import { todayRouter } from "../today-routes.js";
import type { ServerPlugin } from "./types.js";

export const todayPlugin: ServerPlugin = {
  id: "today",
  name: "Today",
  featureKey: "daily",
  tools: ["hub_brain_today"],
  routes: [
    { order: 90, mount: "/delegation", router: brainRouter },
    { order: 120, mount: "/delegation", router: dailyRouter },
    { order: 180, mount: "/delegation/today", router: todayRouter },
  ],
};
