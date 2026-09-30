import { Router } from "express";
import { delegationGuard } from "./delegation-security.js";
import { getSettings } from "./delegation-store.js";
import { ensureFirstRefresh, limitsSnapshot, refreshLimits } from "./limits.js";

export function limitsRouter(): Router {
  const router = Router();
  router.use(delegationGuard);

  router.get("/", async (_req, res) => {
    try {
      const settings = getSettings();
      await ensureFirstRefresh(settings);
      res.json(limitsSnapshot(settings));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "limits read failed" });
    }
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
