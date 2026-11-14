import { IconBoard } from "../icons";
import type { HubPlugin } from "./types";

export const tasksPlugin: HubPlugin = {
  id: "tasks",
  name: "Tasks",
  description: "Tasks from your second brain as a board, table or timeline.",
  core: false,
  featureKey: "tasks",
  views: [{ key: "board", label: "Tasks", icon: <IconBoard />, subtitle: "Tasks from your second brain as a board: filter by project, move them, hand one to an agent" }],
  settingsTab: { key: "tasks", label: "Tasks" },
  paletteCommands: ({ dispatch }) => ({ newTask: () => dispatch("board", "cchub:board-new-task") }),
};
