import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { runTask, type RunEvent } from "./executor.js";
import { broadcast } from "./sse.js";
import { appendHubSource } from "./second-brain.js";
import { appendRunEvent, beginRun, createTask, finishRun, getSettings, getTaskDetail, listTasks } from "./delegation-store.js";
import { allocatePortBase, portRangeOf } from "./task-ports.js";
import type { CodexSandbox, Isolation, IsolationReason, OriginClient, PermissionMode, RunKind, Runner, TaskDetail, TaskRecord } from "./delegation-types.js";
import { createTaskWorktree, worktreeMainRepo, WorktreeError } from "./worktrees.js";
import { finishShareRequestByTask, getShare } from "./share-store.js";
import { endSession, getSession, listClaims, releaseClaimsOfSession } from "./db.js";
import { SHARE_CREATED_BY_PREFIX, implementGuardrail, implementProfile, type RunProfile, type TrustLevel } from "./share-types.js";
import { discoverWorkspaces, findRepo, findWorkspace, isDirectory, samePath } from "./workspaces.js";

const activeRuns = new Map<string, AbortController>();
const FLUSH_MS = 400;

export class BadRequestError extends Error {}
export class NotFoundError extends Error {}

export function titleFrom(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim().length > 0) ?? prompt;
  return firstLine.trim().slice(0, 80);
}

export function shareLabelFromCreatedBy(createdBy: string | null): string | null {
  if (!createdBy || !createdBy.startsWith(SHARE_CREATED_BY_PREFIX)) return null;
  const rest = createdBy.slice(SHARE_CREATED_BY_PREFIX.length);
  const separator = rest.indexOf(":");
  return separator >= 0 ? rest.slice(separator + 1) : rest;
}

export function shareIdFromCreatedBy(createdBy: string | null): string | null {
  if (!createdBy || !createdBy.startsWith(SHARE_CREATED_BY_PREFIX)) return null;
  const rest = createdBy.slice(SHARE_CREATED_BY_PREFIX.length);
  const separator = rest.indexOf(":");
  return separator >= 0 ? rest.slice(0, separator) : rest;
}

export function shareTrustFromCreatedBy(createdBy: string | null): TrustLevel | null {
  if (!createdBy || !createdBy.startsWith(SHARE_CREATED_BY_PREFIX)) return null;
  const rest = createdBy.slice(SHARE_CREATED_BY_PREFIX.length);
  const separator = rest.indexOf(":");
  const shareId = separator >= 0 ? rest.slice(0, separator) : rest;
  return getShare(shareId)?.trust ?? "low";
}

function taskContext(task: TaskRecord): string {
  const worktreeActive = task.isolation === "worktree" && task.worktreePath != null;
  const lines = [
    `You are running inside the "${task.workspace}" workspace, launched by the CC Hub (task ${task.id}).`,
    `Working directory: ${task.cwd}`,
    "Repositories of this workspace (all accessible; never ask which folder a project lives in, use this map):",
    ...task.addDirs.map((dir) => {
      const label = worktreeActive && samePath(dir, task.worktreePath as string) ? (task.repo ?? basename(dir)) : basename(dir);
      return `- ${label}: ${dir}`;
    }),
  ];
  if (task.repo) {
    lines.push(`This task targets the "${task.repo}" repository.`);
    const repoPath = repoPathOf(task);
    const claims = repoPath ? listClaims({ repoPath }) : [];
    if (claims.length > 0) {
      lines.push(
        "",
        `Files claimed by other agents in "${task.repo}" (do not edit them; if your task needs them, report with hub_report kind "blocked" and stop):`,
        ...claims.map((claim) => {
          const who = claim.sessionTitle ?? (claim.sessionId ? claim.sessionId.slice(0, 8) : claim.id.slice(0, 8));
          const note = claim.note ? `, ${claim.note}` : "";
          return `- ${claim.paths.join(", ")} (session ${who}, until ${new Date(claim.expiresAt).toISOString()}${note})`;
        }),
      );
    }
  }
  if (task.portBase != null) {
    const range = portRangeOf(task.portBase);
    lines.push(
      `Ports reserved for this task: ${range.base}-${range.end} (env HUB_PORT_BASE, HUB_PORT_END). Bind every dev server, preview or test listener to a port in this range; other tasks run in parallel with their own ranges, so never use project defaults such as 3000, 4317, 5173 or 14317.`,
    );
  }
  lines.push("When you finish, state clearly what was done, what was verified and what is still open.");
  if (worktreeActive) {
    const original = worktreeMainRepo(task.worktreePath as string) ?? "the main checkout";
    const auto =
      task.isolationReason === "busy-repo"
        ? " The hub isolated this task automatically because another task is already working in the shared checkout."
        : "";
    lines.push(
      "",
      `This task runs in an isolated git worktree of "${task.repo}" at ${task.worktreePath}, branch ${task.branch} (base ${task.baseBranch}). Make every change there and never in ${original}. When you finish, commit your work on that branch inside the worktree (git add -A && git commit); do not push, do not switch branches, do not touch other worktrees.${auto}`,
    );
  }
  const shareLabel = shareLabelFromCreatedBy(task.createdBy);
  if (shareLabel) {
    const trust = shareTrustFromCreatedBy(task.createdBy) ?? "medium";
    lines.push("", implementGuardrail(shareLabel, trust));
    const shareId = shareIdFromCreatedBy(task.createdBy);
    if (shareId) {
      const artifactsRoot = join(task.cwd, "share-artifacts", shareId);
      lines.push(`Files the asker sent are in ${join(artifactsRoot, "inbox")} (read them when relevant).`);
      if (trust !== "low") lines.push(`To hand a file back to the asker, write it in ${artifactsRoot} and mention its file name; they download it from there.`);
    }
  }
  return lines.join("\n");
}

