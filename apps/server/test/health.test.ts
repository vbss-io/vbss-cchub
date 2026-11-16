import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { HealthInputs, HealthItem, HealthState } from "../src/health.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-health-"));
process.env.HUB_DATA_DIR = dataDir;

type Health = typeof import("../src/health.js");
let health: Health;

before(async () => {
  health = await import("../src/health.js");
});

after(async () => {
  (await import("../src/db.js")).db.close();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    void 0;
  }
});

const NOW = 1_900_000_000_000;

function allOk(): HealthInputs {
  return {
    now: NOW,
    claudeHooks: { installed: true, outdated: false, error: null },
    claudeLastEventAt: NOW - 5 * 60_000,
    codexHooks: { installed: true, updateAvailable: false, error: null, missing: [] },
    codexLastEventAt: null,
    mcpClaude: { installed: true, updateAvailable: false, error: null },
    mcpCodex: { installed: true, updateAvailable: false, error: null },
    statusline: { state: "installed", error: null },
    codexLive: { enabled: true, pid: 4242, source: "live", error: null },
    share: { enabled: true, tunnel: { state: "running", error: null, endpointError: null, publicUrl: "https://x.ngrok.app", installed: true } },
    history: { enabled: true, running: false, progress: null, sessions: 12, files: 12, lastBuildAt: NOW - 1000, lastError: null },
  };
}

const item = (input: HealthInputs, id: string): HealthItem => {
  const found = health.buildHealth(input).items.find((entry) => entry.id === id);
  assert.ok(found, id);
  return found;
};

const stateOf = (input: HealthInputs, id: string): HealthState => item(input, id).state;

