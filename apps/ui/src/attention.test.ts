import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attentionCount, needsYou } from "./attention";
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
});
