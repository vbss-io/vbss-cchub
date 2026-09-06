import { Router } from "express";
import { listCodexSessions } from "./codex-sessions.js";
import { config } from "./config.js";
import { listSessions } from "./db.js";
import { broadcast } from "./sse.js";
import { brainToday } from "./second-brain.js";
import { runtimeSnapshot } from "./runtimes.js";
import {
  createReport,
  getSettings,
  getTask,
  getTaskDetail,
  listReports,
  listTaskEvents,
  listTasks,
  TaskBusyError,
  updateSettings,
} from "./delegation-store.js";
import { delegationGuard } from "./delegation-security.js";
import { abortRun, BadRequestError, NotFoundError, brainNote, delegateTask, startRun } from "./delegation-launch.js";
import { shareRouter } from "./share-routes.js";
import { systemRouter } from "./system-routes.js";
export { abortActiveRuns } from "./delegation-launch.js";
import {
  AUTONOMY_LEVELS,
  CODEX_SANDBOXES,
  PERMISSION_MODES,
  REPORT_KINDS,
  RUNNERS,
  TASK_STATUSES,
  type Autonomy,
  type CodexSandbox,
  type PermissionMode,
  type ReportKind,
  type RunKind,
  type Runner,
  type TaskRecord,
  type TaskStatus,
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
  const message = err instanceof Error ? err.message : "request failed";
  res.status(err instanceof BadRequestError ? 400 : err instanceof NotFoundError ? 404 : 500).json({ error: message });
};

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
    const patch: { workspacesRoot?: string | null; editorCommand?: string; secondBrainRoot?: string | null; autonomy?: Autonomy; ownerName?: string } = {};
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
    res.json(updateSettings(patch));
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
            inFlight: tasks.filter((t) => t.status === "running" || t.status === "pending"),
            attention: tasks.filter((t) => t.status === "attention" || t.status === "failed" || t.status === "interrupted").slice(0, 20),
            recent: tasks.slice(0, 10),
          },
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

  router.get("/tasks", (req, res) => {
    try {
      const status = oneOf<TaskStatus>(req.query.status, TASK_STATUSES, "status");
      const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      res.json(listTasks({ status, limit: Number.isFinite(limit) ? limit : undefined }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/tasks/:id", (req, res) => {
    const detail = getTaskDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    res.json(detail);
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
    try {
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
      });
      res.status(201).json(detail);
    } catch (err) {
      sendError(res, err);
    }
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
