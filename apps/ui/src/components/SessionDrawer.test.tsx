import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSessionAsks, fetchSessionLiveSummary, fetchSubagentLive, focusSession, markSessionSeen, type ClaimRecord } from "../api";
import { listTasksByOrigin } from "../delegation";
import { agentRecord, liveAgentSummary, liveSummary, NOW, sessionRecord, shareRequest, taskRecord, transcriptEntry } from "../test-support/u4-fixtures";
import type { PermissionRequestRecord, SessionRecord, TranscriptEntry } from "../types";
import { SessionDrawer, Timeline } from "./SessionDrawer";

const hoisted = vi.hoisted(() => ({ approvals: [] as unknown[] }));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  fetchSessionLiveSummary: vi.fn(),
  fetchSubagentLive: vi.fn(),
  fetchSessionAsks: vi.fn(),
  focusSession: vi.fn(),
  markSessionSeen: vi.fn(),
}));

vi.mock("../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../delegation")>()), listTasksByOrigin: vi.fn() }));

vi.mock("../approvals-context", () => ({ useApprovals: () => ({ forSession: () => hoisted.approvals }) }));

vi.mock("./ApprovalRequest", () => ({ ApprovalList: ({ requests }: { requests: PermissionRequestRecord[] }) => <div data-testid="approvals">{requests.length}</div> }));

vi.mock("./ReviewPanel", () => ({
  ReviewPanel: ({ subject, refreshKey, onError }: { subject: { kind: string; id: string }; refreshKey: string; onError: (text: string) => void }) => (
    <div data-testid="review-panel">
      {`${subject.kind}:${subject.id}:${refreshKey}`}
      <button onClick={() => onError("review broke")}>raise</button>
    </div>
  ),
}));

const liveMock = vi.mocked(fetchSessionLiveSummary);
const subagentMock = vi.mocked(fetchSubagentLive);
const asksMock = vi.mocked(fetchSessionAsks);
const focusMock = vi.mocked(focusSession);
const seenMock = vi.mocked(markSessionSeen);
const tasksMock = vi.mocked(listTasksByOrigin);

const flush = async (ms = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
  hoisted.approvals = [];
  for (const mock of [liveMock, subagentMock, asksMock, focusMock, seenMock, tasksMock]) mock.mockReset();
  liveMock.mockImplementation((id) => Promise.resolve(liveSummary(sessionRecord({ sessionId: id }), [transcriptEntry({ role: "user", text: "hello" }), transcriptEntry()])));
  focusMock.mockResolvedValue({ ok: true });
  seenMock.mockResolvedValue(undefined);
  tasksMock.mockResolvedValue([]);
  asksMock.mockResolvedValue({ forks: [], asks: [] });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true, writable: true });
});

interface Overrides {
  session?: SessionRecord;
  props?: Partial<Parameters<typeof SessionDrawer>[0]>;
}

const setup = async ({ session = sessionRecord(), props = {} }: Overrides = {}) => {
  const onClose = vi.fn();
  const view = render(<SessionDrawer session={session} workspace="api-ws" delegatedEnabled={false} onClose={onClose} {...props} />);
  await flush();
  return { onClose, ...view };
};

const tab = (name: string | RegExp) => screen.getByRole("tab", { name });

