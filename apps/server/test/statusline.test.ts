import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { decodePrevious, installStatusline, statuslineStatus, uninstallStatusline, wrapperCommand, type StatuslinePaths } from "../src/claude-statusline.js";
import { acceptClaudeStatusline, fetchClaudeLimits, parseStatuslineRateLimits, resetLimitsState, type LimitsPayload } from "../src/limits.js";
import { makeSandbox, serverDir, startServer, waitFor, type RunningServer, type Sandbox } from "./helpers.js";

const wrapper = join(serverDir, "hooks", "statusline-cchub.mjs");
const tmp = mkdtempSync(join(tmpdir(), "cchub-statusline-"));
const posix = (value: string): string => value.replace(/\\/g, "/");
const MINUTE = 60_000;
const T0 = Date.parse("2026-11-15T12:00:00.000Z");
const RESET_5H = Math.floor(Math.max(T0, Date.now()) / 1000) + 3 * 3600;
const RESET_7D = Math.floor(Math.max(T0, Date.now()) / 1000) + 3 * 86400;

after(() => rmSync(tmp, { recursive: true, force: true }));

const statusInput = Buffer.from(
  JSON.stringify({
    session_id: "session-abc",
    model: { display_name: "Opus" },
    rate_limits: { five_hour: { used_percentage: 23.5, resets_at: RESET_5H }, seven_day: { used_percentage: 41.2, resets_at: RESET_7D } },
  }),
  "utf8",
);

const previousScript = join(tmp, "previous-statusline.mjs");
writeFileSync(
  previousScript,
  [
    'import { createHash } from "node:crypto";',
    "const chunks = [];",
    "for await (const chunk of process.stdin) chunks.push(chunk);",
    "const digest = createHash(\"sha256\").update(Buffer.concat(chunks)).digest(\"hex\");",
    "process.stdout.write(Buffer.concat([Buffer.from(\"\\u001b[32m\\u2713 Opus\\u001b[0m\\r\\nline two \", \"utf8\"), Buffer.from([0xff, 0x00, 0x7f]), Buffer.from(digest, \"utf8\")]));",
  ].join("\n"),
);

interface WrapperRun {
  stdout: Buffer;
  code: number | null;
  elapsedMs: number;
}

function run(file: string, args: string[], input: Buffer, env: NodeJS.ProcessEnv): Promise<WrapperRun> {
  return new Promise((resolveRun, reject) => {
    const started = Date.now();
    const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ stdout: Buffer.concat(chunks), code, elapsedMs: Date.now() - started }));
    child.stdin.end(input);
  });
}

function wrapperEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HUB_PORT: String(port), HUB_HOST_TARGET: "127.0.0.1" };
  delete env.HUB_SKIP;
  return env;
}

const previousCommand = `"${posix(process.execPath)}" "${posix(previousScript)}"`;

function argsFor(previous: Record<string, unknown> | null): string[] {
  const command = wrapperCommand({ scriptPath: wrapper, runner: "node" }, previous);
  const encoded = /--previous ([A-Za-z0-9_-]+)/.exec(command)?.[1];
  return encoded ? [wrapper, "--previous", encoded] : [wrapper];
}

