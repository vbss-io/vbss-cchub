import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BoardConflictError } from "../delegation";
import { api, makeBoardPayload, makeBoardTasks, renderBoard, resetApi } from "../test-support/u2-board-view";

vi.mock("../delegation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../delegation")>()),
  getTasksBoard: vi.fn(),
  patchBoardItem: vi.fn(),
  createBoardItem: vi.fn(),
  addBoardNote: vi.fn(),
  editBoardNote: vi.fn(),
  deleteBoardNote: vi.fn(),
  sweepBoardDone: vi.fn(),
  addBoardTaskToDaily: vi.fn(),
  syncBoardTaskToDaily: vi.fn(),
  delegateBoardTask: vi.fn(),
  moveBoardItem: vi.fn(),
  reparentBoardTask: vi.fn(),
  moveBoardTaskToProject: vi.fn(),
  openBoardProjectInEditor: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("../notify", async (importOriginal) => ({ ...(await importOriginal<typeof import("../notify")>()), openExternal: vi.fn(() => Promise.resolve()) }));

const useView = (view: "table" | "timeline" | "kanban", extra: Record<string, unknown> = {}) => window.localStorage.setItem("hub.board.prefs", JSON.stringify({ view, ...extra }));

const rowOf = (title: string): HTMLElement => screen.getByText(title, { selector: ".board-table__task, .board-table__task *" }).closest("tr") as HTMLElement;

beforeEach(() => {
  resetApi();
  window.localStorage.clear();
  api.patch.mockImplementation((target) => Promise.resolve({ task: makeBoardTasks().find((task) => task.line === target.line && task.projectId === target.projectId) ?? makeBoardTasks()[0]!, updatedAt: 1, moved: false }));
  api.moveToProject.mockResolvedValue({ task: makeBoardTasks()[0]! });
});

