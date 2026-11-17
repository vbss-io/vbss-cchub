import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyStreamEvent, TasksBoardStreamEvent } from "../api";
import { obsidianUrl, recurrenceNotice } from "../board-model";
import {
  addBoardNote,
  addCapture,
  addMeeting,
  BoardConflictError,
  clearToday,
  createBoardItem,
  createTodayNote,
  delegateBoardTask,
  deleteBoardNote,
  editBoardNote,
  getTasksBoard,
  getToday,
  linkTick,
  moveBoardItem,
  moveBoardTaskToProject,
  openBoardProjectInEditor,
  patchBoardItem,
  promoteCapture,
  reorderFocus,
  reparentBoardTask,
  scheduleTask,
  tickDay,
  TodayUnavailableError,
  undoClearToday,
  type BoardPayload,
  type BoardTask,
  type TodayData,
} from "../delegation";
import { FOCUS_COLLAPSE_KEY } from "../focus-collapse";
import { openExternal } from "../notify";
import { boardPayload, boardProject, boardTask, DAY, settingsOf, todayData, todayEntry } from "../test-support/u1-fixtures";
import { installMatchMedia, installResizeObserver, makeBus } from "../test-support/u1-mock";
import { START_DAY_EVENT, TODAY_DRAG_MIME } from "../today-model";
import { TodayView } from "./TodayView";

const dv = vi.hoisted(() => ({
  entry: { exists: true, path: "/d.md" } as { exists: boolean; path: string | null },
  sessions: [] as { sessionId: string; title: string | null; client: string | null; status: string }[],
}));

vi.mock("../delegation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../delegation")>()),
  addBoardNote: vi.fn(),
  addCapture: vi.fn(),
  addMeeting: vi.fn(),
  clearToday: vi.fn(),
  createBoardItem: vi.fn(),
  createTodayNote: vi.fn(),
  delegateBoardTask: vi.fn(),
  deleteBoardNote: vi.fn(),
  editBoardNote: vi.fn(),
  getTasksBoard: vi.fn(),
  getToday: vi.fn(),
  linkTick: vi.fn(),
  moveBoardItem: vi.fn(),
  moveBoardTaskToProject: vi.fn(),
  openBoardProjectInEditor: vi.fn(),
  patchBoardItem: vi.fn(),
  promoteCapture: vi.fn(),
  reorderFocus: vi.fn(),
  reparentBoardTask: vi.fn(),
  scheduleTask: vi.fn(),
  tickDay: vi.fn(),
  undoClearToday: vi.fn(),
}));

vi.mock("../notify", async (importOriginal) => ({ ...(await importOriginal<typeof import("../notify")>()), openExternal: vi.fn() }));

vi.mock("./DailyView", async () => {
  const { createElement, useEffect } = await import("react");
  return {
    DAILY_ORGANIZE_EVENT: "cchub:daily-organize",
    DAILY_REFINE_EVENT: "cchub:daily-refine",
    useDailySessions: () => ({ sessions: dv.sessions, refresh: () => undefined }),
    DailyView: (props: { date: string; onEntryChange?: (info: { exists: boolean; path: string | null }) => void }) => {
      useEffect(() => {
        props.onEntryChange?.(dv.entry);
      }, []);
      return createElement("div", { "data-testid": "daily-view" }, `daily:${props.date}`);
    },
  };
});

vi.mock("../components/FocusOutliner", async () => ({ FocusOutliner: (await import("../test-support/u1-today-stubs")).FocusOutlinerStub }));
vi.mock("../components/BacklogPanel", async () => ({ BacklogPanel: (await import("../test-support/u1-today-stubs")).BacklogPanelStub }));
vi.mock("../components/StartDayPanel", async () => ({ StartDayPanel: (await import("../test-support/u1-today-stubs")).StartDayPanelStub }));
vi.mock("../components/DaySummaryDialog", async () => ({ DaySummaryDialog: (await import("../test-support/u1-today-stubs")).DaySummaryDialogStub }));
vi.mock("../components/TodaySubtaskPicker", async () => ({ TodaySubtaskPicker: (await import("../test-support/u1-today-stubs")).SubtaskPickerStub }));
vi.mock("../components/BoardDrawer", async () => ({ BoardDrawer: (await import("../test-support/u1-today-stubs")).BoardDrawerStub }));
vi.mock("../components/BoardNewTaskDialog", async () => ({ BoardNewTaskDialog: (await import("../test-support/u1-today-stubs")).NewTaskDialogStub }));
vi.mock("../components/BoardDelegateDialog", async () => ({ BoardDelegateDialog: (await import("../test-support/u1-today-stubs")).DelegateDialogStub }));
vi.mock("../components/BoardOrganizeDialogs", async () => {
  const stubs = await import("../test-support/u1-today-stubs");
  return { BoardParentPickerDialog: stubs.ParentPickerStub, BoardMoveProjectDialog: stubs.MoveProjectStub };
});

const mocked = {
  getToday: vi.mocked(getToday),
  getBoard: vi.mocked(getTasksBoard),
  schedule: vi.mocked(scheduleTask),
  patch: vi.mocked(patchBoardItem),
  create: vi.mocked(createBoardItem),
  addNote: vi.mocked(addBoardNote),
  editNote: vi.mocked(editBoardNote),
  deleteNote: vi.mocked(deleteBoardNote),
  capture: vi.mocked(addCapture),
  meeting: vi.mocked(addMeeting),
  promote: vi.mocked(promoteCapture),
  createNote: vi.mocked(createTodayNote),
  tick: vi.mocked(linkTick),
  reorder: vi.mocked(reorderFocus),
  clear: vi.mocked(clearToday),
  undo: vi.mocked(undoClearToday),
  move: vi.mocked(moveBoardItem),
  reparent: vi.mocked(reparentBoardTask),
  moveProject: vi.mocked(moveBoardTaskToProject),
  openEditor: vi.mocked(openBoardProjectInEditor),
  delegate: vi.mocked(delegateBoardTask),
  external: vi.mocked(openExternal),
  tickDay: vi.mocked(tickDay),
};

const YESTERDAY = "2026-11-15";
const DAY_BEFORE = "2026-11-14";
const TOMORROW = "2026-11-17";

const alpha = boardProject("alpha", "Alpha", { path: "/vault/alpha.md" });
const beta = boardProject("beta", "Beta", { path: "/vault/beta.md" });
const s1 = boardTask("s1", "alpha", 3, { title: "Sub one", depth: 1, raw: "  - [ ] Sub one" });
const s2 = boardTask("s2", "alpha", 4, { title: "Sub two", depth: 1, raw: "  - [ ] Sub two" });
const s3 = boardTask("s3", "alpha", 5, { title: "Sub three", depth: 1, raw: "  - [ ] Sub three" });
const t1 = boardTask("t1", "alpha", 2, { title: "Write docs", raw: "- [ ] Write docs", scheduled: DAY, subtasks: [s1, s2, s3] });
const t2 = boardTask("t2", "alpha", 6, { title: "Fix bug", raw: "- [-] Fix bug", status: "doing", checkbox: "doing", scheduled: DAY });
const t3 = boardTask("t3", "beta", 2, { title: "Carried task", raw: "- [ ] Carried task", scheduled: YESTERDAY });
const t4 = boardTask("t4", "beta", 3, { title: "Backlog only", raw: "- [ ] Backlog only" });

const board = (patch: Partial<BoardPayload> = {}): BoardPayload => boardPayload({ projects: [alpha, beta], tasks: [t1, t2, t3, t4], ...patch });

const focusEntries = () => [{ ...todayEntry(t1, "Alpha"), visibleSubtasks: ["s1", "s3"] }, todayEntry(t2, "Alpha")];

const dataOf = (patch: Partial<TodayData> = {}): TodayData => todayData({ focus: focusEntries(), carriedOver: [todayEntry(t3, "Beta")], ...patch });

const daily = makeBus<DailyStreamEvent>();
const boardBus = makeBus<TasksBoardStreamEvent>();

interface MountOptions {
  tasks?: boolean;
  daily?: boolean;
  projectOrder?: string[];
  nullSettings?: boolean;
}

const mount = (options: MountOptions = {}) => {
  const props = { onOpenSession: vi.fn(), onOpenTask: vi.fn(), onDelegated: vi.fn(), onNotice: vi.fn(), onError: vi.fn() };
  const settings = options.nullSettings ? null : settingsOf({ daily: options.daily ?? true, tasks: options.tasks ?? true, projectOrder: options.projectOrder });
  const view = render(<TodayView settings={settings} workspaces={[]} subscribeDaily={daily.subscribe} subscribeBoard={boardBus.subscribe} {...props} />);
  return { ...view, ...props };
};

const ready = async () => screen.findByTestId("outliner");

const mountReady = async (options: MountOptions = {}) => {
  const view = mount(options);
  await ready();
  return view;
};

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));

const choose = (menu: string, item: string | RegExp) => {
  click(menu);
  fireEvent.click(within(screen.getByRole("menu", { name: menu })).getByRole("menuitem", { name: item }));
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const todayCalls = () => mocked.getToday.mock.calls.length;

const setTime = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 16, 12, 0, 0));
};

const dragTransfer = (payload: string, types: string[] = [TODAY_DRAG_MIME]) => ({ types, getData: () => payload, dropEffect: "" });

