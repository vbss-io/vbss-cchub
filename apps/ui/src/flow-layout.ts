import type { TaskRecord, WorkspaceRecord } from "./delegation";
import type { AgentRecord, CodexSessionRecord, GroupRecord, SessionRecord, SessionStatus } from "./types";
import { workspaceOf } from "./wsmatch";

export type Orientation = "horizontal" | "vertical";

export type FlowTone = "go" | "pend" | "hold" | "muted" | "brand";

export type FlowNodeKind = "hub" | "workspace" | "session" | "codex" | "subagents" | "agent" | "task" | "taskgroup" | "more";

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  title: string;
  subtitle: string;
  tone: FlowTone;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  parent: string | null;
  lane: string;
  running: boolean;
  dim: boolean;
  badge: string | null;
  sessionId?: string;
  codexId?: string;
  taskId?: string;
  workspaceName?: string;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  origin?: boolean;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
}

export interface FlowInput {
  sessions: SessionRecord[];
  codex: CodexSessionRecord[];
  tasks: TaskRecord[];
  workspaces: WorkspaceRecord[];
  groups: GroupRecord[];
  agentsBySession: Record<string, AgentRecord[]>;
  expandedSubagents: Set<string>;
  expandedTaskGroups: Set<string>;
  collapsedLanes: Set<string>;
  orientation: Orientation;
  showEndedAgents?: boolean;
}

export const OUTSIDE_LANE = "\u0000outside";
export const OUTSIDE_LABEL = "Outside workspaces";

const SIZES: Record<FlowNodeKind, [number, number]> = {
  hub: [172, 56],
  workspace: [196, 52],
  session: [268, 64],
  codex: [268, 64],
  subagents: [212, 48],
  agent: [196, 44],
  task: [224, 56],
  taskgroup: [212, 48],
  more: [196, 38],
};

const DEPTH_MAIN_H = [24, 240, 500, 840, 1150];
const DEPTH_MAIN_V = [24, 156, 316, 500, 664];
const CROSS_GAP_H = 34;
const CROSS_GAP_V = 40;
const MARGIN = 40;
const MAX_AGENTS = 12;

const statusRank: Record<SessionStatus, number> = { waiting: 0, active: 1, idle: 2, ended: 3 };

const STALE_MS = (Number(import.meta.env?.VITE_STALE_HOURS) || 4) * 3_600_000;

const staleSession = (session: SessionRecord): boolean =>
  session.archivedAt == null && session.status !== "ended" && Date.now() - session.updatedAt > STALE_MS;

const sessionTone = (session: SessionRecord): FlowTone => {
  if (staleSession(session)) return "muted";
  if (session.status === "active") return "go";
  if (session.status === "waiting") return "pend";
  if (session.status === "idle") return "hold";
  return "muted";
};

const taskRunning = (task: TaskRecord): boolean => task.status === "running" || task.status === "pending";

