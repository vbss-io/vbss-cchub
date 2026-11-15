import { Router } from "express";
import { getSettings } from "./delegation-store.js";
import { pluginViews } from "./plugins/registry.js";
import type { PluginManifest } from "./plugins/types.js";

export function pluginsRouter(plugins: readonly PluginManifest[]): Router {
  const router = Router();

  router.get("/plugins", (_req, res) => {
    res.json(pluginViews(plugins, getSettings().features));
  });

  return router;
}
