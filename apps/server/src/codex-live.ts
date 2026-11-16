import { basename } from "node:path";
import type { CodexSessionRecord, CodexSessionStatus } from "./codex-sessions.js";
import type { SessionMove } from "./permissions.js";

export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "Interrupt", "SessionEnd"] as const;
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

const LIVE_TTL_MS = 12 * 3_600_000;
const MAX_MESSAGE = 300;

const STATUS_BY_EVENT: Record<CodexHookEvent, CodexSessionStatus> = {
  SessionStart: "idle",
  UserPromptSubmit: "active",
  PermissionRequest: "waiting",
  PostToolUse: "active",
  Stop: "idle",
  Interrupt: "idle",
  SessionEnd: "ended",
};

export interface CodexHookFacts {
  event: CodexHookEvent;
  sessionId: string;
  cwd: string | null;
  transcriptPath: string | null;
  model: string | null;
  toolName: string | null;
  toolInput: unknown;
  lastAssistantMessage: string | null;
  delegated: boolean;
}

export interface CodexLiveState {
  sessionId: string;
  status: CodexSessionStatus;
  cwd: string | null;
  transcriptPath: string | null;
  lastMessage: string | null;
  startedAt: number;
  updatedAt: number;
  interactiveAt: number | null;
}

const live = new Map<string, CodexLiveState>();

export const isCodexHookEvent = (value: unknown): value is CodexHookEvent =>
  typeof value === "string" && (CODEX_HOOK_EVENTS as readonly string[]).includes(value);

export function recordCodexHook(facts: CodexHookFacts, now: number = Date.now()): CodexLiveState {
  const previous = live.get(facts.sessionId);
  const next: CodexLiveState = {
    sessionId: facts.sessionId,
    status: STATUS_BY_EVENT[facts.event],
    cwd: facts.cwd ?? previous?.cwd ?? null,
    transcriptPath: facts.transcriptPath ?? previous?.transcriptPath ?? null,
    lastMessage: facts.lastAssistantMessage ? facts.lastAssistantMessage.trim().slice(0, MAX_MESSAGE) : (previous?.lastMessage ?? null),
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    interactiveAt: facts.delegated ? (previous?.interactiveAt ?? null) : now,
  };
  live.set(facts.sessionId, next);
  return next;
}

export function codexSessionMove(facts: CodexHookFacts): SessionMove | null {
  const base = { agent: "codex" as const, sessionId: facts.sessionId, agentId: null, toolName: facts.toolName, toolInput: facts.toolInput };
  if (facts.event === "PostToolUse") return facts.toolName ? { ...base, scope: "tool" } : null;
  if (facts.event === "Stop" || facts.event === "Interrupt" || facts.event === "UserPromptSubmit" || facts.event === "SessionEnd") return { ...base, scope: "session" };
  return null;
}

export function listCodexLive(now: number = Date.now()): CodexLiveState[] {
  for (const [id, state] of live) if (now - state.updatedAt > LIVE_TTL_MS) live.delete(id);
  return [...live.values()];
}

export function openElsewhere(sessionId: string, now: number = Date.now()): boolean {
  const state = live.get(sessionId);
  return state !== undefined && state.interactiveAt !== null && state.status !== "ended" && now - state.updatedAt <= LIVE_TTL_MS;
}

export function clearCodexLive(): void {
  live.clear();
}

const samePath = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();

function syntheticRecord(state: CodexLiveState): CodexSessionRecord {
  return {
    id: state.sessionId,
    title: state.cwd ? basename(state.cwd) : "Codex session",
    cwd: state.cwd,
    originator: null,
    source: null,
    threadSource: null,
    client: "codex-cli",
    status: state.status,
    turns: 0,
    lastMessage: state.lastMessage,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    file: state.transcriptPath ?? "",
    origin: null,
    hubTaskId: null,
    customTitle: null,
    archivedAt: null,
    hidden: false,
  };
}

export function mergeCodexLive(records: CodexSessionRecord[], states: CodexLiveState[]): CodexSessionRecord[] {
  const used = new Set<string>();
  const merged = records.map((record) => {
    const state = states.find((item) => item.sessionId === record.id) ?? states.find((item) => samePath(item.transcriptPath, record.file));
    if (!state) return record;
    used.add(state.sessionId);
    return {
      ...record,
      status: state.status,
      cwd: record.cwd ?? state.cwd,
      lastMessage: state.lastMessage ?? record.lastMessage,
      updatedAt: Math.max(record.updatedAt, state.updatedAt),
    };
  });
  const fresh = states.filter((state) => !used.has(state.sessionId) && state.status !== "ended").map(syntheticRecord);
  return [...merged, ...fresh].sort((a, b) => b.updatedAt - a.updatedAt);
}
