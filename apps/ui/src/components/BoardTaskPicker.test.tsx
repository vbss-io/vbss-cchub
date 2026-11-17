import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyFocusDraftItem } from "../daily-plan";
import { getTasksBoard } from "../delegation";
import { makePayload, makeProject, makeTask } from "../test-support/u2-fixtures";
import { BoardTaskPicker } from "./BoardTaskPicker";

vi.mock("../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../delegation")>()), getTasksBoard: vi.fn() }));

const board = vi.mocked(getTasksBoard);

const payload = makePayload({
  projects: [makeProject("alpha", { name: "alpha", title: "Alpha" }), makeProject("beta", { name: "beta", title: "Beta" })],
  tasks: [
    makeTask("t1", { projectId: "alpha", title: "Write tests", status: "todo", priority: 1 }),
    makeTask("t2", { projectId: "alpha", title: "Review PR", status: "doing", line: 2 }),
    makeTask("t3", { projectId: "beta", title: "Plan sprint", status: "todo", line: 1 }),
    makeTask("t4", { projectId: "beta", title: "Hidden blocked", status: "blocked", line: 2 }),
  ],
});

const setup = (props: Partial<Parameters<typeof BoardTaskPicker>[0]> = {}) => {
  const onPick = vi.fn();
  const onPickDoing = vi.fn();
  render(<BoardTaskPicker newItemsText="" carriedItems={[]} wikilinks={false} onPick={onPick} onPickDoing={onPickDoing} {...props} />);
  return { onPick, onPickDoing };
};

beforeEach(() => {
  board.mockReset();
});

