import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNotification, NOTIF_EVENT_META, type NotifEventKind, type NotifEventPayload } from "./notifications";
import {
  ageToasts,
  hideBehindApprovals,
  pruneToasts,
  sessionToastContext,
  taskToastContext,
  TOAST_AUTO_MS,
  TOAST_LOOK,
  toastLifetime,
  toastReasonGone,
  upsertToast,
  toastStack,
  toastTarget,
  toastTime,
  toastView,
} from "./toast-model";

const ALL_KINDS: NotifEventKind[] = NOTIF_EVENT_META.map((meta) => meta.kind);
const NOW = 1_800_000_000_000;

const fired = (kind: NotifEventKind, payload: NotifEventPayload) => {
  const built = buildNotification(kind, payload);
  return { kind, id: payload.id, title: built.title, body: built.body, at: NOW };
};

describe("TOAST_LOOK", () => {
  it("maps every event kind to the app colour rule", () => {
    assert.deepEqual(
      Object.fromEntries(ALL_KINDS.map((kind) => [kind, `${TOAST_LOOK[kind].tone}:${TOAST_LOOK[kind].label}`])),
      {
        sessionNeedsYou: "pend:Needs you",
        sessionIdle: "unread:Finished",
        sessionFinished: "muted:Ended",
        taskCompleted: "unread:Finished",
        taskFailed: "hold:Failed",
        taskNeedsYou: "pend:Needs you",
        shareAsk: "go:Answering",
        shareImplement: "go:Implementing",
      },
    );
  });

  it("gives sessions, tasks and shares their own source", () => {
    assert.deepEqual(
      ALL_KINDS.map((kind) => TOAST_LOOK[kind].source),
      ["session", "session", "session", "task", "task", "task", "share", "share"],
    );
  });
});

describe("toastLifetime", () => {
  it("keeps Needs you and Failed until acted on and lets the informative kinds go after 6 s", () => {
    assert.equal(TOAST_AUTO_MS, 6_000);
    const kept = ALL_KINDS.filter((kind) => toastLifetime(kind) === null);
    assert.deepEqual(kept, ["sessionNeedsYou", "taskFailed", "taskNeedsYou"]);
    for (const kind of ALL_KINDS.filter((item) => !kept.includes(item))) assert.equal(toastLifetime(kind), TOAST_AUTO_MS);
  });
});

const timed = (kind: NotifEventKind, id: string, elapsed = 0) => ({ kind, id, lifetime: toastLifetime(kind), elapsed });

describe("ageToasts", () => {
  it("drops every informative kind once its 6 s ran out and never ages the kept kinds", () => {
    const cards = ALL_KINDS.map((kind) => timed(kind, `id-${kind}`));
    const almost = ageToasts(cards, TOAST_AUTO_MS - 1, false);
    assert.equal(almost.length, ALL_KINDS.length);
    const after = ageToasts(almost, 1, false);
    assert.deepEqual(after.map((card) => card.kind), ["sessionNeedsYou", "taskFailed", "taskNeedsYou"]);
    const much = ageToasts(after, 24 * 60 * 60 * 1000, false);
    assert.deepEqual(much.map((card) => card.elapsed), [0, 0, 0]);
  });

  it("pauses while hovered and keeps the same list when nothing changes", () => {
    const cards = [timed("sessionIdle", "a", TOAST_AUTO_MS - 1)];
    assert.equal(ageToasts(cards, 5_000, true), cards);
    const kept = [timed("taskFailed", "t")];
    assert.equal(ageToasts(kept, 5_000, false), kept);
    assert.deepEqual(ageToasts([], 5_000, false), []);
  });
});

