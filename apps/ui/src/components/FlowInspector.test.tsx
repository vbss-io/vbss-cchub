import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FlowNode } from "../flow-layout";
import { codexRecord, sessionRecord, taskRecord } from "../test-support/u4-fixtures";
import { FlowInspector } from "./FlowInspector";

const node = (overrides: Partial<FlowNode> = {}): FlowNode => ({
  id: "n1",
  kind: "session",
  title: "Node title",
  subtitle: "active",
  tone: "go",
  x: 0,
  y: 0,
  w: 100,
  h: 50,
  depth: 1,
  parent: null,
  lane: "lane-1",
  running: false,
  dim: false,
  badge: null,
  ...overrides,
});

const handlers = () => ({
  onClose: vi.fn(),
  onOpenSession: vi.fn(),
  onOpenCodex: vi.fn(),
  onOpenTask: vi.fn(),
  onFocus: vi.fn(),
  onOpenWorkspace: vi.fn(),
  onToggleLane: vi.fn(),
  onToggleSubagents: vi.fn(),
  onToggleEnded: vi.fn(),
  onToggleTaskGroup: vi.fn(),
});

interface Setup {
  node: FlowNode;
  session?: ReturnType<typeof sessionRecord> | null;
  codex?: ReturnType<typeof codexRecord> | null;
  task?: ReturnType<typeof taskRecord> | null;
  origin?: { label: string; sessionId: string | null } | null;
  laneCollapsed?: boolean;
  expanded?: boolean;
  endedListed?: boolean;
}

const setup = ({ node: target, session = null, codex = null, task = null, origin = null, laneCollapsed = false, expanded = false, endedListed = false }: Setup) => {
  const fns = handlers();
  render(<FlowInspector node={target} session={session} codex={codex} task={task} origin={origin} laneCollapsed={laneCollapsed} expanded={expanded} endedListed={endedListed} {...fns} />);
  return fns;
};

const row = (label: string): string => {
  const term = screen.getByText(label, { selector: "dt" });
  return term.parentElement?.querySelector("dd")?.textContent ?? "";
};

describe("FlowInspector header", () => {
  it("shows the kind label and title and clears the selection", () => {
    const fns = setup({ node: node({ kind: "hub", title: "Hub", subtitle: "3 live" }) });
    expect(screen.getByText("Hub", { selector: ".flow-inspect__kind" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Hub" })).toBeTruthy();
    expect(row("Summary")).toBe("3 live");
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(fns.onClose).toHaveBeenCalledTimes(1);
  });

  it("renders no actions for a node without a matching record", () => {
    setup({ node: node({ kind: "session" }) });
    expect(screen.getByText("Claude session")).toBeTruthy();
    expect(document.querySelector(".flow-inspect__actions")).toBeNull();
  });
});

describe("FlowInspector Claude session", () => {
  it("lists status, client, folder, subagents, fork and delegated tasks and opens details", () => {
    const fns = setup({
      node: node({ badge: "2" }),
      session: sessionRecord({ forkOf: "forkparent99", delegatedTasks: 3, hostPid: 77 }),
    });
    expect(row("Status")).toBe("active");
    expect(row("Client")).toBe("Claude Code · terminal");
    expect(row("Folder")).toBe("C:/work/api");
    expect(row("Subagents")).toBe("2 running");
    expect(row("Fork of")).toBe("forkpare");
    expect(row("Delegated")).toBe("3 tasks");
    fireEvent.click(screen.getByRole("button", { name: "Open details" }));
    expect(fns.onOpenSession).toHaveBeenCalledWith("sess-0001-aaaa");
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    expect(fns.onFocus).toHaveBeenCalledWith("sess-0001-aaaa");
  });

  it("uses the singular for one delegated task and hides Focus without a window or when ended", () => {
    setup({ node: node(), session: sessionRecord({ delegatedTasks: 1, hostPid: null }) });
    expect(row("Delegated")).toBe("1 task");
    expect(screen.queryByRole("button", { name: "Focus" })).toBeNull();
  });

  it("hides Focus for an ended session and skips empty rows", () => {
    setup({ node: node(), session: sessionRecord({ cwd: null, status: "ended", hostPid: 5 }) });
    expect(screen.queryByRole("button", { name: "Focus" })).toBeNull();
    expect(screen.queryByText("Folder", { selector: "dt" })).toBeNull();
    expect(screen.queryByText("Subagents", { selector: "dt" })).toBeNull();
    expect(screen.queryByText("Fork of", { selector: "dt" })).toBeNull();
    expect(screen.queryByText("Delegated", { selector: "dt" })).toBeNull();
  });
});

describe("FlowInspector Codex thread", () => {
  it("lists the thread facts and opens details", () => {
    const fns = setup({ node: node({ kind: "codex", title: "Fix build" }), codex: codexRecord() });
    expect(screen.getByText("Codex thread")).toBeTruthy();
    expect(row("Client")).toBe("Codex app");
    expect(row("Turns")).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "Open details" }));
    expect(fns.onOpenCodex).toHaveBeenCalledWith("codex-0001-aaaa");
  });

  it("skips the folder row without a cwd", () => {
    setup({ node: node({ kind: "codex" }), codex: codexRecord({ cwd: null }) });
    expect(screen.queryByText("Folder", { selector: "dt" })).toBeNull();
  });
});

