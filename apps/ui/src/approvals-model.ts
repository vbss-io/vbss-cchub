import type { NotifEventConfig } from "./notifications";
import type { PermissionAgent, PermissionRequestRecord, PermissionRequestSummary } from "./types";

export type ApprovalItem = PermissionRequestRecord & { pendingDetails?: true };

export type ApprovalsState = readonly ApprovalItem[];

export type ApprovalsAction =
  | { type: "replace"; list: readonly PermissionRequestRecord[] }
  | { type: "request"; record: PermissionRequestSummary }
  | { type: "details"; list: readonly PermissionRequestRecord[] }
  | { type: "resolved"; id: string }
  | { type: "prune"; now: number };

export const APPROVAL_GRACE_MS = 3_000;
export const URGENT_SECONDS = 10;
export const REASON_MAX = 2_000;

const byCreated = (a: PermissionRequestRecord, b: PermissionRequestRecord): number => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

export function reduceApprovals(state: ApprovalsState, action: ApprovalsAction): ApprovalsState {
  if (action.type === "replace") return [...action.list].sort(byCreated);
  if (action.type === "request") {
    const known = state.find((item) => item.id === action.record.id);
    const merged: ApprovalItem = known
      ? { ...known, ...action.record }
      : { toolInput: null, cwd: null, turnId: null, ...action.record, pendingDetails: true };
    return [...state.filter((item) => item.id !== action.record.id), merged].sort(byCreated);
  }
  if (action.type === "details") {
    const byId = new Map(action.list.map((item) => [item.id, item]));
    if (!state.some((item) => byId.has(item.id))) return state;
    return state.map((item) => byId.get(item.id) ?? item);
  }
  if (action.type === "resolved") return state.some((item) => item.id === action.id) ? state.filter((item) => item.id !== action.id) : state;
  const alive = state.filter((item) => item.expiresAt + APPROVAL_GRACE_MS > action.now);
  return alive.length === state.length ? state : alive;
}

export const needsDetails = (list: ApprovalsState): boolean => list.some((item) => item.pendingDetails === true);

export const sessionKey = (agent: PermissionAgent, sessionId: string): string => `${agent}:${sessionId}`;

export const approvalsOf = (list: ApprovalsState, agent: PermissionAgent, sessionId: string): PermissionRequestRecord[] =>
  list.filter((item) => item.agent === agent && item.sessionId === sessionId);

export function latestPerSession(list: ApprovalsState): PermissionRequestRecord[] {
  const latest = new Map<string, PermissionRequestRecord>();
  for (const item of list) {
    const key = sessionKey(item.agent, item.sessionId);
    const current = latest.get(key);
    if (!current || byCreated(current, item) < 0) latest.set(key, item);
  }
  return [...latest.values()].sort(byCreated);
}

export function toastQueue(list: ApprovalsState, dismissed: ReadonlySet<string>): PermissionRequestRecord[] {
  return latestPerSession(list).filter((item) => !dismissed.has(item.id));
}

export function replaceToastForSession(toasts: readonly PermissionRequestRecord[], record: PermissionRequestRecord): PermissionRequestRecord[] {
  const key = sessionKey(record.agent, record.sessionId);
  const older = toasts.filter((item) => sessionKey(item.agent, item.sessionId) !== key);
  return [...older, record].sort(byCreated);
}

export const secondsLeft = (expiresAt: number, now: number): number => Math.max(0, Math.ceil((expiresAt - now) / 1000));

export function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const rest = total % 60;
  return `${Math.floor(total / 60)}:${rest < 10 ? "0" : ""}${rest}`;
}

export interface Countdown {
  text: string;
  urgent: boolean;
  expired: boolean;
}

export function countdown(expiresAt: number, now: number): Countdown {
  const seconds = secondsLeft(expiresAt, now);
  if (seconds === 0) return { text: "expiring", urgent: true, expired: true };
  return { text: `${formatSeconds(seconds)} left`, urgent: seconds <= URGENT_SECONDS, expired: false };
}

export const countdownFraction = (record: Pick<PermissionRequestRecord, "createdAt" | "expiresAt">, now: number): number => {
  const span = record.expiresAt - record.createdAt;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (record.expiresAt - now) / span));
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function inputText(toolInput: unknown): string {
  if (toolInput === null || toolInput === undefined) return "";
  if (typeof toolInput === "string") return toolInput;
  if (isObject(toolInput)) {
    const command = toolInput.command;
    if (typeof command === "string") return command;
    if (Array.isArray(command) && command.every((part) => typeof part === "string")) return command.join(" ");
  }
  return JSON.stringify(toolInput, null, 2);
}

export interface ApprovalView {
  id: string;
  title: string;
  tool: string;
  input: string;
  cwd: string | null;
  agentLabel: string;
  subagent: boolean;
}

const AGENT_LABEL: Readonly<Record<PermissionAgent, string>> = { claude: "Claude", codex: "Codex" };

export function approvalView(record: PermissionRequestRecord): ApprovalView {
  return {
    id: record.id,
    title: record.title?.trim() || record.sessionId.slice(0, 8),
    tool: record.toolName,
    input: inputText(record.toolInput),
    cwd: record.cwd,
    agentLabel: AGENT_LABEL[record.agent],
    subagent: record.agentId !== null,
  };
}

export interface DecisionBody {
  behavior: "allow" | "deny";
  message?: string;
}

export function decisionBody(behavior: "allow" | "deny", reason: string): DecisionBody {
  const message = reason.trim().slice(0, REASON_MAX);
  return behavior === "deny" && message.length > 0 ? { behavior, message } : { behavior };
}

export const pendingLabel = (count: number): string => `${count} approval${count === 1 ? "" : "s"} waiting`;

export function sessionsWithApprovals(list: ApprovalsState): Set<string> {
  return new Set(list.map((item) => sessionKey(item.agent, item.sessionId)));
}

export const approvalToastsOn = (config: Pick<NotifEventConfig, "enabled" | "desktop" | "style"> & { events: Partial<NotifEventConfig["events"]> }): boolean =>
  config.enabled && config.desktop && (config.style === "cchub" || config.style === "both") && config.events.sessionNeedsYou !== false;
