import { Router } from "express";
import { getSession } from "./db.js";
import { flushTrail, trailStatus } from "./trail.js";
import { asString } from "./route-helpers.js";

export function trailRouter(): Router {
  const router = Router();

  router.get("/trail", (_req, res) => {
    res.json(trailStatus());
  });

  router.post("/trail/flush", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = asString(body.sessionId);
    if (sessionId) {
      const session = getSession(sessionId);
      if (!session?.transcriptPath) {
        res.status(404).json({ error: "session not found or without a transcript" });
        return;
      }
    }
    res.json({ scheduled: flushTrail(sessionId) });
  });

  return router;
}