describe("BoardView table", () => {
  it("lists tasks grouped by project with their fields", async () => {
    useView("table");
    renderBoard();
    await screen.findByRole("table");
    expect(screen.getByText("Platform", { selector: ".board-group__name" })).toBeTruthy();
    expect(screen.getByText("Platform › API", { selector: ".board-group__name" })).toBeTruthy();
    const row = rowOf("Write spec");
    expect(within(row).getByText("P0")).toBeTruthy();
    expect(within(row).getByText("To-Do")).toBeTruthy();
    expect(within(row).getByText("01/01").className).toContain("board-due--overdue");
    expect(within(row).getByText("1/2")).toBeTruthy();
    expect(within(row).getByText("Today · out of sync")).toBeTruthy();
    expect(within(rowOf("Build API")).getByText("10/11")).toBeTruthy();
    expect(within(rowOf("Waiting")).getByText("vendor")).toBeTruthy();
    expect(within(rowOf("Shipped")).getByText("Done 2026-11-10")).toBeTruthy();
    expect(within(rowOf("Plain task")).getAllByText("-").length).toBeGreaterThanOrEqual(3);
  });

  it("shows a repeat mark for recurring tasks", async () => {
    useView("table");
    const tasks = makeBoardTasks();
    tasks[0] = { ...tasks[0]!, repeat: "every week" };
    renderBoard({ payload: makeBoardPayload({ tasks }) });
    await screen.findByRole("table");
    expect(within(rowOf("Write spec")).getByRole("img", { name: "Repeats: every week" })).toBeTruthy();
  });

  it("sorts by a header and toggles the direction", async () => {
    const user = userEvent.setup();
    useView("table");
    renderBoard();
    await screen.findByRole("table");
    const header = screen.getByRole("columnheader", { name: /Task/ });
    expect(header.getAttribute("aria-sort")).toBe("none");
    await user.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    await user.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(JSON.parse(window.localStorage.getItem("hub.board.prefs") ?? "{}").tableSort).toEqual({ key: "title", dir: "desc" });
  });

  it("collapses and expands a project group", async () => {
    const user = userEvent.setup();
    useView("table");
    renderBoard();
    await screen.findByRole("table");
    const toggle = screen.getByText("Garden", { selector: ".board-group__name" }).closest("button") as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Parked")).toBeNull();
    await user.click(toggle);
    expect(screen.getByText("Parked")).toBeTruthy();
  });

  it("opens the drawer from a row click and Enter but not from its controls", async () => {
    const user = userEvent.setup();
    useView("table");
    renderBoard();
    await screen.findByRole("table");
    await user.click(within(rowOf("Write spec")).getByRole("checkbox", { name: "Select Write spec" }));
    expect(screen.queryByRole("dialog", { name: /Details of/ })).toBeNull();
    await user.click(screen.getByText("Waiting"));
    expect(screen.getByRole("dialog", { name: "Details of Waiting" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close details" }));
    const row = rowOf("Plain task");
    row.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Details of Plain task" })).toBeTruthy();
  });

  it("does not open the drawer when a key is pressed inside a row control or text is selected", async () => {
    const user = userEvent.setup();
    useView("table");
    renderBoard();
    await screen.findByRole("table");
    fireEvent.keyDown(within(rowOf("Plain task")).getByRole("checkbox"), { key: "Enter" });
    fireEvent.keyDown(rowOf("Plain task"), { key: "x" });
    expect(screen.queryByRole("dialog", { name: /Details of/ })).toBeNull();
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "chosen" } as Selection);
    await user.click(screen.getByText("Plain task"));
    expect(screen.queryByRole("dialog", { name: /Details of/ })).toBeNull();
    selection.mockRestore();
  });

  it("expands subtasks and notes under a row", async () => {
    const user = userEvent.setup();
    useView("table");
    renderBoard();
    await screen.findByRole("table");
    await user.click(within(rowOf("Write spec")).getByRole("button", { name: "Show details of Write spec" }));
    expect(screen.getByText("spec note")).toBeTruthy();
    expect(screen.getByText("Sub A")).toBeTruthy();
    await user.click(within(rowOf("Write spec")).getByRole("button", { name: "Hide details of Write spec" }));
    expect(screen.queryByText("spec note")).toBeNull();
  });

  it("changes a task status from the row menu with the API call", async () => {
    const user = userEvent.setup();
    useView("table");
    renderBoard();
    await screen.findByRole("table");
    await user.click(within(rowOf("Plain task")).getByRole("button", { name: "Actions for Plain task" }));
    await user.click(screen.getByRole("menuitem", { name: "Move to Doing" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith({ projectId: "p3", line: 3, raw: "- [ ] Plain task" }, { status: "doing" }));
  });

  it("pages through done tasks", async () => {
    const user = userEvent.setup();
    useView("table");
    const done = Array.from({ length: 12 }, (_, index) => ({ ...makeBoardTasks()[3]!, id: `d${index}`, title: `Done ${index}`, line: 100 + index, raw: `- [x] Done ${index}`, doneAt: `2026-10-${String(10 + index).padStart(2, "0")}` }));
    renderBoard({ payload: makeBoardPayload({ tasks: done }) });
    await screen.findByRole("table");
    expect(screen.queryByText("Done 0")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show more done tasks (2)" }));
    expect(screen.getByText("Done 0")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByText("Done 0")).toBeNull();
  });
});

describe("BoardView bulk actions", () => {
  const pick = async (user: ReturnType<typeof userEvent.setup>, ...titles: string[]) => {
    for (const title of titles) await user.click(screen.getByRole("checkbox", { name: `Select ${title}` }));
  };

  it("shows the bulk bar for the selection and clears it", async () => {
    const user = userEvent.setup();
    useView("table");
    renderBoard();
    await screen.findByRole("table");
    expect(screen.queryByRole("toolbar", { name: "Bulk actions" })).toBeNull();
    await pick(user, "Write spec", "Waiting");
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Select all tasks" }) as HTMLInputElement).indeterminate).toBe(true);
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("toolbar", { name: "Bulk actions" })).toBeNull();
  });

  it("selects and deselects every visible row", async () => {
    const user = userEvent.setup();
    useView("table");
    renderBoard();
    await screen.findByRole("table");
    const all = screen.getByRole("checkbox", { name: "Select all tasks" }) as HTMLInputElement;
    await user.click(all);
    expect(all.checked).toBe(true);
    expect(screen.getByText("6 selected")).toBeTruthy();
    await user.click(all);
    expect(screen.queryByRole("toolbar", { name: "Bulk actions" })).toBeNull();
  });

  it("applies a status to the selected tasks one by one and reports it", async () => {
    const user = userEvent.setup();
    useView("table");
    const { onNotice } = renderBoard();
    await screen.findByRole("table");
    await pick(user, "Write spec", "Waiting");
    await user.selectOptions(screen.getByRole("combobox", { name: "Set status" }), "doing");
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Set Doing on 2 tasks"));
    expect(api.patch).toHaveBeenCalledWith({ projectId: "p1", line: 3, raw: "- [ ] Write spec" }, { status: "doing" });
    expect(api.patch).toHaveBeenCalledWith({ projectId: "p1", line: 10, raw: "- [ ] Waiting" }, { status: "doing" });
    await waitFor(() => expect(screen.queryByRole("toolbar", { name: "Bulk actions" })).toBeNull());
  });

  it("sets and clears the priority in bulk", async () => {
    const user = userEvent.setup();
    useView("table");
    const { onNotice } = renderBoard();
    await screen.findByRole("table");
    await pick(user, "Plain task");
    await user.selectOptions(screen.getByRole("combobox", { name: "Set priority" }), "2");
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Set P2 on 1 task"));
    expect(api.patch).toHaveBeenCalledWith(expect.objectContaining({ line: 3 }), { priority: 2 });
    await pick(user, "Write spec");
    await user.selectOptions(screen.getByRole("combobox", { name: "Set priority" }), "none");
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Cleared the priority of 1 task"));
  });

  it("moves the selection to another project", async () => {
    const user = userEvent.setup();
    useView("table");
    const { onNotice } = renderBoard();
    await screen.findByRole("table");
    await pick(user, "Plain task");
    await user.selectOptions(screen.getByRole("combobox", { name: "Move to project" }), "p1");
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Moved 1 task to Platform"));
    expect(api.moveToProject).toHaveBeenCalledWith({ projectId: "p3", line: 3, raw: "- [ ] Plain task" }, "p1", null);
  });

  it("asks for confirmation before archiving and can be cancelled", async () => {
    const user = userEvent.setup();
    useView("table");
    const { onNotice } = renderBoard();
    await screen.findByRole("table");
    await pick(user, "Plain task");
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByRole("dialog", { name: "Archive 1 task?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.patch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(within(screen.getByRole("dialog", { name: "Archive 1 task?" })).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Archived 1 task"));
    expect(api.patch).toHaveBeenCalledWith(expect.objectContaining({ line: 3 }), { status: "archived" });
  });

  it("pluralizes the archive confirmation", async () => {
    const user = userEvent.setup();
    useView("table");
    renderBoard();
    await screen.findByRole("table");
    await pick(user, "Plain task", "Parked");
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByRole("dialog", { name: "Archive 2 tasks?" })).toBeTruthy();
  });

  it("reports when nothing needs to change", async () => {
    const user = userEvent.setup();
    useView("table");
    const { onNotice } = renderBoard();
    await screen.findByRole("table");
    await pick(user, "Plain task");
    await user.selectOptions(screen.getByRole("combobox", { name: "Set status" }), "todo");
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Nothing to change on the selected tasks"));
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("skips finished occurrences and keeps them selected", async () => {
    const user = userEvent.setup();
    useView("table");
    const tasks = makeBoardTasks();
    tasks[3] = { ...tasks[3]!, repeat: "every week" };
    const { onError } = renderBoard({ payload: makeBoardPayload({ tasks }) });
    await screen.findByRole("table");
    await pick(user, "Shipped");
    await user.selectOptions(screen.getByRole("combobox", { name: "Set status" }), "doing");
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('"Shipped" (finished occurrence, edit it in Obsidian)')));
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("reports conflicts, refreshes and keeps the unprocessed task selected", async () => {
    const user = userEvent.setup();
    useView("table");
    api.patch.mockRejectedValueOnce(new BoardConflictError("changed on disk", null));
    const { onError } = renderBoard();
    await screen.findByRole("table");
    await pick(user, "Plain task");
    await user.selectOptions(screen.getByRole("combobox", { name: "Set status" }), "doing");
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("The board was refreshed.")));
    await waitFor(() => expect(screen.getByText("1 selected")).toBeTruthy());
  });

  it("clears the selection when leaving the table layout", async () => {
    const user = userEvent.setup();
    useView("table");
    renderBoard();
    await screen.findByRole("table");
    await pick(user, "Plain task");
    await user.click(screen.getByRole("button", { name: "Kanban" }));
    await user.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.queryByRole("toolbar", { name: "Bulk actions" })).toBeNull();
  });
});

describe("BoardView timeline", () => {
  it("shows the timeline with zoom controls and opens a task from it", async () => {
    const user = userEvent.setup();
    useView("timeline");
    renderBoard();
    await screen.findByRole("group", { name: "Task timeline" });
    expect(screen.getByRole("button", { name: "Month" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Week" }));
    expect(screen.getByRole("button", { name: "Week" }).getAttribute("aria-pressed")).toBe("true");
    expect(JSON.parse(window.localStorage.getItem("hub.board.prefs") ?? "{}").timelineZoom).toBe("week");
    await user.click(screen.getByRole("button", { name: "Quarter" }));
    expect(screen.getByRole("button", { name: "Quarter" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: /^Open details of Build API/ }));
    expect(screen.getByRole("dialog", { name: "Details of Build API" })).toBeTruthy();
  });

  it("jumps to today and toggles groups and the undated list", async () => {
    const user = userEvent.setup();
    useView("timeline");
    renderBoard();
    await screen.findByRole("group", { name: "Task timeline" });
    await user.click(screen.getByRole("button", { name: "Today" }));
    const group = screen.getByText("Platform", { selector: ".board-group__name" }).closest("button") as HTMLElement;
    await user.click(group);
    expect(group.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /^Open details of Write spec/ })).toBeNull();
    await user.click(screen.getByText("No dates", { selector: ".board-group__name" }));
    expect(screen.getByRole("button", { name: "Open details of Waiting" })).toBeTruthy();
  });

  it("hides the expand entry in the board menu and pages through done tasks", async () => {
    const user = userEvent.setup();
    useView("timeline");
    const done = Array.from({ length: 12 }, (_, index) => ({ ...makeBoardTasks()[3]!, id: `d${index}`, title: `Done ${index}`, line: 100 + index, raw: `- [x] Done ${index}`, doneAt: `2026-10-${String(10 + index).padStart(2, "0")}`, due: "2026-11-01" }));
    renderBoard({ payload: makeBoardPayload({ tasks: done }) });
    await screen.findByRole("group", { name: "Task timeline" });
    await user.click(screen.getByRole("button", { name: "Board actions" }));
    expect(screen.queryByRole("menuitem", { name: /Expand all|Collapse all/ })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Refresh" }));
    await user.click(screen.getByRole("button", { name: "Show more done tasks (2)" }));
    expect(screen.getByRole("button", { name: /^Open details of Done 0/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByRole("button", { name: /^Open details of Done 0/ })).toBeNull();
  });
});
