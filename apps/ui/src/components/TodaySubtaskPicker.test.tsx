import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTodaySubtasks, planTodaySubtask, type TodaySubtaskOption, type TodaySubtaskOptions } from "../delegation";
import { TodaySubtaskPicker } from "./TodaySubtaskPicker";

vi.mock("../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../delegation")>()), getTodaySubtasks: vi.fn(), planTodaySubtask: vi.fn() }));

const option = (id: string, patch: Partial<TodaySubtaskOption> = {}): TodaySubtaskOption => ({
  id,
  projectId: "alpha",
  line: 5,
  raw: `- [ ] ${id}`,
  title: id,
  status: "todo",
  scheduled: null,
  planned: false,
  inToday: false,
  duplicate: false,
  ...patch,
});

const abc = (): TodaySubtaskOption[] => [option("A"), option("B", { line: 6 }), option("C", { line: 7 })];

const target = { projectId: "alpha", line: 3, title: "Parent task" };
const get = vi.mocked(getTodaySubtasks);
const plan = vi.mocked(planTodaySubtask);

interface Call {
  line: number;
  planned: boolean;
  settle: (value: TodaySubtaskOptions | Error) => void;
}

const control = () => {
  const calls: Call[] = [];
  let settled = 0;
  plan.mockImplementation(
    (_date, input) =>
      new Promise<TodaySubtaskOptions>((resolve, reject) => {
        calls.push({ line: input.line, planned: input.planned, settle: (value) => (value instanceof Error ? reject(value) : resolve(value)) });
      }),
  );
  const next = (): Call => {
    const call = calls[settled] as Call;
    settled += 1;
    return call;
  };
  return {
    calls,
    resolveNext: async (listing: string[], planned: string[] = listing) => {
      const subtasks = abc()
        .filter((item) => listing.includes(item.id))
        .map((item) => ({ ...item, inToday: planned.includes(item.id) }));
      await act(async () => {
        next().settle({ parentId: "p", subtasks });
      });
    },
    rejectNext: async (error: Error) => {
      await act(async () => {
        next().settle(error);
      });
    },
  };
};

const renderPicker = () => {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const view = render(<TodaySubtaskPicker date="2026-11-16" target={target} onClose={onClose} onChanged={onChanged} />);
  return { onClose, onChanged, view };
};

const checkedBoxes = () => (screen.getAllByRole("checkbox") as HTMLInputElement[]).map((box) => box.checked);

