import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import type { DelegationSettings } from "./delegation-types.js";
import { broadcast } from "./sse.js";

export interface LimitWindow {
  utilization: number;
  resetsAt: number | null;
  reset: boolean;
}

export interface ClaudeModelLimit extends LimitWindow {
  name: string;
}

export interface ClaudeLimits {
  source: "api" | "cache" | "none";
  fetchedAt: number | null;
  stale: boolean;
  fiveHour: LimitWindow;
  sevenDay: LimitWindow;
  models: ClaudeModelLimit[];
  extra: { enabled: boolean; utilization: number | null } | null;
  error: string | null;
}

export interface CodexWindow {
  usedPercent: number;
  resetsAt: number | null;
  reset: boolean;
}

export interface CodexLimits {
  source: "rollout" | "live" | "none";
  fetchedAt: number | null;
  stale: boolean;
  primary: CodexWindow;
  secondary: CodexWindow;
  planType: string | null;
  error: string | null;
}

export interface LimitsPayload {
  updatedAt: number | null;
  claude: ClaudeLimits | null;
  codex: CodexLimits | null;
}

export interface ClaudeCredentials {
  accessToken: string;
  expiresAt: number | null;
}

export interface LimitsSources {
  now?: number;
  fetchImpl?: typeof fetch;
  credentialsPath?: string;
  statePath?: string;
  usageUrl?: string;
  codexSessionsDir?: string;
  codexLive?: () => Promise<CodexLimits | null>;
  sleep?: (ms: number) => Promise<void>;
}

const REQUEST_TIMEOUT_MS = 5_000;
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;
const MIN_CALL_GAP_MS = 60_000;
const TRANSIENT_RETRY_DELAY_MS = 20_000;
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const LIVE_TIMEOUT_MS = 8_000;
const ROLLOUT_LOOKBACK_DAYS = 14;
const ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;
const MIN_STALE_AFTER_MS = 10 * 60_000;
const NO_CLAUDE_LOGIN = "no Claude Code login found";
const NO_CODEX_DATA = "no Codex session data found";
const CODEX_LIVE_UNAVAILABLE = "codex live limits unavailable";
const MODEL_WINDOWS: readonly (readonly [string, string])[] = [
  ["Opus", "seven_day_opus"],
  ["Sonnet", "seven_day_sonnet"],
];

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isoToMs(value: unknown): number | null {
  const text = asString(value);
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function parseWindow(value: unknown): LimitWindow | null {
  const obj = asObject(value);
  if (!obj) return null;
  const utilization = asNumber(obj.utilization);
  const resetsAt = isoToMs(obj.resets_at);
  if (utilization === null && resetsAt === null) return null;
  return { utilization: clampPercent(utilization ?? 0), resetsAt, reset: false };
}

function emptyWindow(): LimitWindow {
  return { utilization: 0, resetsAt: null, reset: false };
}

interface ParsedClaude {
  fiveHour: LimitWindow;
  sevenDay: LimitWindow;
  models: ClaudeModelLimit[];
  extra: { enabled: boolean; utilization: number | null } | null;
}

export function parseClaudeUsage(raw: unknown): ParsedClaude | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const fiveHour = parseWindow(obj.five_hour);
  const sevenDay = parseWindow(obj.seven_day);
  const entries = Array.isArray(obj.limits) ? obj.limits : [];
  if (!fiveHour && !sevenDay && entries.length === 0) return null;

  const models: ClaudeModelLimit[] = [];
  const seen = new Set<string>();
  const add = (name: string, window: LimitWindow): void => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    models.push({ name, utilization: window.utilization, resetsAt: window.resetsAt, reset: false });
  };
  for (const [name, key] of MODEL_WINDOWS) {
    const window = parseWindow(obj[key]);
    if (window) add(name, window);
  }
  for (const entry of entries) {
    const limit = asObject(entry);
    if (!limit || limit.group === "session") continue;
    const name = asString(asObject(asObject(limit.scope)?.model)?.display_name);
    const percent = asNumber(limit.percent);
    if (name === null || percent === null) continue;
    add(name, { utilization: clampPercent(percent), resetsAt: isoToMs(limit.resets_at), reset: false });
  }

  const extraObj = asObject(obj.extra_usage);
  const extraUtilization = extraObj ? asNumber(extraObj.utilization) : null;
  const extra = extraObj
    ? { enabled: extraObj.is_enabled === true, utilization: extraUtilization === null ? null : clampPercent(extraUtilization) }
    : null;

  return {
    fiveHour: fiveHour ?? emptyWindow(),
    sevenDay: sevenDay ?? emptyWindow(),
    models,
    extra,
  };
}

