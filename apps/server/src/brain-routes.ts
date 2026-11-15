import { Router } from "express";
import { brainToday } from "./second-brain.js";
import { getSettings } from "./delegation-store.js";
import { isDirectory } from "./workspaces.js";

export function brainRouter(): Router {
  const router = Router();

  router.get("/brain/today", (_req, res) => {
    const root = getSettings().secondBrainRoot;
    if (!root || !isDirectory(root)) {
      res.status(404).json({ error: "second brain not linked: set secondBrainRoot in settings" });
      return;
    }
    res.json(brainToday(root));
  });

  return router;
}
