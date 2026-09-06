import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "cch-tunnel-run-"));
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const capture = join(tmp, "ngrok-capture.json");
process.env.HUB_DATA_DIR = join(tmp, "data");
process.env.HUB_NGROK_BIN = process.execPath;
process.env.HUB_NGROK_ARGS_PREFIX = JSON.stringify([join(fixtures, "fake-ngrok.mjs")]);
process.env.HUB_SHARE_PORT = "4445";
process.env.FAKE_NGROK_CAPTURE = capture;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.FAKE_NGROK_MODE;

type Tunnel = typeof import("../src/tunnel.js");
let tunnel: Tunnel;

before(async () => {
  tunnel = await import("../src/tunnel.js");
});

describe("tunnel lifecycle with a fake ngrok", () => {
  it("starts, reports the public url, passes the token by env and stops", async () => {
    tunnel.updateTunnelSettings({ authtoken: "tok-123", domain: "me.ngrok-free.app" });
    const status = await tunnel.startTunnel();
    assert.equal(status.state, "running");
    assert.equal(status.publicUrl, "https://fake.ngrok-free.app");
    const seen = JSON.parse(readFileSync(capture, "utf8")) as { argv: string[]; authtoken: string | null };
    assert.equal(seen.authtoken, "tok-123");
    assert.ok(!seen.argv.includes("tok-123"), "token must not be on the command line");
    assert.deepEqual(seen.argv.slice(-2), ["--domain", "me.ngrok-free.app"]);
    assert.ok(seen.argv.includes("4445"));
    const again = await tunnel.startTunnel();
    assert.equal(again.state, "running");
    const stopped = tunnel.stopTunnel();
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.publicUrl, null);
    tunnel.updateTunnelSettings({ authtoken: null, domain: null });
  });

  it("explains a missing authtoken instead of showing a bare ERROR line", async () => {
    process.env.FAKE_NGROK_MODE = "auth";
    const status = await tunnel.startTunnel();
    delete process.env.FAKE_NGROK_MODE;
    assert.equal(status.state, "error");
    assert.match(status.error ?? "", /authtoken/);
    assert.match(status.error ?? "", /Settings › Sharing/);
    assert.equal(tunnel.stopTunnel().state, "stopped");
  });

  it("refuses an invalid static domain before spawning", async () => {
    tunnel.updateTunnelSettings({ domain: "bad domain; rm -rf" });
    const status = await tunnel.startTunnel();
    assert.equal(status.state, "error");
    assert.match(status.error ?? "", /not a valid host name/);
    tunnel.updateTunnelSettings({ domain: null });
    tunnel.stopTunnel();
  });

  it("exposes a share endpoint error in the status", () => {
    tunnel.markShareEndpoint("listen EADDRINUSE");
    assert.equal(tunnel.tunnelStatus().endpointError, "listen EADDRINUSE");
    tunnel.markShareEndpoint(null);
    assert.equal(tunnel.tunnelStatus().endpointError, null);
  });
});

after(async () => {
  tunnel.stopTunnel();
  const { db } = await import("../src/db.js");
  db.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