describe("TodaySubtaskPicker", () => {
  beforeEach(() => {
    get.mockReset();
    plan.mockReset();
  });

  it("loads the subtasks of the parent for the day and shows them", async () => {
    get.mockResolvedValue({ parentId: "p", subtasks: [option("Write tests"), option("Review", { status: "doing" })] });
    renderPicker();
    expect(screen.getByText("Loading...")).toBeTruthy();
    await screen.findByText("Write tests");
    expect(get).toHaveBeenCalledWith("2026-11-16", "alpha", 3);
    expect(screen.getByRole("dialog", { name: "Plan subtasks of Parent task" })).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(document.querySelectorAll(".tag--board-doing")).toHaveLength(1);
  });

  it("shows the empty state when there are no open subtasks", async () => {
    get.mockResolvedValue({ parentId: "p", subtasks: [] });
    renderPicker();
    expect(await screen.findByText("No open subtasks.")).toBeTruthy();
  });

  it("shows the error and an empty list when loading fails", async () => {
    get.mockRejectedValue(new Error("hub down"));
    renderPicker();
    expect((await screen.findByRole("alert")).textContent).toBe("hub down");
    expect(screen.getByText("No open subtasks.")).toBeTruthy();
  });

  it("falls back to a generic message for a non-error rejection", async () => {
    get.mockRejectedValue("nope");
    renderPicker();
    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong");
  });

  it("plans a subtask optimistically, replaces the list and reports the change once", async () => {
    get.mockResolvedValueOnce({ parentId: "p", subtasks: [option("Write tests")] }).mockResolvedValue({ parentId: "p", subtasks: [option("Write tests", { inToday: true })] });
    plan.mockResolvedValue({ parentId: "p", subtasks: [option("Write tests", { inToday: true })] });
    const { onChanged } = renderPicker();
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(plan).toHaveBeenCalledWith("2026-11-16", { projectId: "alpha", line: 5, raw: "- [ ] Write tests", planned: true });
    expect(plan).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("unplans a planned subtask", async () => {
    get.mockResolvedValue({ parentId: "p", subtasks: [option("Write tests", { inToday: true })] });
    plan.mockResolvedValue({ parentId: "p", subtasks: [option("Write tests")] });
    renderPicker();
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(plan).toHaveBeenCalledWith("2026-11-16", expect.objectContaining({ planned: false })));
  });

  it("flips three boxes at once, keeps them enabled, writes in click order and refreshes once", async () => {
    const server = control();
    get.mockResolvedValueOnce({ parentId: "p", subtasks: abc() }).mockResolvedValue({ parentId: "p", subtasks: abc().map((item) => ({ ...item, inToday: true })) });
    const { onChanged } = renderPicker();
    const boxes = await screen.findAllByRole("checkbox");
    fireEvent.click(boxes[2] as HTMLElement);
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[1] as HTMLElement);
    expect(checkedBoxes()).toEqual([true, true, true]);
    expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).every((box) => !box.disabled)).toBe(true);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    expect(server.calls[0]?.line).toBe(7);
    await server.resolveNext(["A", "B", "C"], ["C"]);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    expect(server.calls[1]?.line).toBe(5);
    expect(checkedBoxes()).toEqual([true, true, true]);
    expect(onChanged).not.toHaveBeenCalled();
    await server.resolveNext(["A", "B", "C"], ["A", "C"]);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(3));
    expect(server.calls[2]?.line).toBe(6);
    await server.resolveNext(["A", "B", "C"]);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(checkedBoxes()).toEqual([true, true, true]);
    expect(plan).toHaveBeenCalledTimes(3);
  });

  it("sends no write when the same box is clicked twice before its write runs", async () => {
    get.mockResolvedValue({ parentId: "p", subtasks: [option("A")] });
    const { onChanged } = renderPicker();
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    fireEvent.click(box);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(plan).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("applies the final state when a box is clicked again while its write is in flight", async () => {
    const server = control();
    get.mockResolvedValue({ parentId: "p", subtasks: [option("A")] });
    const { onChanged } = renderPicker();
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    fireEvent.click(box);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    await server.resolveNext(["A"]);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    expect(server.calls.map((call) => call.planned)).toEqual([true, false]);
    await server.resolveNext(["A"], []);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("sends nothing more when a box returns to the confirmed state while its write is in flight", async () => {
    const server = control();
    get.mockResolvedValue({ parentId: "p", subtasks: [option("A")] });
    const { onChanged } = renderPicker();
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    fireEvent.click(box);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    fireEvent.click(box);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    await server.resolveNext(["A"]);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("reverts only the item that failed, shows why and keeps writing the rest", async () => {
    const server = control();
    get.mockResolvedValueOnce({ parentId: "p", subtasks: abc() }).mockResolvedValue({ parentId: "p", subtasks: abc().map((item) => ({ ...item, inToday: item.id !== "B" })) });
    const { onChanged } = renderPicker();
    const boxes = await screen.findAllByRole("checkbox");
    for (const box of boxes) fireEvent.click(box);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    await server.resolveNext(["A", "B", "C"], ["A"]);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    await server.rejectNext(new Error("conflict"));
    expect((await screen.findByRole("alert")).textContent).toBe("conflict");
    expect(checkedBoxes()).toEqual([true, false, true]);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(3));
    expect(server.calls[2]?.line).toBe(7);
    await server.resolveNext(["A", "B", "C"], ["A", "C"]);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(checkedBoxes()).toEqual([true, false, true]);
  });

  it("skips the write for a subtask that left the list while earlier writes ran", async () => {
    const server = control();
    get.mockResolvedValue({ parentId: "p", subtasks: [option("A"), option("B", { line: 6 })] });
    const { onChanged } = renderPicker();
    const boxes = await screen.findAllByRole("checkbox");
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[1] as HTMLElement);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    await server.resolveNext(["A"]);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it("keeps writing after the picker closes and still refreshes the day once", async () => {
    const server = control();
    get.mockResolvedValue({ parentId: "p", subtasks: abc().slice(0, 2) });
    const { onChanged, view } = renderPicker();
    const boxes = await screen.findAllByRole("checkbox");
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(boxes[1] as HTMLElement);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    view.unmount();
    await server.resolveNext(["A", "B"], ["A"]);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    expect(onChanged).not.toHaveBeenCalled();
    await server.resolveNext(["A", "B"]);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(plan).toHaveBeenCalledTimes(2);
  });

  it("stays quiet about failures and reload errors that arrive after the picker closed", async () => {
    const server = control();
    get.mockResolvedValueOnce({ parentId: "p", subtasks: [option("A")] }).mockRejectedValue(new Error("gone"));
    const { onChanged, view } = renderPicker();
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    view.unmount();
    await server.rejectNext(new Error("late"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  const loads = () => {
    const pending: ((value: TodaySubtaskOptions | Error) => void)[] = [];
    get.mockImplementation(
      () =>
        new Promise<TodaySubtaskOptions>((resolve, reject) => {
          pending.push((value) => (value instanceof Error ? reject(value) : resolve(value)));
        }),
    );
    return {
      settle: async (index: number, value: TodaySubtaskOptions | Error) => {
        await act(async () => {
          (pending[index] as (value: TodaySubtaskOptions | Error) => void)(value);
        });
      },
    };
  };

  const listing = (planned: string[], raws: Record<string, string> = {}): TodaySubtaskOptions => ({
    parentId: "p",
    subtasks: abc().map((item) => ({ ...item, inToday: planned.includes(item.id), raw: raws[item.id] ?? item.raw })),
  });

  it("ignores a reload that answers after a newer write already replaced the list", async () => {
    const server = control();
    const reads = loads();
    const { onChanged } = renderPicker();
    await reads.settle(0, listing([]));
    const boxes = await screen.findAllByRole("checkbox");
    fireEvent.click(boxes[0] as HTMLElement);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    await server.resolveNext(["A", "B", "C"], ["A"]);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getAllByRole("checkbox")[1] as HTMLElement);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    const fresh = "- [ ] B \u23f3 2026-11-16";
    await act(async () => {
      server.calls[1]?.settle(listing(["A", "B"], { B: fresh }));
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    await reads.settle(1, listing(["A"]));
    expect(checkedBoxes()).toEqual([true, true, false]);
    fireEvent.click(screen.getAllByRole("checkbox")[1] as HTMLElement);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(3));
    expect(plan).toHaveBeenLastCalledWith("2026-11-16", { projectId: "alpha", line: 6, raw: fresh, planned: false });
    await act(async () => {
      server.calls[2]?.settle(listing(["A"]));
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    await reads.settle(2, listing(["A", "B"], { B: fresh }));
    expect(checkedBoxes()).toEqual([true, false, false]);
    await reads.settle(3, listing(["A"]));
    expect(checkedBoxes()).toEqual([true, false, false]);
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  it("stays quiet when a superseded reload fails", async () => {
    const server = control();
    const reads = loads();
    renderPicker();
    await reads.settle(0, listing([]));
    fireEvent.click((await screen.findAllByRole("checkbox"))[0] as HTMLElement);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
    await server.resolveNext(["A", "B", "C"], ["A"]);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getAllByRole("checkbox")[1] as HTMLElement);
    await waitFor(() => expect(plan).toHaveBeenCalledTimes(2));
    await reads.settle(1, new Error("stale read failed"));
    expect(screen.queryByRole("alert")).toBeNull();
    await server.resolveNext(["A", "B", "C"], ["A", "B"]);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    await reads.settle(2, listing(["A", "B"]));
    expect(checkedBoxes()).toEqual([true, true, false]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("blocks duplicates and explains why", async () => {
    get.mockResolvedValue({ parentId: "p", subtasks: [option("Same", { duplicate: true })] });
    renderPicker();
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/Another subtask has the same title/)).toBeTruthy();
    fireEvent.click(box);
    expect(plan).not.toHaveBeenCalled();
  });

  it("ignores a toggle on a duplicate row even when the input is clicked programmatically", async () => {
    get.mockResolvedValue({ parentId: "p", subtasks: [option("Same", { duplicate: true }), option("Other", { line: 6 })] });
    renderPicker();
    const boxes = (await screen.findAllByRole("checkbox")) as HTMLInputElement[];
    boxes[0]?.removeAttribute("disabled");
    fireEvent.click(boxes[0] as HTMLElement);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(plan).not.toHaveBeenCalled();
  });

  it("closes on Escape, on the overlay and on Done but not inside the dialog", async () => {
    get.mockResolvedValue({ parentId: "p", subtasks: [] });
    const { onClose } = renderPicker();
    await screen.findByText("No open subtasks.");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(document.querySelector(".modal__overlay") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