describe("statusline wrapper", () => {
  let hub: Server;
  let port = 0;
  const posts: unknown[] = [];

  before(async () => {
    hub = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        posts.push({ url: req.url, body: JSON.parse(body) as unknown });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolveListen) => hub.listen(0, "127.0.0.1", resolveListen));
    const address = hub.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  after(async () => {
    await new Promise<void>((resolveClose) => hub.close(() => resolveClose()));
  });

  beforeEach(() => {
    posts.length = 0;
  });

  it("prints nothing without a previous statusline and posts rate_limits with the session id", async () => {
    const result = await run(process.execPath, argsFor(null), statusInput, wrapperEnv(port));
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, 0);
    assert.deepEqual(posts, [
      {
        url: "/delegation/limits/claude-source/report",
        body: { sessionId: "session-abc", rateLimits: { five_hour: { used_percentage: 23.5, resets_at: RESET_5H }, seven_day: { used_percentage: 41.2, resets_at: RESET_7D } } },
      },
    ]);
  });

  it("chains the previous statusline with the same stdin and returns its output byte for byte", async () => {
    const direct = await run(process.execPath, [previousScript], statusInput, process.env);
    assert.ok(direct.stdout.length > 64);
    const wrapped = await run(process.execPath, argsFor({ type: "command", command: previousCommand, padding: 1 }), statusInput, wrapperEnv(port));
    assert.equal(wrapped.code, 0);
    assert.equal(Buffer.compare(wrapped.stdout, direct.stdout), 0);
    assert.equal(posts.length, 1);
  });

  it("stays silent and quick when the hub hangs or is offline, and does not post without rate_limits", async () => {
    const hanging = createServer(() => undefined);
    await new Promise<void>((resolveListen) => hanging.listen(0, "127.0.0.1", resolveListen));
    const address = hanging.address();
    const hangPort = typeof address === "object" && address ? address.port : 0;
    try {
      const direct = await run(process.execPath, [previousScript], statusInput, process.env);
      const slow = await run(process.execPath, argsFor({ type: "command", command: previousCommand }), statusInput, wrapperEnv(hangPort));
      assert.equal(Buffer.compare(slow.stdout, direct.stdout), 0);
      assert.ok(slow.elapsedMs < 3000, `took ${slow.elapsedMs} ms`);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolveClose) => hanging.close(() => resolveClose()));
    }
    const offline = await run(process.execPath, argsFor(null), statusInput, wrapperEnv(1));
    assert.equal(offline.code, 0);
    assert.equal(offline.stdout.length, 0);
    const noLimits = await run(process.execPath, argsFor(null), Buffer.from(JSON.stringify({ session_id: "x" })), wrapperEnv(port));
    assert.equal(noLimits.stdout.length, 0);
    assert.equal(posts.length, 0);
  });
});