export function readClaudeCredentials(path: string = config.claudeCredentialsPath): ClaudeCredentials | null {
  try {
    const parsed = asObject(JSON.parse(readFileSync(path, "utf8")));
    const oauth = asObject(parsed?.claudeAiOauth);
    const accessToken = asString(oauth?.accessToken);
    if (accessToken === null) return null;
    return { accessToken, expiresAt: asNumber(oauth?.expiresAt) };
  } catch {
    return null;
  }
}

export function readClaudeCachedLimits(path: string = config.claudeStatePath): ClaudeLimits | null {
  try {
    const parsed = asObject(JSON.parse(readFileSync(path, "utf8")));
    const cached = asObject(parsed?.cachedUsageUtilization);
    const fetchedAt = asNumber(cached?.fetchedAtMs);
    const usage = parseClaudeUsage(cached?.utilization);
    if (fetchedAt === null || usage === null) return null;
    return { source: "cache", fetchedAt, stale: false, ...usage, error: null };
  } catch {
    return null;
  }
}

interface ClaudeState {
  value: ClaudeLimits | null;
  attemptedAt: number | null;
  lastCallAt: number | null;
  backoffUntil: number;
  backoffStep: number;
  lastError: string | null;
}

interface CodexState {
  value: CodexLimits | null;
  attemptedAt: number | null;
  lastError: string | null;
}

interface LimitsState {
  claude: ClaudeState;
  codex: CodexState;
}

function freshState(): LimitsState {
  return {
    claude: { value: null, attemptedAt: null, lastCallAt: null, backoffUntil: 0, backoffStep: 0, lastError: null },
    codex: { value: null, attemptedAt: null, lastError: null },
  };
}

let state = freshState();

export function resetLimitsState(): void {
  state = freshState();
}

function userAgent(): string {
  try {
    const pkg = asObject(JSON.parse(readFileSync(join(config.serverDir, "package.json"), "utf8")));
    return `vbss-cchub/${asString(pkg?.version) ?? "dev"}`;
  } catch {
    return "vbss-cchub/dev";
  }
}

function claudeFallback(message: string, sources: LimitsSources): ClaudeLimits | null {
  const base = state.claude.value ?? readClaudeCachedLimits(sources.statePath);
  return base ? { ...base, error: message } : null;
}

