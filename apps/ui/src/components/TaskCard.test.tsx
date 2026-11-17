import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, makeSession, makeTaskRecord } from "../test-support/u2-task-fixtures";
import { TaskCard, durationLabel, inFlight, needsYou, taskOrigin, taskStatusLabel, whyOf, worktreeLabel, TASK_STATUS_LABEL, type TaskOrigin } from "./TaskCard";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("taskOrigin", () => {
  it("names the delegating session by custom title, title or short id", () => {
    const task = makeTaskRecord("t", { originSessionId: "abcdef123456" });
    expect(taskOrigin(task, { abcdef123456: makeSession("abcdef123456", { customTitle: "Custom", title: "T" }) })).toEqual({ label: "delegated by Custom", sessionId: "abcdef123456" });
    expect(taskOrigin(task, { abcdef123456: makeSession("abcdef123456", { title: "Plain" }) }).label).toBe("delegated by Plain");
    expect(taskOrigin(task, { abcdef123456: makeSession("abcdef123456") }).label).toBe("delegated by abcdef12");
  });

  it("falls back to the short id without a link when the session is unknown", () => {
    expect(taskOrigin(makeTaskRecord("t", { originSessionId: "abcdef123456" }), {})).toEqual({ label: "delegated by abcdef12", sessionId: null });
  });

  it("labels share, creators and the mcp default", () => {
    expect(taskOrigin(makeTaskRecord("t", { originClient: "share" }), {}).label).toBe("via share");
    expect(taskOrigin(makeTaskRecord("t", { createdBy: "routine:daily" }), {}).label).toBe("via routine");
    expect(taskOrigin(makeTaskRecord("t", { createdBy: "vitor" }), {}).label).toBe("via vitor");
    expect(taskOrigin(makeTaskRecord("t", { originClient: "codex" }), {}).label).toBe("via codex");
    expect(taskOrigin(makeTaskRecord("t"), {}).label).toBe("via mcp");
  });
});

describe("task labels", () => {
  it("explains why attention, failed and interrupted tasks need the user", () => {
    expect(whyOf(makeTaskRecord("t", { status: "attention", lastError: "denied" }))).toEqual({ headline: "Ran in safe mode and hit a permission it could not grant", detail: "denied", retry: "autonomous" });
    expect(whyOf(makeTaskRecord("t", { status: "failed", lastError: "boom" }))).toEqual({ headline: "The run failed", detail: "boom", retry: "plain" });
    expect(whyOf(makeTaskRecord("t", { status: "interrupted" }))).toEqual({ headline: "The hub restarted mid-run", detail: null, retry: "plain" });
    expect(whyOf(makeTaskRecord("t", { status: "completed" }))).toBeNull();
  });

  it("measures the duration up to now while running and up to the last update otherwise", () => {
    expect(durationLabel(makeTaskRecord("t", { status: "running", createdAt: NOW - 5 * 60_000 }))).toBe("running 5m");
    expect(durationLabel(makeTaskRecord("t", { status: "completed", createdAt: NOW - 3_600_000, updatedAt: NOW - 1_800_000 }))).toBe("30m");
  });

  it("re-exports the status predicates and labels", () => {
    expect(inFlight("running")).toBe(true);
    expect(inFlight("completed")).toBe(false);
    expect(needsYou("failed")).toBe(true);
    expect(TASK_STATUS_LABEL.attention).toBe("Needs you");
  });

  it("calls a finished unmerged worktree task ready to merge unless archived", () => {
    const ready = makeTaskRecord("t", { status: "completed", isolation: "worktree", worktreePath: "/wt" });
    expect(taskStatusLabel(ready)).toBe("Ready to merge");
    expect(taskStatusLabel({ ...ready, archivedAt: 5 })).toBe("Completed");
    expect(taskStatusLabel(makeTaskRecord("t", { status: "failed" }))).toBe("Failed");
  });

  it("describes the worktree state", () => {
    expect(worktreeLabel(makeTaskRecord("t"))).toBeNull();
    expect(worktreeLabel(makeTaskRecord("t", { isolation: "worktree" }))).toBe("worktree");
    expect(worktreeLabel(makeTaskRecord("t", { isolation: "worktree", branch: "task/x" }))).toBe("worktree · task/x");
    expect(worktreeLabel(makeTaskRecord("t", { isolation: "worktree", isolationReason: "busy-repo", branch: "task/x" }))).toBe("worktree · auto · task/x");
    expect(worktreeLabel(makeTaskRecord("t", { isolation: "worktree", mergedAt: 10, branch: "task/x" }))).toBe("merged · task/x");
  });
});

