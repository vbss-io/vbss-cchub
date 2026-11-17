import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { TaskRecord } from "../src/delegation-types.js";
import { createTaskWorktree, discardTaskWorktree, mergeTaskWorktree, worktreeMainRepo, worktreeStatus, WorktreeError } from "../src/worktrees.js";
import { s2Git, s2InitRepo } from "./helpers/s2-env.js";

const box = mkdtempSync(join(tmpdir(), "cch-s2-wt-"));

after(() => {
  rmSync(box, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

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
  } as TaskRecord;
}

function freshRepo(name: string): { repo: string; root: string } {
  const repo = join(box, name, "repo");
  const root = join(box, name, "ws");
  s2InitRepo(repo, { "base.txt": "base\n" });
  mkdirSync(root, { recursive: true });
  return { repo, root };
}

function taskOf(repo: string, root: string, over: Partial<TaskRecord> = {}): { task: TaskRecord; path: string; branch: string } {
  const id = randomUUID();
  const created = createTaskWorktree({ repoPath: repo, repoName: "repo", taskId: id, root });
  return { task: makeTask({ id, worktreePath: created.path, branch: created.branch, baseBranch: created.baseBranch, ...over }), path: created.path, branch: created.branch };
}

function commitIn(dir: string, file: string, content: string): void {
  writeFileSync(join(dir, file), content);
  s2Git(dir, "add", "-A");
  s2Git(dir, "commit", "-q", "-m", `edit ${file}`);
}

describe("creating worktrees", () => {
  it("refuses a detached HEAD and a branch that already exists", () => {
    const { repo, root } = freshRepo("create");
    const id = randomUUID();
    createTaskWorktree({ repoPath: repo, repoName: "repo", taskId: id, root });
    assert.throws(
      () => createTaskWorktree({ repoPath: repo, repoName: "repo", taskId: id, root }),
      (err: unknown) => err instanceof WorktreeError && err.status === 400 && /could not create a worktree/.test(err.message),
    );
    s2Git(repo, "checkout", "-q", "--detach");
    assert.throws(
      () => createTaskWorktree({ repoPath: repo, repoName: "repo", taskId: randomUUID(), root }),
      (err: unknown) => err instanceof WorktreeError && err.status === 400 && /detached HEAD/.test(err.message),
    );
  });

  it("links the node_modules of the repo into the worktree unless one is already there", () => {
    const { repo, root } = freshRepo("links");
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "marker.txt"), "x");
    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    s2Git(repo, "add", "-A");
    s2Git(repo, "commit", "-q", "-m", "ignore modules");
    const linked = taskOf(repo, root);
    assert.equal(existsSync(join(linked.path, "node_modules", "marker.txt")), true);
    assert.ok(worktreeMainRepo(linked.path));
    assert.equal(worktreeMainRepo(join(box, "not-a-worktree")), null);
  });
});

describe("worktree status", () => {
  it("reports a missing folder, a null path, a task without a base branch and a broken checkout", async () => {
    const { repo, root } = freshRepo("status");
    const none = await worktreeStatus(makeTask({ worktreePath: null }));
    assert.equal(none.exists, false);
    assert.equal(none.hint, "Worktree discarded.");
    const made = taskOf(repo, root);
    commitIn(made.path, "work.txt", "work\n");
    writeFileSync(join(made.path, "dirty.txt"), "dirty\n");
    const noBase = await worktreeStatus({ ...made.task, baseBranch: null });
    assert.equal(noBase.exists, true);
    assert.equal(noBase.dirty, true);
    assert.deepEqual(noBase.commits, []);
    assert.equal(noBase.diffStat, "");
    const full = await worktreeStatus(made.task);
    assert.equal(full.commits.length, 1);
    assert.match(full.diffStat, /work\.txt/);
    const gone = await worktreeStatus({ ...made.task, worktreePath: join(box, "gone-folder") });
    assert.equal(gone.exists, false);
    const broken = join(box, "broken-checkout");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, ".git"), "gitdir: C:/does/not/exist\n");
    const failing = await worktreeStatus({ ...made.task, worktreePath: broken });
    assert.equal(failing.exists, true);
    assert.equal(failing.dirty, false);
    assert.notEqual(failing.hint, "");
  });
});

