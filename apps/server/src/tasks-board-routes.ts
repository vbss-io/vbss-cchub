import { Router } from "express";
import { localDate } from "./second-brain.js";
import { getSettings } from "./delegation-store.js";
import { BadRequestError } from "./delegation-launch.js";
import { DailyConflictError } from "./daily.js";
import { addBoardNote, AlreadyInDailyError, AmbiguousDailyLineError, BOARD_STATUSES, createBoardTask, dailyTaskLinks, deleteBoardNote, delegateBoardTask, editBoardNote, moveBoardItem, moveTaskToProject, readBoard, reparentBoardTask, TaskConflictError, sweepDoneTasks, writeBoardTaskSynced, type BoardStatus } from "./tasks-board.js";
import { addTaskToDailyChecked, syncTaskFromDailyChecked, syncTaskToDailyChecked } from "./today.js";
import { RUNNERS, type Runner } from "./delegation-types.js";
import { openWorkspace } from "./workspaces.js";
import { asString, oneOf, sendError } from "./route-helpers.js";

export function tasksBoardRouter(): Router {
  const router = Router();

  const boardTarget = (body: Record<string, unknown>): { projectId: string; line: number; raw: string } => {
    const projectId = asString(body.projectId);
    if (!projectId) throw new BadRequestError("projectId required");
    if (typeof body.line !== "number" || !Number.isInteger(body.line) || body.line < 0) {
      throw new BadRequestError("line must be a non-negative integer");
    }
    if (typeof body.raw !== "string") throw new BadRequestError("raw required");
    return { projectId, line: body.line, raw: body.raw };
  };

  const sendBoardError = (res: Parameters<typeof sendError>[0], err: unknown): void => {
    if (err instanceof TaskConflictError) {
      res.status(409).json({ error: err.message, current: err.current });
      return;
    }
    if (err instanceof AlreadyInDailyError || err instanceof AmbiguousDailyLineError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof DailyConflictError) {
      res.status(409).json({ error: err.message });
      return;
    }
    sendError(res, err);
  };

  const boardDates = (body: Record<string, unknown>): { start?: string | null; scheduled?: string | null; due?: string | null; repeat?: string | null } => ({
    ...(body.start !== undefined ? { start: body.start as string | null } : {}),
    ...(body.scheduled !== undefined ? { scheduled: body.scheduled as string | null } : {}),
    ...(body.due !== undefined ? { due: body.due as string | null } : {}),
    ...(body.repeat !== undefined ? { repeat: body.repeat as string | null } : {}),
  });

  router.get("/tasks-board", (_req, res) => {
    try {
      res.json(readBoard(getSettings()));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.patch("/tasks-board/item", (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      const target = boardTarget(body);
      const status = oneOf<BoardStatus>(body.status, BOARD_STATUSES, "status");
      if (body.title !== undefined && typeof body.title !== "string") throw new BadRequestError("title must be a string");
      if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") {
        throw new BadRequestError("reason must be a string or null");
      }
      res.json(
        writeBoardTaskSynced(getSettings(), {
          ...target,
          ...(status ? { status } : {}),
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(body.reason !== undefined ? { reason: body.reason as string | null } : {}),
          ...(body.priority !== undefined ? { priority: body.priority as number | null } : {}),
          ...boardDates(body),
        }),
      );
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  router.post("/tasks-board/item", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const projectId = asString(body.projectId);
      if (!projectId) throw new BadRequestError("projectId required");
      if (typeof body.title !== "string") throw new BadRequestError("title required");
      const status = oneOf<BoardStatus>(body.status, BOARD_STATUSES, "status");
      if (body.reason !== undefined && body.reason !== null && typeof body.reason !== "string") {
        throw new BadRequestError("reason must be a string or null");
      }
      const hasParent = body.parentLine !== undefined && body.parentLine !== null;
      if (hasParent && (typeof body.parentLine !== "number" || !Number.isInteger(body.parentLine) || body.parentLine < 0)) {
        throw new BadRequestError("parentLine must be a non-negative integer");
      }
      if (hasParent && typeof body.parentRaw !== "string") throw new BadRequestError("parentRaw required with parentLine");
      const hasAfter = body.after !== undefined && body.after !== null;
      const after = body.after as Record<string, unknown> | undefined;
      if (hasAfter && (typeof after !== "object" || Array.isArray(after))) throw new BadRequestError("after must be an object with line and raw");
      if (hasAfter && (typeof after?.line !== "number" || !Number.isInteger(after.line) || after.line < 0)) {
        throw new BadRequestError("after.line must be a non-negative integer");
      }
      if (hasAfter && typeof after?.raw !== "string") throw new BadRequestError("after.raw required");
      res.status(201).json(
        createBoardTask(getSettings(), {
          projectId,
          title: body.title,
          ...(status ? { status } : {}),
          ...(body.reason !== undefined ? { reason: body.reason as string | null } : {}),
          ...(body.priority !== undefined ? { priority: body.priority as number | null } : {}),
          ...boardDates(body),
          ...(hasParent ? { parentLine: body.parentLine as number, parentRaw: body.parentRaw as string } : {}),
          ...(hasAfter ? { after: { line: after?.line as number, raw: after?.raw as string } } : {}),
        }),
      );
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  const noteText = (body: Record<string, unknown>): string => {
    if (typeof body.text !== "string") throw new BadRequestError("text must be a single non-empty line");
    return body.text;
  };

  router.post("/tasks-board/note", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.status(201).json(addBoardNote(getSettings(), { ...boardTarget(body), text: noteText(body) }));
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  router.patch("/tasks-board/note", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(editBoardNote(getSettings(), { ...boardTarget(body), text: noteText(body) }));
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  router.delete("/tasks-board/note", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(deleteBoardNote(getSettings(), boardTarget(body)));
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  const PARENT_SHAPE_ERROR = "parent must be null or { line, raw }";

  const boardParent = (value: unknown): { line: number; raw: string } | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw new BadRequestError(PARENT_SHAPE_ERROR);
    const ref = value as Record<string, unknown>;
    if (typeof ref.line !== "number" || !Number.isInteger(ref.line) || ref.line < 0 || typeof ref.raw !== "string") {
      throw new BadRequestError(PARENT_SHAPE_ERROR);
    }
    return { line: ref.line, raw: ref.raw };
  };

  router.post("/tasks-board/move", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const target = boardTarget(body);
      if (body.direction !== "up" && body.direction !== "down") throw new BadRequestError("direction must be up or down");
      res.json(moveBoardItem(getSettings(), { ...target, direction: body.direction }));
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  router.post("/tasks-board/reparent", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const target = boardTarget(body);
      if (body.parent === undefined) throw new BadRequestError(PARENT_SHAPE_ERROR);
      res.json(reparentBoardTask(getSettings(), { ...target, parent: boardParent(body.parent) }));
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  router.post("/tasks-board/move-to-project", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const target = boardTarget(body);
      const targetProjectId = asString(body.targetProjectId);
      if (!targetProjectId) throw new BadRequestError("targetProjectId required");
      res.json(moveTaskToProject(getSettings(), { ...target, targetProjectId, parent: boardParent(body.parent) }));
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  router.post("/tasks-board/sweep-done", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(sweepDoneTasks(getSettings(), asString(body.projectId)));
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  router.post("/tasks-board/open", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const settings = getSettings();
    if (!settings.features.tasks) {
      res.status(400).json({ error: "the tasks feature is disabled" });
      return;
    }
    const projectId = asString(body.projectId);
    const project = projectId ? readBoard(settings).projects.find((entry) => entry.id === projectId) : undefined;
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }
    const outcome = openWorkspace(project.path, settings.editorCommand);
    res.status(outcome.ok ? 200 : 500).json(outcome);
  });

  router.get("/tasks-board/daily-links", (req, res) => {
    try {
      const date = typeof req.query.date === "string" && req.query.date !== "" ? req.query.date : localDate();
      res.json(dailyTaskLinks(getSettings(), date));
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  router.post("/tasks-board/add-to-daily", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const target = boardTarget(body);
      res.status(201).json(addTaskToDailyChecked(getSettings(), { ...target, date: asString(body.date) }));
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  router.post("/tasks-board/sync-daily", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const target = boardTarget(body);
      res.json(syncTaskToDailyChecked(getSettings(), { ...target, date: asString(body.date) }));
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  router.post("/tasks-board/sync-from-daily", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      if (typeof body.line !== "number" || !Number.isInteger(body.line) || body.line < 0) {
        throw new BadRequestError("line must be a non-negative integer");
      }
      res.json(syncTaskFromDailyChecked(getSettings(), { line: body.line, date: asString(body.date) }));
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  router.post("/tasks-board/delegate", (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      const target = boardTarget(body);
      res.status(201).json(
        delegateBoardTask(getSettings(), {
          ...target,
          workspace: asString(body.workspace),
          prompt: asString(body.prompt),
          repo: asString(body.repo),
          runner: oneOf<Runner>(body.runner, RUNNERS, "runner"),
        }),
      );
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  return router;
}
