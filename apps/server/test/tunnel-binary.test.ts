import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, describe, it } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "cch-tunnel-bin-"));
const dataDir = join(tmp, "data");
const localAppData = join(tmp, "localappdata-empty");
process.env.HUB_DATA_DIR = dataDir;
process.env.LOCALAPPDATA = localAppData;
delete process.env.HUB_NGROK_BIN;
delete process.env.HUB_NGROK_ARGS_PREFIX;
delete process.env.HUB_RESOURCE_DIR;

const originalPath = process.env.PATH;

type Tunnel = typeof import("../src/tunnel.js");
let tunnel: Tunnel;

before(async () => {
  tunnel = await import("../src/tunnel.js");
});

describe("ngrok binary discovery does not spawn a process", () => {
  it("finds a regular-file candidate on PATH", () => {
    const dir = mkdtempSync(join(tmp, "path-file-"));
    writeFileSync(join(dir, "ngrok.exe"), "");
    process.env.PATH = dir;
    tunnel.resetNgrokBinaryCache();
    assert.equal(tunnel.findNgrokBinary(), join(dir, "ngrok.exe"));
    process.env.PATH = originalPath;
  });

  it("finds a symlink candidate on PATH (app-execution aliases report as symlinks)", () => {
    const dir = mkdtempSync(join(tmp, "path-symlink-"));
    const target = join(dir, "real-ngrok.exe");
    writeFileSync(target, "");
    const link = join(dir, "ngrok.exe");
    try {
      symlinkSync(target, link, "file");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        console.log("skipping symlink assertion: EPERM creating symlink on this machine");
        return;
      }
      throw err;
    }
    process.env.PATH = dir;
    tunnel.resetNgrokBinaryCache();
    assert.equal(tunnel.findNgrokBinary(), link);
    process.env.PATH = originalPath;
  });

  it("reports a missing candidate as not found, quickly and without spawning", () => {
    const dir = mkdtempSync(join(tmp, "path-missing-"));
    process.env.PATH = dir;
    tunnel.resetNgrokBinaryCache();
    const startedAt = performance.now();
    const found = tunnel.findNgrokBinary();
    const elapsedMs = performance.now() - startedAt;
    assert.equal(found, null);
    assert.ok(elapsedMs < 1_000, `findNgrokBinary took ${elapsedMs}ms, expected well under 1s (no spawn)`);
    process.env.PATH = originalPath;
  });

  it("memoizes the result for the TTL, and resetNgrokBinaryCache forces a re-check", () => {
    const dir = mkdtempSync(join(tmp, "path-memo-"));
    const binary = join(dir, "ngrok.exe");
    writeFileSync(binary, "");
    process.env.PATH = dir;
    tunnel.resetNgrokBinaryCache();
    assert.equal(tunnel.findNgrokBinary(), binary);
    rmSync(binary, { force: true });
    assert.equal(tunnel.findNgrokBinary(), binary, "cached value should survive within the TTL even after removal");
    tunnel.resetNgrokBinaryCache();
    assert.equal(tunnel.findNgrokBinary(), null, "reset must force a fresh lookup that sees the removal");
    process.env.PATH = originalPath;
  });
});

after(async () => {
  process.env.PATH = originalPath;
  const { db } = await import("../src/db.js");
  db.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