export function brainNote(text: string): void {
  const root = getSettings().secondBrainRoot;
  if (!root || !isDirectory(root)) return;
  try {
    appendHubSource(root, text);
  } catch (err) {
    console.error(`second brain append failed: ${String(err)}`);
  }
}

class RunLog {
  private pending = "";
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly runId: string,
    private readonly taskId: string,
  ) {}

  push(event: RunEvent): void {
    broadcast("run-event", { taskId: this.taskId, runId: this.runId, kind: event.kind, text: event.text });
    if (event.kind === "text") {
      this.pending += event.text;
      if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      return;
    }
    this.flush();
    appendRunEvent({ runId: this.runId, taskId: this.taskId, kind: event.kind, text: event.text });
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length > 0) {
      appendRunEvent({ runId: this.runId, taskId: this.taskId, kind: "text", text: this.pending });
      this.pending = "";
    }
  }
}

const TIMEOUT_WARNING_MS = 5 * 60_000;
const TIMEOUT_WARNING_TEXT = "5 minutes left before the run timeout";

export function resolveIsolation(
  requested: Isolation | null,
  repoBusy: boolean,
  hasRepo: boolean,
): { isolation: Isolation; reason: IsolationReason } {
  if (requested === "worktree") return { isolation: "worktree", reason: "requested" };
  if (requested === "shared") return { isolation: "shared", reason: "requested" };
  if (repoBusy && hasRepo) return { isolation: "worktree", reason: "busy-repo" };
  return { isolation: "shared", reason: "default" };
}

export function resolvePermissionMode(requested: PermissionMode | null, autonomous: boolean): PermissionMode {
  if (requested === "plan") return "plan";
  if (autonomous) return "bypassPermissions";
  return requested ?? "acceptEdits";
}

export function resolveRunTimeoutMs(): number {
  const envRaw = process.env.HUB_DELEGATION_TIMEOUT_MIN;
  if (envRaw !== undefined && envRaw.trim() !== "") {
    const minutes = Number(envRaw);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
  }
  const minutes = getSettings().runTimeoutMinutes;
  return minutes > 0 ? minutes * 60_000 : 0;
}

export function abortActiveRuns(reason: string): void {
  for (const controller of activeRuns.values()) controller.abort(new Error(reason));
}

export function abortRun(taskId: string, reason: string): boolean {
  const controller = activeRuns.get(taskId);
  if (!controller) return false;
  controller.abort(new Error(reason));
  return true;
}

