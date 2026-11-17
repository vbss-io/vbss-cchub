import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BoardConflictError } from "../delegation";
import { openExternal } from "../notify";
import { api, cardOf, makeBoardPayload, makeBoardTasks, renderBoard, resetApi } from "../test-support/u2-board-view";

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

const external = vi.mocked(openExternal);
const spec = () => makeBoardTasks()[0]!;
const plain = () => makeBoardTasks()[6]!;

const menuAction = async (user: ReturnType<typeof userEvent.setup>, title: string, item: string | RegExp) => {
  await user.click(within(cardOf(title)).getByRole("button", { name: `Actions for ${title}` }));
  await user.click(screen.getByRole("menuitem", { name: item }));
};

const openDrawer = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
  await user.click(screen.getByText(title, { selector: ".board-card__title *, .board-card__title" }));
  return screen.getByRole("dialog", { name: `Details of ${title}` });
};

const drawerMenu = async (user: ReturnType<typeof userEvent.setup>, title: string, item: string | RegExp) => {
  await user.click(screen.getByRole("button", { name: `More actions for ${title}` }));
  await user.click(screen.getByRole("menuitem", { name: item }));
};

beforeEach(() => {
  resetApi();
  window.localStorage.clear();
  external.mockReset();
  external.mockResolvedValue(undefined);
  api.patch.mockResolvedValue({ task: spec(), updatedAt: 1, moved: false });
  api.addNote.mockResolvedValue({ task: spec() });
  api.editNote.mockResolvedValue({ task: spec() });
  api.deleteNote.mockResolvedValue({ task: spec() });
  api.addToDaily.mockResolvedValue({ date: "2026-11-16", line: 5, raw: "- [ ] x" });
  api.syncDaily.mockResolvedValue({ date: "2026-11-16", updated: 1 });
  api.move.mockResolvedValue({ task: spec() });
  api.reparent.mockResolvedValue({ task: plain() });
  api.moveToProject.mockResolvedValue({ task: plain() });
  api.create.mockResolvedValue({ task: spec(), updatedAt: 1 });
  api.openEditor.mockResolvedValue({ ok: true, error: null, command: "code" });
});

