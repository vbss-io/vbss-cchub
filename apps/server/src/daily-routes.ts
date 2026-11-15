import { Router } from "express";
import { localDate } from "./second-brain.js";
import { activeDailyTask, getSettings, getTaskDetail } from "./delegation-store.js";
import { composeDaily, DailyBusyError, DailyConflictError, dailyRoot, dailyDir, dailySessionsForDate, dailyTemplatePath, dailyTemplateText, findYesterday, generateDaily, isValidDailyDate, listDiaryDates, parseTaskLines, readDaily, readFrontmatterKey, setFrontmatterKey, previousDate, setTaskChecked, taskBlock, writeDaily, yesterdayTrail, type ComposeFocusItem, type TaskLine } from "./daily.js";
import { composeBoardFor } from "./tasks-board.js";
import { closeDailyTicks, organizeFocusChecked, saveDailyFromClient } from "./today.js";
import { asString, asStringArray, sendError } from "./route-helpers.js";

export function dailyRouter(): Router {
  const router = Router();

  router.get("/daily", (_req, res) => {
    const settings = getSettings();
    const root = dailyRoot(settings);
    if (!root) {
      res.json({ enabled: false, root: null, dir: null, today: localDate(), dates: [], running: null, templatePath: null });
      return;
    }
    const active = activeDailyTask();
    let running: { taskId: string; date: string; startedAt: number } | null = null;
    if (active && active.dailyDate) {
      const detail = getTaskDetail(active.id);
      const lastRun = detail?.runs[detail.runs.length - 1] ?? null;
      running = { taskId: active.id, date: active.dailyDate, startedAt: lastRun?.startedAt ?? active.createdAt };
    }
    res.json({
      enabled: settings.features.daily,
      root,
      dir: dailyDir(settings),
      today: localDate(),
      dates: listDiaryDates(settings).slice(0, 60),
      running,
      templatePath: dailyTemplatePath(settings),
    });
  });

  router.get("/daily/sessions", (req, res) => {
    const date = typeof req.query.date === "string" ? req.query.date : "";
    if (!isValidDailyDate(date)) {
      res.status(400).json({ error: "date must be a valid YYYY-MM-DD" });
      return;
    }
    res.json(dailySessionsForDate(date));
  });

  router.get("/daily/:date", (req, res) => {
    if (!isValidDailyDate(req.params.date)) {
      res.status(400).json({ error: "date must be a valid YYYY-MM-DD" });
      return;
    }
    try {
      res.json(readDaily(getSettings(), req.params.date));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put("/daily/:date", (req, res) => {
    if (!isValidDailyDate(req.params.date)) {
      res.status(400).json({ error: "date must be a valid YYYY-MM-DD" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    if (typeof body.content !== "string") {
      res.status(400).json({ error: "content required" });
      return;
    }
    const baseUpdatedAt = typeof body.baseUpdatedAt === "number" ? body.baseUpdatedAt : undefined;
    let writeId: string | null = null;
    if (body.writeId !== undefined && body.writeId !== null) {
      if (typeof body.writeId !== "string" || body.writeId.length > 64) {
        res.status(400).json({ error: "writeId must be a string of at most 64 characters" });
        return;
      }
      writeId = body.writeId;
    }
    try {
      res.json(saveDailyFromClient(getSettings(), req.params.date, body.content, baseUpdatedAt, writeId));
    } catch (err) {
      if (err instanceof DailyConflictError) {
        res.status(409).json({ error: err.message, content: err.content, updatedAt: err.updatedAt });
        return;
      }
      sendError(res, err);
    }
  });

  router.post("/daily/:date/organize-focus", (req, res) => {
    if (!isValidDailyDate(req.params.date)) {
      res.status(400).json({ error: "date must be a valid YYYY-MM-DD" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const baseUpdatedAt = typeof body.baseUpdatedAt === "number" ? body.baseUpdatedAt : undefined;
    try {
      const settings = getSettings();
      res.json(organizeFocusChecked(settings, req.params.date, composeBoardFor(settings), baseUpdatedAt));
    } catch (err) {
      if (err instanceof DailyConflictError) {
        res.status(409).json({ error: err.message, content: err.content, updatedAt: err.updatedAt });
        return;
      }
      sendError(res, err);
    }
  });

  router.post("/daily/:date/generate", (req, res) => {
    if (!isValidDailyDate(req.params.date)) {
      res.status(400).json({ error: "date must be a valid YYYY-MM-DD" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const focus = asString(body.focus);
    const context = asString(body.context);
    try {
      res.status(201).json(generateDaily(req.params.date, focus, context));
    } catch (err) {
      if (err instanceof DailyBusyError) {
        res.status(409).json({ error: err.message, taskId: err.taskId });
        return;
      }
      sendError(res, err);
    }
  });

  router.get("/daily/:date/prepare", (req, res) => {
    if (!isValidDailyDate(req.params.date)) {
      res.status(400).json({ error: "date must be a valid YYYY-MM-DD" });
      return;
    }
    try {
      const settings = getSettings();
      const date = req.params.date;
      const yesterdayDate = findYesterday(settings, date);
      let yesterday: { date: string; path: string; closed: boolean; tasks: (TaskLine & { block: string })[] } | null = null;
      if (yesterdayDate) {
        const read = readDaily(settings, yesterdayDate);
        const closed = readFrontmatterKey(read.content, settings.daily.closedKey) !== null;
        const tasks = parseTaskLines(read.content)
          .filter((task) => task.depth === 0)
          .map((task) => ({ ...task, block: taskBlock(read.content, task.line) }));
        yesterday = { date: yesterdayDate, path: read.path, closed, tasks };
      }
      res.json({
        date,
        yesterday,
        yesterdayTrail: yesterdayTrail(settings, yesterdayDate ?? previousDate(date)),
        sessionsToday: dailySessionsForDate(date),
        headings: settings.daily.headings,
        wikilinks: settings.daily.wikilinks,
        templatePath: dailyTemplatePath(settings),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/daily/:date/close-yesterday", (req, res) => {
    if (!isValidDailyDate(req.params.date)) {
      res.status(400).json({ error: "date must be a valid YYYY-MM-DD" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const yesterday = typeof body.yesterday === "string" ? body.yesterday : "";
    if (!isValidDailyDate(yesterday)) {
      res.status(400).json({ error: "yesterday must be a valid YYYY-MM-DD" });
      return;
    }
    if (body.summary !== undefined && typeof body.summary !== "string") {
      res.status(400).json({ error: "summary must be a string" });
      return;
    }
    const tasksBody = Array.isArray(body.tasks) ? body.tasks : [];
    const tasks: { line: number; checked: boolean }[] = [];
    for (const item of tasksBody) {
      if (!item || typeof item !== "object") {
        res.status(400).json({ error: "tasks[] entries must be objects" });
        return;
      }
      const rec = item as Record<string, unknown>;
      if (typeof rec.line !== "number" || typeof rec.checked !== "boolean") {
        res.status(400).json({ error: "tasks[].line and tasks[].checked required" });
        return;
      }
      tasks.push({ line: rec.line, checked: rec.checked });
    }
    const busy = activeDailyTask(yesterday);
    if (busy) {
      res.status(409).json({ error: "a daily generation is already running for this date" });
      return;
    }
    try {
      const settings = getSettings();
      const existing = readDaily(settings, yesterday);
      if (!existing.exists) {
        res.status(400).json({ error: "yesterday diary not found" });
        return;
      }
      let content = existing.content;
      for (const task of tasks) content = setTaskChecked(content, task.line, task.checked);
      content = setFrontmatterKey(content, settings.daily.closedKey, req.params.date);
      const written = closeDailyTicks(settings, yesterday, existing.content, content);
      res.json({ date: yesterday, updatedAt: written.updatedAt, closed: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/daily/:date/compose", (req, res) => {
    if (!isValidDailyDate(req.params.date)) {
      res.status(400).json({ error: "date must be a valid YYYY-MM-DD" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    if (!Array.isArray(body.focus)) {
      res.status(400).json({ error: "focus must be an array" });
      return;
    }
    const focus: ComposeFocusItem[] = [];
    for (const item of body.focus) {
      if (!item || typeof item !== "object") {
        res.status(400).json({ error: "focus[] entries must be objects" });
        return;
      }
      const rec = item as Record<string, unknown>;
      if (typeof rec.text !== "string") {
        res.status(400).json({ error: "focus[].text required" });
        return;
      }
      const project = typeof rec.project === "string" ? rec.project : null;
      const block = typeof rec.block === "string" ? rec.block : undefined;
      focus.push({ project, text: rec.text, block });
    }
    if (!Array.isArray(body.meetings)) {
      res.status(400).json({ error: "meetings must be an array" });
      return;
    }
    const meetings = asStringArray(body.meetings);
    const briefing = typeof body.briefing === "string" ? body.briefing : undefined;
    const overwrite = body.overwrite === true;
    try {
      const settings = getSettings();
      const date = req.params.date;
      const existing = readDaily(settings, date);
      if (existing.exists && !overwrite) {
        res.status(409).json({ error: "diary exists", updatedAt: existing.updatedAt });
        return;
      }
      const content = composeDaily(
        dailyTemplateText(settings),
        { briefing, focus, meetings, sessions: dailySessionsForDate(date) },
        { date, headings: settings.daily.headings, wikilinks: settings.daily.wikilinks, board: composeBoardFor(settings) },
      );
      writeDaily(settings, date, content);
      res.json(readDaily(settings, date));
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
