import { execFile, execFileSync } from "node:child_process";
import { existsSync, lstatSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { TaskRecord, WorktreeInfo } from "./delegation-types.js";

const execFileAsync = promisify(execFile);

export class WorktreeError extends Error {
  readonly status: number;
  readonly files?: string[];

  constructor(message: string, status: number, files?: string[]) {
    super(message);
    this.name = "WorktreeError";
    this.status = status;
    this.files = files;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

async function gitAsync(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true });
  return stdout.trim();
}

function task8Of(taskId: string): string {
  return taskId.slice(0, 8);
}

const normalizePath = (path: string): string => resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function worktreeMainRepo(worktreePath: string): string | null {
  try {
    const out = git(worktreePath, ["worktree", "list", "--porcelain"]);
    const entries = out
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
    const wanted = normalizePath(worktreePath);
    if (!entries.some((entry) => normalizePath(entry) === wanted)) return null;
    return entries[0] ?? null;
  } catch {
    return null;
  }
}

function linkNodeModules(repoPath: string, worktreePath: string): void {
  const target = join(repoPath, "node_modules");
  const link = join(worktreePath, "node_modules");
  if (!existsSync(target) || existsSync(link)) return;
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    return;
  }
}

function unlinkNodeModules(worktreePath: string): boolean {
  const link = join(worktreePath, "node_modules");
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    return true;
  }
  if (!stat.isSymbolicLink()) return false;
  try {
    rmdirSync(link);
    return true;
  } catch {
    try {
      unlinkSync(link);
      return true;
    } catch {
      return false;
    }
  }
}

export function createTaskWorktree(input: {
  repoPath: string;
  repoName: string;
  taskId: string;
  root: string;
}): { path: string; branch: string; baseBranch: string } {
  const task8 = task8Of(input.taskId);
  const branch = `hub/${task8}`;
  let baseBranch: string;
  try {
    baseBranch = git(input.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    throw new WorktreeError(`"${input.repoName}" is not a git checkout; a worktree needs a git repository`, 400);
  }
  if (!baseBranch || baseBranch === "HEAD") {
    throw new WorktreeError(`"${input.repoName}" is in detached HEAD; check out a branch before delegating in a worktree`, 400);
  }
  const path = join(input.root, ".worktrees", input.repoName, task8);
  try {
    git(input.repoPath, ["worktree", "add", "-b", branch, path, "HEAD"]);
  } catch (err) {
    throw new WorktreeError(`could not create a worktree for "${input.repoName}": ${err instanceof Error ? err.message : String(err)}`, 400);
  }
  linkNodeModules(input.repoPath, path);
  return { path, branch, baseBranch };
}

export function worktreeHint(task: TaskRecord, info: WorktreeInfo): string {
  const id8 = task.id.slice(0, 8);
  const branch = info.branch ?? "the branch";
  if (info.mergedAt != null) return `Merged into ${info.baseBranch}.`;
  if (task.status === "running" || task.status === "pending") {
    return `Runs in its own worktree on branch ${branch}; when it completes, merge with hub_task_merge (taskId ${id8}) or POST /delegation/tasks/${task.id}/merge.`;
  }
  if (!info.exists) return "Worktree folder is gone; discard to clean the branch.";
  if (info.commits.length > 0) {
    return `${info.commits.length} commit(s) on ${branch} waiting: merge with hub_task_merge (taskId ${id8}), or discard with { discard: true }.`;
  }
  return `No commits on ${branch}: discard with hub_task_merge { taskId ${id8}, discard: true }.`;
}

export async function worktreeStatus(task: TaskRecord): Promise<WorktreeInfo> {
  const path = task.worktreePath;
  const info: WorktreeInfo = {
    path,
    branch: task.branch,
    baseBranch: task.baseBranch,
    exists: false,
    dirty: false,
    commits: [],
    diffStat: "",
    mergedAt: task.mergedAt,
    hint: "",
  };
  if (path && isCheckedOut(path)) {
    info.exists = true;
    try {
      info.dirty = (await gitAsync(path, ["status", "--porcelain"])).length > 0;
      if (task.baseBranch) {
        const log = await gitAsync(path, ["log", `${task.baseBranch}..HEAD`, "--format=%H%x1f%s"]);
        info.commits = log.length === 0 ? [] : log.split(/\r?\n/).map((line) => {
          const [sha, subject] = line.split("\x1f");
          return { sha: sha ?? "", subject: subject ?? "" };
        });
        info.diffStat = await gitAsync(path, ["diff", "--stat", `${task.baseBranch}...HEAD`]);
      }
    } catch {
      info.hint = worktreeHint(task, info);
      return info;
    }
  }
  info.hint = worktreeHint(task, info);
  return info;
}

const mergeLocks = new Set<string>();

async function findWorktreeOnBranch(main: string, branch: string): Promise<string | null> {
  const out = await gitAsync(main, ["worktree", "list", "--porcelain"]);
  for (const block of out.split(/\r?\n\r?\n/)) {
    let path: string | null = null;
    let onBranch = false;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ") && line.slice("branch ".length).trim() === `refs/heads/${branch}`) onBranch = true;
    }
    if (path && onBranch) return path;
  }
  return null;
}

