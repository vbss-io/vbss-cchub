import type { CodexSessionRecord, SessionStatus } from "./types";

export type SessionTab = "activity" | "agents" | "asks" | "delegated" | "review" | "details";

export interface DrawerTab<K extends string> {
  key: K;
  label: string;
  count?: string;
}

export type SessionPrimary = "focus" | null;

export const sessionPrimaryAction = ({ status, stale }: { status: SessionStatus; stale: boolean }): SessionPrimary => (status !== "ended" && !stale ? "focus" : null);

export interface SessionTabInput {
  agentsTotal: number;
  agentsRunning: number;
  asks: number;
  forks: number;
  delegated: number;
  delegatedOn: boolean;
  review?: boolean;
}

export function sessionTabs({ agentsTotal, agentsRunning, asks, forks, delegated, delegatedOn, review = false }: SessionTabInput): DrawerTab<SessionTab>[] {
  const tabs: DrawerTab<SessionTab>[] = [{ key: "activity", label: "Activity" }];
  if (agentsTotal > 0) tabs.push({ key: "agents", label: "Subagents", count: agentsRunning > 0 ? `${agentsRunning}/${agentsTotal}` : String(agentsTotal) });
  if (asks > 0 || forks > 0) tabs.push(asks > 0 ? { key: "asks", label: "Asks", count: String(asks) } : { key: "asks", label: "Asks" });
  if (delegatedOn && delegated > 0) tabs.push({ key: "delegated", label: "Delegated", count: String(delegated) });
  if (review) tabs.push({ key: "review", label: "Review" });
  tabs.push({ key: "details", label: "Details" });
  return tabs;
}

export const visibleTab = <K extends string>(tab: K, tabs: readonly DrawerTab<K>[], fallback: K): K => (tabs.some((item) => item.key === tab) ? tab : fallback);

export type SessionMenuKey = "open" | "share" | "large" | "archive";

export function sessionMenuKeys({ canShare, archived, canOpen = false }: { canShare: boolean; archived: boolean; canOpen?: boolean }): SessionMenuKey[] {
  const keys: SessionMenuKey[] = [];
  if (canOpen) keys.push("open");
  if (canShare) keys.push("share");
  keys.push("large");
  if (!archived) keys.push("archive");
  return keys;
}

export type CodexPrimary = "focus-app" | null;

export const codexPrimaryAction = ({ status, appRunning }: { status: CodexSessionRecord["status"]; appRunning: boolean }): CodexPrimary =>
  appRunning && (status === "active" || status === "waiting" || status === "idle") ? "focus-app" : null;

export type CodexMenuKey = "open" | "task" | "large" | "archive" | "unarchive";

export function codexMenuKeys({ hubTask, delegatedOn, archived, canOpen = false }: { hubTask: boolean; delegatedOn: boolean; archived: boolean; canOpen?: boolean }): CodexMenuKey[] {
  const keys: CodexMenuKey[] = [];
  if (canOpen) keys.push("open");
  if (hubTask && delegatedOn) keys.push("task");
  keys.push("large");
  keys.push(archived ? "unarchive" : "archive");
  return keys;
}

export interface SessionRelationsInput {
  forkOf: string | null;
  forkParentName: string | null;
  helperOf: string | null;
  helperParentName: string | null;
  helpers: number;
  helpersTotal: number;
  peers: number;
}

export interface SessionRelations {
  fork: string;
  helpers: string;
  peers: string;
}

const NONE = "—";

export function sessionRelations({ forkOf, forkParentName, helperOf, helperParentName, helpers, helpersTotal, peers }: SessionRelationsInput): SessionRelations {
  const helperParts = [
    ...(helpersTotal > 0 ? [`${helpers} helper${helpers === 1 ? "" : "s"} folded in · ${helpersTotal} total`] : []),
    ...(helperOf ? [`helper of ${helperParentName ?? helperOf.slice(0, 8)}`] : []),
  ];
  return {
    fork: forkOf ? `fork of ${forkParentName ?? forkOf.slice(0, 8)}` : NONE,
    helpers: helperParts.length > 0 ? helperParts.join(" · ") : NONE,
    peers: peers > 0 ? `${peers} other live agent${peers === 1 ? "" : "s"} in this folder` : NONE,
  };
}

export interface AgentLike {
  agentId: string;
  status: "running" | "ended";
  turns: number;
  agentType: string | null;
}

export interface AgentSplit<A extends AgentLike> {
  shown: A[];
  silent: [string, number][];
}

export function splitAgents<A extends AgentLike>(agents: readonly A[]): AgentSplit<A> {
  const shown: A[] = [];
  const silent = new Map<string, number>();
  for (const agent of agents) {
    if (agent.status === "running" || agent.turns > 0) shown.push(agent);
    else silent.set(agent.agentType ?? "agent", (silent.get(agent.agentType ?? "agent") ?? 0) + 1);
  }
  return { shown, silent: [...silent] };
}

export function toggleExpanded(expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export const AGENT_TAIL_LIMIT = 12;

export function agentStepsLabel(turns: number): string {
  if (turns >= AGENT_TAIL_LIMIT) return `${AGENT_TAIL_LIMIT}+ steps`;
  return `${turns} ${turns === 1 ? "step" : "steps"}`;
}
