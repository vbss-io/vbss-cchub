import { existsSync, readFileSync } from "node:fs";
import { listCodexSessions } from "./codex-store.js";
import { listSessions } from "./db.js";
import type { DelegationSettings, WorkspaceRecord } from "./delegation-types.js";
import { localDate, localTime, readBlockBullets, trailFilePath } from "./second-brain.js";
import { collectBoard, tasksRoot, type BoardTask } from "./tasks-board.js";
import { isHubRun, trailDir } from "./trail.js";
import { discoverWorkspaces, isDirectory, workspaceFor } from "./workspaces.js";

export const HANDOFF_MAX_CHARS = 1500;
const HANDOFF_SESSIONS = 3;
const HANDOFF_KEY_POINTS = 3;
const HANDOFF_OPEN_LOOPS = 8;
const LINE_CAP = 180;
const OPEN_STATUSES = new Set(["doing", "todo", "blocked"]);

export interface HandoffSession {
  sessionId: string;
  client: "claude" | "codex";
  title: string;
  updatedAt: number;
  keyPoints: string[];
}

export interface HandoffOpenLoop {
  project: string;
  status: string;
  title: string;
}

export interface HandoffPreview {
  workspace: string | null;
  enabled: boolean;
  sessions: HandoffSession[];
  openLoops: HandoffOpenLoop[];
  text: string | null;
  chars: number;
}

const clipLine = (text: string, max = LINE_CAP): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export const isHandoffEnabled = (settings: DelegationSettings, workspace: string): boolean => settings.memory.handoffWorkspaces.includes(workspace);

function trailKeyPoints(settings: DelegationSettings, sessionId: string, times: number[]): string[] {
  const dir = trailDir(settings);
  if (!dir) return [];
  const dates = [...new Set(times.map((time) => localDate(new Date(time))))];
  for (const date of dates) {
    const file = trailFilePath(dir, date);
    if (!existsSync(file)) continue;
    try {
      const bullets = readBlockBullets(readFileSync(file, "utf8"), sessionId);
      if (bullets.length > 0) return bullets.slice(-HANDOFF_KEY_POINTS);
    } catch {
      continue;
    }
  }
  return [];
}

function recentSessions(settings: DelegationSettings, workspaces: WorkspaceRecord[], workspace: string, excludeSessionId: string | null): HandoffSession[] {
  const inWorkspace = (cwd: string | null): boolean => workspaceFor(workspaces, cwd)?.name === workspace;
  const claude = listSessions()
    .filter((session) => session.sessionId !== excludeSessionId && !isHubRun(session) && session.helperOf === null && inWorkspace(session.cwd))
    .map((session) => ({ session, at: session.updatedAt }));
  const codex = listCodexSessions().filter((thread) => thread.id !== excludeSessionId && thread.origin !== "hub" && !thread.hidden && inWorkspace(thread.cwd));
  const merged: HandoffSession[] = [
    ...claude.map(({ session }) => ({
      sessionId: session.sessionId,
      client: "claude" as const,
      title: clipLine(session.customTitle ?? session.title ?? "untitled", 100),
      updatedAt: session.updatedAt,
      keyPoints: [],
    })),
    ...codex.map((thread) => ({
      sessionId: thread.id,
      client: "codex" as const,
      title: clipLine(thread.customTitle ?? thread.title, 100),
      updatedAt: thread.updatedAt,
      keyPoints: [],
    })),
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, HANDOFF_SESSIONS);
  const startedById = new Map(claude.map(({ session }) => [session.sessionId, session.startedAt]));
  return merged.map((item) =>
    item.client === "claude" ? { ...item, keyPoints: trailKeyPoints(settings, item.sessionId, [item.updatedAt, startedById.get(item.sessionId) ?? item.updatedAt]) } : item,
  );
}

const statusRank = (task: BoardTask): number => (task.status === "doing" ? 0 : task.status === "todo" ? 1 : 2);

function openLoops(settings: DelegationSettings, workspace: string): HandoffOpenLoop[] {
  const root = tasksRoot(settings);
  if (!root || !isDirectory(root)) return [];
  const { loaded, tasks } = collectBoard(root, settings.tasks);
  const projects = new Map(loaded.projects.filter((project) => project.workspace === workspace).map((project) => [project.id, project.title]));
  return tasks
    .filter((task) => projects.has(task.projectId) && task.section === "open" && OPEN_STATUSES.has(task.status))
    .map((task, index) => ({ task, index }))
    .sort((a, b) => statusRank(a.task) - statusRank(b.task) || (a.task.priority ?? 99) - (b.task.priority ?? 99) || a.index - b.index)
    .slice(0, HANDOFF_OPEN_LOOPS)
    .map(({ task }) => ({ project: projects.get(task.projectId) ?? task.projectId, status: task.status, title: clipLine(task.title) }));
}

export function renderHandoff(workspace: string, sessions: HandoffSession[], loops: HandoffOpenLoop[]): string | null {
  if (sessions.length === 0 && loops.length === 0) return null;
  const lines: string[] = [`Context from the CC Hub for the "${workspace}" workspace (earlier work, for reference only).`];
  if (sessions.length > 0) {
    lines.push("", "Recent sessions in this workspace:");
    for (const session of sessions) {
      const when = new Date(session.updatedAt);
      lines.push(`- ${localDate(when)} ${localTime(when)} · ${session.title} (${session.client})`);
      for (const point of session.keyPoints) lines.push(`  - ${clipLine(point)}`);
    }
  }
  if (loops.length > 0) {
    const projects = [...new Set(loops.map((loop) => loop.project))];
    lines.push("", `Open loops of the linked project${projects.length > 1 ? "s" : ""} (${projects.join(", ")}):`);
    for (const loop of loops) lines.push(`- ${loop.status === "todo" ? "" : `[${loop.status}] `}${loop.title}`);
  }
  let text = "";
  for (const line of lines) {
    const next = text === "" ? line : `${text}\n${line}`;
    if (next.length > HANDOFF_MAX_CHARS) break;
    text = next;
  }
  return text.trim() === "" ? null : text;
}

export function handoffPreview(settings: DelegationSettings, workspace: string, excludeSessionId: string | null = null): HandoffPreview {
  const workspaces = discoverWorkspaces(settings.workspacesRoot);
  const sessions = recentSessions(settings, workspaces, workspace, excludeSessionId);
  const loops = openLoops(settings, workspace);
  const text = renderHandoff(workspace, sessions, loops);
  return { workspace, enabled: isHandoffEnabled(settings, workspace), sessions, openLoops: loops, text, chars: text?.length ?? 0 };
}

export function handoffForCwd(settings: DelegationSettings, cwd: string | null, sessionId: string | null): { workspace: string | null; text: string | null } {
  const workspace = workspaceFor(discoverWorkspaces(settings.workspacesRoot), cwd)?.name ?? null;
  if (!workspace || !isHandoffEnabled(settings, workspace)) return { workspace, text: null };
  return { workspace, text: handoffPreview(settings, workspace, sessionId).text };
}
