import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAgents, reportUiError } from "../api";
import type { WorkspaceRecord } from "../delegation";
import { codexRecord, NOW, sessionRecord, taskRecord } from "../test-support/u4-fixtures";
import type { AgentRecord, SessionRecord } from "../types";
import { FlowErrorBoundary, FlowView } from "./FlowView";

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), fetchAgents: vi.fn(), reportUiError: vi.fn() }));

const agentsMock = vi.mocked(fetchAgents);
const reportMock = vi.mocked(reportUiError);

const workspaces: WorkspaceRecord[] = [{ name: "api-ws", file: "C:/ws/api.json", contextPath: null, repos: [{ name: "api", path: "C:/work/api" }], error: null }];

const agent = (id: string, status: "running" | "ended", sessionId = "s1"): AgentRecord => ({
  agentId: id,
  sessionId,
  agentType: "explorer",
  status,
  transcriptPath: null,
  lastMessage: null,
  startedAt: NOW - 1000,
  updatedAt: NOW - 500,
});

const live = (id: string, title: string, overrides: Partial<SessionRecord> = {}): SessionRecord => sessionRecord({ sessionId: id, title, ...overrides });

const byId = (...records: SessionRecord[]): Record<string, SessionRecord> => Object.fromEntries(records.map((record) => [record.sessionId, record]));

type Props = Parameters<typeof FlowView>[0];

const baseProps = (): Props => ({
  sessions: {},
  codexSessions: [],
  tasks: [],
  workspaces,
  groups: [],
  onOpenSession: vi.fn(),
  onOpenTask: vi.fn(),
  onOpenCodex: vi.fn(),
  onFocus: vi.fn(),
  onOpenWorkspace: vi.fn(),
  query: "",
  onQuery: vi.fn(),
  scope: { sessions: true, codex: true, tasks: true },
  delegatedEnabled: true,
});

const setup = async (overrides: Partial<Props> = {}) => {
  const props = { ...baseProps(), ...overrides };
  const view = render(<FlowView {...props} />);
  await act(async () => {
    await Promise.resolve();
  });
  return { props, ...view };
};

const nodeEl = (title: string): Element => {
  const label = screen.getAllByText(title, { selector: "text.flow__title" })[0];
  if (!label) throw new Error(`no node titled ${title}`);
  return label.closest("g.flow__node") as Element;
};

const nodeTitles = (): string[] => Array.from(document.querySelectorAll("text.flow__title")).map((node) => node.textContent ?? "");

const scaleOf = (): number => {
  const transform = document.querySelector("svg.flow > g")?.getAttribute("transform") ?? "";
  return Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? "NaN");
};

const translateOf = (): [number, number] => {
  const transform = document.querySelector("svg.flow > g")?.getAttribute("transform") ?? "";
  const match = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(transform);
  return [Number(match?.[1]), Number(match?.[2])];
};

const openFilters = () => fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  agentsMock.mockReset();
  agentsMock.mockResolvedValue([]);
  reportMock.mockReset();
  reportMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FlowView empty and summary", () => {
  it("says nothing matches when there are no runs and draws no canvas", async () => {
    await setup();
    expect(screen.getByText("Nothing matches this filter. Start a session or clear the filters.")).toBeTruthy();
    expect(document.querySelector("svg.flow")).toBeNull();
    expect(screen.getByText("0 live · 0 subagents · 0 tasks · 0 need you")).toBeTruthy();
  });

  it("draws the hub, workspace and session nodes with a summary line", async () => {
    await setup({ sessions: byId(live("s1", "Alpha", { agentsRunning: 2, agentsTotal: 2 }), live("s2", "Beta", { status: "waiting" })) });
    expect(nodeTitles()).toEqual(expect.arrayContaining(["Alpha", "Beta", "api-ws"]));
    expect(screen.getByText("2 live · 2 subagents · 0 tasks · 1 need you")).toBeTruthy();
    expect(document.querySelectorAll("path.flow__edge").length).toBeGreaterThan(0);
  });

  it("leaves tasks out of the summary when delegation is off", async () => {
    await setup({ sessions: byId(live("s1", "Alpha")), delegatedEnabled: false, scope: { sessions: true, codex: true, tasks: false } });
    expect(screen.getByText("1 live · 0 subagents · 0 need you")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "With tasks" })).toBeNull();
  });
});

