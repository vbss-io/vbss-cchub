import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { DelegationSettings } from "../src/delegation-types.js";
import {
  fetchClaudeLimits,
  limitsPollingActive,
  limitsSnapshot,
  parseClaudeUsage,
  readClaudeCachedLimits,
  readClaudeCredentials,
  readCodexRolloutLimits,
  refreshLimits,
  resetLimitsState,
  startLimitsPolling,
  stopLimitsPolling,
  type LimitsPayload,
} from "../src/limits.js";
import { onBroadcast } from "../src/sse.js";
import { makeSandbox, serverDir, startServer, waitFor, type RunningServer, type Sandbox } from "./helpers.js";

const TOKEN = "sk-ant-oat01-TESTTOKEN-do-not-leak-0123456789";
const MINUTE = 60_000;
const T0 = Date.parse("2026-09-30T12:00:00.000Z");

const USAGE_FIXTURE = {
  five_hour: { utilization: 42.5, resets_at: "2026-09-30T15:00:00.000000+00:00", limit_dollars: null },
  seven_day: { utilization: 71, resets_at: "2026-10-03T09:00:00.000000+00:00" },
  seven_day_opus: { utilization: 33, resets_at: "2026-10-03T09:00:00+00:00" },
  seven_day_sonnet: null,
  seven_day_oauth_apps: null,
  seven_day_cowork: null,
  seven_day_omelette: null,
  extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1000, utilization: 20 },
  limits: [
    { kind: "session", group: "session", percent: 42.5, severity: "normal", resets_at: "2026-09-30T15:00:00+00:00", scope: null, is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 71, severity: "normal", resets_at: "2026-10-03T09:00:00+00:00", scope: null, is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: 33, severity: "normal", resets_at: "2026-10-03T09:00:00+00:00", scope: { model: { id: null, display_name: "opus" } }, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: 57, severity: "normal", resets_at: "2026-10-03T09:00:00+00:00", scope: { model: { id: null, display_name: "Fable" } }, is_active: false },
    { kind: "weekly_scoped", group: "weekly", percent: null, severity: "normal", resets_at: null, scope: { model: { id: null, display_name: "Ghost" } }, is_active: false },
  ],
  spend: { used: { amount_minor: 0 } },
  seven_day_breakdown: { rows: [] },
};

function settingsWith(overrides: { limits?: boolean; claude?: boolean; codex?: boolean; refreshMinutes?: number }): DelegationSettings {
  return {
    features: { daily: false, trail: false, usage: false, limits: overrides.limits ?? true },
    limits: { claude: overrides.claude ?? true, codex: overrides.codex ?? true, refreshMinutes: overrides.refreshMinutes ?? 5 },
  } as unknown as DelegationSettings;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  method: string | undefined;
}

function fetchDouble(handler: (call: number) => Response): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      method: init?.method,
    });
    return Promise.resolve(handler(calls.length));
  }) as typeof fetch;
  return { impl, calls };
}

let tmp = "";
let credentialsPath = "";
let statePath = "";
let sessionsDir = "";

function writeCredentials(expiresAt: number | null): void {
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: "REFRESH-SECRET", expiresAt } }));
}

function writeState(fetchedAtMs: number, utilization: unknown = USAGE_FIXTURE): void {
  writeFileSync(statePath, JSON.stringify({ accountUuid: "ACCOUNT-UUID-SECRET", email: "person@example.com", cachedUsageUtilization: { fetchedAtMs, accountUuid: "ACCOUNT-UUID-SECRET", utilization } }));
}

function dayDir(root: string, at: number): string {
  const date = new Date(at);
  const dir = join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function tokenCountLine(at: number, primary: { used: number; resetsAtSec: number }, secondary: { used: number; resetsAtSec: number }, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: new Date(at).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: null,
      rate_limits: {
        limit_id: "codex",
        limit_name: null,
        primary: { used_percent: primary.used, window_minutes: 300, resets_at: primary.resetsAtSec },
        secondary: { used_percent: secondary.used, window_minutes: 10080, resets_at: secondary.resetsAtSec },
        credits: { has_credits: false, unlimited: false, balance: null },
        plan_type: "plus",
        ...extra,
      },
    },
  });
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "cchub-limits-"));
  credentialsPath = join(tmp, "credentials.json");
  statePath = join(tmp, "claude-state.json");
  sessionsDir = join(tmp, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
});