describe("Timeline", () => {
  const entries: TranscriptEntry[] = [
    transcriptEntry({ role: "user", text: "question" }),
    transcriptEntry({ role: "tool", text: "ran ls", tool: "Bash" }),
    transcriptEntry({ role: "result", text: "files" }),
    transcriptEntry({ role: "assistant", text: "" }),
  ];

  it("shows the empty text when there are no entries", () => {
    render(<Timeline entries={[]} empty="Nothing yet" detail={false} onShowDetail={vi.fn()} />);
    expect(screen.getByText("Nothing yet")).toBeTruthy();
  });

  it("shows only the conversation and offers the hidden tool steps", () => {
    const onShowDetail = vi.fn();
    render(<Timeline entries={entries} empty="" detail={false} onShowDetail={onShowDetail} />);
    expect(screen.getByText("question")).toBeTruthy();
    expect(screen.getByText("(empty)")).toBeTruthy();
    expect(screen.queryByText("ran ls")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "2 tool steps hidden · Detailed" }));
    expect(onShowDetail).toHaveBeenCalledTimes(1);
  });

  it("uses the singular for one hidden step", () => {
    render(<Timeline entries={entries.slice(0, 2)} empty="" detail={false} onShowDetail={vi.fn()} />);
    expect(screen.getByRole("button", { name: "1 tool step hidden · Detailed" })).toBeTruthy();
  });

  it("shows tool steps with their tool name and the assistant label in detail mode", () => {
    render(<Timeline entries={entries} empty="" detail onShowDetail={vi.fn()} assistantLabel="codex" />);
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("result")).toBeTruthy();
    expect(screen.getByText("you")).toBeTruthy();
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /tool step/ })).toBeNull();
  });

  it("numbers duplicate entries so the keys stay unique", () => {
    const same = transcriptEntry({ role: "user", text: "same", at: 5 });
    render(<Timeline entries={[same, same]} empty="" detail onShowDetail={vi.fn()} />);
    expect(screen.getAllByText("same")).toHaveLength(2);
  });

  it("windows long timelines from the end and pages earlier turns", () => {
    const many = Array.from({ length: 10 }, (_, index) => transcriptEntry({ role: "user", text: `turn ${index}`, at: index + 1 }));
    render(<Timeline entries={many} empty="" detail onShowDetail={vi.fn()} initial={3} />);
    expect(screen.getByText("turn 9")).toBeTruthy();
    expect(screen.queryByText("turn 0")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all (+7)" }));
    expect(screen.getByText("turn 0")).toBeTruthy();
  });
});

