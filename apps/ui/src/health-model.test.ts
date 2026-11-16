import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canRunFix, checkedLine, countByState, fixPlan, healthRows, healthSummary, HEALTH_STATE_LABEL } from "./health-model";
import type { HealthItem, HealthReport } from "./types";

const item = (patch: Partial<HealthItem> = {}): HealthItem => ({ id: "claude-hooks", label: "Claude Code hooks", state: "ok", detail: "Installed", fixAction: null, ...patch });

const report = (items: HealthItem[], state: HealthReport["state"] = "ok"): HealthReport => ({ checkedAt: new Date(2026, 10, 16, 10, 5).getTime(), state, items });

describe("healthRows", () => {
  it("is empty before the report arrives", () => {
    assert.deepEqual(healthRows(null), []);
  });

  it("labels each of the four states", () => {
    const rows = healthRows(report([item({ state: "ok" }), item({ id: "codex-hooks", state: "warn" }), item({ id: "mcp-codex", state: "off" }), item({ id: "share-tunnel", state: "error" })]));
    assert.deepEqual(rows.map((row) => row.stateLabel), ["OK", "Attention", "Off", "Error"]);
    assert.deepEqual(rows.map((row) => row.state), ["ok", "warn", "off", "error"]);
    assert.deepEqual(Object.values(HEALTH_STATE_LABEL), ["OK", "Attention", "Off", "Error"]);
  });

  it("keeps the label and detail from the server", () => {
    const [row] = healthRows(report([item({ detail: "Installed, last event 3 min ago" })]));
    assert.equal(row?.label, "Claude Code hooks");
    assert.equal(row?.detail, "Installed, last event 3 min ago");
  });
});

describe("fixPlan", () => {
  it("has no button when the server offers no fix", () => {
    assert.equal(fixPlan("claude-hooks", null), null);
  });

  it("keeps the route and body of an api fix", () => {
    assert.deepEqual(fixPlan("codex-hooks", { kind: "api", label: "Install hooks", method: "POST", path: "/delegation/connect/codex-hooks", body: { action: "install" } }), {
      kind: "api",
      label: "Install hooks",
      method: "POST",
      path: "/delegation/connect/codex-hooks",
      body: { action: "install" },
    });
  });

  it("uses a null body when the fix has none", () => {
    assert.deepEqual(fixPlan("claude-hooks", { kind: "api", label: "Install hooks", method: "POST", path: "/api/hooks/install" }), {
      kind: "api",
      label: "Install hooks",
      method: "POST",
      path: "/api/hooks/install",
      body: null,
    });
  });

  it("points a generic settings link at the right section", () => {
    assert.deepEqual(fixPlan("history-index", { kind: "navigate", label: "Open Memory settings", hash: "#/settings" }), { kind: "navigate", label: "Open Memory settings", hash: "#/settings/memory" });
    assert.deepEqual(fixPlan("codex-app-server", { kind: "navigate", label: "Open Limits settings", hash: "#/settings" }), { kind: "navigate", label: "Open Limits settings", hash: "#/settings/plugin-limits" });
  });

  it("leaves a specific link alone", () => {
    assert.deepEqual(fixPlan("history-index", { kind: "navigate", label: "Open", hash: "#/settings/connections" }), { kind: "navigate", label: "Open", hash: "#/settings/connections" });
  });
});

describe("healthSummary and counts", () => {
  it("says checking before the report", () => {
    assert.equal(healthSummary(null), "Checking");
  });

  it("counts warnings and errors as needing attention", () => {
    assert.equal(healthSummary(report([item({ state: "warn" }), item({ state: "error" }), item({ state: "ok" })])), "2 need attention");
    assert.equal(healthSummary(report([item({ state: "error" })])), "1 needs attention");
  });

  it("mentions off items when nothing needs attention", () => {
    assert.equal(healthSummary(report([item({ state: "ok" }), item({ state: "off" })])), "Everything that is on works, 1 off");
    assert.equal(healthSummary(report([item({ state: "ok" })])), "Everything works");
  });

  it("counts each state", () => {
    assert.deepEqual(countByState(report([item({ state: "ok" }), item({ state: "ok" }), item({ state: "off" })])), { ok: 2, warn: 0, off: 1, error: 0 });
    assert.deepEqual(countByState(null), { ok: 0, warn: 0, off: 0, error: 0 });
  });
});

describe("checkedLine and canRunFix", () => {
  it("shows when the report was made, in local time", () => {
    assert.equal(checkedLine(report([]), new Date(2026, 10, 16, 12, 0).getTime()), "Checked Today 10:05");
    assert.equal(checkedLine(null, 0), null);
  });

  it("allows a fix only when there is one and nothing else is running", () => {
    const plan = fixPlan("claude-hooks", { kind: "api", label: "Install", method: "POST", path: "/api/hooks/install" });
    assert.equal(canRunFix(plan, null), true);
    assert.equal(canRunFix(plan, "codex-hooks"), false);
    assert.equal(canRunFix(null, null), false);
  });
});
