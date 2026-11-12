import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { TaskRecord } from "../src/delegation-types.js";
import { freePort, makeSandbox, startServer, waitFor, type RunningServer } from "./helpers.js";

process.env.HUB_PREVIEW = "1";

type Worktrees = typeof import("../src/worktrees.js");
let wt: Worktrees;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.com");
  writeFileSync(join(path, "base.txt"), "base\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "base");
}

function makeTask(over: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task0000",
    title: "t",
    prompt: "p",
    workspace: "w",
    repo: "repo",
    cwd: "",
    addDirs: [],
    runner: "claude",
    requestedModel: null,
    permissionMode: null,
    sandbox: null,
    status: "completed",
    sessionId: null,
    createdBy: null,
    originSessionId: null,
    originClient: null,
    lastError: null,
    runsCount: 0,
    archivedAt: null,
    isolation: "worktree",
    isolationReason: null,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    mergedAt: null,
    portBase: null,
    dailyDate: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

before(async () => {
  wt = await import("../src/worktrees.js");
});

describe("preview git guard: classification", () => {
  it("allows exactly the read-only commands", () => {
    const allowed: string[][] = [
      ["worktree", "list", "--porcelain"],
      ["status", "--porcelain"],
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["log", "main..HEAD", "--format=%H"],
      ["diff", "--stat", "main...HEAD"],
      ["diff", "--name-only", "--diff-filter=U"],
      ["show", "HEAD"],
      ["branch", "--list", "hub/abc"],
      ["branch", "--show-current"],
      ["ls-files"],
      ["merge-base", "main", "HEAD"],
      ["for-each-ref", "refs/heads"],
      ["config", "--get", "user.name"],
    ];
    for (const args of allowed) assert.equal(wt.isReadOnlyGit(args), true, args.join(" "));
  });

  it("refuses every command that can mutate a repository", () => {
    const refused: string[][] = [
      [],
      ["worktree", "add", "-b", "hub/abc", "/x", "HEAD"],
      ["worktree", "remove", "--force", "/x"],
      ["worktree", "prune"],
      ["merge", "--no-ff", "--no-edit", "hub/abc"],
      ["merge", "--abort"],
      ["branch", "-D", "hub/abc"],
      ["branch", "hub/abc"],
      ["branch"],
      ["checkout", "main"],
      ["commit", "-m", "x"],
      ["reset", "--hard"],
      ["config", "user.name", "x"],
      ["push"],
      ["fetch"],
    ];
    for (const args of refused) assert.equal(wt.isReadOnlyGit(args), false, args.join(" "));
  });
});

describe("preview git guard: worktree operations", () => {
  const box = mkdtempSync(join(tmpdir(), "cch-wt-preview-"));
  const repo = join(box, "repo");
  const root = join(box, "ws");
  const taskId = "abcdef1234567890";
  const branch = "hub/abcdef12";
  const worktreePath = join(root, ".worktrees", "repo", "abcdef12");
  const task = (): TaskRecord => makeTask({ id: taskId, worktreePath, branch, baseBranch: "main" });

  before(() => {
    initRepo(repo);
    mkdirSync(join(root, ".worktrees", "repo"), { recursive: true });
    git(repo, "worktree", "add", "-b", branch, worktreePath, "HEAD");
    writeFileSync(join(worktreePath, "feature.txt"), "hello\n");
    git(worktreePath, "add", "-A");
    git(worktreePath, "commit", "-m", "add feature");
  });

  after(() => {
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const isPreviewRefusal = (err: unknown): boolean =>
    err instanceof wt.PreviewWriteError && err instanceof wt.WorktreeError && err.status === 403 && err.message === "git writes are disabled in preview mode";

  it("still reads status, commits and the main checkout", async () => {
    const status = await wt.worktreeStatus(task());
    assert.equal(status.exists, true);
    assert.equal(status.commits.length, 1);
    assert.match(status.diffStat, /feature\.txt/);
    assert.equal(wt.worktreeMainRepo(worktreePath)?.toLowerCase(), repo.replace(/\\/g, "/").toLowerCase());
  });

  it("refuses to merge and leaves the base branch and the worktree untouched", async () => {
    const headBefore = git(repo, "rev-parse", "HEAD");
    await assert.rejects(() => wt.mergeTaskWorktree(task()), isPreviewRefusal);
    assert.equal(git(repo, "rev-parse", "HEAD"), headBefore);
    assert.equal(existsSync(join(repo, "feature.txt")), false);
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(existsSync(worktreePath), true);
  });

  it("refuses to discard and keeps the worktree folder, its junction and its branch", async () => {
    await assert.rejects(() => wt.discardTaskWorktree(task(), repo), isPreviewRefusal);
    assert.equal(existsSync(worktreePath), true);
    assert.equal(git(repo, "branch", "--list", branch).includes(branch), true);
    assert.match(git(repo, "worktree", "list", "--porcelain"), /abcdef12/);
  });

  it("refuses to create a worktree and creates no branch", () => {
    assert.throws(() => wt.createTaskWorktree({ repoPath: repo, repoName: "repo", taskId: "ffffffff00000000", root }), isPreviewRefusal);
    assert.equal(git(repo, "branch", "--list", "hub/ffffffff"), "");
    assert.equal(existsSync(join(root, ".worktrees", "repo", "ffffffff")), false);
  });
});

describe("preview mode through the routes", () => {
  const box = makeSandbox("cch-wt-preview-http-");
  const children: ChildProcess[] = [];
  let taskId = "";
  let worktreePath = "";
  let branch = "";

  const call = async (hub: RunningServer, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
  };

  const stop = (hub: RunningServer): Promise<void> =>
    new Promise((resolve) => {
      hub.child.once("exit", () => resolve());
      hub.child.kill();
    });

  before(async () => {
    initRepo(box.repoA);
    const first = await startServer(box, { HUB_DELEGATION: "1", HUB_PREVIEW: "", HUB_SHARE_PORT: String(await freePort()) });
    children.push(first.child);
    await call(first, "PUT", "/delegation/settings", { workspacesRoot: box.root });
    const created = await call(first, "POST", "/delegation/tasks", { prompt: "isolated please", workspace: "pilot", repo: "repo-a", isolation: "worktree", source: "test" });
    assert.equal(created.status, 201);
    const task = (created.json as { task: { id: string; worktreePath: string; branch: string } }).task;
    taskId = task.id;
    worktreePath = task.worktreePath;
    branch = task.branch;
    await waitFor(async () => {
      const detail = (await call(first, "GET", `/delegation/tasks/${taskId}`)).json as { task: { status: string } };
      return ["pending", "running"].includes(detail.task.status) ? null : true;
    }, 15000);
    writeFileSync(join(worktreePath, "from-agent.txt"), "done\n");
    git(worktreePath, "config", "user.name", "Agent");
    git(worktreePath, "config", "user.email", "agent@example.com");
    git(worktreePath, "add", "-A");
    git(worktreePath, "commit", "-m", "agent work");
    await stop(first);
  });

  after(() => {
    for (const child of children) child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("answers merge and discard with 403 and records nothing on the task", async () => {
    const hub = await startServer(box, { HUB_DELEGATION: "1", HUB_PREVIEW: "1", HUB_SHARE_PORT: String(await freePort()) });
    children.push(hub.child);
    const headBefore = git(box.repoA, "rev-parse", "HEAD");

    const merge = await call(hub, "POST", `/delegation/tasks/${taskId}/merge`);
    assert.equal(merge.status, 403);
    assert.equal((merge.json as { error: string }).error, "git writes are disabled in preview mode");

    const discard = await call(hub, "POST", `/delegation/tasks/${taskId}/worktree/discard`);
    assert.equal(discard.status, 403);
    assert.equal((discard.json as { error: string }).error, "git writes are disabled in preview mode");

    const detail = (await call(hub, "GET", `/delegation/tasks/${taskId}`)).json as { task: { worktreePath: string | null; mergedAt: number | null }; worktree: { exists: boolean; commits: unknown[] } | null };
    assert.equal(detail.task.worktreePath, worktreePath);
    assert.equal(detail.task.mergedAt, null);
    assert.equal(detail.worktree?.exists, true);
    assert.equal(detail.worktree?.commits.length, 1);

    assert.equal(git(box.repoA, "rev-parse", "HEAD"), headBefore);
    assert.equal(existsSync(join(box.repoA, "from-agent.txt")), false);
    assert.equal(existsSync(worktreePath), true);
    assert.equal(git(box.repoA, "branch", "--list", branch).includes(branch), true);
  });

  it("refuses to delegate into a new worktree and creates no branch", async () => {
    const hub = await startServer(box, { HUB_DELEGATION: "1", HUB_PREVIEW: "1", HUB_SHARE_PORT: String(await freePort()) });
    children.push(hub.child);
    const branchesBefore = git(box.repoA, "branch", "--list");
    const created = await call(hub, "POST", "/delegation/tasks", { prompt: "another one", workspace: "pilot", repo: "repo-a", isolation: "worktree", source: "test" });
    assert.equal(created.status, 403);
    assert.equal(git(box.repoA, "branch", "--list"), branchesBefore);
  });

  it("refuses to install or uninstall the Claude Code hooks", async () => {
    const hub = await startServer(box, { HUB_DELEGATION: "1", HUB_PREVIEW: "1", HUB_SHARE_PORT: String(await freePort()), USERPROFILE: box.home, HOME: box.home });
    children.push(hub.child);
    for (const action of ["install", "uninstall"]) {
      const res = await call(hub, "POST", `/api/hooks/${action}`);
      assert.equal(res.status, 403);
      assert.equal((res.json as { error: string }).error, "hook changes are disabled in preview mode");
    }
    assert.equal(existsSync(join(box.home, ".claude", "settings.json")), false);
  });
});
