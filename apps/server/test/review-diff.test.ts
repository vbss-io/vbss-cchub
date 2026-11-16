import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { capFile, composeReview, computeDiff, DIFF_FILE_LINES, gitRead, headCommit, parseReviewComments, parseUnifiedDiff, type DiffReady, type DiffResult } from "../src/review-diff.js";

const box = mkdtempSync(join(tmpdir(), "cch-diff-"));
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.com");
  git(path, "config", "core.autocrlf", "false");
  writeFileSync(join(path, "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  writeFileSync(join(path, "old.txt"), "to be removed\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "base");
}

const ready = (diff: DiffResult): DiffReady => {
  assert.equal(diff.available, true, diff.available ? "" : diff.reason);
  return diff as DiffReady;
};

after(() => {
  try {
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    void 0;
  }
});

describe("unified diff parsing", () => {
  it("parses statuses, line numbers and content lines that look like headers", () => {
    const text = [
      "diff --git a/src/x.ts b/src/x.ts",
      "index 1111111..2222222 100644",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "--- old dashes",
      "+++ new pluses",
      " tail",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "\\ No newline at end of file",
      "diff --git a/a.txt b/b.txt",
      "similarity index 90%",
      "rename from a.txt",
      "rename to b.txt",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(text);
    assert.deepEqual(files.map((file) => [file.path, file.status]), [["src/x.ts", "modified"], ["gone.txt", "deleted"], ["new.txt", "added"], ["b.txt", "renamed"], ["img.png", "modified"]]);
    const [x, gone, created, renamed, image] = files;
    assert.deepEqual(x?.hunks[0]?.lines.map((line) => [line.kind, line.oldLine, line.newLine, line.text]), [
      ["ctx", 1, 1, "keep"],
      ["del", 2, null, "-- old dashes"],
      ["add", null, 2, "++ new pluses"],
      ["ctx", 3, 3, "tail"],
    ]);
    assert.equal(x?.additions, 1);
    assert.equal(x?.deletions, 1);
    assert.equal(gone?.deletions, 1);
    assert.equal(created?.additions, 2);
    assert.equal(renamed?.oldPath, "a.txt");
    assert.equal(image?.binary, true);
  });

  it("caps long files and flags them as truncated", () => {
    const body = Array.from({ length: 50 }, (_, index) => `+line ${index}`).join("\n");
    const [file] = parseUnifiedDiff(`diff --git a/big.txt b/big.txt\nnew file mode 100644\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,50 @@\n${body}\n`);
    assert.ok(file);
    const capped = capFile(file, 10);
    assert.equal(capped.truncated, true);
    assert.equal(capped.shownLines, 10);
    assert.equal(capped.totalLines, 50);
    assert.equal(capped.hunks[0]?.lines.length, 10);
    assert.equal(capFile(file, 100).truncated, false);
  });
});

describe("diff of a worktree against its base", () => {
  it("includes the branch commits, uncommitted edits and untracked files", async () => {
    const repo = join(box, "wt-repo");
    initRepo(repo);
    const worktree = join(box, "wt", "task");
    git(repo, "worktree", "add", "-b", "hub/task", worktree, "HEAD");
    writeFileSync(join(worktree, "app.ts"), "const a = 1;\nconst b = 20;\nconst c = 3;\n");
    git(worktree, "commit", "-am", "change b");
    writeFileSync(join(worktree, "app.ts"), "const a = 1;\nconst b = 20;\nconst c = 30;\n");
    writeFileSync(join(worktree, "notes.md"), "# notes\nhello\n");
    git(repo, "commit", "--allow-empty", "-m", "main moved on");
    const diff = ready(await computeDiff({ dir: worktree, baseRef: null, baseKind: "worktree", baseBranch: "main" }));
    assert.equal(diff.base.kind, "worktree");
    const app = diff.files.find((file) => file.path === "app.ts");
    assert.deepEqual(app?.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === "add").map((line) => line.text)), ["const b = 20;", "const c = 30;"]);
    const notes = diff.files.find((file) => file.path === "notes.md");
    assert.equal(notes?.status, "untracked");
    assert.equal(notes?.additions, 2);
    assert.equal(diff.totals.files, 2);
    assert.equal(git(worktree, "status", "--porcelain").includes("notes.md"), true);
  });
});

