import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  needsDetails,
  APPROVAL_GRACE_MS,
  approvalToastsOn,
  approvalView,
  approvalsOf,
  countdown,
  countdownFraction,
  decisionBody,
  formatSeconds,
  inputText,
  latestPerSession,
  pendingLabel,
  reduceApprovals,
  replaceToastForSession,
  secondsLeft,
  sessionKey,
  toastQueue,
} from "./approvals-model";
import type { PermissionRequestRecord } from "./types";

const NOW = 1_800_000_000_000;

const record = (over: Partial<PermissionRequestRecord> & { id: string }): PermissionRequestRecord => ({
  agent: "claude",
  sessionId: "s1",
  agentId: null,
  toolName: "Bash",
  toolInput: { command: "ls" },
  cwd: "C:/work/api",
  turnId: null,
  title: "Refactor",
  windowMs: 300_000,
  createdAt: NOW,
  expiresAt: NOW + 300_000,
  ...over,
});

describe("reduceApprovals", () => {
  it("adds a request and keeps the list ordered by creation", () => {
    const later = record({ id: "b", createdAt: NOW + 5 });
    const earlier = record({ id: "a", createdAt: NOW });
    const state = reduceApprovals(reduceApprovals([], { type: "request", record: later }), { type: "request", record: earlier });
    assert.deepEqual(state.map((item) => item.id), ["a", "b"]);
  });

  it("does not duplicate a request that arrives twice", () => {
    const first = record({ id: "a" });
    const state = reduceApprovals(reduceApprovals([], { type: "request", record: first }), { type: "request", record: first });
    assert.equal(state.length, 1);
  });

  it("removes the item on permission-resolved and ignores unknown ids", () => {
    const start = [record({ id: "a" }), record({ id: "b", createdAt: NOW + 1 })];
    const after = reduceApprovals(start, { type: "resolved", id: "a" });
    assert.deepEqual(after.map((item) => item.id), ["b"]);
    assert.equal(reduceApprovals(after, { type: "resolved", id: "zzz" }), after);
  });

  it("shows a broadcast summary first and fills tool input and cwd from the guarded fetch", () => {
    const { toolInput: _input, cwd: _cwd, turnId: _turn, ...summary } = record({ id: "a", toolInput: { command: "git push" }, cwd: "C:/work/api", turnId: "t1" });
    const shown = reduceApprovals([], { type: "request", record: summary });
    assert.equal(shown[0]?.toolInput, null);
    assert.equal(shown[0]?.cwd, null);
    assert.equal(shown[0]?.pendingDetails, true);
    assert.equal(needsDetails(shown), true);
    const stale = record({ id: "gone", createdAt: NOW - 5 });
    const filled = reduceApprovals(shown, { type: "details", list: [stale, record({ id: "a", toolInput: { command: "git push" }, cwd: "C:/work/api", turnId: "t1" })] });
    assert.deepEqual(filled.map((item) => item.id), ["a"]);
    assert.deepEqual(filled[0]?.toolInput, { command: "git push" });
    assert.equal(filled[0]?.cwd, "C:/work/api");
    assert.equal(filled[0]?.pendingDetails, undefined);
    assert.equal(needsDetails(filled), false);
    assert.equal(reduceApprovals(filled, { type: "details", list: [stale] }), filled);
    const again = reduceApprovals(filled, { type: "request", record: summary });
    assert.deepEqual(again[0]?.toolInput, { command: "git push" });
    assert.equal(again[0]?.turnId, "t1");
    assert.equal(again[0]?.pendingDetails, undefined);
  });

  it("replaces the list from a fresh fetch", () => {
    const state = reduceApprovals([record({ id: "old" })], { type: "replace", list: [record({ id: "n2", createdAt: NOW + 2 }), record({ id: "n1" })] });
    assert.deepEqual(state.map((item) => item.id), ["n1", "n2"]);
  });

  it("prunes requests whose window ended past the grace period only", () => {
    const start = [record({ id: "gone", expiresAt: NOW }), record({ id: "grace", expiresAt: NOW + APPROVAL_GRACE_MS + 1 }), record({ id: "live", expiresAt: NOW + 60_000 })];
    const after = reduceApprovals(start, { type: "prune", now: NOW + APPROVAL_GRACE_MS });
    assert.deepEqual(after.map((item) => item.id), ["grace", "live"]);
    assert.equal(reduceApprovals(after, { type: "prune", now: NOW + APPROVAL_GRACE_MS }), after);
  });
});

