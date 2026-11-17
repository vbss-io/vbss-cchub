import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "../delegation";
import { NOW, makeDetail, makeReport, makeRun, makeSession, makeTaskRecord, makeWorktree } from "../test-support/u2-task-fixtures";
import type { CodexSessionRecord } from "../types";
import { useTaskDetail, type TaskDetailState } from "../use-task-detail";
import { TaskDrawer } from "./TaskDrawer";

vi.mock("../use-task-detail", () => ({ useTaskDetail: vi.fn() }));

vi.mock("./ReviewPanel", () => ({
  ReviewPanel: ({ subject, running, refreshKey }: { subject: { kind: string; id: string }; running: boolean; refreshKey: string }) => (
    <div data-testid="review-panel">{`${subject.kind}:${subject.id}:${running ? "running" : "idle"}:${refreshKey}`}</div>
  ),
}));

vi.mock("../views/ReportsView", () => ({
  ReportRow: ({ report }: { report: { id: string; text: string } }) => <li data-testid="report-row">{`${report.id}:${report.text}`}</li>,
}));

const hook = vi.mocked(useTaskDetail);

interface Handlers {
  archive: ReturnType<typeof vi.fn<() => void>>;
  unarchive: ReturnType<typeof vi.fn<() => void>>;
  cancel: ReturnType<typeof vi.fn<() => void>>;
  merge: ReturnType<typeof vi.fn<() => void>>;
  discard: ReturnType<typeof vi.fn<() => void>>;
  retry: ReturnType<typeof vi.fn<TaskDetailState["retry"]>>;
  sendContinue: ReturnType<typeof vi.fn<TaskDetailState["sendContinue"]>>;
}

const makeState = (task: TaskRecord | null, patch: Partial<TaskDetailState> = {}): { state: TaskDetailState; handlers: Handlers } => {
  const handlers: Handlers = {
    archive: vi.fn<() => void>(),
    unarchive: vi.fn<() => void>(),
    cancel: vi.fn<() => void>(),
    merge: vi.fn<() => void>(),
    discard: vi.fn<() => void>(),
    retry: vi.fn<TaskDetailState["retry"]>(),
    sendContinue: vi.fn<TaskDetailState["sendContinue"]>(() => Promise.resolve(true)),
  };
  const state: TaskDetailState = {
    detail: task ? makeDetail(task, { runs: [makeRun("r1", task.id)] }) : null,
    worktree: null,
    logLines: [{ key: "1", kind: "text", text: "live output line" }],
    busy: false,
    archiveSupported: true,
    ...handlers,
    ...patch,
  };
  return { state, handlers };
};

interface SetupOptions {
  task?: TaskRecord | null;
  listed?: TaskRecord[];
  state?: Partial<TaskDetailState>;
  props?: Partial<Parameters<typeof TaskDrawer>[0]>;
}

const setup = ({ task = makeTaskRecord("t1", { title: "Ship it" }), listed, state: statePatch = {}, props = {} }: SetupOptions = {}) => {
  const { state, handlers } = makeState(task, statePatch);
  hook.mockReturnValue(state);
  const callbacks = { onRefresh: vi.fn(() => Promise.resolve()), onError: vi.fn(), onClose: vi.fn(), onOpenSession: vi.fn(), onOpenCodex: vi.fn(), onOpenTask: vi.fn() };
  const view = render(
    <TaskDrawer
      taskId="t1"
      tasks={listed ?? (task ? [task] : [])}
      sessions={{}}
      codexSessions={[]}
      workspace={null}
      tick={0}
      subscribeRunEvents={() => () => undefined}
      {...callbacks}
      {...props}
    />,
  );
  return { ...callbacks, handlers, state, ...view };
};

