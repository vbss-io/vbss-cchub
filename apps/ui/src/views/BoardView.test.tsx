import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePayload } from "../test-support/u2-fixtures";
import { api, cardOf, column, dataTransfer, defaultSettings, makeBoardPayload, makeBoardTasks, renderBoard, resetApi } from "../test-support/u2-board-view";

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

beforeEach(() => {
  resetApi();
  window.localStorage.clear();
});

describe("BoardView loading states", () => {
  it("shows a loading hint until the board arrives", async () => {
    let resolve: (value: ReturnType<typeof makeBoardPayload>) => void = () => undefined;
    api.board.mockReturnValue(new Promise((done) => {
      resolve = done;
    }));
    renderBoard({ payload: null });
    expect(screen.getByText("Loading…")).toBeTruthy();
    await act(async () => {
      resolve(makeBoardPayload());
    });
    expect(await screen.findByText("Write spec")).toBeTruthy();
  });

  it("shows the load error with a retry that reloads", async () => {
    const user = userEvent.setup();
    api.board.mockRejectedValueOnce(new Error("hub down"));
    renderBoard({ payload: null });
    expect(await screen.findByText("hub down")).toBeTruthy();
    api.board.mockResolvedValue(makeBoardPayload());
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Write spec")).toBeTruthy();
    expect(api.board).toHaveBeenCalledTimes(2);
  });

  it("uses a generic message for non-Error load failures", async () => {
    api.board.mockRejectedValueOnce("weird");
    renderBoard({ payload: null });
    expect(await screen.findByText("could not load tasks")).toBeTruthy();
  });

  it("asks for the second brain path when nothing is configured", async () => {
    const user = userEvent.setup();
    const { onOpenSettings } = renderBoard({ payload: makePayload({ configured: false, root: null }) });
    expect(await screen.findByText(/Set the Second brain path/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("names the missing Tasks folder", async () => {
    renderBoard({ payload: makePayload({ configured: false, root: "/missing" }) });
    expect(await screen.findByText("The Tasks folder /missing does not exist.")).toBeTruthy();
  });

  it("explains when the folder has no markdown files", async () => {
    renderBoard({ payload: makePayload({ projects: [], tasks: [] }) });
    expect(await screen.findByText("No markdown files found in /vault.")).toBeTruthy();
  });

  it("lists the files that could not be read and keeps a refresh error visible", async () => {
    const user = userEvent.setup();
    renderBoard({ payload: makeBoardPayload({ errors: [{ path: "/vault/a.md", error: "bad" }] }) });
    expect(await screen.findByText(/1 file could not be read: \/vault\/a\.md/)).toBeTruthy();
    api.board.mockRejectedValueOnce(new Error("refresh failed"));
    await user.click(screen.getByRole("button", { name: "Board actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Refresh" }));
    expect(await screen.findByText("refresh failed")).toBeTruthy();
    expect(screen.getByText("Write spec")).toBeTruthy();
  });

  it("pluralizes the unreadable files message", async () => {
    renderBoard({
      payload: makeBoardPayload({
        errors: [
          { path: "/a.md", error: "x" },
          { path: "/b.md", error: "y" },
        ],
      }),
    });
    expect(await screen.findByText(/2 files could not be read: \/a\.md, \/b\.md/)).toBeTruthy();
  });
});

describe("BoardView kanban", () => {
  it("renders a column per status that has cards, with counts and cards", async () => {
    renderBoard();
    await screen.findByText("Write spec");
    expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Blocked", "Hold", "To-Do", "Doing", "Done"]);
    expect(within(column("To-Do")).getByText("2", { selector: ".pill__count" })).toBeTruthy();
    expect(within(column("To-Do")).getByText("Write spec")).toBeTruthy();
    expect(within(column("To-Do")).getByText("Plain task")).toBeTruthy();
    expect(within(column("Blocked")).getByText("vendor", { selector: ".board-card__reason" })).toBeTruthy();
    expect(within(column("Done")).getByText("Shipped")).toBeTruthy();
    expect(screen.queryByText("Old thing")).toBeNull();
  });

  it("shows card details: priority, subtask progress, due and daily state", async () => {
    renderBoard();
    await screen.findByText("Write spec");
    const card = cardOf("Write spec");
    expect(within(card).getByText("P0")).toBeTruthy();
    expect(within(card).queryByText("1/2")).toBeNull();
    expect(within(card).getByText("01/01").className).toContain("board-due--overdue");
    expect(within(card).getByText("Today · out of sync")).toBeTruthy();
    expect(within(cardOf("Shipped")).getByText("Done 2026-11-10")).toBeTruthy();
  });

  it("shows the subtask progress once the card is expanded", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Show details of Write spec" }));
    expect(within(cardOf("Write spec")).getByText("1/2", { selector: ".board-meta__progress" })).toBeTruthy();
  });

  it("expands a card to show notes and subtasks, then collapses it", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    const card = cardOf("Write spec");
    expect(within(card).queryByText("spec note")).toBeNull();
    await user.click(within(card).getByRole("button", { name: "Show details of Write spec" }));
    expect(within(card).getByText("spec note")).toBeTruthy();
    expect(within(card).getByText("Sub A")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Add subtask" })).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "Hide details of Write spec" }));
    expect(within(card).queryByText("spec note")).toBeNull();
  });

  it("moves a card to another column by dragging and dropping, asserting the API call", async () => {
    api.patch.mockResolvedValue({ task: makeBoardTasks()[0]!, updatedAt: 1, moved: false });
    renderBoard();
    await screen.findByText("Write spec");
    const card = cardOf("Write spec");
    const transfer = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: transfer });
    expect(transfer.setData).toHaveBeenCalledWith("text/plain", "t1");
    expect(card.className).toContain("board-card--drag");
    const doing = column("Doing");
    fireEvent.dragOver(doing, { dataTransfer: transfer });
    expect(doing.className).toContain("board-col--over");
    fireEvent.drop(doing, { dataTransfer: transfer });
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith({ projectId: "p1", line: 3, raw: "- [ ] Write spec" }, { status: "doing" }));
    expect(doing.className).not.toContain("board-col--over");
  });

  it("does not patch when dropping on the same column", async () => {
    renderBoard();
    await screen.findByText("Write spec");
    const transfer = dataTransfer();
    fireEvent.dragStart(cardOf("Write spec"), { dataTransfer: transfer });
    fireEvent.drop(column("To-Do"), { dataTransfer: transfer });
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("ignores drag over without a dragged card and clears the highlight on leave and end", async () => {
    renderBoard();
    await screen.findByText("Write spec");
    const transfer = dataTransfer();
    const doing = column("Doing");
    fireEvent.dragOver(doing, { dataTransfer: transfer });
    expect(doing.className).not.toContain("board-col--over");
    const card = cardOf("Write spec");
    fireEvent.dragStart(card, { dataTransfer: transfer });
    fireEvent.dragOver(doing, { dataTransfer: transfer });
    fireEvent.dragOver(doing, { dataTransfer: transfer });
    expect(doing.className).toContain("board-col--over");
    const leaveTo = (target: Node) => {
      const event = new Event("dragleave", { bubbles: true });
      Object.defineProperty(event, "relatedTarget", { value: target });
      fireEvent(doing, event);
    };
    leaveTo(within(doing).getByText("Build API"));
    expect(doing.className).toContain("board-col--over");
    leaveTo(document.body);
    expect(doing.className).not.toContain("board-col--over");
    fireEvent.dragOver(doing, { dataTransfer: transfer });
    fireEvent.dragEnd(card);
    expect(doing.className).not.toContain("board-col--over");
    expect(card.className).not.toContain("board-card--drag");
  });

  it("shows empty columns while dragging so cards can be dropped there", async () => {
    renderBoard({ payload: makeBoardPayload({ tasks: makeBoardTasks().filter((task) => task.status === "todo") }) });
    await screen.findByText("Write spec");
    expect(screen.queryByRole("region", { name: "Doing" })).toBeNull();
    fireEvent.dragStart(cardOf("Write spec"), { dataTransfer: dataTransfer() });
    expect(screen.getByRole("region", { name: "Doing" })).toBeTruthy();
    expect(within(column("Doing")).getByText("Drop a task here")).toBeTruthy();
  });

  it("makes finished occurrences and busy cards non draggable", async () => {
    const tasks = makeBoardTasks();
    tasks[3] = { ...tasks[3]!, repeat: "every week" };
    renderBoard({ payload: makeBoardPayload({ tasks }), settings: defaultSettings });
    await screen.findByText("Write spec");
    expect(cardOf("Shipped").getAttribute("draggable")).toBe("false");
    expect(cardOf("Shipped").getAttribute("title")).toContain("Finished occurrence");
    expect(cardOf("Write spec").getAttribute("draggable")).toBe("true");
  });

  it("opens the drawer when a card is clicked but not when a control inside is", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Show details of Write spec" }));
    expect(screen.queryByRole("dialog", { name: /Details of/ })).toBeNull();
    await user.click(screen.getByText("Write spec"));
    expect(screen.getByRole("dialog", { name: "Details of Write spec" })).toBeTruthy();
  });

  it("does not open the drawer while text is selected or just after a drag", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "chosen" } as Selection);
    await user.click(screen.getByText("Write spec"));
    expect(screen.queryByRole("dialog", { name: /Details of/ })).toBeNull();
    selection.mockRestore();
    const card = cardOf("Write spec");
    fireEvent.dragStart(card, { dataTransfer: dataTransfer() });
    fireEvent.click(card);
    expect(screen.queryByRole("dialog", { name: /Details of/ })).toBeNull();
  });

  it("hides and restores the Done column and pages through done tasks", async () => {
    const user = userEvent.setup();
    const done = Array.from({ length: 13 }, (_, index) => ({ ...makeBoardTasks()[3]!, id: `d${index}`, title: `Done ${index}`, line: 100 + index, raw: `- [x] Done ${index}`, doneAt: `2026-10-${String(10 + index).padStart(2, "0")}` }));
    renderBoard({ payload: makeBoardPayload({ tasks: done }) });
    await screen.findByText("Done 12");
    expect(within(column("Done")).getAllByRole("article")).toHaveLength(10);
    await user.click(screen.getByRole("button", { name: "Show more (3)" }));
    expect(within(column("Done")).getAllByRole("article")).toHaveLength(13);
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(within(column("Done")).getAllByRole("article")).toHaveLength(10);
    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
  });
});