describe("health panel", () => {
  it("lists every integration and is ok when all are fine", () => {
    const report = health.buildHealth(allOk());
    assert.deepEqual(report.items.map((entry) => entry.id), ["claude-hooks", "codex-hooks", "mcp-claude-code", "mcp-codex", "claude-statusline", "codex-app-server", "share-tunnel", "history-index"]);
    assert.equal(report.state, "ok");
    assert.ok(report.items.every((entry) => entry.state === "ok" && entry.fixAction === null));
    assert.match(item(allOk(), "claude-hooks").detail, /last event 5 min ago/);
    assert.match(item(allOk(), "codex-hooks").detail, /no event received yet/);
  });

  it("maps the Claude hooks to ok, warn, off and error with the install button", () => {
    const base = allOk();
    const outdated = { ...base, claudeHooks: { installed: false, outdated: true, error: null } };
    assert.equal(stateOf(outdated, "claude-hooks"), "warn");
    assert.deepEqual(item(outdated, "claude-hooks").fixAction, { kind: "api", label: "Update hooks", method: "POST", path: "/api/hooks/install" });
    assert.equal(stateOf({ ...base, claudeHooks: { installed: false, outdated: false, error: null } }, "claude-hooks"), "off");
    assert.equal(stateOf({ ...base, claudeHooks: { installed: false, outdated: false, error: "boom" } }, "claude-hooks"), "error");
  });

  it("maps the Codex hooks and both MCP registrations", () => {
    const base = allOk();
    const codexWarn = { ...base, codexHooks: { installed: false, updateAvailable: true, error: null, missing: ["Stop"] } };
    assert.equal(stateOf(codexWarn, "codex-hooks"), "warn");
    assert.deepEqual(item(codexWarn, "codex-hooks").fixAction, { kind: "api", label: "Update hooks", method: "POST", path: "/delegation/connect/codex-hooks", body: { action: "install" } });
    assert.equal(stateOf({ ...base, codexHooks: { installed: false, updateAvailable: false, error: null, missing: [] } }, "codex-hooks"), "off");
    assert.equal(stateOf({ ...base, codexHooks: { installed: false, updateAvailable: false, error: "bad json", missing: [] } }, "codex-hooks"), "error");
    const mcpOff = { ...base, mcpCodex: { installed: false, updateAvailable: false, error: null } };
    assert.equal(stateOf(mcpOff, "mcp-codex"), "off");
    assert.deepEqual(item(mcpOff, "mcp-codex").fixAction, { kind: "api", label: "Register", method: "POST", path: "/delegation/connect/mcp", body: { client: "codex", action: "install" } });
    assert.equal(stateOf({ ...base, mcpClaude: { installed: true, updateAvailable: true, error: null } }, "mcp-claude-code"), "warn");
    assert.equal(stateOf({ ...base, mcpClaude: { installed: false, updateAvailable: false, error: "not JSON" } }, "mcp-claude-code"), "error");
  });

  it("maps the statusline and the Codex app-server", () => {
    const base = allOk();
    assert.equal(stateOf({ ...base, statusline: { state: "outdated", error: null } }, "claude-statusline"), "warn");
    assert.equal(stateOf({ ...base, statusline: { state: "not-installed", error: null } }, "claude-statusline"), "off");
    assert.equal(item({ ...base, statusline: { state: "not-installed", error: null } }, "claude-statusline").fixAction?.kind, "api");
    assert.equal(stateOf({ ...base, statusline: { state: "not-installed", error: "bad settings" } }, "claude-statusline"), "error");
    assert.equal(stateOf({ ...base, codexLive: { enabled: false, pid: null, source: null, error: null } }, "codex-app-server"), "off");
    assert.equal(stateOf({ ...base, codexLive: { enabled: true, pid: 1, source: "rollout", error: "codex live limits unavailable" } }, "codex-app-server"), "warn");
    assert.equal(stateOf({ ...base, codexLive: { enabled: true, pid: null, source: "rollout", error: "codex live limits unavailable" } }, "codex-app-server"), "error");
  });

  it("maps the Share tunnel and the history index", () => {
    const base = allOk();
    const tunnel = base.share.tunnel;
    assert.equal(stateOf({ ...base, share: { enabled: false, tunnel } }, "share-tunnel"), "off");
    assert.equal(stateOf({ ...base, share: { enabled: true, tunnel: { ...tunnel, state: "stopped" } } }, "share-tunnel"), "off");
    assert.deepEqual(item({ ...base, share: { enabled: true, tunnel: { ...tunnel, state: "stopped" } } }, "share-tunnel").fixAction, { kind: "api", label: "Start tunnel", method: "POST", path: "/delegation/tunnel/start" });
    assert.equal(item({ ...base, share: { enabled: true, tunnel: { ...tunnel, state: "stopped", installed: false } } }, "share-tunnel").fixAction?.label, "Install ngrok");
    assert.equal(stateOf({ ...base, share: { enabled: true, tunnel: { ...tunnel, state: "starting" } } }, "share-tunnel"), "warn");
    assert.equal(stateOf({ ...base, share: { enabled: true, tunnel: { ...tunnel, state: "error", error: "authtoken" } } }, "share-tunnel"), "error");
    assert.equal(stateOf({ ...base, share: { enabled: true, tunnel: { ...tunnel, endpointError: "EADDRINUSE" } } }, "share-tunnel"), "error");
    const history = base.history;
    assert.equal(stateOf({ ...base, history: { ...history, enabled: false } }, "history-index"), "off");
    assert.equal(stateOf({ ...base, history: { ...history, lastBuildAt: null, files: 0 } }, "history-index"), "warn");
    assert.equal(stateOf({ ...base, history: { ...history, lastError: "disk full" } }, "history-index"), "error");
    assert.match(item({ ...base, history: { ...history, running: true, progress: { done: 3, total: 9 } } }, "history-index").detail, /3\/9/);
  });

  it("rolls the items up to the worst state", () => {
    const base = allOk();
    assert.equal(health.buildHealth({ ...base, statusline: { state: "not-installed", error: null } }).state, "off");
    assert.equal(health.buildHealth({ ...base, statusline: { state: "outdated", error: null }, codexHooks: { installed: false, updateAvailable: false, error: null, missing: [] } }).state, "warn");
    assert.equal(health.buildHealth({ ...base, history: { ...base.history, lastError: "x" } }).state, "error");
  });
});
