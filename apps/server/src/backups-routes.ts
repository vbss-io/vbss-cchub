import { Router } from "express";
import { backupDatabase, backupsSummary } from "./backups.js";
import { delegationGuard } from "./delegation-security.js";

export function backupsRouter(): Router {
  const router = Router();
  router.use(delegationGuard);

  router.get("/", (_req, res) => {
    try {
      res.json(backupsSummary());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "backups read failed" });
    }
  });

  router.post("/", async (_req, res) => {
    try {
      const backup = await backupDatabase("manual");
      res.status(201).json({ backup });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "backup failed" });
    }
  });

  return router;
}