describe("TaskCard", () => {
  const origin: TaskOrigin = { label: "via mcp", sessionId: null };

  const setup = (task = makeTaskRecord("t1", { title: "Ship it" }), props: Partial<Parameters<typeof TaskCard>[0]> = {}) => {
    const handlers = { onSelect: vi.fn(), onOpenSession: vi.fn(), onCancel: vi.fn(), onArchive: vi.fn(), onRetry: vi.fn() };
    const view = render(<TaskCard task={task} origin={origin} runSession={null} selected={false} archiveSupported busy={false} {...handlers} {...props} />);
    return { ...handlers, ...view };
  };

  it("shows title, runner, workspace, status, runs and age", () => {
    setup(makeTaskRecord("t1", { title: "Ship it", repo: "api", runsCount: 2, status: "completed" }));
    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("api").title).toContain("vbss / api");
    expect(screen.getByText(/50m · 2 runs/)).toBeTruthy();
    expect(screen.getByText("10m ago")).toBeTruthy();
  });

  it("uses the codex runner and a singular run", () => {
    setup(makeTaskRecord("t1", { runner: "codex", runsCount: 1 }));
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText(/· 1 run$/)).toBeTruthy();
  });

  it("shows the cost, the context meter and the extras counter", () => {
    const session = makeSession("sess-12345678", { contextTokens: 50_000, status: "active", model: "claude-opus-4" });
    setup(makeTaskRecord("t1", { portBase: 4000, portEnd: 4009 }), { cost: "$1.25", costTitle: "1 run", runSession: session, peers: 2 });
    expect(screen.getByText(/\$1\.25/).getAttribute("title")).toBe("1 run");
    const meter = document.querySelector(".rc__ctx") as HTMLElement;
    expect(meter.title).toContain("50,000");
    expect(meter.textContent).toMatch(/\d+%/);
    const more = screen.getByRole("note");
    expect(more.getAttribute("aria-label")).toContain("ports 4000–4009");
    expect(more.getAttribute("aria-label")).toContain("2 more here");
    expect(more.getAttribute("aria-label")).toContain("hub session sess-123 · active");
  });

  it("omits the peers note for isolated worktrees and the meter without context", () => {
    setup(makeTaskRecord("t1", { isolation: "worktree", branch: "task/t1" }), { peers: 3, runSession: makeSession("s1") });
    expect(screen.getByRole("note").getAttribute("aria-label")).not.toContain("more here");
    expect(document.querySelector(".rc__ctx")).toBeNull();
    expect(screen.getByText("task/t1").title).toContain("own git worktree");
  });

  it("falls back to a generic worktree part without a branch", () => {
    setup(makeTaskRecord("t1", { isolation: "worktree" }));
    expect(screen.getByText("worktree")).toBeTruthy();
  });

  it("explains failures and offers retry actions in the menu", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", { status: "failed", lastError: "exit 1" });
    const { onRetry } = setup(task);
    expect(screen.getByText("The run failed")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: `Actions for ${task.title}` }));
    await user.click(screen.getByRole("menuitem", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith(task, "plain");
  });

  it("offers both the autonomous and the plain retry for permission failures", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", { status: "attention" });
    const { onRetry } = setup(task);
    await user.click(screen.getByRole("button", { name: `Actions for ${task.title}` }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open", "Retry autonomous", "Retry", "Archive"]);
    await user.click(screen.getByRole("menuitem", { name: "Retry autonomous" }));
    expect(onRetry).toHaveBeenCalledWith(task, "autonomous");
    await user.click(screen.getByRole("button", { name: `Actions for ${task.title}` }));
    await user.click(screen.getByRole("menuitem", { name: "Retry" }));
    expect(onRetry).toHaveBeenLastCalledWith(task, "plain");
  });

  it("cancels a running task and does not offer archive", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", { status: "running" });
    const { onCancel } = setup(task);
    await user.click(screen.getByRole("button", { name: `Actions for ${task.title}` }));
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledWith("t1");
  });

  it("archives a finished task when supported, hides it when unsupported or archived", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", { status: "completed" });
    const { onArchive, unmount } = setup(task);
    await user.click(screen.getByRole("button", { name: `Actions for ${task.title}` }));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledWith("t1");
    unmount();
    const unsupported = setup(task, { archiveSupported: false });
    await user.click(screen.getByRole("button", { name: `Actions for ${task.title}` }));
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
    unsupported.unmount();
    setup({ ...task, archivedAt: 5 });
    expect(document.querySelector("article")?.className).toContain("card--archived");
    await user.click(screen.getByRole("button", { name: `Actions for ${task.title}` }));
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
  });

  it("opens the run session and the delegating session from the menu", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", { title: "Linked" });
    const { onOpenSession } = setup(task, { runSession: makeSession("run-session"), origin: { label: "delegated by X", sessionId: "origin-session" } });
    await user.click(screen.getByRole("button", { name: "Actions for Linked" }));
    await user.click(screen.getByRole("menuitem", { name: "Open session" }));
    expect(onOpenSession).toHaveBeenCalledWith("run-session");
    await user.click(screen.getByRole("button", { name: "Actions for Linked" }));
    await user.click(screen.getByRole("menuitem", { name: "Open delegating session" }));
    expect(onOpenSession).toHaveBeenLastCalledWith("origin-session");
  });

  it("selects on click and from the Open menu item", async () => {
    const user = userEvent.setup();
    const { onSelect } = setup(makeTaskRecord("t1", { title: "Pick" }));
    await user.click(screen.getByText("Pick"));
    expect(onSelect).toHaveBeenCalledWith("t1");
    await user.click(screen.getByRole("button", { name: "Actions for Pick" }));
    await user.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("opens the menu at the pointer on right click", () => {
    setup(makeTaskRecord("t1", { title: "Ctx" }));
    fireEvent.contextMenu(screen.getByRole("article"), { clientX: 30, clientY: 40 });
    const menu = screen.getByRole("menu", { name: "Actions for Ctx" });
    expect(menu.style.left).toBe("30px");
    expect(menu.style.top).toBe("40px");
  });

  it("disables the mutating actions while busy", async () => {
    const user = userEvent.setup();
    const task = makeTaskRecord("t1", { status: "failed", title: "Busy" });
    setup(task, { busy: true });
    expect(screen.getByRole("article").getAttribute("aria-busy")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Actions for Busy" }));
    expect((screen.getByRole("menuitem", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "Archive" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("flags the selected and cancelled states", () => {
    setup(makeTaskRecord("t1", { status: "cancelled" }), { selected: true });
    const card = screen.getByRole("article");
    expect(card.className).toContain("card--sel");
    expect(card.className).toContain("card--task-cancelled");
    expect(within(card).getByText("Cancelled")).toBeTruthy();
  });
});
