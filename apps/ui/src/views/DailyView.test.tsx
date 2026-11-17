import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyStreamEvent, TasksBoardStreamEvent } from "../api";
import {
  closeYesterday,
  composeDaily,
  DailyConflictError,
  DailyExistsError,
  generateDaily,
  getDaily,
  getDailyEntry,
  getDailyLinks,
  getTasksBoard,
  listDailySessions,
  organizeDailyFocus,
  prepareDaily,
  saveDailyEntry,
  type DailyEntry,
  type DailyOverview,
  type DailyPrepare,
  type DailySession,
  type DailyYesterdayTask,
} from "../delegation";
import { boardPayload, DAY, prepareOf, settingsOf } from "../test-support/u1-fixtures";
import { installResizeObserver, makeBus } from "../test-support/u1-mock";
import { DAILY_ORGANIZE_EVENT, DAILY_REFINE_EVENT, DailyView, type DailyEntryInfo } from "./DailyView";

vi.mock("../delegation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../delegation")>()),
  closeYesterday: vi.fn(),
  composeDaily: vi.fn(),
  generateDaily: vi.fn(),
  getDaily: vi.fn(),
  getDailyEntry: vi.fn(),
  getDailyLinks: vi.fn(),
  getTasksBoard: vi.fn(),
  listDailySessions: vi.fn(),
  organizeDailyFocus: vi.fn(),
  prepareDaily: vi.fn(),
  saveDailyEntry: vi.fn(),
}));

vi.mock("../components/BoardTaskPicker", async () => {
  const { createElement } = await import("react");
  return {
    BoardTaskPicker: (props: { onPick: (item: { project: string | null; text: string }) => void; onPickDoing: (item: { project: string | null; text: string; block: string }) => void }) =>
      createElement(
        "div",
        null,
        createElement("button", { onClick: () => props.onPick({ project: "Alpha", text: "Picked task" }) }, "pick-new"),
        createElement("button", { onClick: () => props.onPickDoing({ project: null, text: "Doing item", block: "- [-] Doing item" }) }, "pick-doing"),
      ),
  };
});

const getOverview = vi.mocked(getDaily);
const getEntry = vi.mocked(getDailyEntry);
const sessionsOf = vi.mocked(listDailySessions);
const save = vi.mocked(saveDailyEntry);
const organize = vi.mocked(organizeDailyFocus);
const generate = vi.mocked(generateDaily);
const prepare = vi.mocked(prepareDaily);
const closeY = vi.mocked(closeYesterday);
const compose = vi.mocked(composeDaily);
const links = vi.mocked(getDailyLinks);
const board = vi.mocked(getTasksBoard);

const CONTENT = "# 2026-11-16\n\n## Focus\n\n- [ ] Task one\n- [x] Task two\n";

const overviewOf = (patch: Partial<DailyOverview> = {}): DailyOverview => ({ enabled: true, root: "/r", dir: "/r/d", today: DAY, dates: [], running: null, templatePath: null, ...patch });

const entryOf = (patch: Partial<DailyEntry> = {}): DailyEntry => ({ date: DAY, path: "/d.md", exists: true, content: CONTENT, updatedAt: 100, ...patch });

const line = (n: number, text: string, patch: Partial<DailyYesterdayTask> = {}): DailyYesterdayTask => ({ line: n, depth: 0, state: "todo", checked: false, text, raw: `- [ ] ${text}`, ...patch });

const yesterdayPrepare = (patch: Partial<DailyPrepare> = {}): DailyPrepare =>
  prepareOf({
    yesterday: {
      date: "2026-11-15",
      path: "/y.md",
      closed: false,
      tasks: [line(3, "Alpha - Write report"), line(4, "Fix bug", { state: "doing", block: "- [-] Fix bug\n  - note" }), line(5, "Shipped", { state: "done", checked: true })],
    },
    yesterdayTrail: { path: "/t.md", bullets: ["Did the thing", "Met the team"] },
    ...patch,
  });

const session = (id: string, patch: Partial<DailySession> = {}): DailySession => ({ sessionId: id, title: `Session ${id}`, client: "claude", cwd: null, status: "done", startedAt: 1, updatedAt: 2, ...patch });

const daily = makeBus<DailyStreamEvent>();
const boardBus = makeBus<TasksBoardStreamEvent>();

interface MountOptions {
  tasks?: boolean;
  daily?: boolean;
  embedded?: boolean;
  modeSlot?: HTMLElement | null;
  date?: string;
  onEntryChange?: (info: DailyEntryInfo) => void;
}

const mount = (options: MountOptions = {}) => {
  const onOpenSession = vi.fn();
  const onOpenTask = vi.fn();
  const element = (next: MountOptions) => (
    <DailyView
      settings={settingsOf({ daily: next.daily ?? true, tasks: next.tasks ?? false })}
      onOpenSession={onOpenSession}
      onOpenTask={onOpenTask}
      subscribeDaily={daily.subscribe}
      subscribeBoard={boardBus.subscribe}
      embedded={next.embedded}
      modeSlot={next.modeSlot}
      date={next.date}
      onEntryChange={next.onEntryChange}
    />
  );
  const view = render(element(options));
  return { ...view, onOpenSession, onOpenTask, rerender: (next: MountOptions) => view.rerender(element(next)) };
};

const ready = async () => {
  await screen.findByText("Task one");
};

const eventOf = (patch: Partial<DailyStreamEvent> = {}): DailyStreamEvent => ({ date: DAY, updatedAt: 300, source: "disk", writeId: null, ...patch });

const editor = (): HTMLTextAreaElement => screen.getByRole("textbox") as HTMLTextAreaElement;

const toEditMode = async () => {
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await waitFor(() => expect(editor().value).toBe(CONTENT));
};

const openWizard = async () => {
  await ready();
  fireEvent.click(screen.getAllByRole("button", { name: "Plan today" })[0] as HTMLElement);
  await screen.findByText(`Plan today · ${DAY}`);
};

