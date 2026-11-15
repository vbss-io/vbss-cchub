import { shareRouter } from "../share-routes.js";
import type { ServerPlugin } from "./types.js";

export const sharePlugin: ServerPlugin = {
  id: "share",
  name: "Share",
  featureKey: "share",
  tools: ["hub_shares", "hub_share_create", "hub_share_update", "hub_share_activity", "hub_tunnel"],
  routes: [{ order: 30, mount: "/delegation", router: shareRouter }],
};
