import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "cch-cwdguard-"));
process.env.HUB_DATA_DIR = dataDir;
process.env.HUB_GH_BIN = join(dataDir, "must-not-spawn-gh.exe");
process.env.HUB_GH_ARGS_PREFIX = "[]";

type Diff = typeof import("../src/review-diff.js");
type Gh = typeof import("../src/gh.js");
let diff: Diff;
let gh: Gh;

before(async () => {
  diff = await import("../src/review-diff.js");
  gh = await import("../src/gh.js");
});

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    void 0;
  }
});

const UNSAFE = ["\\\\server\\share\\repo", "//server/share/repo", "\\\\?\\C:\\repo", "\\\\.\\pipe\\x", "relative/dir", "..", ".", "", "C:repo"];

describe("session cwd guard", () => {
  it("refuses UNC, device, relative and empty directories", () => {
    for (const dir of UNSAFE) assert.equal(diff.unsafeDirReason(dir), diff.UNSAFE_DIR_REASON, JSON.stringify(dir));
    assert.equal(diff.unsafeDirReason(null), diff.UNSAFE_DIR_REASON);
    assert.equal(diff.unsafeDirReason(`${dataDir}\0x`), diff.UNSAFE_DIR_REASON);
  });

  it("accepts an absolute local directory", () => {
    assert.equal(diff.unsafeDirReason(dataDir), null);
  });

  it("returns an unavailable diff without touching git", async () => {
    for (const dir of UNSAFE.filter((item) => item.length > 0)) {
      const result = await diff.computeDiff({ dir, baseRef: null, baseKind: "head", baseBranch: null });
      assert.deepEqual(result, { available: false, reason: diff.UNSAFE_DIR_REASON }, dir);
    }
  });

  it("refuses to read git or resolve HEAD in an unsafe directory", async () => {
    await assert.rejects(diff.gitRead("\\\\server\\share\\repo", ["status"]), /not an absolute local path/);
    assert.equal(diff.headCommit("\\\\server\\share\\repo"), null);
    assert.equal(diff.headCommit("relative/dir"), null);
  });

  it("returns an unavailable gh status without running gh", async () => {
    gh.resetGhCache();
    for (const dir of UNSAFE.filter((item) => item.length > 0)) {
      assert.deepEqual(await gh.ghStatus(dir), { available: false, reason: diff.UNSAFE_DIR_REASON }, dir);
    }
  });

  it("does not run gh with an unsafe cwd", async () => {
    const outcome = await gh.runGh(["--version"], "\\\\server\\share\\repo");
    assert.deepEqual(outcome, { ok: false, stdout: "", stderr: "", missing: false });
  });
});