export function startRun(task: TaskRecord, kind: RunKind, prompt: string, model: string | null, permissionMode: PermissionMode | null): void {
  const resumeSessionId = kind === "continue" ? task.sessionId : null;
  const plannedSession = task.runner === "claude" && !resumeSessionId ? randomUUID() : null;
  const trust = shareTrustFromCreatedBy(task.createdBy);
  const fromShare = trust !== null;
  const profile: RunProfile | null = trust ? implementProfile(trust) : null;
  const autonomous = getSettings().autonomy === "full";
  const effectiveMode: PermissionMode = profile ? profile.permissionMode : resolvePermissionMode(permissionMode, autonomous);
  const effectiveSandbox: CodexSandbox | null =
    task.runner === "codex" ? (profile ? profile.codexSandbox : (task.sandbox ?? (autonomous ? "danger-full-access" : "workspace-write"))) : null;
  const run = beginRun({
    taskId: task.id,
    kind,
    runner: task.runner,
    prompt,
    model,
    permissionMode: effectiveMode,
    sessionId: resumeSessionId ?? plannedSession,
  });
  const controller = new AbortController();
  activeRuns.set(task.id, controller);
  const log = new RunLog(run.id, task.id);
  const timeoutMs = resolveRunTimeoutMs();
  const timer =
    timeoutMs > 0
      ? setTimeout(
          () => controller.abort(new Error(`timed out after ${Math.round(timeoutMs / 60_000)} min`)),
          timeoutMs,
        )
      : null;
  const warningTimer =
    timeoutMs > TIMEOUT_WARNING_MS
      ? setTimeout(() => log.push({ kind: "status", text: TIMEOUT_WARNING_TEXT }), timeoutMs - TIMEOUT_WARNING_MS)
      : null;
  broadcast("delegation", { taskId: task.id });
  void runTask({
    runner: task.runner,
    cwd: task.cwd,
    addDirs: task.addDirs,
    taskId: task.id,
    runId: run.id,
    prompt,
    systemContext: taskContext(task),
    model,
    permissionMode: effectiveMode,
    sandbox: effectiveSandbox,
    sessionId: plannedSession,
    resumeSessionId,
    portBase: task.portBase,
    restricted: profile?.restricted,
    strictMcpConfig: profile?.strictMcpConfig,
    permissionPrompts: profile?.permissionPrompts,
    tools: profile?.tools,
    allowedTools: profile?.allowedTools,
    disallowedTools: profile?.disallowedTools,
    maxTurns: profile?.maxTurns,
    guard: profile?.guard ?? undefined,
    signal: controller.signal,
    onEvent: (event) => log.push(event),
  })
    .then((outcome) => {
      log.flush();
      finishRun({
        runId: run.id,
        taskId: task.id,
        status: outcome.status,
        effectiveModel: outcome.effectiveModel,
        sessionId: outcome.sessionId,
        result: outcome.result,
        error: outcome.error,
        exitCode: outcome.exitCode,
      });
      const summary = outcome.status === "completed" ? (outcome.result ?? "").slice(0, 160) : (outcome.error ?? "");
      brainNote(`task ${outcome.status} · ${task.workspace} · ${task.title} (${task.runner}) — ${summary}`);
      endRunSession(outcome.sessionId ?? run.sessionId, `run ${outcome.status}`);
      if (fromShare) {
        const ok = outcome.status === "completed" || outcome.status === "attention";
        finishShareRequestByTask({ taskId: task.id, status: ok ? "completed" : "failed", error: ok ? null : outcome.error, sessionId: outcome.sessionId });
        broadcast("share-request", { taskId: task.id, status: ok ? "completed" : "failed" });
      }
    })
    .catch((err: unknown) => {
      log.flush();
      const message = err instanceof Error ? err.message : "executor crashed";
      try {
        finishRun({
          runId: run.id,
          taskId: task.id,
          status: "failed",
          effectiveModel: null,
          sessionId: null,
          result: null,
          error: message,
          exitCode: null,
        });
      } catch (storeErr) {
        console.error(`run ${run.id} could not be finalized: ${String(storeErr)}`);
      }
      endRunSession(run.sessionId, "run failed");
      if (fromShare) finishShareRequestByTask({ taskId: task.id, status: "failed", error: message, sessionId: null });
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
      if (warningTimer) clearTimeout(warningTimer);
      activeRuns.delete(task.id);
      broadcast("delegation", { taskId: task.id });
    });
}

export interface DelegateInput {
  prompt: string | null;
  workspace: string | null;
  repo: string | null;
  runner: Runner | null;
  model: string | null;
  permissionMode: PermissionMode | null;
  sandbox: CodexSandbox | null;
  title: string | null;
  source: string | null;
  isolation?: Isolation | null;
  originSessionId?: string | null;
  originClient?: OriginClient | null;
}

export interface WorkspaceTarget {
  workspace: string;
  repo: string | null;
  repoPath: string | null;
  cwd: string;
  addDirs: string[];
}

export function resolveWorkspaceTarget(workspaceName: string, repoName: string | null): WorkspaceTarget {
  const root = getSettings().workspacesRoot;
  const workspace = findWorkspace(root, workspaceName);
  if (!workspace) {
    const available = discoverWorkspaces(root).map((item) => item.name);
    throw new NotFoundError(`workspace "${workspaceName}" not found; available: ${available.join(", ") || "none"}`);
  }
  const repo = repoName ? findRepo(workspace, repoName) : null;
  if (repoName && !repo) {
    throw new NotFoundError(
      `repo "${repoName}" is not in workspace "${workspace.name}"; available: ${workspace.repos.map((item) => item.name).join(", ") || "none"}`,
    );
  }
  const cwd = workspace.contextPath ?? repo?.path ?? workspace.repos[0]?.path ?? null;
  if (!cwd || !isDirectory(cwd)) throw new BadRequestError(`workspace "${workspace.name}" has no usable folder to run in`);
  const addDirs = workspace.repos.map((item) => item.path).filter((path) => !samePath(path, cwd) && isDirectory(path));
  return { workspace: workspace.name, repo: repo?.name ?? null, repoPath: repo?.path ?? null, cwd, addDirs };
}

