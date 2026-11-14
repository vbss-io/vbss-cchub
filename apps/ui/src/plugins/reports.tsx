import { IconReports } from "../icons";
import type { HubPlugin } from "./types";

export const reportsPlugin: HubPlugin = {
  id: "reports",
  name: "Reports",
  description: "What agents reported back to the hub.",
  core: false,
  featureKey: "reports",
  views: [{ key: "reports", label: "Reports", icon: <IconReports />, subtitle: "What agents reported back" }],
};
