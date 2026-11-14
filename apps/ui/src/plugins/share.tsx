import { IconShare } from "../icons";
import type { HubPlugin } from "./types";

export const sharePlugin: HubPlugin = {
  id: "share",
  name: "Share",
  description: "Links so other people and their assistants can ask your Claude.",
  core: false,
  featureKey: "share",
  views: [{ key: "share", label: "Share", icon: <IconShare />, subtitle: "Links so other people and their assistants can ask your Claude, on the LAN or through ngrok" }],
  settingsTab: { key: "sharing", label: "Sharing" },
};