async function runMerge(cwd: string, branch: string): Promise<void> {
  try {
    await gitAsync(cwd, ["merge", "--no-ff", "--no-edit", branch]);
  } catch (err) {
    let files: string[] = [];
    try {
      const conflicts = await gitAsync(cwd, ["diff", "--name-only", "--diff-filter=U"]);
      files = conflicts.length === 0 ? [] : conflicts.split(/\r?\n/);
    } catch {
      files = [];
    }
    try {
      await gitAsync(cwd, ["merge", "--abort"]);
    } catch {
      void err;
    }
    throw new WorktreeError("merge conflict", 409, files);
  }
}

export async function mergeTaskWorktree(task: TaskRecord): Promise<void> {
  if (task.isolation !== "worktree" || !task.worktreePath) throw new WorktreeError("task has no worktree", 404);
  if (!task.branch || !task.baseBranch) throw new WorktreeError("task has no worktree branch", 409);
  if (!existsSync(task.worktreePath)) throw new WorktreeError("the worktree folder is gone; discard it first", 409);
  const main = worktreeMainRepo(task.worktreePath);
  if (!main) throw new WorktreeError("could not resolve the original checkout of the worktree", 409);
  const branch = task.branch;
  const baseBranch = task.baseBranch;
  const lockKey = normalizePath(main);
  if (mergeLocks.has(lockKey)) throw new WorktreeError("a merge of this repository is already in flight", 409);
  mergeLocks.add(lockKey);
  try {
    if ((await gitAsync(task.worktreePath, ["status", "--porcelain"])).length > 0) {
      throw new WorktreeError("the worktree has uncommitted changes; commit or discard them before merging", 409);
    }
    const pending = await gitAsync(task.worktreePath, ["log", `${baseBranch}..${branch}`, "--format=%H"]);
    if (pending.length === 0) throw new WorktreeError("nothing to merge", 409);

    const currentBranch = await gitAsync(main, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (currentBranch === baseBranch) {
      await runMerge(main, branch);
      return;
    }

    const existing = await findWorktreeOnBranch(main, baseBranch);
    if (existing) {
      await runMerge(existing, branch);
      return;
    }

    const tmp = join(dirname(task.worktreePath), `_merge-${task8Of(task.id)}`);
    try {
      await gitAsync(main, ["worktree", "add", tmp, baseBranch]);
    } catch (err) {
      throw new WorktreeError(`could not create a temporary worktree on "${baseBranch}" to merge into: ${err instanceof Error ? err.message : String(err)}`, 409);
    }
    try {
      await runMerge(tmp, branch);
    } finally {
      try {
        await gitAsync(main, ["worktree", "remove", "--force", tmp]);
      } catch {
        try {
          await gitAsync(main, ["worktree", "prune"]);
        } catch {
          void 0;
        }
      }
      if (existsSync(tmp)) removeFolder(tmp);
    }
  } finally {
    mergeLocks.delete(lockKey);
  }
}

const REMOVAL_RETRY_MS = 5_000;
const REMOVAL_ATTEMPTS = 24;

function removeFolder(path: string, attempt = 0): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    if (attempt >= REMOVAL_ATTEMPTS) return;
    setTimeout(() => removeFolder(path, attempt + 1), REMOVAL_RETRY_MS).unref();
  }
}

const isCheckedOut = (path: string): boolean => existsSync(join(path, ".git"));

export async function discardTaskWorktree(task: TaskRecord, mainRepo: string | null = null): Promise<void> {
  if (task.isolation !== "worktree") throw new WorktreeError("task has no worktree", 404);
  const path = task.worktreePath;
  if (!path) return;
  const main = (existsSync(path) ? worktreeMainRepo(path) : null) ?? mainRepo;
  if (!main) return;
  const linkGone = existsSync(path) ? unlinkNodeModules(path) : true;
  try {
    await gitAsync(main, ["worktree", "remove", "--force", path]);
  } catch {
    try {
      await gitAsync(main, ["worktree", "prune"]);
    } catch {
      return;
    }
  }
  if (linkGone && existsSync(path)) removeFolder(path);
  if (task.branch) {
    try {
      await gitAsync(main, ["branch", "-D", task.branch]);
    } catch {
      return;
    }
  }
}
