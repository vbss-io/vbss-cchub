import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { TaskRecord } from "../src/delegation-types.js";
import type { WorktreeInfo } from "../src/delegation-types.js";
import { createTaskWorktree, discardTaskWorktree, mergeTaskWorktree, worktreeHint, worktreeMainRepo, worktreeStatus, WorktreeError } from "../src/worktrees.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "main");
  writeFileSync(join(path, ".gitignore"), "node_modules\n");
  mkdirSync(join(path, "node_modules"), { recursive: true });
  writeFileSync(join(path, "node_modules", "marker.txt"), "keep me");
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
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function makeInfo(over: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    path: "/tmp/wt",
    branch: "hub/abc12345",
    baseBranch: "main",
    exists: true,
    dirty: false,
    commits: [],
    diffStat: "",
    mergedAt: null,
    hint: "",
    ...over,
  };
}

const box = mkdtempSync(join(tmpdir(), "cch-wt-"));
const repo = join(box, "repo");
const root = join(box, "ws");
const taskId = randomUUID();
const task8 = taskId.slice(0, 8);
let worktreePath = "";

before(() => {
  initRepo(repo);
  mkdirSync(root, { recursive: true });
});

after(() => {
  try {
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* the temp dir is disposable */
  }
});

describe("worktrees", () => {
  it("creates a worktree on a fresh branch off the base branch", () => {
    const created = createTaskWorktree({ repoPath: repo, repoName: "repo", taskId, root });
    assert.equal(created.branch, `hub/${task8}`);
    assert.equal(created.baseBranch, "main");
    assert.equal(created.path, join(root, ".worktrees", "repo", task8));
    assert.ok(existsSync(created.path));
    worktreePath = created.path;
  });

  it("reports the status with the worktree's commits and diff stat", async () => {
    writeFileSync(join(worktreePath, "feature.txt"), "hello\n");
    git(worktreePath, "add", "-A");
    git(worktreePath, "commit", "-m", "add feature");
    const status = await worktreeStatus(makeTask({ id: taskId, worktreePath, branch: `hub/${task8}`, baseBranch: "main" }));
    assert.equal(status.exists, true);
    assert.equal(status.dirty, false);
    assert.equal(status.commits.length, 1);
    assert.equal(status.commits[0]?.subject, "add feature");
    assert.match(status.diffStat, /feature\.txt/);
  });

  it("merges the branch into the base checkout and leaves it clean", async () => {
    await mergeTaskWorktree(makeTask({ id: taskId, worktreePath, branch: `hub/${task8}`, baseBranch: "main" }));
    assert.ok(existsSync(join(repo, "feature.txt")));
    assert.equal(git(repo, "status", "--porcelain"), "");
  });

  it("refuses to merge when there is nothing to merge", async () => {
    await assert.rejects(
      () => mergeTaskWorktree(makeTask({ id: taskId, worktreePath, branch: `hub/${task8}`, baseBranch: "main" })),
      (err: unknown) => err instanceof WorktreeError && err.status === 409 && err.message === "nothing to merge",
    );
  });

  it("discards the worktree folder and its branch", async () => {
    assert.equal(existsSync(join(worktreePath, "node_modules", "marker.txt")), true);
    await discardTaskWorktree(makeTask({ id: taskId, worktreePath, branch: `hub/${task8}`, baseBranch: "main" }));
    assert.equal(existsSync(worktreePath), false);
    assert.equal(existsSync(join(repo, "node_modules", "marker.txt")), true);
    assert.equal(git(repo, "branch", "--list", `hub/${task8}`), "");
  });

  it("does not mistake a plain folder inside a repo for one of its worktrees", () => {
    const plain = join(repo, "just-a-folder");
    mkdirSync(plain, { recursive: true });
    assert.equal(worktreeMainRepo(plain), null);
    assert.equal(worktreeMainRepo(repo), repo.replace(/\\/g, "/"));
  });

  it("discards a worktree whose folder was already emptied, given the main repo", async () => {
    const id = "0badf00d-0000-4000-8000-000000000000";
    const created = createTaskWorktree({ repoPath: repo, repoName: "repo", taskId: id, root });
    rmSync(join(created.path, "node_modules"), { recursive: true, force: true });
    rmSync(join(created.path, ".git"), { force: true });
    await discardTaskWorktree(makeTask({ id, worktreePath: created.path, branch: created.branch, baseBranch: "main" }), repo);
    assert.equal(existsSync(created.path), false);
    assert.equal(git(repo, "branch", "--list", created.branch), "");
    assert.equal(existsSync(join(repo, "node_modules", "marker.txt")), true);
  });

  it("aborts on a conflicting merge and leaves the base checkout clean", async () => {
    const conflictBox = mkdtempSync(join(tmpdir(), "cch-wtc-"));
    const conflictRepo = join(conflictBox, "repo");
    const conflictRoot = join(conflictBox, "ws");
    try {
      initRepo(conflictRepo);
      mkdirSync(conflictRoot, { recursive: true });
      writeFileSync(join(conflictRepo, "shared.txt"), "one\n");
      git(conflictRepo, "add", "-A");
      git(conflictRepo, "commit", "-m", "shared");
      const id = randomUUID();
      const created = createTaskWorktree({ repoPath: conflictRepo, repoName: "repo", taskId: id, root: conflictRoot });
      writeFileSync(join(created.path, "shared.txt"), "worktree edit\n");
      git(created.path, "add", "-A");
      git(created.path, "commit", "-m", "worktree edit");
      writeFileSync(join(conflictRepo, "shared.txt"), "base edit\n");
      git(conflictRepo, "add", "-A");
      git(conflictRepo, "commit", "-m", "base edit");
      await assert.rejects(
        () => mergeTaskWorktree(makeTask({ id, worktreePath: created.path, branch: created.branch, baseBranch: created.baseBranch })),
        (err: unknown) => {
          assert.ok(err instanceof WorktreeError);
          assert.equal(err.status, 409);
          assert.equal(err.message, "merge conflict");
          assert.ok((err.files ?? []).includes("shared.txt"));
          return true;
        },
      );
      assert.equal(git(conflictRepo, "status", "--porcelain"), "");
      assert.equal(existsSync(join(conflictRepo, ".git", "MERGE_HEAD")), false);
    } finally {
      try {
        rmSync(conflictBox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* disposable */
      }
    }
  });

  it("rejects a non-git repo with a 400 WorktreeError", () => {
    const plain = join(box, "plain");
    mkdirSync(plain, { recursive: true });
    assert.throws(
      () => createTaskWorktree({ repoPath: plain, repoName: "plain", taskId: randomUUID(), root }),
      (err: unknown) => err instanceof WorktreeError && err.status === 400,
    );
  });

  it("merges into the base branch when the checkout sits on another branch, without touching it", async () => {
    const offBox = mkdtempSync(join(tmpdir(), "cch-wtoff-"));
    const offRepo = join(offBox, "repo");
    const offRoot = join(offBox, "ws");
    try {
      initRepo(offRepo);
      mkdirSync(offRoot, { recursive: true });
      const id = randomUUID();
      const created = createTaskWorktree({ repoPath: offRepo, repoName: "repo", taskId: id, root: offRoot });
      writeFileSync(join(created.path, "feature.txt"), "hello\n");
      git(created.path, "add", "-A");
      git(created.path, "commit", "-m", "add feature");
      git(offRepo, "checkout", "-b", "other");
      const worktreesBefore = git(offRepo, "worktree", "list");
      await mergeTaskWorktree(makeTask({ id, worktreePath: created.path, branch: created.branch, baseBranch: created.baseBranch }));
      assert.equal(git(offRepo, "rev-parse", "--abbrev-ref", "HEAD"), "other");
      assert.equal(git(offRepo, "status", "--porcelain"), "");
      assert.match(git(offRepo, "log", "main", "-1", "--format=%s"), /Merge branch/);
      assert.equal(existsSync(join(offRoot, ".worktrees", "repo", `_merge-${id.slice(0, 8)}`)), false);
      assert.equal(git(offRepo, "worktree", "list"), worktreesBefore);
    } finally {
      try {
        rmSync(offBox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* disposable */
      }
    }
  });

  it("aborts a conflicting off-branch merge with a 409 and leaves no temp worktree", async () => {
    const cBox = mkdtempSync(join(tmpdir(), "cch-wtoffc-"));
    const cRepo = join(cBox, "repo");
    const cRoot = join(cBox, "ws");
    try {
      initRepo(cRepo);
      mkdirSync(cRoot, { recursive: true });
      writeFileSync(join(cRepo, "shared.txt"), "one\n");
      git(cRepo, "add", "-A");
      git(cRepo, "commit", "-m", "shared");
      const id = randomUUID();
      const created = createTaskWorktree({ repoPath: cRepo, repoName: "repo", taskId: id, root: cRoot });
      writeFileSync(join(created.path, "shared.txt"), "worktree edit\n");
      git(created.path, "add", "-A");
      git(created.path, "commit", "-m", "worktree edit");
      writeFileSync(join(cRepo, "shared.txt"), "base edit\n");
      git(cRepo, "add", "-A");
      git(cRepo, "commit", "-m", "base edit");
      const baseHead = git(cRepo, "rev-parse", "main");
      git(cRepo, "checkout", "-b", "other");
      const worktreesBefore = git(cRepo, "worktree", "list");
      await assert.rejects(
        () => mergeTaskWorktree(makeTask({ id, worktreePath: created.path, branch: created.branch, baseBranch: created.baseBranch })),
        (err: unknown) => {
          assert.ok(err instanceof WorktreeError);
          assert.equal(err.status, 409);
          assert.equal(err.message, "merge conflict");
          assert.ok((err.files ?? []).includes("shared.txt"));
          return true;
        },
      );
      assert.equal(git(cRepo, "rev-parse", "main"), baseHead);
      assert.equal(git(cRepo, "rev-parse", "--abbrev-ref", "HEAD"), "other");
      assert.equal(existsSync(join(cRoot, ".worktrees", "repo", `_merge-${id.slice(0, 8)}`)), false);
      assert.equal(git(cRepo, "worktree", "list"), worktreesBefore);
    } finally {
      try {
        rmSync(cBox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* disposable */
      }
    }
  });
});

describe("worktreeHint", () => {
  it("points at merge or discard while the task is still running or pending", () => {
    const task = makeTask({ status: "running", branch: "hub/abc12345" });
    const info = makeInfo({ branch: "hub/abc12345", commits: [] });
    assert.equal(
      worktreeHint(task, info),
      `Runs in its own worktree on branch hub/abc12345; when it completes, merge with hub_task_merge (taskId ${task.id.slice(0, 8)}) or POST /delegation/tasks/${task.id}/merge.`,
    );
  });

  it("counts the commits waiting to merge once the task has finished", () => {
    const task = makeTask({ status: "completed", branch: "hub/abc12345" });
    const info = makeInfo({ branch: "hub/abc12345", commits: [{ sha: "a", subject: "one" }, { sha: "b", subject: "two" }] });
    assert.equal(
      worktreeHint(task, info),
      `2 commit(s) on hub/abc12345 waiting: merge with hub_task_merge (taskId ${task.id.slice(0, 8)}), or discard with { discard: true }.`,
    );
  });

  it("tells the caller there is nothing to merge when the branch has no commits", () => {
    const task = makeTask({ status: "completed", branch: "hub/abc12345" });
    const info = makeInfo({ branch: "hub/abc12345", commits: [] });
    assert.equal(worktreeHint(task, info), `No commits on hub/abc12345: discard with hub_task_merge { taskId ${task.id.slice(0, 8)}, discard: true }.`);
  });

  it("reports the merge once mergedAt is set", () => {
    const task = makeTask({ status: "completed", branch: "hub/abc12345" });
    const info = makeInfo({ branch: "hub/abc12345", baseBranch: "main", mergedAt: Date.now() });
    assert.equal(worktreeHint(task, info), "Merged into main.");
  });

  it("tells the caller to discard when the worktree folder is gone", () => {
    const task = makeTask({ status: "failed", branch: "hub/abc12345" });
    const info = makeInfo({ branch: "hub/abc12345", exists: false, commits: [] });
    assert.equal(worktreeHint(task, info), "Worktree folder is gone; discard to clean the branch.");
  });
});
