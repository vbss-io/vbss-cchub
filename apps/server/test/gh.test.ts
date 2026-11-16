import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { fixtures } from "./helpers.js";
import { ghStatus, isReadOnlyGh, resetGhCache, summarizeChecks } from "../src/gh.js";

const box = mkdtempSync(join(tmpdir(), "cch-gh-"));
const repo = join(box, "repo");
const capture = join(box, "gh-capture.jsonl");
const git = (...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

mkdirSync(repo, { recursive: true });
git("init", "-b", "feat/g4");
git("config", "user.name", "Test");
git("config", "user.email", "test@example.com");
writeFileSync(join(repo, "a.txt"), "a\n");
git("add", "-A");
git("commit", "-m", "base");

const useFakeGh = (mode: string): void => {
  process.env.HUB_GH_BIN = process.execPath;
  process.env.HUB_GH_ARGS_PREFIX = JSON.stringify([join(fixtures, "fake-gh.mjs")]);
  process.env.FAKE_GH_CAPTURE = capture;
  process.env.FAKE_GH_MODE = mode;
};

const calls = (): string[][] =>
  existsSync(capture)
    ? readFileSync(capture, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
    : [];

beforeEach(() => {
  resetGhCache();
  rmSync(capture, { force: true });
});

after(() => {
  try {
    rmSync(box, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    void 0;
  }
});

describe("gh read-only status", () => {
  it("allows only read commands", () => {
    assert.equal(isReadOnlyGh(["--version"]), true);
    assert.equal(isReadOnlyGh(["auth", "status"]), true);
    assert.equal(isReadOnlyGh(["pr", "view", "x", "--json", "number"]), true);
    assert.equal(isReadOnlyGh(["run", "list"]), true);
    assert.equal(isReadOnlyGh(["pr", "merge", "1"]), false);
    assert.equal(isReadOnlyGh(["pr", "comment", "1"]), false);
    assert.equal(isReadOnlyGh(["auth", "login"]), false);
    assert.equal(isReadOnlyGh(["api", "repos"]), false);
    assert.equal(isReadOnlyGh(["run", "rerun", "1"]), false);
  });

  it("is unavailable when gh is not installed, so the section hides", async () => {
    process.env.HUB_GH_BIN = join(box, "missing-gh.exe");
    process.env.HUB_GH_ARGS_PREFIX = "[]";
    assert.deepEqual(await ghStatus(repo), { available: false, reason: "gh is not installed" });
  });

  it("is unavailable when gh is not logged in", async () => {
    useFakeGh("unauth");
    assert.deepEqual(await ghStatus(repo), { available: false, reason: "gh is not logged in" });
  });

  it("reads the PR of the branch with its checks and the latest runs, then serves the cache", async () => {
    useFakeGh("");
    const status = await ghStatus(repo, null, 1_000_000);
    assert.equal(status.available, true);
    if (!status.available) return;
    assert.equal(status.branch, "feat/g4");
    assert.equal(status.pr?.number, 42);
    assert.equal(status.pr?.url, "https://github.example/fake/pull/42");
    assert.deepEqual(status.pr?.checks, { total: 4, passing: 1, failing: 1, pending: 2, state: "failing" });
    assert.equal(status.runs.length, 2);
    assert.equal(status.runs[0]?.conclusion, "failure");
    const first = calls();
    assert.deepEqual(first.map((argv) => argv.slice(0, 2).join(" ")).sort(), ["--version", "auth status", "pr view", "run list"]);
    assert.ok(first.every((argv) => isReadOnlyGh(argv)));
    await ghStatus(repo, null, 1_030_000);
    assert.equal(calls().length, first.length);
    await ghStatus(repo, null, 1_070_000);
    assert.ok(calls().length > first.length);
  });

  it("reports no PR when the branch has none", async () => {
    useFakeGh("nopr");
    const status = await ghStatus(repo);
    assert.equal(status.available, true);
    if (status.available) {
      assert.equal(status.pr, null);
      assert.equal(status.runs.length, 2);
    }
  });

  it("summarizes check states", () => {
    assert.deepEqual(summarizeChecks([]), { total: 0, passing: 0, failing: 0, pending: 0, state: "none" });
    assert.equal(summarizeChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }]).state, "passing");
    assert.equal(summarizeChecks([{ status: "QUEUED", conclusion: "" }]).state, "pending");
  });
});
