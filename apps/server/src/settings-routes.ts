import { Router } from "express";
import { broadcast } from "./sse.js";
import { getSettings, updateSettings, type UpdateSettingsInput } from "./delegation-store.js";
import { watchDaily } from "./daily.js";
import { watchTasksBoard } from "./tasks-board.js";
import { AUTONOMY_LEVELS, FOCUS_SOURCES, LIMITS_REFRESH_MAX, LIMITS_REFRESH_MIN, RUN_TIMEOUT_MAX, RUN_TIMEOUT_MIN, RUNNERS, TASKS_DATE_TOKEN, TASKS_PRIORITY_LEVELS_MAX, TASKS_PRIORITY_LEVELS_MIN, TASKS_PRIORITY_TAG_RE, TASKS_SEPARATOR_RE, TRAIL_DETAILS, USAGE_DAYS_MAX, USAGE_DAYS_MIN, WIDGET_EDGES, WIDGET_PANELS, type Autonomy, type FocusSource, type Runner, type TrailDetail, type WidgetEdge, type WidgetPanel } from "./delegation-types.js";
import { isDirectory } from "./workspaces.js";
import { asString } from "./route-helpers.js";

export function settingsRouter(): Router {
  const router = Router();

  router.get("/settings", (_req, res) => {
    res.json(getSettings());
  });

  router.put("/settings", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const patch: UpdateSettingsInput = {};
    if ("runTimeoutMinutes" in body) {
      const minutes = typeof body.runTimeoutMinutes === "number" ? body.runTimeoutMinutes : Number(body.runTimeoutMinutes);
      if (!Number.isFinite(minutes) || minutes < RUN_TIMEOUT_MIN || minutes > RUN_TIMEOUT_MAX) {
        res.status(400).json({ error: `runTimeoutMinutes must be between ${RUN_TIMEOUT_MIN} and ${RUN_TIMEOUT_MAX}` });
        return;
      }
      patch.runTimeoutMinutes = minutes;
    }
    if ("ownerName" in body) {
      const name = asString(body.ownerName);
      if (!name || name.trim().length > 60) {
        res.status(400).json({ error: "ownerName must be 1-60 characters" });
        return;
      }
      patch.ownerName = name.trim();
    }
    if ("autonomy" in body) {
      const level = asString(body.autonomy);
      if (!level || !(AUTONOMY_LEVELS as readonly string[]).includes(level)) {
        res.status(400).json({ error: "autonomy must be full or safe" });
        return;
      }
      patch.autonomy = level as Autonomy;
    }
    if ("workspacesRoot" in body) {
      const root = asString(body.workspacesRoot);
      if (root && !isDirectory(root)) {
        res.status(400).json({ error: "workspacesRoot must be an existing directory" });
        return;
      }
      patch.workspacesRoot = root;
    }
    if ("editorCommand" in body) {
      const editor = asString(body.editorCommand);
      if (!editor) {
        res.status(400).json({ error: "editorCommand required" });
        return;
      }
      patch.editorCommand = editor.trim();
    }
    if ("secondBrainRoot" in body) {
      const root = asString(body.secondBrainRoot);
      if (root && !isDirectory(root)) {
        res.status(400).json({ error: "secondBrainRoot must be an existing directory" });
        return;
      }
      patch.secondBrainRoot = root;
    }
    const featuresBody = body.features as Record<string, unknown> | undefined;
    if (featuresBody && typeof featuresBody === "object") {
      const featuresPatch: NonNullable<UpdateSettingsInput["features"]> = {};
      for (const key of ["daily", "trail", "usage", "limits", "tasks", "flow", "delegated", "workspaces", "reports", "share", "widget"] as const) {
        if (!(key in featuresBody)) continue;
        const flag = featuresBody[key];
        if (typeof flag !== "boolean") {
          res.status(400).json({ error: `features.${key} must be a boolean` });
          return;
        }
        featuresPatch[key] = flag;
      }
      if (Object.keys(featuresPatch).length > 0) patch.features = featuresPatch;
    }
    const dailyBody = body.daily as Record<string, unknown> | undefined;
    if (dailyBody && typeof dailyBody === "object") {
      const dailyPatch: NonNullable<UpdateSettingsInput["daily"]> = {};
      if ("dir" in dailyBody) dailyPatch.dir = asString(dailyBody.dir);
      if ("template" in dailyBody) dailyPatch.template = asString(dailyBody.template);
      if ("prompt" in dailyBody) dailyPatch.prompt = asString(dailyBody.prompt);
      if ("runner" in dailyBody) {
        const runner = asString(dailyBody.runner);
        if (!runner || !(RUNNERS as readonly string[]).includes(runner)) {
          res.status(400).json({ error: `daily.runner must be one of: ${RUNNERS.join(", ")}` });
          return;
        }
        dailyPatch.runner = runner as Runner;
      }
      if ("closedKey" in dailyBody) {
        const closedKey = asString(dailyBody.closedKey);
        if (!closedKey) {
          res.status(400).json({ error: "daily.closedKey required" });
          return;
        }
        dailyPatch.closedKey = closedKey;
      }
      if ("wikilinks" in dailyBody) {
        if (typeof dailyBody.wikilinks !== "boolean") {
          res.status(400).json({ error: "daily.wikilinks must be a boolean" });
          return;
        }
        dailyPatch.wikilinks = dailyBody.wikilinks;
      }
      if ("focusSource" in dailyBody) {
        if (typeof dailyBody.focusSource !== "string" || !(FOCUS_SOURCES as readonly string[]).includes(dailyBody.focusSource)) {
          res.status(400).json({ error: `daily.focusSource must be one of: ${FOCUS_SOURCES.join(", ")}` });
          return;
        }
        dailyPatch.focusSource = dailyBody.focusSource as FocusSource;
      }
      if ("projectOrder" in dailyBody) {
        const order = dailyBody.projectOrder;
        if (!Array.isArray(order) || !order.every((item) => typeof item === "string" && item.trim() !== "" && !/[\r\n]/.test(item))) {
          res.status(400).json({ error: "daily.projectOrder must be an array of project ids" });
          return;
        }
        dailyPatch.projectOrder = [...new Set(order.map((item: string) => item.trim()))];
      }
      const headingsBody = dailyBody.headings as Record<string, unknown> | undefined;
      if (headingsBody && typeof headingsBody === "object") {
        const headingsPatch: NonNullable<UpdateSettingsInput["daily"]>["headings"] = {};
        if ("focus" in headingsBody) {
          const focus = asString(headingsBody.focus);
          if (!focus) {
            res.status(400).json({ error: "daily.headings.focus required" });
            return;
          }
          headingsPatch.focus = focus;
        }
        if ("meetings" in headingsBody) {
          const meetings = asString(headingsBody.meetings);
          if (!meetings) {
            res.status(400).json({ error: "daily.headings.meetings required" });
            return;
          }
          headingsPatch.meetings = meetings;
        }
        if ("sessions" in headingsBody) {
          const sessions = asString(headingsBody.sessions);
          if (!sessions) {
            res.status(400).json({ error: "daily.headings.sessions required" });
            return;
          }
          headingsPatch.sessions = sessions;
        }
        if ("captures" in headingsBody) {
          if (typeof headingsBody.captures !== "string" || /[\r\n]/.test(headingsBody.captures)) {
            res.status(400).json({ error: "daily.headings.captures must be a single line of text" });
            return;
          }
          headingsPatch.captures = headingsBody.captures.trim();
        }
        dailyPatch.headings = headingsPatch;
      }
      patch.daily = dailyPatch;
    }
    const tasksBody = body.tasks as Record<string, unknown> | undefined;
    if (tasksBody && typeof tasksBody === "object") {
      const tasksPatch: NonNullable<UpdateSettingsInput["tasks"]> = {};
      const stringList = (value: unknown): string[] | null => {
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
        const words = value.map((item: string) => item.trim());
        if (words.some((word) => word === "" || /[\r\n]/.test(word))) return null;
        return [...new Set(words)];
      };
      if ("root" in tasksBody) {
        if (tasksBody.root !== null && typeof tasksBody.root !== "string") {
          res.status(400).json({ error: "tasks.root must be a string or null" });
          return;
        }
        tasksPatch.root = typeof tasksBody.root === "string" && tasksBody.root.trim() ? tasksBody.root.trim() : null;
      }
      if ("section" in tasksBody) {
        if (typeof tasksBody.section !== "string" || /[\r\n]/.test(tasksBody.section)) {
          res.status(400).json({ error: "tasks.section must be a single-line string" });
          return;
        }
        tasksPatch.section = tasksBody.section.trim();
      }
      if ("prefixes" in tasksBody) {
        const prefixesBody = tasksBody.prefixes as Record<string, unknown> | null;
        if (!prefixesBody || typeof prefixesBody !== "object" || Array.isArray(prefixesBody)) {
          res.status(400).json({ error: "tasks.prefixes must be an object" });
          return;
        }
        const prefixesPatch: NonNullable<NonNullable<UpdateSettingsInput["tasks"]>["prefixes"]> = {};
        for (const key of ["blocked", "hold", "archived"] as const) {
          if (!(key in prefixesBody)) continue;
          const words = stringList(prefixesBody[key]);
          if (!words) {
            res.status(400).json({ error: `tasks.prefixes.${key} must be an array of non-empty strings` });
            return;
          }
          if (words.length === 0) {
            res.status(400).json({ error: `tasks.prefixes.${key} needs at least one word` });
            return;
          }
          prefixesPatch[key] = words;
        }
        tasksPatch.prefixes = prefixesPatch;
      }
      if ("separator" in tasksBody) {
        if (typeof tasksBody.separator !== "string" || !TASKS_SEPARATOR_RE.test(tasksBody.separator)) {
          res.status(400).json({ error: 'tasks.separator must be a dash or colon surrounded by spaces, like " - " or ": "' });
          return;
        }
        tasksPatch.separator = tasksBody.separator;
      }
      if ("exclude" in tasksBody) {
        const patterns = stringList(tasksBody.exclude);
        if (!patterns) {
          res.status(400).json({ error: "tasks.exclude must be an array of non-empty strings" });
          return;
        }
        tasksPatch.exclude = patterns;
      }
      for (const key of ["workspaceKey", "parentKey"] as const) {
        if (!(key in tasksBody)) continue;
        const value = tasksBody[key];
        if (typeof value !== "string" || !/^[^\s:]+$/.test(value.trim())) {
          res.status(400).json({ error: `tasks.${key} must be a frontmatter key without spaces or colons` });
          return;
        }
        tasksPatch[key] = value.trim();
      }
      if ("delegatePrompt" in tasksBody) {
        if (tasksBody.delegatePrompt !== null && typeof tasksBody.delegatePrompt !== "string") {
          res.status(400).json({ error: "tasks.delegatePrompt must be a string or null" });
          return;
        }
        tasksPatch.delegatePrompt = typeof tasksBody.delegatePrompt === "string" && tasksBody.delegatePrompt.trim() ? tasksBody.delegatePrompt : null;
      }
      if ("markDoingOnDelegate" in tasksBody) {
        if (typeof tasksBody.markDoingOnDelegate !== "boolean") {
          res.status(400).json({ error: "tasks.markDoingOnDelegate must be a boolean" });
          return;
        }
        tasksPatch.markDoingOnDelegate = tasksBody.markDoingOnDelegate;
      }
      if ("reasonSeparator" in tasksBody) {
        const value = tasksBody.reasonSeparator;
        if (typeof value !== "string" || value.trim() === "" || /[\r\n]/.test(value)) {
          res.status(400).json({ error: "tasks.reasonSeparator must be a single-line string with text in it" });
          return;
        }
        tasksPatch.reasonSeparator = value;
      }
      if ("doneSection" in tasksBody) {
        if (typeof tasksBody.doneSection !== "string" || /[\r\n]/.test(tasksBody.doneSection)) {
          res.status(400).json({ error: "tasks.doneSection must be a single-line string" });
          return;
        }
        tasksPatch.doneSection = tasksBody.doneSection.trim();
      }
      if ("doneStamp" in tasksBody) {
        const value = tasksBody.doneStamp;
        if (typeof value !== "string" || /[\r\n]/.test(value) || !value.includes(TASKS_DATE_TOKEN)) {
          res.status(400).json({ error: `tasks.doneStamp must be a single-line string containing ${TASKS_DATE_TOKEN}` });
          return;
        }
        tasksPatch.doneStamp = value;
      }
      if ("priorityTag" in tasksBody) {
        const value = typeof tasksBody.priorityTag === "string" ? tasksBody.priorityTag.trim() : "";
        if (!TASKS_PRIORITY_TAG_RE.test(value)) {
          res.status(400).json({ error: "tasks.priorityTag must be letters, digits, - or _ only" });
          return;
        }
        tasksPatch.priorityTag = value;
      }
      if ("priorityLevels" in tasksBody) {
        const value = tasksBody.priorityLevels;
        if (typeof value !== "number" || !Number.isInteger(value) || value < TASKS_PRIORITY_LEVELS_MIN || value > TASKS_PRIORITY_LEVELS_MAX) {
          res.status(400).json({ error: `tasks.priorityLevels must be an integer from ${TASKS_PRIORITY_LEVELS_MIN} to ${TASKS_PRIORITY_LEVELS_MAX}` });
          return;
        }
        tasksPatch.priorityLevels = value;
      }
      patch.tasks = tasksPatch;
    }
    const trailBody = body.trail as Record<string, unknown> | undefined;
    if (trailBody && typeof trailBody === "object") {
      const trailPatch: NonNullable<UpdateSettingsInput["trail"]> = {};
      if ("dir" in trailBody) trailPatch.dir = asString(trailBody.dir);
      if ("prompt" in trailBody) trailPatch.prompt = asString(trailBody.prompt);
      if ("detail" in trailBody) {
        const detail = asString(trailBody.detail);
        if (!detail || !(TRAIL_DETAILS as readonly string[]).includes(detail)) {
          res.status(400).json({ error: `trail.detail must be one of: ${TRAIL_DETAILS.join(", ")}` });
          return;
        }
        trailPatch.detail = detail as TrailDetail;
      }
      if ("model" in trailBody) {
        const model = trailBody.model === null ? null : asString(trailBody.model);
        if ((trailBody.model !== null && !model) || (model !== null && model.trim().length > 80)) {
          res.status(400).json({ error: "trail.model must be null or 1-80 characters" });
          return;
        }
        trailPatch.model = model === null ? null : model.trim();
      }
      if ("hubEvents" in trailBody) {
        if (typeof trailBody.hubEvents !== "boolean") {
          res.status(400).json({ error: "trail.hubEvents must be a boolean" });
          return;
        }
        trailPatch.hubEvents = trailBody.hubEvents;
      }
      patch.trail = trailPatch;
    }
    const widgetBody = body.widget as Record<string, unknown> | undefined;
    if (widgetBody && typeof widgetBody === "object") {
      const widgetPatch: NonNullable<UpdateSettingsInput["widget"]> = {};
      if ("edge" in widgetBody) {
        const edge = asString(widgetBody.edge);
        if (!edge || !(WIDGET_EDGES as readonly string[]).includes(edge)) {
          res.status(400).json({ error: `widget.edge must be one of: ${WIDGET_EDGES.join(", ")}` });
          return;
        }
        widgetPatch.edge = edge as WidgetEdge;
      }
      if ("panel" in widgetBody) {
        const panel = asString(widgetBody.panel);
        if (!panel || !(WIDGET_PANELS as readonly string[]).includes(panel)) {
          res.status(400).json({ error: `widget.panel must be one of: ${WIDGET_PANELS.join(", ")}` });
          return;
        }
        widgetPatch.panel = panel as WidgetPanel;
      }
      if ("autostart" in widgetBody) {
        if (typeof widgetBody.autostart !== "boolean") {
          res.status(400).json({ error: "widget.autostart must be a boolean" });
          return;
        }
        widgetPatch.autostart = widgetBody.autostart;
      }
      const ringsBody = widgetBody.rings as Record<string, unknown> | undefined;
      if (ringsBody && typeof ringsBody === "object") {
        const ringsPatch: NonNullable<NonNullable<UpdateSettingsInput["widget"]>["rings"]> = {};
        for (const key of ["claude", "codex"] as const) {
          if (!(key in ringsBody)) continue;
          const flag = ringsBody[key];
          if (typeof flag !== "boolean") {
            res.status(400).json({ error: `widget.rings.${key} must be a boolean` });
            return;
          }
          ringsPatch[key] = flag;
        }
        widgetPatch.rings = ringsPatch;
      }
      patch.widget = widgetPatch;
    }
    const limitsBody = body.limits as Record<string, unknown> | undefined;
    if (limitsBody && typeof limitsBody === "object") {
      const limitsPatch: NonNullable<UpdateSettingsInput["limits"]> = {};
      for (const key of ["claude", "codex", "codexLive"] as const) {
        if (!(key in limitsBody)) continue;
        const flag = limitsBody[key];
        if (typeof flag !== "boolean") {
          res.status(400).json({ error: `limits.${key} must be a boolean` });
          return;
        }
        limitsPatch[key] = flag;
      }
      if ("refreshMinutes" in limitsBody) {
        const minutes = limitsBody.refreshMinutes;
        if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < LIMITS_REFRESH_MIN || minutes > LIMITS_REFRESH_MAX) {
          res.status(400).json({ error: `limits.refreshMinutes must be between ${LIMITS_REFRESH_MIN} and ${LIMITS_REFRESH_MAX}` });
          return;
        }
        limitsPatch.refreshMinutes = minutes;
      }
      patch.limits = limitsPatch;
    }
    const usageBody = body.usage as Record<string, unknown> | undefined;
    if (usageBody && typeof usageBody === "object") {
      const usagePatch: NonNullable<UpdateSettingsInput["usage"]> = {};
      if ("days" in usageBody) {
        const days = usageBody.days;
        if (typeof days !== "number" || !Number.isFinite(days) || days < USAGE_DAYS_MIN || days > USAGE_DAYS_MAX) {
          res.status(400).json({ error: `usage.days must be between ${USAGE_DAYS_MIN} and ${USAGE_DAYS_MAX}` });
          return;
        }
        usagePatch.days = days;
      }
      patch.usage = usagePatch;
    }
    const updated = updateSettings(patch);
    watchDaily(updated);
    watchTasksBoard(updated);
    broadcast("settings", updated);
    res.json(updated);
  });

  return router;
}
