import { claudeClient, codexClient } from "../clients";
import type { TaskRecord } from "../delegation";
import { IconClose } from "../icons";
import type { CodexSessionRecord, SessionRecord } from "../types";
import type { FlowNode } from "../flow-layout";

interface Props {
  node: FlowNode;
  session: SessionRecord | null;
  codex: CodexSessionRecord | null;
  task: TaskRecord | null;
  origin: { label: string; sessionId: string | null } | null;
  laneCollapsed: boolean;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenCodex: (id: string) => void;
  onOpenTask: (id: string) => void;
  onFocus: (sessionId: string) => void;
  onOpenWorkspace: (name: string) => void;
  onToggleLane: (key: string) => void;
  onToggleSubagents: (sessionId: string) => void;
  onToggleTaskGroup: (key: string) => void;
  expanded: boolean;
}

const KIND_LABEL: Record<FlowNode["kind"], string> = {
  hub: "Hub",
  workspace: "Workspace",
  session: "Claude session",
  codex: "Codex thread",
  subagents: "Subagents",
  agent: "Subagent",
  task: "Delegated task",
  taskgroup: "Delegated (no live session)",
  more: "Ended subagents",
};

interface Row {
  label: string;
  value: string;
}

export function FlowInspector({
  node,
  session,
  codex,
  task,
  origin,
  laneCollapsed,
  onClose,
  onOpenSession,
  onOpenCodex,
  onOpenTask,
  onFocus,
  onOpenWorkspace,
  onToggleLane,
  onToggleSubagents,
  onToggleTaskGroup,
  expanded,
}: Props) {
  const rows: Row[] = [];
  const actions: { label: string; run: () => void; primary?: boolean }[] = [];

  if (node.kind === "session" && session) {
    rows.push({ label: "Status", value: node.subtitle });
    rows.push({ label: "Client", value: claudeClient(session.client).label });
    if (session.cwd) rows.push({ label: "Folder", value: session.cwd });
    if (node.badge) rows.push({ label: "Subagents", value: `${node.badge} running` });
    if (session.forkOf) rows.push({ label: "Fork of", value: session.forkOf.slice(0, 8) });
    if ((session.delegatedTasks ?? 0) > 0) rows.push({ label: "Delegated", value: `${session.delegatedTasks} task${session.delegatedTasks === 1 ? "" : "s"}` });
    actions.push({ label: "Open details", run: () => onOpenSession(session.sessionId), primary: true });
    if (session.status !== "ended" && session.hostPid) actions.push({ label: "Focus", run: () => onFocus(session.sessionId) });
  } else if (node.kind === "codex" && codex) {
    rows.push({ label: "Status", value: codex.status });
    rows.push({ label: "Client", value: codexClient(codex.client).label });
    if (codex.cwd) rows.push({ label: "Folder", value: codex.cwd });
    rows.push({ label: "Turns", value: String(codex.turns) });
    actions.push({ label: "Open details", run: () => onOpenCodex(codex.id), primary: true });
  } else if (node.kind === "task" && task) {
    rows.push({ label: "Status", value: task.status });
    rows.push({ label: "Runner", value: task.runner });
    rows.push({ label: "Workspace", value: task.workspace });
    if (origin) rows.push({ label: "Delegated by", value: origin.label });
    if (task.lastError) rows.push({ label: "Last error", value: task.lastError });
    actions.push({ label: "Open in Delegated", run: () => onOpenTask(task.id), primary: true });
    if (origin?.sessionId) actions.push({ label: "Open delegating session", run: () => onOpenSession(origin.sessionId!) });
  } else if (node.kind === "workspace") {
    rows.push({ label: "Lane", value: node.subtitle });
    if (node.workspaceName) actions.push({ label: "Open workspace", run: () => onOpenWorkspace(node.workspaceName!), primary: true });
    actions.push({ label: laneCollapsed ? "Expand lane" : "Collapse lane", run: () => onToggleLane(node.lane) });
  } else if (node.kind === "subagents" && node.sessionId) {
    rows.push({ label: "Subagents", value: node.title });
    rows.push({ label: "Running", value: node.subtitle });
    actions.push({ label: expanded ? "Collapse" : "Expand", run: () => onToggleSubagents(node.sessionId!), primary: true });
    actions.push({ label: "Open session", run: () => onOpenSession(node.sessionId!) });
  } else if (node.kind === "taskgroup") {
    rows.push({ label: "Tasks", value: node.subtitle });
    actions.push({ label: expanded ? "Collapse" : "Expand", run: () => onToggleTaskGroup(node.lane), primary: true });
  } else if (node.kind === "agent") {
    rows.push({ label: "Type", value: node.title });
    rows.push({ label: "Status", value: node.subtitle });
    if (node.sessionId) actions.push({ label: "Open session", run: () => onOpenSession(node.sessionId!), primary: true });
  } else if (node.kind === "hub") {
    rows.push({ label: "Summary", value: node.subtitle });
  }

  return (
    <aside className="flow-inspect" aria-label="Node details">
      <div className="flow-inspect__head">
        <div>
          <span className="flow-inspect__kind">{KIND_LABEL[node.kind]}</span>
          <h3 className="flow-inspect__title">{node.title}</h3>
        </div>
        <button className="act act--icon" onClick={onClose} title="Clear selection" aria-label="Clear selection">
          <IconClose />
        </button>
      </div>
      <dl className="flow-inspect__rows">
        {rows.map((row) => (
          <div key={row.label} className="flow-inspect__row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {actions.length > 0 && (
        <div className="flow-inspect__actions">
          {actions.map((action) => (
            <button key={action.label} className={`act ${action.primary ? "act--focus" : ""}`} onClick={action.run}>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
