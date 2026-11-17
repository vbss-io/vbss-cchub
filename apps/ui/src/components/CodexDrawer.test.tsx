import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCodexLive } from "../api";
import { replyCodexThread } from "../delegation-actions";
import { codexRecord, NOW, transcriptEntry } from "../test-support/u4-fixtures";
import type { CodexSessionRecord, PermissionRequestRecord } from "../types";
import { CodexDrawer } from "./CodexDrawer";

const hoisted = vi.hoisted(() => ({ approvals: [] as unknown[] }));

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), fetchCodexLive: vi.fn() }));

vi.mock("../delegation-actions", async (importOriginal) => ({ ...(await importOriginal<typeof import("../delegation-actions")>()), replyCodexThread: vi.fn() }));

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

const liveMock = vi.mocked(fetchCodexLive);
const replyMock = vi.mocked(replyCodexThread);

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
  liveMock.mockReset();
  replyMock.mockReset();
  liveMock.mockResolvedValue({ entries: [transcriptEntry({ role: "user", text: "fix the build" }), transcriptEntry({ text: "on it" })] });
});

afterEach(() => {
  vi.useRealTimers();
});

const setup = async (thread: CodexSessionRecord = codexRecord(), props: Partial<Parameters<typeof CodexDrawer>[0]> = {}) => {
  const fns = { onClose: vi.fn(), onOpenTask: vi.fn(), onFocusApp: vi.fn(), onArchive: vi.fn(), onUnarchive: vi.fn() };
  const view = render(<CodexDrawer thread={thread} workspace="api-ws" delegatedEnabled={false} codexAppRunning={false} {...fns} {...props} />);
  await flush();
  return { fns, ...view };
};

const tab = (name: string) => screen.getByRole("tab", { name });
const hubThread = (overrides: Partial<CodexSessionRecord> = {}): CodexSessionRecord => codexRecord({ origin: "hub", hubTaskId: "task-9", ...overrides });

