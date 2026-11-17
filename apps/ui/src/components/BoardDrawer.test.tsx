import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINISHED_OCCURRENCE_HINT } from "../board-model";
import { getSettings, type BoardTask, type DelegationSettings } from "../delegation";
import { makeNote, makeProject, makeTask } from "../test-support/u2-fixtures";
import { BoardDrawer, organizeMenuItems, type BoardOrganizeActions } from "./BoardDrawer";
import type { BoardNoteActions, BoardTodayControls } from "./BoardParts";

vi.mock("../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../delegation")>()), getSettings: vi.fn() }));

const settings = vi.mocked(getSettings);

const grand = makeTask("g", { title: "Grand", line: 6 });
const sub1 = makeTask("s1", { title: "Sub one", line: 4, status: "doing", priority: 1, subtasks: [grand], noteItems: [makeNote(5, "sub note")] });
const sub2 = makeTask("s2", { title: "Sub two", line: 8 });
const parent = makeTask("p", { title: "Parent", line: 2, noteItems: [makeNote(3, "parent note")], subtasks: [sub1, sub2] });
const other = makeTask("o", { title: "Other", line: 10 });
const tasks: BoardTask[] = [parent, other];
const project = makeProject("p1", { title: "Platform", path: "/vault/platform.md" });

let clock = 1_900_000_000_000;

const fakeSettings = (focusSource: string): DelegationSettings => ({ daily: { focusSource } }) as unknown as DelegationSettings;

const makeHandlers = () => {
  const noteActions: BoardNoteActions = { onAdd: vi.fn(() => Promise.resolve(true)), onEdit: vi.fn(), onDelete: vi.fn() };
  const organize: BoardOrganizeActions = { onMove: vi.fn(), onMoveNote: vi.fn(), onPromote: vi.fn(), onMakeSubtask: vi.fn(), onMoveToProject: vi.fn() };
  const today: BoardTodayControls = {
    isLinked: vi.fn(() => false),
    isOutOfSync: vi.fn(() => false),
    dailyState: vi.fn(() => null),
    addState: { visible: true, allowed: true, hint: "Add it" },
    onAdd: vi.fn(),
  };
  return {
    noteActions,
    organize,
    today,
    onSyncDaily: vi.fn(),
    onUseDaily: vi.fn(),
    onStatus: vi.fn(),
    onRename: vi.fn(),
    onReason: vi.fn(),
    onPriority: vi.fn(),
    onDates: vi.fn(),
    onDelegate: vi.fn(),
    onAddSubtask: vi.fn(),
    onAddToday: vi.fn(),
    onOpenObsidian: vi.fn(),
    onOpenEditor: vi.fn(),
    onClose: vi.fn(),
  };
};

type Props = Parameters<typeof BoardDrawer>[0];

const setup = (overrides: Partial<Props> = {}) => {
  const handlers = makeHandlers();
  const props: Props = {
    task: parent,
    tasks,
    project,
    breadcrumb: "Platform",
    pending: new Set(),
    organizing: false,
    suspended: false,
    inToday: false,
    todayCheckbox: null,
    addState: handlers.today.addState,
    finished: new Set(),
    ...handlers,
    ...overrides,
  };
  const view = render(<BoardDrawer {...props} />);
  return { ...handlers, ...view, props };
};

const drawer = () => screen.getByRole("dialog", { name: /^Details of/ });
const moreMenu = (title = "Parent") => screen.getByRole("button", { name: `More actions for ${title}` });