const wizardReady = async () => {
  await openWizard();
  await screen.findByText("Yesterday · 2026-11-15");
};

const toStepTwo = async () => {
  await wizardReady();
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  await screen.findByText("Carried over");
};

describe("DailyView", () => {
  beforeAll(() => {
    installResizeObserver();
  });

  beforeEach(() => {
    window.localStorage.clear();
    for (const fn of [getOverview, getEntry, sessionsOf, save, organize, generate, prepare, closeY, compose, links, board]) fn.mockReset();
    getOverview.mockResolvedValue(overviewOf());
    getEntry.mockResolvedValue(entryOf());
    sessionsOf.mockResolvedValue([]);
    save.mockResolvedValue({ date: DAY, path: "/d.md", updatedAt: 500 });
    prepare.mockResolvedValue(yesterdayPrepare());
    links.mockResolvedValue({ date: DAY, exists: true, path: "/d.md", items: [], taskIds: [] });
    board.mockResolvedValue(boardPayload());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("loading and availability", () => {
    it("says Daily is off when the feature is disabled", () => {
      mount({ daily: false });
      expect(screen.getByText(/Daily is off/)).toBeTruthy();
      expect(getOverview).not.toHaveBeenCalled();
    });

    it("shows a loading state, then the entry of today", async () => {
      mount();
      expect(screen.getByText("Loading…")).toBeTruthy();
      await ready();
      expect(getEntry).toHaveBeenCalledWith(DAY);
      expect(screen.getByText("Task two")).toBeTruthy();
    });

    it("asks for a newer hub when the overview route is missing", async () => {
      getOverview.mockRejectedValue(new Error("request failed (404)"));
      mount();
      expect(await screen.findByText(/Daily needs a newer hub/)).toBeTruthy();
    });

    it("shows a retryable error for other overview failures", async () => {
      getOverview.mockRejectedValueOnce(new Error("boom"));
      mount();
      expect(await screen.findByText("Could not load Daily.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await ready();
      expect(getOverview).toHaveBeenCalledTimes(2);
    });

    it("treats a non-error overview failure as a plain error", async () => {
      getOverview.mockRejectedValueOnce("x");
      mount();
      expect(await screen.findByText("Could not load Daily.")).toBeTruthy();
    });
  });

  describe("navigation and preview", () => {
    it("moves between days with Previous, Next, Today and the date field", async () => {
      mount();
      await ready();
      fireEvent.click(screen.getByRole("button", { name: "‹ Previous" }));
      await waitFor(() => expect(getEntry).toHaveBeenLastCalledWith("2026-11-15"));
      fireEvent.click(screen.getByRole("button", { name: "Next ›" }));
      await waitFor(() => expect(getEntry).toHaveBeenLastCalledWith(DAY));
      fireEvent.click(screen.getByRole("button", { name: "Next ›" }));
      await waitFor(() => expect(getEntry).toHaveBeenLastCalledWith("2026-11-17"));
      fireEvent.click(screen.getByRole("button", { name: "Today" }));
      await waitFor(() => expect(getEntry).toHaveBeenLastCalledWith(DAY));
      const date = document.querySelector("input[type=date]") as HTMLInputElement;
      fireEvent.change(date, { target: { value: "2026-12-01" } });
      await waitFor(() => expect(getEntry).toHaveBeenLastCalledWith("2026-12-01"));
      fireEvent.change(date, { target: { value: "" } });
      expect(getEntry).toHaveBeenLastCalledWith("2026-12-01");
    });

    it("filters the preview by open and done tasks and remembers the choice", async () => {
      mount();
      await ready();
      expect(screen.getByRole("button", { name: /^Open/ }).textContent).toContain("1");
      fireEvent.click(screen.getByRole("button", { name: /^Open/ }));
      expect(screen.queryByText("Task two")).toBeNull();
      expect(window.localStorage.getItem("hub.daily.taskFilter")).toBe("open");
      fireEvent.click(screen.getByRole("button", { name: /^Done/ }));
      expect(screen.queryByText("Task one")).toBeNull();
      expect(screen.getByText("Task two")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "All" }));
      expect(screen.getByText("Task one")).toBeTruthy();
    });

    it("starts with a stored filter", async () => {
      window.localStorage.setItem("hub.daily.taskFilter", "done");
      mount();
      await screen.findByText("Task two");
      expect(screen.queryByText("Task one")).toBeNull();
    });

    it("ignores a stored filter that is not valid and a storage that throws", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      mount();
      await ready();
      expect(screen.getByText("Task two")).toBeTruthy();
    });

    it("toggles a task from the preview and saves the note", async () => {
      mount();
      await ready();
      fireEvent.click(screen.getByRole("checkbox", { name: "Task one" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(save).toHaveBeenCalledWith(DAY, CONTENT.replace("- [ ] Task one", "- [x] Task one"), 100, expect.any(String));
      await waitFor(() => expect(screen.getByText(/^Saved \d/)).toBeTruthy());
    });

    it("links to Obsidian when the entry exists", async () => {
      mount();
      await ready();
      expect(screen.getByRole("link", { name: "Open in Obsidian" }).getAttribute("href")).toBe("obsidian://open?path=%2Fd.md");
    });

    it("lists the sessions of the day and opens one", async () => {
      sessionsOf.mockResolvedValue([session("abc12345xyz", { title: null, client: null }), session("s2", { client: "codex" })]);
      const view = mount();
      await ready();
      fireEvent.click(await screen.findByRole("button", { name: "abc12345" }));
      expect(view.onOpenSession).toHaveBeenCalledWith("abc12345xyz");
      expect(screen.getByText("codex")).toBeTruthy();
      expect(sessionsOf).toHaveBeenCalledWith(DAY);
    });

    it("shows none yet when there are no sessions and keeps going when listing fails", async () => {
      sessionsOf.mockRejectedValue(new Error("nope"));
      mount();
      await ready();
      expect(screen.getByText("none yet")).toBeTruthy();
    });

    it("offers a button to open the running generation", async () => {
      getOverview.mockResolvedValue(overviewOf({ running: { taskId: "task-9", date: DAY, startedAt: 1 } }));
      const view = mount();
      fireEvent.click(await screen.findByRole("button", { name: /generating/ }));
      expect(view.onOpenTask).toHaveBeenCalledWith("task-9");
    });

    it("hides a generation of another day", async () => {
      getOverview.mockResolvedValue(overviewOf({ running: { taskId: "task-9", date: "2026-01-01", startedAt: 1 } }));
      mount();
      await ready();
      expect(screen.queryByRole("button", { name: /generating/ })).toBeNull();
    });

    it("shows the tasks check when Tasks is on", async () => {
      mount({ tasks: true });
      expect(await screen.findByText("No focus items to check.")).toBeTruthy();
      expect(links).toHaveBeenCalledWith(DAY);
    });
  });

  describe("missing entry", () => {
    beforeEach(() => {
      getEntry.mockResolvedValue(entryOf({ exists: false, content: "", updatedAt: null }));
    });

    it("offers to create the note from a template", async () => {
      mount();
      expect(await screen.findByText(`No entry yet for ${DAY}.`)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Create from template" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      const written = save.mock.calls[0]?.[1] ?? "";
      expect(written).toContain("type: daily");
      expect(written).toContain(`date: ${DAY}`);
      expect(save.mock.calls[0]?.[2]).toBeNull();
    });

    it("hides the refine and Obsidian actions and disables organize", async () => {
      mount();
      await screen.findByText(`No entry yet for ${DAY}.`);
      expect(screen.queryByRole("button", { name: "Refine with assistant" })).toBeNull();
      expect(screen.queryByRole("link", { name: "Open in Obsidian" })).toBeNull();
      expect((screen.getByRole("button", { name: "Organize focus" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("opens the planner from the empty state", async () => {
      mount();
      await screen.findByText(`No entry yet for ${DAY}.`);
      const empty = document.querySelector(".daily__empty") as HTMLElement;
      fireEvent.click(within(empty).getByRole("button", { name: "Plan today" }));
      expect(await screen.findByText(`Plan today · ${DAY}`)).toBeTruthy();
    });
  });

  describe("editing and saving", () => {
    it("switches to the editor and autosaves after a pause", async () => {
      mount();
      await toEditMode();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      fireEvent.change(editor(), { target: { value: `${CONTENT}more` } });
      expect(screen.getByText("Unsaved")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(save).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(save).toHaveBeenCalledWith(DAY, `${CONTENT}more`, 100, expect.any(String));
      vi.useRealTimers();
      await waitFor(() => expect(screen.getByText(/^Saved \d/)).toBeTruthy());
    });

    it("saves on blur when there are unsaved edits and not when clean", async () => {
      mount();
      await toEditMode();
      fireEvent.blur(editor());
      expect(save).not.toHaveBeenCalled();
      fireEvent.change(editor(), { target: { value: "changed" } });
      fireEvent.blur(editor());
      await waitFor(() => expect(save).toHaveBeenCalledWith(DAY, "changed", 100, expect.any(String)));
    });

    it("goes back to the preview with the Preview pill", async () => {
      mount();
      await toEditMode();
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
      expect(screen.getByRole("checkbox", { name: "Task one" })).toBeTruthy();
    });

    it("shows Unsaved when saving fails and keeps the text", async () => {
      save.mockRejectedValue(new Error("disk"));
      mount();
      await toEditMode();
      fireEvent.change(editor(), { target: { value: "changed" } });
      fireEvent.blur(editor());
      await waitFor(() => expect(save).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByText("Unsaved")).toBeTruthy());
      expect(editor().value).toBe("changed");
    });

    it("on a save conflict shows the banner and lets the user reload the remote text", async () => {
      save.mockRejectedValueOnce(new DailyConflictError("changed", "remote text", 900));
      mount();
      await toEditMode();
      fireEvent.change(editor(), { target: { value: "mine" } });
      fireEvent.blur(editor());
      expect(await screen.findByText("Changed in Obsidian")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(editor().value).toBe("remote text"));
      expect(screen.queryByText("Changed in Obsidian")).toBeNull();
    });

    it("on a save conflict lets the user keep their text against the new base", async () => {
      save.mockRejectedValueOnce(new DailyConflictError("changed", "remote text", 900));
      mount();
      await toEditMode();
      fireEvent.change(editor(), { target: { value: "mine" } });
      fireEvent.blur(editor());
      await screen.findByText("Changed in Obsidian");
      fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      expect(save).toHaveBeenLastCalledWith(DAY, "mine", 900, expect.any(String));
    });
  });

  describe("daily stream events", () => {
    it("reloads the entry when the note changed on disk and nothing is pending", async () => {
      mount();
      await ready();
      getEntry.mockResolvedValue(entryOf({ content: "# new\n\n- [ ] From disk\n", updatedAt: 300 }));
      act(() => daily.emit(eventOf()));
      expect(await screen.findByText("From disk")).toBeTruthy();
      expect(getOverview).toHaveBeenCalledTimes(2);
    });

    it("ignores events of other days but still refreshes the overview", async () => {
      mount();
      await ready();
      act(() => daily.emit(eventOf({ date: "2026-01-01" })));
      await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2));
      expect(getEntry).toHaveBeenCalledTimes(1);
    });

    it("ignores the echo of its own write and adopts its update time", async () => {
      mount();
      await ready();
      fireEvent.click(screen.getByRole("checkbox", { name: "Task one" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      const writeId = save.mock.calls[0]?.[3] ?? "";
      await waitFor(() => expect(screen.getByText(/^Saved \d/)).toBeTruthy());
      act(() => daily.emit(eventOf({ writeId, updatedAt: 777 })));
      expect(getEntry).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("checkbox", { name: "Task two" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      expect(save.mock.calls[1]?.[2]).toBe(777);
    });

    it("ignores the echo of its own write without a time", async () => {
      mount();
      await ready();
      fireEvent.click(screen.getByRole("checkbox", { name: "Task one" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      act(() => daily.emit(eventOf({ writeId: save.mock.calls[0]?.[3] ?? "", updatedAt: null })));
      expect(getEntry).toHaveBeenCalledTimes(1);
    });

    it("flags a conflict instead of reloading when there are unsaved edits", async () => {
      mount();
      await toEditMode();
      fireEvent.change(editor(), { target: { value: "dirty" } });
      act(() => daily.emit(eventOf()));
      expect(await screen.findByText("Changed in Obsidian")).toBeTruthy();
      expect(getEntry).toHaveBeenCalledTimes(1);
      getEntry.mockResolvedValue(entryOf({ content: "fresh from disk", updatedAt: 300 }));
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(editor().value).toBe("fresh from disk"));
    });

    it("reloads after recovering the stream when the text is clean", async () => {
      mount();
      await ready();
      act(() => daily.emit(eventOf({ recovered: true })));
      await waitFor(() => expect(getEntry).toHaveBeenCalledTimes(2));
      expect(sessionsOf.mock.calls.length).toBeGreaterThan(1);
    });

    it("does not reload after recovering the stream when edits are pending", async () => {
      mount();
      await toEditMode();
      fireEvent.change(editor(), { target: { value: "dirty" } });
      act(() => daily.emit(eventOf({ recovered: true })));
      await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2));
      expect(getEntry).toHaveBeenCalledTimes(1);
    });

    it("defers an event that arrives while saving and settles it after the save", async () => {
      let release: (value: { date: string; path: string; updatedAt: number }) => void = () => undefined;
      save.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      mount();
      await ready();
      fireEvent.click(screen.getByRole("checkbox", { name: "Task one" }));
      await screen.findByText("Saving…");
      act(() => daily.emit(eventOf()));
      expect(getEntry).toHaveBeenCalledTimes(1);
      await act(async () => release({ date: DAY, path: "/d.md", updatedAt: 500 }));
      await waitFor(() => expect(getEntry).toHaveBeenCalledTimes(2));
    });

    it("settles a deferred event even when the save fails", async () => {
      let fail: (reason: Error) => void = () => undefined;
      save.mockReturnValue(
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      );
      mount();
      await ready();
      fireEvent.click(screen.getByRole("checkbox", { name: "Task one" }));
      await screen.findByText("Saving…");
      act(() => daily.emit(eventOf()));
      await act(async () => fail(new Error("disk")));
      await waitFor(() => expect(getEntry).toHaveBeenCalledTimes(2));
    });

    it("drops a deferred event when the save ends in a conflict", async () => {
      let fail: (reason: Error) => void = () => undefined;
      save.mockReturnValue(
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
      );
      mount();
      await ready();
      fireEvent.click(screen.getByRole("checkbox", { name: "Task one" }));
      await screen.findByText("Saving…");
      act(() => daily.emit(eventOf()));
      await act(async () => fail(new DailyConflictError("changed", "remote", 900)));
      expect(await screen.findByText("Changed in Obsidian")).toBeTruthy();
      expect(getEntry).toHaveBeenCalledTimes(1);
    });
  });

  describe("sessions refresh", () => {
    it("polls the sessions every thirty seconds and when the window regains focus", async () => {
      const polls: (() => void)[] = [];
      const realSetInterval = window.setInterval.bind(window);
      vi.spyOn(window, "setInterval").mockImplementation(((handler: TimerHandler, delay?: number) => {
        if (delay === 30_000 && typeof handler === "function") polls.push(handler as () => void);
        return realSetInterval(handler, delay);
      }) as typeof window.setInterval);
      mount();
      await ready();
      const base = sessionsOf.mock.calls.length;
      expect(polls.length).toBeGreaterThan(0);
      act(() => polls[polls.length - 1]?.());
      expect(sessionsOf.mock.calls.length).toBe(base + 1);
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(sessionsOf.mock.calls.length).toBe(base + 2);
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(sessionsOf.mock.calls.length).toBe(base + 3);
    });

    it("ignores a session list that belongs to a day the view already left", async () => {
      mount();
      await ready();
      let release: (value: DailySession[]) => void = () => undefined;
      sessionsOf.mockReturnValueOnce(
        new Promise<DailySession[]>((resolve) => {
          release = resolve;
        }),
      );
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      sessionsOf.mockResolvedValue([]);
      fireEvent.click(screen.getByRole("button", { name: "‹ Previous" }));
      await waitFor(() => expect(getEntry).toHaveBeenLastCalledWith("2026-11-15"));
      await act(async () => release([session("late")]));
      expect(screen.queryByText("Session late")).toBeNull();
    });
  });

  describe("organize focus", () => {
    it("organizes the focus, reloads the note and reports the result", async () => {
      organize.mockResolvedValue({ date: DAY, path: "/d.md", updatedAt: 2, changed: true, groups: 2 });
      mount();
      await ready();
      fireEvent.click(screen.getByRole("button", { name: "Organize focus" }));
      expect(await screen.findByText("Focus organized by project")).toBeTruthy();
      expect(organize).toHaveBeenCalledWith(DAY, 100);
      expect(getEntry).toHaveBeenCalledTimes(2);
    });

    it("reports when nothing changed and lets the notice be dismissed", async () => {
      organize.mockResolvedValue({ date: DAY, path: "/d.md", updatedAt: 2, changed: false, groups: 0 });
      mount();
      await ready();
      fireEvent.click(screen.getByRole("button", { name: "Organize focus" }));
      expect(await screen.findByText("Focus already organized")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByText("Focus already organized")).toBeNull();
    });

    it("clears a notice after a while", async () => {
      organize.mockResolvedValue({ date: DAY, path: "/d.md", updatedAt: 2, changed: false, groups: 0 });
      mount();
      await ready();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      fireEvent.click(screen.getByRole("button", { name: "Organize focus" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(screen.getByText("Focus already organized")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100);
      });
      expect(screen.queryByText("Focus already organized")).toBeNull();
    });

    it("shows an error notice when organizing fails", async () => {
      organize.mockRejectedValue(new Error("cannot organize"));
      mount();
      await ready();
      fireEvent.click(screen.getByRole("button", { name: "Organize focus" }));
      expect((await screen.findByText("cannot organize")).closest(".toast")?.className).toContain("toast--error");
    });

    it("uses a generic notice for a non-error failure", async () => {
      organize.mockRejectedValue("x");
      mount();
      await ready();
      fireEvent.click(screen.getByRole("button", { name: "Organize focus" }));
      expect(await screen.findByText("could not organize the focus")).toBeTruthy();
    });

    it("turns a conflict into the changed banner", async () => {
      organize.mockRejectedValue(new DailyConflictError("changed", "remote", 900));
      mount();
      await ready();
      fireEvent.click(screen.getByRole("button", { name: "Organize focus" }));
      expect(await screen.findByText("Changed in Obsidian")).toBeTruthy();
    });

    it("is disabled while there are unsaved edits", async () => {
      mount();
      await toEditMode();
      fireEvent.change(editor(), { target: { value: "dirty" } });
      expect((screen.getByRole("button", { name: "Organize focus" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("does not overwrite edits typed while organizing", async () => {
      let release: (value: { date: string; path: string; updatedAt: number; changed: boolean; groups: number }) => void = () => undefined;
      organize.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      mount();
      await toEditMode();
      fireEvent.click(screen.getByRole("button", { name: "Organize focus" }));
      await screen.findByText("Organizing…");
      fireEvent.change(editor(), { target: { value: "typed meanwhile" } });
      await act(async () => release({ date: DAY, path: "/d.md", updatedAt: 2, changed: true, groups: 1 }));
      expect(await screen.findByText("Focus organized by project")).toBeTruthy();
      expect(getEntry).toHaveBeenCalledTimes(1);
      expect(editor().value).toBe("typed meanwhile");
    });
  });

  describe("refine with the assistant", () => {
    it("toggles the panel and starts a generation with the focus text and context", async () => {
      generate.mockResolvedValue({ taskId: "g1" });
      mount();
      await ready();
      fireEvent.click(screen.getByRole("button", { name: "Refine with assistant" }));
      fireEvent.change(screen.getByLabelText(/What are you working on today/), { target: { value: "ship the outliner" } });
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      await waitFor(() => expect(generate).toHaveBeenCalledWith(DAY, "ship the outliner", "- [ ] Task one\n- [x] Task two"));
      await waitFor(() => expect(screen.queryByLabelText(/What are you working on today/)).toBeNull());
      expect(getOverview).toHaveBeenCalledTimes(2);
    });

    it("shows the error of a failed generation and keeps the panel", async () => {
      generate.mockRejectedValue(new Error("busy"));
      mount();
      await ready();
      fireEvent.click(screen.getByRole("button", { name: "Refine with assistant" }));
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      expect(await screen.findByText("busy")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Refine with assistant" }));
      expect(screen.queryByLabelText(/What are you working on today/)).toBeNull();
    });

    it("uses a generic error for a non-error failure", async () => {
      generate.mockRejectedValue("x");
      mount();
      await ready();
      fireEvent.click(screen.getByRole("button", { name: "Refine with assistant" }));
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      expect(await screen.findByText("could not start generation")).toBeTruthy();
    });
  });

  describe("refresh", () => {
    it("reloads the overview, the sessions and the entry", async () => {
      mount();
      await ready();
      const sessionCalls = sessionsOf.mock.calls.length;
      getEntry.mockResolvedValue(entryOf({ content: "# fresh\n\n- [ ] Refreshed\n" }));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      expect(await screen.findByText("Refreshed")).toBeTruthy();
      expect(getOverview).toHaveBeenCalledTimes(2);
      expect(sessionsOf.mock.calls.length).toBe(sessionCalls + 1);
    });

    it("keeps unsaved edits and tells the user", async () => {
      mount();
      await toEditMode();
      fireEvent.change(editor(), { target: { value: "dirty" } });
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      expect(await screen.findByText("Unsaved edits kept; sessions refreshed")).toBeTruthy();
      expect(editor().value).toBe("dirty");
      expect(getEntry).toHaveBeenCalledTimes(1);
    });

    it("shows the failure of a refresh", async () => {
      mount();
      await ready();
      getEntry.mockRejectedValueOnce(new Error("offline"));
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      expect(await screen.findByText("offline")).toBeTruthy();
    });

    it("uses a generic notice for a non-error refresh failure", async () => {
      mount();
      await ready();
      getEntry.mockRejectedValueOnce("x");
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      expect(await screen.findByText("could not refresh the daily")).toBeTruthy();
    });

    it("ignores a second click while refreshing", async () => {
      mount();
      await ready();
      let release: (value: DailyEntry) => void = () => undefined;
      getEntry.mockReturnValueOnce(
        new Promise<DailyEntry>((resolve) => {
          release = resolve;
        }),
      );
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await screen.findByRole("button", { name: "Refreshing…" });
      fireEvent.click(screen.getByRole("button", { name: "Refreshing…" }));
      expect(getOverview).toHaveBeenCalledTimes(2);
      await act(async () => release(entryOf()));
    });
  });

  describe("window events", () => {
    it("refreshes on cchub:daily-refresh", async () => {
      mount();
      await ready();
      act(() => {
        window.dispatchEvent(new CustomEvent("cchub:daily-refresh"));
      });
      await waitFor(() => expect(getEntry).toHaveBeenCalledTimes(2));
    });

    it("opens the planner on cchub:daily-plan-today", async () => {
      mount();
      await ready();
      act(() => {
        window.dispatchEvent(new CustomEvent("cchub:daily-plan-today"));
      });
      expect(await screen.findByText(`Plan today · ${DAY}`)).toBeTruthy();
    });

    it("opens the refine panel on the refine event and closes the planner", async () => {
      mount();
      await wizardReady();
      act(() => {
        window.dispatchEvent(new CustomEvent(DAILY_REFINE_EVENT));
      });
      expect(await screen.findByLabelText(/What are you working on today/)).toBeTruthy();
      expect(screen.queryByText(`Plan today · ${DAY}`)).toBeNull();
    });

    it("organizes on the organize event when the note is saved", async () => {
      organize.mockResolvedValue({ date: DAY, path: "/d.md", updatedAt: 2, changed: true, groups: 1 });
      mount();
      await ready();
      act(() => {
        window.dispatchEvent(new CustomEvent(DAILY_ORGANIZE_EVENT));
      });
      await waitFor(() => expect(organize).toHaveBeenCalledWith(DAY, 100));
    });

    it("explains why it cannot organize when there are pending changes", async () => {
      mount();
      await toEditMode();
      fireEvent.change(editor(), { target: { value: "dirty" } });
      act(() => {
        window.dispatchEvent(new CustomEvent(DAILY_ORGANIZE_EVENT));
      });
      expect(await screen.findByText("Organize focus needs a saved daily without pending changes")).toBeTruthy();
      expect(organize).not.toHaveBeenCalled();
    });

    it("runs a plan request that arrived before the daily was ready", async () => {
      let release: (value: DailyOverview) => void = () => undefined;
      getOverview.mockReturnValueOnce(
        new Promise<DailyOverview>((resolve) => {
          release = resolve;
        }),
      );
      mount();
      act(() => {
        window.dispatchEvent(new CustomEvent("cchub:daily-plan-today"));
      });
      await act(async () => release(overviewOf()));
      expect(await screen.findByText(`Plan today · ${DAY}`)).toBeTruthy();
    });

    it("runs a refresh request that arrived before the entry was ready", async () => {
      let release: (value: DailyEntry) => void = () => undefined;
      getEntry.mockReturnValueOnce(
        new Promise<DailyEntry>((resolve) => {
          release = resolve;
        }),
      );
      mount();
      await waitFor(() => expect(getEntry).toHaveBeenCalledTimes(1));
      act(() => {
        window.dispatchEvent(new CustomEvent("cchub:daily-refresh"));
      });
      getEntry.mockResolvedValue(entryOf({ content: "# later\n\n- [ ] After refresh\n" }));
      await act(async () => release(entryOf()));
      expect(await screen.findByText("After refresh")).toBeTruthy();
    });

    it("tells the user when a plan request waited too long", async () => {
      let release: (value: DailyOverview) => void = () => undefined;
      getOverview.mockReturnValueOnce(
        new Promise<DailyOverview>((resolve) => {
          release = resolve;
        }),
      );
      mount();
      vi.useFakeTimers({ toFake: ["Date"] });
      act(() => {
        window.dispatchEvent(new CustomEvent("cchub:daily-plan-today"));
      });
      vi.setSystemTime(Date.now() + 20_000);
      await act(async () => release(overviewOf()));
      vi.useRealTimers();
      expect(await screen.findByText("The daily was not ready; open Plan today again")).toBeTruthy();
      expect(screen.queryByText(`Plan today · ${DAY}`)).toBeNull();
    });

    it("tells the user when a refresh request waited too long", async () => {
      let release: (value: DailyOverview) => void = () => undefined;
      getOverview.mockReturnValueOnce(
        new Promise<DailyOverview>((resolve) => {
          release = resolve;
        }),
      );
      mount();
      vi.useFakeTimers({ toFake: ["Date"] });
      act(() => {
        window.dispatchEvent(new CustomEvent("cchub:daily-refresh"));
      });
      vi.setSystemTime(Date.now() + 20_000);
      await act(async () => release(overviewOf()));
      vi.useRealTimers();
      expect(await screen.findByText("The daily was not ready; refresh again")).toBeTruthy();
    });
  });

  describe("embedded mode", () => {
    it("renders the mode pills in the given slot and reports the entry", async () => {
      const slot = document.createElement("div");
      document.body.appendChild(slot);
      const onEntryChange = vi.fn();
      mount({ embedded: true, modeSlot: slot, date: DAY, onEntryChange });
      await ready();
      expect(within(slot).getByRole("button", { name: "Preview" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Plan today" })).toBeNull();
      await waitFor(() => expect(onEntryChange).toHaveBeenLastCalledWith({ exists: true, path: "/d.md" }));
      slot.remove();
    });

    it("shows a small toolbar when no slot is given and follows the date prop", async () => {
      const onEntryChange = vi.fn();
      const view = mount({ embedded: true, date: DAY, onEntryChange });
      await ready();
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
      getEntry.mockResolvedValue(entryOf({ exists: false, content: "", updatedAt: null }));
      view.rerender({ embedded: true, date: "2026-11-20", onEntryChange });
      await waitFor(() => expect(getEntry).toHaveBeenLastCalledWith("2026-11-20"));
      await waitFor(() => expect(onEntryChange).toHaveBeenLastCalledWith({ exists: false, path: null }));
    });

    it("shows no mode controls while the slot is still unknown", async () => {
      mount({ embedded: true, modeSlot: null, date: DAY });
      await ready();
      expect(screen.queryByRole("button", { name: "Preview" })).toBeNull();
    });

    it("shows the running generation chip in the slot", async () => {
      getOverview.mockResolvedValue(overviewOf({ running: { taskId: "task-9", date: DAY, startedAt: 1 } }));
      const slot = document.createElement("div");
      document.body.appendChild(slot);
      const view = mount({ embedded: true, modeSlot: slot, date: DAY });
      fireEvent.click(await within(slot).findByRole("button", { name: /generating/ }));
      expect(view.onOpenTask).toHaveBeenCalledWith("task-9");
      slot.remove();
    });
  });

  describe("planner wizard", () => {
    it("starts at yesterday with sensible defaults and keeps done and carry exclusive", async () => {
      mount();
      await wizardReady();
      const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
      expect(boxes.map((box) => box.checked)).toEqual([false, true, false, true, true, false]);
      expect(screen.getByText("In progress")).toBeTruthy();
      fireEvent.click(boxes[0] as HTMLElement);
      expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).map((box) => box.checked)).toEqual([true, false, false, true, true, false]);
      fireEvent.click(screen.getAllByRole("checkbox")[3] as HTMLElement);
      fireEvent.click(screen.getAllByRole("checkbox")[2] as HTMLElement);
      expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).map((box) => box.checked)).toEqual([true, false, true, false, true, false]);
      fireEvent.click(screen.getAllByRole("checkbox")[3] as HTMLElement);
      expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).map((box) => box.checked)).toEqual([true, false, false, true, true, false]);
    });

    it("uses the trail as the yesterday summary", async () => {
      mount();
      await wizardReady();
      fireEvent.click(screen.getByRole("button", { name: "Use as summary" }));
      expect((screen.getByLabelText(/What happened yesterday/) as HTMLTextAreaElement).value).toBe("Did the thing\nMet the team");
    });

    it("skips yesterday and carries the open tasks over", async () => {
      mount();
      await toStepTwo();
      const inputs = screen.getAllByDisplayValue(/Write report|Fix bug/) as HTMLInputElement[];
      expect(inputs.map((input) => input.value)).toEqual(["Alpha - Write report", "Fix bug"]);
      expect(screen.getByText("In progress")).toBeTruthy();
    });

    it("closes yesterday with the chosen states and moves on", async () => {
      closeY.mockResolvedValue({ date: DAY, updatedAt: 1, closed: true });
      mount();
      await wizardReady();
      fireEvent.click(screen.getAllByRole("checkbox")[0] as HTMLElement);
      fireEvent.click(screen.getByRole("button", { name: "Close yesterday" }));
      await screen.findByText("Carried over");
      expect(closeY).toHaveBeenCalledWith(DAY, {
        yesterday: "2026-11-15",
        tasks: [
          { line: 3, checked: true },
          { line: 4, checked: false },
          { line: 5, checked: true },
        ],
      });
      expect(screen.getAllByDisplayValue("Fix bug")).toHaveLength(1);
      expect(screen.queryByDisplayValue("Alpha - Write report")).toBeNull();
    });

    it("shows the error when closing yesterday fails and stays on the step", async () => {
      closeY.mockRejectedValue(new Error("cannot close"));
      mount();
      await wizardReady();
      fireEvent.click(screen.getByRole("button", { name: "Close yesterday" }));
      expect(await screen.findByText("cannot close")).toBeTruthy();
      expect(screen.getByText("Yesterday · 2026-11-15")).toBeTruthy();
    });

    it("uses a generic close error for a non-error failure", async () => {
      closeY.mockRejectedValue("x");
      mount();
      await wizardReady();
      fireEvent.click(screen.getByRole("button", { name: "Close yesterday" }));
      expect(await screen.findByText("could not close yesterday")).toBeTruthy();
    });

    it("says when there is no previous diary and starts at the second step", async () => {
      prepare.mockResolvedValue(prepareOf());
      mount();
      await openWizard();
      expect(await screen.findByText("Carried over")).toBeTruthy();
      expect(screen.getByText("Nothing carried over.")).toBeTruthy();
    });

    it("handles a closed yesterday without tasks or trail", async () => {
      prepare.mockResolvedValue(prepareOf({ yesterday: { date: "2026-11-15", path: "/y.md", closed: true, tasks: [] } }));
      mount();
      await openWizard();
      expect(await screen.findByText("already closed on 2026-11-15")).toBeTruthy();
      expect(screen.getByText("No tasks yesterday.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Use as summary" })).toBeNull();
    });

    it("shows a retryable error when preparing fails", async () => {
      prepare.mockRejectedValueOnce(new Error("no prepare"));
      mount();
      await openWizard();
      expect(await screen.findByText("no prepare")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByText("Yesterday · 2026-11-15");
      expect(prepare).toHaveBeenCalledTimes(2);
    });

    it("uses a generic prepare error for a non-error failure", async () => {
      prepare.mockRejectedValueOnce("x");
      mount();
      await openWizard();
      expect(await screen.findByText("could not load prepare")).toBeTruthy();
    });

    it("edits and removes carried items and fills meetings and new items", async () => {
      mount();
      await toStepTwo();
      fireEvent.change(screen.getByDisplayValue("Fix bug"), { target: { value: "Fix the bug" } });
      expect(screen.getByDisplayValue("Fix the bug")).toBeTruthy();
      fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0] as HTMLElement);
      expect(screen.queryByDisplayValue("Alpha - Write report")).toBeNull();
      fireEvent.change(screen.getByLabelText(/Meetings \(one per line\)/), { target: { value: "Standup\n\nReview" } });
      fireEvent.change(screen.getByLabelText(/New items/), { target: { value: "Alpha - New thing\nPlain thing" } });
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(await screen.findByText("1 carried · 2 new · 2 meetings · briefing no")).toBeTruthy();
      expect(screen.getByText("- [-] Fix bug")).toBeTruthy();
      expect(screen.getByText("- [ ] Alpha - New thing")).toBeTruthy();
      expect(screen.getByText("- [ ] Plain thing")).toBeTruthy();
    });

    it("walks back through the steps", async () => {
      mount();
      await toStepTwo();
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      await screen.findByText(`Create diary · ${DAY}`);
      expect(screen.getByText("- [ ] Alpha - Write report")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      await screen.findByText("Carried over");
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      expect(await screen.findByText("Yesterday · 2026-11-15")).toBeTruthy();
    });

    it("adds Tasks items through the picker without duplicating doing items", async () => {
      mount({ tasks: true });
      await toStepTwo();
      fireEvent.click(screen.getByRole("button", { name: "pick-new" }));
      fireEvent.click(screen.getByRole("button", { name: "pick-new" }));
      expect((screen.getByLabelText(/New items/) as HTMLTextAreaElement).value).toBe("Alpha - Picked task\n");
      fireEvent.click(screen.getByRole("button", { name: "pick-doing" }));
      fireEvent.click(screen.getByRole("button", { name: "pick-doing" }));
      expect(screen.getAllByDisplayValue("Doing item")).toHaveLength(1);
    });

    it("does not offer the picker when Tasks is off", async () => {
      mount();
      await toStepTwo();
      expect(screen.queryByRole("button", { name: "pick-new" })).toBeNull();
    });

    it("creates the diary with carried items, new items, meetings and the briefing", async () => {
      compose.mockResolvedValue(entryOf({ content: "# composed\n\n- [ ] Composed task\n", updatedAt: 800 }));
      mount();
      await wizardReady();
      fireEvent.click(screen.getByRole("button", { name: "Use as summary" }));
      fireEvent.click(screen.getByRole("button", { name: "Skip" }));
      await screen.findByText("Carried over");
      fireEvent.change(screen.getByLabelText(/Meetings \(one per line\)/), { target: { value: "Standup" } });
      fireEvent.change(screen.getByLabelText(/New items/), { target: { value: "Alpha - Extra" } });
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      await screen.findByText("2 carried · 1 new · 1 meetings · briefing yes");
      fireEvent.click(screen.getByRole("button", { name: "Create diary" }));
      expect(await screen.findByText("Composed task")).toBeTruthy();
      expect(compose).toHaveBeenCalledWith(DAY, {
        focus: [
          { project: null, text: "Alpha - Write report", block: undefined },
          { project: null, text: "Fix bug", block: "- [-] Fix bug\n  - note" },
          { project: "Alpha", text: "Extra" },
        ],
        meetings: ["Standup"],
        briefing: "Did the thing\nMet the team",
      });
      expect(window.localStorage.getItem(`hub.daily.plan.${DAY}`)).toBeNull();
      expect(screen.queryByText(`Plan today · ${DAY}`)).toBeNull();
      expect(getOverview).toHaveBeenCalledTimes(2);
    });

    it("asks before overwriting an existing diary and can cancel", async () => {
      compose.mockRejectedValueOnce(new DailyExistsError("exists", 5));
      mount();
      await toStepTwo();
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(await screen.findByRole("button", { name: "Create diary" }));
      expect(await screen.findByText(`A diary for ${DAY} already exists. Overwrite?`)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByText(/already exists/)).toBeNull();
    });

    it("overwrites an existing diary when confirmed", async () => {
      compose.mockRejectedValueOnce(new DailyExistsError("exists", 5));
      compose.mockResolvedValueOnce(entryOf({ content: "# over\n\n- [ ] Overwritten\n" }));
      mount();
      await toStepTwo();
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(await screen.findByRole("button", { name: "Create diary" }));
      fireEvent.click(await screen.findByRole("button", { name: "Overwrite" }));
      expect(await screen.findByText("Overwritten")).toBeTruthy();
      expect(compose).toHaveBeenLastCalledWith(DAY, expect.objectContaining({ overwrite: true }));
    });

    it("shows the error when creating the diary fails", async () => {
      compose.mockRejectedValueOnce(new Error("compose failed"));
      mount();
      await toStepTwo();
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(await screen.findByRole("button", { name: "Create diary" }));
      expect(await screen.findByText("compose failed")).toBeTruthy();
      compose.mockRejectedValueOnce("x");
      fireEvent.click(screen.getByRole("button", { name: "Create diary" }));
      expect(await screen.findByText("could not create diary")).toBeTruthy();
    });

    it("closes with Close and with Escape but ignores other keys", async () => {
      mount();
      await wizardReady();
      fireEvent.keyDown(window, { key: "a" });
      expect(screen.getByText(`Plan today · ${DAY}`)).toBeTruthy();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByText(`Plan today · ${DAY}`)).toBeNull();
      await openWizard();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByText(`Plan today · ${DAY}`)).toBeNull();
    });

    it("keeps a draft of the planner and restores it on the next open", async () => {
      mount();
      await toStepTwo();
      fireEvent.change(screen.getByLabelText(/New items/), { target: { value: "Drafted" } });
      await waitFor(() => expect(JSON.parse(window.localStorage.getItem(`hub.daily.plan.${DAY}`) ?? "{}").newItemsText).toBe("Drafted"));
      fireEvent.keyDown(window, { key: "Escape" });
      await openWizard();
      expect(await screen.findByText("Carried over")).toBeTruthy();
      expect((screen.getByLabelText(/New items/) as HTMLTextAreaElement).value).toBe("Drafted");
    });

    it("ignores a draft that cannot be parsed and a storage that throws on write", async () => {
      window.localStorage.setItem(`hub.daily.plan.${DAY}`, "{not json");
      mount();
      await wizardReady();
      const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      fireEvent.click(screen.getByRole("button", { name: "Skip" }));
      await screen.findByText("Carried over");
      write.mockRestore();
    });

    it("clears the draft key even when removing it throws", async () => {
      compose.mockResolvedValue(entryOf({ content: "# composed\n\n- [ ] Composed task\n" }));
      mount();
      await toStepTwo();
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      fireEvent.click(await screen.findByRole("button", { name: "Create diary" }));
      expect(await screen.findByText("Composed task")).toBeTruthy();
      remove.mockRestore();
    });

    it("closes the planner when the day changes", async () => {
      mount();
      await wizardReady();
      fireEvent.click(screen.getByRole("button", { name: "Next ›" }));
      await waitFor(() => expect(screen.queryByText(`Plan today · ${DAY}`)).toBeNull());
    });
  });
});
