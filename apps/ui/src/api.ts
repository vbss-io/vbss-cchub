import type {
  AgentRecord,
  CodexSessionRecord,
  GroupRecord,
  HooksStatus,
  RunEventMessage,
  RuntimeSnapshot,
  SessionLive,
  SessionRecord,
  TranscriptEntry,
} from "./types";

const envUrl = import.meta.env.VITE_HUB_URL as string | undefined;
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const host = inTauri ? "127.0.0.1" : location.hostname || "localhost";
const base = envUrl ?? `http://${host}:4317`;

export const hubBase = base;

export type { HooksStatus, WslHookStatus } from "./types";
import type { ShareRequestRecord, TunnelStatus } from "./delegation";
import type { NotifEventKind } from "./notifications";

export type ShareRequestEvent = ShareRequestRecord;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return (await res.json()) as T;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((json as { error?: string } | null)?.error ?? `${path} failed (${res.status})`);
  return json as T;
}

export const fetchHealth = (): Promise<{ ok: boolean; hostname: string | null }> => getJson("/api/health");

export const fetchSessions = (): Promise<SessionRecord[]> => getJson("/api/sessions");

export const fetchRuntimes = (): Promise<RuntimeSnapshot> => getJson("/api/runtimes");

export const fetchCodexSessions = (): Promise<CodexSessionRecord[]> => getJson("/api/codex/sessions");

export const fetchCodexLive = (id: string, limit = 40): Promise<{ entries: TranscriptEntry[] }> =>
  getJson(`/api/codex/${encodeURIComponent(id)}/live?limit=${limit}`);

export const renameCodexThread = (id: string, title: string): Promise<void> =>
  send("PATCH", `/api/codex/${encodeURIComponent(id)}`, { title });

export const archiveCodexThread = (id: string): Promise<void> =>
  send("POST", `/api/codex/${encodeURIComponent(id)}/archive`);

export const unarchiveCodexThread = (id: string): Promise<void> =>
  send("POST", `/api/codex/${encodeURIComponent(id)}/unarchive`);

export const deleteCodexThread = (id: string): Promise<void> =>
  send("DELETE", `/api/codex/${encodeURIComponent(id)}`);

export const fetchAgents = (sessionId: string): Promise<AgentRecord[]> =>
  getJson(`/api/sessions/${encodeURIComponent(sessionId)}/agents`);

export const fetchSessionLive = (sessionId: string, limit = 40): Promise<SessionLive> =>
  getJson(`/api/sessions/${encodeURIComponent(sessionId)}/live?limit=${limit}`);

export const getHooks = (): Promise<HooksStatus> => getJson("/api/hooks");

export const setHooks = (install: boolean): Promise<HooksStatus> =>
  send("POST", `/api/hooks/${install ? "install" : "uninstall"}`);

export interface FocusResult {
  ok: boolean;
  reason?: string;
}

export const focusSession = (sessionId: string): Promise<FocusResult> =>
  send("POST", `/api/sessions/${encodeURIComponent(sessionId)}/focus`);

export const focusCodexApp = (): Promise<FocusResult> => send("POST", "/api/codex/focus");

export interface DesktopNotifyStatus {
  supported: boolean;
  appId: string;
  toastsEnabled: boolean | null;
  appEnabled: boolean | null;
  registered: boolean | null;
  error: string | null;
}

export interface DesktopNotifyResult {
  ok: boolean;
  via: "windows-toast" | null;
  reason: string | null;
}

export const getDesktopNotifyStatus = (force = false): Promise<DesktopNotifyStatus> => send("GET", `/api/notify/status${force ? "?force=1" : ""}`);

