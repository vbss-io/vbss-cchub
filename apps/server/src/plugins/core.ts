import { Router } from "express";
import { backupsRouter } from "../backups-routes.js";
import { connectRouter } from "../connect-routes.js";
import { delegationGuard } from "../delegation-security.js";
import { memoryRouter } from "../memory-routes.js";
import { overviewRouter } from "../overview-routes.js";
import { pluginsRouter } from "../plugins-routes.js";
import { settingsRouter } from "../settings-routes.js";
import { systemRouter } from "../system-routes.js";
import { uiPrefsRouter } from "../ui-prefs-routes.js";
import type { ServerPlugin } from "./types.js";

const guardRouter = (): Router => Router().use(delegationGuard);

export const corePlugin: ServerPlugin = {
  id: "core",
  name: "Core",
  featureKey: null,
  tools: ["hub_overview", "hub_workspaces", "hub_sessions", "hub_session_live", "hub_focus", "hub_claim"],
  routes: [
    { order: 10, mount: "/delegation/ui-prefs", router: uiPrefsRouter },
    { order: 20, mount: "/delegation", router: guardRouter },
    { order: 40, mount: "/delegation", router: systemRouter },
    { order: 50, mount: "/delegation", router: settingsRouter },
    { order: 70, mount: "/delegation", router: connectRouter },
    { order: 80, mount: "/delegation", router: overviewRouter },
    { order: 145, mount: "/delegation", router: pluginsRouter },
    { order: 170, mount: "/delegation/backups", router: backupsRouter },
    { order: 175, mount: "/delegation/memory", router: memoryRouter },
  ],
};
