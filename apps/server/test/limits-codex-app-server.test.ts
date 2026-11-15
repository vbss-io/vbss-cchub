import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import * as limits from "../src/limits.js";
import type { CodexLimits } from "../src/limits.js";
import { fixtures, serverDir, waitFor } from "./helpers.js";

const fakeServer = join(fixtures, "fake-codex-app-server.mjs");
const tmp = mkdtempSync(join(tmpdir(), "cchub-codex-app-server-"));
let logCounter = 0;

after(() => rmSync(tmp, { recursive: true, force: true }));

function logLines(log: string): string[] {
  try {
    return readFileSync(log, "utf8").trim().split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

const starts = (log: string): string[] => logLines(log).filter((line) => line.startsWith("start "));
const methods = (log: string): string[] => logLines(log).filter((line) => line.startsWith("method ")).map((line) => line.slice(7));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Harness {
  server: limits.CodexAppServer;
  log: string;
  updates: CodexLimits[];
}

function harness(mode: string, backoffBaseMs = 150): Harness {
  logCounter += 1;
  const log = join(tmp, `app-server-${logCounter}.log`);
  const updates: CodexLimits[] = [];
  const server = new limits.CodexAppServer({
    command: () => ({ bin: process.execPath, args: [fakeServer] }),
    env: () => ({ ...process.env, FAKE_APP_LOG: log, FAKE_APP_MODE: mode }),
    requestTimeoutMs: 4000,
    backoffBaseMs,
    backoffMaxMs: 1000,
    onUpdate: (value) => updates.push(value),
  });
  return { server, log, updates };
}

describe("codex app-server client", () => {
  it("keeps one long-lived app-server across reads and concurrent callers", async () => {
    const { server, log } = harness("");
    try {
      const [first, second] = await Promise.all([server.read(), server.read()]);
      const third = await server.read();
      assert.ok(first && second && third);
      assert.equal(server.startCount, 1);
      assert.equal(starts(log).length, 1);
      assert.match(starts(log)[0] ?? "", /app-server --listen stdio:\/\//);
      assert.deepEqual(methods(log), ["initialize", "initialized", "account/rateLimits/read", "account/rateLimits/read", "account/rateLimits/read"]);
      assert.equal(third.source, "live");
      assert.equal(third.primary.usedPercent, 23);
      assert.equal(third.secondary.usedPercent, 40);
      assert.equal(third.planType, "pro");
    } finally {
      server.stop();
    }
  });

  it("reads every bucket of rateLimitsByLimitId and keeps primary and secondary from the codex bucket", async () => {
    const { server } = harness("");
    try {
      const value = await server.read();
      assert.ok(value);
      assert.deepEqual(value.buckets?.map((bucket) => [bucket.limitId, bucket.limitName, bucket.primary?.usedPercent ?? null, bucket.secondary?.usedPercent ?? null]), [
        ["codex", null, 21, 40],
        ["codex_other", "codex_other", 42, null],
      ]);
    } finally {
      server.stop();
    }
  });

  it("applies account/rateLimits/updated pushes onto the last snapshot", async () => {
    const { server, updates } = harness("push");
    try {
      const value = await server.read();
      assert.equal(value?.primary.usedPercent, 21);
      const pushed = await waitFor(async () => updates[0] ?? null, 3000);
      assert.equal(pushed.primary.usedPercent, 31);
      assert.equal(pushed.secondary.usedPercent, 40);
      assert.equal(pushed.planType, "pro");
      assert.deepEqual(pushed.buckets?.map((bucket) => bucket.limitId), ["codex", "codex_other"]);
      assert.equal(server.value?.primary.usedPercent, 31);
    } finally {
      server.stop();
    }
  });

  it("restarts a dead app-server once, after a backoff, and never runs two", async () => {
    const { server, log } = harness("die-after-read", 400);
    try {
      assert.ok(await server.read());
      const firstPid = Number((starts(log)[0] ?? "").split(" ")[1]);
      await waitFor(async () => (server.backingOff ? true : null), 3000);
      assert.equal(await server.read(), null);
      assert.equal(starts(log).length, 1);
      await waitFor(async () => (server.startCount === 2 && server.pid !== null ? true : null), 5000);
      assert.equal(alive(firstPid), false);
      assert.ok(await server.read());
      assert.equal(starts(log).length, 2);
    } finally {
      server.stop();
    }
  });

  it("stops the child on stop and does not restart it afterwards", async () => {
    const { server, log } = harness("", 100);
    assert.ok(await server.read());
    const pid = server.pid;
    assert.ok(pid);
    server.stop();
    await waitFor(async () => (alive(pid) ? null : true), 5000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    assert.equal(server.pid, null);
    assert.equal(server.backingOff, false);
    assert.equal(starts(log).length, 1);
  });

  it("parses the documented read response and merges an update for one bucket", () => {
    const now = Date.now();
    const parsed = limits.parseCodexLiveRateLimits(
      {
        rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: Math.floor(now / 1000) + 600 }, secondary: null, rateLimitReachedType: null },
        rateLimitsByLimitId: {
          codex_other: { limitId: "codex_other", limitName: "codex_other", primary: { usedPercent: 42, windowDurationMins: 60, resetsAt: Math.floor(now / 1000) + 1200 } },
        },
      },
      now,
    );
    assert.ok(parsed);
    assert.equal(parsed.primary.usedPercent, 25);
    assert.deepEqual(parsed.buckets?.map((bucket) => bucket.limitId), ["codex", "codex_other"]);
    const merged = limits.mergeCodexLiveUpdate(parsed, { rateLimits: { limitId: "codex_other", primary: { usedPercent: 50, windowDurationMins: 60, resetsAt: Math.floor(now / 1000) + 900 } } }, now);
    assert.equal(merged?.primary.usedPercent, 25);
    assert.equal(merged?.buckets?.find((bucket) => bucket.limitId === "codex_other")?.primary?.usedPercent, 50);
  });
});

describe("hub codex live limits", () => {
  it("spawns a single app-server for repeated readCodexLimitsLive calls in one hub process", async () => {
    const log = join(tmp, "hub-live.log");
    const runner = `import(${JSON.stringify(pathToFileURL(join(serverDir, "src", "limits.ts")).href)}).then(async (m) => { const a = await m.readCodexLimitsLive(4000); const b = await m.readCodexLimitsLive(4000); console.log(JSON.stringify({ a: a && a.primary.usedPercent, b: b && b.primary.usedPercent })); m.stopCodexAppServer(); process.exit(0); });`;
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "-e", runner], {
        cwd: serverDir,
        env: { ...process.env, HUB_CODEX_BIN: process.execPath, HUB_CODEX_ARGS_PREFIX: JSON.stringify([fakeServer]), HUB_DATA_DIR: join(tmp, "hub-data"), FAKE_APP_LOG: log },
        stdio: ["ignore", "pipe", "inherit"],
      });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("error", reject);
      child.on("close", () => resolveOutput(out));
    });
    assert.deepEqual(JSON.parse(output.trim().split("\n").pop() ?? "null"), { a: 21, b: 22 });
    assert.equal(starts(log).length, 1);
  });
});