describe("BoardView task writes", () => {
  it("changes a status from the card menu with the API call", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Plain task");
    await menuAction(user, "Plain task", "Move to Doing");
    expect(api.patch).toHaveBeenCalledWith({ projectId: "p3", line: 3, raw: "- [ ] Plain task" }, { status: "doing" });
  });

  it("changes the priority from the card menu and clears it", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Plain task");
    await menuAction(user, "Plain task", "Priority P2");
    expect(api.patch).toHaveBeenLastCalledWith(expect.objectContaining({ line: 3 }), { priority: 2 });
    await menuAction(user, "Write spec", "No priority");
    expect(api.patch).toHaveBeenLastCalledWith(expect.objectContaining({ line: 3, projectId: "p1" }), { priority: null });
  });

  it("does not write when the chosen value is already current", async () => {
    renderBoard();
    await screen.findByText("Write spec");
    const user = userEvent.setup();
    const drawer = await openDrawer(user, "Write spec");
    await user.selectOptions(within(drawer).getAllByRole("combobox", { name: "Status of Write spec" })[0] as HTMLElement, "todo");
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("announces a recurring task being reopened and reloads", async () => {
    const user = userEvent.setup();
    api.patch.mockResolvedValue({ task: { ...spec(), due: "2026-12-03" }, updatedAt: 1, moved: false, recurred: true });
    const { onNotice } = renderBoard();
    await screen.findByText("Plain task");
    api.board.mockClear();
    await menuAction(user, "Plain task", "Move to Done");
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Done - next one on 03/12"));
    await waitFor(() => expect(api.board).toHaveBeenCalled());
  });

  it("reloads after a task moved sections and refreshes when the daily was synced", async () => {
    const user = userEvent.setup();
    api.patch.mockResolvedValueOnce({ task: spec(), updatedAt: 1, moved: true });
    renderBoard();
    await screen.findByText("Plain task");
    api.board.mockClear();
    await menuAction(user, "Plain task", "Move to Done");
    await waitFor(() => expect(api.board).toHaveBeenCalledTimes(1));
    api.patch.mockResolvedValueOnce({ task: spec(), updatedAt: 1, moved: false, dailySynced: true });
    await menuAction(user, "Parked", "Move to Doing");
    await waitFor(() => expect(api.board).toHaveBeenCalledTimes(2));
  });

  it("keeps the drawer on the task after it moved", async () => {
    const user = userEvent.setup();
    api.patch.mockResolvedValue({ task: spec(), updatedAt: 1, moved: true });
    renderBoard();
    await screen.findByText("Write spec");
    const drawer = await openDrawer(user, "Write spec");
    await user.selectOptions(within(drawer).getAllByRole("combobox", { name: "Status of Write spec" })[0] as HTMLElement, "done");
    await waitFor(() => expect(api.board).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("dialog", { name: "Details of Write spec" })).toBeTruthy();
  });

  it("explains a conflict, refreshes and lets the user retry", async () => {
    const user = userEvent.setup();
    api.patch.mockRejectedValue(new BoardConflictError("changed", null));
    const { onError } = renderBoard();
    await screen.findByText("Plain task");
    api.board.mockClear();
    await menuAction(user, "Plain task", "Move to Doing");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("This task changed on disk, so the board was refreshed. Try again."));
    expect(api.board).toHaveBeenCalled();
  });

  it("reports other write failures, with a fallback for non-Errors", async () => {
    const user = userEvent.setup();
    api.patch.mockRejectedValueOnce(new Error("disk full")).mockRejectedValueOnce("weird");
    const { onError } = renderBoard();
    await screen.findByText("Plain task");
    await menuAction(user, "Plain task", "Move to Doing");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("disk full"));
    await menuAction(user, "Plain task", "Move to Doing");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("could not update the task"));
  });

  it("marks a card busy while its write is in flight", async () => {
    const user = userEvent.setup();
    let finish: (value: { task: ReturnType<typeof spec>; updatedAt: number; moved: boolean }) => void = () => undefined;
    api.patch.mockReturnValue(new Promise((done) => {
      finish = done;
    }));
    renderBoard();
    await screen.findByText("Plain task");
    await menuAction(user, "Plain task", "Move to Doing");
    await waitFor(() => expect(cardOf("Plain task").className).toContain("board-card--busy"));
    expect(cardOf("Plain task").getAttribute("draggable")).toBe("false");
    await act(async () => {
      finish({ task: spec(), updatedAt: 1, moved: false });
    });
    await waitFor(() => expect(cardOf("Plain task").className).not.toContain("board-card--busy"));
  });
});