after(() => {
  stopLimitsPolling();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  resetLimitsState();
  rmSync(credentialsPath, { force: true });
  rmSync(statePath, { force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  stopLimitsPolling();
  delete process.env.HUB_CODEX_LIVE_LIMITS;
});

describe("claude parsing", () => {
  it("converts utilization and resets_at and merges models from seven_day_* and limits[]", () => {
    const parsed = parseClaudeUsage(USAGE_FIXTURE);
    assert.ok(parsed);
    assert.deepEqual(parsed.fiveHour, { utilization: 42.5, resetsAt: Date.parse("2026-09-30T15:00:00.000Z") });
    assert.deepEqual(parsed.sevenDay, { utilization: 71, resetsAt: Date.parse("2026-10-03T09:00:00.000Z") });
    assert.deepEqual(parsed.models, [
      { name: "Opus", utilization: 33, resetsAt: Date.parse("2026-10-03T09:00:00.000Z") },
      { name: "Fable", utilization: 57, resetsAt: Date.parse("2026-10-03T09:00:00.000Z") },
    ]);
    assert.deepEqual(parsed.extra, { enabled: true, utilization: 20 });
  });

  it("is defensive about nulls, out-of-range numbers and garbage", () => {
    assert.equal(parseClaudeUsage(null), null);
    assert.equal(parseClaudeUsage("nope"), null);
    assert.equal(parseClaudeUsage({}), null);
    const parsed = parseClaudeUsage({ five_hour: { utilization: 130, resets_at: "garbage" }, seven_day: null, extra_usage: null });
    assert.ok(parsed);
    assert.deepEqual(parsed.fiveHour, { utilization: 100, resetsAt: null });
    assert.deepEqual(parsed.sevenDay, { utilization: 0, resetsAt: null });
    assert.deepEqual(parsed.models, []);
    assert.equal(parsed.extra, null);
  });
});

describe("claude credentials and cache", () => {
  it("returns null when the credentials file is missing or malformed and never throws", () => {
    assert.equal(readClaudeCredentials(credentialsPath), null);
    writeFileSync(credentialsPath, "{not json");
    assert.equal(readClaudeCredentials(credentialsPath), null);
    writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: {} }));
    assert.equal(readClaudeCredentials(credentialsPath), null);
    writeCredentials(T0 + 3_600_000);
    assert.deepEqual(readClaudeCredentials(credentialsPath), { accessToken: TOKEN, expiresAt: T0 + 3_600_000 });
  });

  it("reads the cached utilization from the state file with its age and without identity fields", () => {
    assert.equal(readClaudeCachedLimits(statePath), null);
    writeState(T0 - 3 * 86_400_000);
    const cached = readClaudeCachedLimits(statePath);
    assert.ok(cached);
    assert.equal(cached.source, "cache");
    assert.equal(cached.fetchedAt, T0 - 3 * 86_400_000);
    assert.equal(cached.fiveHour.utilization, 42.5);
    assert.equal(cached.error, null);
    assert.ok(!JSON.stringify(cached).includes("ACCOUNT-UUID-SECRET"));
    assert.ok(!JSON.stringify(cached).includes("person@example.com"));
  });
});