const taskTone = (task: TaskRecord): FlowTone => {
  if (taskRunning(task)) return "pend";
  if (task.status === "completed") return "go";
  if (task.status === "cancelled") return "muted";
  return "hold";
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const shortCwd = (cwd: string | null): string => {
  if (!cwd) return "no folder";
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
};

const searchable = (workspace: WorkspaceRecord | undefined): string[] => {
  if (!workspace) return [];
  const strip = (value: string): string =>
    value.toLowerCase().replace(/^(?:[a-z]:[\\/]users[\\/][^\\/]+|\/home\/[^/]+|\/users\/[^/]+)/i, "").replace(/\\/g, "/");
  return [strip(workspace.name), workspace.contextPath ? strip(workspace.contextPath) : "", ...workspace.repos.map((repo) => strip(repo.path))].filter(
    Boolean,
  );
};

function laneRank(key: string, label: string, groups: GroupRecord[], workspaces: WorkspaceRecord[]): [number, string] {
  if (key === OUTSIDE_LANE) return [Number.MAX_SAFE_INTEGER, ""];
  const fields = searchable(workspaces.find((item) => item.name === key));
  let best = Number.POSITIVE_INFINITY;
  for (const group of groups) {
    const pattern = group.match.trim().toLowerCase();
    if (pattern && fields.some((field) => field.includes(pattern))) best = Math.min(best, group.position);
  }
  if (best === Number.POSITIVE_INFINITY) return [100_000, label.toLowerCase()];
  return [best, label.toLowerCase()];
}

interface Lane {
  key: string;
  label: string;
  sublabel: string;
  sessions: SessionRecord[];
  codex: CodexSessionRecord[];
  looseTasks: TaskRecord[];
}

export function buildFlow(input: FlowInput): FlowGraph {
  const { workspaces, groups, agentsBySession, expandedSubagents, expandedTaskGroups, collapsedLanes, orientation } = input;
  const showEndedAgents = input.showEndedAgents === true;
  const laneKeyOf = (cwd: string | null | undefined): string => workspaceOf(workspaces, cwd) ?? OUTSIDE_LANE;
  const sessions = input.sessions.filter((session) => session.helperOf == null);
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));

  const lanes = new Map<string, Lane>();
  const ensureLane = (key: string, sublabel: string): Lane => {
    let lane = lanes.get(key);
    if (!lane) {
      lane = { key, label: key === OUTSIDE_LANE ? OUTSIDE_LABEL : key, sublabel, sessions: [], codex: [], looseTasks: [] };
      lanes.set(key, lane);
    }
    return lane;
  };

  for (const session of sessions) ensureLane(laneKeyOf(session.cwd), shortCwd(session.cwd)).sessions.push(session);
  for (const thread of input.codex) ensureLane(laneKeyOf(thread.cwd), shortCwd(thread.cwd)).codex.push(thread);
  for (const task of input.tasks) {
    if (task.sessionId && sessionById.has(task.sessionId)) continue;
    const key = task.workspace && sessions.some((session) => laneKeyOf(session.cwd) === task.workspace) ? task.workspace : laneKeyOf(task.cwd);
    ensureLane(key, shortCwd(task.cwd)).looseTasks.push(task);
  }

  const tasksBySession = new Map<string, TaskRecord[]>();
  for (const task of input.tasks) {
    if (task.sessionId && sessionById.has(task.sessionId)) {
      const list = tasksBySession.get(task.sessionId) ?? [];
      list.push(task);
      tasksBySession.set(task.sessionId, list);
    }
  }

  const ordered = [...lanes.values()].sort((a, b) => {
    const ra = laneRank(a.key, a.label, groups, workspaces);
    const rb = laneRank(b.key, b.label, groups, workspaces);
    return ra[0] - rb[0] || ra[1].localeCompare(rb[1]);
  });

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const children = new Map<string, string[]>();
  const add = (node: FlowNode) => {
    nodes.push(node);
    if (node.parent) {
      const list = children.get(node.parent) ?? [];
      list.push(node.id);
      children.set(node.parent, list);
      edges.push({ id: `${node.parent}->${node.id}`, from: node.parent, to: node.id });
    }
  };
  const base = (kind: FlowNodeKind, id: string, parent: string | null, lane: string): FlowNode => {
    const [w, h] = SIZES[kind];
    return { id, kind, title: "", subtitle: "", tone: "muted", x: 0, y: 0, w, h, depth: 0, parent, lane, running: false, dim: false, badge: null };
  };

  add({ ...base("hub", "hub", null, ""), title: "CC Hub", subtitle: `${sessions.length} live · ${input.codex.length} codex · ${input.tasks.length} tasks`, tone: "brand" });

  for (const lane of ordered) {
    const laneSessions = [...lane.sessions].sort((a, b) => statusRank[a.status] - statusRank[b.status] || b.updatedAt - a.updatedAt);
    const agentsRunningTotal = laneSessions.reduce((sum, session) => sum + (session.agentsRunning ?? 0), 0);
    const laneRunning =
      laneSessions.some((session) => session.status === "active" || session.status === "waiting") ||
      agentsRunningTotal > 0 ||
      lane.codex.some((thread) => thread.status === "active") ||
      lane.looseTasks.some(taskRunning) ||
      laneSessions.some((session) => (tasksBySession.get(session.sessionId) ?? []).some(taskRunning));
    const laneDim = !laneRunning;
    const wsId = `ws:${lane.key}`;
    add({
      ...base("workspace", wsId, "hub", lane.key),
      title: clip(lane.label, 22),
      subtitle: lane.key === OUTSIDE_LANE ? lane.sublabel : `${laneSessions.length} sessions`,
      tone: "brand",
      running: laneRunning,
      dim: laneDim,
      workspaceName: lane.key === OUTSIDE_LANE ? undefined : lane.key,
    });
    const collapsed = collapsedLanes.has(lane.key);
    if (collapsed) continue;

    for (const session of laneSessions) {
      const sid = `s:${session.sessionId}`;
      const total = session.agentsTotal ?? 0;
      const running = session.agentsRunning ?? 0;
      add({
        ...base("session", sid, wsId, lane.key),
        title: clip(session.customTitle ?? session.title ?? session.sessionId.slice(0, 8), 26),
        subtitle: staleSession(session) ? "inactive" : session.status,
        tone: sessionTone(session),
        running: session.status === "active" || running > 0,
        dim: laneDim,
        badge: running > 0 ? `${running} running` : showEndedAgents && total > 0 ? `${total} ended` : null,
        sessionId: session.sessionId,
      });

      if (running > 0 || (showEndedAgents && total > 0)) {
        const subId = `sub:${session.sessionId}`;
        add({
          ...base("subagents", subId, sid, lane.key),
          title: running > 0 ? `${running} running` : `${total} ended`,
          subtitle: running > 0 ? `of ${total} subagents` : "subagents",
          tone: running > 0 ? "go" : "muted",
          running: running > 0,
          dim: laneDim,
          sessionId: session.sessionId,
        });
        if (expandedSubagents.has(session.sessionId)) {
          const allAgents = [...(agentsBySession[session.sessionId] ?? [])].sort(
            (a, b) => Number(b.status === "running") - Number(a.status === "running") || b.updatedAt - a.updatedAt,
          );
          const agents = showEndedAgents ? allAgents : allAgents.filter((agent) => agent.status === "running");
          const hiddenEnded = allAgents.length - agents.length;
          for (const agent of agents.slice(0, MAX_AGENTS)) {
            add({
              ...base("agent", `a:${agent.agentId}`, subId, lane.key),
              title: clip(agent.agentType ?? "agent", 24),
              subtitle: agent.status === "running" ? "running" : "ended",
              tone: agent.status === "running" ? "go" : "muted",
              running: agent.status === "running",
              dim: laneDim,
              sessionId: session.sessionId,
            });
          }
          const rest = Math.max(0, agents.length - MAX_AGENTS) + hiddenEnded;
          if (rest > 0) {
            add({
              ...base("more", `more:${session.sessionId}`, subId, lane.key),
              title: `+${rest} ended`,
              subtitle: hiddenEnded > 0 ? "turn on show ended to list" : "collapsed",
              tone: "muted",
              dim: laneDim,
              sessionId: session.sessionId,
            });
          }
        }
      }

      for (const task of tasksBySession.get(session.sessionId) ?? []) {
        add({
          ...base("task", `t:${task.id}`, sid, lane.key),
          title: clip(task.title, 26),
          subtitle: `${task.runner} · ${task.status}`,
          tone: taskTone(task),
          running: taskRunning(task),
          dim: laneDim,
          taskId: task.id,
        });
      }
    }

    for (const thread of lane.codex) {
      add({
        ...base("codex", `c:${thread.id}`, wsId, lane.key),
        title: clip(thread.customTitle ?? thread.title, 26),
        subtitle: `codex · ${thread.status}`,
        tone: thread.status === "active" ? "go" : "muted",
        running: thread.status === "active",
        dim: laneDim,
        codexId: thread.id,
      });
    }

    if (lane.looseTasks.length > 0) {
      const groupId = `tg:${lane.key}`;
      const anyRunning = lane.looseTasks.some(taskRunning);
      add({
        ...base("taskgroup", groupId, wsId, lane.key),
        title: "delegated",
        subtitle: `no live session · ${lane.looseTasks.length}`,
        tone: anyRunning ? "pend" : "muted",
        running: anyRunning,
        dim: laneDim,
      });
      if (expandedTaskGroups.has(lane.key)) {
        for (const task of lane.looseTasks) {
          add({
            ...base("task", `t:${task.id}`, groupId, lane.key),
            title: clip(task.title, 26),
            subtitle: `${task.runner} · ${task.status}`,
            tone: taskTone(task),
            running: taskRunning(task),
            dim: laneDim,
            taskId: task.id,
          });
        }
      }
    }
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const task of input.tasks) {
    const originId = task.originSessionId;
    if (!originId || !sessionById.has(originId)) continue;
    const from = `s:${originId}`;
    const to = `t:${task.id}`;
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
    edges.push({ id: `origin:${originId}->${task.id}`, from, to, origin: true });
  }

  place(nodes, children, orientation);
  const width = nodes.reduce((max, node) => Math.max(max, node.x + node.w), 0) + MARGIN;
  const height = nodes.reduce((max, node) => Math.max(max, node.y + node.h), 0) + MARGIN;
  return { nodes, edges, width, height };
}