const menuButton = (name = "Ship it") => screen.getByRole("button", { name: `Actions for ${name}` });
const openMenu = async (user: ReturnType<typeof userEvent.setup>, name?: string) => {
  await user.click(menuButton(name));
};
const menuLabels = () => screen.getAllByRole("menuitem").map((item) => item.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  hook.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskDrawer header", () => {
  it("shows the title, status, runner, workspace and timing with cost", () => {
    setup({ task: makeTaskRecord("t1", { title: "Ship it", repo: "api", runsCount: 3, status: "completed" }), state: { detail: makeDetail(makeTaskRecord("t1", { title: "Ship it", repo: "api", runsCount: 3 }), { runs: [makeRun("r1", "t1", { costUsd: 1.5 })] }) } });
    const drawer = screen.getByRole("dialog", { name: "Ship it" });
    expect(within(drawer).getByRole("heading", { name: "Ship it" })).toBeTruthy();
    expect(within(drawer).getByText("Completed")).toBeTruthy();
    expect(within(drawer).getByText("Claude")).toBeTruthy();
    expect(within(drawer).getByText("vbss / api")).toBeTruthy();
    expect(within(drawer).getByText(/started 1h ago · 50m · 3 runs/)).toBeTruthy();
    expect(within(drawer).getByText(/\$1\.50/)).toBeTruthy();
  });

  it("prefers the workspace label from props and shows the codex runner and archived flag", () => {
    setup({ task: makeTaskRecord("t1", { title: "Ship it", runner: "codex", archivedAt: 5 }), props: { workspace: "Display WS" } });
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("Display WS")).toBeTruthy();
    expect(screen.getByText("archived")).toBeTruthy();
  });

  it("falls back to the listed task before the detail loads", () => {
    const listed = makeTaskRecord("t1", { title: "Listed title" });
    setup({ task: null, listed: [listed], state: { detail: null } });
    expect(screen.getByRole("dialog", { name: "Listed title" })).toBeTruthy();
    expect(screen.getByText("Loading the task…")).toBeTruthy();
  });

  it("uses a generic name when the task is unknown", () => {
    setup({ task: null, listed: [] });
    expect(screen.getByRole("dialog", { name: "Task" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });

  it("closes from the close button", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("explains a failure for tasks that need attention", () => {
    setup({ task: makeTaskRecord("t1", { title: "Ship it", status: "failed", lastError: "exit 2" }) });
    expect(screen.getByText("The run failed")).toBeTruthy();
    expect(screen.getByText("exit 2")).toBeTruthy();
  });

  it("omits the failure box for healthy tasks and for statuses without a retry", () => {
    setup({ task: makeTaskRecord("t1", { title: "Ship it", status: "completed" }) });
    expect(document.querySelector(".why")).toBeNull();
  });
});

describe("TaskDrawer primary actions", () => {
  it("cancels a running task", async () => {
    const user = userEvent.setup();
    const { handlers } = setup({ task: makeTaskRecord("t1", { title: "Ship it", status: "running" }) });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(handlers.cancel).toHaveBeenCalledTimes(1);
  });

  it("starts a follow-up composer from Continue, sends the trimmed prompt and closes it on success", async () => {
    const user = userEvent.setup();
    const { handlers } = setup();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const box = screen.getByPlaceholderText("send a follow-up into the same session");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(box, "  more please  ");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(handlers.sendContinue).toHaveBeenCalledWith("more please");
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByPlaceholderText("send a follow-up into the same session")).toBeNull();
  });

  it("keeps the composer when the follow-up fails and can be cancelled", async () => {
    const user = userEvent.setup();
    setup({ state: { sendContinue: vi.fn(() => Promise.resolve(false)) } });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByPlaceholderText("send a follow-up into the same session"), "again");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect((screen.getByPlaceholderText("send a follow-up into the same session") as HTMLTextAreaElement).value).toBe("again");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText("send a follow-up into the same session")).toBeNull();
  });

  it("ignores a blank follow-up", async () => {
    const user = userEvent.setup();
    const { state } = setup();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const box = screen.getByPlaceholderText("send a follow-up into the same session");
    fireEvent.change(box, { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(state.sendContinue).not.toHaveBeenCalled();
  });

  it("merges a finished worktree task from the primary button", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", { title: "Ship it", status: "completed", isolation: "worktree", worktreePath: "/wt", branch: "task/t1", baseBranch: "main" });
    const { handlers } = setup({ task, state: { worktree: makeWorktree() } });
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    const merge = screen.getByRole("button", { name: "Merge into main" });
    expect(merge.title).toBe("git merge --no-ff into main");
    await user.click(merge);
    expect(handlers.merge).toHaveBeenCalledTimes(1);
  });

  it("disables the primary buttons while busy", () => {
    setup({ state: { busy: true } });
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("has no primary button for archived tasks", () => {
    setup({ task: makeTaskRecord("t1", { title: "Ship it", archivedAt: 9 }) });
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});

describe("TaskDrawer menu", () => {
  it("offers archive for a finished shared task and runs it", async () => {
    const user = userEvent.setup();
    const { handlers } = setup();
    await openMenu(user);
    expect(menuLabels()).toEqual(["Open in a large view", "Archive"]);
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(handlers.archive).toHaveBeenCalledTimes(1);
  });

  it("hides archive when unsupported and while running", async () => {
    const user = userEvent.setup();
    const first = setup({ state: { archiveSupported: false } });
    await openMenu(user);
    expect(menuLabels()).toEqual(["Open in a large view"]);
    first.unmount();
    setup({ task: makeTaskRecord("t1", { title: "Ship it", status: "running" }) });
    await openMenu(user);
    expect(menuLabels()).toEqual(["Open in a large view"]);
  });

  it("offers unarchive and Continue for archived tasks", async () => {
    const user = userEvent.setup();
    const { handlers } = setup({ task: makeTaskRecord("t1", { title: "Ship it", archivedAt: 9 }) });
    await openMenu(user);
    expect(menuLabels()).toEqual(["Continue", "Open in a large view", "Unarchive"]);
    await user.click(screen.getByRole("menuitem", { name: "Unarchive" }));
    expect(handlers.unarchive).toHaveBeenCalledTimes(1);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Continue" }));
    expect(screen.getByPlaceholderText("send a follow-up into the same session")).toBeTruthy();
  });

  it("offers retries for tasks that need attention", async () => {
    const user = userEvent.setup();
    const { handlers } = setup({ task: makeTaskRecord("t1", { title: "Ship it", status: "attention" }) });
    await openMenu(user);
    expect(menuLabels()).toEqual(["Retry autonomous", "Retry", "Open in a large view", "Archive"]);
    await user.click(screen.getByRole("menuitem", { name: "Retry autonomous" }));
    expect(handlers.retry).toHaveBeenCalledWith("autonomous");
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Retry" }));
    expect(handlers.retry).toHaveBeenLastCalledWith("plain");
  });

  it("offers a single plain retry after a failure", async () => {
    const user = userEvent.setup();
    const { handlers } = setup({ task: makeTaskRecord("t1", { title: "Ship it", status: "failed" }) });
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Retry" }));
    expect(handlers.retry).toHaveBeenCalledWith("plain");
  });

  it("links to the run session, the Codex thread and the delegating session", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", { title: "Ship it", sessionId: "run-s", originSessionId: "origin-s" });
    const thread = { id: "thread-1", hubTaskId: "t1" } as CodexSessionRecord;
    const { onOpenSession, onOpenCodex } = setup({ task, props: { sessions: { "run-s": makeSession("run-s"), "origin-s": makeSession("origin-s") }, codexSessions: [thread] } });
    await openMenu(user);
    expect(menuLabels()).toEqual(["Open session", "Open Codex thread", "Open delegating session", "Open in a large view", "Archive"]);
    await user.click(screen.getByRole("menuitem", { name: "Open session" }));
    expect(onOpenSession).toHaveBeenCalledWith("run-s");
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Open Codex thread" }));
    expect(onOpenCodex).toHaveBeenCalledWith("thread-1");
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Open delegating session" }));
    expect(onOpenSession).toHaveBeenLastCalledWith("origin-s");
  });

  it("offers merge in the menu while another action is primary, and discard for existing worktrees", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", { title: "Ship it", status: "failed", isolation: "worktree", worktreePath: "/wt", branch: "task/t1", baseBranch: "main" });
    const { handlers } = setup({ task, state: { worktree: makeWorktree() } });
    await openMenu(user);
    expect(menuLabels()).toEqual(["Merge into main", "Retry", "Open in a large view", "Archive", "Discard worktree"]);
    await user.click(screen.getByRole("menuitem", { name: "Merge into main" }));
    expect(handlers.merge).toHaveBeenCalledTimes(1);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Discard worktree" }));
    expect(screen.getByRole("tab", { name: "Worktree", selected: true })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(handlers.discard).toHaveBeenCalledTimes(1);
  });

  it("uses the stored base branch label while the worktree status is unknown", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", { title: "Ship it", status: "failed", isolation: "worktree", baseBranch: "develop" });
    setup({ task, state: { worktree: null } });
    await openMenu(user);
    expect(screen.queryByRole("menuitem", { name: /Merge into/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Discard worktree" })).toBeNull();
  });
});

describe("TaskDrawer tabs", () => {
  it("shows the live output by default", () => {
    setup();
    expect(screen.getByRole("tab", { name: "Live output", selected: true })).toBeTruthy();
    expect(screen.getByText("live output line")).toBeTruthy();
  });

  it("shows what was asked as markdown", async () => {
    const user = userEvent.setup();
    setup({ task: makeTaskRecord("t1", { title: "Ship it", prompt: "**Do** this" }) });
    await user.click(screen.getByRole("tab", { name: "What was asked" }));
    expect(document.querySelector(".askbox__body strong")?.textContent).toBe("Do");
  });

  it("lists the runs with a count and an empty state", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", { title: "Ship it" });
    const first = setup({ task, state: { detail: makeDetail(task, { runs: [makeRun("r1", "t1", { prompt: "first prompt" }), makeRun("r2", "t1", { seq: 2, prompt: "second prompt" })] }) } });
    expect(within(screen.getByRole("tab", { name: /^Runs/ })).getByText("2")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: /^Runs/ }));
    expect(screen.getByText("first prompt")).toBeTruthy();
    expect(screen.getByText("second prompt")).toBeTruthy();
    first.unmount();
    setup({ task, state: { detail: makeDetail(task, { runs: [] }) } });
    await user.click(screen.getByRole("tab", { name: /^Runs/ }));
    expect(screen.getByText("No runs recorded yet.")).toBeTruthy();
  });

  it("hides the Worktree tab for shared checkouts and shows the panel for isolated tasks", async () => {
    const user = userEvent.setup();
    const shared = setup();
    expect(screen.queryByRole("tab", { name: "Worktree" })).toBeNull();
    shared.unmount();
    const task = makeTaskRecord("t1", { title: "Ship it", isolation: "worktree", worktreePath: "/wt", branch: "task/t1", baseBranch: "main" });
    setup({ task, state: { worktree: makeWorktree() } });
    await user.click(screen.getByRole("tab", { name: "Worktree" }));
    expect(screen.getByText("task/t1").tagName).toBe("CODE");
    await user.click(screen.getByRole("button", { name: "Discard worktree" }));
    expect(screen.getByText(/losing unmerged work/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByText(/losing unmerged work/)).toBeNull();
  });

  it("merges from inside the worktree panel", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", { title: "Ship it", status: "failed", isolation: "worktree", worktreePath: "/wt", branch: "task/t1", baseBranch: "main" });
    const { handlers } = setup({ task, state: { worktree: makeWorktree() } });
    await user.click(screen.getByRole("tab", { name: "Worktree" }));
    await user.click(screen.getByRole("button", { name: "Merge into main" }));
    expect(handlers.merge).toHaveBeenCalledTimes(1);
  });

  it("renders the review panel for the task", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("tab", { name: "Review" }));
    expect(screen.getByTestId("review-panel").textContent).toBe("task:t1:idle:completed:1");
  });

  it("only offers Reports when there are some and lists them", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", { title: "Ship it" });
    const first = setup({ task });
    expect(screen.queryByRole("tab", { name: /^Reports/ })).toBeNull();
    first.unmount();
    setup({ task, state: { detail: makeDetail(task, { reports: [makeReport("rep1"), makeReport("rep2")] }) } });
    await user.click(screen.getByRole("tab", { name: /^Reports/ }));
    expect(screen.getAllByTestId("report-row").map((row) => row.textContent)).toEqual(["rep1:Report body", "rep2:Report body"]);
  });

  it("shows task details with links to the sessions", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", {
      title: "Ship it",
      repo: "api",
      runner: "codex",
      requestedModel: "gpt-x",
      permissionMode: "plan",
      addDirs: ["/a", "/b"],
      portBase: 4000,
      portEnd: 4009,
      sessionId: "hub-sess",
      originSessionId: "origin-s",
      isolation: "worktree",
      branch: "task/t1",
    });
    const { onOpenSession } = setup({ task, state: { worktree: makeWorktree() }, props: { sessions: { "origin-s": makeSession("origin-s", { title: "Parent" }) } } });
    await user.click(screen.getByRole("tab", { name: "Details" }));
    const details = document.querySelector("dl.details") as HTMLElement;
    expect(within(details).getByText("t1")).toBeTruthy();
    expect(within(details).getByText("vbss / api")).toBeTruthy();
    expect(within(details).getByText("codex · gpt-x · plan")).toBeTruthy();
    expect(within(details).getByText("/ws/vbss")).toBeTruthy();
    expect(within(details).getByText("/a, /b")).toBeTruthy();
    expect(within(details).getByText("worktree · task/t1 · /ws/vbss/.worktrees/t1")).toBeTruthy();
    expect(within(details).getByText("4000–4009")).toBeTruthy();
    await user.click(within(details).getByRole("button", { name: "delegated by Parent" }));
    expect(onOpenSession).toHaveBeenCalledWith("origin-s");
    await user.click(within(details).getByRole("button", { name: "hub-sess" }));
    expect(onOpenSession).toHaveBeenLastCalledWith("hub-sess");
  });

  it("shows placeholders in the details for a minimal task", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("tab", { name: "Details" }));
    const details = document.querySelector("dl.details") as HTMLElement;
    expect(within(details).getByText("shared checkout")).toBeTruthy();
    expect(within(details).getAllByText("—").length).toBeGreaterThanOrEqual(3);
    expect(within(details).getByText("via mcp")).toBeTruthy();
  });

  it("returns to the live tab when the task changes", async () => {
    const user = userEvent.setup();
    const { rerender, state } = setup();
    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByRole("tab", { name: "Details", selected: true })).toBeTruthy();
    hook.mockReturnValue(state);
    rerender(
      <TaskDrawer
        taskId="t2"
        tasks={[]}
        sessions={{}}
        codexSessions={[]}
        workspace={null}
        tick={0}
        subscribeRunEvents={() => () => undefined}
        onRefresh={() => Promise.resolve()}
        onError={() => undefined}
        onClose={() => undefined}
        onOpenSession={() => undefined}
        onOpenCodex={() => undefined}
      />,
    );
    expect(screen.getByRole("tab", { name: "Live output", selected: true })).toBeTruthy();
  });

  it("passes the running flag to the live log", () => {
    setup({ task: makeTaskRecord("t1", { title: "Ship it", status: "running" }), state: { logLines: [] } });
    expect(screen.getByText("Waiting for the first output…")).toBeTruthy();
  });
});

describe("TaskDrawer dismissal and large view", () => {
  it("closes on Escape and on a mouse down outside, but not inside or in a menu", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
    await openMenu(user);
    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(document);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("toggles the large view from the header button and the menu, leaving it with Escape or the backdrop", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    expect(document.querySelector(".drawer__backdrop")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open in a large view" }));
    expect(document.querySelector(".drawer--full")).not.toBeNull();
    expect(document.querySelector(".drawer__backdrop")).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".drawer--full")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open in a large view" }));
    fireEvent.click(document.querySelector(".drawer__backdrop") as HTMLElement);
    expect(document.querySelector(".drawer--full")).toBeNull();
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Open in a large view" }));
    expect(screen.getByRole("button", { name: "Back to the side panel" })).toBeTruthy();
    await openMenu(user);
    expect(screen.getByRole("menuitem", { name: "Back to the side panel" })).toBeTruthy();
  });

  it("renders the resize handle on wide viewports only", () => {
    const wide = setup();
    expect(screen.getByRole("separator", { name: "Resize task panel" })).toBeTruthy();
    wide.unmount();
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 600 });
    setup();
    expect(screen.queryByRole("separator")).toBeNull();
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
  });
});
