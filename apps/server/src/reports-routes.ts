import { Router } from "express";
import { broadcast } from "./sse.js";
import { createReport, getTask, listReports } from "./delegation-store.js";
import { brainNote } from "./delegation-launch.js";
import { REPORT_KINDS, type ReportKind } from "./delegation-types.js";
import { asString, oneOf, sendError } from "./route-helpers.js";

export function reportsRouter(): Router {
  const router = Router();

  router.get("/reports", (req, res) => {
    const taskId = typeof req.query.taskId === "string" ? req.query.taskId : null;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    res.json(listReports({ taskId, limit: Number.isFinite(limit) ? limit : undefined }));
  });

  router.post("/reports", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const text = asString(body.text);
    if (!text) {
      res.status(400).json({ error: "text required" });
      return;
    }
    try {
      const kind = oneOf<ReportKind>(body.kind, REPORT_KINDS, "kind") ?? "note";
      const taskId = asString(body.taskId);
      if (taskId && !getTask(taskId)) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      const report = createReport({
        taskId,
        sessionId: asString(body.sessionId),
        workspace: asString(body.workspace),
        kind,
        text: text.trim(),
        source: asString(body.source),
      });
      broadcast("report", report);
      brainNote(`report ${report.kind}${report.workspace ? ` · ${report.workspace}` : ""}${report.source ? ` · ${report.source}` : ""} — ${report.text.slice(0, 200)}`);
      res.status(201).json(report);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