describe("SessionDrawer header and lifecycle", () => {
  it("shows the name, status, workspace and loads the live transcript", async () => {
    await setup();
    expect(screen.getByRole("dialog", { name: "Refactor auth" })).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText("api-ws")).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("Here is the plan")).toBeTruthy();
    expect(liveMock).toHaveBeenCalledWith("sess-0001-aaaa");
  });

  it("falls back to the folder, the short id and the finished or inactive tags", async () => {
    const view = await setup({ session: sessionRecord({ title: null, status: "idle", unread: true }), props: { workspace: null } });
    liveMock.mockResolvedValue(liveSummary(sessionRecord({ title: null, status: "idle", unread: true }), []));
    await flush(3000);
    expect(screen.getByRole("dialog", { name: "sess-000" })).toBeTruthy();
    expect(screen.getByText("finished")).toBeTruthy();
    expect(screen.getByText("work/api")).toBeTruthy();
    view.unmount();
    liveMock.mockResolvedValue(liveSummary(sessionRecord({ stale: true }), []));
    await setup({ session: sessionRecord({ stale: true }) });
    expect(screen.getByText("inactive")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Focus/ })).toBeNull();
  });

  it("focuses the session and closes from the close button and Escape", async () => {
    const { onClose } = await setup();
    fireEvent.click(screen.getByRole("button", { name: /Focus/ }));
    expect(focusMock).toHaveBeenCalledWith("sess-0001-aaaa");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes on an outside click but not inside the panel or its menu", async () => {
    const { onClose } = await setup();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes full screen from the expand button, leaves on Escape and then closes on Escape", async () => {
    const { onClose } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Open in a large view" }));
    expect(screen.getByRole("dialog").className).toContain("drawer--full");
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog").className).not.toContain("drawer--full");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open in a large view" }));
    fireEvent.click(document.querySelector(".drawer__backdrop") as HTMLElement);
    expect(screen.getByRole("dialog").className).not.toContain("drawer--full");
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in a large view" }));
    expect(screen.getByRole("button", { name: "Back to the side panel" })).toBeTruthy();
  });

  it("drops the resize edge when the viewport is stacked", async () => {
    await setup();
    expect(screen.getByRole("separator", { name: "Resize session panel" })).toBeTruthy();
    act(() => {
      Object.defineProperty(window, "innerWidth", { value: 500, configurable: true, writable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.queryByRole("separator", { name: "Resize session panel" })).toBeNull();
  });

  it("renders the pending approvals above the tabs", async () => {
    hoisted.approvals = [{ id: "p1" }, { id: "p2" }];
    await setup();
    expect(screen.getByTestId("approvals").textContent).toBe("2");
  });
});

describe("SessionDrawer seen marker", () => {
  it("marks the session seen once on open and again when it turns unread", async () => {
    const { rerender } = await setup();
    expect(seenMock).toHaveBeenCalledTimes(1);
    expect(seenMock).toHaveBeenCalledWith("sess-0001-aaaa");
    rerender(<SessionDrawer session={sessionRecord({ updatedAt: NOW })} workspace="api-ws" delegatedEnabled={false} onClose={vi.fn()} />);
    await flush();
    expect(seenMock).toHaveBeenCalledTimes(1);
    rerender(<SessionDrawer session={sessionRecord({ unread: true })} workspace="api-ws" delegatedEnabled={false} onClose={vi.fn()} />);
    await flush();
    expect(seenMock).toHaveBeenCalledTimes(2);
    rerender(<SessionDrawer session={sessionRecord({ unread: false })} workspace="api-ws" delegatedEnabled={false} onClose={vi.fn()} />);
    await flush();
    expect(seenMock).toHaveBeenCalledTimes(2);
    rerender(<SessionDrawer session={sessionRecord({ sessionId: "sess-other", unread: false })} workspace="api-ws" delegatedEnabled={false} onClose={vi.fn()} />);
    await flush();
    expect(seenMock).toHaveBeenLastCalledWith("sess-other");
  });
});

describe("SessionDrawer activity", () => {
  it("shows Loading until the first response and a placeholder for an empty transcript", async () => {
    liveMock.mockReturnValue(new Promise(() => undefined));
    const view = await setup();
    expect(screen.getByText("Loading…")).toBeTruthy();
    view.unmount();
    liveMock.mockResolvedValue(liveSummary(sessionRecord(), []));
    await setup();
    expect(screen.getByText("No transcript yet for this session.")).toBeTruthy();
  });

  it("refreshes every 3 seconds while live and every 15 when ended", async () => {
    await setup();
    expect(liveMock).toHaveBeenCalledTimes(1);
    await flush(3000);
    expect(liveMock).toHaveBeenCalledTimes(2);
  });

  it("uses the slow refresh for an ended session", async () => {
    await setup({ session: sessionRecord({ status: "ended" }) });
    await flush(3000);
    expect(liveMock).toHaveBeenCalledTimes(1);
    await flush(12_000);
    expect(liveMock).toHaveBeenCalledTimes(2);
  });

  it("shows the error and retries up to five times one second apart", async () => {
    liveMock.mockRejectedValue(new Error("hub gone"));
    await setup({ session: sessionRecord({ status: "ended" }) });
    expect(screen.getByText("hub gone")).toBeTruthy();
    await flush(1000);
    expect(liveMock).toHaveBeenCalledTimes(2);
    await flush(4000);
    expect(liveMock).toHaveBeenCalledTimes(6);
    await flush(5000);
    expect(liveMock).toHaveBeenCalledTimes(6);
  });

  it("clears the error after a later success and names a non error failure", async () => {
    liveMock.mockRejectedValueOnce("weird");
    await setup();
    expect(screen.getByText("failed to load")).toBeTruthy();
    await flush(1000);
    expect(screen.queryByText("failed to load")).toBeNull();
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("toggles between Conversation and Detailed and remembers the choice", async () => {
    liveMock.mockResolvedValue(liveSummary(sessionRecord(), [transcriptEntry({ role: "user", text: "ask" }), transcriptEntry({ role: "tool", text: "ran it", tool: "Bash" })]));
    await setup();
    expect(screen.queryByText("ran it")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Detailed" }));
    expect(screen.getByText("ran it")).toBeTruthy();
    expect(localStorage.getItem("hub.timeline.detail")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(screen.queryByText("ran it")).toBeNull();
    expect(localStorage.getItem("hub.timeline.detail")).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "1 tool step hidden · Detailed" }));
    expect(screen.getByText("ran it")).toBeTruthy();
  });

  it("starts in detailed mode when it was remembered", async () => {
    localStorage.setItem("hub.timeline.detail", "1");
    liveMock.mockResolvedValue(liveSummary(sessionRecord(), [transcriptEntry({ role: "tool", text: "ran it", tool: "Bash" })]));
    await setup();
    expect(screen.getByText("ran it")).toBeTruthy();
  });

  it("works without local storage", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await setup();
    expect(screen.getByText("hello")).toBeTruthy();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe("SessionDrawer menu", () => {
  const menuNames = (): string[] => screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");

  it("lists open, share, large and archive when everything is allowed and runs them", async () => {
    const onShare = vi.fn();
    const onArchive = vi.fn();
    const onOpenSession = vi.fn();
    await setup({ props: { onShare, onArchive, onOpenSession } });
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    expect(menuNames()).toEqual(["Open session", "Share", "Open in a large view", "Archive"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open session" }));
    expect(onOpenSession).toHaveBeenCalledWith("sess-0001-aaaa");
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Share" }));
    expect(onShare).toHaveBeenCalledWith("sess-0001-aaaa");
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledWith("sess-0001-aaaa");
  });

  it("hides Share without a workspace, Archive when archived or unsupported and Open for ended sessions", async () => {
    liveMock.mockResolvedValue(liveSummary(sessionRecord({ status: "ended" }), []));
    await setup({ session: sessionRecord({ status: "ended" }), props: { workspace: null, onShare: vi.fn(), onArchive: vi.fn(), onOpenSession: vi.fn() } });
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    expect(menuNames()).toEqual(["Open in a large view", "Archive"]);
  });

  it("offers only the large view without handlers", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    expect(menuNames()).toEqual(["Open in a large view"]);
  });

  it("hides Archive for an archived session", async () => {
    liveMock.mockResolvedValue(liveSummary(sessionRecord({ archivedAt: 5 }), []));
    await setup({ session: sessionRecord({ archivedAt: 5 }), props: { onArchive: vi.fn() } });
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    expect(menuNames()).toEqual(["Open in a large view"]);
  });
});

describe("SessionDrawer subagents", () => {
  const withAgents = (agents = [liveAgentSummary({ agentId: "a1", lastMessage: "scanning files" }), liveAgentSummary({ agentId: "a2", agentType: "reviewer", status: "ended", turns: 0, lastMessage: null }), liveAgentSummary({ agentId: "a3", agentType: "reviewer", status: "ended", turns: 0, lastMessage: null }), liveAgentSummary({ agentId: "a4", agentType: null, status: "ended", turns: 0, lastMessage: null })]) =>
    liveMock.mockImplementation((id) => Promise.resolve(liveSummary(sessionRecord({ sessionId: id, agentsTotal: agents.length, agentsRunning: 1 }), [], agents)));

  it("shows the tab with the running over total count and lists live and silent agents", async () => {
    withAgents();
    await setup({ session: sessionRecord({ agentsTotal: 4, agentsRunning: 1 }) });
    expect(tab(/Subagents/).textContent).toContain("1/4");
    fireEvent.click(tab(/Subagents/));
    expect(screen.getByText("explorer")).toBeTruthy();
    expect(screen.getByText("scanning files")).toBeTruthy();
    expect(screen.getByText("2 steps")).toBeTruthy();
    expect(screen.getByText("2 runs · no transcript on disk")).toBeTruthy();
    expect(screen.getByText("1 run · no transcript on disk")).toBeTruthy();
  });

  it("expands an agent, loads its turns and keeps them fresh", async () => {
    withAgents([liveAgentSummary({ agentId: "a1" })]);
    subagentMock.mockResolvedValue({ agent: agentRecord({ agentId: "a1", lastMessage: "full message", transcript: [transcriptEntry({ role: "user", text: "sub question" })] }) });
    await setup({ session: sessionRecord({ agentsTotal: 1, agentsRunning: 1 }) });
    fireEvent.click(tab(/Subagents/));
    const toggle = screen.getByRole("button", { name: "Show turns of explorer a1" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByText("Loading turns…")).toBeTruthy();
    await flush();
    expect(subagentMock).toHaveBeenCalledWith("sess-0001-aaaa", "a1");
    expect(screen.getByText("sub question")).toBeTruthy();
    expect(screen.getByText("full message")).toBeTruthy();
    await flush(3000);
    expect(subagentMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole("button", { name: "Hide turns of explorer a1" }));
    expect(screen.queryByText("sub question")).toBeNull();
  });

  it("survives a failing subagent load", async () => {
    withAgents([liveAgentSummary({ agentId: "a1" })]);
    subagentMock.mockRejectedValue(new Error("nope"));
    await setup({ session: sessionRecord({ agentsTotal: 1, agentsRunning: 1 }) });
    fireEvent.click(tab(/Subagents/));
    fireEvent.click(screen.getByRole("button", { name: /Show turns/ }));
    await flush();
    expect(screen.getByText("Loading turns…")).toBeTruthy();
  });

  it("says so when there are no subagents yet and while they load", async () => {
    liveMock.mockReturnValue(new Promise(() => undefined));
    await setup({ session: sessionRecord({ agentsTotal: 2, agentsRunning: 0 }) });
    expect(tab(/Subagents/).textContent).toContain("2");
    fireEvent.click(tab(/Subagents/));
    expect(screen.getByText("Loading subagents…")).toBeTruthy();
  });

  it("falls back to Activity when the selected tab disappears", async () => {
    withAgents([liveAgentSummary({ agentId: "a1" })]);
    const view = await setup({ session: sessionRecord({ agentsTotal: 1, agentsRunning: 1 }) });
    fireEvent.click(tab(/Subagents/));
    liveMock.mockResolvedValue(liveSummary(sessionRecord(), [transcriptEntry()], []));
    view.rerender(<SessionDrawer session={sessionRecord({ agentsTotal: 0, agentsRunning: 0, updatedAt: NOW + 1 })} workspace="api-ws" delegatedEnabled={false} onClose={vi.fn()} />);
    await flush();
    expect(tab("Activity").getAttribute("aria-selected")).toBe("true");
  });
});

describe("SessionDrawer asks", () => {
  it("lists the forks and the asks with their answers", async () => {
    asksMock.mockResolvedValue({
      forks: [{ shareId: "s1", asker: "Ana", sessionId: "fork-1", parentSessionId: "sess-0001-aaaa", createdAt: NOW - 1000, lastUsedAt: NOW - 60_000, questions: 2 }],
      asks: [shareRequest({ id: "r1", prompt: "Why?", answer: "Because." }), shareRequest({ id: "r2", prompt: "Pending?", answer: null, asker: null, status: "running" })],
    });
    await setup({ session: sessionRecord({ remoteAsks: 2, forks: 1 }) });
    expect(tab(/Asks/).textContent).toContain("2");
    fireEvent.click(tab(/Asks/));
    expect(screen.getByText("Loading asks…")).toBeTruthy();
    await flush();
    expect(asksMock).toHaveBeenCalledWith("sess-0001-aaaa");
    expect(screen.getByText(/2 questions/)).toBeTruthy();
    expect(screen.getByText("Why?")).toBeTruthy();
    expect(screen.getByText("Because.")).toBeTruthy();
    expect(screen.getByText("someone")).toBeTruthy();
    await flush(5000);
    expect(asksMock).toHaveBeenCalledTimes(2);
  });

  it("uses the singular for one question and says when nobody asked", async () => {
    asksMock.mockResolvedValue({ forks: [{ shareId: "s1", asker: "Ana", sessionId: "fork-1", parentSessionId: null, createdAt: 1, lastUsedAt: NOW, questions: 1 }], asks: [] });
    await setup({ session: sessionRecord({ forks: 1 }) });
    fireEvent.click(tab("Asks"));
    await flush();
    expect(screen.getByText(/1 question(?!s)/)).toBeTruthy();
    expect(screen.getByText("Nobody asked this session yet.")).toBeTruthy();
  });

  it("keeps the loading hint when the asks request fails", async () => {
    asksMock.mockRejectedValue(new Error("x"));
    await setup({ session: sessionRecord({ remoteAsks: 1 }) });
    fireEvent.click(tab(/Asks/));
    await flush();
    expect(screen.getByText("Loading asks…")).toBeTruthy();
  });
});

describe("SessionDrawer delegated", () => {
  const delegatedSession = (): SessionRecord => sessionRecord({ delegatedTasks: 3 });

  it("is hidden when delegation is off", async () => {
    await setup({ session: delegatedSession() });
    expect(screen.queryByRole("tab", { name: /Delegated/ })).toBeNull();
  });

  it("lists delegated tasks, opens one and shows errors and archived tags", async () => {
    tasksMock.mockResolvedValue([
      taskRecord({ id: "t1", title: "Ship it", status: "running" }),
      taskRecord({ id: "t2", title: "Broke", status: "failed", lastError: "exit 1", archivedAt: 5 }),
    ]);
    const onOpenTask = vi.fn();
    await setup({ session: delegatedSession(), props: { delegatedEnabled: true, onOpenTask } });
    expect(tab(/Delegated/).textContent).toContain("3");
    fireEvent.click(tab(/Delegated/));
    expect(screen.getByText("Loading delegated tasks…")).toBeTruthy();
    await flush();
    expect(tasksMock).toHaveBeenCalledWith("sess-0001-aaaa");
    expect(screen.getByText("exit 1")).toBeTruthy();
    expect(screen.getByText("archived")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ship it" }));
    expect(onOpenTask).toHaveBeenCalledWith("t1");
    await flush(5000);
    expect(tasksMock).toHaveBeenCalledTimes(2);
  });

  it("disables the task link without a handler and says when nothing was delegated", async () => {
    tasksMock.mockResolvedValueOnce([taskRecord({ id: "t1", title: "Ship it" })]);
    const view = await setup({ session: delegatedSession(), props: { delegatedEnabled: true } });
    fireEvent.click(tab(/Delegated/));
    await flush();
    expect((screen.getByRole("button", { name: "Ship it" }) as HTMLButtonElement).disabled).toBe(true);
    tasksMock.mockResolvedValue([]);
    await flush(5000);
    expect(screen.getByText("This session has not delegated work to the hub.")).toBeTruthy();
    view.unmount();
  });

  it("survives a failing delegated request", async () => {
    tasksMock.mockRejectedValue(new Error("x"));
    await setup({ session: delegatedSession(), props: { delegatedEnabled: true } });
    fireEvent.click(tab(/Delegated/));
    await flush();
    expect(screen.getByText("Loading delegated tasks…")).toBeTruthy();
  });
});

describe("SessionDrawer review and details", () => {
  it("embeds the review panel for the session and surfaces its errors", async () => {
    await setup();
    fireEvent.click(tab("Review"));
    expect(screen.getByTestId("review-panel").textContent).toContain("session:sess-0001-aaaa:active");
    fireEvent.click(screen.getByRole("button", { name: "raise" }));
    expect(screen.getByText("review broke")).toBeTruthy();
  });

  it("has no Review tab without a working directory", async () => {
    await setup({ session: sessionRecord({ cwd: null }) });
    expect(screen.queryByRole("tab", { name: "Review" })).toBeNull();
  });

  it("shows the session facts in Details with placeholders for missing values", async () => {
    const bare = sessionRecord({ cwd: null, source: null, model: null, tokensIn: null, tokensOut: null, contextTokens: null, forkOf: "forkparent1", helperOf: "helperparent", helpers: 1, helpersTotal: 2 });
    liveMock.mockResolvedValue(liveSummary(bare, []));
    await setup({ session: bare });
    fireEvent.click(tab("Details"));
    expect(screen.getByText("sess-0001-aaaa").tagName).toBe("CODE");
    expect(screen.getByText("Claude Code · terminal")).toBeTruthy();
    expect(screen.getByText("in — · out — · context —")).toBeTruthy();
    expect(screen.getByText("fork of forkpare")).toBeTruthy();
    expect(screen.getByText(/1 helper folded in · 2 total/)).toBeTruthy();
    expect(screen.getByText("0 running · 0 spawned")).toBeTruthy();
  });

  it("shows the model, tokens and the parent names from the known sessions", async () => {
    const parent = sessionRecord({ sessionId: "forkparent1", title: "Parent run", cwd: "C:/other" });
    const peer = sessionRecord({ sessionId: "peer-1", cwd: "C:/work/api" });
    const child = sessionRecord({ forkOf: "forkparent1", transcriptPath: "C:/t.jsonl", claudePid: 11, hostPid: 22 });
    liveMock.mockResolvedValue(liveSummary(child, []));
    await setup({ session: child, props: { sessions: { forkparent1: parent, "peer-1": peer } } });
    fireEvent.click(tab("Details"));
    expect(screen.getByText("fork of Parent run")).toBeTruthy();
    expect(screen.getByText("1 other live agent in this folder")).toBeTruthy();
    expect(screen.getByText("claude-opus-4-7")).toBeTruthy();
    expect(screen.getByText("claude 11 · window 22")).toBeTruthy();
    expect(screen.getByText("C:/t.jsonl")).toBeTruthy();
  });

  it("lists the file claims and releases one", async () => {
    const claims: ClaimRecord[] = [{ id: "c1", sessionId: "sess-0001-aaaa", sessionTitle: null, repoPath: "C:/work/api", paths: ["a.ts", "b.ts"], note: "editing", createdAt: NOW, expiresAt: NOW + 60_000 }];
    const onReleaseClaim = vi.fn();
    await setup({ props: { claims, onReleaseClaim } });
    fireEvent.click(tab("Details"));
    const item = screen.getByText(/a\.ts, b\.ts/);
    expect(item.textContent).toContain("editing");
    fireEvent.click(within(item).getByRole("button", { name: "Release" }));
    expect(onReleaseClaim).toHaveBeenCalledWith("c1");
  });

  it("disables Release without a handler and shows a dash with no claims", async () => {
    const claims: ClaimRecord[] = [{ id: "c1", sessionId: null, sessionTitle: null, repoPath: "C:/r", paths: ["a.ts"], note: null, createdAt: NOW, expiresAt: NOW + 1000 }];
    const view = await setup({ props: { claims } });
    fireEvent.click(tab("Details"));
    expect((screen.getByRole("button", { name: "Release" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<SessionDrawer session={sessionRecord()} workspace="api-ws" delegatedEnabled={false} onClose={vi.fn()} claims={[]} />);
    expect(screen.queryByRole("button", { name: "Release" })).toBeNull();
  });
});
