import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { broadcast } from "./sse.js";

export const PERMISSION_AGENTS = ["claude", "codex"] as const;
export type PermissionAgent = (typeof PERMISSION_AGENTS)[number];

export type PermissionBehavior = "allow" | "deny";

export type PermissionOutcome = "allow" | "deny" | "expired" | "superseded" | "withdrawn";

export const SUBAGENT_WINDOW_CAP_SEC = 20;
export const DECISION_MESSAGE_MAX = 2000;
export const WAITER_GRACE_MS = 3_000;

export interface PermissionRequestInput {
  agent: PermissionAgent;
  sessionId: string;
  agentId: string | null;
  toolName: string;
  toolInput: unknown;
  cwd: string | null;
  turnId: string | null;
  title: string | null;
}

export interface PermissionRequestRecord extends PermissionRequestInput {
  id: string;
  windowMs: number;
  createdAt: number;
  expiresAt: number;
}

export type PermissionRequestSummary = Omit<PermissionRequestRecord, "toolInput" | "cwd" | "turnId">;

export interface OpenedPermission {
  record: PermissionRequestRecord;
  waitToken: string;
}

export type WaitAttach = { status: "gone" } | { status: "forbidden" } | { status: "waiting"; stop: () => void };

export interface PermissionDecision {
  behavior: PermissionBehavior;
  message: string | null;
}

export interface PermissionResolved {
  id: string;
  agent: PermissionAgent;
  sessionId: string;
  outcome: PermissionOutcome;
  at: number;
}

export interface SessionMove {
  agent: PermissionAgent;
  sessionId: string;
  agentId: string | null;
  scope: "tool" | "turn" | "agent" | "session";
  toolName: string | null;
  toolInput: unknown;
}

interface Pending {
  record: PermissionRequestRecord;
  waitToken: string;
  timer: NodeJS.Timeout;
  graceTimer: NodeJS.Timeout | null;
  waiters: Set<(decision: PermissionDecision | null) => void>;
}

const pending = new Map<string, Pending>();

export function windowMsFor(windowSec: number, agentId: string | null): number {
  const capped = agentId ? Math.min(windowSec, SUBAGENT_WINDOW_CAP_SEC) : windowSec;
  return Math.max(0, Math.round(capped)) * 1000;
}

function settle(id: string, outcome: PermissionOutcome, decision: PermissionDecision | null): PermissionRequestRecord | null {
  const entry = pending.get(id);
  if (!entry) return null;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (entry.graceTimer) clearTimeout(entry.graceTimer);
  for (const waiter of entry.waiters) waiter(decision);
  entry.waiters.clear();
  const resolved: PermissionResolved = { id, agent: entry.record.agent, sessionId: entry.record.sessionId, outcome, at: Date.now() };
  broadcast("permission-resolved", resolved);
  return entry.record;
}

export const permissionSummary = (record: PermissionRequestRecord): PermissionRequestSummary => ({
  id: record.id,
  agent: record.agent,
  sessionId: record.sessionId,
  agentId: record.agentId,
  toolName: record.toolName,
  title: record.title,
  windowMs: record.windowMs,
  createdAt: record.createdAt,
  expiresAt: record.expiresAt,
});

export function openPermissionRequest(
  input: PermissionRequestInput,
  windowMs: number,
  options: { now?: number; graceMs?: number } = {},
): OpenedPermission | null {
  if (windowMs <= 0) return null;
  const now = options.now ?? Date.now();
  const record: PermissionRequestRecord = { ...input, id: randomUUID(), windowMs, createdAt: now, expiresAt: now + windowMs };
  const waitToken = randomBytes(24).toString("base64url");
  const timer = setTimeout(() => settle(record.id, "expired", null), windowMs);
  timer.unref();
  const graceTimer = setTimeout(() => {
    const entry = pending.get(record.id);
    if (entry && entry.waiters.size === 0) settle(record.id, "withdrawn", null);
  }, options.graceMs ?? WAITER_GRACE_MS);
  graceTimer.unref();
  pending.set(record.id, { record, waitToken, timer, graceTimer, waiters: new Set() });
  broadcast("permission-request", permissionSummary(record));
  return { record, waitToken };
}