describe("BoardView filters", () => {
  it("narrows the cards with the search box and offers to reset when nothing matches", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await user.type(screen.getByRole("textbox", { name: "Search tasks" }), "build");
    expect(screen.queryByText("Write spec")).toBeNull();
    expect(screen.getByText("Build API")).toBeTruthy();
    await user.clear(screen.getByRole("textbox", { name: "Search tasks" }));
    await user.type(screen.getByRole("textbox", { name: "Search tasks" }), "zzzz");
    expect(screen.getByRole("status").textContent).toContain("No tasks");
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(screen.getByText("Write spec")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Search tasks" }) as HTMLInputElement).value).toBe("");
  });

  it("filters by project, including subprojects only on request", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    const select = screen.getByRole("combobox", { name: "Project" });
    expect(within(select).getByRole("option", { name: /All projects \(6\)/ })).toBeTruthy();
    await user.selectOptions(select, "p1");
    expect(screen.getByText("Build API")).toBeTruthy();
    expect(screen.queryByText("Parked")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    await user.click(screen.getByRole("checkbox", { name: "Include subprojects" }));
    expect(screen.queryByText("Build API")).toBeNull();
    expect(screen.getByText("Write spec")).toBeTruthy();
    await user.selectOptions(select, "");
    if (!screen.queryByRole("group", { name: "Filters" })) await user.click(screen.getByRole("button", { name: /^Filters/ }));
    expect((screen.getByRole("checkbox", { name: "Include subprojects" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("toggles statuses from the filter panel, keeping at least one", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    const status = screen.getByRole("region", { name: "Status" });
    await user.click(within(status).getByRole("checkbox", { name: /Archived/ }));
    expect(screen.getByText("Old thing")).toBeTruthy();
    await user.click(within(status).getByRole("button", { name: "All but Archived" }));
    expect(screen.queryByText("Old thing")).toBeNull();
    await user.click(within(status).getByRole("button", { name: "All" }));
    expect(screen.getByText("Old thing")).toBeTruthy();
    for (const label of [/Blocked/, /Hold/, /To-Do/, /Doing/, /Done/]) await user.click(within(status).getByRole("checkbox", { name: label }));
    const last = within(status).getByRole("checkbox", { name: /Archived/ }) as HTMLInputElement;
    expect(last.disabled).toBe(true);
    expect(last.closest("label")?.getAttribute("title")).toBe("Keep at least one status selected");
  });

  it("hides priorities, restores them with All and clears with None", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    const priority = screen.getByRole("region", { name: "Priority" });
    await user.click(within(priority).getByRole("checkbox", { name: /No priority/ }));
    expect(screen.queryByText("Plain task")).toBeNull();
    expect(screen.getByText("Write spec")).toBeTruthy();
    await user.click(within(priority).getByRole("button", { name: "None" }));
    expect(screen.getByRole("status").textContent).toContain("No tasks");
    await user.click(within(priority).getByRole("button", { name: "All" }));
    expect(screen.getByText("Plain task")).toBeTruthy();
  });

  it("limits the board to tasks in today's daily and removes that filter from its chip", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    const view = screen.getByRole("region", { name: "View" });
    await user.click(within(view).getByRole("checkbox", { name: "In today's daily" }));
    expect(screen.queryByText("Plain task")).toBeNull();
    expect(screen.getByText("Build API")).toBeTruthy();
    const chips = screen.getByRole("list", { name: "Active filters" });
    await user.click(within(chips).getByRole("button", { name: /Remove filter/ }));
    expect(screen.getByText("Plain task")).toBeTruthy();
  });

  it("shows empty columns when Hide empty columns is switched off", async () => {
    const user = userEvent.setup();
    renderBoard({ payload: makeBoardPayload({ tasks: makeBoardTasks().filter((task) => task.status === "todo") }) });
    await screen.findByText("Write spec");
    expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["To-Do"]);
    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    await user.click(within(screen.getByRole("region", { name: "View" })).getByRole("checkbox", { name: "Hide empty columns" }));
    expect(screen.getAllByRole("region", { name: /^(Blocked|Hold|To-Do|Doing|Done)$/ })).toHaveLength(5);
    expect(within(column("Blocked")).getByText("Drop a task here")).toBeTruthy();
  });

  it("hides the Done column from the filter panel", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    await user.click(within(screen.getByRole("region", { name: "View" })).getByRole("checkbox", { name: "Hide Done column" }));
    expect(screen.queryByRole("region", { name: "Done" })).toBeNull();
  });

  it("resets filters and view options with Reset", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await user.type(screen.getByRole("textbox", { name: "Search tasks" }), "build");
    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect((screen.getByRole("textbox", { name: "Search tasks" }) as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Write spec")).toBeTruthy();
  });

  it("omits the daily filter when there is no daily and hints when it is missing", async () => {
    const first = renderBoard({ payload: makeBoardPayload({ today: null }) });
    await screen.findByText("Write spec");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    expect(screen.queryByRole("checkbox", { name: "In today's daily" })).toBeNull();
    first.unmount();
    window.localStorage.setItem("hub.board.prefs", JSON.stringify({ filters: { todayOnly: true } }));
    renderBoard({ payload: makeBoardPayload({ today: { date: "2026-11-16", exists: false, taskIds: [], states: {} } }) });
    expect(await screen.findByText(/daily/i, { selector: ".board-filters__hint" })).toBeTruthy();
  });
});

describe("BoardView persistence and refresh", () => {
  it("restores the saved layout and saves changes", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("hub.board.prefs", JSON.stringify({ view: "table" }));
    renderBoard();
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Table" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Kanban" }));
    expect(JSON.parse(window.localStorage.getItem("hub.board.prefs") ?? "{}").view).toBe("kanban");
  });

  it("falls back to defaults when storage is unavailable", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderBoard();
    expect(await screen.findByText("Write spec")).toBeTruthy();
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("reloads after a board stream event once the delay passes, coalescing bursts", async () => {
    const { boardBus } = renderBoard();
    await screen.findByText("Write spec");
    api.board.mockClear();
    act(() => {
      boardBus.emit({} as never);
      boardBus.emit({} as never);
    });
    await waitFor(() => expect(api.board).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.board).toHaveBeenCalledTimes(1);
  });

  it("reloads on daily events only when the board has a daily", async () => {
    const first = renderBoard({ payload: makeBoardPayload({ today: null }) });
    await screen.findByText("Write spec");
    api.board.mockClear();
    act(() => first.dailyBus.emit({} as never));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(api.board).not.toHaveBeenCalled();
    first.unmount();
    const second = renderBoard();
    await screen.findByText("Write spec");
    api.board.mockClear();
    act(() => second.dailyBus.emit({} as never));
    await waitFor(() => expect(api.board).toHaveBeenCalledTimes(1));
  });

  it("unsubscribes from both streams on unmount", async () => {
    const view = renderBoard();
    await screen.findByText("Write spec");
    expect(view.boardBus.size()).toBe(1);
    expect(view.dailyBus.size()).toBe(1);
    view.unmount();
    expect(view.boardBus.size()).toBe(0);
    expect(view.dailyBus.size()).toBe(0);
  });
});

