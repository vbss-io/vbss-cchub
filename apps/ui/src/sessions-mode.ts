import { normalizeOrigin, type Origin } from "./runs-model";

export type SessionsMode = "list" | "map" | "search" | "routines";

export const SESSIONS_MODE_KEY = "hub.sessions.mode";

export const SESSIONS_MODES: readonly { key: SessionsMode; label: string }[] = [
  { key: "list", label: "List" },
  { key: "map", label: "Flow" },
  { key: "search", label: "Search" },
];

export const ROUTINES_MODE: { key: SessionsMode; label: string } = { key: "routines", label: "Routines" };

export const sessionsModeOptions = (flowOn: boolean, delegatedOn = false): readonly { key: SessionsMode; label: string }[] => [
  ...SESSIONS_MODES.filter((item) => item.key !== "map" || flowOn),
  ...(delegatedOn ? [ROUTINES_MODE] : []),
];

export const parseSessionsMode = (value: string | null | undefined): SessionsMode => (value === "map" || value === "search" ? value : "list");

export const resolveSessionsMode = (requested: SessionsMode, flowOn: boolean, delegatedOn = true): SessionsMode => {
  if (requested === "map" && !flowOn) return "list";
  if (requested === "routines" && !delegatedOn) return "list";
  return requested;
};

export const isTransientMode = (mode: SessionsMode): boolean => mode === "search" || mode === "routines";

export const sessionsModeRouteOf = (view: string, flowOn: boolean): SessionsMode | null => (view === "flow" && flowOn ? "map" : null);

export const navCurrentKey = (view: string, mode: SessionsMode, flowOn: boolean): string => (view === "sessions" && flowOn && mode === "map" ? "flow" : view);

export const navClickMode = (key: string, flowOn: boolean): SessionsMode | null => (key === "sessions" || key === "tasks" ? "list" : key === "flow" && flowOn ? "map" : null);

export interface MapScope {
  sessions: boolean;
  codex: boolean;
  tasks: boolean;
}

export function mapScope(origin: Origin, delegatedOn: boolean): MapScope {
  const picked = normalizeOrigin(origin, delegatedOn);
  return {
    sessions: picked === "all" || picked === "claude",
    codex: picked === "all" || picked === "codex",
    tasks: delegatedOn && (picked === "all" || picked === "delegated"),
  };
}

export interface MapSummary {
  live: number;
  subagents: number;
  tasks: number;
  needYou: number;
}

export function mapSummaryLine(summary: MapSummary, delegatedOn: boolean): string {
  const parts = [`${summary.live} live`, `${summary.subagents} subagents`];
  if (delegatedOn) parts.push(`${summary.tasks} tasks`);
  parts.push(`${summary.needYou} need you`);
  return parts.join(" · ");
}

export const sessionsSubtitle = (delegatedOn: boolean): string =>
  delegatedOn ? "Everything running on this machine: Claude, Codex and delegated work" : "Everything running on this machine: Claude and Codex";