describe("CodexDrawer header", () => {
  it("shows the thread, the workspace chip and the loaded activity", async () => {
    await setup();
    expect(screen.getByRole("dialog", { name: "Fix build" })).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText("api-ws")).toBeTruthy();
    expect(screen.getByText("fix the build")).toBeTruthy();
    expect(screen.getByText("on it")).toBeTruthy();
    expect(liveMock).toHaveBeenCalledWith("codex-0001-aaaa");
  });

  it("uses the custom title, the folder and the archived tag", async () => {
    await setup(codexRecord({ customTitle: "Mine", archivedAt: 9 }), { workspace: null });
    expect(screen.getByRole("dialog", { name: "Mine" })).toBeTruthy();
    expect(screen.getByText("work/api")).toBeTruthy();
    expect(screen.getByText("archived")).toBeTruthy();
  });

  it("offers Focus app only while the Codex app runs for a non ended thread", async () => {
    const { fns, unmount } = await setup(codexRecord(), { codexAppRunning: true });
    fireEvent.click(screen.getByRole("button", { name: /Focus app/ }));
    expect(fns.onFocusApp).toHaveBeenCalledTimes(1);
    unmount();
    await setup(codexRecord({ status: "ended" }), { codexAppRunning: true });
    expect(screen.queryByRole("button", { name: /Focus app/ })).toBeNull();
  });

  it("closes from the close button, Escape and an outside click but not from inside or the menu", async () => {
    const { fns } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(fns.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(fns.onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "x" });
    expect(fns.onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    fireEvent.mouseDown(document);
    expect(fns.onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(fns.onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(document.body);
    expect(fns.onClose).toHaveBeenCalledTimes(3);
  });

  it("goes full screen and back", async () => {
    const { fns } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Open in a large view" }));
    expect(screen.getByRole("dialog").className).toContain("drawer--full");
    fireEvent.mouseDown(document.body);
    expect(fns.onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog").className).not.toContain("drawer--full");
    fireEvent.click(screen.getByRole("button", { name: "Open in a large view" }));
    fireEvent.click(document.querySelector(".drawer__backdrop") as HTMLElement);
    expect(screen.getByRole("dialog").className).not.toContain("drawer--full");
  });

  it("renders the pending approvals", async () => {
    hoisted.approvals = [{ id: "p1" }];
    await setup();
    expect(screen.getByTestId("approvals").textContent).toBe("1");
  });
});

describe("CodexDrawer menu", () => {
  const menuNames = (): string[] => screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");

  it("runs open, delegated task, large view and archive", async () => {
    const onOpenSession = vi.fn();
    const { fns } = await setup(hubThread(), { delegatedEnabled: true, onOpenSession });
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    expect(menuNames()).toEqual(["Open session", "Open in Delegated", "Open in a large view", "Archive"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open session" }));
    expect(onOpenSession).toHaveBeenCalledWith("codex-0001-aaaa");
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Delegated" }));
    expect(fns.onOpenTask).toHaveBeenCalledWith("task-9");
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(fns.onArchive).toHaveBeenCalledWith("codex-0001-aaaa");
  });

  it("offers Unarchive for an archived thread and no open or task entries without support", async () => {
    const { fns } = await setup(codexRecord({ archivedAt: 5 }), { onOpenSession: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    expect(menuNames()).toEqual(["Open in a large view", "Unarchive"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unarchive" }));
    expect(fns.onUnarchive).toHaveBeenCalledWith("codex-0001-aaaa");
  });

  it("toggles the large view from the menu", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in a large view" }));
    expect(screen.getByRole("dialog").className).toContain("drawer--full");
  });
});

describe("CodexDrawer activity", () => {
  it("shows Loading, then the empty placeholder", async () => {
    liveMock.mockReturnValue(new Promise(() => undefined));
    const view = await setup();
    expect(screen.getByText("Loading…")).toBeTruthy();
    view.unmount();
    liveMock.mockResolvedValue({ entries: [] });
    await setup();
    expect(screen.getByText("No transcript yet for this thread.")).toBeTruthy();
  });

  it("refreshes every 5 seconds while live but not once ended", async () => {
    const view = await setup();
    await flush(5000);
    expect(liveMock).toHaveBeenCalledTimes(2);
    view.unmount();
    liveMock.mockClear();
    await setup(codexRecord({ status: "ended" }));
    await flush(10_000);
    expect(liveMock).toHaveBeenCalledTimes(1);
  });

  it("shows the load error, retries five times and clears it on success", async () => {
    liveMock.mockRejectedValue(new Error("rollout locked"));
    await setup(codexRecord({ status: "ended" }));
    expect(screen.getByText("rollout locked")).toBeTruthy();
    await flush(5000);
    expect(liveMock).toHaveBeenCalledTimes(6);
    await flush(5000);
    expect(liveMock).toHaveBeenCalledTimes(6);
  });

  it("names a non error failure and recovers", async () => {
    liveMock.mockRejectedValueOnce("odd");
    await setup();
    expect(screen.getByText("failed to load")).toBeTruthy();
    await flush(1000);
    expect(screen.queryByText("failed to load")).toBeNull();
    expect(screen.getByText("on it")).toBeTruthy();
  });

  it("toggles Detailed and remembers it", async () => {
    liveMock.mockResolvedValue({ entries: [transcriptEntry({ role: "user", text: "q" }), transcriptEntry({ role: "tool", text: "ran it", tool: "exec" })] });
    await setup();
    expect(screen.queryByText("ran it")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Detailed" }));
    expect(screen.getByText("ran it")).toBeTruthy();
    expect(localStorage.getItem("hub.timeline.detail")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(localStorage.getItem("hub.timeline.detail")).toBe("0");
  });

  it("starts detailed when remembered and survives blocked storage", async () => {
    localStorage.setItem("hub.timeline.detail", "1");
    liveMock.mockResolvedValue({ entries: [transcriptEntry({ role: "tool", text: "ran it", tool: "exec" })] });
    const view = await setup();
    expect(screen.getByText("ran it")).toBeTruthy();
    view.unmount();
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await setup();
    expect(screen.queryByText("ran it")).toBeNull();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe("CodexDrawer reply", () => {
  const typeReply = (text: string) => fireEvent.change(screen.getByLabelText("Reply to this run"), { target: { value: text } });
  const send = () => fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

  it("only shows the reply box for a live thread the hub started", async () => {
    const view = await setup(codexRecord());
    expect(screen.queryByLabelText("Reply to this run")).toBeNull();
    view.unmount();
    const archived = await setup(hubThread({ archivedAt: 5 }));
    expect(screen.queryByLabelText("Reply to this run")).toBeNull();
    archived.unmount();
    await setup(hubThread());
    expect(screen.getByLabelText("Reply to this run")).toBeTruthy();
  });

  it("keeps Send disabled for blank text and sends the trimmed reply", async () => {
    replyMock.mockResolvedValue({ ok: true });
    await setup(hubThread());
    expect((screen.getByRole("button", { name: "Send reply" }) as HTMLButtonElement).disabled).toBe(true);
    typeReply("   ");
    expect((screen.getByRole("button", { name: "Send reply" }) as HTMLButtonElement).disabled).toBe(true);
    typeReply("  keep going  ");
    send();
    await flush();
    expect(replyMock).toHaveBeenCalledWith("codex-0001-aaaa", "keep going");
    expect(screen.getByText("Sent. The run continues in the hub.")).toBeTruthy();
    expect((screen.getByLabelText("Reply to this run") as HTMLTextAreaElement).value).toBe("");
    typeReply("more");
    expect(screen.queryByText("Sent. The run continues in the hub.")).toBeNull();
  });

  it("sends with Ctrl+Enter and not with a plain Enter", async () => {
    replyMock.mockResolvedValue({ ok: true });
    await setup(hubThread());
    typeReply("go");
    fireEvent.keyDown(screen.getByLabelText("Reply to this run"), { key: "Enter" });
    expect(replyMock).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("Reply to this run"), { key: "Enter", ctrlKey: true });
    await flush();
    expect(replyMock).toHaveBeenCalledTimes(1);
    typeReply("again");
    fireEvent.keyDown(screen.getByLabelText("Reply to this run"), { key: "Enter", metaKey: true });
    await flush();
    expect(replyMock).toHaveBeenCalledTimes(2);
  });

  it("ignores an empty Ctrl+Enter and a second send while one is in flight", async () => {
    let resolve: (value: { ok: true }) => void = () => undefined;
    replyMock.mockReturnValue(new Promise((done) => (resolve = done)));
    await setup(hubThread());
    fireEvent.keyDown(screen.getByLabelText("Reply to this run"), { key: "Enter", ctrlKey: true });
    expect(replyMock).not.toHaveBeenCalled();
    typeReply("once");
    send();
    await flush();
    expect(screen.getByRole("button", { name: "Sending..." })).toBeTruthy();
    expect((screen.getByLabelText("Reply to this run") as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Reply to this run"), { key: "Enter", ctrlKey: true });
    expect(replyMock).toHaveBeenCalledTimes(1);
    resolve({ ok: true });
    await flush();
    expect(screen.getByText("Sent. The run continues in the hub.")).toBeTruthy();
  });

  it("explains why a thread the hub did not start cannot take a reply and offers to open it", async () => {
    replyMock.mockResolvedValue({ ok: false, code: "not-hub-thread", message: "refused" });
    const onOpenSession = vi.fn();
    await setup(hubThread(), { onOpenSession });
    typeReply("hi");
    send();
    await flush();
    expect(screen.getByText("The hub did not start this thread, so replying here could put two writers on it.")).toBeTruthy();
    const open = screen.getAllByRole("button", { name: "Open session" }).at(-1) as HTMLElement;
    fireEvent.click(open);
    expect(onOpenSession).toHaveBeenCalledWith("codex-0001-aaaa");
    expect((screen.getByLabelText("Reply to this run") as HTMLTextAreaElement).value).toBe("hi");
  });

  it("explains a busy run without an open offer", async () => {
    replyMock.mockResolvedValue({ ok: false, code: "busy", message: "busy" });
    await setup(hubThread(), { onOpenSession: vi.fn() });
    typeReply("hi");
    send();
    await flush();
    expect(screen.getByText("The run is still working. Reply once it stops.")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Open session" })).toHaveLength(0);
  });

  it("shows the server message for an unknown failure and for a thrown error", async () => {
    replyMock.mockResolvedValueOnce({ ok: false, code: null, message: "disk full" });
    await setup(hubThread());
    typeReply("hi");
    send();
    await flush();
    expect(screen.getByText("disk full")).toBeTruthy();
    replyMock.mockRejectedValueOnce(new Error("socket closed"));
    send();
    await flush();
    expect(screen.getByText("socket closed")).toBeTruthy();
    replyMock.mockRejectedValueOnce("odd");
    send();
    await flush();
    expect(screen.getByText("The reply was not sent.")).toBeTruthy();
  });

  it("resets the reply box when the thread changes", async () => {
    const view = await setup(hubThread());
    typeReply("draft");
    view.rerender(<CodexDrawer thread={hubThread({ id: "codex-other" })} workspace="api-ws" delegatedEnabled={false} codexAppRunning={false} onClose={vi.fn()} onOpenTask={vi.fn()} onFocusApp={vi.fn()} onArchive={vi.fn()} onUnarchive={vi.fn()} />);
    await flush();
    expect((screen.getByLabelText("Reply to this run") as HTMLTextAreaElement).value).toBe("");
  });
});

describe("CodexDrawer review and details", () => {
  it("embeds the review panel for the thread and surfaces its errors", async () => {
    await setup();
    fireEvent.click(tab("Review"));
    expect(screen.getByTestId("review-panel").textContent).toContain("session:codex-0001-aaaa:active");
    fireEvent.click(screen.getByRole("button", { name: "raise" }));
    expect(screen.getByText("review broke")).toBeTruthy();
  });

  it("has no Review tab without a working directory", async () => {
    await setup(codexRecord({ cwd: null }));
    expect(screen.queryByRole("tab", { name: "Review" })).toBeNull();
    fireEvent.click(tab("Details"));
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows the thread facts and links the hub task when delegation is on", async () => {
    const { fns } = await setup(hubThread({ originator: "codex_cli", threadSource: "agent_created_thread" }), { delegatedEnabled: true });
    fireEvent.click(tab("Details"));
    expect(screen.getByText("codex-0001-aaaa").tagName).toBe("CODE");
    expect(screen.getByText("Codex app")).toBeTruthy();
    expect(screen.getByText("C:/codex/rollout.jsonl")).toBeTruthy();
    expect(screen.getByText("codex_cli")).toBeTruthy();
    expect(screen.getByText("via hub")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Open in Delegated"));
    expect(fns.onOpenTask).toHaveBeenCalledWith("task-9");
  });

  it("shows the hub task as plain text when delegation is off and labels other sources", async () => {
    const view = await setup(hubThread({ threadSource: "user" }));
    fireEvent.click(tab("Details"));
    expect(screen.getByText("task-9").closest("button")).toBeNull();
    view.unmount();
    const second = await setup(codexRecord({ threadSource: "voice_chat" }));
    fireEvent.click(tab("Details"));
    expect(screen.getByText("voice chat")).toBeTruthy();
    second.unmount();
    await setup(codexRecord({ threadSource: "brand_new" }));
    fireEvent.click(tab("Details"));
    expect(screen.getByText("brand new")).toBeTruthy();
  });
});
