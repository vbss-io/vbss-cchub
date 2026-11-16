import { Router } from "express";
import { claudeSourceRouter } from "./claude-statusline-routes.js";
import { delegationGuard } from "./delegation-security.js";
import { getSettings } from "./delegation-store.js";
import { ensureFirstRefresh, limitsSnapshot, refreshLimits } from "./limits.js";
import { limitsForecast, recordLimitsPayload } from "./limits-forecast.js";

export function limitsRouter(): Router {
  const router = Router();
  router.use(delegationGuard);
  router.use("/claude-source", claudeSourceRouter());

  router.get("/", async (_req, res) => {
    try {
      const settings = getSettings();
      await ensureFirstRefresh(settings);
      const snapshot = limitsSnapshot(settings);
      recordLimitsPayload(snapshot);
      res.json(snapshot);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "limits read failed" });
    }
  });

  router.get("/forecast", (_req, res) => {
    const snapshot = limitsSnapshot(getSettings());
    recordLimitsPayload(snapshot);
    res.json(limitsForecast(snapshot));
  });

  router.post("/refresh", async (_req, res) => {
    try {
      res.json(await refreshLimits(getSettings()));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "limits refresh failed" });
    }
  });

  return router;
}
