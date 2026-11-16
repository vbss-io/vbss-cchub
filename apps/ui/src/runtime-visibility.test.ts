import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { showNoAgents, visibleRuntimeChips, type RuntimeVisibilityInput } from "./runtime-visibility";
import type { RuntimeSnapshot } from "./types";

const group = (running: boolean, count = running ? 1 : 0) => ({ running, count, pids: [] as number[] });

const snapshot = (extra: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  claudeCode: { ...group(false), headless: 0 },
  claudeDesktop: group(false),
  codexApp: group(false),
  codexCli: group(false),
  scannedAt: 1,
  error: null,
  ...extra,
});

const input = (extra: Partial<RuntimeVisibilityInput> = {}): RuntimeVisibilityInput => ({
  runtimes: snapshot(),
  claudeSessions: 0,
  codexSessions: 0,
  hubRunning: 0,
  hubAttention: 0,
  ...extra,
});

const keys = (value: RuntimeVisibilityInput) => visibleRuntimeChips(value).map((chip) => chip.key);

describe("visibleRuntimeChips", () => {
  it("hides every closed or idle runtime", () => {
    assert.deepEqual(keys(input()), []);
    assert.equal(showNoAgents(input()), true);
  });

  it("shows Claude Code with live sessions even without processes", () => {
    const chips = visibleRuntimeChips(input({ claudeSessions: 2 }));
    assert.deepEqual(chips.map((chip) => chip.key), ["claudeCode"]);
    assert.equal(chips[0]?.detail, "2 live · 0 processes");
    assert.equal(showNoAgents(input({ claudeSessions: 2 })), false);
  });

  it("shows Claude Code when its processes run", () => {
    const chips = visibleRuntimeChips(input({ runtimes: snapshot({ claudeCode: { ...group(true, 1), headless: 0 } }) }));
    assert.equal(chips[0]?.detail, "0 live · 1 process");
  });

  it("shows only the runtimes that are open or active", () => {
    const value = input({
      runtimes: snapshot({ claudeDesktop: group(true), codexApp: group(true), codexCli: group(true, 3) }),
      codexSessions: 4,
      hubRunning: 1,
      hubAttention: 2,
    });
    assert.deepEqual(keys(value), ["claudeDesktop", "codexApp", "codexCli", "delegated"]);
    const chips = visibleRuntimeChips(value);
    assert.equal(chips[1]?.detail, "open · 4 threads");
    assert.equal(chips[2]?.detail, "3 running");
    assert.equal(chips[3]?.detail, "1 running · 2 need you");
  });

  it("shows Delegated when only attention is pending", () => {
    assert.deepEqual(keys(input({ hubAttention: 1 })), ["delegated"]);
  });

  it("never shows the Delegated chip when the Delegated plugin is off", () => {
    const value = input({ hubRunning: 2, hubAttention: 1, delegatedOn: false });
    assert.deepEqual(keys(value), []);
    assert.equal(showNoAgents(value), true);
    assert.deepEqual(keys({ ...value, delegatedOn: true }), ["delegated"]);
  });

  it("keeps a scanning placeholder until the first snapshot arrives", () => {
    const value = input({ runtimes: null });
    assert.deepEqual(keys(value), ["claudeCode"]);
    assert.equal(visibleRuntimeChips(value)[0]?.detail, "scanning…");
    assert.equal(showNoAgents(value), false);
  });
});