function clockLabel(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function claudeTransientFallback(message: string, sources: LimitsSources): ClaudeLimits | null {
  const last = state.claude.value;
  if (last !== null && last.source === "api" && last.fetchedAt !== null) {
    return { ...last, error: `network error, showing the value from ${clockLabel(last.fetchedAt)}` };
  }
  return claudeFallback(message, sources);
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordClaudeBackoff(now: number): void {
  const wait = Math.min(BACKOFF_BASE_MS * 2 ** state.claude.backoffStep, BACKOFF_MAX_MS);
  state.claude.backoffUntil = now + wait;
  state.claude.backoffStep += 1;
}

async function callClaudeUsage(token: string, sources: LimitsSources): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await (sources.fetchImpl ?? fetch)(sources.usageUrl ?? config.claudeUsageUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        "User-Agent": userAgent(),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchClaudeLimits(sources: LimitsSources = {}): Promise<ClaudeLimits | null> {
  const now = sources.now ?? Date.now();
  const claude = state.claude;
  claude.attemptedAt = now;

  const settle = (value: ClaudeLimits | null, error: string | null): ClaudeLimits | null => {
    claude.lastError = error;
    if (value) claude.value = value;
    return claude.value;
  };

  if (now < claude.backoffUntil) {
    return settle(claudeFallback(claude.lastError ?? "usage API backing off", sources), claude.lastError);
  }
  if (claude.lastCallAt !== null && now - claude.lastCallAt < MIN_CALL_GAP_MS) return claude.value;

  const credentials = readClaudeCredentials(sources.credentialsPath);
  if (credentials === null) {
    const message = NO_CLAUDE_LOGIN;
    return settle(claudeFallback(message, sources), message);
  }
  if (credentials.expiresAt !== null && credentials.expiresAt - now < TOKEN_EXPIRY_MARGIN_MS) {
    const message = "Claude access token expired or about to expire; open Claude Code to renew it";
    return settle(claudeFallback(message, sources), message);
  }

  claude.lastCallAt = now;
  let response: Response | null = null;
  let transientMessage = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await (sources.sleep ?? waitMs)(TRANSIENT_RETRY_DELAY_MS);
    try {
      response = await callClaudeUsage(credentials.accessToken, sources);
    } catch (error) {
      transientMessage = error instanceof Error && error.name === "AbortError" ? "usage request timed out" : "usage request failed";
      response = null;
      continue;
    }
    if (response.status < 500) break;
    transientMessage = `usage API returned ${response.status}`;
    response = null;
  }
  if (response === null) {
    return settle(claudeTransientFallback(transientMessage, sources), transientMessage);
  }

  if (response.status === 401 || response.status === 403 || response.status === 429) {
    recordClaudeBackoff(now);
    const message = `usage API returned ${response.status}`;
    return settle(claudeFallback(message, sources), message);
  }
  if (!response.ok) {
    const message = `usage API returned ${response.status}`;
    return settle(claudeFallback(message, sources), message);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const parsed = parseClaudeUsage(body);
  if (parsed === null) {
    const message = "unexpected usage response";
    return settle(claudeFallback(message, sources), message);
  }
  claude.backoffStep = 0;
  claude.backoffUntil = 0;
  return settle({ source: "api", fetchedAt: now, stale: false, ...parsed, error: null }, null);
}

function parseCodexWindow(value: unknown, usedKey: string, resetKey: string): CodexWindow | null {
  const obj = asObject(value);
  if (!obj) return null;
  const used = asNumber(obj[usedKey]);
  if (used === null) return null;
  const resetsSeconds = asNumber(obj[resetKey]);
  return { usedPercent: clampPercent(used), resetsAt: resetsSeconds === null ? null : resetsSeconds * 1000, reset: false };
}

function buildCodexLimits(
  primary: CodexWindow | null,
  secondary: CodexWindow | null,
  planType: unknown,
  source: CodexLimits["source"],
  fetchedAt: number,
): CodexLimits | null {
  if (!primary && !secondary) return null;
  const empty: CodexWindow = { usedPercent: 0, resetsAt: null, reset: false };
  return {
    source,
    fetchedAt,
    stale: false,
    primary: primary ?? empty,
    secondary: secondary ?? empty,
    planType: asString(planType),
    error: null,
  };
}

export function parseCodexRateLimits(raw: unknown, fetchedAt: number): CodexLimits | null {
  const obj = asObject(raw);
  if (!obj) return null;
  return buildCodexLimits(
    parseCodexWindow(obj.primary, "used_percent", "resets_at"),
    parseCodexWindow(obj.secondary, "used_percent", "resets_at"),
    obj.plan_type,
    "rollout",
    fetchedAt,
  );
}

function applyCodexReset(window: CodexWindow, now: number): CodexWindow {
  if (window.resetsAt !== null && window.resetsAt <= now) return { usedPercent: 0, resetsAt: null, reset: true };
  return window;
}

function resolveCodexResets(value: CodexLimits, now: number): CodexLimits {
  return { ...value, primary: applyCodexReset(value.primary, now), secondary: applyCodexReset(value.secondary, now) };
}

function dayDirs(root: string, days: number, now: number): string[] {
  const dirs: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(now - offset * 86_400_000);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    dirs.push(join(root, year, month, day));
  }
  return dirs;
}

function readTail(file: string, bytes: number): string {
  const size = statSync(file).size;
  const length = Math.min(size, bytes);
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function newestRateLimits(file: string, fileMtimeMs: number): { rateLimits: unknown; at: number } | null {
  const lines = readTail(file, ROLLOUT_TAIL_BYTES).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!line.includes("token_count") || !line.includes("rate_limits")) continue;
    try {
      const record = asObject(JSON.parse(line));
      const payload = asObject(record?.payload);
      if (record?.type !== "event_msg" || payload?.type !== "token_count") continue;
      if (!asObject(payload.rate_limits)) continue;
      return { rateLimits: payload.rate_limits, at: isoToMs(record.timestamp) ?? fileMtimeMs };
    } catch {
      continue;
    }
  }
  return null;
}

export function readCodexRolloutLimits(options: { root?: string; now?: number; days?: number } = {}): CodexLimits | null {
  const root = options.root ?? config.codexSessionsDir;
  const now = options.now ?? Date.now();
  for (const dir of dayDirs(root, options.days ?? ROLLOUT_LOOKBACK_DAYS, now)) {
    if (!existsSync(dir)) continue;
    let files: { file: string; mtimeMs: number }[];
    try {
      files = readdirSync(dir)
        .filter((entry) => entry.endsWith(".jsonl"))
        .map((entry) => ({ file: join(dir, entry), mtimeMs: statSync(join(dir, entry)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
      continue;
    }
    for (const { file, mtimeMs } of files) {
      try {
        const found = newestRateLimits(file, mtimeMs);
        if (!found) continue;
        const parsed = parseCodexRateLimits(found.rateLimits, found.at);
        if (parsed) return resolveCodexResets(parsed, now);
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function readCodexLimitsLive(timeoutMs: number = LIVE_TIMEOUT_MS): Promise<CodexLimits | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const child = spawn(config.codexBin, [...config.codexArgsPrefix, "app-server", "--listen", "stdio://"], {
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const finish = (value: CodexLimits | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {
        void 0;
      }
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdin.on("error", () => finish(null));
    const send = (message: Json): void => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish(null);
      }
    };
    const handle = (line: string): void => {
      let message: Json | null;
      try {
        message = asObject(JSON.parse(line));
      } catch {
        return;
      }
      if (!message) return;
      if (message.id === 1) {
        if (message.error !== undefined) return finish(null);
        send({ method: "initialized" });
        send({ id: 2, method: "account/rateLimits/read" });
        return;
      }
      if (message.id !== 2) return;
      const snapshot = asObject(asObject(message.result)?.rateLimits);
      if (!snapshot) return finish(null);
      finish(
        buildCodexLimits(
          parseCodexWindow(snapshot.primary, "usedPercent", "resetsAt"),
          parseCodexWindow(snapshot.secondary, "usedPercent", "resetsAt"),
          snapshot.planType,
          "live",
          Date.now(),
        ),
      );
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handle(line);
        newline = buffer.indexOf("\n");
      }
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "vbss-cchub", title: "CC Hub", version: userAgent().split("/")[1] ?? "dev" } },
    });
  });
}

async function refreshCodex(settings: DelegationSettings, sources: LimitsSources): Promise<void> {
  const now = sources.now ?? Date.now();
  const codex = state.codex;
  codex.attemptedAt = now;
  let liveFailed = false;
  if (settings.limits.codexLive) {
    let live: CodexLimits | null = null;
    try {
      live = await (sources.codexLive ?? (() => readCodexLimitsLive()))();
    } catch {
      live = null;
    }
    if (live) {
      codex.value = live;
      codex.lastError = null;
      return;
    }
    liveFailed = true;
  }
  let rollout: CodexLimits | null = null;
  let readFailed = false;
  try {
    rollout = readCodexRolloutLimits({ root: sources.codexSessionsDir, now });
  } catch {
    readFailed = true;
  }
  const error = liveFailed ? CODEX_LIVE_UNAVAILABLE : readFailed ? "could not read Codex rollouts" : NO_CODEX_DATA;
  if (rollout) {
    codex.value = liveFailed ? { ...rollout, error: CODEX_LIVE_UNAVAILABLE } : rollout;
    codex.lastError = liveFailed ? CODEX_LIVE_UNAVAILABLE : null;
    return;
  }
  codex.lastError = error;
  if (codex.value) codex.value = { ...codex.value, error };
}

function staleAfterMs(settings: DelegationSettings): number {
  return Math.max(settings.limits.refreshMinutes * 2 * 60_000, MIN_STALE_AFTER_MS);
}

function resolveWindowReset(window: LimitWindow, now: number): LimitWindow {
  if (window.resetsAt !== null && window.resetsAt <= now) return { utilization: 0, resetsAt: null, reset: true };
  return window;
}

function resolveClaudeResets(value: ClaudeLimits, now: number): ClaudeLimits {
  return {
    ...value,
    fiveHour: resolveWindowReset(value.fiveHour, now),
    sevenDay: resolveWindowReset(value.sevenDay, now),
    models: value.models.map((model) => ({ name: model.name, ...resolveWindowReset(model, now) })),
  };
}

function noClaudeLimits(error: string): ClaudeLimits {
  return { source: "none", fetchedAt: null, stale: true, fiveHour: emptyWindow(), sevenDay: emptyWindow(), models: [], extra: null, error };
}

function noCodexLimits(error: string): CodexLimits {
  const empty: CodexWindow = { usedPercent: 0, resetsAt: null, reset: false };
  return { source: "none", fetchedAt: null, stale: true, primary: empty, secondary: empty, planType: null, error };
}

function successfulFetchedAt(value: { source: string; fetchedAt: number | null } | null): number | null {
  return value !== null && value.source !== "none" && value.source !== "cache" ? value.fetchedAt : null;
}

function refreshedCleanly(value: { source: string; error: string | null } | null): boolean {
  return value !== null && value.source !== "none" && value.error === null;
}

function latestUpdate(settings: DelegationSettings): number | null {
  const times = [
    settings.limits.claude ? successfulFetchedAt(state.claude.value) : null,
    settings.limits.codex ? successfulFetchedAt(state.codex.value) : null,
  ].filter((time): time is number => time !== null);
  return times.length > 0 ? Math.max(...times) : null;
}

export function limitsSnapshot(settings: DelegationSettings, now: number = Date.now()): LimitsPayload {
  if (!settings.features.limits) return { updatedAt: null, claude: null, codex: null };
  const staleAfter = staleAfterMs(settings);
  const isStale = (value: { fetchedAt: number | null; error: string | null }): boolean =>
    value.error !== null || value.fetchedAt === null || now - value.fetchedAt > staleAfter;
  let claude: ClaudeLimits | null = null;
  if (settings.limits.claude) {
    const value = state.claude.value;
    claude = value ? { ...resolveClaudeResets(value, now), stale: isStale(value) } : noClaudeLimits(state.claude.lastError ?? NO_CLAUDE_LOGIN);
  }
  let codex: CodexLimits | null = null;
  if (settings.limits.codex) {
    const value = state.codex.value;
    codex = value ? { ...resolveCodexResets(value, now), stale: isStale(value) } : noCodexLimits(state.codex.lastError ?? NO_CODEX_DATA);
  }
  return { updatedAt: latestUpdate(settings), claude, codex };
}

let inflight: Promise<void> | null = null;

async function runRefresh(settings: DelegationSettings, sources: LimitsSources): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (settings.limits.claude) {
    tasks.push(
      fetchClaudeLimits(sources).then(
        () => undefined,
        () => undefined,
      ),
    );
  }
  if (settings.limits.codex) {
    tasks.push(refreshCodex(settings, sources).catch(() => undefined));
  }
  await Promise.all(tasks);
  const clean =
    (settings.limits.claude && refreshedCleanly(state.claude.value)) || (settings.limits.codex && refreshedCleanly(state.codex.value));
  const updatedAt = latestUpdate(settings);
  if (clean && updatedAt !== null) broadcast("limits", { updatedAt });
}

export async function refreshLimits(settings: DelegationSettings, sources: LimitsSources = {}): Promise<LimitsPayload> {
  if (!settings.features.limits) return limitsSnapshot(settings);
  if (!inflight) {
    inflight = runRefresh(settings, sources).finally(() => {
      inflight = null;
    });
  }
  await inflight;
  return limitsSnapshot(settings, sources.now);
}

export async function ensureFirstRefresh(settings: DelegationSettings, sources: LimitsSources = {}): Promise<void> {
  if (!settings.features.limits) return;
  const pending =
    (settings.limits.claude && state.claude.attemptedAt === null) || (settings.limits.codex && state.codex.attemptedAt === null);
  if (pending) await refreshLimits(settings, sources);
  else if (inflight) await inflight;
}

let pollTimer: NodeJS.Timeout | null = null;
let pollSignature: string | null = null;
let pollSettings: DelegationSettings | null = null;
let pollSources: LimitsSources = {};

export function limitsPollingActive(): boolean {
  return pollTimer !== null;
}

export function stopLimitsPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  pollSignature = null;
  pollSettings = null;
}

export function startLimitsPolling(settings: DelegationSettings, sources: LimitsSources = {}): void {
  const enabled = settings.features.limits && (settings.limits.claude || settings.limits.codex);
  if (!enabled) {
    stopLimitsPolling();
    return;
  }
  const signature = `${settings.limits.claude}:${settings.limits.codex}:${settings.limits.codexLive}:${settings.limits.refreshMinutes}`;
  pollSettings = settings;
  pollSources = sources;
  if (pollTimer && pollSignature === signature) return;
  if (pollTimer) clearInterval(pollTimer);
  pollSignature = signature;
  pollTimer = setInterval(() => {
    if (pollSettings) void refreshLimits(pollSettings, pollSources);
  }, settings.limits.refreshMinutes * 60_000);
  pollTimer.unref();
  void refreshLimits(settings, sources);
}
