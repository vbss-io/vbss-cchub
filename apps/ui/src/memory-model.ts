import type { DaySummary, DaySummaryWriteResult, HandoffPreview, HistoryClient, HistoryHit, HistoryIndexStatus, HistorySearchResult, MemorySettings } from "./types";

export type HistoryPeriod = "any" | "today" | "week" | "month";

export type HistorySort = "relevance" | "recent";

export interface HistoryFilters {
  q: string;
  client: "" | HistoryClient;
  workspace: string;
  period: HistoryPeriod;
  sort: HistorySort;
  group: boolean;
}

export const DEFAULT_HISTORY_FILTERS: HistoryFilters = { q: "", client: "", workspace: "", period: "any", sort: "relevance", group: false };

export const HISTORY_PAGE = 20;
export const HISTORY_PALETTE_LIMIT = 5;
export const HISTORY_DEBOUNCE_MS = 250;
export const HISTORY_MIN_QUERY = 2;
export const HANDOFF_MAX_CHARS = 1500;

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = { historyIndex: true, handoffWorkspaces: [], summaryHeading: "Day summary" };

export const memorySettingsOf = (settings: { memory?: Partial<MemorySettings> } | null): MemorySettings => ({ ...DEFAULT_MEMORY_SETTINGS, ...(settings?.memory ?? {}) });

export const HISTORY_PERIODS: readonly { key: HistoryPeriod; label: string }[] = [
  { key: "any", label: "Any time" },
  { key: "today", label: "Today" },
  { key: "week", label: "Last 7 days" },
  { key: "month", label: "Last 30 days" },
];

const pad = (value: number): string => String(value).padStart(2, "0");

export const localDateString = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const periodFrom = (period: HistoryPeriod, now: Date): string | null => {
  if (period === "today") return localDateString(now);
  if (period === "week") return localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
  if (period === "month") return localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29));
  return null;
};

export const canSearch = (q: string): boolean => q.trim().length >= HISTORY_MIN_QUERY;

export const buildSearchQuery = (filters: HistoryFilters, offset: number, limit: number, now: Date = new Date()): string => {
  const params = new URLSearchParams();
  params.set("q", filters.q.trim());
  if (filters.client) params.set("client", filters.client);
  if (filters.workspace) params.set("workspace", filters.workspace);
  const from = periodFrom(filters.period, now);
  if (from) params.set("from", from);
  params.set("sort", filters.sort);
  params.set("group", filters.group ? "session" : "message");
  params.set("limit", String(limit));
  params.set("offset", String(Math.max(0, offset)));
  return params.toString();
};

export const historyKey = (filters: HistoryFilters, limit: number): string =>
  JSON.stringify([filters.q.trim(), filters.client, filters.workspace, filters.period, filters.sort, filters.group, limit]);

export interface HighlightSegment {
  text: string;
  hit: boolean;
}

export const splitHighlights = (text: string, ranges: readonly (readonly [number, number])[]): HighlightSegment[] => {
  const clean = ranges
    .map(([start, end]): [number, number] => [Math.max(0, Math.min(start, text.length)), Math.max(0, Math.min(end, text.length))])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of clean) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false });
    segments.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments.length > 0 ? segments : [{ text, hit: false }];
};

export interface HistoryState {
  key: string | null;
  phase: "idle" | "loading" | "ready" | "error";
  loadingMore: boolean;
  hits: HistoryHit[];
  hasMore: boolean;
  enabled: boolean | null;
  error: string | null;
}

export const INITIAL_HISTORY_STATE: HistoryState = { key: null, phase: "idle", loadingMore: false, hits: [], hasMore: false, enabled: null, error: null };

export type HistoryAction =
  | { type: "reset" }
  | { type: "start"; key: string; append: boolean }
  | { type: "done"; key: string; result: HistorySearchResult; append: boolean }
  | { type: "fail"; key: string; message: string };

export const mergeHits = (existing: readonly HistoryHit[], incoming: readonly HistoryHit[]): HistoryHit[] => {
  const seen = new Set(existing.map((hit) => hit.messageId));
  return [...existing, ...incoming.filter((hit) => !seen.has(hit.messageId))];
};

export const historyReducer = (state: HistoryState, action: HistoryAction): HistoryState => {
  if (action.type === "reset") return INITIAL_HISTORY_STATE;
  if (action.type === "start") {
    if (action.append) return { ...state, key: action.key, loadingMore: true, error: null };
    return { ...state, key: action.key, phase: "loading", loadingMore: false, error: null };
  }
  if (action.key !== state.key) return state;
  if (action.type === "fail") return { ...state, phase: "error", loadingMore: false, error: action.message };
  const hits = action.append ? mergeHits(state.hits, action.result.hits) : action.result.hits;
  return { ...state, phase: "ready", loadingMore: false, hits, hasMore: action.result.hasMore, enabled: action.result.enabled, error: null };
};

export const nextOffset = (state: HistoryState): number => state.hits.length;

export interface HistoryEmptyInput {
  state: HistoryState;
  query: string;
  status: HistoryIndexStatus | null;
}

export const historyEmptyText = ({ state, query, status }: HistoryEmptyInput): string | null => {
  const off = state.enabled === false || (state.enabled === null && status !== null && !status.enabled);
  if (off) return "The history index is off. Turn it on in Settings › Memory to search what was said in your sessions.";
  const building = status !== null && status.running;
  const progress = building && status.progress ? ` (${status.progress.done} of ${status.progress.total} files)` : "";
  if (state.phase === "error") return state.error ?? "The search failed. Try again.";
  if (!canSearch(query)) return building ? `Building the index${progress}. You can search while it fills in.` : "Type at least two letters to search what you and the assistants said.";
  if (state.phase === "loading" && state.hits.length === 0) return "Searching...";
  if (state.phase === "ready" && state.hits.length === 0) return building ? `Nothing found yet. The index is still building${progress}, so older sessions may show up later.` : `Nothing found for "${query.trim()}".`;
  return null;
};

