import { useEffect, useMemo, useRef, useState, type WheelEvent, type MouseEvent as ReactMouseEvent } from "react";
import { fetchAgents } from "../api";
import { claudeClient, codexClient, isHubRun } from "../clients";
import type { TaskRecord, WorkspaceRecord } from "../delegation";
import { isStale } from "../stale";
import type { AgentRecord, CodexSessionRecord, SessionRecord } from "../types";
import { workspaceOf } from "../wsmatch";

interface Props {
  sessions: Record<string, SessionRecord>;
  codexSessions: CodexSessionRecord[];
  tasks: TaskRecord[];
  workspaces: WorkspaceRecord[];
  onOpenSession: (sessionId: string) => void;
  onOpenTask: (taskId: string) => void;
}

type NodeKind = "hub" | "workspace" | "session" | "codex" | "agent" | "task";

interface FlowNode {
  id: string;
  kind: NodeKind;
  title: string;
  subtitle: string;
  tone: "go" | "pend" | "hold" | "muted" | "brand";
  x: number;
  y: number;
  w: number;
  h: number;
  parent: string | null;
  sessionId?: string;
  taskId?: string;
}

const COLUMN_X = [40, 300, 620, 980];
const SIZES: Record<NodeKind, [number, number]> = {
  hub: [180, 56],
  workspace: [200, 48],
  session: [260, 60],
  codex: [260, 60],
  agent: [220, 46],
  task: [220, 52],
};
const GAP = 14;

const sessionTone = (session: SessionRecord): FlowNode["tone"] =>
  isStale(session) ? "muted" : session.status === "active" ? "go" : session.status === "waiting" ? "pend" : session.status === "idle" ? "hold" : "muted";

const taskTone = (task: TaskRecord): FlowNode["tone"] =>
  task.status === "running" || task.status === "pending" ? "pend" : task.status === "completed" ? "go" : task.status === "cancelled" ? "muted" : "hold";

function layout(
  sessions: SessionRecord[],
  codex: CodexSessionRecord[],
  tasks: TaskRecord[],
  workspaces: WorkspaceRecord[],
  agentsBySession: Record<string, AgentRecord[]>,
): FlowNode[] {
  const nodes: FlowNode[] = [];
  const wsNames = new Map<string, string[]>();
  const push = (kind: NodeKind, id: string, title: string, subtitle: string, tone: FlowNode["tone"], parent: string | null, extra: Partial<FlowNode> = {}) => {
    const [w, h] = SIZES[kind];
    nodes.push({ id, kind, title, subtitle, tone, x: 0, y: 0, w, h, parent, ...extra });
  };
  push("hub", "hub", "CC Hub", `${sessions.length} sessions · ${codex.length} codex · ${tasks.length} tasks`, "brand", null);
  const wsOf = (cwd: string | null | undefined): string => workspaceOf(workspaces, cwd) ?? "other";
  const ensureWs = (name: string) => {
    if (!wsNames.has(name)) {
      wsNames.set(name, []);
      const ws = workspaces.find((item) => item.name === name);
      push("workspace", `ws:${name}`, name, ws ? `${ws.repos.length} repos` : "outside your workspaces", "brand", "hub");
    }
  };
  for (const session of sessions) {
    const ws = wsOf(session.cwd);
    ensureWs(ws);
    const id = `s:${session.sessionId}`;
    push("session", id, session.customTitle ?? session.title ?? session.sessionId.slice(0, 8), `${claudeClient(session.client).label} · ${session.status}`, sessionTone(session), `ws:${ws}`, { sessionId: session.sessionId });
    for (const agent of agentsBySession[session.sessionId] ?? []) {
      push("agent", `a:${agent.agentId}`, agent.agentType ?? "agent", agent.status === "running" ? "running" : agent.lastMessage?.slice(0, 40) ?? "ended", agent.status === "running" ? "go" : "muted", id, { sessionId: session.sessionId });
    }
  }
  for (const thread of codex) {
    const ws = wsOf(thread.cwd);
    ensureWs(ws);
    push("codex", `c:${thread.id}`, thread.title, `${codexClient(thread.client).label} · ${thread.status}`, thread.status === "active" ? "go" : "muted", `ws:${ws}`);
  }
  for (const task of tasks) {
    ensureWs(task.workspace);
    const parentSession = task.sessionId && sessions.some((s) => s.sessionId === task.sessionId) ? `s:${task.sessionId}` : `ws:${task.workspace}`;
    push("task", `t:${task.id}`, task.title, `${task.runner} · ${task.status}`, taskTone(task), parentSession, { taskId: task.id });
  }
  const columns: Record<NodeKind, number> = { hub: 0, workspace: 1, session: 2, codex: 2, agent: 3, task: 3 };
  const byColumn = new Map<number, FlowNode[]>();
  for (const node of nodes) {
    const column = node.kind === "task" && node.parent?.startsWith("ws:") ? 2 : columns[node.kind];
    node.x = COLUMN_X[column] ?? 0;
    if (!byColumn.has(column)) byColumn.set(column, []);
    byColumn.get(column)?.push(node);
  }
  const order = (list: FlowNode[]): FlowNode[] => {
    const parents = new Map<string, FlowNode[]>();
    for (const node of list) {
      const key = node.parent ?? "";
      if (!parents.has(key)) parents.set(key, []);
      parents.get(key)?.push(node);
    }
    return list;
  };
  let maxHeight = 0;
  for (const [column, list] of byColumn) {
    const sorted = column === 0 ? list : order(list).sort((a, b) => (a.parent ?? "").localeCompare(b.parent ?? ""));
    let y = 40;
    for (const node of sorted) {
      node.y = y;
      y += node.h + GAP;
    }
    maxHeight = Math.max(maxHeight, y);
  }
  for (const node of nodes) if (node.kind === "hub") node.y = Math.max(40, maxHeight / 2 - node.h / 2);
  return nodes;
}