describe("BoardView drawer edits", () => {
  it("opens the drawer for a task named by the parent and marks it handled", async () => {
    const { onOpenTaskHandled } = renderBoard({ openTaskId: "t2" });
    expect(await screen.findByRole("dialog", { name: "Details of Build API" })).toBeTruthy();
    expect(onOpenTaskHandled).toHaveBeenCalled();
  });

  it("decodes the task id and ignores unknown ones", async () => {
    const tasks = makeBoardTasks();
    tasks[1] = { ...tasks[1]!, id: "p2:a b" };
    const first = renderBoard({ payload: makeBoardPayload({ tasks }), openTaskId: "p2%3Aa%20b" });
    expect(await screen.findByRole("dialog", { name: "Details of Build API" })).toBeTruthy();
    first.unmount();
    const second = renderBoard({ openTaskId: "%E0%A4%A" });
    await screen.findByText("Write spec");
    await waitFor(() => expect(second.onOpenTaskHandled).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: /Details of/ })).toBeNull();
  });

  it("renames, reprioritizes and edits the reason from the drawer", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Waiting");
    const drawer = await openDrawer(user, "Waiting");
    await user.click(within(drawer).getByRole("button", { name: "Rename Waiting" }));
    await user.type(within(drawer).getByRole("textbox", { name: "Task title" }), " now{Enter}");
    expect(api.patch).toHaveBeenCalledWith({ projectId: "p1", line: 10, raw: "- [ ] Waiting" }, { title: "Waiting now" });
    await user.selectOptions(within(drawer).getAllByRole("combobox", { name: "Priority of Waiting" })[0] as HTMLElement, "1");
    expect(api.patch).toHaveBeenCalledWith(expect.anything(), { priority: 1 });
    await user.click(within(drawer).getByRole("button", { name: "Edit the reason of Waiting" }));
    await user.type(within(drawer).getByRole("textbox", { name: "Reason" }), "!{Enter}");
    expect(api.patch).toHaveBeenCalledWith(expect.anything(), { reason: "vendor!" });
  });

  it("changes the dates from the drawer details", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await openDrawer(user, "Write spec");
    fireEvent.change(screen.getByLabelText("Start date of Write spec"), { target: { value: "2026-12-01" } });
    fireEvent.blur(screen.getByLabelText("Start date of Write spec"));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(expect.objectContaining({ line: 3 }), { start: "2026-12-01" }));
  });

  it("closes the drawer with its button and when the task disappears after a refresh", async () => {
    const user = userEvent.setup();
    const { boardBus } = renderBoard();
    await screen.findByText("Write spec");
    await openDrawer(user, "Write spec");
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("dialog", { name: /Details of/ })).toBeNull();
    await openDrawer(user, "Plain task");
    api.board.mockResolvedValue(makeBoardPayload({ tasks: makeBoardTasks().filter((task) => task.id !== "t7") }));
    act(() => boardBus.emit({} as never));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Details of/ })).toBeNull());
  });

  it("opens the project note in the editor and reports failures", async () => {
    const user = userEvent.setup();
    const { onError } = renderBoard();
    await screen.findByText("Write spec");
    await openDrawer(user, "Write spec");
    await drawerMenu(user, "Write spec", "Open in editor");
    expect(api.openEditor).toHaveBeenCalledWith("p1");
    api.openEditor.mockResolvedValueOnce({ ok: false, error: "no editor", command: "code" });
    await drawerMenu(user, "Write spec", "Open in editor");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not open the editor: no editor"));
    api.openEditor.mockResolvedValueOnce({ ok: false, error: null, command: "vim" });
    await drawerMenu(user, "Write spec", "Open in editor");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not open the editor: vim"));
    api.openEditor.mockRejectedValueOnce(new Error("boom"));
    await drawerMenu(user, "Write spec", "Open in editor");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not open the editor: boom"));
    api.openEditor.mockRejectedValueOnce("odd");
    await drawerMenu(user, "Write spec", "Open in editor");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not open the editor: odd"));
  });

  it("opens the project note in Obsidian and reports failures", async () => {
    const user = userEvent.setup();
    const { onError } = renderBoard();
    await screen.findByText("Write spec");
    await openDrawer(user, "Write spec");
    await drawerMenu(user, "Write spec", "Open in Obsidian");
    expect(external).toHaveBeenCalledWith("obsidian://open?path=%2Fvault%2Fplatform.md");
    external.mockRejectedValueOnce(new Error("no handler"));
    await drawerMenu(user, "Write spec", "Open in Obsidian");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not open Obsidian: no handler"));
    external.mockRejectedValueOnce("odd");
    await drawerMenu(user, "Write spec", "Open in Obsidian");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not open Obsidian: odd"));
  });
});

