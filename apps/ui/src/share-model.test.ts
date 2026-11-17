import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { FirewallStatus, ShareState, TunnelStatus } from "./delegation";
import { activitySummary, filterShares, isShareFilter, reachItems, reachMenuEntries, reachProblems, shareCounts, shareMenuEntries, tunnelIsUp } from "./share-model";

const share = (label: string, state: ShareState, workspace = "preview", repo: string | null = null) => ({ label, state, workspace, repo });

const SHARES = [
  share("Will - nexus doubts", "active"),
  share("Ana - billing review", "paused", "storefront"),
  share("Old demo link", "expired", "preview", "api"),
  share("Revoked one", "revoked"),
];

const tunnel = (patch: Partial<TunnelStatus> = {}): TunnelStatus => ({
  state: "stopped",
  publicUrl: null,
  error: null,
  startedAt: null,
  binary: null,
  installed: true,
  authtokenSet: false,
  domain: null,
  lanUrl: "http://192.168.1.4:4318",
  localUrl: "http://127.0.0.1:4318",
  sharePort: 4318,
  endpointError: null,
  notice: null,
  ...patch,
});

const firewall = (patch: Partial<FirewallStatus> = {}): FirewallStatus => ({ supported: true, allowed: true, ruleName: "rule", port: 4318, error: null, ...patch });

describe("shareCounts", () => {
  it("counts each state and the total", () => {
    assert.deepEqual(shareCounts(SHARES), { active: 1, paused: 1, expired: 1, all: 4 });
  });
});

describe("filterShares", () => {
  it("filters by state", () => {
    assert.deepEqual(filterShares(SHARES, "paused", "").map((item) => item.label), ["Ana - billing review"]);
  });

  it("all keeps revoked shares", () => {
    assert.equal(filterShares(SHARES, "all", "").length, 4);
    assert.equal(filterShares(SHARES, "active", "").some((item) => item.state === "revoked"), false);
  });

  it("searches label, workspace and repo case-insensitively", () => {
    assert.deepEqual(filterShares(SHARES, "all", "  STORE ").map((item) => item.label), ["Ana - billing review"]);
    assert.deepEqual(filterShares(SHARES, "all", "api").map((item) => item.label), ["Old demo link"]);
    assert.deepEqual(filterShares(SHARES, "all", "nexus").map((item) => item.label), ["Will - nexus doubts"]);
  });

  it("combines search with the state filter", () => {
    assert.deepEqual(filterShares(SHARES, "active", "preview").map((item) => item.label), ["Will - nexus doubts"]);
    assert.deepEqual(filterShares(SHARES, "paused", "preview"), []);
  });
});

describe("isShareFilter", () => {
  it("accepts the four filters only", () => {
    for (const key of ["active", "paused", "expired", "all"]) assert.equal(isShareFilter(key), true);
    assert.equal(isShareFilter("revoked"), false);
    assert.equal(isShareFilter(null), false);
  });
});

describe("shareMenuEntries", () => {
  const keys = (state: ShareState, revealed = false) => shareMenuEntries(state, revealed).map((entry) => entry.key);

  it("active share offers pause, rotate and revoke", () => {
    assert.deepEqual(keys("active"), ["details", "copy-prompt", "reveal", "pause", "rotate", "revoke"]);
  });

  it("paused share offers resume instead of pause", () => {
    assert.deepEqual(keys("paused"), ["details", "reveal", "resume", "rotate", "revoke"]);
  });

  it("expired and revoked shares can only be deleted and carry no prompt", () => {
    assert.deepEqual(keys("expired"), ["details", "reveal", "delete"]);
    assert.deepEqual(keys("revoked"), ["details", "reveal", "delete"]);
  });

  it("reveal flips to hide", () => {
    assert.deepEqual(keys("active", true).slice(0, 3), ["details", "copy-prompt", "hide"]);
    assert.deepEqual(keys("paused", true).slice(0, 2), ["details", "hide"]);
  });

  it("marks revoke and delete as danger", () => {
    const danger = (state: ShareState) => shareMenuEntries(state, false).filter((entry) => entry.danger).map((entry) => entry.key);
    assert.deepEqual(danger("active"), ["revoke"]);
    assert.deepEqual(danger("expired"), ["delete"]);
  });
});

describe("activitySummary", () => {
  const relative = () => "2h ago";

  it("says so when nothing arrived", () => {
    assert.equal(activitySummary({ uses: 0, lastUsedAt: null, requestsLastHour: 0, maxPerHour: 30 }, relative), "no requests yet");
  });

  it("shows total, last use and the hourly rate only when it is above zero", () => {
    assert.equal(activitySummary({ uses: 1, lastUsedAt: 5, requestsLastHour: 0, maxPerHour: 30 }, relative), "1 request · last 2h ago");
    assert.equal(activitySummary({ uses: 7, lastUsedAt: 5, requestsLastHour: 3, maxPerHour: 30 }, relative), "7 requests · last 2h ago · 3/30 this hour");
  });
});