describe("claude fetch", () => {
  it("calls the usage endpoint once with the documented headers and maps the response", async () => {
    writeCredentials(T0 + 3_600_000);
    const double = fetchDouble(() => jsonResponse(USAGE_FIXTURE));
    const value = await fetchClaudeLimits({ now: T0, fetchImpl: double.impl, credentialsPath, statePath, usageUrl: "http://usage.invalid/api/oauth/usage" });
    assert.equal(double.calls.length, 1);
    const call = double.calls[0];
    assert.ok(call);
    assert.equal(call.url, "http://usage.invalid/api/oauth/usage");
    assert.equal(call.method, "GET");
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(call.headers["content-type"], "application/json");
    assert.match(call.headers["user-agent"] ?? "", /^vbss-cchub\/\S+$/);
    assert.ok(value);
    assert.equal(value.source, "api");
    assert.equal(value.fetchedAt, T0);
    assert.equal(value.error, null);
    assert.equal(value.fiveHour.utilization, 42.5);
    assert.ok(!JSON.stringify(value).includes(TOKEN));
  });

  it("skips the call when the token expires within five minutes and shows the cached value with its age", async () => {
    writeCredentials(T0 + 4 * MINUTE);
    writeState(T0 - 2 * 3_600_000);
    const double = fetchDouble(() => jsonResponse(USAGE_FIXTURE));
    const value = await fetchClaudeLimits({ now: T0, fetchImpl: double.impl, credentialsPath, statePath });
    assert.equal(double.calls.length, 0);
    assert.ok(value);
    assert.equal(value.source, "cache");
    assert.equal(value.fetchedAt, T0 - 2 * 3_600_000);
    assert.match(value.error ?? "", /expired|expire/);
  });

  it("falls back to the cache when credentials are missing and yields null with no cache at all", async () => {
    const double = fetchDouble(() => jsonResponse(USAGE_FIXTURE));
    assert.equal(await fetchClaudeLimits({ now: T0, fetchImpl: double.impl, credentialsPath, statePath }), null);
    writeState(T0 - MINUTE);
    const value = await fetchClaudeLimits({ now: T0, fetchImpl: double.impl, credentialsPath, statePath });
    assert.equal(double.calls.length, 0);
    assert.equal(value?.source, "cache");
    assert.match(value?.error ?? "", /credentials/);
  });

  it("backs off 5 then 10 minutes on 429 without retrying, keeps the last value and recovers", async () => {
    writeCredentials(T0 + 10 * 3_600_000);
    const responses = [200, 429, 429, 200];
    const double = fetchDouble((call) => (responses[call - 1] === 200 ? jsonResponse(USAGE_FIXTURE) : jsonResponse({}, responses[call - 1] ?? 500)));
    const sources = (at: number) => ({ now: T0 + at, fetchImpl: double.impl, credentialsPath, statePath });

    const first = await fetchClaudeLimits(sources(0));
    assert.equal(first?.error, null);

    const limited = await fetchClaudeLimits(sources(2 * MINUTE));
    assert.equal(double.calls.length, 2);
    assert.equal(limited?.source, "api");
    assert.equal(limited?.fiveHour.utilization, 42.5);
    assert.equal(limited?.error, "usage API returned 429");

    const skipped = await fetchClaudeLimits(sources(4 * MINUTE));
    assert.equal(double.calls.length, 2);
    assert.equal(skipped?.error, "usage API returned 429");

    await fetchClaudeLimits(sources(8 * MINUTE));
    assert.equal(double.calls.length, 3);

    await fetchClaudeLimits(sources(15 * MINUTE));
    assert.equal(double.calls.length, 3);

    const recovered = await fetchClaudeLimits(sources(19 * MINUTE));
    assert.equal(double.calls.length, 4);
    assert.equal(recovered?.error, null);
    assert.equal(recovered?.fetchedAt, T0 + 19 * MINUTE);
  });

  it("treats 401 and 403 as backoff too and other failures as a plain error without backoff", async () => {
    writeCredentials(T0 + 10 * 3_600_000);
    const statuses = [401, 500];
    const double = fetchDouble((call) => jsonResponse({}, statuses[call - 1] ?? 200));
    const at = (offset: number) => ({ now: T0 + offset, fetchImpl: double.impl, credentialsPath, statePath });
    assert.equal(await fetchClaudeLimits(at(0)), null);
    await fetchClaudeLimits(at(2 * MINUTE));
    assert.equal(double.calls.length, 1);
    const later = await fetchClaudeLimits(at(6 * MINUTE));
    assert.equal(double.calls.length, 2);
    assert.equal(later, null);
    await fetchClaudeLimits(at(7 * MINUTE + 1));
    assert.equal(double.calls.length, 3);
  });

  it("never calls faster than 60 seconds apart", async () => {
    writeCredentials(T0 + 10 * 3_600_000);
    const double = fetchDouble(() => jsonResponse(USAGE_FIXTURE));
    await fetchClaudeLimits({ now: T0, fetchImpl: double.impl, credentialsPath, statePath });
    await fetchClaudeLimits({ now: T0 + 30_000, fetchImpl: double.impl, credentialsPath, statePath });
    assert.equal(double.calls.length, 1);
    await fetchClaudeLimits({ now: T0 + 61_000, fetchImpl: double.impl, credentialsPath, statePath });
    assert.equal(double.calls.length, 2);
  });
});