export interface HitSessionLookup {
  claude: (sessionId: string) => boolean;
  codex: (sessionId: string) => boolean;
}

export type HitOpenPlan =
  | { kind: "claude-drawer" | "codex-drawer" | "claude-open" | "codex-open"; sessionId: string }
  | { kind: "none" };

export const hitOpenPlan = (hit: Pick<HistoryHit, "client" | "sessionId">, known: HitSessionLookup): HitOpenPlan => {
  const sessionId = hit.sessionId;
  if (!sessionId) return { kind: "none" };
  if (hit.client === "codex") return known.codex(sessionId) ? { kind: "codex-drawer", sessionId } : { kind: "codex-open", sessionId };
  return known.claude(sessionId) ? { kind: "claude-drawer", sessionId } : { kind: "claude-open", sessionId };
};

export type HitOpenResult = { ok: true } | { ok: false; reason: string };

export const CLIENT_LABEL: Record<HistoryClient, string> = { claude: "Claude", codex: "Codex" };

export const ROLE_LABEL: Record<HistoryHit["role"], string> = { user: "You", assistant: "Assistant" };

export const historyWhen = (at: number | null): string => {
  if (at === null) return "";
  const date = new Date(at);
  return `${localDateString(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const hitHeadline = (hit: HistoryHit, workspaceName: string | null): string => {
  const parts = [CLIENT_LABEL[hit.client], hit.title ?? (hit.sessionId ? `session ${hit.sessionId.slice(0, 8)}` : "unknown session")];
  if (workspaceName) parts.push(workspaceName);
  return parts.join(" · ");
};

export const hitDetail = (hit: HistoryHit): string => {
  const parts = [ROLE_LABEL[hit.role], historyWhen(hit.at)];
  if (hit.matches > 1) parts.push(`${hit.matches} matches`);
  return parts.filter(Boolean).join(" · ");
};

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
};

export const formatBuildTime = (ms: number | null): string => {
  if (ms === null) return "not built yet";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
};

export interface StatRow {
  label: string;
  value: string;
}

export const indexStateLine = (status: HistoryIndexStatus | null): string => {
  if (status === null) return "Checking...";
  if (!status.enabled) return "Off";
  if (status.running) return status.progress ? `Building: ${status.progress.done} of ${status.progress.total} files` : "Building";
  if (status.lastError) return `Stopped: ${status.lastError}`;
  return status.sessions > 0 ? "Ready" : "Nothing indexed yet";
};

export const historyStats = (status: HistoryIndexStatus): StatRow[] => [
  { label: "Sessions", value: status.sessions.toLocaleString("en-US") },
  { label: "Messages", value: status.rows.toLocaleString("en-US") },
  { label: "Index size", value: formatBytes(status.dbBytes) },
  { label: "Last full build", value: formatBuildTime(status.lastBuildMs) },
];

export interface HandoffView {
  kind: "text" | "empty";
  text: string;
  size: string;
}

export const handoffView = (preview: HandoffPreview): HandoffView => {
  if (preview.text === null || preview.text.trim() === "") {
    return { kind: "empty", text: "Nothing to carry over yet: this workspace has no recent sessions or open loops.", size: "" };
  }
  return { kind: "text", text: preview.text, size: `${preview.chars} of ${HANDOFF_MAX_CHARS} characters` };
};

export const HANDOFF_EXPLAIN = "Adds a short recap to new Claude Code sessions started in this workspace. It reaches sessions only after you press Update hooks in Settings › Connections.";

export type SummaryFailureKind = "conflict" | "missing-daily" | "daily-off" | "no-vault" | "other";

export interface SummaryFailure {
  kind: SummaryFailureKind;
  text: string;
}

export const summaryFailure = (status: number, message: string): SummaryFailure => {
  if (status === 409) return { kind: "conflict", text: "The daily changed, reload" };
  if (status === 404) return { kind: "missing-daily", text: "There is no daily note for this day yet. Create it in Today, then write the summary." };
  if (status === 400 && /disabled/i.test(message)) return { kind: "daily-off", text: "The daily feature is off. Turn on Today in Settings › Plugins to write into your diary." };
  if (status === 400 && /second brain/i.test(message)) return { kind: "no-vault", text: "No second brain folder is set. Add it in Settings › General to write into your diary." };
  return { kind: "other", text: message };
};

export const conflictUpdatedAt = (body: unknown): number | null => {
  const value = (body as { updatedAt?: unknown } | null)?.updatedAt;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export interface SummaryPreviewView {
  markdown: string;
  canWrite: boolean;
  note: string | null;
}

export const summaryPreviewView = (summary: DaySummary, dailyExists: boolean): SummaryPreviewView => {
  if (summary.empty) return { markdown: "", canWrite: false, note: "Nothing to summarize for this day yet: no sessions, finished tasks, reports or commits." };
  if (!dailyExists) return { markdown: summary.markdown, canWrite: false, note: "There is no daily note for this day yet. Create it in Today, then write the summary." };
  return { markdown: summary.markdown, canWrite: true, note: null };
};

export const writeOutcomeText = (result: Pick<DaySummaryWriteResult, "changed">, heading: string): string =>
  result.changed ? `Written to the daily under "${heading}".` : "The daily already has this summary.";
