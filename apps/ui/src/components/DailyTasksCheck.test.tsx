import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyStreamEvent, TasksBoardStreamEvent } from "../api";
import { createBoardItem, getDailyLinks, getTasksBoard, patchBoardItem, syncBoardFromDaily, syncBoardTaskToDaily, type BoardPayload, type DailyLinks } from "../delegation";
import { boardPayload, boardProject, boardTask, DAY, linkItem } from "../test-support/u1-fixtures";
import { makeBus } from "../test-support/u1-mock";
import { DailyTasksCheck } from "./DailyTasksCheck";

vi.mock("../delegation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../delegation")>()),
  getDailyLinks: vi.fn(),
  getTasksBoard: vi.fn(),
  patchBoardItem: vi.fn(),
  syncBoardFromDaily: vi.fn(),
  syncBoardTaskToDaily: vi.fn(),
  createBoardItem: vi.fn(),
}));

const links = vi.mocked(getDailyLinks);
const board = vi.mocked(getTasksBoard);
const patch = vi.mocked(patchBoardItem);
const fromDaily = vi.mocked(syncBoardFromDaily);
const toDaily = vi.mocked(syncBoardTaskToDaily);
const create = vi.mocked(createBoardItem);

const alpha = boardProject("alpha", "Alpha");
const linked = boardTask("t1", "alpha", 7, { title: "Linked task", raw: "- [ ] Linked task", status: "doing" });
const child = boardTask("t2", "alpha", 8, { title: "Sub", raw: "  - [ ] Sub" });

const payload = (): BoardPayload => boardPayload({ projects: [alpha, boardProject("beta", "Beta", { depth: 1 })], tasks: [linked, child] });

const dailyOf = (items: DailyLinks["items"], exists = true): DailyLinks => ({ date: DAY, exists, path: "/d.md", items, taskIds: [] });

const daily = makeBus<DailyStreamEvent>();
const boardBus = makeBus<TasksBoardStreamEvent>();

const mount = (onNotice?: (kind: "ok" | "error", text: string) => void, date = DAY) => {
  const element = (value: string) => <DailyTasksCheck date={value} onNotice={onNotice} subscribeDaily={daily.subscribe} subscribeBoard={boardBus.subscribe} />;
  const view = render(element(date));
  return { ...view, setDate: (value: string) => view.rerender(element(value)) };
};

const event = (date: string): DailyStreamEvent => ({ date, updatedAt: 1, source: "disk", writeId: null });