describe("merging worktrees", () => {
  it("explains why a task cannot be merged", async () => {
    const { repo, root } = freshRepo("merge-errors");
    const reject = async (task: TaskRecord, status: number, message: RegExp): Promise<void> => {
      await assert.rejects(
        () => mergeTaskWorktree(task),
        (err: unknown) => err instanceof WorktreeError && err.status === status && message.test(err.message),
      );
    };
    await reject(makeTask({ isolation: "shared" }), 404, /task has no worktree/);
    await reject(makeTask({ worktreePath: null }), 404, /task has no worktree/);
    const made = taskOf(repo, root);
    await reject({ ...made.task, branch: null }, 409, /no worktree branch/);
    await reject({ ...made.task, baseBranch: null }, 409, /no worktree branch/);
    await reject({ ...made.task, worktreePath: join(box, "folder-is-gone") }, 409, /worktree folder is gone/);
    const plain = join(repo, "plain-folder");
    mkdirSync(plain, { recursive: true });
    await reject({ ...made.task, worktreePath: plain }, 409, /could not resolve the original checkout/);
    writeFileSync(join(made.path, "pending.txt"), "uncommitted\n");
    await reject(made.task, 409, /uncommitted changes/);
    rmSync(join(made.path, "pending.txt"));
    await reject(made.task, 409, /nothing to merge/);
  });

  it("allows one merge per repository at a time", async () => {
    const { repo, root } = freshRepo("merge-lock");
    const first = taskOf(repo, root);
    const second = taskOf(repo, root);
    commitIn(first.path, "first.txt", "first\n");
    commitIn(second.path, "second.txt", "second\n");
    const running = mergeTaskWorktree(first.task);
    await assert.rejects(
      () => mergeTaskWorktree(second.task),
      (err: unknown) => err instanceof WorktreeError && err.status === 409 && /already in flight/.test(err.message),
    );
    await running;
    await mergeTaskWorktree(second.task);
    assert.equal(s2Git(repo, "show", "HEAD:second.txt"), "second");
    assert.equal(s2Git(repo, "show", "HEAD:first.txt"), "first");
  });

  it("merges through the worktree that already has the base branch checked out", async () => {
    const { repo, root } = freshRepo("merge-existing");
    const made = taskOf(repo, root);
    commitIn(made.path, "feature.txt", "feature\n");
    s2Git(repo, "checkout", "-q", "-b", "elsewhere");
    const baseTree = join(box, "merge-existing", "base-tree");
    s2Git(repo, "worktree", "add", baseTree, "main");
    await mergeTaskWorktree(made.task);
    assert.equal(s2Git(baseTree, "show", "HEAD:feature.txt"), "feature");
    assert.equal(s2Git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "elsewhere");
    assert.equal(s2Git(baseTree, "status", "--porcelain"), "");
  });

  it("reports a failure to create the temporary merge worktree", async () => {
    const { repo, root } = freshRepo("merge-temp");
    const made = taskOf(repo, root);
    commitIn(made.path, "feature.txt", "feature\n");
    s2Git(repo, "checkout", "-q", "-b", "elsewhere");
    const blocker = join(made.path, "..", `_merge-${made.task.id.slice(0, 8)}`);
    mkdirSync(blocker, { recursive: true });
    writeFileSync(join(blocker, "occupied.txt"), "in the way");
    await assert.rejects(
      () => mergeTaskWorktree(made.task),
      (err: unknown) => err instanceof WorktreeError && err.status === 409 && /could not create a temporary worktree on "main"/.test(err.message),
    );
    rmSync(blocker, { recursive: true, force: true });
    await mergeTaskWorktree(made.task);
    assert.equal(existsSync(blocker), false);
    assert.equal(s2Git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "elsewhere");
  });
});

describe("discarding worktrees", () => {
  it("refuses a task without a worktree and ignores one that is already discarded", async () => {
    await assert.rejects(
      () => discardTaskWorktree(makeTask({ isolation: "shared" })),
      (err: unknown) => err instanceof WorktreeError && err.status === 404,
    );
    await discardTaskWorktree(makeTask({ worktreePath: null }));
    await discardTaskWorktree(makeTask({ worktreePath: join(box, "never-existed") }), null);
  });

  it("prunes when the worktree folder vanished and keeps going when the branch cannot be deleted", async () => {
    const { repo, root } = freshRepo("discard");
    const vanished = taskOf(repo, root);
    rmSync(vanished.path, { recursive: true, force: true });
    await discardTaskWorktree(vanished.task, repo);
    assert.equal(s2Git(repo, "branch", "--list", vanished.branch), "");
    const kept = taskOf(repo, root);
    await discardTaskWorktree({ ...kept.task, branch: "no-such-branch" }, repo);
    assert.equal(existsSync(kept.path), false);
    assert.equal(s2Git(repo, "branch", "--list", kept.branch).includes(kept.branch), true);
    const noBranch = taskOf(repo, root);
    await discardTaskWorktree({ ...noBranch.task, branch: null }, repo);
    assert.equal(existsSync(noBranch.path), false);
  });
});
