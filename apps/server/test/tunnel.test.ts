import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "cch-tunnel-"));
const fakeNgrok = join(tmp, "ngrok-fake.exe");
writeFileSync(fakeNgrok, "");
process.env.HUB_DATA_DIR = join(tmp, "data");
process.env.HUB_NGROK_BIN = fakeNgrok;
process.env.HUB_SHARE_PORT = "4444";
delete process.env.HUB_RESOURCE_DIR;

type Tunnel = typeof import("../src/tunnel.js");
let tunnel: Tunnel;

before(async () => {
  tunnel = await import("../src/tunnel.js");
});

describe("lan address", () => {
  it("prefers a physical private interface over virtual adapters", () => {
    const picked = tunnel.pickLanAddress([
      { name: "vEthernet (WSL)", address: "172.22.144.1", internal: false, family: "IPv4" },
      { name: "Tailscale", address: "100.64.0.9", internal: false, family: "IPv4" },
      { name: "Ethernet", address: "192.168.100.4", internal: false, family: "IPv4" },
      { name: "Loopback", address: "127.0.0.1", internal: true, family: "IPv4" },
    ]);
    assert.equal(picked, "192.168.100.4");
  });

  it("falls back to any private address, then any address, then null", () => {
    assert.equal(tunnel.pickLanAddress([{ name: "vEthernet (Default Switch)", address: "172.26.48.1", internal: false, family: "IPv4" }]), "172.26.48.1");
    assert.equal(tunnel.pickLanAddress([{ name: "eth0", address: "8.8.8.8", internal: false, family: "IPv4" }]), "8.8.8.8");
    assert.equal(tunnel.pickLanAddress([{ name: "lo", address: "::1", internal: true, family: "IPv6" }]), null);
  });
});

describe("ngrok output", () => {
  it("extracts the public url from the started tunnel line", () => {
    const line = JSON.stringify({ lvl: "info", msg: "started tunnel", obj: "tunnels", name: "command_line", addr: "http://localhost:4318", url: "https://abc.ngrok-free.app" });
    assert.deepEqual(tunnel.parseNgrokLine(line), { url: "https://abc.ngrok-free.app", error: null });
  });

  it("surfaces errors and ignores noise", () => {
    const line = JSON.stringify({ lvl: "eror", msg: "failed to start tunnel", err: "ERR_NGROK_4018 authentication failed: authtoken required" });
    assert.match(tunnel.parseNgrokLine(line).error ?? "", /needs an authtoken.*Settings › Sharing/);
    assert.deepEqual(tunnel.parseNgrokLine(JSON.stringify({ lvl: "info", msg: "client session established" })), { url: null, error: null });
    assert.deepEqual(tunnel.parseNgrokLine("not json at all"), { url: null, error: null });
    assert.deepEqual(tunnel.parseNgrokLine("ERROR:"), { url: null, error: null });
    assert.match(tunnel.parseNgrokLine("ERROR: authentication failed").error ?? "", /needs an authtoken/);
    assert.match(tunnel.parseNgrokLine(JSON.stringify({ lvl: "eror", err: "ERR_NGROK_108 limited to 1 simultaneous ngrok agent session" })).error ?? "", /another agent is already running/);
  });
});

describe("binary discovery and status", () => {
  it("honours HUB_NGROK_BIN and reports a stopped tunnel with the share port", () => {
    assert.equal(tunnel.findNgrokBinary(), fakeNgrok);
    const status = tunnel.tunnelStatus();
    assert.equal(status.state, "stopped");
    assert.equal(status.installed, true);
    assert.equal(status.sharePort, 4444);
    assert.equal(status.localUrl, "http://127.0.0.1:4444");
    assert.equal(status.publicUrl, null);
  });

  it("stores the authtoken and domain without echoing the token", () => {
    tunnel.updateTunnelSettings({ authtoken: "secret-token", domain: "me.ngrok-free.app" });
    const status = tunnel.tunnelStatus();
    assert.equal(status.authtokenSet, true);
    assert.equal(status.domain, "me.ngrok-free.app");
    assert.ok(!JSON.stringify(status).includes("secret-token"));
    tunnel.updateTunnelSettings({ authtoken: null, domain: null });
    assert.equal(tunnel.tunnelStatus().authtokenSet, false);
  });
});

after(async () => {
  const { db } = await import("../src/db.js");
  db.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
