import type { Express } from "express";
import { corePlugin } from "./core.js";
import { delegatedPlugin } from "./delegated.js";
import { limitsPlugin } from "./limits.js";
import { orderedRoutes } from "./registry.js";
import { reportsPlugin } from "./reports.js";
import { sharePlugin } from "./share.js";
import { tasksPlugin } from "./tasks.js";
import { todayPlugin } from "./today.js";
import { trailPlugin } from "./trail.js";
import type { ServerPlugin } from "./types.js";
import { usagePlugin } from "./usage.js";
import { workspacesPlugin } from "./workspaces.js";

export const SERVER_PLUGINS: readonly ServerPlugin[] = [
  corePlugin,
  todayPlugin,
  tasksPlugin,
  delegatedPlugin,
  usagePlugin,
  limitsPlugin,
  workspacesPlugin,
  reportsPlugin,
  sharePlugin,
  trailPlugin,
];

export function mountPlugins(app: Pick<Express, "use">): void {
  for (const route of orderedRoutes(SERVER_PLUGINS)) app.use(route.mount, route.router(SERVER_PLUGINS));
}
