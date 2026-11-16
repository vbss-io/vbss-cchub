import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDesktopNotifier, DESKTOP_APP_ID, nativeReasonGone, nativeTag, parseNativeSubject } from "../src/desktop-notify.js";

describe("desktop notifier", () => {
  it("shows a toast through the Windows script with the app id, title and body", async () => {
    const calls: string[][] = [];
    const notifier = createDesktopNotifier(async (args) => {
      calls.push(args);
      return "ok";
    }, "win32");
    const result = await notifier.show("Delegated task finished", "Refactor the executor");
    assert.deepEqual(result, { ok: true, via: "windows-toast", reason: null });
    assert.equal(calls.length, 1);
    const args = calls[0] ?? [];
    assert.ok(args[1]?.endsWith("toast.ps1"));
    assert.equal(args[args.indexOf("-AppId") + 1], DESKTOP_APP_ID);
    assert.equal(args[args.indexOf("-Title") + 1], "Delegated task finished");
    assert.equal(args[args.indexOf("-Body") + 1], "Refactor the executor");
  });

  it("clips long text and reports a failing script", async () => {
    const notifier = createDesktopNotifier(async (args) => {
      if ((args[args.indexOf("-Body") + 1] ?? "").length > 400) throw new Error("too long");
      throw new Error("toast blew up");
    }, "win32");
    const result = await notifier.show("t", "x".repeat(2_000));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "toast blew up");
  });

  it("reads the Windows switches and caches them", async () => {
    let reads = 0;
    const notifier = createDesktopNotifier(async () => {
      reads += 1;
      return JSON.stringify({ toastsEnabled: false, appEnabled: null, registered: true });
    }, "win32");
    const first = await notifier.status();
    const second = await notifier.status();
    assert.equal(first.toastsEnabled, false);
    assert.equal(first.registered, true);
    assert.equal(second, first);
    assert.equal(reads, 1);
    const forced = await notifier.status(true);
    assert.equal(reads, 2);
    assert.equal(forced.supported, true);
  });

  it("is unsupported off Windows", async () => {
    const notifier = createDesktopNotifier(async () => "", "linux");
    assert.equal((await notifier.status()).supported, false);
    assert.equal((await notifier.show("a", "b")).ok, false);
  });
});

describe("native toast tags", () => {
  const recorder = () => {
    const calls: string[][] = [];
    const notifier = createDesktopNotifier(async (args) => {
      calls.push(args);
      return "ok";
    }, "win32");
    return { calls, notifier };
  };
  const arg = (args: string[] | undefined, name: string): string | undefined => (args ? args[args.indexOf(name) + 1] : undefined);

  it("tags a needs-you toast by subject and passes text only as separate arguments", async () => {
    const { calls, notifier } = recorder();
    await notifier.show("Session needs you · x", "rm -rf $(whoami); \"quoted\"", { kind: "sessionNeedsYou", id: "0f0e-session-1" });
    const args = calls[0];
    assert.equal(arg(args, "-Tag"), "0f0e-session-1");
    assert.equal(arg(args, "-Group"), "sessionNeedsYou");
    assert.equal(arg(args, "-Body"), "rm -rf $(whoami); \"quoted\"");
    assert.ok(!args?.includes("-Remove"));
    await notifier.show("Turn finished", "done");
    assert.ok(!calls[1]?.includes("-Tag"));
    assert.deepEqual(notifier.tracked(), [{ kind: "sessionNeedsYou", id: "0f0e-session-1" }]);
  });

  it("hashes a subject id that is too long or unsafe for a Windows tag", () => {
    assert.equal(nativeTag({ kind: "taskFailed", id: "task-1" }).tag, "task-1");
    assert.match(nativeTag({ kind: "taskFailed", id: "x".repeat(65) }).tag, /^[0-9a-f]{40}$/);
    assert.match(nativeTag({ kind: "taskFailed", id: "a b" }).tag, /^[0-9a-f]{40}$/);
  });

  it("removes a session toast from the Notification Center once the session stops waiting or is removed", async () => {
    const { calls, notifier } = recorder();
    await notifier.show("t", "b", { kind: "sessionNeedsYou", id: "s1" });
    await notifier.show("t", "b", { kind: "sessionNeedsYou", id: "s2" });
    assert.equal(await notifier.observe("session", { sessionId: "s1", status: "waiting" }, () => null), 0);
    assert.equal(await notifier.observe("session", { sessionId: "s1", status: "active" }, () => null), 1);
    const removal = calls[2];
    assert.ok(removal?.[1]?.endsWith("toast.ps1"));
    assert.ok(removal?.includes("-Remove"));
    assert.equal(arg(removal, "-AppId"), DESKTOP_APP_ID);
    assert.equal(arg(removal, "-Tag"), "s1");
    assert.equal(arg(removal, "-Group"), "sessionNeedsYou");
    assert.equal(await notifier.observe("session", { sessionId: "s1", status: "idle" }, () => null), 0);
    assert.equal(await notifier.observe("removed", { sessionId: "s2" }, () => null), 1);
    assert.equal(calls.length, 4);
    assert.deepEqual(notifier.tracked(), []);
  });

  it("removes a task toast once the task left attention or failed, or was archived, and only looks up tracked tasks", async () => {
    const { calls, notifier } = recorder();
    const looked: string[] = [];
    const tasks: Record<string, { status: string; archivedAt: number | null }> = { t1: { status: "attention", archivedAt: null }, t2: { status: "failed", archivedAt: null } };
    const lookup = (id: string) => {
      looked.push(id);
      return tasks[id] ?? null;
    };
    await notifier.show("t", "b", { kind: "taskNeedsYou", id: "t1" });
    await notifier.show("t", "b", { kind: "taskFailed", id: "t2" });
    assert.equal(await notifier.observe("delegation", { taskId: "other" }, lookup), 0);
    assert.equal(await notifier.observe("delegation", { taskId: "t1" }, lookup), 0);
    tasks.t1 = { status: "running", archivedAt: null };
    assert.equal(await notifier.observe("delegation", { taskId: "t1" }, lookup), 1);
    tasks.t2 = { status: "failed", archivedAt: 5 };
    assert.equal(await notifier.observe("delegation", { taskId: "t2" }, lookup), 1);
    assert.deepEqual(looked, ["t1", "t1", "t2"]);
    assert.deepEqual(calls.slice(2).map((args) => `${arg(args, "-Group")}:${arg(args, "-Tag")}`), ["taskNeedsYou:t1", "taskFailed:t2"]);
  });

  it("spawns nothing while no tagged toast is shown and accepts only known subjects", async () => {
    const { calls, notifier } = recorder();
    assert.equal(await notifier.observe("session", { sessionId: "s1", status: "active" }, () => null), 0);
    assert.equal(calls.length, 0);
    assert.equal(nativeReasonGone({ kind: "sessionNeedsYou", id: "s1" }, { type: "task", id: "s1", status: null, archived: true }), false);
    assert.deepEqual(parseNativeSubject({ kind: "taskFailed", id: "t1" }), { kind: "taskFailed", id: "t1" });
    assert.equal(parseNativeSubject({ kind: "sessionIdle", id: "s1" }), null);
    assert.equal(parseNativeSubject({ kind: "taskFailed", id: "" }), null);
    assert.equal(parseNativeSubject("taskFailed"), null);
  });
});
