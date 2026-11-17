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

const target = { projectId: "alpha", line: 3, title: "Parent task" };
const get = vi.mocked(getTodaySubtasks);
const plan = vi.mocked(planTodaySubtask);

const renderPicker = () => {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(<TodaySubtaskPicker date="2026-11-16" target={target} onClose={onClose} onChanged={onChanged} />);
  return { onClose, onChanged };
};

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

  it("plans a subtask, replaces the list and reports the change", async () => {
    get.mockResolvedValue({ parentId: "p", subtasks: [option("Write tests")] });
    plan.mockResolvedValue({ parentId: "p", subtasks: [option("Write tests", { inToday: true })] });
    const { onChanged } = renderPicker();
    const box = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(plan).toHaveBeenCalledWith("2026-11-16", { projectId: "alpha", line: 5, raw: "- [ ] Write tests", planned: true });
    await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true));
  });

  it("unplans a planned subtask", async () => {
    get.mockResolvedValue({ parentId: "p", subtasks: [option("Write tests", { inToday: true })] });
    plan.mockResolvedValue({ parentId: "p", subtasks: [option("Write tests")] });
    renderPicker();
    fireEvent.click(await screen.findByRole("checkbox"));
    await waitFor(() => expect(plan).toHaveBeenCalledWith("2026-11-16", expect.objectContaining({ planned: false })));
  });

  it("shows the error and reloads the list when planning fails", async () => {
    get.mockResolvedValue({ parentId: "p", subtasks: [option("Write tests")] });
    plan.mockRejectedValue(new Error("conflict"));
    renderPicker();
    fireEvent.click(await screen.findByRole("checkbox"));
    expect((await screen.findByRole("alert")).textContent).toBe("conflict");
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
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

  it("ignores a second toggle while one is in flight", async () => {
    get.mockResolvedValue({ parentId: "p", subtasks: [option("A"), option("B", { line: 6 })] });
    let release: (value: TodaySubtaskOptions) => void = () => undefined;
    plan.mockReturnValue(
      new Promise<TodaySubtaskOptions>((resolve) => {
        release = resolve;
      }),
    );
    renderPicker();
    const boxes = await screen.findAllByRole("checkbox");
    fireEvent.click(boxes[0] as HTMLElement);
    await waitFor(() => expect((screen.getAllByRole("checkbox")[1] as HTMLInputElement).disabled).toBe(true));
    fireEvent.click(screen.getAllByRole("checkbox")[1] as HTMLElement);
    expect(plan).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ parentId: "p", subtasks: [option("A", { inToday: true }), option("B", { line: 6 })] });
    });
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
