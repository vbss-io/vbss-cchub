import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW, makeRun, makeWorktree } from "../test-support/u2-task-fixtures";
import type { LogLine } from "../use-task-detail";
import { LiveLog, RunCard, WorktreePanel, mergeHint } from "./TaskDetailParts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const line = (key: string, kind: LogLine["kind"], text: string): LogLine => ({ key, kind, text });

const scrollMetrics = (element: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) => {
  let top = metrics.scrollTop;
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
};

describe("LiveLog", () => {
  it("waits for output while running and reports an empty finished run", () => {
    const { rerender, container } = render(<LiveLog lines={[]} running />);
    expect(screen.getByText("Waiting for the first output…")).toBeTruthy();
    expect(container.querySelector(".log__cursor")).not.toBeNull();
    rerender(<LiveLog lines={[]} running={false} />);
    expect(screen.getByText("No output was captured for this run.")).toBeTruthy();
    expect(container.querySelector(".log__cursor")).toBeNull();
  });

  it("renders each line with its kind and a badge for tool and status lines", () => {
    const { container } = render(<LiveLog lines={[line("1", "text", "hello"), line("2", "tool", "Read file"), line("3", "status", "done")]} running={false} />);
    expect(container.querySelectorAll(".log__line")).toHaveLength(3);
    expect(container.querySelector(".log__line--text .log__text")?.textContent).toBe("hello");
    expect(within(container.querySelector(".log__line--tool") as HTMLElement).getByText("tool")).toBeTruthy();
    expect(within(container.querySelector(".log__line--status") as HTMLElement).getByText("status").className).toContain("log__badge--status");
    expect(container.querySelector(".log__line--text .log__badge")).toBeNull();
  });

  it("windows very long logs to the latest lines and reveals earlier ones on demand", async () => {
    const user = userEvent.setup();
    const lines = Array.from({ length: 1200 }, (_, index) => line(String(index), "text", `row ${index}`));
    const { container } = render(<LiveLog lines={lines} running={false} />);
    expect(container.querySelectorAll(".log__line")).toHaveLength(500);
    expect(screen.queryByText("row 0")).toBeNull();
    expect(screen.getByText("row 1199")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Show earlier \(\+700 lines\)/ }));
    expect(container.querySelectorAll(".log__line")).toHaveLength(1200);
    expect(screen.getByText("row 0")).toBeTruthy();
  });

  it("can reveal everything at once", async () => {
    const user = userEvent.setup();
    const lines = Array.from({ length: 700 }, (_, index) => line(String(index), "text", `row ${index}`));
    const { container } = render(<LiveLog lines={lines} running={false} />);
    await user.click(screen.getByRole("button", { name: /Show all/ }));
    expect(container.querySelectorAll(".log__line")).toHaveLength(700);
  });

  it("follows new output while pinned to the bottom and stops once the user scrolls up", () => {
    const first = [line("1", "text", "a")];
    const { container, rerender } = render(<LiveLog lines={first} running />);
    const log = container.querySelector(".log") as HTMLElement;
    scrollMetrics(log, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    rerender(<LiveLog lines={[...first, line("2", "text", "b")]} running />);
    expect(log.scrollTop).toBe(1000);
    fireEvent.scroll(log, { target: { scrollTop: 100 } });
    rerender(<LiveLog lines={[...first, line("2", "text", "b"), line("3", "text", "c")]} running />);
    expect(log.scrollTop).toBe(100);
    fireEvent.scroll(log, { target: { scrollTop: 790 } });
    rerender(<LiveLog lines={[...first, line("2", "text", "b"), line("3", "text", "c"), line("4", "text", "d")]} running />);
    expect(log.scrollTop).toBe(1000);
  });
});

describe("RunCard", () => {
  it("shows the run header with model, permission, cost and relative time", () => {
    const run = makeRun("r1", "t1", { seq: 2, kind: "continue", status: "failed", runner: "codex", effectiveModel: "gpt-x", permissionMode: "plan", costUsd: 0.5, tokensIn: null, tokensOut: null, prompt: "Run it", error: "it broke", result: "**done**" });
    const { container } = render(<RunCard run={run} />);
    expect(screen.getByText("#2 · continue")).toBeTruthy();
    expect(container.querySelector("[data-status='failed']")?.textContent).toBe("Failed");
    expect(screen.getByText("codex")).toBeTruthy();
    expect(screen.getByText("gpt-x")).toBeTruthy();
    expect(screen.getByText("plan")).toBeTruthy();
    expect(screen.getByText("$0.50")).toBeTruthy();
    expect(screen.getByText("Run it")).toBeTruthy();
    expect(screen.getByText("it broke")).toBeTruthy();
    expect(container.querySelector(".run__result strong")?.textContent).toBe("done");
    expect(container.querySelector("time")?.textContent).toBe("33m ago");
  });

  it("omits optional parts when absent and uses the start time for running runs", () => {
    const run = makeRun("r1", "t1", { status: "running", finishedAt: null });
    const { container } = render(<RunCard run={run} />);
    expect(container.querySelector(".run__result")).toBeNull();
    expect(container.querySelector(".run__error")).toBeNull();
    expect(container.querySelectorAll(".chip")).toHaveLength(1);
    expect(container.querySelector("time")?.textContent).toBe("50m ago");
  });
});

