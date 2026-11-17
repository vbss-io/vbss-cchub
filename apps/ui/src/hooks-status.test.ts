import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { HOOK_EVENTS_HINT, hooksView } from "./hooks-status";

describe("hooks status view", () => {
  it("shows checking until the status arrives", () => {
    assert.deepEqual(hooksView(null), { tag: "checking", tone: "muted", action: "Install hooks", detail: null });
  });

  it("offers an update when an older install misses hub events", () => {
    const view = hooksView({ installed: false, outdated: true, missing: ["StopFailure", "SessionEnd"], events: ["Stop"] });
    assert.equal(view.tag, "update available");
    assert.equal(view.tone, "warn");
    assert.equal(view.action, "Update hooks");
    assert.equal(view.detail, "missing StopFailure, SessionEnd");
  });

  it("describes the events the hub registers, permission requests included", () => {
    assert.match(HOOK_EVENTS_HINT, /permission requests/);
    assert.match(HOOK_EVENTS_HINT, /tool results/);
    assert.match(HOOK_EVENTS_HINT, /failed stops/);
  });

  it("reads installed and not installed as before", () => {
    assert.deepEqual(hooksView({ installed: true, events: ["Stop", "Notification"] }), { tag: "installed", tone: "go", action: "Remove hooks", detail: "2 events" });
    assert.deepEqual(hooksView({ installed: false, events: [] }), { tag: "not installed", tone: "muted", action: "Install hooks", detail: null });
  });
});
