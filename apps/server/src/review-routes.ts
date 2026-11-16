import { Router, type Response } from "express";
import { openElsewhere } from "./codex-live.js";
import { rolloutChangedSinceHubRun } from "./codex-rollout-mark.js";
import { listCodexSessions } from "./codex-store.js";
import { getSession } from "./db.js";
import { createInternalTask, isTaskActive, repoPathOf, startRun } from "./delegation-launch.js";
import { getTask, getTaskDetail, resolveTaskId, TaskBusyError, taskCost, taskCosts } from "./delegation-store.js";
import type { TaskRecord } from "./delegation-types.js";
import { ghStatus } from "./gh.js";
import { composeReview, computeDiff, parseReviewComments, taskGitDir, unsafeDirReason, type DiffTarget, type ReviewComment } from "./review-diff.js";
import { asString, sendError, taskJson } from "./route-helpers.js";
import { isDirectory } from "./workspaces.js";

const MAX_COST_IDS = 500;

function taskOf(id: string): TaskRecord | null {
  return getTask(resolveTaskId(id) ?? id);
}

function sessionCwd(id: string): string | null {
  const session = getSession(id);
  if (session) return session.cwd;
  return listCodexSessions().find((thread) => thread.id === id)?.cwd ?? null;
}

function sessionKnown(id: string): boolean {
  return getSession(id) !== null || listCodexSessions().some((thread) => thread.id === id);
}

export function taskDiffTarget(task: TaskRecord, runId: string | null): DiffTarget {
  const dir = taskGitDir(task, repoPathOf(task));
  if (task.isolation === "worktree" && task.worktreePath && dir === task.worktreePath) {
    return { dir, baseRef: null, baseKind: "worktree", baseBranch: task.baseBranch };
  }
  const runs = getTaskDetail(task.id)?.runs ?? [];
  const chosen = runId ? runs.find((run) => run.id === runId) : runs.find((run) => run.startCommit !== null);
  return { dir, baseRef: chosen?.startCommit ?? null, baseKind: "start-commit", baseBranch: null };
}

const fileParam = (value: unknown): string | null => (typeof value === "string" && value.length > 0 && value.length < 1024 ? value : null);

type ReviewSend =
  | { mode: "continue"; taskId: string; text: string }
  | { mode: "new-task"; taskId: string; text: string };

function canContinue(task: TaskRecord): boolean {
  if (!task.sessionId || !isDirectory(task.cwd)) return false;
  if (task.runner === "codex" && (openElsewhere(task.sessionId) || rolloutChangedSinceHubRun(task.sessionId))) return false;
  return true;
}

function sendReview(task: TaskRecord, text: string): ReviewSend {
  if (canContinue(task)) {
    startRun(task, "continue", text, task.requestedModel, task.permissionMode);
    return { mode: "continue", taskId: task.id, text };
  }
  const cwd = task.worktreePath && isDirectory(task.worktreePath) ? task.worktreePath : task.cwd;
  if (!isDirectory(cwd)) throw new Error(`working directory no longer exists: ${cwd}`);
  const follow = createInternalTask({
    title: `Review: ${task.title}`.slice(0, 80),
    prompt: text,
    workspace: task.workspace,
    cwd,
    addDirs: task.addDirs.filter((dir) => dir !== cwd),
    runner: task.runner,
    createdBy: `review:${task.id}`,
  });
  startRun(follow, "launch", text, task.requestedModel, task.permissionMode);
  return { mode: "new-task", taskId: follow.id, text };
}

function commentsOr400(raw: unknown, res: Response): ReviewComment[] | null {
  const parsed = parseReviewComments(raw);
  if (typeof parsed === "string") {
    res.status(400).json({ error: parsed });
    return null;
  }
  return parsed;
}

