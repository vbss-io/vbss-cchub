import { Router, type Response } from "express";
import { DailyConflictError, isValidDailyDate } from "./daily.js";
import { BadRequestError, NotFoundError } from "./delegation-launch.js";
import { delegationGuard } from "./delegation-security.js";
import { getSettings } from "./delegation-store.js";
import { TaskConflictError } from "./tasks-board.js";
import { installTodayHooks, readToday, StaleCaptureError, todayApi } from "./today.js";

type Body = Record<string, unknown>;

function sendTodayError(res: Response, err: unknown): void {
  if (err instanceof TaskConflictError) {
    res.status(409).json({ error: err.message, current: err.current });
    return;
  }
  if (err instanceof DailyConflictError || err instanceof StaleCaptureError) {
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
      const result = todayApi.schedule(getSettings(), { projectId: requireString(body, "projectId"), line: requireLine(body), raw: requireString(body, "raw"), date: target });
      res.json(result);
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
