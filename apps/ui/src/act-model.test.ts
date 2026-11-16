import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backupNote, canOpenCodex, canOpenSession, canReplyToCodex, codexHooksView, isReplyCode, openOutcome, parseWindow, replyBlock, windowHint } from "./act-model";
import type { CodexHooksStatus } from "./types";

const hooks = (over: Partial<CodexHooksStatus> = {}): CodexHooksStatus => ({
  path: "C:/Users/me/.codex/hooks.json",
  exists: true,
  installed: false,
  updateAvailable: false,
  events: [],
  missing: ["PermissionRequest"],
  backupPath: "C:/Users/me/.codex/hooks.json.bak",
  hasBackup: false,
  error: null,
  trustNote: "trust it",
  ...over,
});

describe("parseWindow", () => {
  it("accepts whole seconds from 0 to 1800", () => {
    assert.equal(parseWindow("0"), 0);
    assert.equal(parseWindow(" 300 "), 300);
    assert.equal(parseWindow("1800"), 1800);
  });

  it("rejects out of range, decimals and text", () => {
    assert.equal(parseWindow("1801"), null);
    assert.equal(parseWindow("-1"), null);
    assert.equal(parseWindow("2.5"), null);
    assert.equal(parseWindow("abc"), null);
    assert.equal(parseWindow(""), null);
  });
});

describe("windowHint", () => {
  it("explains zero as observe only", () => {
    assert.match(windowHint(0), /does not wait/);
  });

  it("reads seconds and minutes in plain words", () => {
    assert.equal(windowHint(20), "Waits up to 20 seconds for your answer here.");
    assert.equal(windowHint(300), "Waits up to 5 minutes for your answer here.");
    assert.equal(windowHint(90), "Waits up to 1 minute 30 s for your answer here.");
  });
});

describe("codexHooksView", () => {
  it("is quiet while loading", () => {
    assert.deepEqual(codexHooksView(null), { tag: "checking", tone: "muted", detail: null, canInstall: false, installLabel: "Install hooks", canRemove: false });
  });

  it("offers Install when nothing is there", () => {
    const view = codexHooksView(hooks());
    assert.equal(view.tag, "not installed");
    assert.equal(view.canInstall, true);
    assert.equal(view.installLabel, "Install hooks");
    assert.equal(view.canRemove, false);
  });

  it("offers Update and Remove when the installed hooks differ", () => {
    const view = codexHooksView(hooks({ updateAvailable: true, events: ["Stop"], missing: ["PermissionRequest", "Stop"] }));
    assert.equal(view.tag, "update available");
    assert.equal(view.installLabel, "Update hooks");
    assert.equal(view.canInstall, true);
    assert.equal(view.canRemove, true);
    assert.equal(view.detail, "outdated PermissionRequest, Stop");
  });

  it("offers only Remove when current", () => {
    const view = codexHooksView(hooks({ installed: true, missing: [], events: ["a", "b", "c"] }));
    assert.equal(view.tag, "installed");
    assert.equal(view.canInstall, false);
    assert.equal(view.canRemove, true);
    assert.equal(view.detail, "3 events");
  });

  it("blocks both actions when the file cannot be read and shows why", () => {
    const view = codexHooksView(hooks({ error: "not valid JSON (left untouched)" }));
    assert.equal(view.tone, "hold");
    assert.equal(view.canInstall, false);
    assert.equal(view.canRemove, false);
    assert.equal(view.detail, "not valid JSON (left untouched)");
  });
});

describe("backupNote", () => {
  it("only speaks when a backup exists", () => {
    assert.equal(backupNote(hooks()), null);
    assert.equal(backupNote(null), null);
    assert.match(backupNote(hooks({ hasBackup: true })) ?? "", /hooks\.json\.bak/);
  });
});

describe("openOutcome", () => {
  it("tells a deep link apart from a window focus", () => {
    assert.deepEqual(openOutcome({ ok: true, method: "deep-link" }), { kind: "opened", text: "Opened in the app." });
    assert.deepEqual(openOutcome({ ok: true, method: "focus" }), { kind: "opened", text: "Brought the window to the front." });
  });

  it("turns known reasons into plain words", () => {
    assert.equal(openOutcome({ ok: false, method: "focus", reason: "the Codex app is not running" }).text, "The Codex app is not running. Open it, then try again.");
    assert.equal(openOutcome({ ok: false, method: "deep-link", reason: "the link could not be opened" }).kind, "failed");
  });

  it("keeps an unknown reason visible and handles none", () => {
    assert.equal(openOutcome({ ok: false, method: "focus", reason: "window gone" }).text, "Could not open the session: window gone.");
    assert.equal(openOutcome({ ok: false, method: "focus" }).text, "Could not open the session.");
  });
});

describe("replyBlock", () => {
  it("explains each server reason and offers Open session where it helps", () => {
    assert.equal(isReplyCode("open-elsewhere"), true);
    assert.equal(isReplyCode("nope"), false);
    assert.equal(replyBlock("not-hub-thread", "").offerOpen, true);
    assert.equal(replyBlock("not-current-thread", "").offerOpen, true);
    assert.equal(replyBlock("open-elsewhere", "").offerOpen, true);
    assert.match(replyBlock("open-elsewhere", "").text, /Codex app or CLI/);
    assert.equal(replyBlock("busy", "").offerOpen, false);
    assert.match(replyBlock("busy", "").text, /still working/);
  });

  it("falls back to the server message for an unknown failure", () => {
    assert.deepEqual(replyBlock(null, "working directory no longer exists"), { text: "working directory no longer exists", offerOpen: false });
    assert.deepEqual(replyBlock(null, ""), { text: "The reply was not sent.", offerOpen: false });
  });
});

describe("what can be opened or replied to", () => {
  it("replies only to hub threads that are not archived", () => {
    assert.equal(canReplyToCodex({ origin: "hub", hubTaskId: "t1", archivedAt: null }), true);
    assert.equal(canReplyToCodex({ origin: null, hubTaskId: null, archivedAt: null }), false);
    assert.equal(canReplyToCodex({ origin: "hub", hubTaskId: null, archivedAt: null }), false);
    assert.equal(canReplyToCodex({ origin: "hub", hubTaskId: "t1", archivedAt: 5 }), false);
  });

  it("opens live, unarchived sessions", () => {
    assert.equal(canOpenSession({ status: "waiting", archivedAt: null }), true);
    assert.equal(canOpenSession({ status: "ended", archivedAt: null }), false);
    assert.equal(canOpenSession({ status: "idle", archivedAt: null, stale: true }), false);
    assert.equal(canOpenSession({ status: "idle", archivedAt: 3 }), false);
    assert.equal(canOpenCodex({ status: "waiting", archivedAt: null }), true);
    assert.equal(canOpenCodex({ status: "ended", archivedAt: null }), false);
  });
});