function place(nodes: FlowNode[], children: Map<string, string[]>, orientation: Orientation) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const horizontal = orientation === "horizontal";
  const gap = horizontal ? CROSS_GAP_H : CROSS_GAP_V;
  const cross = (node: FlowNode): number => (horizontal ? node.h : node.w);
  const cursor = { value: MARGIN };
  const centers = new Map<string, number>();

  const shiftSubtree = (id: string, delta: number): void => {
    const current = centers.get(id);
    if (current != null) centers.set(id, current + delta);
    for (const kid of children.get(id) ?? []) shiftSubtree(kid, delta);
  };

  const walk = (id: string, depth: number): number => {
    const node = byId.get(id);
    if (!node) return cursor.value;
    node.depth = depth;
    const kids = children.get(id) ?? [];
    let center: number;
    if (kids.length === 0) {
      center = cursor.value + cross(node) / 2;
      cursor.value += cross(node) + gap;
    } else {
      const start = cursor.value;
      for (const kid of kids) walk(kid, depth + 1);
      const span = cursor.value - gap - start;
      const own = cross(node);
      if (span < own) {
        const delta = (own - span) / 2;
        for (const kid of kids) shiftSubtree(kid, delta);
        cursor.value += own - span;
      }
      const first = centers.get(kids[0]!) ?? start;
      const last = centers.get(kids[kids.length - 1]!) ?? first;
      center = (first + last) / 2;
    }
    centers.set(id, center);
    return center;
  };
  walk("hub", 0);

  const mainAxis = horizontal ? DEPTH_MAIN_H : DEPTH_MAIN_V;
  for (const node of nodes) {
    const main = mainAxis[node.depth] ?? node.depth * (horizontal ? 292 : 168) + MARGIN;
    const center = centers.get(node.id) ?? MARGIN;
    if (horizontal) {
      node.x = main;
      node.y = center - node.h / 2;
    } else {
      node.y = main;
      node.x = center - node.w / 2;
    }
  }
}

export function relatives(edges: FlowEdge[], selected: string): Set<string> {
  const parentOf = new Map<string, string>();
  const kidsOf = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.origin) continue;
    parentOf.set(edge.to, edge.from);
    const list = kidsOf.get(edge.from) ?? [];
    list.push(edge.to);
    kidsOf.set(edge.from, list);
  }
  const keep = new Set<string>([selected]);
  let up: string | undefined = selected;
  while (up != null) {
    up = parentOf.get(up);
    if (up != null) keep.add(up);
  }
  const stack = [selected];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const kid of kidsOf.get(current) ?? []) {
      if (!keep.has(kid)) {
        keep.add(kid);
        stack.push(kid);
      }
    }
  }
  return keep;
}
