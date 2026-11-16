import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checksLine, checksTone, ghVisible, noPrLine, prState, runState, runTitle, runTone, safeUrl } from "./gh-model";
import type { GhChecks, GhStatus } from "./types";

const checks = (patch: Partial<GhChecks> = {}): GhChecks => ({ total: 3, passing: 3, failing: 0, pending: 0, state: "passing", ...patch });

describe("ghVisible", () => {
  it("hides the section when gh is missing, logged out or the branch is unknown", () => {
    const missing: GhStatus = { available: false, reason: "gh is not installed" };
    assert.equal(ghVisible(missing), false);
    assert.equal(ghVisible(null), false);
    assert.equal(ghVisible(undefined), false);
  });

  it("shows the section when gh answered", () => {
    assert.equal(ghVisible({ available: true, branch: "feat/x", pr: null, runs: [], fetchedAt: 1 }), true);
  });
});

describe("checksLine and checksTone", () => {
  it("summarises a passing, failing, pending and empty set", () => {
    assert.equal(checksLine(checks()), "All 3 checks passing");
    assert.equal(checksLine(checks({ failing: 1, passing: 2, state: "failing" })), "1 of 3 checks failing");
    assert.equal(checksLine(checks({ pending: 2, passing: 1, state: "pending" })), "2 of 3 checks running");
    assert.equal(checksLine(checks({ total: 0, passing: 0, state: "none" })), "No checks");
  });

  it("colours only failing and pending", () => {
    assert.equal(checksTone(checks({ state: "failing" })), "hold");
    assert.equal(checksTone(checks({ state: "pending" })), "pend");
    assert.equal(checksTone(checks({ state: "passing" })), "go");
    assert.equal(checksTone(checks({ state: "none" })), "muted");
  });
});

describe("pull request and run text", () => {
  it("names draft pull requests and capitalises the state", () => {
    assert.equal(prState("OPEN", true), "Draft");
    assert.equal(prState("OPEN", false), "Open");
    assert.equal(prState("MERGED", false), "Merged");
    assert.equal(prState("", false), "Unknown");
  });

  it("describes a run by its status or conclusion", () => {
    assert.equal(runState({ status: "in_progress", conclusion: null }), "in progress");
    assert.equal(runState({ status: "completed", conclusion: "timed_out" }), "timed out");
    assert.equal(runState({ status: null, conclusion: null }), "unknown");
  });

  it("colours failing runs and running runs only", () => {
    assert.equal(runTone({ status: "queued", conclusion: null }), "pend");
    assert.equal(runTone({ status: "completed", conclusion: "failure" }), "hold");
    assert.equal(runTone({ status: "completed", conclusion: "success" }), "go");
    assert.equal(runTone({ status: "completed", conclusion: "cancelled" }), "muted");
  });

  it("prefixes the workflow when it adds information", () => {
    assert.equal(runTitle({ title: "fix: bug", workflow: "CI" }), "CI: fix: bug");
    assert.equal(runTitle({ title: "CI", workflow: "CI" }), "CI");
    assert.equal(runTitle({ title: "CI", workflow: null }), "CI");
  });

  it("only links https urls", () => {
    assert.equal(safeUrl("https://github.com/a/b/pull/1"), "https://github.com/a/b/pull/1");
    assert.equal(safeUrl("javascript:alert(1)"), null);
    assert.equal(safeUrl("http://example.com"), null);
    assert.equal(safeUrl(null), null);
  });

  it("says when the branch has no pull request", () => {
    assert.equal(noPrLine("feat/x"), "No pull request for feat/x");
  });
});
