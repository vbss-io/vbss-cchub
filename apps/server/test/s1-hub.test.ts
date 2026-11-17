import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { s1Request, s1Sandbox, s1Wait } from "./helpers/s1-env.js";

const box = s1Sandbox("cch-s1-hub-", { HUB_DELEGATION: "1" });

const { startHub, defaultAppDeps } = await import("../src/app.js");
const { onBroadcast, broadcast } = await import("../src/sse.js");
const { applyHook, createClaim, getSession, listClaims, db } = await import("../src/db.js");
const { beginRun, createTask, getCodexRolloutMark, getTask, updateSettings } = await import("../src/delegation-store.js");
const { vaultSnapshotsDir } = await import("../src/vault-snapshot.js");

type RunningHub = ReturnType<typeof startHub>;

const SAMPLE_THREAD = "01a0aaaa-0000-7000-8000-000000000001";
const TTL_MS = 60_000;

const removed: string[] = [];
const claimEvents: unknown[] = [];
onBroadcast((event, data) => {
  if (event === "removed") removed.push((data as { sessionId: string }).sessionId);
  if (event === "claims") claimEvents.push(data);
});

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

function hook(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "session_start" as const,
    sessionId,
    cwd: null,
    source: null,
    hostPid: null,
    shellPid: null,
    title: null,
    message: null,
    notificationType: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    contextTokens: null,
    agentId: null,
    agentType: null,
    client: null,
    claudePid: null,
    transcriptPath: null,
    agentMessage: null,
    shareLabel: null,
    ...extra,
  };
}

const exits: number[] = [];
const signals = new Map<string, () => void>();
let parentGone = false;
let hub: RunningHub;
let taskId = "";
const logs: string[] = [];

before(async () => {
  updateSettings({ features: { usage: true } });
  applyHook(hook("s1-empty"), Date.now() - 2 * TTL_MS);
  applyHook(hook("s1-dead", { model: "opus", claudePid: deadPid() }));
  createClaim({ sessionId: "s1-dead", repoPath: box.repoA, paths: ["a.ts"], note: null, ttlMs: null });
  const task = createTask({
    title: "codex run",
    prompt: "do it",
    workspace: "pilot",
    repo: null,
    cwd: box.repoA,
    addDirs: [],
    runner: "codex",
    model: null,
    permissionMode: null,
    sandbox: null,
    createdBy: null,
    originSessionId: null,
    originClient: null,
  });
  taskId = task.id;
  beginRun({ taskId: task.id, kind: "launch", runner: "codex", prompt: "do it", model: null, permissionMode: null, sessionId: SAMPLE_THREAD });
  mock.method(console, "log", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  hub = startHub(
    {
      host: "127.0.0.1",
      port: 0,
      shareHost: "127.0.0.1",
      sharePort: 0,
      dataDir: box.dataDir,
      staticDir: null,
      previewMode: false,
      delegationEnabled: true,
      emptyTtlMs: TTL_MS,
      devSeed: false,
      parentPid: 424242,
      appVersion: "s1-test-version",
    },
    defaultAppDeps,
    {
      exit: (code) => {
        exits.push(code);
      },
      onSignal: (signal, handler) => {
        signals.set(signal, handler);
      },
      probe: () => {
        if (parentGone) throw new Error("ESRCH");
      },
    },
  );
  await hub.listening;
});

after(async () => {
  await hub.stop();
  mock.restoreAll();
  db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const base = (): string => {
  const address = hub.server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
};

describe("startHub", () => {
  it("listens and serves the API", async () => {
    const res = await s1Request(base(), "GET", "/api/health");
    assert.equal(res.status, 200);
    assert.equal((res.json as { ok: boolean }).ok, true);
    assert.ok(logs.some((line) => line.startsWith("vbss-cchub server on http://127.0.0.1:0")));
  });

  it("records the app version and enables vault snapshots under the data dir", () => {
    assert.equal(readFileSync(join(box.dataDir, "backups", "last-version"), "utf8").trim(), "s1-test-version");
    assert.equal(vaultSnapshotsDir(), join(box.dataDir, "vault-snapshots"));
  });

  it("purges empty sessions and ends dead ones at startup", () => {
    assert.equal(getSession("s1-empty"), null);
    assert.ok(removed.includes("s1-empty"));
    assert.equal(getSession("s1-dead")?.status, "ended");
    assert.ok(!listClaims().some((claim) => claim.sessionId === "s1-dead"));
    assert.ok(claimEvents.length >= 1);
    assert.ok(logs.includes("purged 1 empty sessions"));
  });

  it("marks interrupted runs and records the codex rollout of their thread", () => {
    assert.equal(getTask(taskId)?.status, "interrupted");
    assert.notEqual(getCodexRolloutMark(SAMPLE_THREAD), null);
    assert.ok(logs.includes("marked 1 delegation runs interrupted on restart"));
    assert.ok(logs.includes("delegation enabled (loopback callers only)"));
  });

  it("starts the share endpoint", async () => {
    for (let i = 0; i < 100 && !hub.shareServer()?.listening; i += 1) await s1Wait(20);
    assert.equal(hub.shareServer()?.listening, true);
    for (let i = 0; i < 100 && !logs.some((line) => line.startsWith("share endpoint on")); i += 1) await s1Wait(20);
    assert.ok(logs.some((line) => line.startsWith("share endpoint on http://127.0.0.1:0")));
  });

  it("reacts to settings and limits broadcasts", () => {
    assert.doesNotThrow(() => broadcast("settings", {}));
    assert.doesNotThrow(() => broadcast("limits", {}));
  });

  it("shuts down with exit code 0 on SIGINT and SIGTERM", async () => {
    assert.deepEqual([...signals.keys()].sort(), ["SIGINT", "SIGTERM"]);
    signals.get("SIGINT")?.();
    for (let i = 0; i < 150 && exits.length < 1; i += 1) await s1Wait(20);
    assert.deepEqual(exits, [0]);
    signals.get("SIGTERM")?.();
    for (let i = 0; i < 150 && exits.length < 2; i += 1) await s1Wait(20);
    assert.deepEqual(exits, [0, 0]);
  });

  it("shuts down when the parent process is gone", async () => {
    parentGone = true;
    for (let i = 0; i < 300 && exits.length < 3; i += 1) await s1Wait(20);
    assert.deepEqual(exits, [0, 0, 0]);
  });

  it("closes its servers on stop", async () => {
    const share = hub.shareServer();
    await hub.stop();
    assert.equal(hub.server.listening, false);
    assert.equal(share?.listening, false);
    await hub.stop();
  });
});