describe("statusline install", () => {
  let counter = 0;

  function paths(): StatuslinePaths {
    counter += 1;
    const home = join(tmp, `home-${counter}`);
    return {
      settingsPath: join(home, ".claude", "settings.json"),
      recordPath: join(home, "hub-data", "claude-statusline-install.json"),
      scriptPath: "C:\\Program Files\\VBSS CCHUB\\sidecar\\hooks\\statusline-cchub.mjs",
      runner: "C:\\Program Files\\VBSS CCHUB\\sidecar\\node.exe",
    };
  }

  const userSettings = '{\r\n    "model": "opus",\r\n    "statusLine": {\r\n        "type": "command",\r\n        "command": "~/.claude/statusline.sh",\r\n        "padding": 1,\r\n        "refreshInterval": 5\r\n    },\r\n    "hooks": {}\r\n}\r\n';

  it("wraps the existing statusline, keeps its fields, backs up, is idempotent, and restores the exact bytes", () => {
    const p = paths();
    mkdirSync(join(p.settingsPath, ".."), { recursive: true });
    writeFileSync(p.settingsPath, userSettings);
    assert.equal(statuslineStatus(p).state, "not-installed");

    const installed = installStatusline(p);
    assert.equal(installed.state, "installed");
    assert.equal(installed.previousCommand, "~/.claude/statusline.sh");
    assert.equal(readFileSync(`${p.settingsPath}.bak`, "utf8"), userSettings);
    const written = JSON.parse(readFileSync(p.settingsPath, "utf8")) as { model: string; hooks: unknown; statusLine: Record<string, unknown> };
    assert.equal(written.model, "opus");
    assert.deepEqual(written.hooks, {});
    assert.equal(written.statusLine.type, "command");
    assert.equal(written.statusLine.padding, 1);
    assert.equal(written.statusLine.refreshInterval, 5);
    assert.match(String(written.statusLine.command), /^"C:\/Program Files\/VBSS CCHUB\/sidecar\/node\.exe" "C:\/Program Files\/VBSS CCHUB\/sidecar\/hooks\/statusline-cchub\.mjs" --previous [A-Za-z0-9_-]+$/);
    assert.deepEqual(decodePrevious(String(written.statusLine.command)), { type: "command", command: "~/.claude/statusline.sh", padding: 1, refreshInterval: 5 });

    const afterFirst = readFileSync(p.settingsPath, "utf8");
    assert.equal(installStatusline(p).state, "installed");
    assert.equal(readFileSync(p.settingsPath, "utf8"), afterFirst);

    const removed = uninstallStatusline(p);
    assert.equal(removed.state, "not-installed");
    assert.equal(Buffer.compare(readFileSync(p.settingsPath), Buffer.from(userSettings, "utf8")), 0);
    assert.equal(uninstallStatusline(p).state, "not-installed");
    assert.equal(Buffer.compare(readFileSync(p.settingsPath), Buffer.from(userSettings, "utf8")), 0);
  });

  it("installs without a previous statusline and removes the file it created", () => {
    const p = paths();
    const installed = installStatusline(p);
    assert.equal(installed.state, "installed");
    assert.equal(installed.previousCommand, null);
    const written = JSON.parse(readFileSync(p.settingsPath, "utf8")) as { statusLine: { command: string } };
    assert.equal(decodePrevious(written.statusLine.command), null);
    assert.doesNotMatch(written.statusLine.command, /--previous/);
    uninstallStatusline(p);
    assert.equal(existsSync(p.settingsPath), false);

    const q = paths();
    mkdirSync(join(q.settingsPath, ".."), { recursive: true });
    writeFileSync(q.settingsPath, '{"theme":"dark"}');
    installStatusline(q);
    uninstallStatusline(q);
    assert.equal(readFileSync(q.settingsPath, "utf8"), '{"theme":"dark"}');
  });

  it("restores the previous statusline semantically when the user changed settings after installing", () => {
    const p = paths();
    mkdirSync(join(p.settingsPath, ".."), { recursive: true });
    writeFileSync(p.settingsPath, userSettings);
    installStatusline(p);
    const edited = JSON.parse(readFileSync(p.settingsPath, "utf8")) as Record<string, unknown>;
    edited.effortLevel = "high";
    writeFileSync(p.settingsPath, JSON.stringify(edited, null, 2));
    uninstallStatusline(p);
    const restored = JSON.parse(readFileSync(p.settingsPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(restored, { model: "opus", statusLine: { type: "command", command: "~/.claude/statusline.sh", padding: 1, refreshInterval: 5 }, hooks: {}, effortLevel: "high" });
  });

  it("reports an install from an older path as outdated and updates it keeping the previous command", () => {
    const p = paths();
    const previous = { type: "command", command: "echo hi" };
    const stale = wrapperCommand({ scriptPath: "C:/old/hooks/statusline-cchub.mjs", runner: "node" }, previous);
    mkdirSync(join(p.settingsPath, ".."), { recursive: true });
    writeFileSync(p.settingsPath, JSON.stringify({ statusLine: { type: "command", command: stale } }));
    const status = statuslineStatus(p);
    assert.equal(status.state, "outdated");
    assert.equal(status.outdated, true);
    assert.equal(status.previousCommand, "echo hi");
    assert.equal(installStatusline(p).state, "installed");
    const written = JSON.parse(readFileSync(p.settingsPath, "utf8")) as { statusLine: { command: string } };
    assert.deepEqual(decodePrevious(written.statusLine.command), previous);
    uninstallStatusline(p);
    assert.deepEqual(JSON.parse(readFileSync(p.settingsPath, "utf8")), { statusLine: previous });
  });

  it("never touches an invalid settings.json", () => {
    const p = paths();
    mkdirSync(join(p.settingsPath, ".."), { recursive: true });
    writeFileSync(p.settingsPath, "{ not json");
    assert.match(installStatusline(p).error ?? "", /not valid JSON/);
    assert.match(uninstallStatusline(p).error ?? "", /not valid JSON/);
    assert.equal(readFileSync(p.settingsPath, "utf8"), "{ not json");
    assert.equal(existsSync(`${p.settingsPath}.bak`), false);
  });
});

describe("claude limits source preference", () => {
  const credentialsPath = join(tmp, "credentials.json");
  const statePath = join(tmp, "missing-state.json");
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-TEST-TOKEN", expiresAt: T0 + 10 * 3_600_000 } }));
  const usage = { five_hour: { utilization: 80, resets_at: new Date(T0 + 3_600_000).toISOString() }, seven_day: { utilization: 90, resets_at: new Date(T0 + 86_400_000).toISOString() } };

  function counting(): { impl: typeof fetch; calls: () => number } {
    let calls = 0;
    const impl = (() => {
      calls += 1;
      return Promise.resolve(new Response(JSON.stringify(usage), { status: 200, headers: { "Content-Type": "application/json" } }));
    }) as typeof fetch;
    return { impl, calls: () => calls };
  }

  const report = (at: number) => parseStatuslineRateLimits({ five_hour: { used_percentage: 23.5, resets_at: RESET_5H }, seven_day: { used_percentage: 41.2, resets_at: RESET_7D } }, "s1", at);

  beforeEach(() => resetLimitsState());

  it("uses fresh statusline data without calling the private endpoint", async () => {
    const line = report(T0);
    assert.ok(line);
    acceptClaudeStatusline(line);
    const double = counting();
    const value = await fetchClaudeLimits({ now: T0 + 5 * MINUTE, fetchImpl: double.impl, credentialsPath, statePath, claudeSource: { freshMinutes: 15, privateFallback: true } });
    assert.equal(double.calls(), 0);
    assert.equal(value?.source, "statusline");
    assert.equal(value?.fetchedAt, T0);
    assert.deepEqual(value?.fiveHour, { utilization: 23.5, resetsAt: RESET_5H * 1000, reset: false });
    assert.deepEqual(value?.sevenDay, { utilization: 41.2, resetsAt: RESET_7D * 1000, reset: false });
    assert.equal(value?.error, null);
  });

  it("falls back to the private endpoint once the statusline data is older than N minutes", async () => {
    const line = report(T0);
    assert.ok(line);
    acceptClaudeStatusline(line);
    const double = counting();
    const value = await fetchClaudeLimits({ now: T0 + 16 * MINUTE, fetchImpl: double.impl, credentialsPath, statePath, claudeSource: { freshMinutes: 15, privateFallback: true } });
    assert.equal(double.calls(), 1);
    assert.equal(value?.source, "api");
    assert.equal(value?.fiveHour.utilization, 80);
  });

  it("never calls the private endpoint when the fallback is disabled", async () => {
    const double = counting();
    const none = await fetchClaudeLimits({ now: T0, fetchImpl: double.impl, credentialsPath, statePath, claudeSource: { freshMinutes: 15, privateFallback: false } });
    assert.equal(none, null);
    const line = report(T0);
    assert.ok(line);
    acceptClaudeStatusline(line);
    const stale = await fetchClaudeLimits({ now: T0 + 30 * MINUTE, fetchImpl: double.impl, credentialsPath, statePath, claudeSource: { freshMinutes: 15, privateFallback: false } });
    assert.equal(double.calls(), 0);
    assert.equal(stale?.source, "statusline");
    assert.equal(stale?.error, "status line data is older than 15 minutes and the private usage endpoint is off");
  });

  it("ignores an older report than the one it has and rejects payloads without windows", () => {
    const newer = report(T0 + MINUTE);
    const older = report(T0);
    assert.ok(newer && older);
    assert.equal(acceptClaudeStatusline(newer), true);
    assert.equal(acceptClaudeStatusline(older), false);
    assert.equal(parseStatuslineRateLimits({ spend_limit: { used_percentage: 3 } }, null, T0), null);
    assert.equal(parseStatuslineRateLimits(null, null, T0), null);
  });
});

describe("claude source routes", () => {
  let box: Sandbox;
  let hub: RunningServer;
  let usageServer: Server;
  const usageCalls: string[] = [];
  let configDir = "";
  const original = '{\n  "statusLine": { "type": "command", "command": "echo previous" },\n  "theme": "dark"\n}\n';

  const http = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(`${hub.base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
  };

  before(async () => {
    box = makeSandbox("cchub-statusline-routes-");
    usageServer = createServer((req, res) => {
      usageCalls.push(req.url ?? "");
      res.writeHead(500).end();
    });
    await new Promise<void>((resolveListen) => usageServer.listen(0, "127.0.0.1", resolveListen));
    const address = usageServer.address();
    const usagePort = typeof address === "object" && address ? address.port : 0;
    configDir = join(box.home, "claude-config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), original);
    const credentials = join(box.tmp, "credentials.json");
    writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-ROUTE-TOKEN", expiresAt: Date.now() + 10 * 3_600_000 } }));
    hub = await startServer(box, {
      HUB_DELEGATION: "1",
      HOME: box.home,
      USERPROFILE: box.home,
      CLAUDE_CONFIG_DIR: configDir,
      HUB_CLAUDE_CREDENTIALS: credentials,
      HUB_CLAUDE_STATE: join(box.tmp, "missing-state.json"),
      HUB_CLAUDE_USAGE_URL: `http://127.0.0.1:${usagePort}/api/oauth/usage`,
    });
  });

  after(async () => {
    hub.child.kill();
    await new Promise<void>((resolveClose) => usageServer.close(() => resolveClose()));
  });

  it("takes the wrapper's report, prefers it over the private endpoint and keeps it across a refresh", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, HUB_PORT: String(hub.port), HUB_HOST_TARGET: "127.0.0.1" };
    delete env.HUB_SKIP;
    await run(process.execPath, [wrapper], statusInput, env);
    const source = (await http("GET", "/delegation/limits/claude-source")).json as { lastReportAt: number | null; privateFallback: boolean; freshMinutes: number };
    assert.equal(typeof source.lastReportAt, "number");
    assert.equal(source.privateFallback, true);
    assert.equal(source.freshMinutes, 15);

    await http("PUT", "/delegation/settings", { features: { limits: true }, limits: { claude: true, codex: false } });
    const limits = (await http("GET", "/delegation/limits")).json as LimitsPayload;
    assert.equal(limits.claude?.source, "statusline");
    assert.equal(limits.claude?.fiveHour.utilization, 23.5);
    assert.equal(limits.claude?.sevenDay.resetsAt, RESET_7D * 1000);
    const refreshed = (await http("POST", "/delegation/limits/refresh")).json as LimitsPayload;
    assert.equal(refreshed.claude?.source, "statusline");
    assert.deepEqual(usageCalls, []);
    assert.equal((await http("POST", "/delegation/limits/claude-source/report", { rateLimits: {} })).status, 400);
  });

  it("saves the fallback toggle and validates it", async () => {
    const off = await http("PUT", "/delegation/limits/claude-source", { privateFallback: false });
    assert.equal(off.status, 200);
    assert.equal((off.json as { privateFallback: boolean }).privateFallback, false);
    assert.equal((await http("PUT", "/delegation/limits/claude-source", { privateFallback: "no" })).status, 400);
    assert.equal((await http("PUT", "/delegation/limits/claude-source", { freshMinutes: 0 })).status, 400);
    const again = (await http("GET", "/delegation/limits/claude-source")).json as { privateFallback: boolean };
    assert.equal(again.privateFallback, false);
  });

  it("installs and removes the statusline only on request, against CLAUDE_CONFIG_DIR, restoring the original bytes", async () => {
    const settingsPath = join(configDir, "settings.json");
    const before = (await http("GET", "/delegation/limits/claude-source")).json as { statusline: { state: string; settingsPath: string } };
    assert.equal(before.statusline.state, "not-installed");
    assert.equal(before.statusline.settingsPath, settingsPath);
    assert.equal(readFileSync(settingsPath, "utf8"), original);

    const installed = (await http("POST", "/delegation/limits/claude-source/install")).json as { statusline: { state: string; previousCommand: string | null } };
    assert.equal(installed.statusline.state, "installed");
    assert.equal(installed.statusline.previousCommand, "echo previous");
    const command = (JSON.parse(readFileSync(settingsPath, "utf8")) as { statusLine: { command: string } }).statusLine.command;
    assert.match(command, /statusline-cchub\.mjs" --previous /);

    const removed = (await http("POST", "/delegation/limits/claude-source/uninstall")).json as { statusline: { state: string } };
    assert.equal(removed.statusline.state, "not-installed");
    assert.equal(Buffer.compare(readFileSync(settingsPath), Buffer.from(original, "utf8")), 0);
    await waitFor(async () => (existsSync(join(box.dataDir, "claude-statusline-install.json")) ? null : true), 2000);
  });
});