describe("FlowInspector delegated task", () => {
  it("shows the task facts with the delegating session and opens both", () => {
    const fns = setup({
      node: node({ kind: "task" }),
      task: taskRecord({ lastError: "exit 1" }),
      origin: { label: "Parent", sessionId: "parent-1" },
    });
    expect(row("Runner")).toBe("claude");
    expect(row("Workspace")).toBe("api");
    expect(row("Delegated by")).toBe("Parent");
    expect(row("Last error")).toBe("exit 1");
    fireEvent.click(screen.getByRole("button", { name: "Open in Delegated" }));
    expect(fns.onOpenTask).toHaveBeenCalledWith("task-1");
    fireEvent.click(screen.getByRole("button", { name: "Open delegating session" }));
    expect(fns.onOpenSession).toHaveBeenCalledWith("parent-1");
  });

  it("omits the origin and error rows and the delegating session without one", () => {
    setup({ node: node({ kind: "task" }), task: taskRecord(), origin: { label: "share", sessionId: null } });
    expect(row("Delegated by")).toBe("share");
    expect(screen.queryByRole("button", { name: "Open delegating session" })).toBeNull();
    expect(screen.queryByText("Last error", { selector: "dt" })).toBeNull();
  });

  it("omits the delegated by row without an origin", () => {
    setup({ node: node({ kind: "task" }), task: taskRecord() });
    expect(screen.queryByText("Delegated by", { selector: "dt" })).toBeNull();
  });
});

describe("FlowInspector workspace", () => {
  it("opens the workspace and toggles the lane", () => {
    const fns = setup({ node: node({ kind: "workspace", subtitle: "4 runs", workspaceName: "api-ws", lane: "api-ws" }) });
    expect(row("Lane")).toBe("4 runs");
    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    expect(fns.onOpenWorkspace).toHaveBeenCalledWith("api-ws");
    fireEvent.click(screen.getByRole("button", { name: "Collapse lane" }));
    expect(fns.onToggleLane).toHaveBeenCalledWith("api-ws");
  });

  it("offers Expand lane when collapsed and no open action for the outside lane", () => {
    setup({ node: node({ kind: "workspace", subtitle: "x" }), laneCollapsed: true });
    expect(screen.queryByRole("button", { name: "Open workspace" })).toBeNull();
    expect(screen.getByRole("button", { name: "Expand lane" })).toBeTruthy();
  });
});

describe("FlowInspector subagents and agents", () => {
  it("toggles the subagent group and the ended list and opens the session", () => {
    const fns = setup({ node: node({ kind: "subagents", title: "3 subagents", subtitle: "1 running", sessionId: "s1" }), expanded: true, endedListed: true });
    expect(row("Subagents")).toBe("3 subagents");
    expect(row("Running")).toBe("1 running");
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(fns.onToggleSubagents).toHaveBeenCalledWith("s1");
    fireEvent.click(screen.getByRole("button", { name: "Hide ended subagents" }));
    expect(fns.onToggleEnded).toHaveBeenCalledWith("s1");
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(fns.onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("offers Expand and no Hide button while collapsed", () => {
    setup({ node: node({ kind: "subagents", sessionId: "s1" }), expanded: false, endedListed: true });
    expect(screen.getByRole("button", { name: "Expand" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hide ended subagents" })).toBeNull();
  });

  it("shows a subagent and opens its session", () => {
    const fns = setup({ node: node({ kind: "agent", title: "explorer", subtitle: "running", sessionId: "s1" }) });
    expect(row("Type")).toBe("explorer");
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    expect(fns.onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("has no open action for an agent without a session", () => {
    setup({ node: node({ kind: "agent", title: "explorer" }) });
    expect(screen.queryByRole("button", { name: "Open session" })).toBeNull();
  });
});

describe("FlowInspector task group and more", () => {
  it("toggles a task group", () => {
    const fns = setup({ node: node({ kind: "taskgroup", subtitle: "2 tasks", lane: "tg-lane" }), expanded: true });
    expect(row("Tasks")).toBe("2 tasks");
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(fns.onToggleTaskGroup).toHaveBeenCalledWith("tg-lane");
  });

  it("lists ended subagents from an ended more node", () => {
    const fns = setup({ node: node({ kind: "more", moreKind: "ended", sessionId: "s1" }) });
    fireEvent.click(screen.getByRole("button", { name: "List ended subagents" }));
    expect(fns.onToggleEnded).toHaveBeenCalledWith("s1");
    expect(screen.getByRole("button", { name: "Open session" }).className).not.toContain("act--focus");
  });

  it("hides the ended list from an overflow more node and makes Open session primary", () => {
    const fns = setup({ node: node({ kind: "more", moreKind: "overflow", sessionId: "s1" }), endedListed: true });
    fireEvent.click(screen.getByRole("button", { name: "Hide ended subagents" }));
    expect(fns.onToggleEnded).toHaveBeenCalledWith("s1");
    expect(screen.getByRole("button", { name: "Open session" }).className).toContain("act--focus");
  });

  it("offers only Open session from an overflow node whose ended list is hidden", () => {
    setup({ node: node({ kind: "more", moreKind: "overflow", sessionId: "s1" }), endedListed: false });
    expect(screen.queryByRole("button", { name: "Hide ended subagents" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open session" })).toBeTruthy();
  });
});