describe("toastReasonGone", () => {
  it("drops a session Needs you once the session moved on or disappeared, not while it waits", () => {
    const card = timed("sessionNeedsYou", "s1");
    assert.equal(toastReasonGone(card, { type: "session", id: "s1", status: "waiting" }), false);
    for (const status of ["active", "idle", "ended", null] as const) assert.equal(toastReasonGone(card, { type: "session", id: "s1", status }), true, String(status));
    assert.equal(toastReasonGone(card, { type: "session", id: "other", status: "active" }), false);
  });

  it("drops a task Needs you or Failed once the task left that state or was archived", () => {
    const needs = timed("taskNeedsYou", "t1");
    const failed = timed("taskFailed", "t1");
    assert.equal(toastReasonGone(needs, { type: "task", id: "t1", status: "attention", archived: false }), false);
    assert.equal(toastReasonGone(needs, { type: "task", id: "t1", status: "running", archived: false }), true);
    assert.equal(toastReasonGone(needs, { type: "task", id: "t1", status: "attention", archived: true }), true);
    assert.equal(toastReasonGone(failed, { type: "task", id: "t1", status: "failed", archived: false }), false);
    assert.equal(toastReasonGone(failed, { type: "task", id: "t1", status: "running", archived: false }), true);
    assert.equal(toastReasonGone(failed, { type: "task", id: "t1", status: null, archived: false }), true);
    assert.equal(toastReasonGone(failed, { type: "session", id: "t1", status: null }), false);
  });

  it("leaves the informative kinds to their timer", () => {
    for (const kind of ["sessionIdle", "sessionFinished", "taskCompleted", "shareAsk", "shareImplement"] as const) {
      assert.equal(toastReasonGone(timed(kind, "x"), { type: "session", id: "x", status: null }), false, kind);
      assert.equal(toastReasonGone(timed(kind, "x"), { type: "task", id: "x", status: null, archived: true }), false, kind);
    }
  });

  it("prunes only the cards whose reason ended", () => {
    const cards = [timed("sessionNeedsYou", "s1"), timed("sessionNeedsYou", "s2"), timed("sessionIdle", "s1")];
    assert.deepEqual(pruneToasts(cards, { type: "session", id: "s1", status: "active" }).map((card) => `${card.kind}:${card.id}`), ["sessionNeedsYou:s2", "sessionIdle:s1"]);
    assert.equal(pruneToasts(cards, { type: "session", id: "s2", status: "waiting" }), cards);
  });
});

describe("upsertToast and hideBehindApprovals", () => {
  it("keeps one card per event and subject, the newest", () => {
    const first = { ...timed("sessionNeedsYou", "s1"), key: 1 };
    const other = { ...timed("sessionIdle", "s1"), key: 2 };
    const again = { ...timed("sessionNeedsYou", "s1"), key: 3 };
    assert.deepEqual(upsertToast(upsertToast([first], other), again).map((card) => card.key), [2, 3]);
  });

  it("hides a session Needs you while that session has an approval card", () => {
    const cards = [timed("sessionNeedsYou", "s1"), timed("sessionNeedsYou", "s2"), timed("sessionIdle", "s1")];
    assert.deepEqual(hideBehindApprovals(cards, new Set(["s1"])).map((card) => `${card.kind}:${card.id}`), ["sessionNeedsYou:s2", "sessionIdle:s1"]);
    assert.equal(hideBehindApprovals(cards, new Set()), cards);
  });
});

describe("toastTarget", () => {
  it("focuses sessions and navigates tasks and shares", () => {
    assert.deepEqual(toastTarget("sessionNeedsYou", "s1"), { hash: "#/sessions", focus: true });
    assert.deepEqual(toastTarget("sessionIdle", "s1"), { hash: "#/sessions", focus: true });
    assert.deepEqual(toastTarget("sessionFinished", "s1"), { hash: "#/sessions", focus: true });
    assert.deepEqual(toastTarget("taskCompleted", "t1"), { hash: "#/tasks/t1", focus: false });
    assert.deepEqual(toastTarget("taskFailed", "t1"), { hash: "#/tasks/t1", focus: false });
    assert.deepEqual(toastTarget("taskNeedsYou", "t1"), { hash: "#/tasks/t1", focus: false });
    assert.deepEqual(toastTarget("shareAsk", "r1"), { hash: "#/share/r1", focus: false });
    assert.deepEqual(toastTarget("shareImplement", "r1"), { hash: "#/share/r1", focus: false });
  });
});

describe("toastTime", () => {
  it("reads just now, minutes and hours", () => {
    assert.equal(toastTime(NOW, NOW), "just now");
    assert.equal(toastTime(NOW + 5_000, NOW), "just now");
    assert.equal(toastTime(NOW - 3 * 60_000, NOW), "3m ago");
    assert.equal(toastTime(NOW - 125 * 60_000, NOW), "2h ago");
  });
});

describe("toastStack", () => {
  it("shows the newest four and counts the rest", () => {
    assert.deepEqual(toastStack([1, 2, 3, 4, 5, 6]), { hidden: 2, visible: [3, 4, 5, 6] });
    assert.deepEqual(toastStack([1, 2]), { hidden: 0, visible: [1, 2] });
    assert.deepEqual(toastStack([]), { hidden: 0, visible: [] });
  });
});