export const sendDesktopNotification = async (title: string, body: string): Promise<DesktopNotifyResult> => {
  const res = await fetch(`${base}/api/notify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, body }) });
  return (await res.json()) as DesktopNotifyResult;
};

export const archiveSession = (sessionId: string): Promise<void> =>
  send("POST", `/api/sessions/${encodeURIComponent(sessionId)}/archive`);

export const setSessionFavorite = (sessionId: string, favorite: boolean): Promise<void> =>
  send("POST", `/api/sessions/${encodeURIComponent(sessionId)}/favorite`, { favorite });

export const deleteSession = (sessionId: string): Promise<void> =>
  send("DELETE", `/api/sessions/${encodeURIComponent(sessionId)}`);

export const renameSession = (sessionId: string, title: string): Promise<void> =>
  send("PATCH", `/api/sessions/${encodeURIComponent(sessionId)}`, { title });

export const fetchGroups = (): Promise<GroupRecord[]> => getJson("/api/groups");

export const createGroup = (name: string, match: string): Promise<GroupRecord> =>
  send("POST", "/api/groups", { name, match });

export const updateGroup = (id: string, fields: { name?: string; match?: string }): Promise<GroupRecord> =>
  send("PATCH", `/api/groups/${encodeURIComponent(id)}`, fields);

export const deleteGroup = (id: string): Promise<void> => send("DELETE", `/api/groups/${encodeURIComponent(id)}`);

export const reorderGroups = (ids: string[]): Promise<void> => send("POST", "/api/groups/reorder", { ids });

export interface HubEvents {
  onSession: (session: SessionRecord) => void;
  onCodex?: (sessions: CodexSessionRecord[]) => void;
  onRemoved?: (sessionId: string) => void;
  onGroups?: (groups: GroupRecord[]) => void;
  onHooks?: (hooks: HooksStatus) => void;
  onDelegation?: (taskId: string) => void;
  onReport?: () => void;
  onRunEvent?: (event: RunEventMessage) => void;
  onShareRequest?: (request: ShareRequestEvent) => void;
  onTunnel?: (status: TunnelStatus) => void;
  onShareStream?: (event: ShareStreamEvent) => void;
  onNavigate?: (hash: string) => void;
  onToast?: (card: ToastCard) => void;
}

export interface ToastCard {
  kind: NotifEventKind;
  id: string;
  title: string;
  body: string;
  at: number;
}

export interface ShareStreamEvent {
  requestId: string;
  shareId: string;
  kind: "text" | "tool" | "status";
  text: string;
}

export interface SessionAsks {
  forks: { shareId: string; asker: string; sessionId: string; parentSessionId: string | null; createdAt: number; lastUsedAt: number; questions: number }[];
  asks: ShareRequestRecord[];
}

export const fetchSessionAsks = (sessionId: string): Promise<SessionAsks> => getJson(`/api/sessions/${encodeURIComponent(sessionId)}/asks`);

export function subscribe(handlers: HubEvents): () => void {
  const source = new EventSource(`${base}/api/events`);
  const data = <T>(event: Event): T => JSON.parse((event as MessageEvent<string>).data) as T;
  source.addEventListener("session", (event) => handlers.onSession(data<SessionRecord>(event)));
  source.addEventListener("codex", (event) => handlers.onCodex?.(data<CodexSessionRecord[]>(event)));
  source.addEventListener("removed", (event) => handlers.onRemoved?.(data<{ sessionId: string }>(event).sessionId));
  source.addEventListener("groups", (event) => handlers.onGroups?.(data<GroupRecord[]>(event)));
  source.addEventListener("hooks", (event) => handlers.onHooks?.(data<HooksStatus>(event)));
  source.addEventListener("delegation", (event) => handlers.onDelegation?.(data<{ taskId: string }>(event).taskId));
  source.addEventListener("report", () => handlers.onReport?.());
  source.addEventListener("run-event", (event) => handlers.onRunEvent?.(data<RunEventMessage>(event)));
  source.addEventListener("share-request", (event) => handlers.onShareRequest?.(data<ShareRequestEvent>(event)));
  source.addEventListener("tunnel", (event) => handlers.onTunnel?.(data<TunnelStatus>(event)));
  source.addEventListener("share-stream", (event) => handlers.onShareStream?.(data<ShareStreamEvent>(event)));
  source.addEventListener("ui-navigate", (event) => handlers.onNavigate?.(data<{ hash: string }>(event).hash));
  source.addEventListener("toast", (event) => handlers.onToast?.(data<ToastCard>(event)));
  return () => source.close();
}

export const sendToast = (card: Omit<ToastCard, "at"> & { at?: number }): Promise<void> =>
  fetch(`${base}/api/toast`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(card) })
    .then(() => undefined)
    .catch(() => undefined);

export const requestNavigate = (hash: string): Promise<void> =>
  fetch(`${base}/api/ui/navigate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hash }) })
    .then(() => undefined)
    .catch(() => undefined);

export const reportUiError = (view: string, error: Error, componentStack: string | null): Promise<void> =>
  fetch(`${hubBase}/api/ui-error`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ view, message: error.message, stack: error.stack ?? "", componentStack: componentStack ?? "" }),
  })
    .then(() => undefined)
    .catch(() => undefined);