const edgePath = (from: FlowNode, to: FlowNode): string => {
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  const dx = Math.max(40, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};

export function FlowView({ sessions, codexSessions, tasks, workspaces, onOpenSession, onOpenTask }: Props) {
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [agentsBySession, setAgentsBySession] = useState<Record<string, AgentRecord[]>>({});
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const liveSessions = useMemo(
    () => Object.values(sessions).filter((s) => s.archivedAt == null && s.status !== "ended" && !isStale(s) && !isHubRun(s.client)),
    [sessions],
  );
  const liveCodex = useMemo(() => codexSessions.filter((s) => s.status !== "ended"), [codexSessions]);
  const shownTasks = useMemo(() => tasks.filter((t) => t.status === "running" || t.status === "pending" || t.status === "attention").concat(tasks.filter((t) => t.status === "completed" || t.status === "failed").slice(0, 5)), [tasks]);

  useEffect(() => {
    let mounted = true;
    const withAgents = liveSessions.filter((s) => (s.agentsTotal ?? 0) > 0);
    void Promise.all(withAgents.map((s) => fetchAgents(s.sessionId).then((agents) => [s.sessionId, agents] as const).catch(() => [s.sessionId, []] as const))).then((pairs) => {
      if (mounted) setAgentsBySession(Object.fromEntries(pairs));
    });
    return () => {
      mounted = false;
    };
  }, [liveSessions]);

  const nodes = useMemo(() => layout(liveSessions, liveCodex, shownTasks, workspaces, agentsBySession), [liveSessions, liveCodex, shownTasks, workspaces, agentsBySession]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    const rect = svgRef.current?.getBoundingClientRect();
    const px = event.clientX - (rect?.left ?? 0);
    const py = event.clientY - (rect?.top ?? 0);
    setView((current) => {
      const k = Math.min(2.5, Math.max(0.3, current.k * factor));
      const x = px - (px - current.x) * (k / current.k);
      const y = py - (py - current.y) * (k / current.k);
      return { x, y, k };
    });
  };

  const onMouseDown = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, ox: view.x, oy: view.y };
  };
  const onMouseMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    setView((current) => ({ ...current, x: drag.current!.ox + (event.clientX - drag.current!.x), y: drag.current!.oy + (event.clientY - drag.current!.y) }));
  };
  const endDrag = () => {
    drag.current = null;
  };

  const activate = (node: FlowNode) => {
    if (node.kind === "session" && node.sessionId) onOpenSession(node.sessionId);
    if (node.kind === "agent" && node.sessionId) onOpenSession(node.sessionId);
    if (node.kind === "task" && node.taskId) onOpenTask(node.taskId);
  };

  return (
    <div className="view view--flow">
      <div className="flow__bar">
        <p className="hint">
          Live map: workspaces → sessions and Codex threads → subagents and delegated tasks. Drag to pan, wheel to zoom, click a node to open it.
        </p>
        <div className="flow__controls">
          <span className="legend"><i className="legend__dot legend__dot--go" /> active</span>
          <span className="legend"><i className="legend__dot legend__dot--pend" /> waiting / running</span>
          <span className="legend"><i className="legend__dot legend__dot--hold" /> idle / failed</span>
          <button className="act" onClick={() => setView({ x: 0, y: 0, k: 1 })}>Reset view</button>
        </div>
      </div>
      <div className="flow__canvas">
        <svg
          ref={svgRef}
          className="flow"
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {nodes.map((node) => {
              const parent = node.parent ? byId.get(node.parent) : null;
              return parent ? <path key={`e:${node.id}`} className="flow__edge" d={edgePath(parent, node)} /> : null;
            })}
            {nodes.map((node) => (
              <g
                key={node.id}
                className={`flow__node flow__node--${node.kind} flow__node--${node.tone}`}
                transform={`translate(${node.x} ${node.y})`}
                onClick={() => activate(node)}
              >
                <rect width={node.w} height={node.h} rx={10} />
                <rect className="flow__stripe" width={4} height={node.h} rx={2} />
                <text className="flow__title" x={14} y={node.kind === "hub" ? 24 : 22}>
                  {node.title.length > 30 ? `${node.title.slice(0, 29)}…` : node.title}
                </text>
                <text className="flow__sub" x={14} y={node.kind === "hub" ? 42 : 40}>
                  {node.subtitle.length > 38 ? `${node.subtitle.slice(0, 37)}…` : node.subtitle}
                </text>
              </g>
            ))}
          </g>
        </svg>
        {nodes.length <= 1 && <p className="empty">Nothing live right now. Sessions, threads and tasks show up here as they run.</p>}
      </div>
    </div>
  );
}
