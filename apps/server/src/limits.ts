import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import type { DelegationSettings } from "./delegation-types.js";
import { broadcast } from "./sse.js";

export interface LimitWindow {
  utilization: number;
  resetsAt: number | null;
}

export interface ClaudeModelLimit extends LimitWindow {
  name: string;
}

export interface ClaudeLimits {
  source: "api" | "cache";
  fetchedAt: number;
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
  source: "rollout" | "live";
  fetchedAt: number;
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
}

const REQUEST_TIMEOUT_MS = 5_000;
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60_000;
const MIN_CALL_GAP_MS = 60_000;
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const LIVE_TIMEOUT_MS = 8_000;
const ROLLOUT_LOOKBACK_DAYS = 14;
const ROLLOUT_TAIL_BYTES = 2 * 1024 * 1024;
const MIN_STALE_AFTER_MS = 10 * 60_000;
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
  return { utilization: clampPercent(utilization ?? 0), resetsAt };
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
    models.push({ name, utilization: window.utilization, resetsAt: window.resetsAt });
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
    add(name, { utilization: clampPercent(percent), resetsAt: isoToMs(limit.resets_at) });
  }

  const extraObj = asObject(obj.extra_usage);
  const extraUtilization = extraObj ? asNumber(extraObj.utilization) : null;
  const extra = extraObj
    ? { enabled: extraObj.is_enabled === true, utilization: extraUtilization === null ? null : clampPercent(extraUtilization) }
    : null;

  return {
    fiveHour: fiveHour ?? { utilization: 0, resetsAt: null },
    sevenDay: sevenDay ?? { utilization: 0, resetsAt: null },
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
}

interface LimitsState {
  claude: ClaudeState;
  codex: CodexState;
  updatedAt: number | null;
}

function freshState(): LimitsState {
  return {
    claude: { value: null, attemptedAt: null, lastCallAt: null, backoffUntil: 0, backoffStep: 0, lastError: null },
    codex: { value: null, attemptedAt: null },
    updatedAt: null,
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
    const message = "no Claude credentials found";
    return settle(claudeFallback(message, sources), message);
  }
  if (credentials.expiresAt !== null && credentials.expiresAt - now < TOKEN_EXPIRY_MARGIN_MS) {
    const message = "Claude access token expired or about to expire; open Claude Code to renew it";
    return settle(claudeFallback(message, sources), message);
  }

  claude.lastCallAt = now;
  let response: Response;
  try {
    response = await callClaudeUsage(credentials.accessToken, sources);
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError" ? "usage request timed out" : "usage request failed";
    return settle(claudeFallback(message, sources), message);
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

export function readCodexLimitsLive(): Promise<CodexLimits | null> {
  if (process.env.HUB_CODEX_LIVE_LIMITS !== "1") return Promise.resolve(null);
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
    const timer = setTimeout(() => finish(null), LIVE_TIMEOUT_MS);
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

async function refreshCodex(sources: LimitsSources): Promise<void> {
  const now = sources.now ?? Date.now();
  state.codex.attemptedAt = now;
  let live: CodexLimits | null = null;
  if (process.env.HUB_CODEX_LIVE_LIMITS === "1") {
    try {
      live = await (sources.codexLive ?? readCodexLimitsLive)();
    } catch {
      live = null;
    }
    if (live) {
      state.codex.value = live;
      return;
    }
  }
  let rollout: CodexLimits | null = null;
  let failed = false;
  try {
    rollout = readCodexRolloutLimits({ root: sources.codexSessionsDir, now });
  } catch {
    failed = true;
  }
  if (rollout) {
    state.codex.value = process.env.HUB_CODEX_LIVE_LIMITS === "1" ? { ...rollout, error: "live read failed; showing the last rollout snapshot" } : rollout;
    return;
  }
  if (state.codex.value) {
    state.codex.value = { ...state.codex.value, error: failed ? "could not read Codex rollouts" : "no Codex rate limit record found" };
  }
}

function staleAfterMs(settings: DelegationSettings): number {
  return Math.max(settings.limits.refreshMinutes * 2 * 60_000, MIN_STALE_AFTER_MS);
}

export function limitsSnapshot(settings: DelegationSettings, now: number = Date.now()): LimitsPayload {
  if (!settings.features.limits) return { updatedAt: null, claude: null, codex: null };
  const staleAfter = staleAfterMs(settings);
  const claude = settings.limits.claude ? state.claude.value : null;
  const codex = settings.limits.codex ? state.codex.value : null;
  return {
    updatedAt: state.updatedAt,
    claude: claude ? { ...claude, stale: claude.error !== null || now - claude.fetchedAt > staleAfter } : null,
    codex: codex
      ? { ...resolveCodexResets(codex, now), stale: codex.error !== null || now - codex.fetchedAt > staleAfter }
      : null,
  };
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
    tasks.push(refreshCodex(sources).catch(() => undefined));
  }
  await Promise.all(tasks);
  const now = sources.now ?? Date.now();
  const fresh =
    (settings.limits.claude && state.claude.value !== null && state.claude.value.error === null) ||
    (settings.limits.codex && state.codex.value !== null && state.codex.value.error === null);
  if (fresh) {
    state.updatedAt = now;
    broadcast("limits", { updatedAt: now });
  }
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
  const signature = `${settings.limits.claude}:${settings.limits.codex}:${settings.limits.refreshMinutes}`;
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