describe("BoardView notes", () => {
  const expandSpec = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findByText("Write spec");
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Show details of Write spec" }));
  };

  it("adds a note with trimmed text and reloads", async () => {
    const user = userEvent.setup();
    renderBoard();
    await expandSpec(user);
    api.board.mockClear();
    await user.type(within(cardOf("Write spec")).getByRole("textbox", { name: "Add note to Write spec" }), "  fresh note {Enter}");
    await waitFor(() => expect(api.addNote).toHaveBeenCalledWith({ projectId: "p1", line: 3, raw: "- [ ] Write spec" }, "fresh note"));
    await waitFor(() => expect(api.board).toHaveBeenCalled());
  });

  it("rejects an invalid note before calling the API", async () => {
    const user = userEvent.setup();
    const { onError } = renderBoard();
    await expandSpec(user);
    await user.type(within(cardOf("Write spec")).getByRole("textbox", { name: "Add note to Write spec" }), "- [[ ] sneaky{Enter}");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("A note cannot look like a task or a code fence"));
    expect(api.addNote).not.toHaveBeenCalled();
  });

  it("edits a note in place", async () => {
    const user = userEvent.setup();
    renderBoard();
    await expandSpec(user);
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Edit note spec note" }));
    await user.type(within(cardOf("Write spec")).getByRole("textbox", { name: "Note" }), " v2{Enter}");
    await waitFor(() => expect(api.editNote).toHaveBeenCalledWith({ projectId: "p1", line: 6, raw: "  - spec note" }, "spec note v2"));
  });

  it("refuses to save an edited note that became invalid", async () => {
    const user = userEvent.setup();
    const { onError } = renderBoard();
    await expandSpec(user);
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Edit note spec note" }));
    const input = within(cardOf("Write spec")).getByRole("textbox", { name: "Note" });
    await user.clear(input);
    await user.type(input, "```{Enter}");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("A note cannot look like a task or a code fence"));
    expect(api.editNote).not.toHaveBeenCalled();
  });

  it("deletes a note and reloads", async () => {
    const user = userEvent.setup();
    renderBoard();
    await expandSpec(user);
    api.board.mockClear();
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Delete note spec note" }));
    await waitFor(() => expect(api.deleteNote).toHaveBeenCalledWith({ projectId: "p1", line: 6, raw: "  - spec note" }));
    await waitFor(() => expect(api.board).toHaveBeenCalled());
  });

  it("handles conflicts and failures of note writes", async () => {
    const user = userEvent.setup();
    api.deleteNote.mockRejectedValueOnce(new BoardConflictError("changed", null)).mockRejectedValueOnce(new Error("locked")).mockRejectedValueOnce("odd");
    const { onError } = renderBoard();
    await expandSpec(user);
    const remove = () => user.click(within(cardOf("Write spec")).getByRole("button", { name: "Delete note spec note" }));
    await remove();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("This task changed on disk, so the board was refreshed. Try again."));
    await remove();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("locked"));
    await remove();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("could not update the note"));
  });
});