describe("FlowView selection and inspector", () => {
  it("selects a node, shows the inspector, highlights relatives and clears on Escape", async () => {
    const { props } = await setup({ sessions: byId(live("s1", "Alpha", { hostPid: 5 })) });
    fireEvent.click(nodeEl("Alpha"));
    const inspector = screen.getByRole("complementary", { name: "Node details" });
    expect(within(inspector).getByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect(nodeEl("Alpha").getAttribute("class")).toContain("flow__node--sel");
    expect(document.querySelector(".flow__canvas--panel")).toBeTruthy();
    fireEvent.click(within(inspector).getByRole("button", { name: "Open details" }));
    expect(props.onOpenSession).toHaveBeenCalledWith("s1");
    fireEvent.click(within(inspector).getByRole("button", { name: "Focus" }));
    expect(props.onFocus).toHaveBeenCalledWith("s1");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Node details" })).toBeNull();
    fireEvent.keyDown(window, { key: "a" });
  });

  it("clears the selection from the inspector and from a click on the canvas", async () => {
    await setup({ sessions: byId(live("s1", "Alpha")) });
    fireEvent.click(nodeEl("Alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByRole("complementary", { name: "Node details" })).toBeNull();
    fireEvent.click(nodeEl("Alpha"));
    fireEvent.click(document.querySelector("svg.flow") as SVGElement);
    expect(screen.queryByRole("complementary", { name: "Node details" })).toBeNull();
  });

  it("opens things with a double click on the node", async () => {
    const { props } = await setup({
      sessions: byId(live("s1", "Alpha")),
      codexSessions: [codexRecord({ title: "Thread" })],
      tasks: [taskRecord({ id: "t1", title: "Job", sessionId: "s1" })],
    });
    fireEvent.doubleClick(nodeEl("Alpha"));
    expect(props.onOpenSession).toHaveBeenCalledWith("s1");
    fireEvent.doubleClick(nodeEl("Thread"));
    expect(props.onOpenCodex).toHaveBeenCalledWith("codex-0001-aaaa");
    fireEvent.doubleClick(nodeEl("Job"));
    expect(props.onOpenTask).toHaveBeenCalledWith("t1");
    fireEvent.doubleClick(nodeEl("api-ws"));
    expect(props.onOpenWorkspace).toHaveBeenCalledWith("api-ws");
  });

  it("shows the hover path and clears it when the mouse leaves", async () => {
    await setup({ sessions: byId(live("s1", "Alpha")) });
    const canvas = document.querySelector("svg.flow") as SVGElement;
    fireEvent.mouseEnter(nodeEl("Alpha"));
    expect(document.querySelector(".flow__path")?.textContent).toBe("CC Hub › api-ws › Alpha");
    fireEvent.mouseLeave(canvas);
    expect(document.querySelector(".flow__path")).toBeNull();
  });

  it("shows the client badge on session, codex and task nodes", async () => {
    await setup({
      sessions: byId(live("s1", "Alpha", { client: "vscode" })),
      codexSessions: [codexRecord({ title: "Thread" })],
      tasks: [taskRecord({ id: "t1", title: "Job", sessionId: "s1", runner: "codex" })],
    });
    const clients = Array.from(document.querySelectorAll("text.flow__client")).map((node) => node.textContent);
    expect(clients).toEqual(expect.arrayContaining(["VS Code", "Codex app", "codex"]));
  });

  it("names the delegating session in the task inspector", async () => {
    const { props } = await setup({
      sessions: byId(live("s1", "Alpha"), live("s2", "Parent")),
      tasks: [taskRecord({ id: "t1", title: "Job", sessionId: "s1", originSessionId: "s2" })],
    });
    fireEvent.click(nodeEl("Job"));
    const inspector = screen.getByRole("complementary", { name: "Node details" });
    expect(within(inspector).getByText("Parent")).toBeTruthy();
    fireEvent.click(within(inspector).getByRole("button", { name: "Open delegating session" }));
    expect(props.onOpenSession).toHaveBeenCalledWith("s2");
  });

  it("labels the origin of tasks by client when no session is known", async () => {
    await setup({
      tasks: [
        taskRecord({ id: "t1", title: "FromCodex", originClient: "codex" }),
        taskRecord({ id: "t2", title: "FromShare", originClient: "share" }),
        taskRecord({ id: "t3", title: "FromClaude", originClient: "claude-code" }),
        taskRecord({ id: "t4", title: "FromNone" }),
        taskRecord({ id: "t5", title: "Unknown", originSessionId: "zzzz9999-xx" }),
      ],
    });
    fireEvent.click(nodeEl("delegated").querySelector(".flow__expander") as Element);
    const origin = (title: string): string => {
      fireEvent.click(nodeEl(title));
      return screen.getByRole("complementary", { name: "Node details" }).textContent ?? "";
    };
    expect(origin("FromCodex")).toContain("Delegated byCodex");
    expect(origin("FromShare")).toContain("Delegated byshare");
    expect(origin("FromClaude")).toContain("Delegated byClaude Code");
    expect(origin("FromNone")).not.toContain("Delegated by");
    expect(origin("Unknown")).toContain("zzzz9999");
  });
});

describe("FlowView expanders", () => {
  it("expands the subagents of a session and lists them from the agents api", async () => {
    agentsMock.mockResolvedValue([agent("a1", "running"), agent("a2", "ended")]);
    await setup({ sessions: byId(live("s1", "Alpha", { agentsRunning: 1, agentsTotal: 2 })) });
    expect(agentsMock).toHaveBeenCalledWith("s1");
    const subagents = "1 running";
    expect(subagents).not.toBe("");
    const group = nodeEl(subagents);
    expect(nodeTitles()).not.toContain("explorer");
    fireEvent.click(group.querySelector(".flow__expander") as Element);
    await waitFor(() => expect(nodeTitles()).toContain("explorer"));
    fireEvent.click(group.querySelector(".flow__expander") as Element);
    expect(nodeTitles()).not.toContain("explorer");
  });

  it("toggles the subagents and the ended list from the inspector", async () => {
    agentsMock.mockResolvedValue([agent("a1", "running"), agent("a2", "ended")]);
    await setup({ sessions: byId(live("s1", "Alpha", { agentsRunning: 1, agentsTotal: 2 })) });
    fireEvent.click(nodeEl("1 running"));
    fireEvent.click(within(screen.getByRole("complementary", { name: "Node details" })).getByRole("button", { name: "Expand" }));
    await waitFor(() => expect(nodeTitles()).toContain("+1 ended"));
    expect(nodeTitles().filter((title) => title === "explorer")).toHaveLength(1);
    fireEvent.click(nodeEl("+1 ended"));
    fireEvent.click(within(screen.getByRole("complementary", { name: "Node details" })).getByRole("button", { name: "List ended subagents" }));
    expect(nodeTitles().filter((title) => title === "explorer")).toHaveLength(2);
    expect(nodeTitles()).not.toContain("+1 ended");
    fireEvent.click(nodeEl("1 running"));
    const inspector = within(screen.getByRole("complementary", { name: "Node details" }));
    fireEvent.click(inspector.getByRole("button", { name: "Hide ended subagents" }));
    expect(nodeTitles().filter((title) => title === "explorer")).toHaveLength(1);
    fireEvent.click(inspector.getByRole("button", { name: "Collapse" }));
    expect(nodeTitles()).not.toContain("explorer");
  });

  it("expands a group and opens the session from an agent by double click", async () => {
    agentsMock.mockResolvedValue([agent("a1", "running")]);
    const { props } = await setup({ sessions: byId(live("s1", "Alpha", { agentsRunning: 1, agentsTotal: 1 })) });
    fireEvent.doubleClick(nodeEl("1 running"));
    await waitFor(() => expect(nodeTitles()).toContain("explorer"));
    fireEvent.doubleClick(nodeEl("explorer"));
    expect(props.onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("survives a failing agents request and refreshes it every five seconds", async () => {
    agentsMock.mockRejectedValue(new Error("x"));
    await setup({ sessions: byId(live("s1", "Alpha", { agentsRunning: 1, agentsTotal: 1 })) });
    expect(nodeTitles()).toContain("Alpha");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(agentsMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("groups tasks with no live session and expands the group", async () => {
    const { props } = await setup({ tasks: [taskRecord({ id: "t1", title: "Orphan job", status: "failed" }), taskRecord({ id: "t2", title: "Pending job", status: "attention" })] });
    expect(nodeTitles()).not.toContain("Orphan job");
    const group = nodeEl("delegated");
    fireEvent.click(group.querySelector(".flow__expander") as Element);
    expect(nodeTitles()).toEqual(expect.arrayContaining(["Orphan job", "Pending job"]));
    fireEvent.click(nodeEl("Orphan job"));
    fireEvent.click(within(screen.getByRole("complementary", { name: "Node details" })).getByRole("button", { name: "Open in Delegated" }));
    expect(props.onOpenTask).toHaveBeenCalledWith("t1");
    fireEvent.click(nodeEl("delegated"));
    fireEvent.click(within(screen.getByRole("complementary", { name: "Node details" })).getByRole("button", { name: "Collapse" }));
    expect(nodeTitles()).not.toContain("Orphan job");
  });

  it("collapses a workspace lane from its inspector", async () => {
    await setup({ sessions: byId(live("s1", "Alpha")) });
    fireEvent.click(nodeEl("api-ws"));
    fireEvent.click(within(screen.getByRole("complementary", { name: "Node details" })).getByRole("button", { name: "Collapse lane" }));
    expect(nodeTitles()).not.toContain("Alpha");
    fireEvent.click(nodeEl("api-ws"));
    fireEvent.click(within(screen.getByRole("complementary", { name: "Node details" })).getByRole("button", { name: "Expand lane" }));
    expect(nodeTitles()).toContain("Alpha");
  });
});

describe("FlowView filters", () => {
  const mixed = (): Record<string, SessionRecord> =>
    byId(
      live("s1", "Active one"),
      live("s2", "Waiting one", { status: "waiting" }),
      live("s3", "Ended one", { status: "ended" }),
      live("s4", "Agentic", { agentsTotal: 1, agentsRunning: 1 }),
      live("s5", "Archived one", { archivedAt: 5 }),
      live("s6", "Helper one", { helperOf: "s1" }),
      live("s7", "Head one", { client: "headless" }),
      live("s8", "Stale one", { updatedAt: NOW - 5 * 3_600_000 }),
    );

  it("filters by the pills", async () => {
    await setup({ sessions: mixed(), tasks: [taskRecord({ id: "t1", title: "Job", sessionId: "s1" })] });
    expect(nodeTitles()).toEqual(expect.arrayContaining(["Active one", "Waiting one", "Agentic"]));
    expect(nodeTitles()).not.toContain("Ended one");
    expect(nodeTitles()).not.toContain("Archived one");
    expect(nodeTitles()).not.toContain("Helper one");
    expect(nodeTitles()).not.toContain("Head one");
    fireEvent.click(screen.getByRole("button", { name: "Needs you" }));
    expect(nodeTitles()).toContain("Waiting one");
    expect(nodeTitles()).not.toContain("Active one");
    fireEvent.click(screen.getByRole("button", { name: "With subagents" }));
    expect(nodeTitles()).toContain("Agentic");
    expect(nodeTitles()).not.toContain("Waiting one");
    fireEvent.click(screen.getByRole("button", { name: "With tasks" }));
    expect(nodeTitles()).toContain("Active one");
    expect(nodeTitles()).not.toContain("Agentic");
    expect(screen.getByRole("button", { name: "With tasks" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(nodeTitles()).toContain("Agentic");
  });

  it("hides Codex threads under the needs you, subagents and tasks pills", async () => {
    await setup({ sessions: byId(live("s1", "Alpha", { status: "waiting", agentsTotal: 1, agentsRunning: 1 })), codexSessions: [codexRecord({ title: "Thread" })] });
    expect(nodeTitles()).toContain("Thread");
    fireEvent.click(screen.getByRole("button", { name: "Needs you" }));
    expect(nodeTitles()).not.toContain("Thread");
  });

  it("falls back to Live when the tasks pill is picked and tasks leave the scope", async () => {
    const props = baseProps();
    const view = render(<FlowView {...props} sessions={byId(live("s1", "Alpha"))} tasks={[taskRecord({ sessionId: "s1" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "With tasks" }));
    view.rerender(<FlowView {...props} sessions={byId(live("s1", "Alpha"))} scope={{ sessions: true, codex: true, tasks: false }} />);
    expect(screen.getByRole("button", { name: "Live" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("searches by title or folder through the shared query", async () => {
    const { props } = await setup({ sessions: byId(live("s1", "Alpha"), live("s2", "Beta", { cwd: "C:/work/other" })), codexSessions: [codexRecord({ title: "Thread" })], query: "alp" });
    expect(nodeTitles()).toContain("Alpha");
    expect(nodeTitles()).not.toContain("Beta");
    expect(nodeTitles()).not.toContain("Thread");
    fireEvent.change(screen.getByPlaceholderText("search title or folder"), { target: { value: "x" } });
    expect(props.onQuery).toHaveBeenCalledWith("x");
  });

  it("searches by folder", async () => {
    await setup({ sessions: byId(live("s1", "Alpha"), live("s2", "Beta", { cwd: "C:/work/other" })), query: "other" });
    expect(nodeTitles()).toContain("Beta");
    expect(nodeTitles()).not.toContain("Alpha");
  });

  it("shows ended items with their toggle, counted for the period", async () => {
    await setup({ sessions: mixed(), codexSessions: [codexRecord({ id: "c9", title: "Old thread", status: "ended", updatedAt: NOW - 1000 })] });
    openFilters();
    expect(screen.getByText(/Show ended \(3\)/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Show ended/));
    expect(nodeTitles()).toEqual(expect.arrayContaining(["Ended one", "Stale one", "Old thread"]));
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeTruthy();
  });

  it("shows completed tasks with their toggle", async () => {
    await setup({ tasks: [taskRecord({ id: "t1", title: "Finished", status: "completed", sessionId: null }), taskRecord({ id: "t2", title: "Cancelled", status: "cancelled", updatedAt: NOW - 20 * 86_400_000 })] });
    openFilters();
    expect(screen.getByText(/Show completed tasks \(1\)/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Show completed tasks/));
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue("Last 7 days"), { target: { value: "30d" } });
    expect(screen.getByText(/Show completed tasks \(2\)/)).toBeTruthy();
  });

  it("persists the period and the orientation and restores them", async () => {
    const first = await setup({ sessions: byId(live("s1", "Alpha")) });
    openFilters();
    fireEvent.change(screen.getByDisplayValue("Last 7 days"), { target: { value: "today" } });
    fireEvent.click(screen.getByRole("button", { name: "Vertical" }));
    expect(localStorage.getItem("hub.flow.period")).toBe("today");
    expect(localStorage.getItem("hub.flow.orientation")).toBe("vertical");
    expect(document.querySelector(".flow--vertical")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Horizontal" }));
    expect(document.querySelector(".flow--horizontal")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Vertical" }));
    first.unmount();
    await setup({ sessions: byId(live("s1", "Alpha")) });
    expect(document.querySelector(".flow--vertical")).toBeTruthy();
    openFilters();
    expect(screen.getByDisplayValue("Today (24 h)")).toBeTruthy();
  });

  it("ignores a bad stored period", async () => {
    localStorage.setItem("hub.flow.period", "forever");
    await setup({ sessions: byId(live("s1", "Alpha")) });
    openFilters();
    expect(screen.getByDisplayValue("Last 7 days")).toBeTruthy();
  });

  it("filters by client for sessions and hub runs and drops Codex from the list when needed", async () => {
    await setup({ sessions: byId(live("s1", "Term", { client: "terminal" }), live("s2", "Code", { client: "vscode" }), live("s3", "Share", { client: "share" }), live("s4", "Head", { client: "headless" })), codexSessions: [codexRecord({ title: "Thread" })] });
    openFilters();
    const select = screen.getByLabelText("Client");
    fireEvent.change(select, { target: { value: "vscode" } });
    expect(nodeTitles()).toContain("Code");
    expect(nodeTitles()).not.toContain("Term");
    expect(nodeTitles()).not.toContain("Thread");
    fireEvent.change(select, { target: { value: "hub" } });
    expect(nodeTitles()).toEqual(expect.arrayContaining(["Share", "Head"]));
    fireEvent.change(select, { target: { value: "share" } });
    expect(nodeTitles()).toContain("Share");
    expect(nodeTitles()).not.toContain("Head");
    fireEvent.change(select, { target: { value: "codex" } });
    expect(nodeTitles()).toContain("Thread");
    expect(nodeTitles()).not.toContain("Term");
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeTruthy();
  });

  it("hides the client select without a session scope and codex only when out of scope", async () => {
    const view = await setup({ sessions: byId(live("s1", "Alpha")), codexSessions: [codexRecord()], scope: { sessions: false, codex: true, tasks: false } });
    expect(nodeTitles()).not.toContain("Alpha");
    expect(nodeTitles()).toContain("Fix build");
    openFilters();
    expect(screen.queryByLabelText("Client")).toBeNull();
    view.unmount();
    await setup({ sessions: byId(live("s1", "Alpha")), codexSessions: [codexRecord()], scope: { sessions: true, codex: false, tasks: false } });
    openFilters();
    expect(within(screen.getByLabelText("Client")).queryByRole("option", { name: "Codex threads" })).toBeNull();
    expect(nodeTitles()).not.toContain("Fix build");
  });
});

describe("FlowView viewport", () => {
  it("zooms with the buttons and resets", async () => {
    await setup({ sessions: byId(live("s1", "Alpha")) });
    const start = scaleOf();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(scaleOf()).toBeCloseTo(start * 1.12, 2);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(scaleOf()).toBeLessThan(start);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(document.querySelector("svg.flow > g")?.getAttribute("transform")).toBe("translate(0 0) scale(1)");
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(scaleOf()).toBeCloseTo(0.3, 2);
  });

  it("zooms with the wheel in both directions and clamps", async () => {
    await setup({ sessions: byId(live("s1", "Alpha")) });
    const canvas = document.querySelector("svg.flow") as SVGElement;
    const start = scaleOf();
    fireEvent.wheel(canvas, { deltaY: -100, clientX: 10, clientY: 10 });
    expect(scaleOf()).toBeGreaterThan(start);
    fireEvent.wheel(canvas, { deltaY: 100, clientX: 10, clientY: 10 });
    fireEvent.wheel(canvas, { deltaY: 100, clientX: 10, clientY: 10 });
    expect(scaleOf()).toBeLessThan(start);
    for (let index = 0; index < 40; index += 1) fireEvent.wheel(canvas, { deltaY: -100 });
    expect(scaleOf()).toBeLessThanOrEqual(2.5);
  });

  it("pans by dragging and ignores the click that ends a drag", async () => {
    await setup({ sessions: byId(live("s1", "Alpha")) });
    const canvas = document.querySelector("svg.flow") as SVGElement;
    const [x0, y0] = translateOf();
    fireEvent.mouseDown(canvas, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(canvas, { clientX: 130, clientY: 120 });
    expect(translateOf()).toEqual([x0 + 30, y0 + 20]);
    fireEvent.click(nodeEl("Alpha"));
    expect(screen.queryByRole("complementary", { name: "Node details" })).toBeNull();
    fireEvent.mouseUp(canvas);
    fireEvent.mouseMove(canvas, { clientX: 500, clientY: 500 });
    expect(translateOf()).toEqual([x0 + 30, y0 + 20]);
    fireEvent.click(nodeEl("Alpha"));
    expect(screen.getByRole("complementary", { name: "Node details" })).toBeTruthy();
  });

  it("does not drag with another mouse button and treats a tiny move as a click", async () => {
    await setup({ sessions: byId(live("s1", "Alpha")) });
    const canvas = document.querySelector("svg.flow") as SVGElement;
    const [x0] = translateOf();
    fireEvent.mouseDown(canvas, { button: 2, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(canvas, { clientX: 90, clientY: 90 });
    expect(translateOf()[0]).toBe(x0);
    fireEvent.mouseDown(canvas, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(canvas, { clientX: 11, clientY: 11 });
    fireEvent.mouseUp(canvas);
    fireEvent.click(nodeEl("Alpha"));
    expect(screen.getByRole("complementary", { name: "Node details" })).toBeTruthy();
  });

  it("keeps the view where the user left it when the graph changes", async () => {
    const props = baseProps();
    const view = render(<FlowView {...props} sessions={byId(live("s1", "Alpha"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const zoomed = scaleOf();
    view.rerender(<FlowView {...props} sessions={byId(live("s1", "Alpha"), live("s2", "Beta"))} />);
    expect(scaleOf()).toBe(zoomed);
  });

  it("explains the map in the legend", async () => {
    await setup({ sessions: byId(live("s1", "Alpha")) });
    fireEvent.click(screen.getByRole("button", { name: "Map legend" }));
    expect(screen.getByText("delegated task")).toBeTruthy();
    expect(screen.getByText("delegated by")).toBeTruthy();
    expect(screen.getByText(/Click a node to inspect/)).toBeTruthy();
  });

  it("leaves the delegated items out of the legend when delegation is off", async () => {
    await setup({ sessions: byId(live("s1", "Alpha")), delegatedEnabled: false });
    fireEvent.click(screen.getByRole("button", { name: "Map legend" }));
    expect(screen.queryByText("delegated task")).toBeNull();
    expect(screen.queryByText("delegated by")).toBeNull();
  });
});

describe("FlowErrorBoundary", () => {
  const Bomb = ({ armed }: { armed: boolean }) => {
    if (armed) throw new Error("kaboom");
    return <p>map ok</p>;
  };

  it("reports the crash, shows the message and recovers on Reload map", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let armed = true;
    const Harness = () => <Bomb armed={armed} />;
    render(
      <FlowErrorBoundary>
        <Harness />
      </FlowErrorBoundary>,
    );
    expect(screen.getByText("The map hit an error.")).toBeTruthy();
    expect(screen.getByText(/kaboom/)).toBeTruthy();
    expect(reportMock).toHaveBeenCalledWith("flow", expect.objectContaining({ message: "kaboom" }), expect.any(String));
    armed = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload map" }));
    expect(screen.getByText("map ok")).toBeTruthy();
    spy.mockRestore();
  });

  it("shows unknown error when the error has no message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Empty = () => {
      throw new Error("");
    };
    render(
      <FlowErrorBoundary>
        <Empty />
      </FlowErrorBoundary>,
    );
    expect(screen.getByText(/unknown error/)).toBeTruthy();
    spy.mockRestore();
  });
});
