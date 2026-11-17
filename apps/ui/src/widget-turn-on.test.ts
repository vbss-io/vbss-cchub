import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { turnOnOptimistically } from "./widget-turn-on";

describe("turnOnOptimistically", () => {
  it("opens the intent before the request settles so an early settings event docks expanded", async () => {
    const calls: string[] = [];
    let release: (value: string) => void = () => undefined;
    const pending = turnOnOptimistically(
      { open: () => calls.push("open"), revert: () => calls.push("revert") },
      () => {
        calls.push("request");
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
    );
    assert.deepEqual(calls, ["open", "request"]);
    release("saved");
    assert.deepEqual(await pending, { ok: true, value: "saved" });
    assert.deepEqual(calls, ["open", "request"]);
  });

  it("reverts the intent and reports the message when the request fails", async () => {
    const calls: string[] = [];
    const result = await turnOnOptimistically(
      { open: () => calls.push("open"), revert: () => calls.push("revert") },
      () => Promise.reject(new Error("offline")),
    );
    assert.deepEqual(result, { ok: false, message: "offline" });
    assert.deepEqual(calls, ["open", "revert"]);
  });

  it("falls back to a generic message for a non-error rejection", async () => {
    const result = await turnOnOptimistically({ open: () => undefined, revert: () => undefined }, () => Promise.reject("nope"));
    assert.deepEqual(result, { ok: false, message: "could not turn the widget on" });
  });
});
