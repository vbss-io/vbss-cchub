import { listCodexLive } from "./codex-live.js";
import { codexHooksStatus, type CodexHooksStatus } from "./codex-hooks.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { getSettings } from "./delegation-store.js";
import { historyStatus, type HistoryIndexStatus } from "./history-index.js";
import { windowsHooks } from "./hooks-control.js";
import { mcpStatus, type McpStatus } from "./installers.js";
import { codexAppServerPid, limitsSnapshot } from "./limits.js";
import { statuslineStatus, type StatuslineStatus } from "./claude-statusline.js";
import { tunnelStatus, type TunnelStatus } from "./tunnel.js";

export const HEALTH_STATES = ["ok", "warn", "off", "error"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export type HealthFix =
  | { kind: "api"; label: string; method: "POST"; path: string; body?: Record<string, string> }
  | { kind: "navigate"; label: string; hash: string };

export interface HealthItem {
  id: string;
  label: string;
  state: HealthState;
  detail: string;
  fixAction: HealthFix | null;
}

export interface HealthReport {
  checkedAt: number;
  state: HealthState;
  items: HealthItem[];
}

export interface ClaudeHooksFacts {
  installed: boolean;
  outdated: boolean;
  error: string | null;
}

export interface HealthInputs {
  now: number;
  claudeHooks: ClaudeHooksFacts;
  claudeLastEventAt: number | null;
  codexHooks: Pick<CodexHooksStatus, "installed" | "updateAvailable" | "error" | "missing">;
  codexLastEventAt: number | null;
  mcpClaude: Pick<McpStatus, "installed" | "updateAvailable" | "error">;
  mcpCodex: Pick<McpStatus, "installed" | "updateAvailable" | "error">;
  statusline: Pick<StatuslineStatus, "state" | "error">;
  codexLive: { enabled: boolean; pid: number | null; source: string | null; error: string | null };
  share: { enabled: boolean; tunnel: Pick<TunnelStatus, "state" | "error" | "endpointError" | "publicUrl" | "installed"> };
  history: Pick<HistoryIndexStatus, "enabled" | "running" | "progress" | "sessions" | "files" | "lastBuildAt" | "lastError">;
}

const MEMORY_SETTINGS_HASH = "#/settings/memory";
const LIMITS_SETTINGS_HASH = "#/settings/plugin-limits";
const STATUS_TIMEOUT_MS = 8_000;

export function ago(at: number | null, now: number): string {
  if (at === null) return "no event received yet";
  const minutes = Math.max(Math.round((now - at) / 60_000), 0);
  if (minutes < 1) return "last event just now";
  if (minutes < 60) return `last event ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `last event ${hours} h ago`;
  return `last event ${Math.round(hours / 24)} days ago`;
}

const api = (label: string, path: string, body?: Record<string, string>): HealthFix => ({ kind: "api", label, method: "POST", path, ...(body ? { body } : {}) });

function claudeHooksItem(input: HealthInputs): HealthItem {
  const base = { id: "claude-hooks", label: "Claude Code hooks" };
  const { installed, outdated, error } = input.claudeHooks;
  if (error) return { ...base, state: "error", detail: error, fixAction: api("Install hooks", "/api/hooks/install") };
  if (installed && !outdated) return { ...base, state: "ok", detail: `Installed, ${ago(input.claudeLastEventAt, input.now)}`, fixAction: null };
  if (outdated) return { ...base, state: "warn", detail: "An update to the hooks is available", fixAction: api("Update hooks", "/api/hooks/install") };
  return { ...base, state: "off", detail: "Not installed", fixAction: api("Install hooks", "/api/hooks/install") };
}

function codexHooksItem(input: HealthInputs): HealthItem {
  const base = { id: "codex-hooks", label: "Codex hooks" };
  const fix = (label: string): HealthFix => api(label, "/delegation/connect/codex-hooks", { action: "install" });
  const status = input.codexHooks;
  if (status.error) return { ...base, state: "error", detail: status.error, fixAction: fix("Install hooks") };
  if (status.installed) return { ...base, state: "ok", detail: `Installed, ${ago(input.codexLastEventAt, input.now)}`, fixAction: null };
  if (status.updateAvailable) return { ...base, state: "warn", detail: `Update available (missing ${status.missing.join(", ")})`, fixAction: fix("Update hooks") };
  return { ...base, state: "off", detail: "Not installed", fixAction: fix("Install hooks") };
}

function mcpItem(id: string, label: string, client: string, status: HealthInputs["mcpClaude"]): HealthItem {
  const fix = (text: string): HealthFix => api(text, "/delegation/connect/mcp", { client, action: "install" });
  if (status.error) return { id, label, state: "error", detail: status.error, fixAction: fix("Register") };
  if (status.installed && status.updateAvailable) return { id, label, state: "warn", detail: "Registered with an outdated entry", fixAction: fix("Update registration") };
  if (status.installed) return { id, label, state: "ok", detail: "Registered", fixAction: null };
  return { id, label, state: "off", detail: "Not registered", fixAction: fix("Register") };
}

function statuslineItem(input: HealthInputs): HealthItem {
  const base = { id: "claude-statusline", label: "Claude statusline" };
  const fix = (label: string): HealthFix => api(label, "/delegation/limits/claude-source/install");
  if (input.statusline.error) return { ...base, state: "error", detail: input.statusline.error, fixAction: fix("Install statusline") };
  if (input.statusline.state === "installed") return { ...base, state: "ok", detail: "Installed", fixAction: null };
  if (input.statusline.state === "outdated") return { ...base, state: "warn", detail: "An update is available", fixAction: fix("Update statusline") };
  return { ...base, state: "off", detail: "Not installed", fixAction: fix("Install statusline") };
}

function codexLiveItem(input: HealthInputs): HealthItem {
  const base = { id: "codex-app-server", label: "Codex app-server (live limits)" };
  const live = input.codexLive;
  if (!live.enabled) return { ...base, state: "off", detail: "Live Codex limits are off", fixAction: { kind: "navigate", label: "Open Limits settings", hash: LIMITS_SETTINGS_HASH } };
  if (live.pid !== null && live.source === "live" && live.error === null) return { ...base, state: "ok", detail: `Running (pid ${live.pid})`, fixAction: null };
  if (live.pid !== null) return { ...base, state: "warn", detail: live.error ?? "Running, no live reading yet", fixAction: api("Refresh limits", "/delegation/limits/refresh") };
  return { ...base, state: "error", detail: live.error ?? "Not running", fixAction: api("Refresh limits", "/delegation/limits/refresh") };
}

function shareItem(input: HealthInputs): HealthItem {
  const base = { id: "share-tunnel", label: "Share tunnel" };
  const { enabled, tunnel } = input.share;
  const start: HealthFix = tunnel.installed ? api("Start tunnel", "/delegation/tunnel/start") : api("Install ngrok", "/delegation/tunnel/install");
  if (!enabled) return { ...base, state: "off", detail: "The Share plugin is off", fixAction: null };
  if (tunnel.endpointError) return { ...base, state: "error", detail: `Share endpoint could not listen: ${tunnel.endpointError}`, fixAction: null };
  if (tunnel.state === "running") return { ...base, state: "ok", detail: tunnel.publicUrl ? `Running at ${tunnel.publicUrl}` : "Running", fixAction: null };
  if (tunnel.state === "error") return { ...base, state: "error", detail: tunnel.error ?? "The tunnel failed", fixAction: start };
  if (tunnel.state === "starting" || tunnel.state === "installing") return { ...base, state: "warn", detail: tunnel.state === "starting" ? "Starting" : "Installing ngrok", fixAction: null };
  return { ...base, state: "off", detail: "Stopped", fixAction: start };
}

function historyItem(input: HealthInputs): HealthItem {
  const base = { id: "history-index", label: "History search index" };
  const status = input.history;
  if (!status.enabled) return { ...base, state: "off", detail: "The history index is turned off", fixAction: { kind: "navigate", label: "Open Memory settings", hash: MEMORY_SETTINGS_HASH } };
  if (status.lastError) return { ...base, state: "error", detail: status.lastError, fixAction: api("Rebuild index", "/delegation/memory/history/rebuild") };
  if (status.running) {
    const progress = status.progress ? ` (${status.progress.done}/${status.progress.total} files)` : "";
    return { ...base, state: "ok", detail: `Indexing${progress}`, fixAction: null };
  }
  if (status.lastBuildAt === null && status.files === 0) return { ...base, state: "warn", detail: "Not built yet", fixAction: api("Build index", "/delegation/memory/history/run") };
  return { ...base, state: "ok", detail: `${status.sessions} sessions indexed`, fixAction: null };
}

const SEVERITY: Record<HealthState, number> = { ok: 0, off: 1, warn: 2, error: 3 };

export function worstState(items: readonly HealthItem[]): HealthState {
  return items.reduce<HealthState>((worst, item) => (SEVERITY[item.state] > SEVERITY[worst] ? item.state : worst), "ok");
}

export function buildHealth(input: HealthInputs): HealthReport {
  const items = [
    claudeHooksItem(input),
    codexHooksItem(input),
    mcpItem("mcp-claude-code", "MCP in Claude Code", "claude-code", input.mcpClaude),
    mcpItem("mcp-codex", "MCP in Codex", "codex", input.mcpCodex),
    statuslineItem(input),
    codexLiveItem(input),
    shareItem(input),
    historyItem(input),
  ];
  return { checkedAt: input.now, state: worstState(items), items };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolvePromise) => setTimeout(() => resolvePromise(fallback), ms).unref())]);
}

async function claudeHooksFacts(): Promise<ClaudeHooksFacts> {
  try {
    const status = await withTimeout(windowsHooks("status"), STATUS_TIMEOUT_MS, { error: "the hooks status check timed out" } as Record<string, unknown>);
    const error = typeof status.error === "string" ? status.error : null;
    return { installed: status.installed === true, outdated: status.outdated === true, error };
  } catch (err) {
    return { installed: false, outdated: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function safe<T>(read: () => T, fallback: (message: string) => T): T {
  try {
    return read();
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err));
  }
}

const lastEventStmt = db.prepare(`SELECT MAX(created_at) AS at FROM events`);

export async function collectHealthInputs(now: number = Date.now()): Promise<HealthInputs> {
  const settings = getSettings();
  const codexLive = listCodexLive(now);
  const snapshot = limitsSnapshot(settings, now);
  const mcpFallback = (message: string) => ({ installed: false, updateAvailable: false, error: message });
  return {
    now,
    claudeHooks: await claudeHooksFacts(),
    claudeLastEventAt: (lastEventStmt.get() as { at: number | null }).at,
    codexHooks: safe<HealthInputs["codexHooks"]>(() => codexHooksStatus(settings.approvals.codexWindowSec), (message) => ({ installed: false, updateAvailable: false, error: message, missing: [] })),
    codexLastEventAt: codexLive.length > 0 ? Math.max(...codexLive.map((state) => state.updatedAt)) : null,
    mcpClaude: safe<HealthInputs["mcpClaude"]>(() => mcpStatus("claude-code"), mcpFallback),
    mcpCodex: safe<HealthInputs["mcpCodex"]>(() => mcpStatus("codex"), mcpFallback),
    statusline: safe<HealthInputs["statusline"]>(() => statuslineStatus(), (message) => ({ state: "not-installed", error: message })),
    codexLive: {
      enabled: settings.features.limits && settings.limits.codex && settings.limits.codexLive,
      pid: codexAppServerPid(),
      source: snapshot.codex?.source ?? null,
      error: snapshot.codex?.error ?? null,
    },
    share: { enabled: config.delegationEnabled && settings.features.share, tunnel: tunnelStatus() },
    history: historyStatus(),
  };
}

export async function healthReport(): Promise<HealthReport> {
  return buildHealth(await collectHealthInputs());
}