export function listPermissionRequests(): PermissionRequestRecord[] {
  return [...pending.values()].map((entry) => entry.record).sort((a, b) => a.createdAt - b.createdAt);
}

export function getPermissionRequest(id: string): PermissionRequestRecord | null {
  return pending.get(id)?.record ?? null;
}

function tokenMatches(expected: string, given: string | null): boolean {
  if (given === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function waitForDecision(id: string, waitToken: string | null, onDecision: (decision: PermissionDecision | null) => void): WaitAttach {
  const entry = pending.get(id);
  if (!entry) return { status: "gone" };
  if (!tokenMatches(entry.waitToken, waitToken)) return { status: "forbidden" };
  if (entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }
  entry.waiters.add(onDecision);
  return {
    status: "waiting",
    stop: () => {
      entry.waiters.delete(onDecision);
    },
  };
}

export function decidePermission(id: string, decision: PermissionDecision): PermissionRequestRecord | null {
  const message = decision.behavior === "deny" && decision.message ? decision.message.slice(0, DECISION_MESSAGE_MAX) : null;
  return settle(id, decision.behavior, { behavior: decision.behavior, message });
}

export function withdrawPermission(id: string): PermissionRequestRecord | null {
  return settle(id, "withdrawn", null);
}

function targetsOf(move: SessionMove): PermissionRequestRecord[] {
  const ofSession = listPermissionRequests().filter((record) => record.agent === move.agent && record.sessionId === move.sessionId);
  if (move.scope === "session") return ofSession;
  if (move.scope === "turn") return ofSession.filter((record) => record.agentId === null);
  if (move.scope === "agent") return ofSession.filter((record) => record.agentId === move.agentId);
  const sameTool = ofSession.filter((record) => record.agentId === move.agentId && record.toolName === move.toolName);
  if (move.toolInput === undefined) return sameTool.slice(0, 1);
  const exact = sameTool.find((record) => isDeepStrictEqual(record.toolInput, move.toolInput));
  return exact ? [exact] : [];
}

export function clearForSessionMove(move: SessionMove): PermissionRequestRecord[] {
  const cleared: PermissionRequestRecord[] = [];
  for (const record of targetsOf(move)) {
    const done = settle(record.id, "superseded", null);
    if (done) cleared.push(done);
  }
  return cleared;
}

export function hasPendingPermission(agent: PermissionAgent, sessionId: string): boolean {
  return listPermissionRequests().some((record) => record.agent === agent && record.sessionId === sessionId);
}

const CLAUDE_TURN_KINDS: ReadonlySet<string> = new Set(["stop", "stop_failure"]);
const CLAUDE_SESSION_KINDS: ReadonlySet<string> = new Set(["user_prompt", "session_end"]);

export interface ClaudeHookFacts {
  kind: string;
  sessionId: string;
  agentId: string | null;
  notificationType: string | null;
  toolName: string | null;
  toolInput: unknown;
}

export function claudeSessionMove(facts: ClaudeHookFacts): SessionMove | null {
  const base = { agent: "claude" as const, sessionId: facts.sessionId, agentId: facts.agentId, toolName: facts.toolName, toolInput: facts.toolInput };
  if (facts.kind === "tool_done") return facts.toolName ? { ...base, scope: "tool" } : null;
  if (facts.kind === "subagent_stop") return facts.agentId ? { ...base, scope: "agent" } : null;
  if (CLAUDE_SESSION_KINDS.has(facts.kind)) return { ...base, scope: "session" };
  if (CLAUDE_TURN_KINDS.has(facts.kind)) return { ...base, scope: "turn" };
  if (facts.kind === "notification" && facts.notificationType === "idle_prompt") return { ...base, scope: "session" };
  return null;
}

export function clearAllPermissions(): void {
  for (const id of [...pending.keys()]) settle(id, "withdrawn", null);
}
