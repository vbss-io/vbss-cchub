import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionRecord, SessionStatus } from "./types";
import { pipTone, sessionTone, taskTone } from "./widget-model";

const session = (status: SessionStatus, unread = false): SessionRecord => ({
  sessionId: "s",
  status,
  cwd: null,
  source: null,
  hostPid: null,
  title: "s",
  customTitle: null,
  lastMessage: null,
  model: null,
  tokensIn: null,
  tokensOut: null,
  contextTokens: null,
  archivedAt: null,
  favoriteAt: null,
  unread,
  startedAt: 0,
  updatedAt: 0,
});

describe("sessionTone", () => {
  it("is yellow for waiting, violet for unread, cyan for active and grey for the rest", () => {
    assert.equal(sessionTone(session("waiting")), "pend");
    assert.equal(sessionTone(session("idle", true)), "unread");
    assert.equal(sessionTone(session("active")), "go");
    assert.equal(sessionTone(session("idle")), "idle");
    assert.equal(sessionTone(session("ended")), "idle");
  });
});

describe("taskTone", () => {
  it("is yellow when the task needs you, red on failure, cyan while running and grey when done", () => {
    assert.equal(taskTone("attention"), "pend");
    assert.equal(taskTone("failed"), "hold");
    assert.equal(taskTone("interrupted"), "hold");
    assert.equal(taskTone("running"), "go");
    assert.equal(taskTone("pending"), "go");
    assert.equal(taskTone("completed"), "idle");
    assert.equal(taskTone("cancelled"), "idle");
  });
});

describe("pipTone", () => {
  it("turns red only for a failure, yellow for needs you, cyan while something runs and grey otherwise", () => {
    assert.equal(pipTone({ failed: 1, needYou: 3, running: 2 }), "hold");
    assert.equal(pipTone({ failed: 0, needYou: 1, running: 2 }), "pend");
    assert.equal(pipTone({ failed: 0, needYou: 0, running: 2 }), "go");
    assert.equal(pipTone({ failed: 0, needYou: 0, running: 0 }), "idle");
  });
});
