import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const pidFilePath = join(tmp, "data", "pids", "ngrok.pid");
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function startLeftover(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  if (typeof child.pid !== "number") throw new Error("leftover process has no pid");
  return child.pid;
}

describe("reaping a leftover ngrok from a previous run", () => {
  it("kills the stale ngrok named in the pid file at startup and removes the file", async () => {
    const pid = await startLeftover();
    mkdirSync(dirname(pidFilePath), { recursive: true });
    writeFileSync(pidFilePath, String(pid), "utf8");
    const closed = await tunnel.reapLeftoverNgrok();
    assert.equal(closed, pid);
    assert.equal(existsSync(pidFilePath), false);
    assert.equal(alive(pid), false);
  });

  it("closes a pre-existing ngrok on start, sets a notice and reaches running", async () => {
    const pid = await startLeftover();
    mkdirSync(dirname(pidFilePath), { recursive: true });
    writeFileSync(pidFilePath, String(pid), "utf8");
    tunnel.updateTunnelSettings({ authtoken: "tok-321", domain: null });
    const status = await tunnel.startTunnel();
    assert.equal(status.state, "running");
    assert.match(status.notice ?? "", /closed an ngrok that was already running/);
    assert.match(status.notice ?? "", new RegExp(`\\(pid ${pid}\\)`));
    assert.equal(alive(pid), false);
    const stopped = tunnel.stopTunnel();
    assert.equal(stopped.notice, null);
    tunnel.updateTunnelSettings({ authtoken: null, domain: null });
  });
});

after(async () => {
  tunnel.stopTunnel();
  const { db } = await import("../src/db.js");
  db.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
