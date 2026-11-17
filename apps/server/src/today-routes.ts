import { Router, type Response } from "express";
import { DailyConflictError, isValidDailyDate } from "./daily.js";
import { BadRequestError, NotFoundError } from "./delegation-launch.js";
import { delegationGuard } from "./delegation-security.js";
import { getSettings } from "./delegation-store.js";
import { TaskConflictError } from "./tasks-board.js";
import { installTodayHooks, readToday, StaleCaptureError, StaleTodayLineError, todayApi, type LinkTickTarget } from "./today.js";

type Body = Record<string, unknown>;

function sendTodayError(res: Response, err: unknown): void {
  if (err instanceof TaskConflictError) {
    res.status(409).json({ error: err.message, current: err.current });
    return;
  }
  if (err instanceof DailyConflictError || err instanceof StaleCaptureError || err instanceof StaleTodayLineError) {
    res.status(409).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "request failed";
  res.status(err instanceof BadRequestError ? 400 : err instanceof NotFoundError ? 404 : 500).json({ error: message });
}

function requireString(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new BadRequestError(`${key} required`);
  return value;
}

function requireLine(body: Body): number {
  const value = body.line;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new BadRequestError("line must be a non-negative integer");
  return value;
}

function linkTarget(value: unknown): LinkTickTarget | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new BadRequestError("target must be an object or null");
  const target = value as Body;
  return { projectId: requireString(target, "projectId"), line: requireLine(target), raw: requireString(target, "raw") };
}

export function todayRouter(): Router {
  installTodayHooks();
  const router = Router();
  router.use(delegationGuard);

  const dateOf = (raw: string | undefined): string => {
    if (raw === undefined || !isValidDailyDate(raw)) throw new BadRequestError("date must be a valid YYYY-MM-DD");
    return raw;
  };

  router.get("/:date", (req, res) => {
    try {
      res.json(readToday(getSettings(), dateOf(req.params.date)));
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  router.post("/:date/schedule", (req, res) => {
    try {
      const date = dateOf(req.params.date);
      const body = (req.body ?? {}) as Body;
      const target = body.date;
      if (target !== null && typeof target !== "string") throw new BadRequestError("date must be a YYYY-MM-DD string or null");
      const result = todayApi.schedule(getSettings(), { projectId: requireString(body, "projectId"), line: requireLine(body), raw: requireString(body, "raw"), date: target, from: date });
      res.json(result);
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  router.get("/:date/subtasks", (req, res) => {
    try {
      const date = dateOf(req.params.date);
      const projectId = req.query.projectId;
      const line = typeof req.query.line === "string" && /^\d+$/.test(req.query.line) ? Number(req.query.line) : null;
      if (typeof projectId !== "string" || projectId === "") throw new BadRequestError("projectId required");
      if (line === null) throw new BadRequestError("line must be a non-negative integer");
      res.json(todayApi.subtaskOptions(getSettings(), date, { projectId, line }));
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  router.post("/:date/subtasks", (req, res) => {
    try {
      const date = dateOf(req.params.date);
      const body = (req.body ?? {}) as Body;
      if (typeof body.planned !== "boolean") throw new BadRequestError("planned must be a boolean");
      res.json(todayApi.planSubtask(getSettings(), date, { projectId: requireString(body, "projectId"), line: requireLine(body), raw: requireString(body, "raw"), planned: body.planned }));
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  router.post("/:date/reorder", (req, res) => {
    try {
      const date = dateOf(req.params.date);
      const body = (req.body ?? {}) as Body;
      const direction = body.direction;
      if (direction !== "up" && direction !== "down") throw new BadRequestError("direction must be up or down");
      res.json(todayApi.reorderFocus(getSettings(), date, { projectId: requireString(body, "projectId"), line: requireLine(body), raw: requireString(body, "raw"), direction }));
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  router.post("/:date/clear", (req, res) => {
    try {
      res.json(todayApi.clearToday(getSettings(), dateOf(req.params.date)));
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  router.post("/:date/clear/undo", (req, res) => {
    try {
      const date = dateOf(req.params.date);
      res.json(todayApi.undoClear(getSettings(), date, requireString((req.body ?? {}) as Body, "token")));
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  router.post("/:date/capture", (req, res) => {
    try {
      const date = dateOf(req.params.date);
      const captures = todayApi.appendCapture(getSettings(), date, requireString((req.body ?? {}) as Body, "text"));
      res.json({ captures });
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  router.post("/:date/promote", (req, res) => {
    try {
      const date = dateOf(req.params.date);
      const body = (req.body ?? {}) as Body;
      if (body.schedule !== undefined && typeof body.schedule !== "boolean") throw new BadRequestError("schedule must be a boolean");
      const result = todayApi.promoteCapture(getSettings(), date, {
        line: requireLine(body),
        raw: requireString(body, "raw"),
        projectId: requireString(body, "projectId"),
        ...(body.schedule === true ? { schedule: true } : {}),
      });
      res.json(result);
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  router.post("/:date/meeting", (req, res) => {
    try {
      const date = dateOf(req.params.date);
      const meetings = todayApi.appendMeeting(getSettings(), date, requireString((req.body ?? {}) as Body, "text"));
      res.json({ meetings });
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  router.post("/:date/create", (req, res) => {
    try {
      const date = dateOf(req.params.date);
      const result = todayApi.createToday(getSettings(), date);
      res.json(result);
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  router.post("/:date/link-tick", (req, res) => {
    try {
      const date = dateOf(req.params.date);
      const body = (req.body ?? {}) as Body;
      const lineIndex = body.lineIndex;
      if (typeof lineIndex !== "number" || !Number.isInteger(lineIndex) || lineIndex < 0) throw new BadRequestError("lineIndex must be a non-negative integer");
      const action = body.action;
      if (action !== "apply" && action !== "dismiss") throw new BadRequestError("action must be apply or dismiss");
      res.json(todayApi.linkTick(getSettings(), date, { lineIndex, raw: requireString(body, "raw"), target: linkTarget(body.target), action }));
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  router.post("/:date/tick", (req, res) => {
    try {
      const date = dateOf(req.params.date);
      const body = (req.body ?? {}) as Body;
      const status = body.status;
      if (status !== "todo" && status !== "doing" && status !== "done") throw new BadRequestError("status must be todo, doing or done");
      res.json(todayApi.tickDay(getSettings(), date, { projectId: requireString(body, "projectId"), line: requireLine(body), raw: requireString(body, "raw"), status }));
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  router.post("/:date/migrate", (req, res) => {
    try {
      const date = dateOf(req.params.date);
      const result = todayApi.migrateFocus(getSettings(), date);
      res.json(result);
    } catch (err) {
      sendTodayError(res, err);
    }
  });

  return router;
}
