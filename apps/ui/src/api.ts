import type { GroupRecord, SessionRecord } from "./types";

const envUrl = import.meta.env.VITE_HUB_URL as string | undefined;
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const host = inTauri ? "127.0.0.1" : location.hostname || "localhost";
const base = envUrl ?? `http://${host}:4317`;

export async function fetchSessions(): Promise<SessionRecord[]> {
  const res = await fetch(`${base}/api/sessions`);
  return (await res.json()) as SessionRecord[];
}

export interface WslHookStatus {
  distro: string;
  installed?: boolean;
  error?: string;
}

export interface HooksStatus {
  installed: boolean;
  events: string[];
  settingsPath?: string;
  notifyPath?: string;
  wsl?: WslHookStatus[];
}

export async function getHooks(): Promise<HooksStatus> {
  const res = await fetch(`${base}/api/hooks`);
  return (await res.json()) as HooksStatus;
}

export async function setHooks(install: boolean): Promise<HooksStatus> {
  const res = await fetch(`${base}/api/hooks/${install ? "install" : "uninstall"}`, {
    method: "POST",
  });
  return (await res.json()) as HooksStatus;
}

export interface FocusResult {
  ok: boolean;
  reason?: string;
}

export async function focusSession(sessionId: string): Promise<FocusResult> {
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/focus`, {
    method: "POST",
  });
  return (await res.json()) as FocusResult;
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function archiveSession(sessionId: string): Promise<void> {
  await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST" });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
}

export async function fetchGroups(): Promise<GroupRecord[]> {
  const res = await fetch(`${base}/api/groups`);
  return (await res.json()) as GroupRecord[];
}

export async function createGroup(name: string, match: string): Promise<void> {
  await fetch(`${base}/api/groups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, match }),
  });
}

export async function updateGroup(
  id: string,
  fields: { name?: string; match?: string },
): Promise<void> {
  await fetch(`${base}/api/groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });
}

export async function deleteGroup(id: string): Promise<void> {
  await fetch(`${base}/api/groups/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function reorderGroups(ids: string[]): Promise<void> {
  await fetch(`${base}/api/groups/reorder`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

export function subscribe(
  onSession: (session: SessionRecord) => void,
  onRemoved?: (sessionId: string) => void,
  onGroups?: (groups: GroupRecord[]) => void,
  onHooks?: (hooks: HooksStatus) => void,
): () => void {
  const source = new EventSource(`${base}/api/events`);
  source.addEventListener("session", (event) => {
    onSession(JSON.parse((event as MessageEvent<string>).data) as SessionRecord);
  });
  source.addEventListener("removed", (event) => {
    const data = JSON.parse((event as MessageEvent<string>).data) as { sessionId: string };
    onRemoved?.(data.sessionId);
  });
  source.addEventListener("groups", (event) => {
    onGroups?.(JSON.parse((event as MessageEvent<string>).data) as GroupRecord[]);
  });
  source.addEventListener("hooks", (event) => {
    onHooks?.(JSON.parse((event as MessageEvent<string>).data) as HooksStatus);
  });
  return () => source.close();
}