describe("reachItems", () => {
  const byKey = (items: ReturnType<typeof reachItems>) => Object.fromEntries(items.map((item) => [item.key, item]));

  it("lan ok, firewall ok and internet off in the common case", () => {
    const items = byKey(reachItems(tunnel(), firewall()));
    assert.equal(items.lan?.tone, "ok");
    assert.equal(items.lan?.detail, "192.168.1.4:4318");
    assert.equal(items.firewall?.tone, "ok");
    assert.equal(items.internet?.tone, "off");
    assert.equal(items.internet?.detail, "off");
  });

  it("flags a blocking firewall as a warning", () => {
    assert.equal(byKey(reachItems(tunnel(), firewall({ allowed: false })))["firewall"]?.tone, "warn");
  });

  it("omits the firewall item when the platform does not support it", () => {
    assert.equal(byKey(reachItems(tunnel(), firewall({ supported: false, allowed: null })))["firewall"], undefined);
  });

  it("shows the public host while the tunnel runs", () => {
    const items = byKey(reachItems(tunnel({ state: "running", publicUrl: "https://x.ngrok.app" }), firewall()));
    assert.equal(items.internet?.tone, "ok");
    assert.equal(items.internet?.detail, "x.ngrok.app");
  });

  it("marks an endpoint failure and a tunnel failure as errors", () => {
    assert.equal(byKey(reachItems(tunnel({ endpointError: "EADDRINUSE" }), firewall()))["lan"]?.tone, "error");
    assert.equal(byKey(reachItems(tunnel({ state: "error", error: "boom" }), firewall()))["internet"]?.tone, "error");
  });

  it("is quiet before the first status arrives", () => {
    const items = reachItems(null, null);
    assert.deepEqual(items.map((item) => item.tone), ["off", "off", "off"]);
  });
});

describe("tunnelIsUp", () => {
  it("is true while the tunnel is running, installing or starting", () => {
    assert.equal(tunnelIsUp(tunnel({ state: "running" })), true);
    assert.equal(tunnelIsUp(tunnel({ state: "installing" })), true);
    assert.equal(tunnelIsUp(tunnel({ state: "starting" })), true);
  });

  it("is false when stopped, failed or unknown", () => {
    assert.equal(tunnelIsUp(tunnel({ state: "stopped" })), false);
    assert.equal(tunnelIsUp(tunnel({ state: "error", error: "boom" })), false);
    assert.equal(tunnelIsUp(null), false);
  });

  it("agrees with the menu label for every tunnel state", () => {
    for (const state of ["stopped", "installing", "starting", "running", "error"] as const) {
      const label = reachMenuEntries(tunnel({ state }), firewall())[0]?.label;
      assert.equal(label, tunnelIsUp(tunnel({ state })) ? "Stop tunnel" : "Start tunnel");
    }
  });
});

describe("reachMenuEntries", () => {
  it("offers start tunnel, then stop tunnel once it is up or coming up", () => {
    assert.equal(reachMenuEntries(tunnel(), firewall())[0]?.label, "Start tunnel");
    assert.equal(reachMenuEntries(tunnel({ state: "running" }), firewall())[0]?.label, "Stop tunnel");
    assert.equal(reachMenuEntries(tunnel({ state: "starting" }), firewall())[0]?.label, "Stop tunnel");
    assert.equal(reachMenuEntries(tunnel({ state: "installing" }), firewall())[0]?.label, "Stop tunnel");
  });

  it("adds Allow LAN only when the firewall blocks", () => {
    assert.deepEqual(reachMenuEntries(tunnel(), firewall({ allowed: false })).map((entry) => entry.key), ["tunnel", "firewall", "settings"]);
    assert.deepEqual(reachMenuEntries(tunnel(), firewall()).map((entry) => entry.key), ["tunnel", "settings"]);
    assert.deepEqual(reachMenuEntries(tunnel(), null).map((entry) => entry.key), ["tunnel", "settings"]);
  });
});

describe("reachProblems", () => {
  it("lists the endpoint and tunnel errors", () => {
    assert.equal(reachProblems(tunnel()).length, 0);
    assert.equal(reachProblems(tunnel({ endpointError: "EADDRINUSE" })).length, 1);
    assert.deepEqual(reachProblems(tunnel({ state: "error", error: "ngrok failed" })), ["ngrok failed"]);
    assert.equal(reachProblems(null).length, 0);
  });
});