describe("TodayView", () => {
  beforeAll(() => {
    installResizeObserver();
  });

  beforeEach(() => {
    window.localStorage.clear();
    installMatchMedia(false);
    setTime();
    dv.entry = { exists: true, path: "/d.md" };
    dv.sessions = [];
    for (const fn of Object.values(mocked)) fn.mockReset();
    mocked.getToday.mockResolvedValue(dataOf());
    mocked.getBoard.mockResolvedValue(board());
    mocked.schedule.mockResolvedValue({ task: t1 });
    mocked.patch.mockResolvedValue({ task: t1, updatedAt: 1, moved: false });
    mocked.create.mockResolvedValue({ task: t1, updatedAt: 1 });
    mocked.addNote.mockResolvedValue({ task: t1 });
    mocked.editNote.mockResolvedValue({ task: t1 });
    mocked.deleteNote.mockResolvedValue({ task: t1 });
    mocked.capture.mockResolvedValue({ captures: [] });
    mocked.meeting.mockResolvedValue({ meetings: [] });
    mocked.promote.mockResolvedValue({ task: t1 });
    mocked.createNote.mockResolvedValue({ dailyExists: true });
    mocked.tick.mockResolvedValue(undefined);
    mocked.reorder.mockResolvedValue({ moved: true });
    mocked.clear.mockResolvedValue({ token: "tok", lines: 2, unscheduled: 1 });
    mocked.undo.mockResolvedValue({ restored: true });
    mocked.move.mockResolvedValue({ task: t1 });
    mocked.reparent.mockResolvedValue({ task: t1 });
    mocked.moveProject.mockResolvedValue({ task: t1 });
    mocked.openEditor.mockResolvedValue({ ok: true, error: null, command: "code" });
    mocked.delegate.mockResolvedValue({ taskId: "run-1", task: t2 });
    mocked.external.mockResolvedValue(undefined);
    mocked.tickDay.mockResolvedValue({ task: t1 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("availability and loading", () => {
    it("says Today is off when Daily is disabled or settings are missing", () => {
      const view = mount({ daily: false });
      expect(screen.getByText(/Today is off/)).toBeTruthy();
      expect(mocked.getToday).not.toHaveBeenCalled();
      view.unmount();
      mount({ nullSettings: true });
      expect(screen.getByText(/Today is off/)).toBeTruthy();
    });

    it("shows a loading state and then the focus of the day with the board loaded", async () => {
      mount();
      expect(screen.getByText("Loading…")).toBeTruthy();
      await ready();
      expect(mocked.getToday).toHaveBeenCalledWith(DAY);
      expect(mocked.getBoard).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("heading", { name: /^Focus/ }).textContent).toBe("Focus 2");
      expect(screen.getByText("Write docs")).toBeTruthy();
      expect(screen.getByText("Today", { selector: ".today__day" })).toBeTruthy();
      expect(screen.getByTestId("outliner").getAttribute("data-today")).toBe(DAY);
    });

    it("shows the load error with a retry", async () => {
      mocked.getToday.mockRejectedValueOnce(new Error("hub down"));
      mount();
      expect((await screen.findByRole("alert")).textContent).toContain("hub down");
      click("Retry");
      await ready();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("uses a generic message when the failure is not an error", async () => {
      mocked.getToday.mockRejectedValueOnce("x");
      mount();
      expect((await screen.findByRole("alert")).textContent).toContain("could not load Today");
    });

    it("asks for a newer hub when the routes are missing", async () => {
      mocked.getToday.mockRejectedValue(new TodayUnavailableError("old"));
      mount();
      expect((await screen.findByRole("alert")).textContent).toContain("Today needs a newer hub");
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("works without Tasks: no board call, no backlog, a hint and a disabled Add task", async () => {
      await mountReady({ tasks: false });
      expect(mocked.getBoard).not.toHaveBeenCalled();
      expect(screen.getByText(/Turn on Tasks in Settings/)).toBeTruthy();
      expect(screen.queryByLabelText("Backlog stub")).toBeNull();
      expect((screen.getByRole("button", { name: "Add task" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("explains that scheduling does not change a list-driven focus", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ focusSource: "list" }));
      await mountReady();
      expect(screen.getByText(/Focus follows the list in the note/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /^plan:/ })).toBeNull();
    });

    it("ignores a result that arrives after a newer request", async () => {
      let release: (value: TodayData) => void = () => undefined;
      mocked.getToday.mockReturnValueOnce(
        new Promise<TodayData>((resolve) => {
          release = resolve;
        }),
      );
      mount();
      click("Next ›");
      await ready();
      await act(async () => release(dataOf({ focus: [] })));
      expect(screen.getByText("Write docs")).toBeTruthy();
    });
  });

  describe("day navigation", () => {
    it("moves between days and back to today", async () => {
      await mountReady();
      expect((screen.getByRole("button", { name: "Today" }) as HTMLButtonElement).disabled).toBe(true);
      click("Next ›");
      await waitFor(() => expect(mocked.getToday).toHaveBeenLastCalledWith(TOMORROW));
      expect(screen.getByText("Tomorrow", { selector: ".today__day" })).toBeTruthy();
      click("‹ Previous");
      click("‹ Previous");
      await waitFor(() => expect(mocked.getToday).toHaveBeenLastCalledWith(YESTERDAY));
      expect(screen.getByText("Yesterday", { selector: ".today__day" })).toBeTruthy();
      click("Today");
      await waitFor(() => expect(mocked.getToday).toHaveBeenLastCalledWith(DAY));
    });

    it("jumps to a typed date and ignores an emptied field", async () => {
      await mountReady();
      const input = screen.getByLabelText("Day") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "2026-12-24" } });
      await waitFor(() => expect(mocked.getToday).toHaveBeenLastCalledWith("2026-12-24"));
      const calls = todayCalls();
      fireEvent.change(input, { target: { value: "" } });
      expect(todayCalls()).toBe(calls);
    });
  });

  describe("tabs", () => {
    it("shows the note with the Note tab and remembers it", async () => {
      await mountReady();
      expect(screen.getByRole("tab", { name: "Today" }).getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("tab", { name: "Note" })).toBeTruthy();
      expect(screen.queryByRole("tab", { name: "Backlog" })).toBeNull();
      fireEvent.click(screen.getByRole("tab", { name: "Note" }));
      expect(window.localStorage.getItem("hub.today.tab")).toBe("note");
      expect((document.querySelector(".today__note") as HTMLElement).hidden).toBe(false);
      expect(screen.getByTestId("daily-view").textContent).toBe(`daily:${DAY}`);
      expect(document.querySelector(".today__modes")).not.toBeNull();
    });

    it("opens on the stored Note tab and survives a storage that throws", async () => {
      window.localStorage.setItem("hub.today.tab", "note");
      mount();
      await waitFor(() => expect(screen.getByRole("tab", { name: "Note" }).getAttribute("aria-selected")).toBe("true"));
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      fireEvent.click(screen.getByRole("tab", { name: "Today" }));
      expect(screen.getByRole("tab", { name: "Today" }).getAttribute("aria-selected")).toBe("true");
    });

    it("falls back to defaults when storage cannot be read", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      await mountReady();
      expect(screen.getByRole("tab", { name: "Today" }).getAttribute("aria-selected")).toBe("true");
    });

    it("on a narrow screen offers a Backlog tab and hides the focus there", async () => {
      installMatchMedia(true);
      mount();
      await screen.findByRole("tab", { name: "Backlog" });
      await waitFor(() => expect(screen.getByTestId("outliner")).toBeTruthy());
      fireEvent.click(screen.getByRole("tab", { name: "Backlog" }));
      expect(screen.getByLabelText("Backlog stub")).toBeTruthy();
      expect(screen.queryByTestId("outliner")).toBeNull();
      expect(window.localStorage.getItem("hub.today.tab")).toBeNull();
    });

    it("returns to the Today view when the screen widens while on Backlog", async () => {
      const media = installMatchMedia(true);
      mount();
      fireEvent.click(await screen.findByRole("tab", { name: "Backlog" }));
      act(() => media.setMatches(false));
      await waitFor(() => expect(screen.getByRole("tab", { name: "Today" }).getAttribute("aria-selected")).toBe("true"));
      expect(screen.getByTestId("outliner")).toBeTruthy();
      expect(screen.getByLabelText("Backlog stub")).toBeTruthy();
    });

    it("shows main and backlog side by side on a wide screen", async () => {
      await mountReady();
      expect(screen.getByLabelText("Backlog stub")).toBeTruthy();
      expect(document.querySelector(".today__split")).not.toBeNull();
    });
  });

  describe("start of the day", () => {
    beforeEach(() => {
      mocked.getToday.mockResolvedValue(dataOf({ dailyExists: false }));
    });

    it("shows the start panel instead of the create button when today has no note", async () => {
      mount();
      await screen.findByLabelText("Start stub");
      expect(screen.queryByRole("button", { name: "Create today's note" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Add task" })).toBeNull();
      expect(screen.queryByText(/No note for this day yet/)).toBeNull();
    });

    it("schedules, postpones and drops carried tasks from the start panel", async () => {
      mount();
      await screen.findByLabelText("Start stub");
      const target = { projectId: "beta", line: 2, raw: "- [ ] Carried task" };
      click("start-bring");
      await waitFor(() => expect(mocked.schedule).toHaveBeenLastCalledWith(DAY, { ...target, date: DAY }));
      click("start-tomorrow");
      await waitFor(() => expect(mocked.schedule).toHaveBeenLastCalledWith(DAY, { ...target, date: TOMORROW }));
      click("start-drop");
      await waitFor(() => expect(mocked.schedule).toHaveBeenLastCalledWith(DAY, { ...target, date: null }));
      await waitFor(() => expect(todayCalls()).toBe(4));
    });

    it("brings every carried task and stops at the first failure", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ dailyExists: false, carriedOver: [todayEntry(t3, "Beta"), todayEntry(t4, "Beta")] }));
      const view = mount();
      await screen.findByLabelText("Start stub");
      click("start-bring-all");
      await waitFor(() => expect(mocked.schedule).toHaveBeenCalledTimes(2));
      mocked.schedule.mockReset();
      mocked.schedule.mockRejectedValue(new Error("no write"));
      click("start-bring-all");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("no write"));
      expect(mocked.schedule).toHaveBeenCalledTimes(1);
    });

    it("opens a carried task in the drawer", async () => {
      mount();
      await screen.findByLabelText("Start stub");
      click("start-open");
      expect((await screen.findByTestId("drawer-task")).textContent).toBe("t3");
    });

    it("refreshes and leaves the start panel once the note was created", async () => {
      mount();
      await screen.findByLabelText("Start stub");
      mocked.getToday.mockResolvedValue(dataOf({ dailyExists: true }));
      click("start-created");
      await waitFor(() => expect(screen.queryByLabelText("Start stub")).toBeNull());
    });

    it("hands over to the assistant and the classic planner through the note tab", async () => {
      const refine = vi.fn();
      const plan = vi.fn();
      window.addEventListener("cchub:daily-refine", refine);
      window.addEventListener("cchub:daily-plan-today", plan);
      mount();
      await screen.findByLabelText("Start stub");
      click("start-refine");
      expect(refine).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("tab", { name: "Note" }).getAttribute("aria-selected")).toBe("true");
      fireEvent.click(screen.getByRole("tab", { name: "Today" }));
      click("start-classic");
      expect(plan).toHaveBeenCalledTimes(1);
      window.removeEventListener("cchub:daily-refine", refine);
      window.removeEventListener("cchub:daily-plan-today", plan);
    });

    it("forwards errors from the start panel", async () => {
      const view = mount();
      await screen.findByLabelText("Start stub");
      click("start-error");
      expect(view.onError).toHaveBeenCalledWith("start error");
      click("start-close");
      expect(screen.getByLabelText("Start stub")).toBeTruthy();
    });

    it("offers a plain create button for a past day without a note", async () => {
      mount();
      await screen.findByLabelText("Start stub");
      click("‹ Previous");
      expect(await screen.findByText(/No note for this day yet/)).toBeTruthy();
      mocked.getToday.mockResolvedValue(dataOf({ dailyExists: true }));
      click("Create note");
      await waitFor(() => expect(mocked.createNote).toHaveBeenCalledWith(YESTERDAY));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Create note" })).toBeNull());
    });

    it("reports a failure to create the note", async () => {
      mocked.createNote.mockRejectedValueOnce(new Error("exists"));
      const view = mount();
      await screen.findByLabelText("Start stub");
      click("‹ Previous");
      await screen.findByText(/No note for this day yet/);
      click("Create note");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("exists"));
      mocked.createNote.mockRejectedValueOnce("x");
      click("Create note");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("could not create the note"));
    });
  });

  describe("carried over strip", () => {
    it("lists carried tasks and drives their actions", async () => {
      await mountReady();
      const strip = screen.getByRole("region", { name: "Carried over" });
      expect(within(strip).getByText("Carried over").closest("h3")?.textContent).toContain("1");
      expect(within(strip).getByText("15/11").getAttribute("title")).toBe("Scheduled for 2026-11-15");
      const target = { projectId: "beta", line: 2, raw: "- [ ] Carried task" };
      fireEvent.click(within(strip).getByRole("button", { name: "Bring to today" }));
      await waitFor(() => expect(mocked.schedule).toHaveBeenLastCalledWith(DAY, { ...target, date: DAY }));
      fireEvent.click(within(strip).getByRole("button", { name: "Tomorrow" }));
      await waitFor(() => expect(mocked.schedule).toHaveBeenLastCalledWith(DAY, { ...target, date: TOMORROW }));
      fireEvent.click(within(strip).getByRole("button", { name: "Drop" }));
      await waitFor(() => expect(mocked.schedule).toHaveBeenLastCalledWith(DAY, { ...target, date: null }));
      fireEvent.click(within(strip).getByRole("button", { name: "Bring all" }));
      await waitFor(() => expect(mocked.schedule).toHaveBeenCalledTimes(4));
      fireEvent.click(within(strip).getByRole("button", { name: "Carried task" }));
      expect((await screen.findByTestId("drawer-task")).textContent).toBe("t3");
    });

    it("uses the day wording for another day and shows the in-progress mark", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ carriedOver: [todayEntry({ ...t3, status: "doing" }, "Beta")] }));
      await mountReady();
      click("Next ›");
      await waitFor(() => expect(mocked.getToday).toHaveBeenLastCalledWith(TOMORROW));
      const strip = screen.getByRole("region", { name: "Carried over" });
      expect(within(strip).getByRole("button", { name: "Bring here" })).toBeTruthy();
      expect(within(strip).getByRole("img", { name: "In progress" })).toBeTruthy();
    });

    it("is hidden when nothing is carried over", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ carriedOver: [] }));
      await mountReady();
      expect(screen.queryByRole("region", { name: "Carried over" })).toBeNull();
    });

    it("reports a failure while bringing a task", async () => {
      mocked.schedule.mockRejectedValue(new BoardConflictError("changed", null));
      const view = await mountReady();
      fireEvent.click(within(screen.getByRole("region", { name: "Carried over" })).getByRole("button", { name: "Bring to today" }));
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("This task changed on disk, so Today was refreshed. Try again."));
    });
  });

  describe("more actions menu", () => {
    it("starts the day on demand even when the note exists", async () => {
      await mountReady();
      expect(screen.queryByLabelText("Start stub")).toBeNull();
      choose("More actions", "Start the day");
      expect((await screen.findByLabelText("Start stub")).getAttribute("data-note-exists")).toBe("true");
    });

    it("starts the day from the global start-day event", async () => {
      await mountReady();
      act(() => {
        window.dispatchEvent(new CustomEvent(START_DAY_EVENT));
      });
      expect(await screen.findByLabelText("Start stub")).toBeTruthy();
    });

    it("opens the classic planner and the organizer through window events", async () => {
      const plan = vi.fn();
      const organize = vi.fn();
      window.addEventListener("cchub:daily-plan-today", plan);
      window.addEventListener("cchub:daily-organize", organize);
      await mountReady();
      choose("More actions", "Classic planner");
      expect(plan).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("tab", { name: "Note" }).getAttribute("aria-selected")).toBe("true");
      choose("More actions", "Organize focus");
      expect(organize).toHaveBeenCalledTimes(1);
      window.removeEventListener("cchub:daily-plan-today", plan);
      window.removeEventListener("cchub:daily-organize", organize);
    });

    it("refines with the assistant when the note exists and disables it otherwise", async () => {
      const refine = vi.fn();
      window.addEventListener("cchub:daily-refine", refine);
      await mountReady();
      choose("More actions", "Refine with assistant");
      expect(refine).toHaveBeenCalledTimes(1);
      window.removeEventListener("cchub:daily-refine", refine);
    });

    it("disables refine and Obsidian when the note does not exist", async () => {
      dv.entry = { exists: false, path: null };
      await mountReady();
      click("More actions");
      const menu = screen.getByRole("menu", { name: "More actions" });
      expect((within(menu).getByRole("menuitem", { name: "Refine with assistant" }) as HTMLButtonElement).disabled).toBe(true);
      expect((within(menu).getByRole("menuitem", { name: "Open in Obsidian" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("opens the note in Obsidian and reports a failure", async () => {
      const view = await mountReady();
      choose("More actions", "Open in Obsidian");
      expect(mocked.external).toHaveBeenCalledWith(obsidianUrl("/d.md"));
      mocked.external.mockRejectedValueOnce(new Error("no handler"));
      choose("More actions", "Open in Obsidian");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("Could not open Obsidian: no handler"));
    });

    it("refreshes the day and tells the note to refresh", async () => {
      const refresh = vi.fn();
      window.addEventListener("cchub:daily-refresh", refresh);
      await mountReady();
      const before = todayCalls();
      choose("More actions", "Refresh");
      await waitFor(() => expect(todayCalls()).toBeGreaterThan(before));
      expect(refresh).toHaveBeenCalledTimes(1);
      window.removeEventListener("cchub:daily-refresh", refresh);
    });

    it("refreshes when the note view asks for it", async () => {
      await mountReady();
      const before = todayCalls();
      act(() => {
        window.dispatchEvent(new CustomEvent("cchub:daily-refresh"));
      });
      await waitFor(() => expect(todayCalls()).toBeGreaterThan(before));
    });

    it("switches to the note tab on the plan event", async () => {
      await mountReady();
      act(() => {
        window.dispatchEvent(new CustomEvent("cchub:daily-plan-today"));
      });
      expect(screen.getByRole("tab", { name: "Note" }).getAttribute("aria-selected")).toBe("true");
    });
  });

  describe("live refresh", () => {
    beforeEach(() => {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(new Date(2026, 10, 16, 12, 0, 0));
    });

    const mountFake = async () => {
      mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByTestId("outliner")).toBeTruthy();
    };

    const advance = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    it("reloads shortly after a change of this day and ignores other days", async () => {
      await mountFake();
      const base = todayCalls();
      act(() => daily.emit({ date: "2026-01-01", updatedAt: 1, source: "disk", writeId: null }));
      await advance(400);
      expect(todayCalls()).toBe(base);
      act(() => daily.emit({ date: DAY, updatedAt: 1, source: "disk", writeId: null }));
      act(() => daily.emit({ date: DAY, updatedAt: 2, source: "disk", writeId: null }));
      await advance(400);
      expect(todayCalls()).toBe(base + 1);
    });

    it("reloads after a recovered stream of any day and after board changes", async () => {
      await mountFake();
      const base = todayCalls();
      act(() => daily.emit({ date: "2026-01-01", updatedAt: null, source: "disk", writeId: null, recovered: true }));
      await advance(400);
      expect(todayCalls()).toBe(base + 1);
      act(() => boardBus.emit({ source: "disk", projectId: "alpha" }));
      await advance(400);
      expect(todayCalls()).toBe(base + 2);
    });

    it("waits while the user is typing in the outliner", async () => {
      await mountFake();
      const base = todayCalls();
      const input = document.createElement("input");
      input.className = "outliner__input";
      document.body.appendChild(input);
      input.focus();
      act(() => boardBus.emit({ source: "disk", projectId: "alpha" }));
      await advance(300);
      expect(todayCalls()).toBe(base);
      await advance(700);
      expect(todayCalls()).toBe(base);
      input.blur();
      await advance(700);
      expect(todayCalls()).toBe(base + 1);
      input.remove();
    });

    it("stops listening when unmounted", async () => {
      const view = mount();
      await advance(10);
      expect(daily.listeners()).toBeGreaterThan(0);
      view.unmount();
      expect(daily.listeners()).toBe(0);
      expect(boardBus.listeners()).toBe(0);
    });
  });

  describe("focus section", () => {
    it("lists the focus items and the empty states", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ focus: [] }));
      mount();
      expect(await screen.findByText("Nothing in focus. Add a task or drag one from the backlog.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Focus actions" })).toBeNull();
    });

    it("collapses and expands everything from the focus menu and remembers it", async () => {
      await mountReady();
      click("Focus actions");
      expect((within(screen.getByRole("menu", { name: "Focus actions" })).getByRole("menuitem", { name: "Expand all" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(within(screen.getByRole("menu", { name: "Focus actions" })).getByRole("menuitem", { name: "Collapse all" }));
      expect(JSON.parse(window.localStorage.getItem(FOCUS_COLLAPSE_KEY) ?? "{}").projects).toEqual(["alpha"]);
      expect(JSON.parse(screen.getByTestId("collapse").textContent ?? "{}").projects).toEqual(["alpha"]);
      choose("Focus actions", "Expand all");
      expect(JSON.parse(window.localStorage.getItem(FOCUS_COLLAPSE_KEY) ?? "{}").projects).toEqual([]);
    });

    it("takes the collapse state back from the outliner and restores a stored one", async () => {
      window.localStorage.setItem(FOCUS_COLLAPSE_KEY, JSON.stringify({ projects: ["beta"], tasks: [] }));
      await mountReady();
      expect(JSON.parse(screen.getByTestId("collapse").textContent ?? "{}").projects).toEqual(["beta"]);
      click("collapse-change");
      expect(JSON.parse(screen.getByTestId("collapse").textContent ?? "{}").projects).toEqual(["alpha"]);
    });

    it("clears the day after confirming and offers an undo", async () => {
      await mountReady();
      choose("Focus actions", "Clear today");
      expect(screen.getByRole("dialog", { name: "Clear today?" })).toBeTruthy();
      expect(screen.getByText(/Removes the 2 task lines from the focus of the note/)).toBeTruthy();
      click("Clear");
      expect(mocked.clear).toHaveBeenCalledWith(DAY);
      expect(await screen.findByText("Cleared today: 2 lines out of the note, 1 date out of the projects")).toBeTruthy();
      click("Undo");
      await waitFor(() => expect(mocked.undo).toHaveBeenCalledWith(DAY, "tok"));
      await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    });

    it("cancels the confirmation without clearing", async () => {
      await mountReady();
      choose("Focus actions", "Clear today");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(mocked.clear).not.toHaveBeenCalled();
    });

    it("words the confirmation for one line and for another day", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ focus: [todayEntry(t2, "Alpha")] }));
      await mountReady();
      click("Next ›");
      await waitFor(() => expect(mocked.getToday).toHaveBeenLastCalledWith(TOMORROW));
      choose("Focus actions", "Clear this day");
      expect(screen.getByRole("dialog", { name: "Clear this day?" })).toBeTruthy();
      expect(screen.getByText(/Removes the task line from the focus/)).toBeTruthy();
    });

    it("dismisses the undo notice and lets it expire", async () => {
      await mountReady();
      choose("Focus actions", "Clear today");
      click("Clear");
      await screen.findByRole("status");
      click("Dismiss");
      expect(screen.queryByRole("status")).toBeNull();
      choose("Focus actions", "Clear today");
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(new Date(2026, 10, 16, 12, 0, 0));
      click("Clear");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.getByRole("status")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(21_000);
      });
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("shows the undo only for the day that was cleared", async () => {
      await mountReady();
      choose("Focus actions", "Clear today");
      click("Clear");
      await screen.findByRole("status");
      click("Next ›");
      await waitFor(() => expect(mocked.getToday).toHaveBeenLastCalledWith(TOMORROW));
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("reports failures to clear and to undo", async () => {
      mocked.clear.mockRejectedValueOnce(new Error("clear failed"));
      const view = await mountReady();
      choose("Focus actions", "Clear today");
      click("Clear");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("clear failed"));
      choose("Focus actions", "Clear today");
      click("Clear");
      await screen.findByRole("status");
      mocked.undo.mockRejectedValueOnce(new Error("undo failed"));
      click("Undo");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("undo failed"));
    });

    it("disables clearing when the focus follows the list or there is no note", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ focusSource: "list" }));
      await mountReady();
      click("Focus actions");
      expect((within(screen.getByRole("menu", { name: "Focus actions" })).getByRole("menuitem", { name: "Clear today" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("focus outliner callbacks", () => {
    const target = (task: BoardTask) => ({ projectId: task.projectId, line: task.line, raw: task.raw });

    it("renames with title and fields and sends only the fields when the title is unchanged", async () => {
      await mountReady();
      click("rename:t2");
      await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith(target(t2), { title: "Renamed", priority: 2, due: "2026-12-01" }));
      click("rename-same:t2");
      await waitFor(() => expect(mocked.patch).toHaveBeenLastCalledWith(target(t2), {}));
      await waitFor(() => expect(todayCalls()).toBeGreaterThanOrEqual(3));
    });

    it("creates after a root task scheduled for the day and after a covered subtask under its parent", async () => {
      await mountReady();
      click("create:t2");
      await waitFor(() => expect(mocked.create).toHaveBeenLastCalledWith({ projectId: "alpha", title: "Created", priority: 1, due: "2026-12-02", scheduled: DAY, after: { line: 6, raw: "- [-] Fix bug" } }));
      click("create-plain:s1");
      await waitFor(() =>
        expect(mocked.create).toHaveBeenLastCalledWith({ projectId: "alpha", title: "Plain", parentLine: 2, parentRaw: "- [ ] Write docs", after: { line: 3, raw: "  - [ ] Sub one" } }),
      );
    });

    it("surfaces a failed creation to the outliner", async () => {
      mocked.create.mockRejectedValueOnce(new Error("create failed"));
      await mountReady();
      click("create:t2");
      expect((await screen.findByRole("alert")).textContent).toBe("create:t2 failed: create failed");
    });

    it("indents under the previous sibling and ignores the first one", async () => {
      await mountReady();
      click("indent:t1");
      click("indent:t2");
      await waitFor(() => expect(mocked.reparent).toHaveBeenCalledTimes(1));
      expect(mocked.reparent).toHaveBeenCalledWith(target(t2), { line: 2, raw: "- [ ] Write docs" });
    });

    it("outdents a subtask to the project level and schedules it for the day", async () => {
      mocked.reparent.mockResolvedValue({ task: s1 });
      await mountReady();
      click("outdent:s1");
      await waitFor(() => expect(mocked.reparent).toHaveBeenCalledWith(target(s1), null));
      await waitFor(() => expect(mocked.schedule).toHaveBeenCalledWith(DAY, { ...target(s1), date: DAY }));
    });

    it("ignores outdent for a root task", async () => {
      await mountReady();
      click("outdent:t2");
      await settle();
      expect(mocked.reparent).not.toHaveBeenCalled();
    });

    it("outdents a nested subtask under a grandparent that is in the focus without rescheduling", async () => {
      const inner = boardTask("in1", "alpha", 9, { title: "Inner", depth: 2, raw: "    - [ ] Inner" });
      const mid = boardTask("mid", "alpha", 8, { title: "Mid", depth: 1, raw: "  - [ ] Mid", subtasks: [inner] });
      const root = boardTask("root", "alpha", 7, { title: "Root", scheduled: DAY, subtasks: [mid] });
      mocked.getBoard.mockResolvedValue(board({ tasks: [root, t3, t4] }));
      mocked.getToday.mockResolvedValue(dataOf({ focus: [todayEntry(root, "Alpha")] }));
      mocked.reparent.mockResolvedValue({ task: inner });
      await mountReady();
      click("outdent:in1");
      await waitFor(() => expect(mocked.reparent).toHaveBeenCalledWith(target(inner), { line: 7, raw: "- [ ] root" }));
      expect(mocked.schedule).not.toHaveBeenCalled();
    });

    it("moves a root task in the note and a nested one in its project, step by step", async () => {
      mocked.move.mockImplementation((moved) => Promise.resolve({ task: { ...t1, projectId: moved.projectId, line: moved.line + 1, raw: moved.raw } }));
      await mountReady();
      click("up:t2");
      await waitFor(() => expect(mocked.reorder).toHaveBeenCalledWith(DAY, { ...target(t2), direction: "up" }));
      click("down:s1");
      await waitFor(() => expect(mocked.move).toHaveBeenCalledTimes(2));
      expect(mocked.move.mock.calls[0]?.[0]).toEqual(target(s1));
      expect(mocked.move.mock.calls[0]?.[1]).toBe("down");
      expect(mocked.move.mock.calls[1]?.[0]).toMatchObject({ line: 4 });
      click("up:s1");
      await waitFor(() => expect(mocked.move).toHaveBeenCalledTimes(3));
    });

    it("toggles done both ways and tells about recurring tasks", async () => {
      mocked.patch.mockResolvedValue({ task: { ...t1, repeat: "every day" }, updatedAt: 1, moved: false, recurred: true });
      const view = await mountReady();
      click("done:t2");
      await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith(target(t2), { status: "done" }));
      await waitFor(() => expect(view.onNotice).toHaveBeenCalledWith(recurrenceNotice({ ...t1, repeat: "every day" })));
    });

    it("reopens a done task", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ focus: [todayEntry({ ...t2, status: "done" }, "Alpha")] }));
      await mountReady();
      click("done:t2");
      await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith(target(t2), { status: "todo" }));
    });

    it("starts and stops a task and ignores tasks that cannot change", async () => {
      await mountReady();
      click("doing:t1");
      await waitFor(() => expect(mocked.patch).toHaveBeenLastCalledWith(target(t1), { status: "doing" }));
      click("doing:t2");
      await waitFor(() => expect(mocked.patch).toHaveBeenLastCalledWith(target(t2), { status: "todo" }));
    });

    it("on yesterday ticks through the day of the note, not the project, and says so", async () => {
      mocked.getToday.mockImplementation((date) => Promise.resolve(date === YESTERDAY ? dataOf({ focus: [...focusEntries(), todayEntry({ ...t3, status: "done", checkbox: "done" }, "Beta")] }) : dataOf()));
      await mountReady();
      expect(screen.queryByText(/a tick closes the task on/)).toBeNull();
      click("‹ Previous");
      await waitFor(() => expect(mocked.getToday).toHaveBeenLastCalledWith(YESTERDAY));
      expect(await screen.findByText(`Yesterday: a tick closes the task on ${YESTERDAY} and writes this note first; scheduled dates stay as they are.`)).toBeTruthy();
      await screen.findByRole("button", { name: "done:t3" });
      click("done:t1");
      await waitFor(() => expect(mocked.tickDay).toHaveBeenCalledWith(YESTERDAY, { ...target(t1), status: "done" }));
      click("done:t3");
      await waitFor(() => expect(mocked.tickDay).toHaveBeenLastCalledWith(YESTERDAY, { ...target(t3), status: "todo" }));
      click("doing:t1");
      await waitFor(() => expect(mocked.tickDay).toHaveBeenLastCalledWith(YESTERDAY, { ...target(t1), status: "doing" }));
      click("doing:t2");
      await waitFor(() => expect(mocked.tickDay).toHaveBeenLastCalledWith(YESTERDAY, { ...target(t2), status: "todo" }));
      expect(mocked.patch).not.toHaveBeenCalled();
    });

    it("on the day before yesterday keeps ticking the project as before", async () => {
      await mountReady();
      click("‹ Previous");
      click("‹ Previous");
      await waitFor(() => expect(mocked.getToday).toHaveBeenLastCalledWith(DAY_BEFORE));
      await settle();
      expect(screen.queryByText(/a tick closes the task on/)).toBeNull();
      click("done:t1");
      await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith(target(t1), { status: "done" }));
      click("doing:t1");
      await waitFor(() => expect(mocked.patch).toHaveBeenLastCalledWith(target(t1), { status: "doing" }));
      expect(mocked.tickDay).not.toHaveBeenCalled();
    });

    it("does not toggle doing for a blocked task", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ focus: [todayEntry({ ...t2, status: "blocked" }, "Alpha")] }));
      await mountReady();
      click("doing:t2");
      await settle();
      expect(mocked.patch).not.toHaveBeenCalled();
    });

    it("adds a note, moves a task to tomorrow and unschedules through the root", async () => {
      await mountReady();
      click("note:t2");
      await waitFor(() => expect(mocked.addNote).toHaveBeenCalledWith(target(t2), "a note"));
      click("tomorrow:s1");
      await waitFor(() => expect(mocked.schedule).toHaveBeenLastCalledWith(DAY, { ...target(t1), date: TOMORROW }));
      click("unschedule:t2");
      await waitFor(() => expect(mocked.schedule).toHaveBeenLastCalledWith(DAY, { ...target(t2), date: null }));
    });

    it("opens a task from the outliner", async () => {
      await mountReady();
      click("open:t2");
      expect((await screen.findByTestId("drawer-task")).textContent).toBe("t2");
    });

    it("adds to a project and reports the plan", async () => {
      await mountReady();
      click("add-project");
      await waitFor(() => expect(mocked.create).toHaveBeenCalledWith({ projectId: "alpha", title: "Typed", scheduled: DAY }));
    });

    it("hides the add-to-project action when there are no projects", async () => {
      mocked.getBoard.mockResolvedValue(board({ projects: [] }));
      await mountReady();
      expect(screen.queryByRole("button", { name: "add-project" })).toBeNull();
    });

    it("opens and refreshes through the subtask picker", async () => {
      await mountReady();
      expect(screen.getByText(JSON.stringify({ open: 3, hidden: 1 }), { selector: "[data-plan=t1]" })).toBeTruthy();
      click("plan:t1");
      expect(screen.getByText(`picker:${DAY}:alpha:2:Write docs`)).toBeTruthy();
      const before = todayCalls();
      click("picker-changed");
      await waitFor(() => expect(todayCalls()).toBeGreaterThan(before));
      click("picker-close");
      expect(screen.queryByRole("dialog", { name: "Picker stub" })).toBeNull();
    });

    it("does not offer subtask planning for a day in the past", async () => {
      await mountReady();
      click("‹ Previous");
      await waitFor(() => expect(mocked.getToday).toHaveBeenLastCalledWith(YESTERDAY));
      expect(screen.queryByRole("button", { name: "plan:t1" })).toBeNull();
    });
  });

  describe("quick add", () => {
    const quickInput = (): HTMLInputElement => screen.getByRole("textbox", { name: "Add to focus" }) as HTMLInputElement;
    const type = (value: string) => fireEvent.change(quickInput(), { target: { value } });

    it("creates a task scheduled for the day with parsed priority and due date and remembers the project", async () => {
      await mountReady();
      fireEvent.change(screen.getByLabelText("Project for the task to add"), { target: { value: "beta" } });
      type("Brand new #p1 due:2026-12-05");
      fireEvent.keyDown(quickInput(), { key: "Enter" });
      await waitFor(() => expect(mocked.create).toHaveBeenCalledWith({ projectId: "beta", title: "Brand new", scheduled: DAY, priority: 1, due: "2026-12-05" }));
      await waitFor(() => expect(quickInput().value).toBe(""));
      expect(window.localStorage.getItem("hub.today.quickProject")).toBe("beta");
    });

    it("defaults to the first project of the saved order", async () => {
      await mountReady({ projectOrder: ["beta", "alpha"] });
      expect((screen.getByLabelText("Project for the task to add") as HTMLSelectElement).value).toBe("beta");
    });

    it("defaults to the stored project when it still exists", async () => {
      window.localStorage.setItem("hub.today.quickProject", "beta");
      await mountReady();
      expect((screen.getByLabelText("Project for the task to add") as HTMLSelectElement).value).toBe("beta");
    });

    it("schedules an existing open task with the same title", async () => {
      const view = await mountReady();
      fireEvent.change(screen.getByLabelText("Project for the task to add"), { target: { value: "beta" } });
      type("Backlog only");
      fireEvent.keyDown(quickInput(), { key: "Enter" });
      await waitFor(() => expect(mocked.schedule).toHaveBeenCalledWith(DAY, { projectId: "beta", line: 3, raw: "- [ ] Backlog only", date: DAY }));
      await waitFor(() => expect(view.onNotice).toHaveBeenCalledWith('Scheduled the existing task "Backlog only"'));
    });

    it("says when the task is already in focus", async () => {
      const view = await mountReady();
      type("Fix bug");
      fireEvent.keyDown(quickInput(), { key: "Enter" });
      await waitFor(() => expect(view.onNotice).toHaveBeenCalledWith('"Fix bug" is already in focus'));
      expect(mocked.create).not.toHaveBeenCalled();
    });

    it("shows a creation error and turns a conflict into the refresh notice", async () => {
      mocked.create.mockRejectedValueOnce(new Error("create failed"));
      await mountReady();
      type("Another");
      fireEvent.keyDown(quickInput(), { key: "Enter" });
      expect((await screen.findByText("create failed")).getAttribute("role")).toBe("alert");
      mocked.create.mockRejectedValueOnce(new BoardConflictError("changed", null));
      type("Another");
      fireEvent.keyDown(quickInput(), { key: "Enter" });
      expect(await screen.findByText("This task changed on disk, so Today was refreshed. Try again.")).toBeTruthy();
    });

    it("uses a generic error for a non-error failure", async () => {
      mocked.create.mockRejectedValueOnce("x");
      await mountReady();
      type("Another");
      fireEvent.keyDown(quickInput(), { key: "Enter" });
      expect(await screen.findByText("could not add the task")).toBeTruthy();
    });

    it("asks for a title when the text only holds tokens", async () => {
      await mountReady();
      type("#p1");
      fireEvent.keyDown(quickInput(), { key: "Enter" });
      expect(await screen.findByText("Type a task title")).toBeTruthy();
    });

    it("ignores an empty Enter and a composing Enter and clears with Escape or the clear button", async () => {
      await mountReady();
      fireEvent.keyDown(quickInput(), { key: "Enter" });
      expect(mocked.create).not.toHaveBeenCalled();
      type("Thing");
      fireEvent.keyDown(quickInput(), { key: "Enter", isComposing: true });
      expect(mocked.create).not.toHaveBeenCalled();
      fireEvent.keyDown(quickInput(), { key: "a" });
      fireEvent.keyDown(quickInput(), { key: "Escape" });
      expect(quickInput().value).toBe("");
      type("Thing");
      click("Clear");
      expect(quickInput().value).toBe("");
      expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    });

    it("focuses the field from the Add task button", async () => {
      await mountReady();
      click("Add task");
      await waitFor(() => expect(document.activeElement).toBe(quickInput()));
    });

    it("is hidden when there are no projects", async () => {
      mocked.getBoard.mockResolvedValue(board({ projects: [] }));
      await mountReady();
      expect(screen.queryByRole("textbox", { name: "Add to focus" })).toBeNull();
    });
  });

  describe("changed in the note", () => {
    const item = { line: "- [x] Fix bug", taskTitle: "Fix bug", projectId: "alpha", dailyCheckbox: "done" as const, projectStatus: "doing" as const };

    it("applies the note status to the task", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ outOfSync: [item] }));
      await mountReady();
      expect(screen.getByText(/Task "Fix bug" is doing, the note says done\./)).toBeTruthy();
      click("Use note");
      await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith({ projectId: "alpha", line: 6, raw: "- [-] Fix bug" }, { status: "done" }));
    });

    it("reports a failure applying the note", async () => {
      mocked.patch.mockRejectedValueOnce(new Error("patch failed"));
      mocked.getToday.mockResolvedValue(dataOf({ outOfSync: [item] }));
      const view = await mountReady();
      click("Use note");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("patch failed"));
    });

    it("keeps the task and remembers the choice", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ outOfSync: [item] }));
      await mountReady();
      click("Keep task");
      expect(screen.queryByText("Changed in the note - check status")).toBeNull();
      expect(JSON.parse(window.localStorage.getItem("hub.today.keptTasks") ?? "[]")).toHaveLength(1);
    });

    it("hides a task that was kept before and forgets it once it is back in sync", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ outOfSync: [item] }));
      window.localStorage.setItem("hub.today.keptTasks", JSON.stringify(["alpha\u0000Fix bug\u0000- [x] Fix bug", "stale"]));
      await mountReady();
      expect(screen.queryByText("Changed in the note - check status")).toBeNull();
      await waitFor(() => expect(JSON.parse(window.localStorage.getItem("hub.today.keptTasks") ?? "[]")).toEqual(["alpha\u0000Fix bug\u0000- [x] Fix bug"]));
    });

    it("disables Use note for a recurring task already completed and for an unknown task", async () => {
      mocked.getToday.mockResolvedValue(
        dataOf({ outOfSync: [{ ...item, reason: "recurring-done" }, { ...item, taskTitle: "Ghost", line: "- [x] Ghost" }] }),
      );
      await mountReady();
      expect(screen.getByText(/was already completed today/)).toBeTruthy();
      const buttons = screen.getAllByRole("button", { name: "Use note" }) as HTMLButtonElement[];
      expect(buttons.map((button) => button.disabled)).toEqual([true, true]);
    });
  });

  describe("note lines without a task", () => {
    const tick = {
      line: "- [ ] Ship release",
      lineIndex: 7,
      section: "Focus",
      checkbox: "todo" as const,
      candidates: [{ projectId: "alpha", line: 2, raw: "- [ ] Write docs", title: "Write docs" }],
    };

    it("links a line to one of the suggested tasks", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ unmatched: [tick] }));
      await mountReady();
      expect(screen.getByText("In the note, no matching task").closest("h3")?.textContent).toContain("1");
      expect(screen.getByText(/Ship release/)).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Link "Ship release" to a task'), { target: { value: "0" } });
      await waitFor(() =>
        expect(mocked.tick).toHaveBeenCalledWith(DAY, { lineIndex: 7, raw: "- [ ] Ship release", target: { projectId: "alpha", line: 2, raw: "- [ ] Write docs" }, action: "apply" }),
      );
    });

    it("dismisses a line with Ignore and reports failures", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ unmatched: [tick] }));
      const view = await mountReady();
      click("Ignore");
      await waitFor(() => expect(mocked.tick).toHaveBeenCalledWith(DAY, { lineIndex: 7, raw: "- [ ] Ship release", target: null, action: "dismiss" }));
      mocked.tick.mockRejectedValueOnce(new Error("tick failed"));
      click("Ignore");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("tick failed"));
      mocked.tick.mockRejectedValueOnce(new BoardConflictError("changed", null));
      fireEvent.change(screen.getByLabelText('Link "Ship release" to a task'), { target: { value: "0" } });
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("This task changed on disk, so Today was refreshed. Try again."));
    });

    it("searches for another task, links the pick and can cancel or escape", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ unmatched: [tick] }));
      await mountReady();
      const select = screen.getByLabelText('Link "Ship release" to a task');
      fireEvent.change(select, { target: { value: "other" } });
      const search = screen.getByLabelText("Search tasks to link") as HTMLInputElement;
      expect(screen.getByRole("list", { name: "Open tasks" })).toBeTruthy();
      fireEvent.change(search, { target: { value: "zzz" } });
      expect(screen.getByText("No task matches.")).toBeTruthy();
      fireEvent.keyDown(search, { key: "x" });
      fireEvent.keyDown(search, { key: "Escape" });
      expect(screen.queryByLabelText("Search tasks to link")).toBeNull();
      fireEvent.change(select, { target: { value: "other" } });
      fireEvent.change(screen.getByLabelText("Search tasks to link"), { target: { value: "backlog" } });
      fireEvent.click(within(screen.getByRole("list", { name: "Open tasks" })).getByRole("button", { name: /Backlog only/ }));
      await waitFor(() =>
        expect(mocked.tick).toHaveBeenCalledWith(DAY, { lineIndex: 7, raw: "- [ ] Ship release", target: { projectId: "beta", line: 3, raw: "- [ ] Backlog only" }, action: "apply" }),
      );
      fireEvent.change(select, { target: { value: "other" } });
      fireEvent.click(within(screen.getByLabelText("Search tasks to link").parentElement as HTMLElement).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByLabelText("Search tasks to link")).toBeNull();
    });

    it("offers recently done tasks and a count when the list is long", async () => {
      const doneTask = boardTask("d1", "alpha", 30, { title: "Shipped earlier", section: "done", status: "done", doneAt: "2026-11-14" });
      mocked.getBoard.mockResolvedValue(board({ tasks: [t1, t2, t3, t4, doneTask] }));
      mocked.getToday.mockResolvedValue(dataOf({ unmatched: [tick] }));
      await mountReady();
      fireEvent.change(screen.getByLabelText('Link "Ship release" to a task'), { target: { value: "other" } });
      const finished = screen.getByRole("list", { name: "Recently done tasks" });
      fireEvent.click(within(finished).getByRole("button", { name: /Shipped earlier/ }));
      await waitFor(() => expect(mocked.tick).toHaveBeenCalledWith(DAY, expect.objectContaining({ target: { projectId: "alpha", line: 30, raw: "- [ ] d1" } })));
    });

    it("shows how many tasks match when there are more than listed", async () => {
      const many = Array.from({ length: 35 }, (_unused, index) => boardTask(`m${index}`, "alpha", 100 + index, { title: `Many ${index}` }));
      mocked.getBoard.mockResolvedValue(board({ tasks: [t1, t2, t3, t4, ...many] }));
      mocked.getToday.mockResolvedValue(dataOf({ unmatched: [tick] }));
      await mountReady();
      fireEvent.change(screen.getByLabelText('Link "Ship release" to a task'), { target: { value: "other" } });
      expect(screen.getByText(/Showing 30 of 42/)).toBeTruthy();
    });

    it("creates a task from a line in its own project", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ inNoteLinks: [{ line: "- [ ] Alpha - Loose idea", taskId: null }] }));
      const view = await mountReady();
      click("Create task");
      await waitFor(() => expect(mocked.create).toHaveBeenCalledWith({ projectId: "alpha", title: "Loose idea", scheduled: DAY }));
      await waitFor(() => expect(view.onNotice).toHaveBeenCalledWith('Created "Loose idea" for today'));
      expect(window.localStorage.getItem("hub.today.quickProject")).toBe("alpha");
    });

    it("asks for the project when the line has none, then creates or cancels", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ inNoteLinks: [{ line: "- [ ] Loose idea", taskId: null }] }));
      await mountReady();
      click("Create task");
      fireEvent.change(screen.getByLabelText("Project for the new task"), { target: { value: "beta" } });
      click("Cancel");
      expect(screen.queryByLabelText("Project for the new task")).toBeNull();
      click("Create task");
      fireEvent.change(screen.getByLabelText("Project for the new task"), { target: { value: "beta" } });
      click("Create");
      await waitFor(() => expect(mocked.create).toHaveBeenCalledWith({ projectId: "beta", title: "Loose idea", scheduled: DAY }));
    });

    it("preselects the stored project and reports a creation failure", async () => {
      window.localStorage.setItem("hub.today.quickProject", "beta");
      mocked.create.mockRejectedValueOnce(new Error("create failed"));
      mocked.getToday.mockResolvedValue(dataOf({ inNoteLinks: [{ line: "- [ ] Loose idea", taskId: null }] }));
      const view = await mountReady();
      click("Create task");
      expect((screen.getByLabelText("Project for the new task") as HTMLSelectElement).value).toBe("beta");
      click("Create");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("create failed"));
    });

    it("shows the children of a line and the hint of an ambiguous one", async () => {
      mocked.getToday.mockResolvedValue(
        dataOf({
          noteBlocks: [{ line: "- [ ] Loose idea", lineIndex: 9, taskId: null, projectId: null, text: null, children: ["  - first detail"] }],
          ambiguous: [
            { kind: "line", text: "- [ ] Loose idea", line: 9, taskId: null, reason: "same-title" },
            { kind: "line", text: "- [ ] Mystery line", line: null, taskId: null, reason: "unclear-line" },
          ],
        }),
      );
      await mountReady();
      expect(screen.getByText("first detail")).toBeTruthy();
      expect(screen.getByText(/Another task has the same title/)).toBeTruthy();
      expect(screen.getByText(/A line in the note could mean this task or another one/)).toBeTruthy();
      expect(screen.getByText("In the note, no matching task").closest("h3")?.textContent).toContain("2");
    });

    it("limits the actions on a past day", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ inNoteLinks: [{ line: "- [ ] Loose idea", taskId: null }], unmatched: [tick] }));
      await mountReady();
      click("‹ Previous");
      await waitFor(() => expect(mocked.getToday).toHaveBeenLastCalledWith(YESTERDAY));
      expect(screen.queryByRole("button", { name: "Create task" })).toBeNull();
      expect(screen.getByLabelText('Link "Ship release" to a task')).toBeTruthy();
    });
  });

  describe("also in the note", () => {
    const t5 = boardTask("t5", "beta", 4, { title: "Another loose", raw: "- [ ] Another loose" });

    beforeEach(() => {
      mocked.getBoard.mockResolvedValue(board({ tasks: [t1, t2, t3, t4, t5] }));
    });

    const linkedData = () =>
      dataOf({
        noteBlocks: [
          { line: "- [ ] Alpha - Backlog only", lineIndex: 4, taskId: "t4", projectId: "alpha", text: "Backlog only", children: ["  - child detail"] },
          { line: "- [ ] Another loose", lineIndex: 5, taskId: "t5", projectId: null, text: null, children: [] },
          { line: "- [ ] Scheduled elsewhere", lineIndex: 6, taskId: "t3", projectId: null, text: null, children: [] },
          { line: "- [-] Fix bug", lineIndex: 7, taskId: "t2", projectId: null, text: null, children: [] },
        ],
      });

    it("adds one linked task or all of them to the focus", async () => {
      mocked.getToday.mockResolvedValue(linkedData());
      await mountReady();
      const section = screen.getByText(/Also in the note \(4\)/).closest("details") as HTMLElement;
      expect(within(section).getByText("child detail")).toBeTruthy();
      expect(within(section).getByText("Scheduled 2026-11-15")).toBeTruthy();
      expect(within(section).getAllByRole("img", { name: /To-do|Doing/ }).length).toBeGreaterThan(0);
      fireEvent.click(within(section).getByRole("button", { name: 'Add "Backlog only" to focus' }));
      await waitFor(() => expect(mocked.schedule).toHaveBeenCalledWith(DAY, { projectId: "beta", line: 3, raw: "- [ ] Backlog only", date: DAY }));
      fireEvent.click(within(section).getByRole("button", { name: "Add all (2)" }));
      await waitFor(() => expect(mocked.schedule).toHaveBeenCalledTimes(3));
    });

    it("stops adding after a failure and reports it", async () => {
      mocked.getToday.mockResolvedValue(linkedData());
      mocked.schedule.mockRejectedValue(new Error("no write"));
      const view = await mountReady();
      fireEvent.click(screen.getByRole("button", { name: "Add all (2)" }));
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("no write"));
      expect(mocked.schedule).toHaveBeenCalledTimes(1);
    });

    it("offers no add actions when the focus follows the list", async () => {
      mocked.getToday.mockResolvedValue({ ...linkedData(), focusSource: "list" });
      await mountReady();
      expect(screen.queryByRole("button", { name: /^Add all/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /to focus$/ })).toBeNull();
    });
  });

  describe("meetings, captures, summary and sessions", () => {
    it("adds a meeting with Enter, trims it and clears the field", async () => {
      await mountReady();
      const input = screen.getByLabelText("Add meeting") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "  Standup  " } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(mocked.meeting).toHaveBeenCalledWith(DAY, "Standup"));
      await waitFor(() => expect(input.value).toBe(""));
    });

    it("ignores empty, composing and unrelated input and clears with Escape", async () => {
      await mountReady();
      const input = screen.getByLabelText("Add meeting") as HTMLInputElement;
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.change(input, { target: { value: "x" } });
      fireEvent.keyDown(input, { key: "Enter", isComposing: true });
      fireEvent.keyDown(input, { key: "a" });
      expect(mocked.meeting).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: "Escape" });
      expect(input.value).toBe("");
    });

    it("shows the error of a failed capture and keeps the text", async () => {
      mocked.capture.mockRejectedValueOnce(new Error("capture failed"));
      await mountReady();
      const input = screen.getByLabelText("Add capture") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "idea" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect((await screen.findByText("capture failed")).getAttribute("role")).toBe("alert");
      expect(input.value).toBe("idea");
      mocked.capture.mockRejectedValueOnce("x");
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await screen.findByText("Something went wrong")).toBeTruthy();
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByText("Something went wrong")).toBeNull();
    });

    it("lists meetings and captures and promotes a capture into a project", async () => {
      mocked.getToday.mockResolvedValue(
        dataOf({
          meetings: ["Standup at 10"],
          captures: [
            { line: 11, raw: "- idea one", text: "idea one", promotedTo: null },
            { line: 12, raw: "- idea two", text: "idea two", promotedTo: "Alpha" },
          ],
        }),
      );
      await mountReady();
      expect(screen.getByText("Standup at 10")).toBeTruthy();
      expect(screen.getByTitle("Promoted to a task").textContent).toContain("Alpha");
      click("Promote to task");
      fireEvent.change(screen.getByLabelText("Project for the new task"), { target: { value: "beta" } });
      fireEvent.click(screen.getByLabelText("Schedule for today"));
      click("Promote");
      await waitFor(() => expect(mocked.promote).toHaveBeenCalledWith(DAY, { line: 11, raw: "- idea one", projectId: "beta", schedule: false }));
      expect(window.localStorage.getItem("hub.today.promoteProject")).toBe("beta");
      await waitFor(() => expect(screen.queryByRole("button", { name: "Promote" })).toBeNull());
    });

    it("preselects the stored promote project, can cancel and shows the failure", async () => {
      window.localStorage.setItem("hub.today.promoteProject", "beta");
      mocked.promote.mockRejectedValueOnce(new Error("promote failed"));
      mocked.getToday.mockResolvedValue(dataOf({ captures: [{ line: 11, raw: "- idea one", text: "idea one", promotedTo: null }] }));
      await mountReady();
      click("Promote to task");
      expect((screen.getByLabelText("Project for the new task") as HTMLSelectElement).value).toBe("beta");
      click("Cancel");
      expect(screen.queryByLabelText("Project for the new task")).toBeNull();
      click("Promote to task");
      click("Promote");
      expect((await screen.findByText("promote failed")).getAttribute("role")).toBe("alert");
    });

    it("disables promotion while the board has no projects", async () => {
      mocked.getBoard.mockResolvedValue(board({ projects: [] }));
      mocked.getToday.mockResolvedValue(dataOf({ captures: [{ line: 11, raw: "- idea one", text: "idea one", promotedTo: null }] }));
      await mountReady();
      expect((screen.getByRole("button", { name: "Promote to task" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("words the schedule checkbox for another day", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ captures: [{ line: 11, raw: "- idea one", text: "idea one", promotedTo: null }] }));
      await mountReady();
      click("Next ›");
      await waitFor(() => expect(mocked.getToday).toHaveBeenLastCalledWith(TOMORROW));
      click("Promote to task");
      expect(screen.getByLabelText("Schedule for this day")).toBeTruthy();
    });

    it("tells when the day has no note and shows the summary and sessions when present", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ dailyExists: false, summary: "  Shipped the outliner  " }));
      dv.sessions = [
        { sessionId: "abcdef123456", title: null, client: "claude", status: "done" },
        { sessionId: "s2", title: "Pairing", client: null, status: "running" },
      ];
      const view = mount();
      await screen.findByLabelText("Start stub");
      click("‹ Previous");
      await screen.findByText(/No note for this day yet/);
      expect(screen.getByText("Summary")).toBeTruthy();
      expect(screen.getByText("Shipped the outliner")).toBeTruthy();
      expect(screen.getByText("Sessions today (2)")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "abcdef12" }));
      expect(view.onOpenSession).toHaveBeenCalledWith("abcdef123456");
      expect(screen.getByText("claude")).toBeTruthy();
      expect(screen.getByText("running")).toBeTruthy();
    });

    it("shows none yet without sessions and hides an empty summary", async () => {
      mocked.getToday.mockResolvedValue(dataOf({ summary: "   " }));
      await mountReady();
      expect(screen.getByText("none yet")).toBeTruthy();
      expect(screen.queryByText("Summary")).toBeNull();
    });
  });

  describe("day summary", () => {
    it("opens the summary dialog, forwards its notices and closes it", async () => {
      const view = await mountReady();
      click("Day summary");
      expect(screen.getByText(`summary-for:${DAY}`)).toBeTruthy();
      click("summary-notice");
      expect(view.onNotice).toHaveBeenCalledWith("summary noted");
      click("summary-close");
      expect(screen.queryByRole("dialog", { name: "Summary stub" })).toBeNull();
    });
  });

  describe("backlog", () => {
    it("passes the backlog its tasks, the focus ids and the carried ids", async () => {
      await mountReady();
      expect(screen.getByTestId("backlog-info").textContent).toBe(`4|t3|t1,s1,s2,s3,t2|${DAY}|`);
    });

    it("schedules for the viewed day or tomorrow and opens a task", async () => {
      await mountReady();
      click("backlog-schedule");
      await waitFor(() => expect(mocked.schedule).toHaveBeenLastCalledWith(DAY, { projectId: "alpha", line: 2, raw: "- [ ] Write docs", date: DAY }));
      click("backlog-tomorrow");
      await waitFor(() => expect(mocked.schedule).toHaveBeenLastCalledWith(DAY, expect.objectContaining({ date: TOMORROW })));
      click("backlog-open");
      expect((await screen.findByTestId("drawer-task")).textContent).toBe("t1");
    });

    it("completes a task and tells about a recurring one", async () => {
      mocked.patch.mockResolvedValue({ task: { ...t1, repeat: "every day" }, updatedAt: 1, moved: false, recurred: true });
      const view = await mountReady();
      click("backlog-done");
      await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith({ projectId: "alpha", line: 2, raw: "- [ ] Write docs" }, { status: "done" }));
      await waitFor(() => expect(view.onNotice).toHaveBeenCalled());
      mocked.patch.mockRejectedValueOnce(new Error("cannot complete"));
      click("backlog-done");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("cannot complete"));
    });

    it("starts a task from the backlog and reports a failure", async () => {
      const view = await mountReady();
      click("backlog-doing");
      await waitFor(() => expect(mocked.patch).toHaveBeenCalledWith({ projectId: "alpha", line: 2, raw: "- [ ] Write docs" }, { status: "doing" }));
      mocked.patch.mockRejectedValueOnce(new Error("cannot start"));
      click("backlog-doing");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("cannot start"));
    });

    it("does not start a task that is not todo or doing", async () => {
      mocked.getBoard.mockResolvedValue(board({ tasks: [{ ...t1, status: "blocked" }, t2, t3, t4] }));
      await mountReady();
      click("backlog-doing");
      await settle();
      expect(mocked.patch).not.toHaveBeenCalled();
    });

    it("marks the focus as a drop target while dragging from the backlog", async () => {
      await mountReady();
      const focus = screen.getByRole("region", { name: "Focus" });
      click("backlog-drag-on");
      expect(focus.className).toContain("today__focus--target");
      click("backlog-drag-off");
      expect(focus.className).not.toContain("today__focus--target");
    });
  });

  describe("dropping onto the focus", () => {
    const payload = JSON.stringify({ projectId: "beta", line: 3, raw: "- [ ] Backlog only" });

    it("highlights on drag over, clears on leave and schedules the dropped task", async () => {
      await mountReady();
      const focus = screen.getByRole("region", { name: "Focus" });
      fireEvent.dragOver(focus, { dataTransfer: dragTransfer(payload) });
      expect(focus.className).toContain("today__focus--over");
      fireEvent(focus, new MouseEvent("dragleave", { bubbles: true, relatedTarget: focus.querySelector("h3") }));
      expect(focus.className).toContain("today__focus--over");
      fireEvent.dragLeave(focus, { relatedTarget: null });
      expect(focus.className).not.toContain("today__focus--over");
      fireEvent.dragOver(focus, { dataTransfer: dragTransfer(payload) });
      fireEvent.drop(focus, { dataTransfer: dragTransfer(payload) });
      await waitFor(() => expect(mocked.schedule).toHaveBeenCalledWith(DAY, { projectId: "beta", line: 3, raw: "- [ ] Backlog only", date: DAY }));
      expect(focus.className).not.toContain("today__focus--over");
    });

    it("ignores drags of other things, empty drops and broken payloads", async () => {
      await mountReady();
      const focus = screen.getByRole("region", { name: "Focus" });
      fireEvent.dragOver(focus, { dataTransfer: dragTransfer(payload, ["text/plain"]) });
      expect(focus.className).not.toContain("today__focus--over");
      fireEvent.drop(focus, { dataTransfer: dragTransfer("") });
      fireEvent.drop(focus, { dataTransfer: dragTransfer("{broken") });
      await settle();
      expect(mocked.schedule).not.toHaveBeenCalled();
    });

    it("reports a failed drop", async () => {
      mocked.schedule.mockRejectedValueOnce(new Error("drop failed"));
      const view = await mountReady();
      fireEvent.drop(screen.getByRole("region", { name: "Focus" }), { dataTransfer: dragTransfer(payload) });
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("drop failed"));
    });
  });

  describe("task drawer", () => {
    const target = (task: BoardTask) => ({ projectId: task.projectId, line: task.line, raw: task.raw });

    beforeEach(() => {
      mocked.patch.mockResolvedValue({ task: t2, updatedAt: 1, moved: false });
    });

    const openDrawer = async (id = "t2") => {
      const view = await mountReady();
      if (id === "t3") fireEvent.click(within(screen.getByRole("region", { name: "Carried over" })).getByRole("button", { name: "Carried task" }));
      else click(`open:${id}`);
      await screen.findByTestId("drawer-task");
      return view;
    };

    it("shows the task with its flags and closes", async () => {
      await openDrawer();
      expect(screen.getByTestId("drawer-flags").textContent).toBe(`true|true|false|null|false|false|false|Schedule for ${DAY}|Alpha|3`);
      click("drawer-close");
      expect(screen.queryByTestId("drawer-task")).toBeNull();
    });

    it("writes status, title, reason, priority and dates and skips no-op changes", async () => {
      await openDrawer();
      click("drawer-status-same");
      click("drawer-rename-same");
      click("drawer-priority-same");
      await settle();
      expect(mocked.patch).not.toHaveBeenCalled();
      click("drawer-status-done");
      await waitFor(() => expect(mocked.patch).toHaveBeenLastCalledWith(target(t2), { status: "done" }));
      click("drawer-rename");
      await waitFor(() => expect(mocked.patch).toHaveBeenLastCalledWith(target(t2), { title: "Renamed task" }));
      click("drawer-reason");
      await waitFor(() => expect(mocked.patch).toHaveBeenLastCalledWith(target(t2), { reason: "because" }));
      click("drawer-priority");
      await waitFor(() => expect(mocked.patch).toHaveBeenLastCalledWith(target(t2), { priority: 2 }));
      click("drawer-dates");
      await waitFor(() => expect(mocked.patch).toHaveBeenLastCalledWith(target(t2), { due: "2026-12-01" }));
    });

    it("tells about a recurring completion and follows the task after the refresh", async () => {
      mocked.patch.mockResolvedValue({ task: { ...t2, repeat: "every day" }, updatedAt: 1, moved: false, recurred: true });
      const view = await openDrawer();
      click("drawer-status-done");
      await waitFor(() => expect(view.onNotice).toHaveBeenCalledWith(recurrenceNotice({ ...t2, repeat: "every day" })));
      await waitFor(() => expect(screen.getByTestId("drawer-task").textContent).toBe("t2"));
    });

    it("refreshes and explains a conflict, and reports other write errors", async () => {
      mocked.patch.mockRejectedValueOnce(new BoardConflictError("changed", null));
      const view = await openDrawer();
      click("drawer-status-done");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("This task changed on disk, so the board was refreshed. Try again."));
      mocked.patch.mockRejectedValueOnce(new Error("write failed"));
      click("drawer-status-done");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("write failed"));
      mocked.patch.mockRejectedValueOnce("x");
      click("drawer-status-done");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("could not update the task"));
    });

    it("adds, edits and deletes notes with validation and error handling", async () => {
      const view = await openDrawer();
      click("drawer-note-add");
      await waitFor(() => expect(mocked.addNote).toHaveBeenCalledWith(target(t2), "a fresh note"));
      await waitFor(() => expect(screen.getByTestId("drawer-outcome").textContent).toBe("true"));
      click("drawer-note-add-bad");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("Write the note first"));
      await waitFor(() => expect(screen.getByTestId("drawer-outcome").textContent).toBe("false"));
      click("drawer-note-edit");
      await waitFor(() => expect(mocked.editNote).toHaveBeenCalledWith({ projectId: "alpha", line: 40, raw: "  - old note" }, "edited"));
      click("drawer-note-edit-bad");
      await waitFor(() => expect(view.onError).toHaveBeenCalledTimes(2));
      click("drawer-note-delete");
      await waitFor(() => expect(mocked.deleteNote).toHaveBeenCalledWith({ projectId: "alpha", line: 40, raw: "  - old note" }));
    });

    it("reports note failures and conflicts", async () => {
      const view = await openDrawer();
      mocked.deleteNote.mockRejectedValueOnce(new Error("no delete"));
      click("drawer-note-delete");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("no delete"));
      mocked.deleteNote.mockRejectedValueOnce(new BoardConflictError("changed", null));
      click("drawer-note-delete");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("This task changed on disk, so the board was refreshed. Try again."));
      mocked.deleteNote.mockRejectedValueOnce("x");
      click("drawer-note-delete");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("could not update the note"));
    });

    it("moves the task and notes through the organize actions", async () => {
      mocked.move.mockResolvedValue({ task: t2 });
      await openDrawer();
      click("drawer-move-up");
      await waitFor(() => expect(mocked.move).toHaveBeenLastCalledWith(target(t2), "up"));
      click("drawer-move-note");
      await waitFor(() => expect(mocked.move).toHaveBeenLastCalledWith({ projectId: "alpha", line: 40, raw: "  - old note" }, "down"));
    });

    it("promotes a subtask to a task with a notice", async () => {
      mocked.reparent.mockResolvedValue({ task: t2 });
      const view = await openDrawer();
      click("drawer-promote");
      await waitFor(() => expect(mocked.reparent).toHaveBeenCalledWith(target(t2), null));
      await waitFor(() => expect(view.onNotice).toHaveBeenCalledWith('Promoted "Fix bug" to a task'));
    });

    it("reports when the organized task cannot be found again and when organizing fails", async () => {
      const view = await openDrawer();
      mocked.move.mockResolvedValueOnce({ task: { ...t2, id: "gone", title: "Vanished" } });
      mocked.getBoard.mockResolvedValueOnce(board({ tasks: [t1, t3, t4] }));
      click("drawer-move-up");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("The change was saved, but the task could not be found again"));
    });

    it("explains conflicts and failures while organizing", async () => {
      const view = await openDrawer();
      mocked.move.mockRejectedValueOnce(new BoardConflictError("changed", null));
      click("drawer-move-up");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("This task changed on disk, so the board was refreshed. Try again."));
      mocked.move.mockRejectedValueOnce(new Error("move failed"));
      click("drawer-move-up");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("move failed"));
      mocked.move.mockRejectedValueOnce("x");
      click("drawer-move-up");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("could not organize the task"));
    });

    it("makes a task a subtask through the parent picker", async () => {
      mocked.reparent.mockResolvedValue({ task: t2 });
      const view = await openDrawer();
      click("drawer-make-subtask");
      expect(screen.getByText(/parent-candidates:/).textContent).toContain("t1");
      click("parent-pick");
      await waitFor(() => expect(mocked.reparent).toHaveBeenCalledWith(target(t2), { line: 2, raw: "- [ ] Write docs" }));
      await waitFor(() => expect(view.onNotice).toHaveBeenCalledWith('Moved "Fix bug" under "Write docs"'));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Parent picker stub" })).toBeNull());
    });

    it("cancels the parent picker", async () => {
      await openDrawer();
      click("drawer-make-subtask");
      click("parent-cancel");
      expect(screen.queryByRole("dialog", { name: "Parent picker stub" })).toBeNull();
    });

    it("moves a task to another project with or without a parent", async () => {
      mocked.moveProject.mockResolvedValue({ task: t2 });
      const view = await openDrawer();
      click("drawer-move-project");
      expect(screen.getByText("move-projects:beta")).toBeTruthy();
      click("move-pick-root");
      await waitFor(() => expect(mocked.moveProject).toHaveBeenLastCalledWith(target(t2), "beta", null));
      await waitFor(() => expect(view.onNotice).toHaveBeenCalledWith('Moved "Fix bug" to Beta'));
      click("drawer-move-project");
      click("move-pick-parent");
      await waitFor(() => expect(mocked.moveProject).toHaveBeenLastCalledWith(target(t2), "beta", { line: 6, raw: "- [-] Fix bug" }));
      click("drawer-move-project");
      click("move-cancel");
      expect(screen.queryByRole("dialog", { name: "Move picker stub" })).toBeNull();
    });

    it("closes a picker whose task disappeared", async () => {
      await openDrawer();
      click("drawer-make-subtask");
      mocked.getBoard.mockResolvedValue(board({ tasks: [t1, t3, t4] }));
      const before = todayCalls();
      click("drawer-priority");
      await waitFor(() => expect(todayCalls()).toBeGreaterThan(before));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Parent picker stub" })).toBeNull());
    });

    it("schedules the task for the day from the drawer", async () => {
      const view = await openDrawer("t3");
      click("drawer-today-add");
      await waitFor(() => expect(mocked.schedule).toHaveBeenCalledWith(DAY, { ...target(t3), date: DAY }));
      mocked.schedule.mockRejectedValueOnce(new Error("no write"));
      click("drawer-add-today");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("no write"));
      mocked.schedule.mockRejectedValueOnce("x");
      click("drawer-add-today");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("could not schedule the task"));
    });

    it("opens the project in Obsidian and in the editor with error reporting", async () => {
      const view = await openDrawer();
      click("drawer-obsidian");
      expect(mocked.external).toHaveBeenCalledWith(obsidianUrl("/vault/alpha.md"));
      mocked.external.mockRejectedValueOnce(new Error("no handler"));
      click("drawer-obsidian");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("Could not open Obsidian: no handler"));
      click("drawer-editor");
      await waitFor(() => expect(mocked.openEditor).toHaveBeenCalledWith("alpha"));
      mocked.openEditor.mockResolvedValueOnce({ ok: false, error: "missing code", command: "code" });
      click("drawer-editor");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("Could not open the editor: missing code"));
      mocked.openEditor.mockResolvedValueOnce({ ok: false, error: null, command: "code ." });
      click("drawer-editor");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("Could not open the editor: code ."));
      mocked.openEditor.mockRejectedValueOnce(new Error("offline"));
      click("drawer-editor");
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("Could not open the editor: offline"));
    });

    it("creates a subtask through the new task dialog and handles conflicts", async () => {
      const view = await openDrawer();
      click("drawer-add-subtask");
      expect(screen.getByText("new-task:alpha:t2")).toBeTruthy();
      click("create-submit");
      await waitFor(() => expect(mocked.create).toHaveBeenCalledWith({ projectId: "alpha", title: "New sub", parentLine: 6, parentRaw: "- [-] Fix bug" }));
      await waitFor(() => expect(view.onNotice).toHaveBeenCalledWith('Created "New sub"'));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task stub" })).toBeNull());
      click("drawer-add-subtask");
      mocked.create.mockRejectedValueOnce(new BoardConflictError("changed", null));
      click("create-submit");
      expect((await screen.findByRole("alert")).textContent).toContain("changed");
      click("create-cancel");
      expect(screen.queryByRole("dialog", { name: "New task stub" })).toBeNull();
    });

    it("delegates the task with and without a repository", async () => {
      const view = await openDrawer();
      click("drawer-delegate");
      expect(screen.getByText("delegate:t2")).toBeTruthy();
      click("delegate-submit");
      await waitFor(() => expect(mocked.delegate).toHaveBeenLastCalledWith({ ...target(t2), workspace: "ws", prompt: "do it", runner: "claude", repo: "repo-a" }));
      await waitFor(() => expect(view.onDelegated).toHaveBeenCalledWith("run-1", "Fix bug"));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delegate stub" })).toBeNull());
      click("drawer-delegate");
      mocked.delegate.mockResolvedValueOnce({ taskId: "run-2", task: t2, warning: "the worktree is dirty" });
      click("delegate-submit-norepo");
      await waitFor(() => expect(mocked.delegate).toHaveBeenLastCalledWith({ ...target(t2), workspace: "ws", prompt: "do it", runner: "codex" }));
      await waitFor(() => expect(view.onError).toHaveBeenCalledWith("Delegated, but the worktree is dirty"));
    });

    it("keeps the delegate dialog open with a notice when the task changed on disk", async () => {
      await openDrawer();
      click("drawer-delegate");
      mocked.delegate.mockRejectedValueOnce(new BoardConflictError("changed", null));
      click("delegate-submit");
      await waitFor(() => expect(screen.getByTestId("delegate-notice").textContent).toBe("This task changed on disk - review and send again|false"));
    });

    it("tells the user when the delegated task no longer exists", async () => {
      await openDrawer();
      click("drawer-delegate");
      mocked.delegate.mockRejectedValueOnce(new BoardConflictError("changed", null));
      mocked.getBoard.mockResolvedValueOnce(board({ tasks: [t1, { ...t2, title: "Renamed elsewhere" }, t3, t4] }));
      click("delegate-submit");
      await waitFor(() => expect(screen.getByTestId("delegate-notice").textContent).toBe("This task no longer exists on disk - close this dialog and pick another task|true"));
      click("delegate-cancel");
      expect(screen.queryByRole("dialog", { name: "Delegate stub" })).toBeNull();
    });

    it("passes other delegate failures back to the dialog", async () => {
      await openDrawer();
      click("drawer-delegate");
      mocked.delegate.mockRejectedValueOnce(new Error("no runner"));
      click("delegate-submit");
      expect((await screen.findByRole("alert")).textContent).toBe("delegate failed: no runner");
    });

    it("closes by itself when its task leaves the board", async () => {
      await openDrawer();
      mocked.getBoard.mockResolvedValue(board({ tasks: [t1, t3, t4] }));
      act(() => {
        window.dispatchEvent(new CustomEvent("cchub:daily-refresh"));
      });
      await waitFor(() => expect(screen.queryByTestId("drawer-task")).toBeNull());
    });

    it("keeps the drawer on the same task when the board is reloaded with shifted lines", async () => {
      await openDrawer();
      mocked.getBoard.mockResolvedValue(board({ tasks: [t1, { ...t2, line: 9, raw: "- [-] Fix bug" }, t3, t4] }));
      act(() => {
        window.dispatchEvent(new CustomEvent("cchub:daily-refresh"));
      });
      await waitFor(() => expect(screen.getByTestId("drawer-task").textContent).toBeTruthy());
    });
  });
});
