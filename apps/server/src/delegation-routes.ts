import { Router } from "express";
import { resolve } from "node:path";
import { listCodexSessions } from "./codex-store.js";
import { config } from "./config.js";
import { getSession, listClaims, listSessions, sessionByPid } from "./db.js";
import { broadcast } from "./sse.js";
import { brainToday, localDate } from "./second-brain.js";
import { runtimeSnapshot } from "./runtimes.js";
import {
  activeDailyTask,
  archiveTask,
  clearTaskWorktreePath,
  createReport,
  getSettings,
  getTask,
  getTaskDetail,
  listReports,
  listTaskEvents,
  listTasks,
  markTaskMerged,
  TaskBusyError,
  unarchiveTask,
  updateSettings,
  setTaskOrigin,
  listTasksByOrigin,
  resolveTaskId,
  type UpdateSettingsInput,
} from "./delegation-store.js";
import { delegationGuard } from "./delegation-security.js";
import { abortRun, BadRequestError, NotFoundError, brainNote, delegateTask, startRun, repoPathOf } from "./delegation-launch.js";
import {
  composeDaily,
  DailyBusyError,
  DailyConflictError,
  dailyRoot,
  dailyDir,
  dailySessionsForDate,
  dailyTemplatePath,
  dailyTemplateText,
  findYesterday,
  generateDaily,
  isValidDailyDate,
  listDiaryDates,
  organizeDailyFocus,
  parseTaskLines,
  readDaily,
  readFrontmatterKey,
  setFrontmatterKey,
  previousDate,
  setTaskChecked,
  taskBlock,
  watchDaily,
  writeDaily,
  yesterdayTrail,
  type ComposeFocusItem,
  type TaskLine,
} from "./daily.js";
import {
  addBoardNote,
  addTaskToDaily,
  AlreadyInDailyError,
  BOARD_STATUSES,
  createBoardTask,
  dailySyncBaseline,
  composeBoardFor,
  dailyTaskLinks,
  deleteBoardNote,
  delegateBoardTask,
  editBoardNote,
  moveBoardItem,
  moveTaskToProject,
  readBoard,
  reparentBoardTask,
  TaskConflictError,
  sweepDoneTasks,
  syncTaskFromDaily,
  syncTasksFromDaily,
  syncTaskToDaily,
  watchTasksBoard,
  writeBoardTaskSynced,
  type BoardStatus,
} from "./tasks-board.js";
import { flushTrail, trailStatus } from "./trail.js";
import { discardTaskWorktree, mergeTaskWorktree, worktreeStatus, WorktreeError } from "./worktrees.js";
import { portRangeOf } from "./task-ports.js";
import { shareRouter } from "./share-routes.js";
import { systemRouter } from "./system-routes.js";
export { abortActiveRuns } from "./delegation-launch.js";
import {
  AUTONOMY_LEVELS,
  CODEX_SANDBOXES,
  ISOLATION_MODES,
  LIMITS_REFRESH_MAX,
  LIMITS_REFRESH_MIN,
  ORIGIN_CLIENTS,
  PERMISSION_MODES,
  REPORT_KINDS,
  RUN_TIMEOUT_MAX,
  RUN_TIMEOUT_MIN,
  RUNNERS,
  TASK_STATUSES,
  TASKS_DATE_TOKEN,
  TASKS_PRIORITY_LEVELS_MAX,
  TASKS_PRIORITY_LEVELS_MIN,
  TASKS_PRIORITY_TAG_RE,
  TASKS_SEPARATOR_RE,
  TRAIL_DETAILS,
  USAGE_DAYS_MAX,
  USAGE_DAYS_MIN,
  WIDGET_EDGES,
  WIDGET_PANELS,
  type Autonomy,
  type CodexSandbox,
  type Isolation,
  type OriginClient,
  type PermissionMode,
  type ReportKind,
  type RunKind,
  type Runner,
  type TaskRecord,
  type TaskStatus,
  type TrailDetail,
  type WidgetEdge,
  type WidgetPanel,
} from "./delegation-types.js";
import {
  configureMcp,
  configureShell,
  connectStatus,
  MCP_CLIENTS,
  SHELL_KINDS,
  type ConnectAction,
  type McpClient,
  type ShellKind,
} from "./installers.js";
import {
  createWorkspace,
  deleteWorkspace,
  discoverWorkspaces,
  findWorkspace,
  isDirectory,
  openWorkspace,
  updateWorkspace,
  workspaceFor,
} from "./workspaces.js";

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T | null {
  const text = asString(value);
  if (!text) return null;
  if (!(allowed as readonly string[]).includes(text)) {
    throw new BadRequestError(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return text as T;
}

const sendError = (res: { status: (code: number) => { json: (body: unknown) => void } }, err: unknown): void => {
  if (err instanceof WorktreeError) {
    res.status(err.status).json(err.files ? { error: err.message, files: err.files } : { error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : "request failed";
  res.status(err instanceof BadRequestError ? 400 : err instanceof NotFoundError ? 404 : 500).json({ error: message });
};

const clipText = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

const taskJson = (task: TaskRecord): TaskRecord & { portEnd: number | null } => ({
  ...task,
  portEnd: task.portBase != null ? portRangeOf(task.portBase).end : null,
});

async function resolveOrigin(
  originPid: number | null,
  hint: OriginClient | null,
): Promise<{ originSessionId: string | null; originClient: OriginClient | null }> {
  if (originPid && Number.isInteger(originPid) && originPid > 0) {
    const session = sessionByPid(originPid);
    if (session) return { originSessionId: session.sessionId, originClient: "claude-code" };
    const runtimes = await runtimeSnapshot();
    if (runtimes.codexApp.pids.includes(originPid) || runtimes.codexCli.pids.includes(originPid)) {
      return { originSessionId: null, originClient: "codex" };
    }
  }
  return { originSessionId: null, originClient: hint };
}

export function delegationRouter(): Router {
  const router = Router();
  router.use(delegationGuard);
  router.use(shareRouter());
  router.use(systemRouter());

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
      for (const key of ["daily", "trail", "usage", "limits", "tasks"] as const) {
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

  router.get("/workspaces", (_req, res) => {
    res.json(discoverWorkspaces(getSettings().workspacesRoot));
  });

  router.post("/workspaces", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const root = getSettings().workspacesRoot;
    const name = asString(body.name);
    if (!root) {
      res.status(400).json({ error: "set the workspaces root first" });
      return;
    }
    if (!name) {
      res.status(400).json({ error: "name required" });
      return;
    }
    try {
      res.status(201).json(createWorkspace(root, name.trim(), asStringArray(body.repos)));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "could not create workspace" });
    }
  });

  router.put("/workspaces/:name", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const root = getSettings().workspacesRoot;
    if (!root) {
      res.status(400).json({ error: "set the workspaces root first" });
      return;
    }
    try {
      res.json(updateWorkspace(root, req.params.name, asStringArray(body.repos)));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "could not update workspace" });
    }
  });

  router.delete("/workspaces/:name", (req, res) => {
    const root = getSettings().workspacesRoot;
    if (!root) {
      res.status(400).json({ error: "set the workspaces root first" });
      return;
    }
    try {
      res.json(deleteWorkspace(root, req.params.name, req.query.context === "1" || req.query.context === "true"));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "could not delete workspace" });
    }
  });

  router.post("/workspaces/:name/open", (req, res) => {
    const settings = getSettings();
    const workspace = findWorkspace(settings.workspacesRoot, req.params.name);
    if (!workspace) {
      res.status(404).json({ error: "workspace not found" });
      return;
    }
    const outcome = openWorkspace(workspace.file, settings.editorCommand);
    res.status(outcome.ok ? 200 : 500).json(outcome);
  });

  router.get("/connect", (_req, res) => {
    connectStatus()
      .then((status) => res.json(status))
      .catch((err: unknown) => sendError(res, err));
  });

  router.post("/connect/shell", (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      const shell = oneOf<ShellKind>(body.shell, SHELL_KINDS, "shell");
      if (!shell) throw new BadRequestError("shell required");
      const action = oneOf<ConnectAction>(body.action, ["install", "uninstall"], "action") ?? "install";
      configureShell(shell, action, getSettings().workspacesRoot)
        .then((status) => res.json(status))
        .catch((err: unknown) => sendError(res, err));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/connect/mcp", (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      const client = oneOf<McpClient>(body.client, MCP_CLIENTS, "client");
      if (!client) throw new BadRequestError("client required");
      const action = oneOf<ConnectAction>(body.action, ["install", "uninstall"], "action") ?? "install";
      res.json(configureMcp(client, action));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/overview", (_req, res) => {
    runtimeSnapshot()
      .then((runtimes) => {
        const workspaces = discoverWorkspaces(getSettings().workspacesRoot);
        const sessions = listSessions().filter((session) => session.archivedAt == null);
        const live = sessions.filter((session) => session.status !== "ended" && !session.stale);
        const counts = { active: 0, waiting: 0, idle: 0, stale: 0, ended: 0 };
        const byClient: Record<string, number> = {};
        for (const session of sessions) {
          if (session.status === "ended") counts.ended += 1;
          else if (session.stale) counts.stale += 1;
          else counts[session.status] += 1;
          if (session.status !== "ended" && !session.stale) {
            const key = session.client ?? "unknown";
            byClient[key] = (byClient[key] ?? 0) + 1;
          }
        }
        const brief = (session: (typeof sessions)[number]) => ({
          sessionId: session.sessionId,
          title: session.customTitle ?? session.title,
          status: session.status,
          client: session.client,
          workspace: workspaceFor(workspaces, session.cwd)?.name ?? null,
          cwd: session.cwd,
          source: session.source,
          model: session.model,
          lastMessage: session.lastMessage,
          agentsRunning: session.agentsRunning,
          agentsTotal: session.agentsTotal,
          updatedAt: session.updatedAt,
        });
        const tasks = listTasks({ limit: 100 });
        const taskBrief = (task: TaskRecord) => ({
          id: task.id,
          title: task.title,
          prompt: clipText(task.prompt, 200),
          workspace: task.workspace,
          repo: task.repo,
          runner: task.runner,
          status: task.status,
          sessionId: task.sessionId,
          createdBy: task.createdBy,
          originSessionId: task.originSessionId,
          originClient: task.originClient,
          isolation: task.isolation,
          branch: task.branch,
          lastError: task.lastError ? clipText(task.lastError, 300) : null,
          runsCount: task.runsCount,
          reposAttached: task.addDirs.length,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        });
        const crowd = new Map<string, { path: string; agents: number }>();
        const bump = (cwd: string | null): void => {
          if (!cwd) return;
          const key = process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
          const entry = crowd.get(key);
          if (entry) entry.agents += 1;
          else crowd.set(key, { path: cwd, agents: 1 });
        };
        for (const session of live) if (session.helperOf == null) bump(session.cwd);
        for (const task of tasks) {
          if ((task.status === "running" || task.status === "pending") && task.isolation === "shared") bump(task.cwd);
        }
        const crowdedFolders = [...crowd.values()].filter((folder) => folder.agents >= 2);
        res.json({
          runtimes,
          sessions: {
            counts,
            byClient,
            attention: live.filter((s) => s.status === "waiting" || s.status === "idle").slice(0, 20).map(brief),
            active: live.filter((s) => s.status === "active").slice(0, 20).map(brief),
            note: "counts ignore sessions whose Claude process died or that went silent for hours; stale ones are counted separately",
          },
          codexSessions: listCodexSessions()
            .filter((s) => s.status !== "ended")
            .slice(0, 20)
            .map((s) => ({ ...s, workspace: workspaceFor(workspaces, s.cwd)?.name ?? null })),
          tasks: {
            inFlight: tasks.filter((t) => t.status === "running" || t.status === "pending").map(taskBrief),
            attention: tasks.filter((t) => t.status === "attention" || t.status === "failed" || t.status === "interrupted").slice(0, 20).map(taskBrief),
            recent: tasks.slice(0, 10).map(taskBrief),
            note: "task entries are brief; use hub_task for the full prompt, run log and attached repos",
          },
          crowdedFolders,
          delegation: { autonomy: getSettings().autonomy, note: getSettings().autonomy === "full" ? "delegations run without permission prompts; do not pass permissionMode unless you want plan mode" : "delegations run with acceptEdits and can stop in Needs you; ask the owner to switch Autonomy to full in Settings" },
          claims: listClaims().map((claim) => ({
            id: claim.id,
            sessionTitle: claim.sessionTitle,
            repoPath: claim.repoPath,
            paths: claim.paths,
            note: claim.note,
            expiresAt: claim.expiresAt,
          })),
          reports: listReports({ limit: 10 }),
          workspaces: workspaces.map((w) => ({ name: w.name, repos: w.repos.length })),
        });
      })
      .catch((err: unknown) => sendError(res, err));
  });

  router.get("/brain/today", (_req, res) => {
    const root = getSettings().secondBrainRoot;
    if (!root || !isDirectory(root)) {
      res.status(404).json({ error: "second brain not linked: set secondBrainRoot in settings" });
      return;
    }
    res.json(brainToday(root));
  });


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
    if (err instanceof AlreadyInDailyError) {
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
      res.status(201).json(
        createBoardTask(getSettings(), {
          projectId,
          title: body.title,
          ...(status ? { status } : {}),
          ...(body.reason !== undefined ? { reason: body.reason as string | null } : {}),
          ...(body.priority !== undefined ? { priority: body.priority as number | null } : {}),
          ...boardDates(body),
          ...(hasParent ? { parentLine: body.parentLine as number, parentRaw: body.parentRaw as string } : {}),
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
      res.status(201).json(addTaskToDaily(getSettings(), { ...target, date: asString(body.date) }));
    } catch (err) {
      sendBoardError(res, err);
    }
  });

  router.post("/tasks-board/sync-daily", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const target = boardTarget(body);
      res.json(syncTaskToDaily(getSettings(), { ...target, date: asString(body.date) }));
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
      res.json(syncTaskFromDaily(getSettings(), { line: body.line, date: asString(body.date) }));
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
      const settings = getSettings();
      const baseline = dailySyncBaseline(settings, req.params.date);
      const written = writeDaily(settings, req.params.date, body.content, baseUpdatedAt, writeId, "client");
      if (baseline !== null) syncTasksFromDaily(settings, req.params.date, baseline, body.content);
      res.json(written);
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
      res.json(organizeDailyFocus(settings, req.params.date, composeBoardFor(settings), baseUpdatedAt));
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
      const written = writeDaily(settings, yesterday, content);
      syncTasksFromDaily(settings, yesterday, existing.content, content);
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

  router.get("/tasks", (req, res) => {
    try {
      const status = oneOf<TaskStatus>(req.query.status, TASK_STATUSES, "status");
      const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const includeArchived = req.query.archived === "1" || req.query.archived === "true";
      if (typeof req.query.origin === "string" && req.query.origin) {
        res.json(listTasksByOrigin(req.query.origin, Number.isFinite(limit) ? limit : undefined).map(taskJson));
        return;
      }
      res.json(listTasks({ status, limit: Number.isFinite(limit) ? limit : undefined, includeArchived }).map(taskJson));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.param("id", (req, _res, next, value: string) => {
    if (req.baseUrl.endsWith("/delegation") && req.path.startsWith("/tasks/")) {
      const resolved = resolveTaskId(value);
      if (resolved) req.params.id = resolved;
    }
    next();
  });

  router.get("/tasks/:id", (req, res) => {
    void (async () => {
      const detail = getTaskDetail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      try {
        const worktree = detail.task.isolation === "worktree" ? await worktreeStatus(detail.task) : null;
        res.json({ ...detail, task: taskJson(detail.task), worktree });
      } catch (err) {
        sendError(res, err);
      }
    })();
  });

  router.get("/tasks/:id/worktree", (req, res) => {
    void (async () => {
      const task = getTask(req.params.id);
      if (!task || task.isolation !== "worktree") {
        res.status(404).json({ error: "task has no worktree" });
        return;
      }
      try {
        res.json(await worktreeStatus(task));
      } catch (err) {
        sendError(res, err);
      }
    })();
  });

  router.post("/tasks/:id/merge", (req, res) => {
    void (async () => {
      const task = getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      if (task.status === "running" || task.status === "pending") {
        res.status(409).json({ error: "cannot merge a running or pending task" });
        return;
      }
      try {
        await mergeTaskWorktree(task);
        const updated = markTaskMerged(task.id);
        broadcast("delegation", { taskId: task.id });
        res.json(updated ? taskJson(updated) : updated);
      } catch (err) {
        sendError(res, err);
      }
    })();
  });

  router.post("/tasks/:id/worktree/discard", (req, res) => {
    void (async () => {
      const task = getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: "task not found" });
        return;
      }
      if (task.status === "running" || task.status === "pending") {
        res.status(409).json({ error: "cannot discard a running or pending task" });
        return;
      }
      try {
        await discardTaskWorktree(task, repoPathOf(task));
        const updated = clearTaskWorktreePath(task.id);
        broadcast("delegation", { taskId: task.id });
        res.json(updated ? taskJson(updated) : updated);
      } catch (err) {
        sendError(res, err);
      }
    })();
  });

  router.get("/tasks/:id/events", (req, res) => {
    if (!getTask(req.params.id)) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    res.json(listTaskEvents(req.params.id));
  });

  router.post("/tasks", (req, res) => {
    const body = req.body as Record<string, unknown>;
    void (async () => {
      try {
        const originPid = typeof body.originPid === "number" ? body.originPid : null;
        const originHint = oneOf<OriginClient>(body.originClient, ORIGIN_CLIENTS, "originClient");
        const explicitOrigin = typeof body.originSessionId === "string" ? getSession(body.originSessionId) : null;
        const origin = explicitOrigin
          ? { originSessionId: explicitOrigin.sessionId, originClient: (explicitOrigin.client === "share" ? "share" : "claude-code") as OriginClient }
          : await resolveOrigin(originPid, originHint);
        const detail = delegateTask({
          prompt: asString(body.prompt),
          workspace: asString(body.workspace),
          repo: asString(body.repo),
          runner: oneOf<Runner>(body.runner, RUNNERS, "runner"),
          model: asString(body.model),
          permissionMode: oneOf<PermissionMode>(body.permissionMode, PERMISSION_MODES, "permissionMode"),
          sandbox: oneOf<CodexSandbox>(body.sandbox, CODEX_SANDBOXES, "sandbox"),
          title: asString(body.title),
          source: asString(body.source),
          isolation: oneOf<Isolation>(body.isolation, ISOLATION_MODES, "isolation"),
          originSessionId: origin.originSessionId,
          originClient: origin.originClient,
        });
        const note =
          detail.task.isolationReason === "busy-repo"
            ? `${detail.task.repo} already has a task running in the shared checkout, so this task works in its own worktree (branch ${detail.task.branch}); merge with hub_task_merge when it completes.`
            : null;
        res.status(201).json({ ...detail, task: taskJson(detail.task), ...(note ? { note } : {}) });
      } catch (err) {
        sendError(res, err);
      }
    })();
  });

  router.post("/tasks/:id/continue", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const prompt = asString(body.prompt);
    if (!prompt) {
      res.status(400).json({ error: "prompt required" });
      return;
    }
    const task = getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    let permissionMode: PermissionMode | null;
    try {
      permissionMode = oneOf<PermissionMode>(body.permissionMode, PERMISSION_MODES, "permissionMode") ?? task.permissionMode;
    } catch (err) {
      sendError(res, err);
      return;
    }
    if (!isDirectory(task.cwd)) {
      res.status(400).json({ error: `working directory no longer exists: ${task.cwd}` });
      return;
    }
    const model = asString(body.model) ?? task.requestedModel;
    const kind: RunKind = task.sessionId ? "continue" : "launch";
    try {
      startRun(task, kind, prompt, model, permissionMode);
    } catch (err) {
      if (err instanceof TaskBusyError) {
        res.status(409).json({ error: "task already running" });
        return;
      }
      throw err;
    }
    res.status(201).json(getTaskDetail(task.id));
  });

  router.patch("/tasks/:id/origin", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const task = getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    const session = typeof body.originSessionId === "string" ? getSession(body.originSessionId) : null;
    if (!session) {
      res.status(400).json({ error: "originSessionId must be a session known to the hub" });
      return;
    }
    const updated = setTaskOrigin(task.id, session.sessionId, session.client === "share" ? "share" : "claude-code");
    broadcast("delegation", { taskId: task.id });
    const refreshed = getSession(session.sessionId);
    if (refreshed) broadcast("session", refreshed);
    res.json(updated ? taskJson(updated) : updated);
  });

  router.post("/tasks/:id/archive", (req, res) => {
    const task = getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    if (task.status === "running" || task.status === "pending") {
      res.status(409).json({ error: "cannot archive a running or pending task" });
      return;
    }
    const updated = archiveTask(task.id);
    broadcast("delegation", { taskId: task.id });
    res.json(updated ? taskJson(updated) : updated);
  });

  router.post("/tasks/:id/unarchive", (req, res) => {
    const task = getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    const updated = unarchiveTask(task.id);
    broadcast("delegation", { taskId: task.id });
    res.json(updated ? taskJson(updated) : updated);
  });

  router.post("/tasks/:id/cancel", (req, res) => {
    if (!abortRun(req.params.id, "cancelled by client")) {
      res.status(409).json({ error: "task is not running" });
      return;
    }
    res.status(202).json({ ok: true });
  });

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