beforeEach(() => {
  clock += 10 * 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(clock));
  settings.mockReset();
  settings.mockResolvedValue(fakeSettings("scheduled"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("organizeMenuItems", () => {
  const organize = makeHandlers().organize;

  it("offers move up and down with availability and the structural actions", () => {
    const items = organizeMenuItems(tasks, other, organize, false);
    expect(items.map((item) => item.id)).toEqual(["up", "down", "subtask", "project"]);
    expect(items[0]).toMatchObject({ disabled: false, title: undefined });
    expect(items[1]).toMatchObject({ disabled: true, title: "Already last" });
    const first = organizeMenuItems(tasks, parent, organize, false);
    expect(first[0]).toMatchObject({ disabled: true, title: "Already first" });
  });

  it("adds Promote to task for subtasks and routes every selection", () => {
    const items = organizeMenuItems(tasks, sub1, organize, false);
    expect(items.map((item) => item.id)).toEqual(["up", "down", "promote", "subtask", "project"]);
    for (const item of items) item.onSelect();
    expect(organize.onMove).toHaveBeenCalledWith(sub1, "up");
    expect(organize.onMove).toHaveBeenCalledWith(sub1, "down");
    expect(organize.onPromote).toHaveBeenCalledWith(sub1);
    expect(organize.onMakeSubtask).toHaveBeenCalledWith(sub1);
    expect(organize.onMoveToProject).toHaveBeenCalledWith(sub1);
  });

  it("disables everything while busy", () => {
    const items = organizeMenuItems(tasks, sub1, organize, true);
    expect(items.every((item) => item.disabled === true)).toBe(true);
  });
});

describe("BoardDrawer header", () => {
  it("shows the title, breadcrumb and status and priority controls", async () => {
    const user = userEvent.setup();
    const { onStatus, onPriority } = setup({ task: sub1 });
    expect(drawer().getAttribute("aria-label")).toBe("Details of Sub one");
    expect(within(drawer()).getByRole("heading", { level: 2 }).textContent).toContain("Sub one");
    expect(screen.getByText("Platform")).toBeTruthy();
    await user.selectOptions(within(drawer()).getAllByRole("combobox", { name: "Status of Sub one" })[0] as HTMLElement, "done");
    expect(onStatus).toHaveBeenCalledWith(sub1, "done");
    await user.selectOptions(within(drawer()).getAllByRole("combobox", { name: "Priority of Sub one" })[0] as HTMLElement, "2");
    expect(onPriority).toHaveBeenCalledWith(sub1, 2);
  });

  it("renames from the title and edits the reason", async () => {
    const user = userEvent.setup();
    const blocked = makeTask("b", { title: "Stuck", status: "blocked", reason: "waiting", line: 2 });
    const { onRename, onReason } = setup({ task: blocked, tasks: [blocked] });
    await user.click(screen.getByRole("button", { name: "Rename Stuck" }));
    await user.type(screen.getByRole("textbox", { name: "Task title" }), "er{Enter}");
    expect(onRename).toHaveBeenCalledWith(blocked, "Stucker");
    await user.click(screen.getByRole("button", { name: "Edit the reason of Stuck" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "!{Enter}");
    expect(onReason).toHaveBeenCalledWith(blocked, "waiting!");
  });

  it("delegates and adds to today", async () => {
    const user = userEvent.setup();
    const { onDelegate, onAddToday } = setup();
    await user.click(screen.getByRole("button", { name: /Delegate/ }));
    expect(onDelegate).toHaveBeenCalledWith(parent);
    await user.click(screen.getByRole("button", { name: "Add to today" }));
    expect(onAddToday).toHaveBeenCalledWith(parent);
  });

  it("labels the daily action for subtasks and respects the allowed flag and its hint", () => {
    setup({ task: sub1, addState: { visible: true, allowed: false, hint: "No daily yet" } });
    const button = screen.getByRole("button", { name: "Add this subtask to today" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("No daily yet");
  });

  it("hides the daily action when already linked or unavailable", () => {
    const { unmount } = setup({ inToday: true });
    expect(screen.queryByRole("button", { name: "Add to today" })).toBeNull();
    unmount();
    setup({ addState: { visible: false, allowed: true, hint: "" } });
    expect(screen.queryByRole("button", { name: "Add to today" })).toBeNull();
  });

  it("disables the controls while the task is busy", () => {
    setup({ pending: new Set(["p"]) });
    expect((screen.getByRole("button", { name: /Delegate/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((moreMenu() as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables the controls while organizing", () => {
    setup({ organizing: true });
    expect((screen.getByRole("button", { name: "Add subtask" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes from the button", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("adds a subtask", async () => {
    const user = userEvent.setup();
    const { onAddSubtask } = setup();
    await user.click(screen.getByRole("button", { name: "Add subtask" }));
    expect(onAddSubtask).toHaveBeenCalledWith(parent);
  });
});

describe("BoardDrawer more actions menu", () => {
  it("opens the project note in Obsidian or the editor", async () => {
    const user = userEvent.setup();
    const { onOpenObsidian, onOpenEditor } = setup();
    await user.click(moreMenu());
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open in Obsidian", "Open in editor", "Move up", "Move down", "Make subtask of...", "Move to project..."]);
    expect(screen.getByRole("menuitem", { name: "Move up" }).className).toContain("board-menu__item--sep");
    await user.click(screen.getByRole("menuitem", { name: "Open in Obsidian" }));
    expect(onOpenObsidian).toHaveBeenCalledWith(project);
    await user.click(moreMenu());
    await user.click(screen.getByRole("menuitem", { name: "Open in editor" }));
    expect(onOpenEditor).toHaveBeenCalledWith(project);
  });

  it("runs the organize actions", async () => {
    const user = userEvent.setup();
    const { organize } = setup({ task: sub2 });
    await user.click(moreMenu("Sub two"));
    await user.click(screen.getByRole("menuitem", { name: "Promote to task" }));
    expect(organize.onPromote).toHaveBeenCalledWith(sub2);
    await user.click(moreMenu("Sub two"));
    await user.click(screen.getByRole("menuitem", { name: "Make subtask of..." }));
    expect(organize.onMakeSubtask).toHaveBeenCalledWith(sub2);
    await user.click(moreMenu("Sub two"));
    await user.click(screen.getByRole("menuitem", { name: "Move to project..." }));
    expect(organize.onMoveToProject).toHaveBeenCalledWith(sub2);
    await user.click(moreMenu("Sub two"));
    await user.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(organize.onMove).toHaveBeenCalledWith(sub2, "up");
  });

  it("omits the project links when the project is unknown", async () => {
    const user = userEvent.setup();
    setup({ project: null });
    await user.click(moreMenu());
    expect(screen.queryByRole("menuitem", { name: "Open in Obsidian" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Move up" }).className).not.toContain("board-menu__item--sep");
  });
});

describe("BoardDrawer finished occurrences", () => {
  const locked = () => setup({ finished: new Set(["p", "s1", "g", "s2"]), task: makeTask("p", { title: "Parent", line: 2, status: "done", priority: 1, repeat: "every week", due: "2026-11-30", section: "done", doneAt: "2026-11-10", noteItems: [makeNote(3, "parent note")], subtasks: [sub1, sub2] }) });

  it("shows read only chips and the hint, without editing controls", () => {
    locked();
    expect(screen.getByText(FINISHED_OCCURRENCE_HINT, { selector: ".board-drawer__locked" })).toBeTruthy();
    expect(within(drawer()).queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Delegate/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add subtask" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /Add note/ })).toBeNull();
    expect(screen.getByText("Done 2026-11-10")).toBeTruthy();
    expect(screen.getByText("2026-11-30")).toBeTruthy();
  });

  it("keeps only the project links in the menu", async () => {
    const user = userEvent.setup();
    locked();
    await user.click(moreMenu());
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open in Obsidian", "Open in editor"]);
  });

  it("hides the menu entirely without a project", () => {
    setup({ project: null, finished: new Set(["p"]) });
    expect(screen.queryByRole("button", { name: /More actions/ })).toBeNull();
  });
});

describe("BoardDrawer tree", () => {
  it("lists notes and subtasks in file order with nested content", () => {
    setup();
    const tree = screen.getByRole("region", { name: "Notes and subtasks" });
    const titles = Array.from(tree.querySelectorAll(".board-tree__task > .board-sub__row .board-title__text, .board-note__text")).map((node) => node.textContent);
    expect(titles).toEqual(["parent note", "Sub one", "sub note", "Grand", "Sub two"]);
    expect(within(tree).getAllByRole("textbox", { name: /Add note to/ })).toHaveLength(4);
  });

  it("routes note moves and edits through the owner", async () => {
    const user = userEvent.setup();
    const { organize, noteActions } = setup();
    await user.click(screen.getByRole("button", { name: "Move note down: parent note" }));
    expect(organize.onMoveNote).toHaveBeenCalledWith(parent, parent.noteItems[0], "down");
    expect((screen.getByRole("button", { name: "Move note up: parent note" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Delete note sub note" }));
    expect(noteActions.onDelete).toHaveBeenCalledWith(sub1, sub1.noteItems[0]);
  });

  it("edits nested subtasks: status, priority, title and reason", async () => {
    const user = userEvent.setup();
    const blocked = makeTask("b", { title: "Blocked kid", status: "blocked", reason: "r", line: 4 });
    const owner = makeTask("p", { title: "Parent", line: 2, subtasks: [blocked] });
    const { onStatus, onPriority, onRename, onReason } = setup({ task: owner, tasks: [owner] });
    await user.selectOptions(screen.getByRole("combobox", { name: "Status of Blocked kid" }), "todo");
    expect(onStatus).toHaveBeenCalledWith(blocked, "todo");
    await user.selectOptions(screen.getByRole("combobox", { name: "Priority of Blocked kid" }), "3");
    expect(onPriority).toHaveBeenCalledWith(blocked, 3);
    await user.click(screen.getByRole("button", { name: "Rename Blocked kid" }));
    await user.type(screen.getByRole("textbox", { name: "Task title" }), "!{Enter}");
    expect(onRename).toHaveBeenCalledWith(blocked, "Blocked kid!");
    await user.click(screen.getByRole("button", { name: "Edit the reason of Blocked kid" }));
    await user.clear(screen.getByRole("textbox", { name: "Reason" }));
    await user.keyboard("{Enter}");
    expect(onReason).toHaveBeenCalledWith(blocked, null);
  });

  it("organizes a nested subtask through its own menu", async () => {
    const user = userEvent.setup();
    const { organize, today } = setup();
    await user.click(screen.getByRole("button", { name: "Actions for Sub two" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Move up", "Move down", "Promote to task", "Make subtask of...", "Move to project...", "Add this subtask to today"]);
    await user.click(screen.getByRole("menuitem", { name: "Move up" }));
    expect(organize.onMove).toHaveBeenCalledWith(sub2, "up");
    await user.click(screen.getByRole("button", { name: "Actions for Sub two" }));
    await user.click(screen.getByRole("menuitem", { name: "Add this subtask to today" }));
    expect(today.onAdd).toHaveBeenCalledWith(sub2);
  });

  it("badges linked subtasks that drifted from the daily and hides the add action", async () => {
    const user = userEvent.setup();
    const handlers = makeHandlers();
    handlers.today.isLinked = vi.fn((id: string) => id === "s2");
    handlers.today.isOutOfSync = vi.fn((id: string) => id === "s2");
    setup({ today: handlers.today });
    expect(screen.getByText("Out of sync with today")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Actions for Sub two" }));
    expect(screen.queryByRole("menuitem", { name: "Add this subtask to today" })).toBeNull();
  });

  it("offers the daily sync actions in the menu when the focus source is the list", async () => {
    settings.mockResolvedValue(fakeSettings("list"));
    const user = userEvent.setup();
    const handlers = makeHandlers();
    handlers.today.isLinked = vi.fn((id: string) => id === "s2");
    handlers.today.isOutOfSync = vi.fn((id: string) => id === "s2");
    handlers.today.dailyState = vi.fn(() => "done" as const);
    setup({ today: handlers.today, onSyncDaily: handlers.onSyncDaily, onUseDaily: handlers.onUseDaily });
    const { onSyncDaily, onUseDaily } = handlers;
    await screen.findByText("Not linked in today's daily");
    await user.click(screen.getByRole("button", { name: "Actions for Sub two" }));
    expect(screen.getByRole("menuitem", { name: "Use daily (Done)" })).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "Sync to daily" }));
    expect(onSyncDaily).toHaveBeenCalledWith(sub2);
    await user.click(screen.getByRole("button", { name: "Actions for Sub two" }));
    await user.click(screen.getByRole("menuitem", { name: "Use daily (Done)" }));
    expect(onUseDaily).toHaveBeenCalledWith(sub2);
  });

  it("hides the daily sync entries while the focus is mirrored from scheduled dates", async () => {
    const user = userEvent.setup();
    const handlers = makeHandlers();
    handlers.today.isLinked = vi.fn((id: string) => id === "s2");
    handlers.today.isOutOfSync = vi.fn((id: string) => id === "s2");
    handlers.today.dailyState = vi.fn(() => "done" as const);
    setup({ today: handlers.today });
    await waitFor(() => expect(settings).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Actions for Sub two" }));
    expect(screen.queryByRole("menuitem", { name: "Sync to daily" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Use daily/ })).toBeNull();
  });

  it("locks finished subtasks inside the tree", () => {
    setup({ finished: new Set(["s2"]) });
    expect(screen.queryByRole("combobox", { name: "Status of Sub two" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Status of Sub one" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Actions for Sub two" })).toBeNull();
  });
});

describe("BoardDrawer details", () => {
  it("edits dates and shows the group, section and file", async () => {
    const task = makeTask("p", { title: "Parent", line: 2, group: "Sprint 4", start: "2026-11-01" });
    const { onDates } = setup({ task, tasks: [task] });
    fireEvent.change(screen.getByLabelText("Due date of Parent"), { target: { value: "2026-12-12" } });
    fireEvent.blur(screen.getByLabelText("Due date of Parent"));
    expect(onDates).toHaveBeenCalledWith(task, { due: "2026-12-12" });
    expect(screen.getByText("Sprint 4").className).toBe("chip");
    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("/vault/platform.md").title).toBe("/vault/platform.md");
  });

  it("shows no group chip and no file row without them", () => {
    setup({ project: null });
    expect(screen.queryByText("File")).toBeNull();
    expect(drawer().querySelector(".board-drawer__facts .muted")?.textContent).toBe("-");
  });

  it("shows the scheduled focus fact in scheduled mode", async () => {
    const today = new Date(clock);
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const first = setup({ task: makeTask("p", { title: "Parent", scheduled: day }) });
    expect(await screen.findByText("In today's focus")).toBeTruthy();
    first.unmount();
    setup({ task: makeTask("p", { title: "Parent", scheduled: "2031-01-01" }) });
    expect(await screen.findByText("Scheduled 2031-01-01")).toBeTruthy();
  });

  it("shows how the task relates to the daily in list mode", async () => {
    settings.mockResolvedValue(fakeSettings("list"));
    setup();
    expect(await screen.findByText("Not linked in today's daily")).toBeTruthy();
  });

  it("offers Sync to daily and Use daily for a linked task that drifted", async () => {
    settings.mockResolvedValue(fakeSettings("list"));
    const user = userEvent.setup();
    const handlers = makeHandlers();
    handlers.today.isOutOfSync = vi.fn(() => true);
    handlers.today.dailyState = vi.fn(() => "doing" as const);
    setup({ inToday: true, todayCheckbox: "doing", today: handlers.today, onSyncDaily: handlers.onSyncDaily, onUseDaily: handlers.onUseDaily });
    const { onSyncDaily, onUseDaily } = handlers;
    await user.click(await screen.findByRole("button", { name: "Sync to daily" }));
    expect(onSyncDaily).toHaveBeenCalledWith(parent);
    await user.click(screen.getByRole("button", { name: "Use daily" }));
    expect(onUseDaily).toHaveBeenCalledWith(parent);
    expect(screen.getByText("Today · Doing")).toBeTruthy();
  });

  it("omits Use daily when the daily has no state for the task", async () => {
    settings.mockResolvedValue(fakeSettings("list"));
    const handlers = makeHandlers();
    handlers.today.isOutOfSync = vi.fn(() => true);
    setup({ inToday: true, today: handlers.today });
    await screen.findByRole("button", { name: "Sync to daily" });
    expect(screen.queryByRole("button", { name: "Use daily" })).toBeNull();
  });

  it("shows a synced linked task without actions", async () => {
    settings.mockResolvedValue(fakeSettings("list"));
    setup({ inToday: true, todayCheckbox: "todo" });
    expect(await screen.findByText("Today · To-Do")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sync to daily" })).toBeNull();
  });

  it("falls back to the scheduled behaviour when settings cannot be read, without caching the failure", async () => {
    settings.mockRejectedValue(new Error("offline"));
    const task = makeTask("p", { title: "Parent", scheduled: "2031-02-02" });
    const first = setup({ task });
    expect(await screen.findByText("Scheduled 2031-02-02")).toBeTruthy();
    first.unmount();
    settings.mockClear();
    settings.mockResolvedValue(fakeSettings("scheduled"));
    setup({ task });
    expect(screen.queryByText("Scheduled 2031-02-02")).toBeNull();
    expect(await screen.findByText("Scheduled 2031-02-02")).toBeTruthy();
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("uses the cached list mode on the next open without refetching", async () => {
    settings.mockResolvedValue(fakeSettings("list"));
    const first = setup();
    await screen.findByText("Not linked in today's daily");
    first.unmount();
    settings.mockClear();
    setup();
    expect(screen.getByText("Not linked in today's daily")).toBeTruthy();
    expect(settings).not.toHaveBeenCalled();
  });
});

describe("BoardDrawer layout and dismissal", () => {
  it("toggles the large view and returns with the same button", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Open in a large view" }));
    expect(drawer().className).toContain("drawer--full");
    expect(document.querySelector(".drawer__backdrop")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Back to the side panel" }));
    expect(drawer().className).not.toContain("drawer--full");
  });

  it("leaves the large view from the backdrop", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Open in a large view" }));
    fireEvent.click(document.querySelector(".drawer__backdrop") as HTMLElement);
    expect(drawer().className).not.toContain("drawer--full");
  });

  it("closes on Escape unless typing, suspended, or in the large view where it first leaves it", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "x" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Add note to Parent" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Open in a large view" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(drawer().className).not.toContain("drawer--full");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape while suspended behind a dialog", () => {
    const { onClose } = setup({ suspended: true });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a mouse down outside, except in dialogs and toasts or inside itself", () => {
    const { onClose } = setup();
    fireEvent.mouseDown(drawer());
    expect(onClose).not.toHaveBeenCalled();
    const overlay = document.createElement("div");
    overlay.className = "modal__overlay";
    const inner = document.createElement("span");
    overlay.append(inner);
    document.body.append(overlay);
    fireEvent.mouseDown(inner);
    expect(onClose).not.toHaveBeenCalled();
    const toasts = document.createElement("div");
    toasts.className = "toasts";
    document.body.append(toasts);
    fireEvent.mouseDown(toasts);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document);
    expect(onClose).toHaveBeenCalledTimes(1);
    overlay.remove();
    toasts.remove();
  });

  it("does not close from an outside click in the large view", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByRole("button", { name: "Open in a large view" }));
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("takes focus on open and gives it back to the opener on close", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount } = setup();
    expect(document.activeElement).toBe(drawer());
    drawer().blur();
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("does not steal focus back when the user moved it elsewhere", () => {
    const opener = document.createElement("button");
    const elsewhere = document.createElement("input");
    document.body.append(opener, elsewhere);
    opener.focus();
    const { unmount } = setup();
    elsewhere.focus();
    unmount();
    expect(document.activeElement).toBe(elsewhere);
    opener.remove();
    elsewhere.remove();
  });

  it("renders the resize handle on wide viewports", () => {
    setup();
    expect(screen.getByRole("separator", { name: "Resize task panel" })).toBeTruthy();
  });
});