describe("BoardView daily integration", () => {
  it("adds a task to today and reloads", async () => {
    const user = userEvent.setup();
    const { onNotice } = renderBoard();
    await screen.findByText("Plain task");
    api.board.mockClear();
    await menuAction(user, "Plain task", "Add to today");
    await waitFor(() => expect(api.addToDaily).toHaveBeenCalledWith({ projectId: "p3", line: 3, raw: "- [ ] Plain task" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("Plain task")));
    expect(api.board).toHaveBeenCalled();
  });

  it("explains that a task is already in the daily and handles other failures", async () => {
    const user = userEvent.setup();
    api.addToDaily.mockRejectedValueOnce(new BoardConflictError("already in the daily", null)).mockRejectedValueOnce(new BoardConflictError("changed", null)).mockRejectedValueOnce(new Error("no daily")).mockRejectedValueOnce("odd");
    const { onError } = renderBoard();
    await screen.findByText("Plain task");
    await menuAction(user, "Plain task", "Add to today");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("That task is already in today's daily."));
    await menuAction(user, "Plain task", "Add to today");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("This task changed on disk, so the board was refreshed. Try again."));
    await menuAction(user, "Plain task", "Add to today");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("no daily"));
    await menuAction(user, "Plain task", "Add to today");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("could not add the task to the daily"));
  });

  it("syncs a drifted task to the daily", async () => {
    const user = userEvent.setup();
    const { onNotice } = renderBoard();
    await screen.findByText("Write spec");
    await menuAction(user, "Write spec", "Sync to daily");
    await waitFor(() => expect(api.syncDaily).toHaveBeenCalledWith({ projectId: "p1", line: 3, raw: "- [ ] Write spec" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('Synced "Write spec" to today\'s daily'));
  });

  it("reports sync conflicts and failures", async () => {
    const user = userEvent.setup();
    api.syncDaily.mockRejectedValueOnce(new BoardConflictError("changed", null)).mockRejectedValueOnce(new Error("no daily")).mockRejectedValueOnce("odd");
    const { onError } = renderBoard();
    await screen.findByText("Write spec");
    await menuAction(user, "Write spec", "Sync to daily");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("This task changed on disk, so the board was refreshed. Try again."));
    await menuAction(user, "Write spec", "Sync to daily");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("no daily"));
    await menuAction(user, "Write spec", "Sync to daily");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("could not sync the task to the daily"));
  });

  it("sets the task status from the daily checkbox", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await menuAction(user, "Write spec", "Use daily (Doing)");
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith({ projectId: "p1", line: 3, raw: "- [ ] Write spec" }, { status: "doing" }));
  });

  it("does nothing for Use daily when the daily has no state for the task", async () => {
    const tasks = makeBoardTasks();
    const payload = makeBoardPayload({ tasks, today: { date: "2026-11-16", exists: true, taskIds: ["t1"], states: {}, mismatch: ["t1"] } });
    renderBoard({ payload });
    await screen.findByText("Write spec");
    const user = userEvent.setup();
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Actions for Write spec" }));
    expect(screen.queryByRole("menuitem", { name: /Use daily/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Sync to daily" })).toBeTruthy();
  });

  it("adds a subtask to today from the card details", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Show details of Write spec" }));
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Add subtask Sub A to today" }));
    await waitFor(() => expect(api.addToDaily).toHaveBeenCalledWith({ projectId: "p1", line: 4, raw: "  - [-] Sub A" }));
  });
});

