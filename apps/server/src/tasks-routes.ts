import { Router } from "express";
import { getSession, sessionByPid } from "./db.js";
import { broadcast } from "./sse.js";
import { runtimeSnapshot } from "./runtimes.js";
import { archiveTask, clearTaskWorktreePath, getTask, getTaskDetail, listTaskEvents, listTasks, markTaskMerged, TaskBusyError, unarchiveTask, setTaskOrigin, listTasksByOrigin, resolveTaskId } from "./delegation-store.js";
import { abortRun, delegateTask, startRun, repoPathOf } from "./delegation-launch.js";
import { discardTaskWorktree, mergeTaskWorktree, worktreeStatus } from "./worktrees.js";
import { CODEX_SANDBOXES, ISOLATION_MODES, ORIGIN_CLIENTS, PERMISSION_MODES, RUNNERS, TASK_STATUSES, type CodexSandbox, type Isolation, type OriginClient, type PermissionMode, type RunKind, type Runner, type TaskStatus } from "./delegation-types.js";
import { isDirectory } from "./workspaces.js";
import { asString, oneOf, sendError, taskJson } from "./route-helpers.js";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

async function resolveOrigin(
  originPid: number | null,
  hint: OriginClient | null,
  envSessionId: string | null = null,
): Promise<{ originSessionId: string | null; originClient: OriginClient | null }> {
  if (envSessionId && SESSION_ID_RE.test(envSessionId)) {
    const known = getSession(envSessionId);
    return { originSessionId: envSessionId, originClient: known?.client === "share" ? "share" : "claude-code" };
  }
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

export function tasksRouter(): Router {
  const router = Router();

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
          : await resolveOrigin(originPid, originHint, typeof body.originEnvSessionId === "string" ? body.originEnvSessionId : null);
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

  return router;
}