describe("diff of a cwd", () => {
  it("diffs against the recorded starting commit, else against HEAD", async () => {
    const repo = join(box, "cwd-repo");
    initRepo(repo);
    const start = headCommit(repo);
    assert.match(start ?? "", /^[0-9a-f]{40}$/);
    writeFileSync(join(repo, "app.ts"), "const a = 10;\nconst b = 2;\nconst c = 3;\n");
    git(repo, "commit", "-am", "agent commit");
    rmSync(join(repo, "old.txt"));
    const sinceStart = ready(await computeDiff({ dir: repo, baseRef: start, baseKind: "start-commit", baseBranch: null }));
    assert.equal(sinceStart.base.kind, "start-commit");
    assert.deepEqual(sinceStart.files.map((file) => [file.path, file.status]).sort(), [["app.ts", "modified"], ["old.txt", "deleted"]]);
    const sinceHead = ready(await computeDiff({ dir: repo, baseRef: null, baseKind: "start-commit", baseBranch: null }));
    assert.equal(sinceHead.base.kind, "head");
    assert.deepEqual(sinceHead.files.map((file) => file.path), ["old.txt"]);
    const bogus = ready(await computeDiff({ dir: repo, baseRef: "0".repeat(40), baseKind: "start-commit", baseBranch: null }));
    assert.equal(bogus.base.kind, "head");
  });

  it("truncates huge files with a flag and shows the full file on request", async () => {
    const repo = join(box, "big-repo");
    initRepo(repo);
    writeFileSync(join(repo, "big.txt"), Array.from({ length: 1200 }, (_, index) => `row ${index}`).join("\n") + "\n");
    git(repo, "add", "big.txt");
    const diff = ready(await computeDiff({ dir: repo, baseRef: null, baseKind: "head", baseBranch: null }));
    const big = diff.files.find((file) => file.path === "big.txt");
    assert.equal(big?.truncated, true);
    assert.equal(big?.shownLines, DIFF_FILE_LINES);
    assert.equal(big?.totalLines, 1200);
    const full = ready(await computeDiff({ dir: repo, baseRef: null, baseKind: "head", baseBranch: null }, { file: "big.txt" }));
    assert.equal(full.files.length, 1);
    assert.equal(full.files[0]?.truncated, false);
    assert.equal(full.files[0]?.shownLines, 1200);
  });

  it("reports a folder that is not a git repository and missing folders", async () => {
    const plain = join(box, "plain");
    mkdirSync(plain, { recursive: true });
    assert.deepEqual(await computeDiff({ dir: plain, baseRef: null, baseKind: "head", baseBranch: null }), { available: false, reason: "not a git repository" });
    assert.equal((await computeDiff({ dir: join(box, "nope"), baseRef: null, baseKind: "head", baseBranch: null })).available, false);
    assert.equal(headCommit(plain), null);
  });

  it("refuses git commands that write", async () => {
    await assert.rejects(gitRead(box, ["commit", "-m", "x"]), /not a read-only command/);
    await assert.rejects(gitRead(box, ["checkout", "main"]), /not a read-only command/);
  });
});

describe("review text", () => {
  it("validates comments", () => {
    assert.equal(typeof parseReviewComments([]), "string");
    assert.equal(typeof parseReviewComments([{ file: "a", line: 0, text: "x" }]), "string");
    assert.equal(typeof parseReviewComments([{ file: "a", line: 1, text: " " }]), "string");
    assert.equal(typeof parseReviewComments([{ file: "a", line: 1, side: "left", text: "x" }]), "string");
    assert.deepEqual(parseReviewComments([{ file: " a.ts ", line: 3, text: " fix " }]), [{ file: "a.ts", line: 3, side: "new", text: "fix" }]);
  });

  it("joins the comments into one text grouped by file with file:line and a quoted context line", () => {
    const [x] = parseUnifiedDiff("diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,3 +1,3 @@\n keep\n-const old = 1;\n+const fresh = 2;\n tail\n");
    assert.ok(x);
    const text = composeReview(
      [
        { file: "src/x.ts", line: 3, side: "new", text: "keep the tail" },
        { file: "README.md", line: 1, side: "new", text: "mention the flag" },
        { file: "src/x.ts", line: 2, side: "new", text: "rename to count\nand add a test" },
        { file: "src/x.ts", line: 2, side: "old", text: "why was this removed?" },
      ],
      [x],
    );
    assert.equal(
      text,
      [
        "Review of your changes (4 comments). Address each one, then summarize what you changed.",
        "",
        "src/x.ts",
        "- src/x.ts:2",
        "  > const fresh = 2;",
        "  rename to count",
        "  and add a test",
        "- src/x.ts:2 (removed line)",
        "  > const old = 1;",
        "  why was this removed?",
        "- src/x.ts:3",
        "  > tail",
        "  keep the tail",
        "",
        "README.md",
        "- README.md:1",
        "  mention the flag",
      ].join("\n"),
    );
  });
});