describe("BoardView creating tasks", () => {
  it("asks for a project in the dialog when none is selected on the board", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Brand new");
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(within(screen.getByRole("dialog", { name: "New task" })).getByRole("combobox", { name: "Project" }), "p2");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ projectId: "p2", title: "Brand new", status: "todo" }));
  });

  it("creates under the selected project and closes with a notice", async () => {
    const user = userEvent.setup();
    const { onNotice } = renderBoard();
    await screen.findByText("Write spec");
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "p3");
    await user.click(screen.getByRole("button", { name: "New task" }));
    expect(screen.getByText("In Garden")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Brand new{Enter}");
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ projectId: "p3", title: "Brand new", status: "todo" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('Created "Brand new"'));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  });

  it("shows creation errors inside the dialog", async () => {
    const user = userEvent.setup();
    api.create.mockRejectedValue(new Error("read only"));
    renderBoard();
    await screen.findByText("Write spec");
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "p3");
    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "X{Enter}");
    expect(await screen.findByText("read only")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull();
  });

  it("adds a subtask under a parent and expands it", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Show details of Write spec" }));
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Add subtask" }));
    expect(screen.getByRole("dialog", { name: "Add subtask" })).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Child{Enter}");
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ projectId: "p1", title: "Child", status: "todo", parentLine: 3, parentRaw: "- [ ] Write spec" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add subtask" })).toBeNull());
    expect(within(cardOf("Write spec")).getByText("spec note")).toBeTruthy();
  });

  it("rebinds the parent after a conflict and asks to try again", async () => {
    const user = userEvent.setup();
    api.create.mockRejectedValueOnce(new BoardConflictError("changed", null));
    renderBoard();
    await screen.findByText("Write spec");
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Show details of Write spec" }));
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Add subtask" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Child{Enter}");
    expect(await screen.findByText("The parent task changed on disk and was reloaded. Add the subtask again.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Add subtask" })).toBeTruthy();
  });

  it("closes the dialog when the parent no longer exists", async () => {
    const user = userEvent.setup();
    api.create.mockRejectedValueOnce(new BoardConflictError("changed", null));
    renderBoard();
    await screen.findByText("Write spec");
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Show details of Write spec" }));
    await user.click(within(cardOf("Write spec")).getByRole("button", { name: "Add subtask" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Child");
    api.board.mockResolvedValue(makeBoardPayload({ tasks: makeBoardTasks().filter((task) => task.id !== "t1") }));
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add subtask" })).toBeNull());
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it("opens the new task dialog from the global event once the board is ready", async () => {
    renderBoard();
    await screen.findByText("Write spec");
    act(() => {
      window.dispatchEvent(new Event("cchub:board-new-task"));
    });
    expect(screen.getByRole("dialog", { name: "New task" })).toBeTruthy();
  });

  it("remembers the global event until the board has loaded", async () => {
    let resolve: (value: ReturnType<typeof makeBoardPayload>) => void = () => undefined;
    api.board.mockReturnValue(new Promise((done) => {
      resolve = done;
    }));
    renderBoard({ payload: null });
    act(() => {
      window.dispatchEvent(new Event("cchub:board-new-task"));
    });
    expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull();
    await act(async () => {
      resolve(makeBoardPayload());
    });
    expect(await screen.findByRole("dialog", { name: "New task" })).toBeTruthy();
  });

  it("ignores the global event when the tasks folder is not configured", async () => {
    renderBoard({ payload: makeBoardPayload({ configured: false }) });
    await screen.findByText("Open settings");
    act(() => {
      window.dispatchEvent(new Event("cchub:board-new-task"));
    });
    expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull();
  });
});

describe("BoardView delegation", () => {
  const spec1 = () => ({ ...spec(), title: "Write spec" });

  it("delegates a task with the preselected workspace and reports it", async () => {
    const user = userEvent.setup();
    api.delegate.mockResolvedValue({ taskId: "run-1", task: spec1() });
    const { onDelegated } = renderBoard();
    await screen.findByText("Write spec");
    await menuAction(user, "Write spec", "Delegate...");
    const dialog = screen.getByRole("dialog", { name: "Delegate task" });
    expect((within(dialog).getByRole("combobox", { name: /^Workspace/ }) as HTMLSelectElement).value).toBe("vbss");
    await user.click(within(dialog).getByRole("button", { name: "Delegate" }));
    await waitFor(() => expect(onDelegated).toHaveBeenCalledWith("run-1", "Write spec"));
    expect(api.delegate).toHaveBeenCalledWith({ projectId: "p1", line: 3, raw: "- [ ] Write spec", workspace: "vbss", prompt: "Do Write spec in Platform", runner: "claude" });
    expect(screen.queryByRole("dialog", { name: "Delegate task" })).toBeNull();
  });

  it("passes the chosen repository and surfaces a server warning", async () => {
    const user = userEvent.setup();
    api.delegate.mockResolvedValue({ taskId: "run-1", task: spec1(), warning: "worktree skipped" });
    const { onError } = renderBoard();
    await screen.findByText("Write spec");
    await menuAction(user, "Write spec", "Delegate...");
    await user.selectOptions(screen.getByRole("combobox", { name: /^Repository/, hidden: true }), "api");
    await user.click(screen.getByRole("button", { name: "Delegate" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Delegated, but worktree skipped"));
    expect(api.delegate).toHaveBeenCalledWith(expect.objectContaining({ repo: "api" }));
  });

  it("rebinds the task after a conflict and asks the user to review", async () => {
    const user = userEvent.setup();
    api.delegate.mockRejectedValueOnce(new BoardConflictError("changed", null));
    renderBoard();
    await screen.findByText("Write spec");
    await menuAction(user, "Write spec", "Delegate...");
    await user.click(screen.getByRole("button", { name: "Delegate" }));
    expect(await screen.findByText("This task changed on disk - review and send again")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Delegate task" })).toBeTruthy();
  });

  it("tells the user when the task vanished and blocks sending", async () => {
    const user = userEvent.setup();
    api.delegate.mockRejectedValueOnce(new BoardConflictError("changed", null));
    renderBoard();
    await screen.findByText("Write spec");
    await menuAction(user, "Write spec", "Delegate...");
    api.board.mockResolvedValue(makeBoardPayload({ tasks: makeBoardTasks().filter((task) => task.id !== "t1") }));
    await user.click(screen.getByRole("button", { name: "Delegate" }));
    expect(await screen.findByText("This task no longer exists on disk - close this dialog and pick another task")).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Delegate" }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("reuses the nearest task with the same title as the conflict target", async () => {
    const user = userEvent.setup();
    const current = { ...spec(), line: 40, raw: "- [ ] Write spec" };
    api.delegate.mockRejectedValueOnce(new BoardConflictError("changed", current));
    renderBoard();
    await screen.findByText("Write spec");
    await menuAction(user, "Write spec", "Delegate...");
    api.board.mockResolvedValue(makeBoardPayload({ tasks: makeBoardTasks().filter((task) => task.id !== "t1") }));
    await user.click(screen.getByRole("button", { name: "Delegate" }));
    expect(await screen.findByText("This task changed on disk - review and send again")).toBeTruthy();
  });

  it("shows other delegation failures in the dialog and closes it on cancel", async () => {
    const user = userEvent.setup();
    api.delegate.mockRejectedValueOnce(new Error("runner offline"));
    renderBoard();
    await screen.findByText("Write spec");
    await menuAction(user, "Write spec", "Delegate...");
    await user.click(screen.getByRole("button", { name: "Delegate" }));
    expect(await screen.findByText("runner offline")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Delegate task" })).toBeNull();
  });

  it("delegates from the drawer and suspends the drawer while the dialog is open", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Write spec");
    await openDrawer(user, "Write spec");
    await user.click(screen.getByRole("button", { name: /Delegate/ }));
    expect(screen.getByRole("dialog", { name: "Delegate task" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Delegate task" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Details of Write spec" })).toBeTruthy();
  });
});

describe("BoardView organizing", () => {
  it("moves a task up or down and refocuses it", async () => {
    const user = userEvent.setup();
    api.move.mockResolvedValue({ task: { ...spec(), line: 2 } });
    renderBoard();
    await screen.findByText("Write spec");
    await openDrawer(user, "Write spec");
    await drawerMenu(user, "Write spec", "Move down");
    await waitFor(() => expect(api.move).toHaveBeenCalledWith({ projectId: "p1", line: 3, raw: "- [ ] Write spec" }, "down"));
    expect(screen.getByRole("dialog", { name: "Details of Write spec" })).toBeTruthy();
  });

  it("moves a note within its task", async () => {
    const user = userEvent.setup();
    const tasks = makeBoardTasks();
    tasks[0] = { ...tasks[0]!, noteItems: [{ line: 6, raw: "  - spec note", text: "spec note" }, { line: 7, raw: "  - second", text: "second" }] };
    renderBoard({ payload: makeBoardPayload({ tasks }) });
    await screen.findByText("Write spec");
    await openDrawer(user, "Write spec");
    await user.click(screen.getByRole("button", { name: "Move note down: spec note" }));
    await waitFor(() => expect(api.move).toHaveBeenCalledWith({ projectId: "p1", line: 6, raw: "  - spec note" }, "down"));
  });

  it("promotes a subtask and announces it", async () => {
    const user = userEvent.setup();
    api.reparent.mockResolvedValue({ task: { ...spec(), title: "Sub A" } });
    const tasks = makeBoardTasks();
    const { onNotice } = renderBoard({ payload: makeBoardPayload({ tasks }) });
    await screen.findByText("Write spec");
    await openDrawer(user, "Write spec");
    await user.click(screen.getByRole("button", { name: "Actions for Sub A" }));
    await user.click(screen.getByRole("menuitem", { name: "Promote to task" }));
    await waitFor(() => expect(api.reparent).toHaveBeenCalledWith({ projectId: "p1", line: 4, raw: "  - [-] Sub A" }, null));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('Promoted "Sub A" to a task'));
  });

  it("reports when the saved change cannot be found again", async () => {
    const user = userEvent.setup();
    api.move.mockResolvedValue({ task: { ...spec(), title: "Ghost" } });
    const { onError } = renderBoard();
    await screen.findByText("Write spec");
    await openDrawer(user, "Write spec");
    await drawerMenu(user, "Write spec", "Move down");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("The change was saved, but the task could not be found again"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Details of/ })).toBeNull());
  });

  it("handles conflicts and failures while organizing", async () => {
    const user = userEvent.setup();
    api.move.mockRejectedValueOnce(new BoardConflictError("changed", null)).mockRejectedValueOnce(new Error("locked")).mockRejectedValueOnce("odd");
    const { onError } = renderBoard();
    await screen.findByText("Write spec");
    await openDrawer(user, "Write spec");
    await drawerMenu(user, "Write spec", "Move down");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("This task changed on disk, so the board was refreshed. Try again."));
    await drawerMenu(user, "Write spec", "Move down");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("locked"));
    await drawerMenu(user, "Write spec", "Move down");
    await waitFor(() => expect(onError).toHaveBeenCalledWith("could not organize the task"));
  });

  it("makes a task a subtask of another through the picker", async () => {
    const user = userEvent.setup();
    const { onNotice } = renderBoard();
    await screen.findByText("Plain task");
    await openDrawer(user, "Plain task");
    await drawerMenu(user, "Plain task", "Make subtask of...");
    const dialog = screen.getByRole("dialog", { name: "Make subtask of" });
    await user.click(within(dialog).getByRole("radio", { name: /Parked/ }));
    await user.click(within(dialog).getByRole("button", { name: "Make subtask" }));
    await waitFor(() => expect(api.reparent).toHaveBeenCalledWith({ projectId: "p3", line: 3, raw: "- [ ] Plain task" }, { line: 1, raw: "- [ ] Parked" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('Moved "Plain task" under "Parked"'));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Make subtask of" })).toBeNull());
  });

  it("cancels the parent picker", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Plain task");
    await openDrawer(user, "Plain task");
    await drawerMenu(user, "Plain task", "Make subtask of...");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Make subtask of" })).toBeNull();
    expect(api.reparent).not.toHaveBeenCalled();
  });

  it("moves a task to another project, optionally under a parent", async () => {
    const user = userEvent.setup();
    const { onNotice } = renderBoard();
    await screen.findByText("Plain task");
    await openDrawer(user, "Plain task");
    await drawerMenu(user, "Plain task", "Move to project...");
    const dialog = screen.getByRole("dialog", { name: "Move to project" });
    await user.selectOptions(within(dialog).getByLabelText("Target project"), "p2");
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(api.moveToProject).toHaveBeenCalledWith({ projectId: "p3", line: 3, raw: "- [ ] Plain task" }, "p2", null));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('Moved "Plain task" to Platform › API'));
  });

  it("places the moved task under a chosen parent of the target project", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByText("Plain task");
    await openDrawer(user, "Plain task");
    await drawerMenu(user, "Plain task", "Move to project...");
    const dialog = screen.getByRole("dialog", { name: "Move to project" });
    await user.selectOptions(within(dialog).getByLabelText("Target project"), "p1");
    await user.selectOptions(within(dialog).getByLabelText("Parent task in the target project"), "t3");
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(api.moveToProject).toHaveBeenCalledWith(expect.anything(), "p1", { line: 10, raw: "- [ ] Waiting" }));
  });

  it("closes the picker when its task disappears after a refresh", async () => {
    const user = userEvent.setup();
    const { boardBus } = renderBoard();
    await screen.findByText("Plain task");
    await openDrawer(user, "Plain task");
    await drawerMenu(user, "Plain task", "Make subtask of...");
    api.board.mockResolvedValue(makeBoardPayload({ tasks: makeBoardTasks().filter((task) => task.id !== "t7") }));
    act(() => boardBus.emit({} as never));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Make subtask of" })).toBeNull());
  });
});
