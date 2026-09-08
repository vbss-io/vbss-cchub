import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDesktopNotifier, DESKTOP_APP_ID } from "../src/desktop-notify.js";

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
