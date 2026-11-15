import type { TaskStatus } from "./delegation";
import { taskNeedsYou } from "./runs-model";
import type { SessionRecord } from "./types";

type AttentionSession = Pick<SessionRecord, "status" | "unread" | "helperOf">;

export function needsYou(session: AttentionSession): boolean {
  if (session.helperOf) return false;
  return session.status === "waiting" || session.unread === true;
}

export function attentionCount(sessions: readonly AttentionSession[]): number {
  return sessions.filter(needsYou).length;
}

interface AttentionTask {
  status: TaskStatus;
  archivedAt: number | null;
}

export interface SessionsBadge {
  count: number;
  sessions: number;
  tasks: number;
}

export function sessionsBadge(sessions: readonly AttentionSession[], tasks: readonly AttentionTask[], delegatedOn: boolean): SessionsBadge {
  const waiting = attentionCount(sessions);
  const needing = delegatedOn ? tasks.filter((task) => task.archivedAt == null && taskNeedsYou(task.status)).length : 0;
  return { count: waiting + needing, sessions: waiting, tasks: needing };
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function sessionsBadgeTitle(label: string, badge: SessionsBadge): string {
  if (badge.count === 0) return label;
  const parts = [badge.sessions > 0 ? plural(badge.sessions, "session") : null, badge.tasks > 0 ? plural(badge.tasks, "delegated task") : null].filter((part): part is string => part !== null);
  return `${label} (${badge.count}): ${parts.join(" and ")} ${badge.count === 1 ? "needs" : "need"} you`;
}
