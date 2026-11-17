import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, describe, it } from "node:test";
import { s2Sandbox } from "./helpers/s2-env.js";

const box = s2Sandbox("cch-s2-health-", { HUB_DELEGATION: "1" });

const { db } = await import("../src/db.js");
const { config } = await import("../src/config.js");
const health = await import("../src/health.js");

after(() => {
  if (db.open) db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

type Inputs = import("../src/health.js").HealthInputs;

const NOW = 1_800_000_000_000;

function inputs(over: Partial<Inputs> = {}): Inputs {
  return {
    now: NOW,
    claudeHooks: { installed: true, outdated: false, error: null },
    claudeLastEventAt: NOW - 10_000,
    codexHooks: { installed: true, updateAvailable: false, error: null, missing: [] },
    codexLastEventAt: NOW - 5 * 60_000,
    mcpClaude: { installed: true, updateAvailable: false, error: null },
    mcpCodex: { installed: true, updateAvailable: false, error: null },
    statusline: { state: "installed", error: null },
    codexLive: { enabled: true, pid: 42, source: "live", error: null },
    share: { enabled: true, tunnel: { state: "running", error: null, endpointError: null, publicUrl: "https://x.example", installed: true } },
    history: { enabled: true, running: false, progress: null, sessions: 12, files: 3, lastBuildAt: NOW - 1000, lastError: null },
    ...over,
  };
}

const itemOf = (report: ReturnType<typeof health.buildHealth>, id: string) => report.items.find((item) => item.id === id);

describe("health items", () => {
  it("reports a healthy machine as ok with no fixes", () => {
    const report = health.buildHealth(inputs());
    assert.equal(report.state, "ok");
    assert.equal(report.checkedAt, NOW);
    assert.ok(report.items.every((item) => item.state === "ok" && item.fixAction === null));
    assert.equal(itemOf(report, "claude-hooks")?.detail, "Installed, last event just now");
  });

  it("describes how long ago the last event arrived", () => {
    assert.equal(health.ago(null, NOW), "no event received yet");
    assert.equal(health.ago(NOW - 10_000, NOW), "last event just now");
    assert.equal(health.ago(NOW - 5 * 60_000, NOW), "last event 5 min ago");
    assert.equal(health.ago(NOW - 3 * 3_600_000, NOW), "last event 3 h ago");
    assert.equal(health.ago(NOW - 72 * 3_600_000, NOW), "last event 3 days ago");
    assert.equal(health.ago(NOW + 60_000, NOW), "last event just now");
  });

  it("offers the right fix for every state of the Claude and Codex hooks", () => {
    const claude = (over: Partial<Inputs["claudeHooks"]>) => itemOf(health.buildHealth(inputs({ claudeHooks: { installed: false, outdated: false, error: null, ...over } })), "claude-hooks");
    assert.deepEqual([claude({ error: "boom" })?.state, claude({ error: "boom" })?.fixAction?.label], ["error", "Install hooks"]);
    assert.deepEqual([claude({ installed: true, outdated: true })?.state, claude({ installed: true, outdated: true })?.fixAction?.label], ["warn", "Update hooks"]);
    assert.deepEqual([claude({})?.state, claude({})?.detail], ["off", "Not installed"]);
    const codex = (over: Partial<Inputs["codexHooks"]>) => itemOf(health.buildHealth(inputs({ codexHooks: { installed: false, updateAvailable: false, error: null, missing: [], ...over } })), "codex-hooks");
    assert.equal(codex({ error: "bad file" })?.state, "error");
    assert.equal(codex({ error: "bad file" })?.fixAction?.label, "Install hooks");
    assert.equal(codex({ updateAvailable: true, missing: ["Stop", "SessionEnd"] })?.detail, "Update available (missing Stop, SessionEnd)");
    assert.equal(codex({ updateAvailable: true, missing: ["Stop"] })?.fixAction?.label, "Update hooks");
    assert.equal(codex({})?.state, "off");
    assert.deepEqual(codex({})?.fixAction, { kind: "api", label: "Install hooks", method: "POST", path: "/delegation/connect/codex-hooks", body: { action: "install" } });
  });

  it("offers the right fix for every state of the MCP registrations and the statusline", () => {
    const mcp = (over: Partial<Inputs["mcpClaude"]>) => itemOf(health.buildHealth(inputs({ mcpClaude: { installed: false, updateAvailable: false, error: null, ...over } })), "mcp-claude-code");
    assert.equal(mcp({ error: "not valid JSON" })?.state, "error");
    assert.equal(mcp({ installed: true, updateAvailable: true })?.fixAction?.label, "Update registration");
    assert.equal(mcp({ installed: true })?.detail, "Registered");
    assert.deepEqual(mcp({})?.fixAction, { kind: "api", label: "Register", method: "POST", path: "/delegation/connect/mcp", body: { client: "claude-code", action: "install" } });
    const statusline = (over: Partial<Inputs["statusline"]>) => itemOf(health.buildHealth(inputs({ statusline: { state: "not-installed", error: null, ...over } as Inputs["statusline"] })), "claude-statusline");
    assert.equal(statusline({ error: "settings unreadable" })?.state, "error");
    assert.equal(statusline({ state: "installed" })?.state, "ok");
    assert.equal(statusline({ state: "outdated" })?.fixAction?.label, "Update statusline");
    assert.equal(statusline({})?.fixAction?.label, "Install statusline");
  });

  it("explains the live Codex limits", () => {
    const live = (over: Partial<Inputs["codexLive"]>) => itemOf(health.buildHealth(inputs({ codexLive: { enabled: true, pid: null, source: null, error: null, ...over } })), "codex-app-server");
    assert.equal(live({ enabled: false })?.fixAction?.kind, "navigate");
    assert.equal(live({ pid: 7, source: "live" })?.detail, "Running (pid 7)");
    assert.equal(live({ pid: 7, source: "cache", error: null })?.detail, "Running, no live reading yet");
    assert.equal(live({ pid: 7, source: "live", error: "slow" })?.detail, "slow");
    assert.equal(live({})?.detail, "Not running");
    assert.equal(live({ error: "spawn failed" })?.detail, "spawn failed");
    assert.equal(live({})?.state, "error");
  });

  it("explains the share tunnel", () => {
    const tunnel = (state: string, over: Record<string, unknown> = {}) => ({ state, error: null, endpointError: null, publicUrl: null, installed: true, ...over }) as Inputs["share"]["tunnel"];
    const share = (enabled: boolean, t: Inputs["share"]["tunnel"]) => itemOf(health.buildHealth(inputs({ share: { enabled, tunnel: t } })), "share-tunnel");
    assert.equal(share(false, tunnel("running"))?.detail, "The Share plugin is off");
    assert.match(share(true, tunnel("running", { endpointError: "port busy" }))?.detail ?? "", /could not listen: port busy/);
    assert.equal(share(true, tunnel("running"))?.detail, "Running");
    assert.equal(share(true, tunnel("running", { publicUrl: "https://a.example" }))?.detail, "Running at https://a.example");
    assert.equal(share(true, tunnel("error"))?.detail, "The tunnel failed");
    assert.equal(share(true, tunnel("error", { error: "no token", installed: false }))?.fixAction?.label, "Install ngrok");
    assert.equal(share(true, tunnel("error", { error: "no token" }))?.fixAction?.label, "Start tunnel");
    assert.equal(share(true, tunnel("starting"))?.detail, "Starting");
    assert.equal(share(true, tunnel("installing"))?.detail, "Installing ngrok");
    assert.equal(share(true, tunnel("stopped"))?.detail, "Stopped");
  });

  it("explains the history index", () => {
    const history = (over: Partial<Inputs["history"]>) => itemOf(health.buildHealth(inputs({ history: { enabled: true, running: false, progress: null, sessions: 0, files: 0, lastBuildAt: null, lastError: null, ...over } })), "history-index");
    assert.equal(history({ enabled: false })?.fixAction?.kind, "navigate");
    assert.equal(history({ lastError: "corrupt" })?.fixAction?.label, "Rebuild index");
    assert.equal(history({ running: true })?.detail, "Indexing");
    assert.equal(history({ running: true, progress: { done: 3, total: 9 } })?.detail, "Indexing (3/9 files)");
    assert.equal(history({})?.detail, "Not built yet");
    assert.equal(history({ files: 4, sessions: 2 })?.detail, "2 sessions indexed");
    assert.equal(history({ lastBuildAt: 5, sessions: 1 })?.detail, "1 sessions indexed");
  });

  it("takes the worst state of the items", () => {
    const worst = (states: ("ok" | "off" | "warn" | "error")[]) => health.worstState(states.map((state, index) => ({ id: String(index), label: "x", state, detail: "", fixAction: null })));
    assert.equal(worst([]), "ok");
    assert.equal(worst(["ok", "off"]), "off");
    assert.equal(worst(["off", "warn", "ok"]), "warn");
    assert.equal(worst(["warn", "error", "off"]), "error");
    assert.equal(worst(["error", "warn"]), "error");
  });
});

describe("collecting the facts", () => {
  it("reads the live state of this machine into a report", async () => {
    const report = await health.healthReport();
    assert.equal(report.items.length, 8);
    assert.ok(["ok", "off", "warn", "error"].includes(report.state));
  });

  it("falls back to an error entry when a status source cannot be read", async () => {
    const keys = ["codexHome", "codexConfigPath", "claudeConfigPath", "resourceDir"] as const;
    const originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(config, key) as PropertyDescriptor]));
    const originalNode = Object.getOwnPropertyDescriptor(config, "nodeBin") as PropertyDescriptor;
    for (const key of [...keys, "nodeBin"] as const) {
      Object.defineProperty(config, key, {
        configurable: true,
        get() {
          throw new Error(`${key} unreadable`);
        },
      });
    }
    try {
      const facts = await health.collectHealthInputs(NOW);
      assert.match(facts.codexHooks.error ?? "", /unreadable/);
      assert.deepEqual(facts.codexHooks.missing, []);
      assert.match(facts.mcpClaude.error ?? "", /unreadable/);
      assert.match(facts.mcpCodex.error ?? "", /unreadable/);
      assert.match(facts.statusline.error ?? "", /unreadable/);
      assert.equal(facts.statusline.state, "not-installed");
      assert.match(facts.claudeHooks.error ?? "", /unreadable/);
      const report = health.buildHealth(facts);
      assert.equal(report.state, "error");
    } finally {
      for (const [key, descriptor] of originals) Object.defineProperty(config, key, descriptor);
      Object.defineProperty(config, "nodeBin", originalNode);
    }
  });
});
