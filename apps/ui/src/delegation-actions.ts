import { hubBase } from "./api";
import { isReplyCode, type CodexReplyCode } from "./act-model";
import { discardWorktree, getWorktree, mergeWorktree, type Isolation, type PermissionMode, type TaskRecord, type WorktreeInfo } from "./delegation";

const base = `${hubBase}/delegation`;

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  const json: unknown = isJson && text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) {
    const failure = json as { error?: string; files?: string[] } | null;
    const message = failure?.error ?? `request failed (${res.status})`;
    throw new Error(failure?.files && failure.files.length > 0 ? `${message}: ${failure.files.join(", ")}` : message);
  }
  return json as T;
}

export const archiveTask = async (id: string): Promise<void> => {
  await send<unknown>("POST", `/tasks/${encodeURIComponent(id)}/archive`);
};

export const unarchiveTask = async (id: string): Promise<void> => {
  await send<unknown>("POST", `/tasks/${encodeURIComponent(id)}/unarchive`);
};

export const listArchivedTasks = async (limit = 200): Promise<TaskRecord[]> => {
  const all = await send<TaskRecord[]>("GET", `/tasks?archived=1&limit=${limit}`);
  return all.filter((task) => taskArchivedAt(task) != null);
};

export const retryTask = async (id: string, permissionMode: PermissionMode | null): Promise<void> => {
  await send<unknown>("POST", `/tasks/${encodeURIComponent(id)}/continue`, {
    prompt: permissionMode ? "continue where you stopped; you now have permission" : "continue where you stopped",
    ...(permissionMode ? { permissionMode } : {}),
  });
};

export type CodexReplyResult = { ok: true } | { ok: false; code: CodexReplyCode | null; message: string };

export async function replyCodexThread(threadId: string, text: string): Promise<CodexReplyResult> {
  const res = await fetch(`${base}/codex/${encodeURIComponent(threadId)}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (res.ok) return { ok: true };
  const raw = await res.text();
  let json: { error?: string; code?: unknown } | null = null;
  try {
    json = raw.length > 0 ? (JSON.parse(raw) as { error?: string; code?: unknown }) : null;
  } catch {
    json = null;
  }
  return { ok: false, code: res.status === 409 && isReplyCode(json?.code) ? json.code : null, message: json?.error ?? `request failed (${res.status})` };
}

export const taskArchivedAt = (task: TaskRecord): number | null =>
  (task as TaskRecord & { archivedAt?: number | null }).archivedAt ?? null;

export async function probeArchiveSupport(): Promise<boolean> {
  try {
    const res = await fetch(`${base}/tasks/__cchub_probe__/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    if (res.status === 404) return (res.headers.get("content-type") ?? "").includes("application/json");
    return res.status < 500;
  } catch {
    return false;
  }
}

export type WorktreeStatus = WorktreeInfo;

export const getTaskWorktree = getWorktree;

export const mergeTaskWorktree = async (id: string): Promise<void> => {
  await mergeWorktree(id);
};

export const discardTaskWorktree = async (id: string): Promise<void> => {
  await discardWorktree(id);
};

export const taskIsolation = (task: TaskRecord): Isolation => (task.isolation === "worktree" ? "worktree" : "shared");
export const taskBranch = (task: TaskRecord): string | null => task.branch ?? null;
export const taskWorktreePath = (task: TaskRecord): string | null => task.worktreePath ?? null;
export const taskMergedAt = (task: TaskRecord): number | null => task.mergedAt ?? null;