describe("BoardView header menu", () => {
  it("expands and collapses all cards", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await user.click(screen.getByRole("button", { name: "Board actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Expand all" }));
    expect(screen.getByText("spec note")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Board actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Collapse all" }));
    expect(screen.queryByText("spec note")).toBeNull();
  });

  it("moves finished tasks to the done section across all projects and reports the count", async () => {
    const user = userEvent.setup();
    api.sweep.mockResolvedValue({ moved: 2, projects: ["p1"] });
    const { onNotice } = renderBoard();
    await screen.findByText("Write spec");
    await user.click(screen.getByRole("button", { name: "Board actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Move done" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Moved 2 tasks to the done section"));
    expect(api.sweep).toHaveBeenCalledWith();
  });

  it("sweeps only the selected project and reports nothing to move or a singular", async () => {
    const user = userEvent.setup();
    api.sweep.mockResolvedValueOnce({ moved: 0, projects: [] }).mockResolvedValue({ moved: 1, projects: ["p3"] });
    const { onNotice } = renderBoard();
    await screen.findByText("Write spec");
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "p3");
    await user.click(screen.getByRole("button", { name: "Board actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Move done" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Nothing to move to the done section"));
    expect(api.sweep).toHaveBeenCalledWith("p3");
    await user.click(screen.getByRole("button", { name: "Board actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Move done" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Moved 1 task to the done section"));
  });

  it("reports a sweep failure and refreshes", async () => {
    const user = userEvent.setup();
    api.sweep.mockRejectedValue(new Error("locked"));
    const { onError } = renderBoard();
    await screen.findByText("Write spec");
    api.board.mockClear();
    await user.click(screen.getByRole("button", { name: "Board actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Move done" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("locked"));
    expect(api.board).toHaveBeenCalled();
  });

  it("falls back to a generic message for non-Error sweep failures", async () => {
    const user = userEvent.setup();
    api.sweep.mockRejectedValue("nope");
    const { onError } = renderBoard();
    await screen.findByText("Write spec");
    await user.click(screen.getByRole("button", { name: "Board actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Move done" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("could not move the done tasks"));
  });

  it("hides the sweep entry when no done section is configured", async () => {
    const user = userEvent.setup();
    renderBoard({ settings: null });
    await screen.findByText("Write spec");
    await user.click(screen.getByRole("button", { name: "Board actions" }));
    expect(screen.queryByRole("menuitem", { name: "Move done" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Refresh" })).toBeTruthy();
  });

  it("refreshes the board from the menu", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    api.board.mockClear();
    await user.click(screen.getByRole("button", { name: "Board actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Refresh" }));
    expect(api.board).toHaveBeenCalledTimes(1);
  });
});
