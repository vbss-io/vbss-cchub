import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode, type WheelEvent, type MouseEvent as ReactMouseEvent } from "react";
import { fetchAgents, reportUiError } from "../api";
import { claudeClient, codexClient, isHubRun, sessionClient } from "../clients";
import type { TaskRecord, WorkspaceRecord } from "../delegation";
import { FlowInspector } from "../components/FlowInspector";
import { buildFlow, relatives, type FlowNode, type Orientation } from "../flow-layout";
import { IconCode, IconCodex, IconDesktop, IconFlow, IconHub, IconSearch, IconTasks, IconTerminal, IconWorkspaces } from "../icons";
import { isStale } from "../stale";
import type { AgentRecord, CodexSessionRecord, GroupRecord, SessionRecord } from "../types";

interface Props {
  sessions: Record<string, SessionRecord>;
  codexSessions: CodexSessionRecord[];
  tasks: TaskRecord[];
  workspaces: WorkspaceRecord[];
  groups: GroupRecord[];
  onOpenSession: (sessionId: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenCodex: (id: string) => void;
  onFocus: (sessionId: string) => void;
  onOpenWorkspace: (name: string) => void;
}

type Pill = "live" | "subagents" | "tasks" | "needsyou";
type ClientFilter = "all" | "terminal" | "vscode" | "claude-desktop" | "wsl" | "hub" | "share" | "codex";

const PILLS: { key: Pill; label: string }[] = [
  { key: "live", label: "Live" },
  { key: "subagents", label: "With subagents" },
  { key: "tasks", label: "With tasks" },
  { key: "needsyou", label: "Needs you" },
];

const CLIENT_FILTERS: { key: ClientFilter; label: string }[] = [
  { key: "all", label: "All clients" },
  { key: "terminal", label: "Claude Code · terminal" },
  { key: "vscode", label: "Claude Code · VS Code" },
  { key: "claude-desktop", label: "Claude Desktop" },
  { key: "wsl", label: "WSL" },
  { key: "hub", label: "Hub runs (headless)" },
  { key: "share", label: "Share forks" },
  { key: "codex", label: "Codex threads" },
];

const LEGEND_SHAPES: { key: string; label: string; icon: ReactNode }[] = [
  { key: "hub", label: "hub", icon: <IconHub size={13} /> },
  { key: "workspace", label: "workspace", icon: <IconWorkspaces size={13} /> },
  { key: "session", label: "Claude session (terminal / VS Code / Desktop)", icon: <IconTerminal size={13} /> },
  { key: "codex", label: "Codex thread", icon: <IconCodex size={13} /> },
  { key: "subagents", label: "subagents", icon: <IconFlow size={13} /> },
  { key: "task", label: "delegated task", icon: <IconTasks size={13} /> },
];

const SHORT_CLIENT: Record<string, string> = {
  "Claude Code · terminal": "terminal",
  "Claude Code · VS Code": "VS Code",
  "Claude Code · WSL": "WSL",
  "Claude Code · headless": "headless",
  "Claude Desktop": "Desktop",
  "Codex · VS Code": "Codex VS Code",
};

const shortClient = (label: string): string => SHORT_CLIENT[label] ?? label;

const LEGEND_TONES: { tone: string; label: string }[] = [
  { tone: "go", label: "active" },
  { tone: "pend", label: "waiting" },
  { tone: "hold", label: "idle" },
  { tone: "muted", label: "ended" },
];

type Period = "today" | "7d" | "30d" | "all";

const DAY_MS = 86_400_000;

const PERIODS: { key: Period; label: string; ms: number }[] = [
  { key: "today", label: "Today (24 h)", ms: DAY_MS },
  { key: "7d", label: "Last 7 days", ms: 7 * DAY_MS },
  { key: "30d", label: "Last 30 days", ms: 30 * DAY_MS },
  { key: "all", label: "All time", ms: Infinity },
];

const loadPeriod = (): Period => {
  const stored = localStorage.getItem("hub.flow.period");
  return PERIODS.some((item) => item.key === stored) ? (stored as Period) : "7d";
};

const periodMs = (period: Period): number => PERIODS.find((item) => item.key === period)?.ms ?? Infinity;

const matchesClient = (session: SessionRecord, filter: ClientFilter): boolean => {
  if (filter === "all") return true;
  if (filter === "codex") return false;
  if (filter === "hub") return isHubRun(session.client);
  if (filter === "share") return session.client === "share";
  return claudeClient(session.client).label === claudeClient(filter).label;
};

const nameOf = (session: SessionRecord): string => session.customTitle ?? session.title ?? session.sessionId.slice(0, 8);

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const originOf = (
  task: TaskRecord | null,
  sessions: Record<string, SessionRecord>,
): { label: string; sessionId: string | null } | null => {
  if (!task) return null;
  if (task.originSessionId) {
    const s = sessions[task.originSessionId];
    const name = s ? s.customTitle ?? s.title ?? task.originSessionId.slice(0, 8) : task.originSessionId.slice(0, 8);
    return { label: name, sessionId: task.originSessionId };
  }
  if (task.originClient === "codex") return { label: "Codex", sessionId: null };
  if (task.originClient === "share") return { label: "share", sessionId: null };
  if (task.originClient === "claude-code") return { label: "Claude Code", sessionId: null };
  return null;
};

const loadOrientation = (): Orientation => (localStorage.getItem("hub.flow.orientation") === "vertical" ? "vertical" : "horizontal");

const edgePath = (from: FlowNode, to: FlowNode, orientation: Orientation): string => {
  if (orientation === "horizontal") {
    const x1 = from.x + from.w;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const dx = Math.max(30, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  const x1 = from.x + from.w / 2;
  const y1 = from.y + from.h;
  const x2 = to.x + to.w / 2;
  const y2 = to.y;
  const dy = Math.max(30, (y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
};

class FlowBoundaryInner extends Component<{ resetKey: number; onReset: () => void; children: ReactNode }, { failed: boolean; message: string }> {
  state = { failed: false, message: "" };
  static getDerivedStateFromError(error: Error): { failed: boolean; message: string } {
    return { failed: true, message: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("flow map crashed", error, info.componentStack);
    void reportUiError("flow", error, info.componentStack ?? null);
  }
  componentDidUpdate(prev: { resetKey: number }): void {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false, message: "" });
  }
  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="flow__crash">
          <p>The map hit an error.</p>
          <p className="muted small">{this.state.message || "unknown error"} · logged to ui-errors.log in the hub data folder</p>
          <button className="act act--focus" onClick={this.props.onReset}>
            Reload map
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function FlowErrorBoundary({ children }: { children: ReactNode }) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <FlowBoundaryInner resetKey={resetKey} onReset={() => setResetKey((value) => value + 1)}>
      {children}
    </FlowBoundaryInner>
  );
}

export function FlowView(props: Props) {
  return (
    <FlowErrorBoundary>
      <FlowCanvasView {...props} />
    </FlowErrorBoundary>
  );
}

function FlowCanvasView({ sessions, codexSessions, tasks, workspaces, groups, onOpenSession, onOpenTask, onOpenCodex, onFocus, onOpenWorkspace }: Props) {
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [orientation, setOrientation] = useState<Orientation>(loadOrientation);
  const [pill, setPill] = useState<Pill>("live");
  const [clientFilter, setClientFilter] = useState<ClientFilter>("all");
  const [query, setQuery] = useState("");
  const [showEnded, setShowEnded] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [period, setPeriod] = useState<Period>(loadPeriod);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [expandedSubagents, setExpandedSubagents] = useState<Set<string>>(() => new Set());
  const [expandedTaskGroups, setExpandedTaskGroups] = useState<Set<string>>(() => new Set());
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(() => new Set());
  const [agentsBySession, setAgentsBySession] = useState<Record<string, AgentRecord[]>>({});
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    localStorage.setItem("hub.flow.orientation", orientation);
  }, [orientation]);

  useEffect(() => {
    localStorage.setItem("hub.flow.period", period);
  }, [period]);

  const baseLive = useMemo(
    () =>
      Object.values(sessions).filter(
        (session) => session.helperOf == null && !isHubRun(session.client) && session.archivedAt == null && !isStale(session) && session.status !== "ended",
      ),
    [sessions],
  );

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const cutoff = Date.now() - periodMs(period);
    return Object.values(sessions).filter((session) => {
      if (session.helperOf != null) return false;
      if (isHubRun(session.client) && clientFilter !== "hub" && clientFilter !== "share") return false;
      if (session.archivedAt != null) return false;
      const ended = session.status === "ended";
      const stale = isStale(session);
      if ((ended || stale) && !(showEnded && session.updatedAt >= cutoff)) return false;
      if (!matchesClient(session, clientFilter)) return false;
      if (pill === "subagents" && (session.agentsTotal ?? 0) === 0) return false;
      if (pill === "tasks" && !tasks.some((task) => task.sessionId === session.sessionId)) return false;
      if (pill === "needsyou" && !(session.status === "waiting" || session.status === "idle")) return false;
      if (needle && !`${nameOf(session)} ${session.cwd ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [sessions, tasks, pill, clientFilter, query, showEnded, period]);

  const toggleCounts = useMemo(() => {
    const cutoff = Date.now() - periodMs(period);
    const endedSessions = Object.values(sessions).filter((session) => {
      if (session.helperOf != null || session.archivedAt != null) return false;
      if (isHubRun(session.client) && clientFilter !== "hub" && clientFilter !== "share") return false;
      if (!matchesClient(session, clientFilter)) return false;
      return (session.status === "ended" || isStale(session)) && session.updatedAt >= cutoff;
    }).length;
    const endedCodex =
      clientFilter === "all" || clientFilter === "codex"
        ? codexSessions.filter((thread) => !thread.hidden && thread.archivedAt == null && thread.status === "ended" && thread.updatedAt >= cutoff).length
        : 0;
    const completed = tasks.filter((task) => (task.status === "completed" || task.status === "cancelled") && task.updatedAt >= cutoff).length;
    return { ended: endedSessions + endedCodex, completed };
  }, [sessions, codexSessions, tasks, clientFilter, period]);

  const filteredCodex = useMemo(() => {
    if (clientFilter !== "all" && clientFilter !== "codex") return [];
    if (pill === "subagents" || pill === "tasks" || pill === "needsyou") return [];
    const needle = query.trim().toLowerCase();
    const cutoff = Date.now() - periodMs(period);
    return codexSessions.filter((thread) => {
      if (thread.hidden || thread.archivedAt != null) return false;
      if (thread.status === "ended" && !(showEnded && thread.updatedAt >= cutoff)) return false;
      if (needle && !`${thread.customTitle ?? thread.title} ${thread.cwd ?? ""}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [codexSessions, clientFilter, pill, query, showEnded, period]);

  const filteredTasks = useMemo(() => {
    const cutoff = Date.now() - periodMs(period);
    return tasks.filter((task) => {
      const finished = task.status === "completed" || task.status === "cancelled";
      if (!finished) return true;
      return showCompleted && task.updatedAt >= cutoff;
    });
  }, [tasks, showCompleted, period]);

  useEffect(() => {
    let mounted = true;
    const withAgents = filteredSessions.filter((session) => (session.agentsTotal ?? 0) > 0 && session.status !== "ended");
    const load = () => {
      void Promise.all(
        withAgents.map((session) =>
          fetchAgents(session.sessionId)
            .then((agents) => [session.sessionId, agents] as const)
            .catch(() => [session.sessionId, []] as const),
        ),
      ).then((pairs) => {
        if (mounted) setAgentsBySession((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
      });
    };
    load();
    const id = setInterval(load, 5_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredSessions.map((s) => s.sessionId).join(",")]);

  const agentsSignature = useMemo(
    () =>
      [...expandedSubagents]
        .map((id) => `${id}:${(agentsBySession[id] ?? []).length}:${(agentsBySession[id] ?? []).filter((a) => a.status === "running").length}`)
        .join("|"),
    [expandedSubagents, agentsBySession],
  );

  const layoutKey = useMemo(() => {
    const sessionSig = filteredSessions
      .map((s) => `${s.sessionId}:${s.status}:${s.agentsTotal ?? 0}:${s.agentsRunning ?? 0}:${s.cwd ?? ""}`)
      .sort()
      .join(",");
    const codexSig = filteredCodex.map((c) => `${c.id}:${c.status}`).sort().join(",");
    const taskSig = filteredTasks.map((t) => `${t.id}:${t.status}:${t.sessionId ?? ""}:${t.originSessionId ?? ""}:${t.workspace}`).sort().join(",");
    const laneSig = `${groups.map((g) => `${g.name}:${g.match}:${g.position}`).join(",")}|${workspaces.map((w) => w.name).join(",")}`;
    const expandSig = `${[...expandedSubagents].sort().join(",")}|${[...expandedTaskGroups].sort().join(",")}|${[...collapsedLanes].sort().join(",")}`;
    return `${orientation}||${sessionSig}||${codexSig}||${taskSig}||${laneSig}||${expandSig}||${agentsSignature}`;
  }, [filteredSessions, filteredCodex, filteredTasks, groups, workspaces, orientation, expandedSubagents, expandedTaskGroups, collapsedLanes, agentsSignature, showEnded, period]);

  const graph = useMemo(
    () =>
      buildFlow({
        sessions: filteredSessions,
        codex: filteredCodex,
        tasks: filteredTasks,
        workspaces,
        groups,
        agentsBySession,
        expandedSubagents,
        expandedTaskGroups,
        collapsedLanes,
        orientation,
        showEndedAgents: showEnded,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey],
  );

  const byId = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph]);
  const highlight = useMemo(() => (selected ? relatives(graph.edges, selected) : null), [graph, selected]);

  const kindIcon = useCallback(
    (node: FlowNode): ReactNode => {
      if (node.kind === "hub") return <IconHub size={14} />;
      if (node.kind === "workspace") return <IconWorkspaces size={14} />;
      if (node.kind === "codex") return <IconCodex size={14} />;
      if (node.kind === "subagents" || node.kind === "agent" || node.kind === "more") return <IconFlow size={14} />;
      if (node.kind === "task" || node.kind === "taskgroup") return <IconTasks size={14} />;
      if (node.kind === "session" && node.sessionId) {
        const s = sessions[node.sessionId];
        const family = s ? claudeClient(s.client) : null;
        if (!family) return <IconTerminal size={14} />;
        if (family.label === "Claude Desktop") return <IconDesktop size={14} />;
        if (family.label.includes("VS Code")) return <IconCode size={14} />;
        if (family.family === "hub") return <IconHub size={14} />;
        return <IconTerminal size={14} />;
      }
      return null;
    },
    [sessions],
  );

  const clientBadge = useCallback(
    (node: FlowNode): string | null => {
      if (node.kind === "session" && node.sessionId) {
        const s = sessions[node.sessionId];
        return s ? clip(shortClient(sessionClient(s).label), 22) : null;
      }
      if (node.kind === "codex" && node.codexId) {
        const thread = codexSessions.find((item) => item.id === node.codexId);
        return thread ? clip(shortClient(codexClient(thread.client).label), 22) : null;
      }
      if (node.kind === "task" && node.taskId) {
        const found = tasks.find((item) => item.id === node.taskId);
        return found ? found.runner : null;
      }
      return null;
    },
    [sessions, codexSessions, tasks],
  );

  const summary = useMemo(() => {
    const live = baseLive.length;
    const subagents = baseLive.reduce((sum, s) => sum + (s.agentsRunning ?? 0), 0);
    const running = tasks.filter((t) => t.status === "running" || t.status === "pending").length;
    const need = baseLive.filter((s) => s.status === "waiting" || s.status === "idle").length;
    return { live, subagents, running, need };
  }, [baseLive, tasks]);

  const fit = useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || graph.width === 0 || graph.height === 0) return;
    const k = Math.min(1.4, Math.max(0.3, Math.min(rect.width / graph.width, rect.height / graph.height) * 0.92));
    setView({ x: (rect.width - graph.width * k) / 2, y: (rect.height - graph.height * k) / 2, k });
  }, [graph.width, graph.height]);

  useEffect(() => {
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orientation]);

  const interactedRef = useRef(false);
  useEffect(() => {
    if (interactedRef.current || graph.width === 0 || graph.height === 0) return;
    fit();
  }, [graph.width, graph.height, fit]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onWheel = (event: WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.12 : 0.89);
  };

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    interactedRef.current = true;
    const rect = svgRef.current?.getBoundingClientRect();
    const px = clientX - (rect?.left ?? 0);
    const py = clientY - (rect?.top ?? 0);
    setView((current) => {
      const k = Math.min(2.5, Math.max(0.25, current.k * factor));
      return { x: px - (px - current.x) * (k / current.k), y: py - (py - current.y) * (k / current.k), k };
    });
  };

  const zoomCenter = (factor: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect) zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  };

