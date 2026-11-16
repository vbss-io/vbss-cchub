import { Router } from "express";
import { healthReport } from "./health.js";
import { sendError } from "./route-helpers.js";

export function healthRouter(): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    healthReport()
      .then((report) => res.json(report))
      .catch((err: unknown) => sendError(res, err));
  });

  return router;
}
