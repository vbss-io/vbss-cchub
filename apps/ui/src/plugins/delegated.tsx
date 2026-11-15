import { IconTasks } from "../icons";
import type { HubPlugin } from "./types";

export const delegatedPlugin: HubPlugin = {
  id: "delegated",
  name: "Delegated",
  description: "Work handed to the hub by agents: follow, steer, cancel.",
  core: false,
  featureKey: "delegated",
  views: [{ key: "tasks", label: "Delegated", icon: <IconTasks />, subtitle: "Work handed to the hub by agents: follow, steer, cancel", inSidebar: false }],
  paletteCommands: (context) => ({ openDelegated: context.openDelegated }),
};
