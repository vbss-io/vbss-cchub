import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNotification, NOTIF_EVENT_META, type NotifEventKind, type NotifEventPayload } from "./notifications";
import {
  sessionToastContext,
  taskToastContext,
  TOAST_ATTENTION_MS,
  TOAST_AUTO_MS,
  TOAST_LOOK,
  toastLifetime,
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
  it("keeps Needs you and Failed on screen for 10 s and the rest for 6 s", () => {
    assert.equal(TOAST_AUTO_MS, 6_000);
    assert.equal(TOAST_ATTENTION_MS, 10_000);
    const long = ALL_KINDS.filter((kind) => toastLifetime(kind) === TOAST_ATTENTION_MS);
    assert.deepEqual(long, ["sessionNeedsYou", "taskFailed", "taskNeedsYou"]);
    for (const kind of ALL_KINDS.filter((item) => !long.includes(item))) assert.equal(toastLifetime(kind), TOAST_AUTO_MS);
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
