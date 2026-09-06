import { Router } from "express";
import { autostartStatus, setAutostart } from "./autostart.js";

export function systemRouter(): Router {
  const router = Router();

  router.get("/system/autostart", (_req, res) => {
    void autostartStatus().then((status) => res.json(status));
  });

  router.put("/system/autostart", (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be true or false" });
      return;
    }
    void setAutostart(body.enabled).then((status) => res.status(status.error ? 409 : 200).json(status));
  });

  return router;
}
