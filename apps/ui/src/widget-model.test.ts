import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SessionRecord, SessionStatus } from "./types";
import { panelHoldsOpen, splitSessions } from "./widget-model";

const session = (sessionId: string, status: SessionStatus, updatedAt: number, favoriteAt: number | null = null, unread = false): SessionRecord => ({
  sessionId,
  status,
  cwd: null,
  source: null,
  hostPid: null,
  title: sessionId,
  customTitle: null,
  lastMessage: null,
  model: null,
  tokensIn: null,
  tokensOut: null,
  contextTokens: null,
  archivedAt: null,
  favoriteAt,
  unread,
  startedAt: 0,
  updatedAt,
});

const ids = (list: readonly SessionRecord[]): string[] => list.map((item) => item.sessionId);

describe("splitSessions", () => {
  it("buckets sessions by status", () => {
    const result = splitSessions([session("a", "waiting", 1), session("b", "active", 2), session("c", "idle", 3), session("d", "ended", 4)]);
    assert.deepEqual(ids(result.needsYou), ["a"]);
    assert.deepEqual(ids(result.running), ["b"]);
    assert.deepEqual(ids(result.idle), ["c"]);
  });

  it("puts unread idle sessions in needs you and keeps seen ones in idle", () => {
    const result = splitSessions([
      session("w", "waiting", 5),
      session("u", "idle", 9, null, true),
      session("seen", "idle", 3),
    ]);
    assert.deepEqual(ids(result.needsYou), ["u", "w"]);
    assert.deepEqual(ids(result.idle), ["seen"]);
  });

  it("orders each bucket by most recent update", () => {
    const result = splitSessions([session("old", "idle", 1), session("new", "idle", 9), session("mid", "idle", 5)]);
    assert.deepEqual(ids(result.idle), ["new", "mid", "old"]);
  });

  it("puts favorites first in running and idle", () => {
    const result = splitSessions([
      session("fresh", "active", 9),
      session("fav", "active", 1, 100),
      session("idle-fresh", "idle", 9),
      session("idle-fav", "idle", 1, 100),
    ]);
    assert.deepEqual(ids(result.running), ["fav", "fresh"]);
    assert.deepEqual(ids(result.idle), ["idle-fav", "idle-fresh"]);
  });

  it("returns empty buckets for no sessions and does not mutate the input", () => {
    assert.deepEqual(splitSessions([]), { needsYou: [], running: [], idle: [] });
    const input = [session("a", "idle", 1), session("b", "idle", 2)];
    splitSessions(input);
    assert.deepEqual(ids(input), ["a", "b"]);
  });
});

describe("panelHoldsOpen", () => {
  it("keeps the panel open while a text field has focus or an Other answer is unsent", () => {
    assert.equal(panelHoldsOpen({ focusedText: false, otherDrafts: [] }), false);
    assert.equal(panelHoldsOpen({ focusedText: false, otherDrafts: ["", "   "] }), false);
    assert.equal(panelHoldsOpen({ focusedText: true, otherDrafts: [] }), true);
    assert.equal(panelHoldsOpen({ focusedText: false, otherDrafts: ["", "SQLite"] }), true);
  });
});
