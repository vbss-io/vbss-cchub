import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { HubFeatures } from "../delegation";
import { disabledTarget } from "./nav-guard";

const allOn: Required<HubFeatures> = { daily: true, trail: true, usage: true, limits: true, tasks: true, flow: true, delegated: true, workspaces: true, reports: true, share: true, widget: true };

describe("disabledTarget", () => {
  it("names the plugin behind a view that is off", () => {
    assert.equal(disabledTarget("tasks", { ...allOn, delegated: false }), "Delegated");
    assert.equal(disabledTarget("daily", { ...allOn, daily: false }), "Today");
    assert.equal(disabledTarget("board", { ...allOn, tasks: false }), "Tasks");
  });

  it("returns null for views that are on, core or settings", () => {
    assert.equal(disabledTarget("tasks", allOn), null);
    assert.equal(disabledTarget("sessions", { ...allOn, delegated: false }), null);
    assert.equal(disabledTarget("settings", { ...allOn, delegated: false }), null);
  });

  it("returns null for unknown routes", () => {
    assert.equal(disabledTarget("nope", allOn), null);
    assert.equal(disabledTarget("", allOn), null);
  });

  it("counts a flag missing from an older hub as on for plugin flags", () => {
    assert.equal(disabledTarget("tasks", { daily: true }), null);
    assert.equal(disabledTarget("daily", {}), "Today");
  });
});
