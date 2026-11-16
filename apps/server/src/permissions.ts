import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { broadcast } from "./sse.js";

export const PERMISSION_AGENTS = ["claude", "codex"] as const;
export type PermissionAgent = (typeof PERMISSION_AGENTS)[number];

export type PermissionBehavior = "allow" | "deny";

export type PermissionOutcome = "allow" | "deny" | "expired" | "superseded" | "withdrawn";

export const SUBAGENT_WINDOW_CAP_SEC = 20;
export const DECISION_MESSAGE_MAX = 2000;

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
  timer: NodeJS.Timeout;
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
  for (const waiter of entry.waiters) waiter(decision);
  entry.waiters.clear();
  const resolved: PermissionResolved = { id, agent: entry.record.agent, sessionId: entry.record.sessionId, outcome, at: Date.now() };
  broadcast("permission-resolved", resolved);
  return entry.record;
}

export function openPermissionRequest(input: PermissionRequestInput, windowMs: number, now: number = Date.now()): PermissionRequestRecord | null {
  if (windowMs <= 0) return null;
  const record: PermissionRequestRecord = { ...input, id: randomUUID(), windowMs, createdAt: now, expiresAt: now + windowMs };
  const timer = setTimeout(() => settle(record.id, "expired", null), windowMs);
  timer.unref();
  pending.set(record.id, { record, timer, waiters: new Set() });
  broadcast("permission-request", record);
  return record;
}

export function listPermissionRequests(): PermissionRequestRecord[] {
  return [...pending.values()].map((entry) => entry.record).sort((a, b) => a.createdAt - b.createdAt);
}

export function getPermissionRequest(id: string): PermissionRequestRecord | null {
  return pending.get(id)?.record ?? null;
}

export function waitForDecision(id: string, onDecision: (decision: PermissionDecision | null) => void): (() => void) | null {
  const entry = pending.get(id);
  if (!entry) return null;
  entry.waiters.add(onDecision);
  return () => {
    entry.waiters.delete(onDecision);
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