describe("toastView", () => {
  it("drops the event prefix from the title because the status label says it", () => {
    const view = toastView(fired("sessionNeedsYou", { id: "s1", name: "Refactor the executor", detail: "Allow Bash: npm test" }), null, NOW);
    assert.equal(view.title, "Refactor the executor");
    assert.equal(view.reason, "Allow Bash: npm test");
    assert.equal(view.tone, "pend");
    assert.equal(view.label, "Needs you");
  });

  it("strips the prefix of every event built by the notifier", () => {
    const titles = ALL_KINDS.map((kind) =>
      toastView(fired(kind, { id: "x", name: "Alpha", title: "Alpha", label: "Alpha", asker: "Rafael", detail: "why" }), null, NOW).title,
    );
    assert.deepEqual(titles, ALL_KINDS.map(() => "Alpha"));
  });

  it("uses the session name of an ended session and shows no reason", () => {
    const view = toastView(fired("sessionFinished", { id: "s1", name: "Finished cleanup" }), null, NOW);
    assert.equal(view.title, "Finished cleanup");
    assert.equal(view.reason, null);
    assert.equal(view.tone, "muted");
  });

  it("keeps the whole title when it does not follow the notifier text", () => {
    const view = toastView({ kind: "taskFailed", id: "t", title: "Custom heading", body: "", at: NOW }, null, NOW);
    assert.equal(view.title, "Custom heading");
    assert.equal(view.reason, null);
  });

  it("keeps the whole title when stripping leaves nothing", () => {
    const view = toastView({ kind: "taskFailed", id: "t", title: "Task failed · ", body: "", at: NOW }, null, NOW);
    assert.equal(view.title, "Task failed ·");
  });

  it("falls back to the source name and time when nothing else is known", () => {
    const session = toastView(fired("sessionIdle", { id: "s", name: "A" }), null, NOW);
    assert.deepEqual(session.parts.map((part) => part.text), ["Session", "just now"]);
    const task = toastView(fired("taskCompleted", { id: "t", title: "A" }), null, NOW);
    assert.deepEqual(task.parts.map((part) => part.text), ["Delegated", "just now"]);
    const share = toastView(fired("shareAsk", { id: "r", label: "docs", asker: "Rafael", detail: "How?" }), null, NOW);
    assert.deepEqual(share.parts.map((part) => part.text), ["Share", "just now"]);
    assert.equal(share.reason, "Rafael: How?");
    assert.deepEqual(share.extras, []);
  });

  it("builds client · where · time with the extras behind +N", () => {
    const view = toastView(
      fired("sessionIdle", { id: "s", name: "A" }),
      { client: "Claude", clientTitle: "Claude Code · terminal", where: "VBSS/vbss-cchub", whereTitle: "C:/VBSS/vbss-cchub", extras: ["2 subagents running"] },
      NOW + 4 * 60_000,
    );
    assert.deepEqual(view.parts, [
      { key: "client", text: "Claude", title: "Claude Code · terminal" },
      { key: "where", text: "VBSS/vbss-cchub", title: "C:/VBSS/vbss-cchub" },
      { key: "time", text: "4m ago", title: "4m ago" },
    ]);
    assert.deepEqual(view.extras, ["2 subagents running"]);
  });

  it("collapses whitespace in the reason so it stays on one line", () => {
    const view = toastView({ kind: "taskFailed", id: "t", title: "Task failed · X", body: "line one\n  line two", at: NOW }, null, NOW);
    assert.equal(view.reason, "line one line two");
  });
});

describe("sessionToastContext", () => {
  it("names the folder and counts running subagents", () => {
    const ctx = sessionToastContext({ cwd: "C:\\Projetos\\VBSS\\vbss-cchub", agentsRunning: 2 }, "Claude", "Claude Code · terminal");
    assert.deepEqual(ctx, {
      client: "Claude",
      clientTitle: "Claude Code · terminal",
      where: "VBSS/vbss-cchub",
      whereTitle: "C:\\Projetos\\VBSS\\vbss-cchub",
      extras: ["2 subagents running"],
    });
  });

  it("leaves the folder out when the session has none", () => {
    const ctx = sessionToastContext({ cwd: null, agentsRunning: 1 }, "Codex", "Codex CLI");
    assert.equal(ctx.where, null);
    assert.deepEqual(ctx.extras, ["1 subagent running"]);
  });
});

describe("taskToastContext", () => {
  it("shows the workspace and keeps the worktree behind +N", () => {
    const ctx = taskToastContext({ workspace: "preview", cwd: "C:/repo", runner: "codex", isolation: "worktree", branch: "hub/fix-toaster" });
    assert.deepEqual(ctx, { client: "Delegated", clientTitle: "Delegated to Codex", where: "preview", whereTitle: "C:/repo", extras: ["worktree · hub/fix-toaster"] });
  });

  it("falls back to the folder and has no extras in the shared checkout", () => {
    const ctx = taskToastContext({ workspace: "", cwd: "C:/a/b/repo", runner: "claude", isolation: "shared", branch: null });
    assert.deepEqual(ctx, { client: "Delegated", clientTitle: "Delegated to Claude", where: "b/repo", whereTitle: "C:/a/b/repo", extras: [] });
  });
});
