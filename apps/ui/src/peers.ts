import type { TaskRecord } from "./delegation";
import type { SessionRecord } from "./types";
import { isStale } from "./stale";

const normalize = (path: string | null): string => (path ?? "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

const liveSession = (session: SessionRecord): boolean =>
  session.archivedAt == null && session.status !== "ended" && session.helperOf == null && !isStale(session);

const sharedRunningTask = (task: TaskRecord): boolean =>
  (task.status === "running" || task.status === "pending") && (task as TaskRecord & { isolation?: string }).isolation !== "worktree";

export function folderPeers(
  folder: string | null,
  sessions: SessionRecord[],
  tasks: TaskRecord[],
  exclude: { sessionId?: string; taskId?: string },
): number {
  const key = normalize(folder);
  if (!key) return 0;
  const sessionCount = sessions.filter((session) => session.sessionId !== exclude.sessionId && liveSession(session) && normalize(session.cwd) === key).length;
  const taskCount = tasks.filter((task) => task.id !== exclude.taskId && sharedRunningTask(task) && normalize(task.cwd) === key).length;
  return sessionCount + taskCount;
}