export function prepareWorktree(
  target: WorkspaceTarget,
  id: string,
  reason: IsolationReason,
): { path: string; branch: string; baseBranch: string } | null {
  if (!target.repo || !target.repoPath) {
    throw new BadRequestError("worktree isolation requires a repo of the workspace to run in");
  }
  try {
    return createTaskWorktree({ repoPath: target.repoPath, repoName: target.repo, taskId: id, root: target.cwd });
  } catch (err) {
    if (reason === "busy-repo" && err instanceof WorktreeError) return null;
    throw err;
  }
}

function worktreeAddDirs(target: WorkspaceTarget, created: { path: string }): string[] {
  const mapped = target.addDirs.map((dir) => (samePath(dir, target.repoPath as string) ? created.path : dir));
  return mapped.some((dir) => samePath(dir, created.path)) ? mapped : [...mapped, created.path];
}

export function repoPathOf(task: TaskRecord): string | null {
  if (!task.repo) return null;
  try {
    return resolveWorkspaceTarget(task.workspace, task.repo).repoPath;
  } catch {
    return null;
  }
}

function endRunSession(sessionId: string | null, message: string): void {
  if (!sessionId) return;
  const releasedClaims = releaseClaimsOfSession(sessionId);
  const ended = endSession(sessionId, message);
  if (ended) broadcast("session", ended);
  if (releasedClaims > 0) broadcast("claims", listClaims());
}

function broadcastOrigin(task: TaskRecord): void {
  if (!task.originSessionId) return;
  const origin = getSession(task.originSessionId);
  if (origin) broadcast("session", origin);
}

export function delegateTask(input: DelegateInput): TaskDetail {
  if (!input.prompt || !input.workspace) throw new BadRequestError("prompt and workspace required");
  const target = resolveWorkspaceTarget(input.workspace, input.repo);
  const runner = input.runner ?? "claude";
  const id = randomUUID();
  const allTasks = listTasks({ limit: 500, includeArchived: true });
  const activeTasks = allTasks.filter((existing) => existing.status === "running" || existing.status === "pending");
  const repoBusy =
    target.repoPath != null &&
    activeTasks.some((existing) => {
      if (existing.isolation !== "shared") return false;
      const existingPath = repoPathOf(existing);
      return existingPath != null && samePath(existingPath, target.repoPath as string);
    });
  const { isolation: requestedIsolation, reason: requestedReason } = resolveIsolation(input.isolation ?? null, repoBusy, target.repoPath != null);
  const created = requestedIsolation === "worktree" ? prepareWorktree(target, id, requestedReason) : null;
  const isolation: Isolation = requestedIsolation === "worktree" && !created ? "shared" : requestedIsolation;
  const isolationReason: IsolationReason = requestedIsolation === "worktree" && !created ? "default" : requestedReason;
  const addDirs = created ? worktreeAddDirs(target, created) : target.addDirs;
  const worktreePath = created?.path ?? null;
  const branch = created?.branch ?? null;
  const baseBranch = created?.baseBranch ?? null;
  const usedPortBases = activeTasks.map((existing) => existing.portBase).filter((base): base is number => base != null);
  const portBase = allocatePortBase(usedPortBases);
  const task = createTask({
    id,
    title: input.title?.trim() || titleFrom(input.prompt),
    prompt: input.prompt,
    workspace: target.workspace,
    repo: target.repo,
    cwd: target.cwd,
    addDirs,
    runner,
    model: input.model,
    permissionMode: input.permissionMode,
    sandbox: input.sandbox,
    createdBy: input.source,
    originSessionId: input.originSessionId ?? null,
    originClient: input.originClient ?? null,
    isolation,
    isolationReason,
    worktreePath,
    branch,
    baseBranch,
    portBase,
  });
  startRun(task, "launch", input.prompt, input.model, input.permissionMode);
  broadcastOrigin(task);
  brainNote(
    `task delegated · ${task.workspace}${task.repo ? `/${task.repo}` : ""} · ${task.title} (${task.runner}${task.createdBy ? `, via ${task.createdBy}` : ""}) · id ${task.id}`,
  );
  return getTaskDetail(task.id) as TaskDetail;
}
