import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codexMenuKeys, codexPrimaryAction, sessionMenuKeys, sessionPrimaryAction, sessionTabs, visibleTab, type SessionTabInput } from "./drawer-model";

const empty: SessionTabInput = { agentsTotal: 0, agentsRunning: 0, asks: 0, forks: 0, delegated: 0, delegatedOn: true };

const keys = (input: SessionTabInput): string[] => sessionTabs(input).map((tab) => tab.key);

describe("sessionPrimaryAction", () => {
  it("offers Focus for a live session that is not stale", () => {
    assert.equal(sessionPrimaryAction({ status: "active", stale: false }), "focus");
    assert.equal(sessionPrimaryAction({ status: "waiting", stale: false }), "focus");
    assert.equal(sessionPrimaryAction({ status: "idle", stale: false }), "focus");
  });

  it("offers nothing for an ended or stale session", () => {
    assert.equal(sessionPrimaryAction({ status: "ended", stale: false }), null);
    assert.equal(sessionPrimaryAction({ status: "idle", stale: true }), null);
  });
});

describe("sessionTabs", () => {
  it("keeps only Activity and Details when nothing else has content", () => {
    assert.deepEqual(keys(empty), ["activity", "details"]);
  });

  it("shows Subagents with running over total", () => {
    const tabs = sessionTabs({ ...empty, agentsTotal: 3, agentsRunning: 1 });
    assert.deepEqual(tabs.map((tab) => tab.key), ["activity", "agents", "details"]);
    assert.equal(tabs.find((tab) => tab.key === "agents")?.count, "1/3");
    assert.equal(sessionTabs({ ...empty, agentsTotal: 2 }).find((tab) => tab.key === "agents")?.count, "2");
  });

  it("shows Asks when the session has asks or forks", () => {
    assert.deepEqual(keys({ ...empty, asks: 2 }), ["activity", "asks", "details"]);
    assert.deepEqual(keys({ ...empty, forks: 1 }), ["activity", "asks", "details"]);
    assert.equal(sessionTabs({ ...empty, forks: 1 }).find((tab) => tab.key === "asks")?.count, undefined);
  });

  it("shows Delegated only with tasks and the Delegated plugin on", () => {
    assert.deepEqual(keys({ ...empty, delegated: 2 }), ["activity", "delegated", "details"]);
    assert.equal(sessionTabs({ ...empty, delegated: 2 }).find((tab) => tab.key === "delegated")?.count, "2");
    assert.deepEqual(keys({ ...empty, delegated: 2, delegatedOn: false }), ["activity", "details"]);
  });
});

describe("visibleTab", () => {
  it("keeps the picked tab while it is visible and falls back when it disappears", () => {
    const tabs = sessionTabs({ ...empty, delegated: 1 });
    assert.equal(visibleTab("delegated", tabs, "activity"), "delegated");
    assert.equal(visibleTab("asks", tabs, "activity"), "activity");
  });
});

describe("sessionMenuKeys", () => {
  it("puts Share, large view and Archive in the menu", () => {
    assert.deepEqual(sessionMenuKeys({ canShare: true, archived: false }), ["share", "large", "archive"]);
  });

  it("drops Share when it cannot be shared and Archive when archived", () => {
    assert.deepEqual(sessionMenuKeys({ canShare: false, archived: true }), ["large"]);
  });
});

describe("codexPrimaryAction", () => {
  it("offers Focus app for a live thread while the Codex app is open", () => {
    assert.equal(codexPrimaryAction({ status: "active", appRunning: true }), "focus-app");
    assert.equal(codexPrimaryAction({ status: "idle", appRunning: true }), "focus-app");
  });

  it("offers nothing when the app is closed or the thread ended", () => {
    assert.equal(codexPrimaryAction({ status: "active", appRunning: false }), null);
    assert.equal(codexPrimaryAction({ status: "ended", appRunning: true }), null);
  });
});

describe("codexMenuKeys", () => {
  it("adds Open in Delegated only for a hub thread with the plugin on", () => {
    assert.deepEqual(codexMenuKeys({ hubTask: true, delegatedOn: true, archived: false }), ["task", "large", "archive"]);
    assert.deepEqual(codexMenuKeys({ hubTask: true, delegatedOn: false, archived: false }), ["large", "archive"]);
    assert.deepEqual(codexMenuKeys({ hubTask: false, delegatedOn: true, archived: true }), ["large", "unarchive"]);
  });
});
