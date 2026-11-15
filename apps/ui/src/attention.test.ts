import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attentionCount, needsYou, sessionsBadge, sessionsBadgeTitle } from "./attention";
import type { TaskStatus } from "./delegation";
import type { SessionStatus } from "./types";

const session = (status: SessionStatus, unread?: boolean) => (unread === undefined ? { status } : { status, unread });

describe("needsYou", () => {
  it("is true for waiting sessions", () => {
    assert.equal(needsYou(session("waiting")), true);
    assert.equal(needsYou(session("waiting", false)), true);
  });

  it("is true for unread sessions", () => {
    assert.equal(needsYou(session("idle", true)), true);
  });

  it("is false for idle sessions already seen", () => {
    assert.equal(needsYou(session("idle", false)), false);
  });

  it("treats a missing unread flag as false", () => {
    assert.equal(needsYou(session("idle")), false);
    assert.equal(needsYou(session("active")), false);
  });

  it("is false for active and ended sessions", () => {
    assert.equal(needsYou(session("active", false)), false);
    assert.equal(needsYou(session("ended", false)), false);
  });
});

describe("attentionCount", () => {
  it("counts waiting plus unread, never every idle", () => {
    const list = [session("waiting"), session("idle", true), session("idle", false), session("idle"), session("active"), session("ended")];
    assert.equal(attentionCount(list), 2);
  });

  it("counts a session once even when it is waiting and unread", () => {
    assert.equal(attentionCount([session("waiting", true)]), 1);
  });

  it("returns zero for no sessions", () => {
    assert.equal(attentionCount([]), 0);
  });

  it("ignores Claude Desktop helper sessions folded into their parent", () => {
    const helper = { status: "idle" as const, unread: true, helperOf: "parent-1" };
    const waitingHelper = { status: "waiting" as const, helperOf: "parent-1" };
    assert.equal(needsYou(helper), false);
    assert.equal(attentionCount([helper, waitingHelper, session("idle", true)]), 1);
  });
});

describe("sessionsBadge", () => {
  const task = (status: TaskStatus, archivedAt: number | null = null) => ({ status, archivedAt });
  const sessions = [session("waiting"), session("idle", true), session("active")];
  const tasks = [task("attention"), task("failed"), task("interrupted"), task("running"), task("pending"), task("done"), task("failed", 5)];

  it("adds the delegated tasks that need you when the Delegated plugin is on", () => {
    assert.deepEqual(sessionsBadge(sessions, tasks, true), { count: 5, sessions: 2, tasks: 3 });
  });

  it("counts only sessions when the Delegated plugin is off", () => {
    assert.deepEqual(sessionsBadge(sessions, tasks, false), { count: 2, sessions: 2, tasks: 0 });
  });

  it("leaves running, pending, done and archived tasks out like the Needs you band", () => {
    assert.deepEqual(sessionsBadge([], [task("running"), task("pending"), task("done"), task("attention", 1)], true), { count: 0, sessions: 0, tasks: 0 });
    assert.deepEqual(sessionsBadge([], [task("failed")], true), { count: 1, sessions: 0, tasks: 1 });
  });
});

describe("sessionsBadgeTitle", () => {
  it("is the plain label without a badge", () => {
    assert.equal(sessionsBadgeTitle("Sessions", { count: 0, sessions: 0, tasks: 0 }), "Sessions");
  });

  it("names what needs you", () => {
    assert.equal(sessionsBadgeTitle("Sessions", { count: 1, sessions: 0, tasks: 1 }), "Sessions (1): 1 delegated task needs you");
    assert.equal(sessionsBadgeTitle("Sessions", { count: 1, sessions: 1, tasks: 0 }), "Sessions (1): 1 session needs you");
    assert.equal(sessionsBadgeTitle("Sessions", { count: 5, sessions: 2, tasks: 3 }), "Sessions (5): 2 sessions and 3 delegated tasks need you");
  });
});
