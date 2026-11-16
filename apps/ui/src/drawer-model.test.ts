import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { agentStepsLabel, sessionRelations, splitAgents, toggleExpanded } from "./drawer-model";
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

  it("adds Review before Details only when the session has a working directory", () => {
    assert.deepEqual(keys({ ...empty, review: true }), ["activity", "review", "details"]);
    assert.deepEqual(keys({ ...empty, review: false }), ["activity", "details"]);
    assert.deepEqual(keys({ ...empty, delegated: 2, review: true }), ["activity", "delegated", "review", "details"]);
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

  it("puts Open session first when the session can be opened", () => {
    assert.deepEqual(sessionMenuKeys({ canShare: true, archived: false, canOpen: true }), ["open", "share", "large", "archive"]);
  });
});

describe("codexPrimaryAction", () => {
  it("offers Focus app for a live thread while the Codex app is open", () => {
    assert.equal(codexPrimaryAction({ status: "active", appRunning: true }), "focus-app");
    assert.equal(codexPrimaryAction({ status: "idle", appRunning: true }), "focus-app");
    assert.equal(codexPrimaryAction({ status: "waiting", appRunning: true }), "focus-app");
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

  it("puts Open session first when the thread can be opened", () => {
    assert.deepEqual(codexMenuKeys({ hubTask: true, delegatedOn: true, archived: false, canOpen: true }), ["open", "task", "large", "archive"]);
  });
});

describe("sessionRelations", () => {
  const none = { forkOf: null, forkParentName: null, helperOf: null, helperParentName: null, helpers: 0, helpersTotal: 0, peers: 0 };

  it("shows dashes when the session has no fork parent, helpers or peers", () => {
    assert.deepEqual(sessionRelations(none), { fork: "—", helpers: "—", peers: "—" });
  });

  it("names the fork parent, the folded helpers and the live peers the card only hints at", () => {
    assert.deepEqual(sessionRelations({ ...none, forkOf: "abcdef123456", forkParentName: "planner", helpers: 2, helpersTotal: 3, peers: 1 }), {
      fork: "fork of planner",
      helpers: "2 helpers folded in · 3 total",
      peers: "1 other live agent in this folder",
    });
  });

  it("falls back to the short id and says whose helper it is", () => {
    assert.deepEqual(sessionRelations({ ...none, forkOf: "abcdef123456", helperOf: "99887766aabb", helpers: 1, helpersTotal: 1, peers: 3 }), {
      fork: "fork of abcdef12",
      helpers: "1 helper folded in · 1 total · helper of 99887766",
      peers: "3 other live agents in this folder",
    });
    assert.equal(sessionRelations({ ...none, helperOf: "99887766aabb", helperParentName: "main" }).helpers, "helper of main");
  });
});

describe("splitAgents", () => {
  const agent = (agentId: string, status: "running" | "ended", turns: number, agentType: string | null = "Explore") => ({ agentId, status, turns, agentType });

  it("keeps running agents and agents with turns, and folds the silent ended ones by type", () => {
    const result = splitAgents([agent("a", "running", 0), agent("b", "ended", 3), agent("c", "ended", 0, "Plan"), agent("d", "ended", 0, null), agent("e", "ended", 0, "Plan")]);
    assert.deepEqual(result.shown.map((item) => item.agentId), ["a", "b"]);
    assert.deepEqual(result.silent, [["Plan", 2], ["agent", 1]]);
  });

  it("returns empty groups for no agents", () => {
    assert.deepEqual(splitAgents([]), { shown: [], silent: [] });
  });
});

describe("toggleExpanded", () => {
  it("adds and removes an id without mutating the input", () => {
    const start = new Set(["a"]);
    const added = toggleExpanded(start, "b");
    assert.deepEqual([...added], ["a", "b"]);
    assert.deepEqual([...toggleExpanded(added, "a")], ["b"]);
    assert.deepEqual([...start], ["a"]);
  });
});

describe("agentStepsLabel", () => {
  it("counts the steps below the tail cap", () => {
    assert.equal(agentStepsLabel(1), "1 step");
    assert.equal(agentStepsLabel(7), "7 steps");
    assert.equal(agentStepsLabel(11), "11 steps");
  });

  it("marks the count as a lower bound once the tail cap is reached", () => {
    assert.equal(agentStepsLabel(12), "12+ steps");
    assert.equal(agentStepsLabel(300), "12+ steps");
  });
});