export function reviewRouter(): Router {
  const router = Router();

  router.get("/costs", (req, res) => {
    const raw = typeof req.query.taskIds === "string" ? req.query.taskIds : "";
    const ids = raw.split(",").map((id) => id.trim()).filter((id) => id.length > 0).slice(0, MAX_COST_IDS);
    res.json({ tasks: taskCosts(ids) });
  });

  router.get("/tasks/:id/cost", (req, res) => {
    const task = taskOf(req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    res.json(taskCost(task.id));
  });

  router.get("/tasks/:id/diff", (req, res) => {
    const task = taskOf(req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    computeDiff(taskDiffTarget(task, asString(req.query.runId)), { file: fileParam(req.query.file) })
      .then((diff) => res.json(diff))
      .catch((err: unknown) => sendError(res, err));
  });

  router.post("/tasks/:id/review", (req, res) => {
    const task = taskOf(req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const comments = commentsOr400(body.comments, res);
    if (!comments) return;
    if (task.status === "running" || task.status === "pending" || isTaskActive(task.id)) {
      res.status(409).json({ error: "the task is still running; send the review when it finishes", code: "busy" });
      return;
    }
    void (async () => {
      try {
        const diff = await computeDiff(taskDiffTarget(task, asString(body.runId)), { maxLines: Number.MAX_SAFE_INTEGER });
        const text = composeReview(comments, diff.available ? diff.files : []);
        if (body.dryRun === true) {
          res.json({ mode: "preview", taskId: task.id, text });
          return;
        }
        const sent = sendReview(task, text);
        const detail = getTaskDetail(sent.taskId);
        res.status(201).json({ ...sent, task: detail ? taskJson(detail.task) : null });
      } catch (err) {
        if (err instanceof TaskBusyError) {
          res.status(409).json({ error: "task already running", code: "busy" });
          return;
        }
        sendError(res, err);
      }
    })();
  });

  router.get("/tasks/:id/gh", (req, res) => {
    const task = taskOf(req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    ghStatus(taskGitDir(task, repoPathOf(task)), task.isolation === "worktree" ? task.branch : null)
      .then((status) => res.json(status))
      .catch((err: unknown) => sendError(res, err));
  });

  router.get("/sessions/:id/diff", (req, res) => {
    if (!sessionKnown(req.params.id)) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    const cwd = sessionCwd(req.params.id);
    if (!cwd) {
      res.json({ available: false, reason: "the session has no working directory" });
      return;
    }
    const unsafe = unsafeDirReason(cwd);
    if (unsafe) {
      res.json({ available: false, reason: unsafe });
      return;
    }
    computeDiff({ dir: cwd, baseRef: null, baseKind: "head", baseBranch: null }, { file: fileParam(req.query.file) })
      .then((diff) => res.json(diff))
      .catch((err: unknown) => sendError(res, err));
  });

  router.post("/sessions/:id/review", (req, res) => {
    if (!sessionKnown(req.params.id)) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    const comments = commentsOr400((req.body as Record<string, unknown>).comments, res);
    if (!comments) return;
    const cwd = sessionCwd(req.params.id);
    const diffPromise = cwd && !unsafeDirReason(cwd) ? computeDiff({ dir: cwd, baseRef: null, baseKind: "head", baseBranch: null }, { maxLines: Number.MAX_SAFE_INTEGER }) : Promise.resolve(null);
    diffPromise
      .then((diff) => res.json({ mode: "copy", sessionId: req.params.id, text: composeReview(comments, diff?.available ? diff.files : []) }))
      .catch((err: unknown) => sendError(res, err));
  });

  router.get("/sessions/:id/gh", (req, res) => {
    if (!sessionKnown(req.params.id)) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    const cwd = sessionCwd(req.params.id);
    const unsafe = cwd ? unsafeDirReason(cwd) : null;
    if (unsafe) {
      res.json({ available: false, reason: unsafe });
      return;
    }
    ghStatus(cwd)
      .then((status) => res.json(status))
      .catch((err: unknown) => sendError(res, err));
  });

  return router;
}