describe("mergeHint", () => {
  it("explains why a merge is unavailable, or the merge command", () => {
    expect(mergeHint(makeWorktree(), true)).toBe("Wait for the run to finish");
    expect(mergeHint(makeWorktree({ mergedAt: 5 }), false)).toBe("Already merged");
    expect(mergeHint(makeWorktree({ dirty: true }), false)).toBe("Commit the pending changes first");
    expect(mergeHint(makeWorktree({ commits: [] }), false)).toBe("Nothing to merge");
    expect(mergeHint(makeWorktree(), false)).toBe("git merge --no-ff task/t1 into main");
  });
});

describe("WorktreePanel", () => {
  const setup = (worktree = makeWorktree(), props: Partial<Parameters<typeof WorktreePanel>[0]> = {}) => {
    const handlers = { onConfirmDiscard: vi.fn(), onDiscard: vi.fn(), onMerge: vi.fn() };
    render(<WorktreePanel worktree={worktree} busy={false} running={false} canMerge confirmDiscard={false} {...handlers} {...props} />);
    return handlers;
  };

  it("reports an unavailable status", () => {
    setup(null as never);
    expect(screen.getByText("Worktree status unavailable.")).toBeTruthy();
  });

  it("lists branch, commits and the diff stat, and merges", async () => {
    const user = userEvent.setup();
    const { onMerge } = setup(makeWorktree({ diffStat: " a.ts | 2 +-" }));
    expect(screen.getByText("task/t1").tagName).toBe("CODE");
    expect(screen.getByText("abcdef1")).toBeTruthy();
    expect(screen.getByText(/Add feature/)).toBeTruthy();
    expect(screen.getByText("a.ts | 2 +-", { exact: false }).tagName).toBe("PRE");
    const merge = screen.getByRole("button", { name: "Merge into main" }) as HTMLButtonElement;
    expect(merge.title).toBe("git merge --no-ff task/t1 into main");
    await user.click(merge);
    expect(onMerge).toHaveBeenCalledTimes(1);
  });

  it("shows the hint only while unmerged", () => {
    const { unmount } = render(<WorktreePanel worktree={makeWorktree({ hint: "Rebase first" })} busy={false} running={false} canMerge confirmDiscard={false} onConfirmDiscard={() => undefined} onDiscard={() => undefined} onMerge={() => undefined} />);
    expect(screen.getByText("Rebase first")).toBeTruthy();
    unmount();
    setup(makeWorktree({ hint: "Rebase first", mergedAt: NOW - 120_000 }));
    expect(screen.queryByText("Rebase first")).toBeNull();
  });

  it("reports a merged worktree and suggests discarding the folder when it still exists", () => {
    setup(makeWorktree({ mergedAt: NOW - 120_000 }));
    expect(screen.getByText(/Merged into main 2m ago\. Discard the worktree/)).toBeTruthy();
  });

  it("reports a merged and already discarded worktree", () => {
    setup(makeWorktree({ mergedAt: NOW - 120_000, path: null, exists: false }));
    expect(screen.getByText(/Merged into main 2m ago\.$/)).toBeTruthy();
    expect(screen.getByText(/worktree discarded/)).toBeTruthy();
  });

  it("notes a removed folder and a discarded worktree", () => {
    const { unmount } = render(<WorktreePanel worktree={makeWorktree({ exists: false })} busy={false} running={false} canMerge={false} confirmDiscard={false} onConfirmDiscard={() => undefined} onDiscard={() => undefined} onMerge={() => undefined} />);
    expect(screen.getByText(/folder removed/)).toBeTruthy();
    unmount();
    setup(makeWorktree({ path: null, exists: false }), { canMerge: false });
    expect(screen.getByText(/worktree discarded/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discard worktree" })).toBeNull();
  });

  it("warns about uncommitted changes and about an empty branch", () => {
    const { unmount } = render(<WorktreePanel worktree={makeWorktree({ dirty: true })} busy={false} running={false} canMerge={false} confirmDiscard={false} onConfirmDiscard={() => undefined} onDiscard={() => undefined} onMerge={() => undefined} />);
    expect(screen.getByText(/Uncommitted changes in the worktree/)).toBeTruthy();
    unmount();
    setup(makeWorktree({ commits: [] }), { canMerge: false });
    expect(screen.getByText("No commits on the branch yet.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Merge into main" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for confirmation before discarding and can back out", async () => {
    const user = userEvent.setup();
    const { onConfirmDiscard } = setup();
    await user.click(screen.getByRole("button", { name: "Discard worktree" }));
    expect(onConfirmDiscard).toHaveBeenCalledWith(true);
  });

  it("confirms the discard, naming the loss of unmerged work", async () => {
    const user = userEvent.setup();
    const { onConfirmDiscard, onDiscard } = setup(makeWorktree(), { confirmDiscard: true });
    expect(screen.getByText("Removes the folder and the branch, losing unmerged work.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discard worktree" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(onConfirmDiscard).toHaveBeenCalledWith(false);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("does not claim lost work when the branch was merged", () => {
    setup(makeWorktree({ mergedAt: NOW - 60_000 }), { confirmDiscard: true });
    expect(screen.getByText("Removes the folder and the branch.")).toBeTruthy();
  });

  it("disables the actions while busy or running", () => {
    setup(makeWorktree(), { busy: true });
    expect((screen.getByRole("button", { name: "Discard worktree" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Merge into main" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables discard and merge while the run is in flight", () => {
    setup(makeWorktree(), { running: true, confirmDiscard: true });
    expect((screen.getByRole("button", { name: "Discard" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Keep" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