describe("per session selection", () => {
  const list = [
    record({ id: "a", sessionId: "s1", createdAt: NOW }),
    record({ id: "b", sessionId: "s1", createdAt: NOW + 10 }),
    record({ id: "c", sessionId: "s2", createdAt: NOW + 5 }),
    record({ id: "d", agent: "codex", sessionId: "s1", createdAt: NOW + 7 }),
  ];

  it("filters by agent and session", () => {
    assert.deepEqual(approvalsOf(list, "claude", "s1").map((item) => item.id), ["a", "b"]);
    assert.deepEqual(approvalsOf(list, "codex", "s1").map((item) => item.id), ["d"]);
    assert.deepEqual(approvalsOf(list, "codex", "zzz"), []);
  });

  it("keeps one entry per session, the most recent, and separates agents", () => {
    assert.deepEqual(latestPerSession(list).map((item) => item.id), ["c", "d", "b"]);
  });

  it("replaces the older toast of the same session with the newer request", () => {
    const toasts = replaceToastForSession([list[0] as PermissionRequestRecord, list[2] as PermissionRequestRecord], list[1] as PermissionRequestRecord);
    assert.deepEqual(toasts.map((item) => item.id), ["c", "b"]);
  });

  it("never stacks two toasts for one session however many arrive", () => {
    let toasts: PermissionRequestRecord[] = [];
    for (const item of list.filter((entry) => entry.sessionId === "s1" && entry.agent === "claude")) toasts = replaceToastForSession(toasts, item);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0]?.id, "b");
  });

  it("hides a dismissed toast without resurrecting the older request of that session", () => {
    assert.deepEqual(toastQueue(list, new Set(["b"])).map((item) => item.id), ["c", "d"]);
  });

  it("builds a stable session key", () => {
    assert.equal(sessionKey("codex", "abc"), "codex:abc");
  });
});

describe("countdown", () => {
  it("rounds up so the last second still reads 1s", () => {
    assert.equal(secondsLeft(NOW + 1, NOW), 1);
    assert.equal(secondsLeft(NOW + 1_000, NOW), 1);
    assert.equal(secondsLeft(NOW + 1_001, NOW), 2);
    assert.equal(secondsLeft(NOW - 5, NOW), 0);
  });

  it("formats under a minute as seconds and above as m:ss", () => {
    assert.equal(formatSeconds(0), "0s");
    assert.equal(formatSeconds(59), "59s");
    assert.equal(formatSeconds(60), "1:00");
    assert.equal(formatSeconds(272), "4:32");
    assert.equal(formatSeconds(1800), "30:00");
    assert.equal(formatSeconds(65), "1:05");
  });

  it("flags urgency at ten seconds and expiry at zero", () => {
    assert.deepEqual(countdown(NOW + 272_000, NOW), { text: "4:32 left", urgent: false, expired: false });
    assert.deepEqual(countdown(NOW + 10_000, NOW), { text: "10s left", urgent: true, expired: false });
    assert.deepEqual(countdown(NOW, NOW), { text: "expiring", urgent: true, expired: true });
  });

  it("gives the remaining fraction of the window, clamped", () => {
    const item = record({ id: "x", createdAt: NOW, expiresAt: NOW + 100_000 });
    assert.equal(countdownFraction(item, NOW), 1);
    assert.equal(countdownFraction(item, NOW + 25_000), 0.75);
    assert.equal(countdownFraction(item, NOW + 200_000), 0);
    assert.equal(countdownFraction(record({ id: "y", createdAt: NOW, expiresAt: NOW }), NOW), 0);
  });
});

describe("inputText", () => {
  it("shows a shell command as is", () => {
    assert.equal(inputText({ command: "git push origin main", description: "push" }), "git push origin main");
  });

  it("joins a command given as an argument list", () => {
    assert.equal(inputText({ command: ["git", "status"] }), "git status");
  });

  it("pretty prints other inputs in full", () => {
    assert.equal(inputText({ file_path: "a.ts", content: "x" }), JSON.stringify({ file_path: "a.ts", content: "x" }, null, 2));
  });

  it("passes strings through and treats nothing as empty", () => {
    assert.equal(inputText("rm -rf build"), "rm -rf build");
    assert.equal(inputText(null), "");
    assert.equal(inputText(undefined), "");
  });
});

describe("approvalView", () => {
  it("labels the agent, falls back to a short id and flags subagents", () => {
    const view = approvalView(record({ id: "a", title: null, sessionId: "0123456789", agentId: "sub-1", agent: "codex" }));
    assert.equal(view.title, "01234567");
    assert.equal(view.agentLabel, "Codex");
    assert.equal(view.subagent, true);
    assert.equal(view.input, "ls");
  });
});

describe("decisionBody", () => {
  it("sends the trimmed reason only with a deny", () => {
    assert.deepEqual(decisionBody("deny", "  not now  "), { behavior: "deny", message: "not now" });
    assert.deepEqual(decisionBody("deny", "   "), { behavior: "deny" });
    assert.deepEqual(decisionBody("allow", "ignored"), { behavior: "allow" });
  });
});

describe("labels and gates", () => {
  it("pluralises the pending label", () => {
    assert.equal(pendingLabel(1), "1 approval waiting");
    assert.equal(pendingLabel(3), "3 approvals waiting");
  });

  it("shows approval toasts only for the CC Hub window style with needs-you alerts on", () => {
    const base = { enabled: true, desktop: true, style: "cchub" as const, events: {} };
    assert.equal(approvalToastsOn(base), true);
    assert.equal(approvalToastsOn({ ...base, style: "both" }), true);
    assert.equal(approvalToastsOn({ ...base, style: "windows" }), false);
    assert.equal(approvalToastsOn({ ...base, enabled: false }), false);
    assert.equal(approvalToastsOn({ ...base, desktop: false }), false);
    assert.equal(approvalToastsOn({ ...base, events: { sessionNeedsYou: false } }), false);
  });
});