  const onMouseDown = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, ox: view.x, oy: view.y, moved: false };
  };
  const onMouseMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (!active) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      active.moved = true;
      interactedRef.current = true;
    }
    const x = active.ox + dx;
    const y = active.oy + dy;
    setView((current) => ({ ...current, x, y }));
  };
  const endDrag = () => {
    drag.current = null;
  };

  const toggleSet = (setter: (fn: (prev: Set<string>) => Set<string>) => void, key: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const mainAction = (node: FlowNode) => {
    if (node.kind === "session" && node.sessionId) onOpenSession(node.sessionId);
    else if (node.kind === "agent" && node.sessionId) onOpenSession(node.sessionId);
    else if (node.kind === "codex" && node.codexId) onOpenCodex(node.codexId);
    else if (node.kind === "task" && node.taskId) onOpenTask(node.taskId);
    else if (node.kind === "workspace" && node.workspaceName) onOpenWorkspace(node.workspaceName);
    else if (node.kind === "subagents" && node.sessionId) toggleSet(setExpandedSubagents, node.sessionId);
    else if (node.kind === "more" && node.sessionId) toggleSet(setExpandedSubagents, node.sessionId);
    else if (node.kind === "taskgroup") toggleSet(setExpandedTaskGroups, node.lane);
  };

  const isExpanded = (node: FlowNode): boolean =>
    node.kind === "taskgroup" ? expandedTaskGroups.has(node.lane) : node.sessionId ? expandedSubagents.has(node.sessionId) : false;

  const onNodeClick = (event: ReactMouseEvent, node: FlowNode) => {
    event.stopPropagation();
    if (drag.current?.moved) return;
    setSelected(node.id);
  };

  const hoverPath = useMemo(() => {
    if (!hovered) return null;
    const chain: string[] = [];
    let cursor: FlowNode | undefined = byId.get(hovered);
    while (cursor) {
      chain.unshift(cursor.title || cursor.kind);
      cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
    }
    return chain.join(" › ");
  }, [hovered, byId]);

  const selectedNode = selected ? byId.get(selected) ?? null : null;
  const dimmedCount = highlight ? graph.nodes.filter((n) => !highlight.has(n.id)).length : 0;

  return (
    <div className={`view view--flow flow--${orientation}`}>
      <div className="flow__bar">
        <div className="flow__filters">
          {PILLS.map((item) => (
            <button key={item.key} className={`pill ${pill === item.key ? "pill--on" : ""}`} onClick={() => setPill(item.key)}>
              {item.label}
            </button>
          ))}
          <label className="search">
            <IconSearch />
            <input className="in" placeholder="search title or folder" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <select className="select" value={clientFilter} onChange={(event) => setClientFilter(event.target.value as ClientFilter)}>
            {CLIENT_FILTERS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
          <select
            className="select"
            value={period}
            onChange={(event) => setPeriod(event.target.value as Period)}
            title="Live items always show; ended sessions/threads and completed tasks show only when their toggle is on and they updated within this period"
          >
            {PERIODS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
          <label className="flow__toggle">
            <input type="checkbox" checked={showEnded} onChange={(event) => setShowEnded(event.target.checked)} /> show ended ({toggleCounts.ended})
          </label>
          <label className="flow__toggle">
            <input type="checkbox" checked={showCompleted} onChange={(event) => setShowCompleted(event.target.checked)} /> show completed tasks ({toggleCounts.completed})
          </label>
        </div>
        <p className="flow__summary">
          {summary.live} live sessions · {summary.subagents} subagents running · {summary.running} tasks running · {summary.need} need you
        </p>
      </div>

      <div className="flow__controls">
        <div className="flow__legend">
          {LEGEND_SHAPES.map((item) => (
            <span key={item.key} className="legend legend--kind">
              <span className="flow__legend-icon">{item.icon}</span> {item.label}
            </span>
          ))}
          {LEGEND_TONES.map((item) => (
            <span key={item.tone} className="legend">
              <i className={`legend__dot legend__dot--${item.tone}`} /> {item.label}
            </span>
          ))}
          <span className="legend legend--badge">
            <i className="legend__badge" /> client badge
          </span>
          <span className="legend">
            <i className="legend__dash" /> delegated by
          </span>
        </div>
        <div className="flow__buttons">
          <span className="flow__hint">{hoverPath ?? "click a node to inspect · double-click to open · Esc clears"}</span>
          <div className="pillpair">
            <button className={`pill ${orientation === "horizontal" ? "pill--on" : ""}`} onClick={() => setOrientation("horizontal")}>
              Horizontal
            </button>
            <button className={`pill ${orientation === "vertical" ? "pill--on" : ""}`} onClick={() => setOrientation("vertical")}>
              Vertical
            </button>
          </div>
          <button className="act" onClick={fit}>
            Fit
          </button>
          <button className="act act--icon" onClick={() => zoomCenter(0.89)} aria-label="Zoom out">
            −
          </button>
          <button className="act act--icon" onClick={() => zoomCenter(1.12)} aria-label="Zoom in">
            +
          </button>
          <button className="act" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
            Reset
          </button>
        </div>
      </div>

      <div className={`flow__canvas ${selectedNode ? "flow__canvas--panel" : ""}`}>
        <svg
          ref={svgRef}
          className="flow"
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={() => {
            endDrag();
            setHovered(null);
          }}
          onClick={() => {
            if (!drag.current?.moved) setSelected(null);
          }}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {graph.edges.map((edge) => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              if (!from || !to) return null;
              const active = highlight != null && highlight.has(edge.from) && highlight.has(edge.to);
              const dim = highlight != null && !active;
              return (
                <path
                  key={edge.id}
                  className={`flow__edge ${edge.origin ? "flow__edge--origin" : ""} ${active ? "flow__edge--on" : ""} ${dim ? "flow__edge--dim" : ""}`}
                  d={edgePath(from, to, orientation)}
                />
              );
            })}
            {graph.nodes.map((node) => {
              const isSelected = node.id === selected;
              const dim = (highlight != null && !highlight.has(node.id)) || (node.dim && node.kind !== "hub" && highlight == null);
              return (
                <g
                  key={node.id}
                  className={`flow__node flow__node--${node.kind} flow__node--${node.tone} ${isSelected ? "flow__node--sel" : ""} ${dim ? "flow__node--dim" : ""}`}
                  transform={`translate(${node.x} ${node.y})`}
                  onClick={(event) => onNodeClick(event, node)}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    mainAction(node);
                  }}
                  onMouseEnter={() => setHovered(node.id)}
                >
                  <rect width={node.w} height={node.h} rx={10} />
                  <rect className="flow__stripe" width={4} height={node.h} rx={2} />
                  <g className="flow__icon" transform={`translate(12 ${node.kind === "hub" ? 14 : 13})`}>
                    {kindIcon(node)}
                  </g>
                  <text className="flow__title" x={32} y={node.kind === "hub" ? 24 : 23}>
                    {node.title}
                  </text>
                  <text className="flow__sub" x={32} y={node.kind === "hub" ? 42 : 41}>
                    {node.subtitle}
                  </text>
                  {node.badge && (
                    <text className="flow__badge" x={node.w - 12} y={23} textAnchor="end">
                      {node.badge}
                    </text>
                  )}
                  {(() => {
                    const label = clientBadge(node);
                    return label ? (
                      <text className="flow__client" x={node.w - 12} y={41} textAnchor="end">
                        {label}
                      </text>
                    ) : null;
                  })()}
                  {(node.kind === "subagents" || node.kind === "taskgroup") && (
                    <g
                      className="flow__expander"
                      transform={`translate(${node.w - 30} ${node.h / 2 - 10})`}
                      onClick={(event) => {
                        event.stopPropagation();
                        mainAction(node);
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      <title>{isExpanded(node) ? "Collapse" : "Expand"}</title>
                      <rect width={20} height={20} rx={6} />
                      <text x={10} y={14.5} textAnchor="middle">
                        {isExpanded(node) ? "−" : "+"}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        {graph.nodes.length <= 1 && <p className="empty">Nothing matches this filter. Start a session or clear the filters.</p>}
        {selectedNode && (
          <FlowInspectorPanel
            node={selectedNode}
            sessions={sessions}
            codexSessions={codexSessions}
            tasks={tasks}
            collapsedLanes={collapsedLanes}
            expandedSubagents={expandedSubagents}
            expandedTaskGroups={expandedTaskGroups}
            onClose={() => setSelected(null)}
            onOpenSession={onOpenSession}
            onOpenCodex={onOpenCodex}
            onOpenTask={onOpenTask}
            onFocus={onFocus}
            onOpenWorkspace={onOpenWorkspace}
            onToggleLane={(key) => toggleSet(setCollapsedLanes, key)}
            onToggleSubagents={(id) => toggleSet(setExpandedSubagents, id)}
            onToggleTaskGroup={(key) => toggleSet(setExpandedTaskGroups, key)}
          />
        )}
        {highlight != null && <span className="flow__meta" data-dimmed={dimmedCount} hidden />}
      </div>
    </div>
  );
}

interface PanelProps {
  node: FlowNode;
  sessions: Record<string, SessionRecord>;
  codexSessions: CodexSessionRecord[];
  tasks: TaskRecord[];
  collapsedLanes: Set<string>;
  expandedSubagents: Set<string>;
  expandedTaskGroups: Set<string>;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenCodex: (id: string) => void;
  onOpenTask: (id: string) => void;
  onFocus: (sessionId: string) => void;
  onOpenWorkspace: (name: string) => void;
  onToggleLane: (key: string) => void;
  onToggleSubagents: (sessionId: string) => void;
  onToggleTaskGroup: (key: string) => void;
}

function FlowInspectorPanel({
  node,
  sessions,
  codexSessions,
  tasks,
  collapsedLanes,
  expandedSubagents,
  expandedTaskGroups,
  onClose,
  onOpenSession,
  onOpenCodex,
  onOpenTask,
  onFocus,
  onOpenWorkspace,
  onToggleLane,
  onToggleSubagents,
  onToggleTaskGroup,
}: PanelProps) {
  const session = node.sessionId ? sessions[node.sessionId] ?? null : null;
  const codex = node.codexId ? codexSessions.find((thread) => thread.id === node.codexId) ?? null : null;
  const task = node.taskId ? tasks.find((item) => item.id === node.taskId) ?? null : null;
  const origin = originOf(task, sessions);
  const expanded = node.kind === "taskgroup" ? expandedTaskGroups.has(node.lane) : node.sessionId ? expandedSubagents.has(node.sessionId) : false;
  return (
    <FlowInspector
      node={node}
      session={node.kind === "session" || node.kind === "subagents" || node.kind === "agent" ? session : null}
      codex={codex}
      task={task}
      origin={origin}
      laneCollapsed={collapsedLanes.has(node.lane)}
      expanded={expanded}
      onClose={onClose}
      onOpenSession={onOpenSession}
      onOpenCodex={onOpenCodex}
      onOpenTask={onOpenTask}
      onFocus={onFocus}
      onOpenWorkspace={onOpenWorkspace}
      onToggleLane={onToggleLane}
      onToggleSubagents={onToggleSubagents}
      onToggleTaskGroup={onToggleTaskGroup}
    />
  );
}