describe("codex rollout", () => {
  it("reads the newest token_count rate limits and reports a passed resets_at as reset", () => {
    const dir = dayDir(sessionsDir, T0);
    const older = tokenCountLine(T0 - 2 * 3_600_000, { used: 5, resetsAtSec: (T0 + MINUTE) / 1000 }, { used: 5, resetsAtSec: (T0 + MINUTE) / 1000 });
    const newer = tokenCountLine(T0 - 30 * MINUTE, { used: 64, resetsAtSec: (T0 + 90 * MINUTE) / 1000 }, { used: 22, resetsAtSec: (T0 - 5 * MINUTE) / 1000 });
    const noLimits = JSON.stringify({ timestamp: new Date(T0).toISOString(), type: "event_msg", payload: { type: "token_count", info: null, rate_limits: null } });
    writeFileSync(join(dir, "rollout-a.jsonl"), [older, newer, noLimits, "{broken"].join("\n") + "\n");

    const limits = readCodexRolloutLimits({ root: sessionsDir, now: T0 });
    assert.ok(limits);
    assert.equal(limits.source, "rollout");
    assert.equal(limits.fetchedAt, T0 - 30 * MINUTE);
    assert.deepEqual(limits.primary, { usedPercent: 64, resetsAt: T0 + 90 * MINUTE, reset: false });
    assert.deepEqual(limits.secondary, { usedPercent: 0, resetsAt: null, reset: true });
    assert.equal(limits.planType, "plus");
    assert.equal(limits.error, null);
  });

  it("prefers the newest file and falls back to older days, returning null when nothing has rate limits", () => {
    assert.equal(readCodexRolloutLimits({ root: sessionsDir, now: T0 }), null);
    const oldDir = dayDir(sessionsDir, T0 - 5 * 86_400_000);
    writeFileSync(join(oldDir, "rollout-old.jsonl"), tokenCountLine(T0 - 5 * 86_400_000, { used: 10, resetsAtSec: (T0 - MINUTE) / 1000 }, { used: 30, resetsAtSec: (T0 + 86_400_000) / 1000 }) + "\n");
    const found = readCodexRolloutLimits({ root: sessionsDir, now: T0 });
    assert.equal(found?.primary.reset, true);
    assert.deepEqual(found?.secondary, { usedPercent: 30, resetsAt: T0 + 86_400_000, reset: false });

    const todayDir = dayDir(sessionsDir, T0);
    writeFileSync(join(todayDir, "rollout-empty.jsonl"), JSON.stringify({ timestamp: new Date(T0).toISOString(), type: "session_meta", payload: {} }) + "\n");
    assert.equal(readCodexRolloutLimits({ root: sessionsDir, now: T0 })?.secondary.usedPercent, 30);
    writeFileSync(join(todayDir, "rollout-new.jsonl"), tokenCountLine(T0 - MINUTE, { used: 80, resetsAtSec: (T0 + MINUTE * 30) / 1000 }, { used: 40, resetsAtSec: (T0 + 86_400_000) / 1000 }) + "\n");
    assert.equal(readCodexRolloutLimits({ root: sessionsDir, now: T0 })?.primary.usedPercent, 80);
  });
});