describe("DailyTasksCheck", () => {
  beforeEach(() => {
    links.mockReset();
    board.mockReset();
    patch.mockReset();
    fromDaily.mockReset();
    toDaily.mockReset();
    create.mockReset();
    board.mockResolvedValue(payload());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the links and the board for the date and shows a loading state first", async () => {
    links.mockResolvedValue(dailyOf([linkItem({ text: "Linked task", taskId: "t1", taskStatus: "doing", taskPriority: 1, projectId: "alpha" })]));
    mount();
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(await screen.findByText("Everything is in sync.")).toBeTruthy();
    expect(links).toHaveBeenCalledWith(DAY);
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(document.querySelector(".tag--board-doing")?.textContent).toBe("Doing");
    expect(document.querySelector(".board-prio")).not.toBeNull();
  });

  it("shows the empty states", async () => {
    links.mockResolvedValueOnce(dailyOf([], false));
    const view = mount();
    expect(await screen.findByText(`No entry yet for ${DAY}.`)).toBeTruthy();
    links.mockResolvedValueOnce(dailyOf([]));
    view.setDate("2026-11-17");
    expect(await screen.findByText("No focus items to check.")).toBeTruthy();
  });

  it("shows the load error", async () => {
    links.mockRejectedValue(new Error("hub down"));
    mount();
    expect((await screen.findByText("hub down")).className).toContain("error");
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("uses a generic message when the load rejection is not an error", async () => {
    links.mockRejectedValue("x");
    mount();
    expect(await screen.findByText("could not check the tasks")).toBeTruthy();
  });

  it("counts items missing from Tasks and out of sync", async () => {
    links.mockResolvedValue(
      dailyOf([
        linkItem({ line: 1, text: "Missing one" }),
        linkItem({ line: 2, text: "Linked task", taskId: "t1", taskStatus: "todo", mismatch: true }),
        linkItem({ line: 3, text: "Dup", candidates: ["t1", "ghost"] }),
      ]),
    );
    mount();
    expect(await screen.findByText("1 not in Tasks, 1 out of sync")).toBeTruthy();
    expect(screen.getByText("Multiple matches")).toBeTruthy();
    expect(screen.getByText("Alpha: Linked task")).toBeTruthy();
    expect(screen.getByText("ghost")).toBeTruthy();
  });

  it("applies the daily to the board and reloads", async () => {
    links.mockResolvedValue(dailyOf([linkItem({ line: 2, text: "Linked task", taskId: "t1", taskStatus: "todo", mismatch: true })]));
    fromDaily.mockResolvedValue({ date: DAY, updated: 1 });
    const onNotice = vi.fn();
    mount(onNotice);
    fireEvent.click(await screen.findByRole("button", { name: "Use daily" }));
    await waitFor(() => expect(fromDaily).toHaveBeenCalledWith(2, DAY));
    await waitFor(() => expect(links).toHaveBeenCalledTimes(2));
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("notifies the failed tasks of an apply", async () => {
    links.mockResolvedValue(dailyOf([linkItem({ line: 2, text: "Linked task", taskId: "t1", taskStatus: "todo", mismatch: true })]));
    fromDaily.mockResolvedValue({ date: DAY, updated: 2, failed: [{ taskId: "t9", error: "gone" }] });
    const onNotice = vi.fn();
    mount(onNotice);
    fireEvent.click(await screen.findByRole("button", { name: "Use daily" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("error", "2 updated, 1 could not be synced - t9: gone"));
  });

  it("writes the board status into the daily", async () => {
    links.mockResolvedValue(dailyOf([linkItem({ line: 2, text: "Linked task", taskId: "t1", taskStatus: "doing", mismatch: true })]));
    toDaily.mockResolvedValue({ date: DAY, updated: 1 });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Use board" }));
    await waitFor(() => expect(toDaily).toHaveBeenCalledWith({ projectId: "alpha", line: 7, raw: "- [ ] Linked task" }, DAY));
  });

  it("disables the use-board button when the linked task is not on the board", async () => {
    links.mockResolvedValue(dailyOf([linkItem({ line: 2, text: "Gone", taskId: "t1", taskStatus: "doing", mismatch: true })]));
    board.mockResolvedValue(boardPayload({ projects: [alpha], tasks: [] }));
    mount();
    const button = await screen.findByRole("button", { name: "Use board" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Use daily" })).toBeTruthy();
  });

  it("syncs a mismatched subtask to the board with the checkbox status", async () => {
    links.mockResolvedValue(
      dailyOf([
        linkItem({
          line: 2,
          text: "Linked task",
          taskId: "t1",
          taskStatus: "todo",
          mismatch: true,
          children: [
            { line: 3, raw: "  - [x] Sub", checkbox: "done", text: "Sub", taskId: "t2", taskStatus: "todo", mismatch: true },
            { line: 4, raw: "  - [-] Loose", checkbox: "doing", text: "Loose", taskId: null, taskStatus: null, mismatch: false },
          ],
        }),
      ]),
    );
    patch.mockResolvedValue({ task: child, updatedAt: 1, moved: false });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ projectId: "alpha", line: 8, raw: "  - [ ] Sub" }, { status: "done" }));
    expect(screen.getByText("[x]")).toBeTruthy();
    expect(screen.getByText("Not in Tasks")).toBeTruthy();
  });

  it("reports a subtask that is no longer on the board", async () => {
    links.mockResolvedValue(
      dailyOf([
        linkItem({
          line: 2,
          text: "Linked task",
          taskId: "t1",
          mismatch: true,
          children: [{ line: 3, raw: "  - [x] Sub", checkbox: "done", text: "Sub", taskId: "t2", taskStatus: "todo", mismatch: true }],
        }),
      ]),
    );
    board.mockResolvedValue(boardPayload({ projects: [alpha], tasks: [linked] }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    expect(await screen.findByText("That subtask is no longer on the board.")).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });

  it("freezes a recurring task finished today: no sync buttons and a label", async () => {
    links.mockResolvedValue(
      dailyOf([
        linkItem({
          line: 2,
          text: "Linked task",
          taskId: "t1",
          taskStatus: "todo",
          mismatch: true,
          recurredToday: true,
          children: [{ line: 3, raw: "  - [x] Sub", checkbox: "done", text: "Sub", taskId: "t2", taskStatus: "todo", mismatch: true }],
        }),
      ]),
    );
    mount();
    expect(await screen.findByText("recurring - done today")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sync" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use daily" })).toBeNull();
  });

  it("adds a missing item to Tasks in the chosen project", async () => {
    links.mockResolvedValue(dailyOf([linkItem({ line: 5, text: "Brand new", checkbox: "doing" })]));
    create.mockResolvedValue({ task: child, updatedAt: 1 });
    mount();
    const row = within((await screen.findByText("Brand new")).closest("li") as HTMLElement);
    const add = row.getByRole("button", { name: "Add to Tasks" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(row.getByLabelText("Project for Brand new"), { target: { value: "beta" } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(create).toHaveBeenCalledWith({ projectId: "beta", title: "Brand new", status: "doing" }));
  });

  it("preselects the project of the item when it is known", async () => {
    links.mockResolvedValue(dailyOf([linkItem({ line: 5, text: "Brand new", projectId: "alpha", label: "Alpha" })]));
    mount();
    const select = (await screen.findByLabelText("Project for Brand new")) as HTMLSelectElement;
    expect(select.value).toBe("alpha");
  });

  it("shows an action error and reloads the links", async () => {
    links.mockResolvedValueOnce(dailyOf([linkItem({ line: 5, text: "Brand new", projectId: "alpha" })]));
    links.mockReturnValue(new Promise(() => undefined));
    create.mockRejectedValue(new Error("write failed"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Add to Tasks" }));
    expect(await screen.findByText("write failed")).toBeTruthy();
    expect(links).toHaveBeenCalledTimes(2);
  });

  it("uses a generic message for a non-error action failure", async () => {
    links.mockResolvedValueOnce(dailyOf([linkItem({ line: 5, text: "Brand new", projectId: "alpha" })]));
    links.mockReturnValue(new Promise(() => undefined));
    create.mockRejectedValue("x");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Add to Tasks" }));
    expect(await screen.findByText("could not update the task")).toBeTruthy();
  });

  it("marks the row busy while an action runs", async () => {
    links.mockResolvedValue(dailyOf([linkItem({ line: 5, text: "Brand new", projectId: "alpha" })]));
    let release: () => void = () => undefined;
    create.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ task: child, updatedAt: 1 });
      }),
    );
    mount();
    const add = await screen.findByRole("button", { name: "Add to Tasks" });
    fireEvent.click(add);
    await waitFor(() => expect((screen.getByRole("button", { name: "Add to Tasks" }) as HTMLButtonElement).disabled).toBe(true));
    await act(async () => release());
    await waitFor(() => expect((screen.getByRole("button", { name: "Add to Tasks" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("refreshes after a debounce when the daily of this date or the board changes", async () => {
    links.mockResolvedValue(dailyOf([]));
    mount();
    await screen.findByText("No focus items to check.");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => daily.emit(event("2026-01-01")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(links).toHaveBeenCalledTimes(1);
    act(() => daily.emit(event(DAY)));
    act(() => daily.emit(event(DAY)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(links).toHaveBeenCalledTimes(2);
    act(() => boardBus.emit({ source: "disk", projectId: "alpha" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(links).toHaveBeenCalledTimes(3);
  });

  it("unsubscribes and drops a pending refresh on unmount", async () => {
    links.mockResolvedValue(dailyOf([]));
    const view = mount();
    await screen.findByText("No focus items to check.");
    expect(daily.listeners()).toBe(1);
    expect(boardBus.listeners()).toBe(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => boardBus.emit({ source: "hub", projectId: "alpha" }));
    view.unmount();
    expect(daily.listeners()).toBe(0);
    expect(boardBus.listeners()).toBe(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(links).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale response after the date changed", async () => {
    let releaseFirst: (value: DailyLinks) => void = () => undefined;
    links.mockReturnValueOnce(
      new Promise<DailyLinks>((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const view = mount();
    links.mockResolvedValueOnce(dailyOf([linkItem({ text: "Fresh" })]));
    view.setDate("2026-11-17");
    expect(await screen.findByText("Fresh")).toBeTruthy();
    await act(async () => releaseFirst(dailyOf([linkItem({ text: "Stale" })])));
    expect(screen.queryByText("Stale")).toBeNull();
  });

  it("ignores a stale failure after the date changed", async () => {
    let rejectFirst: (reason: Error) => void = () => undefined;
    links.mockReturnValueOnce(
      new Promise<DailyLinks>((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    const view = mount();
    links.mockResolvedValueOnce(dailyOf([linkItem({ text: "Fresh" })]));
    view.setDate("2026-11-17");
    await screen.findByText("Fresh");
    await act(async () => rejectFirst(new Error("late")));
    expect(screen.queryByText("late")).toBeNull();
  });
});