describe("BoardTaskPicker", () => {
  it("stays closed without loading until opened", () => {
    setup();
    expect(screen.getByRole("button", { name: "Add from Tasks" }).getAttribute("aria-expanded")).toBe("false");
    expect(board).not.toHaveBeenCalled();
  });

  it("loads the board when opened and lists only To-Do and Doing tasks with their project", async () => {
    const user = userEvent.setup();
    board.mockResolvedValue(payload);
    setup();
    await user.click(screen.getByRole("button", { name: "Add from Tasks" }));
    expect(await screen.findByText("Write tests")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide Tasks" })).toBeTruthy();
    expect(screen.getByText("Review PR")).toBeTruthy();
    expect(screen.getByText("Plan sprint")).toBeTruthy();
    expect(screen.queryByText("Hidden blocked")).toBeNull();
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect(screen.getByText("Doing").className).toContain("tag--board-doing");
  });

  it("shows a loading hint until the board arrives", async () => {
    const user = userEvent.setup();
    let resolve: (value: typeof payload) => void = () => undefined;
    board.mockReturnValue(new Promise((done) => {
      resolve = done;
    }));
    setup();
    await user.click(screen.getByRole("button", { name: "Add from Tasks" }));
    expect(screen.getByText("Loading…")).toBeTruthy();
    resolve(payload);
    expect(await screen.findByText("Write tests")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("filters by project", async () => {
    const user = userEvent.setup();
    board.mockResolvedValue(payload);
    setup();
    await user.click(screen.getByRole("button", { name: "Add from Tasks" }));
    await screen.findByText("Write tests");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by project" }), "beta");
    expect(screen.queryByText("Write tests")).toBeNull();
    expect(screen.getByText("Plan sprint")).toBeTruthy();
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by project" }), "");
    expect(screen.getByText("Write tests")).toBeTruthy();
  });

  it("adds a To-Do task as a new focus item and a Doing task as a carried block", async () => {
    const user = userEvent.setup();
    board.mockResolvedValue(payload);
    const { onPick, onPickDoing } = setup();
    await user.click(screen.getByRole("button", { name: "Add from Tasks" }));
    await screen.findByText("Write tests");
    const todo = screen.getByText("Write tests").closest(".board-picker__row") as HTMLElement;
    await user.click(within(todo).getByRole("button", { name: "Add" }));
    expect(onPick).toHaveBeenCalledWith({ project: "alpha", text: "Write tests" });
    const doing = screen.getByText("Review PR").closest(".board-picker__row") as HTMLElement;
    await user.click(within(doing).getByRole("button", { name: "Add" }));
    expect(onPickDoing).toHaveBeenCalledWith({ project: null, text: "Review PR", block: "- [-] Alpha - Review PR" });
  });

  it("uses wikilinks for the carried block when enabled", async () => {
    const user = userEvent.setup();
    board.mockResolvedValue(payload);
    const { onPickDoing } = setup({ wikilinks: true });
    await user.click(screen.getByRole("button", { name: "Add from Tasks" }));
    await screen.findByText("Review PR");
    await user.click(within(screen.getByText("Review PR").closest(".board-picker__row") as HTMLElement).getByRole("button", { name: "Add" }));
    expect(onPickDoing.mock.calls[0]?.[0].block).toBe("- [-] [[alpha|Alpha]] - Review PR");
  });

  it("marks items already written or already carried as added and disables them", async () => {
    const user = userEvent.setup();
    board.mockResolvedValue(payload);
    const carried: DailyFocusDraftItem[] = [{ project: null, text: "Review PR", block: "- [-] Alpha - Review PR" }];
    setup({ newItemsText: "alpha - Write tests\n", carriedItems: carried });
    await user.click(screen.getByRole("button", { name: "Add from Tasks" }));
    await screen.findByText("Write tests");
    const added = screen.getAllByRole("button", { name: "Added" }) as HTMLButtonElement[];
    expect(added).toHaveLength(2);
    expect(added.every((button) => button.disabled)).toBe(true);
    expect((screen.getByText("Plan sprint").closest(".board-picker__row")?.querySelector("button.act--focus") as HTMLButtonElement).disabled).toBe(false);
  });

  it("explains an empty selection of tasks", async () => {
    const user = userEvent.setup();
    board.mockResolvedValue(makePayload({ projects: payload.projects, tasks: [makeTask("t", { projectId: "alpha", status: "done" })] }));
    setup();
    await user.click(screen.getByRole("button", { name: "Add from Tasks" }));
    expect(await screen.findByText("No To-Do or Doing tasks here.")).toBeTruthy();
  });

  it("points to Settings when the tasks folder is not configured", async () => {
    const user = userEvent.setup();
    board.mockResolvedValue(makePayload({ configured: false }));
    setup();
    await user.click(screen.getByRole("button", { name: "Add from Tasks" }));
    expect(await screen.findByText(/The Tasks folder is not set up yet/)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows the load error", async () => {
    const user = userEvent.setup();
    board.mockRejectedValue(new Error("hub down"));
    setup();
    await user.click(screen.getByRole("button", { name: "Add from Tasks" }));
    expect(await screen.findByText("hub down")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
    const user = userEvent.setup();
    board.mockRejectedValue("nope");
    setup();
    await user.click(screen.getByRole("button", { name: "Add from Tasks" }));
    expect(await screen.findByText("could not load tasks")).toBeTruthy();
  });

  it("ignores a response that arrives after it was closed", async () => {
    const user = userEvent.setup();
    let resolve: (value: typeof payload) => void = () => undefined;
    board.mockReturnValue(new Promise((done) => {
      resolve = done;
    }));
    setup();
    await user.click(screen.getByRole("button", { name: "Add from Tasks" }));
    await user.click(screen.getByRole("button", { name: "Hide Tasks" }));
    resolve(payload);
    await Promise.resolve();
    expect(screen.queryByText("Write tests")).toBeNull();
  });

  it("ignores a late failure after it was closed", async () => {
    const user = userEvent.setup();
    let reject: (reason: unknown) => void = () => undefined;
    board.mockReturnValue(new Promise((_, fail) => {
      reject = fail;
    }));
    setup();
    await user.click(screen.getByRole("button", { name: "Add from Tasks" }));
    await user.click(screen.getByRole("button", { name: "Hide Tasks" }));
    reject(new Error("late"));
    await Promise.resolve();
    board.mockResolvedValue(payload);
    await user.click(screen.getByRole("button", { name: "Add from Tasks" }));
    expect(await screen.findByText("Write tests")).toBeTruthy();
    expect(screen.queryByText("late")).toBeNull();
  });
});