describe("codex live", () => {
  it("does nothing unless HUB_CODEX_LIVE_LIMITS=1", async () => {
    const { readCodexLimitsLive } = await import("../src/limits.js");
    delete process.env.HUB_CODEX_LIVE_LIMITS;
    assert.equal(await readCodexLimitsLive(), null);
  });

  it("talks initialize, initialized and account/rateLimits/read only, then kills the child", async () => {
    const script = join(tmp, "fake-app-server.mjs");
    const log = join(tmp, "app-server-methods.txt");
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.FAKE_LOG;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(log, message.method + "\\n");
  if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "fake" } }) + "\\n");
  if (message.method === "account/rateLimits/read") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 1900500000 }, credits: null, planType: "pro" } } }) + "\\n");
  }
});
`,
    );
    const runner = `import(${JSON.stringify(pathToFileURL(join(serverDir, "src", "limits.ts")).href)}).then(async (m) => { console.log(JSON.stringify(await m.readCodexLimitsLive())); process.exit(0); });`;
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "-e", runner], {
        cwd: serverDir,
        env: {
          ...process.env,
          HUB_CODEX_LIVE_LIMITS: "1",
          HUB_CODEX_BIN: process.execPath,
          HUB_CODEX_ARGS_PREFIX: JSON.stringify([script]),
          HUB_DATA_DIR: join(tmp, "live-data"),
          FAKE_LOG: log,
        },
        stdio: ["ignore", "pipe", "inherit"],
      });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("error", reject);
      child.on("close", () => resolveOutput(out));
    });
    const live = JSON.parse(output.trim().split("\n").pop() ?? "null") as { source: string; primary: unknown; secondary: unknown; planType: string } | null;
    assert.ok(live);
    assert.equal(live.source, "live");
    assert.deepEqual(live.primary, { usedPercent: 12, resetsAt: 1_900_000_000_000, reset: false });
    assert.deepEqual(live.secondary, { usedPercent: 45, resetsAt: 1_900_500_000_000, reset: false });
    assert.equal(live.planType, "pro");
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["initialize", "initialized", "account/rateLimits/read"]);
  });
});

describe("refresh and snapshot", () => {
  it("answers nulls and does not touch the network when the feature is off", async () => {
    writeCredentials(T0 + 10 * 3_600_000);
    const double = fetchDouble(() => jsonResponse(USAGE_FIXTURE));
    const payload = await refreshLimits(settingsWith({ limits: false }), { now: T0, fetchImpl: double.impl, credentialsPath, statePath, codexSessionsDir: sessionsDir });
    assert.deepEqual(payload, { updatedAt: null, claude: null, codex: null });
    assert.equal(double.calls.length, 0);
    assert.deepEqual(limitsSnapshot(settingsWith({ limits: false })), { updatedAt: null, claude: null, codex: null });
  });

  it("merges both providers, nulls a disabled provider and broadcasts limits after a successful refresh", async () => {
    writeCredentials(T0 + 10 * 3_600_000);
    const dir = dayDir(sessionsDir, T0);
    writeFileSync(join(dir, "rollout-a.jsonl"), tokenCountLine(T0 - MINUTE, { used: 10, resetsAtSec: (T0 + 3_600_000) / 1000 }, { used: 20, resetsAtSec: (T0 + 86_400_000) / 1000 }) + "\n");
    const events: { event: string; data: unknown }[] = [];
    const off = onBroadcast((event, data) => events.push({ event, data }));
    const double = fetchDouble(() => jsonResponse(USAGE_FIXTURE));
    const sources = { now: T0, fetchImpl: double.impl, credentialsPath, statePath, codexSessionsDir: sessionsDir };
    const payload: LimitsPayload = await refreshLimits(settingsWith({}), sources);
    off();

    assert.equal(payload.updatedAt, T0);
    assert.equal(payload.claude?.source, "api");
    assert.equal(payload.claude?.stale, false);
    assert.equal(payload.codex?.source, "rollout");
    assert.equal(payload.codex?.primary.usedPercent, 10);
    assert.deepEqual(events, [{ event: "limits", data: { updatedAt: T0 } }]);

    assert.equal(limitsSnapshot(settingsWith({ claude: false }), T0).claude, null);
    assert.equal(limitsSnapshot(settingsWith({ codex: false }), T0).codex, null);
    assert.equal(limitsSnapshot(settingsWith({}), T0 + 30 * MINUTE).claude?.stale, true);
    assert.equal(limitsSnapshot(settingsWith({}), T0 + 30 * MINUTE).codex?.stale, true);
    assert.equal(limitsSnapshot(settingsWith({}), T0 + 30_000).codex?.stale, false);
  });

  it("does not broadcast when every refresh failed and keeps the previous value with an error", async () => {
    writeCredentials(T0 + 10 * 3_600_000);
    const events: string[] = [];
    const off = onBroadcast((event) => events.push(event));
    const double = fetchDouble((call) => (call === 1 ? jsonResponse(USAGE_FIXTURE) : jsonResponse({}, 429)));
    const settings = settingsWith({ codex: false });
    await refreshLimits(settings, { now: T0, fetchImpl: double.impl, credentialsPath, statePath });
    const failed = await refreshLimits(settings, { now: T0 + 2 * MINUTE, fetchImpl: double.impl, credentialsPath, statePath });
    off();
    assert.deepEqual(events, ["limits"]);
    assert.equal(failed.updatedAt, T0);
    assert.equal(failed.claude?.error, "usage API returned 429");
    assert.equal(failed.claude?.stale, true);
    assert.equal(failed.claude?.fiveHour.utilization, 42.5);
  });

  it("uses the live source when opted in and falls back to the rollout snapshot with an error otherwise", async () => {
    const dir = dayDir(sessionsDir, T0);
    writeFileSync(join(dir, "rollout-a.jsonl"), tokenCountLine(T0 - MINUTE, { used: 10, resetsAtSec: (T0 + 3_600_000) / 1000 }, { used: 20, resetsAtSec: (T0 + 86_400_000) / 1000 }) + "\n");
    const settings = settingsWith({ claude: false });
    process.env.HUB_CODEX_LIVE_LIMITS = "1";
    const live = {
      source: "live" as const,
      fetchedAt: T0,
      stale: false,
      primary: { usedPercent: 50, resetsAt: T0 + 3_600_000, reset: false },
      secondary: { usedPercent: 60, resetsAt: T0 + 86_400_000, reset: false },
      planType: "pro",
      error: null,
    };
    const ok = await refreshLimits(settings, { now: T0, codexSessionsDir: sessionsDir, codexLive: () => Promise.resolve(live) });
    assert.equal(ok.codex?.source, "live");
    assert.equal(ok.codex?.primary.usedPercent, 50);
    resetLimitsState();
    const failed = await refreshLimits(settings, { now: T0, codexSessionsDir: sessionsDir, codexLive: () => Promise.reject(new Error("boom")) });
    assert.equal(failed.codex?.source, "rollout");
    assert.match(failed.codex?.error ?? "", /live read failed/);
  });
});

describe("polling", () => {
  it("starts with an immediate refresh, stays a single timer, and stops with the settings", async () => {
    writeCredentials(T0 + 10 * 3_600_000);
    const double = fetchDouble(() => jsonResponse(USAGE_FIXTURE));
    const sources = { fetchImpl: double.impl, credentialsPath, statePath, codexSessionsDir: sessionsDir };
    assert.equal(limitsPollingActive(), false);

    startLimitsPolling(settingsWith({ limits: false }), sources);
    assert.equal(limitsPollingActive(), false);
    startLimitsPolling(settingsWith({ claude: false, codex: false }), sources);
    assert.equal(limitsPollingActive(), false);

    startLimitsPolling(settingsWith({ codex: false }), sources);
    assert.equal(limitsPollingActive(), true);
    await waitFor(async () => (double.calls.length === 1 ? true : null), 2000);
    startLimitsPolling(settingsWith({ codex: false }), sources);
    startLimitsPolling(settingsWith({ codex: false, refreshMinutes: 10 }), sources);
    assert.equal(limitsPollingActive(), true);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.equal(double.calls.length, 1);

    startLimitsPolling(settingsWith({ limits: false }), sources);
    assert.equal(limitsPollingActive(), false);
    startLimitsPolling(settingsWith({}), sources);
    assert.equal(limitsPollingActive(), true);
    stopLimitsPolling();
    assert.equal(limitsPollingActive(), false);
  });
});

interface SeenRequest {
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

describe("limits routes", () => {
  let box: Sandbox;
  let hub: RunningServer;
  let usageServer: Server;
  let usagePort = 0;
  const requests: SeenRequest[] = [];
  let hubLog = "";

  const http = async (method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: unknown }> => {
    const res = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, text, json };
  };

  before(async () => {
    box = makeSandbox("cchub-limits-routes-");
    usageServer = createServer((req, res) => {
      requests.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(USAGE_FIXTURE));
    });
    await new Promise<void>((resolveListen) => usageServer.listen(0, "127.0.0.1", resolveListen));
    const address = usageServer.address();
    usagePort = typeof address === "object" && address ? address.port : 0;

    const routeCredentials = join(box.tmp, "route-credentials.json");
    const routeState = join(box.tmp, "route-state.json");
    writeFileSync(routeCredentials, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: "REFRESH-SECRET", expiresAt: Date.now() + 10 * 3_600_000 } }));
    writeFileSync(routeState, JSON.stringify({ accountUuid: "ACCOUNT-UUID-SECRET", cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: "ACCOUNT-UUID-SECRET", utilization: USAGE_FIXTURE } }));
    const now = Date.now();
    const dir = dayDir(join(box.codexHome, "sessions"), now);
    writeFileSync(join(dir, "rollout-limits.jsonl"), tokenCountLine(now - MINUTE, { used: 37, resetsAtSec: Math.floor((now + 3_600_000) / 1000) }, { used: 9, resetsAtSec: Math.floor((now + 86_400_000) / 1000) }) + "\n");

    hub = await startServer(box, {
      HUB_DELEGATION: "1",
      HUB_CLAUDE_CREDENTIALS: routeCredentials,
      HUB_CLAUDE_STATE: routeState,
      HUB_CLAUDE_USAGE_URL: `http://127.0.0.1:${usagePort}/api/oauth/usage`,
    });
    hub.child.stdout?.on("data", (chunk: Buffer) => (hubLog += chunk.toString()));
    hub.child.stderr?.on("data", (chunk: Buffer) => (hubLog += chunk.toString()));
  });

  after(async () => {
    hub.child.kill();
    await new Promise<void>((resolveClose) => usageServer.close(() => resolveClose()));
  });

  it("answers nulls and makes no call while the feature is off", async () => {
    const get = await http("GET", "/delegation/limits");
    assert.equal(get.status, 200);
    assert.deepEqual(get.json, { updatedAt: null, claude: null, codex: null });
    const post = await http("POST", "/delegation/limits/refresh");
    assert.deepEqual(post.json, { updatedAt: null, claude: null, codex: null });
    assert.equal(requests.length, 0);
  });

  it("serves both providers after enabling, calls the API once with the right headers, and never leaks the token", async () => {
    const controller = new AbortController();
    const stream = await fetch(`${hub.base}/api/events`, { signal: controller.signal });
    const reader = stream.body?.getReader();
    assert.ok(reader);
    let received = "";
    const decoder = new TextDecoder();
    const pump = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          received += decoder.decode(chunk.value);
        }
      } catch {
        return;
      }
    })();

    const enabled = await http("PUT", "/delegation/settings", { features: { limits: true }, limits: { claude: true, codex: true, refreshMinutes: 5 } });
    assert.equal(enabled.status, 200);

    const get = await http("GET", "/delegation/limits");
    assert.equal(get.status, 200);
    const body = get.json as LimitsPayload;
    assert.equal(typeof body.updatedAt, "number");
    assert.equal(body.claude?.source, "api");
    assert.equal(body.claude?.stale, false);
    assert.equal(body.claude?.error, null);
    assert.deepEqual(body.claude?.fiveHour, { utilization: 42.5, resetsAt: Date.parse("2026-09-30T15:00:00.000Z") });
    assert.deepEqual(body.claude?.models.map((model) => model.name), ["Opus", "Fable"]);
    assert.deepEqual(body.claude?.extra, { enabled: true, utilization: 20 });
    assert.equal(body.codex?.source, "rollout");
    assert.equal(body.codex?.primary.usedPercent, 37);
    assert.equal(body.codex?.primary.reset, false);
    assert.equal(body.codex?.secondary.usedPercent, 9);
    assert.equal(body.codex?.planType, "plus");

    const refreshed = await http("POST", "/delegation/limits/refresh");
    assert.equal(refreshed.status, 200);
    assert.equal((refreshed.json as LimitsPayload).claude?.source, "api");

    assert.equal(requests.length, 1);
    const seen = requests[0];
    assert.ok(seen);
    assert.equal(seen.url, "/api/oauth/usage");
    assert.equal(seen.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(seen.headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(seen.headers["content-type"], "application/json");
    assert.match(String(seen.headers["user-agent"]), /^vbss-cchub\//);

    await waitFor(async () => (received.includes("event: limits") ? true : null), 5000);
    controller.abort();
    await pump;

    for (const text of [get.text, refreshed.text, received, hubLog]) {
      assert.ok(!text.includes(TOKEN));
      assert.ok(!text.includes("REFRESH-SECRET"));
      assert.ok(!text.includes("ACCOUNT-UUID-SECRET"));
    }
  });

  it("nulls a provider disabled in settings and goes back to nulls when the feature is turned off", async () => {
    await http("PUT", "/delegation/settings", { limits: { claude: false } });
    const partial = (await http("GET", "/delegation/limits")).json as LimitsPayload;
    assert.equal(partial.claude, null);
    assert.equal(partial.codex?.source, "rollout");
    await http("PUT", "/delegation/settings", { features: { limits: false } });
    assert.deepEqual((await http("GET", "/delegation/limits")).json, { updatedAt: null, claude: null, codex: null });
    assert.equal(requests.length, 1);
  });
});
