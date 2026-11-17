import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardTask } from "../delegation";
import { BACKLOG_FILTERS_KEY, TODAY_DRAG_MIME } from "../today-model";
import { boardProject, boardTask } from "../test-support/u1-fixtures";
import { BacklogPanel } from "./BacklogPanel";

const TODAY = "2026-11-16";
const TOMORROW = "2026-11-17";

const projects = [boardProject("alpha", "Alpha"), boardProject("beta", "Beta")];

const sub = (id: string, status: BoardTask["status"]) => boardTask(id, "alpha", 30, { status, depth: 1 });

const t1 = boardTask("t1", "alpha", 2, { title: "Write docs", priority: 1, due: "2026-11-14", subtasks: [sub("s1", "done"), sub("s2", "todo")] });
const t2 = boardTask("t2", "alpha", 3, { title: "Fix bug", priority: 2, status: "doing", checkbox: "doing", scheduled: "2026-11-18" });
const t3 = boardTask("t3", "alpha", 4, { title: "Triage inbox", priority: null });
const t4 = boardTask("t4", "beta", 2, { title: "Plan trip", priority: 1 });
const t5 = boardTask("t5", "beta", 3, { title: "Blocked thing", priority: 1, status: "blocked", prefix: "BLOCK" });
const t6 = boardTask("t6", "beta", 4, { title: "On hold", priority: 1, status: "hold" });
const done = boardTask("t7", "beta", 5, { title: "Finished", priority: 1, section: "done", status: "done" });
const allTasks = [t1, t2, t3, t4, t5, t6, done];

interface Overrides {
  tasks?: BoardTask[];
  excluded?: ReadonlySet<string>;
  inToday?: ReadonlySet<string>;
  date?: string;
  busyIds?: ReadonlySet<string>;
  levels?: number;
}

const handlers = () => ({ onSchedule: vi.fn(), onDone: vi.fn(), onDoing: vi.fn(), onOpen: vi.fn(), onDragActive: vi.fn() });

const mount = (overrides: Overrides = {}) => {
  const fns = handlers();
  const element = (next: Overrides) => (
    <BacklogPanel
      tasks={next.tasks ?? allTasks}
      projects={projects}
      projectOrder={[]}
      excluded={next.excluded ?? new Set()}
      inToday={next.inToday}
      levels={next.levels}
      date={next.date ?? TODAY}
      today={TODAY}
      nextDate={TOMORROW}
      busyIds={next.busyIds ?? new Set()}
      {...fns}
    />
  );
  const view = render(element(overrides));
  return { ...fns, rerender: (next: Overrides) => view.rerender(element(next)) };
};

const rowOf = (title: string): HTMLElement => screen.getByText(title).closest("[role=listitem]") as HTMLElement;

const focusRow = (title: string): HTMLElement => {
  const row = rowOf(title);
  act(() => row.focus());
  return row;
};

const key = (element: HTMLElement, name: string, init: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(element, { key: name, ...init });

const titles = (): string[] => Array.from(document.querySelectorAll(".backlog__title")).map((element) => element.textContent ?? "");

const openFilters = () => fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));

const stored = (): unknown => JSON.parse(window.localStorage.getItem(BACKLOG_FILTERS_KEY) ?? "null");

describe("BacklogPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("groups the open tasks by project with the default filters applied", () => {
    mount();
    expect(titles()).toEqual(["Write docs", "Fix bug", "Plan trip", "Blocked thing"]);
    expect(screen.getByRole("group", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Beta" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Backlog 4");
    expect(screen.getByText(/T today - M tomorrow/)).toBeTruthy();
  });

  it("shows priority, due, scheduled, subtask progress and status chips", () => {
    mount();
    expect(within(rowOf("Write docs")).getByTitle("Priority P1").textContent).toBe("P1");
    expect(within(rowOf("Write docs")).getByTitle("Due 2026-11-14").textContent).toBe("14/11");
    expect(within(rowOf("Write docs")).getByTitle("Subtasks done").textContent).toBe("1/2");
    expect(within(rowOf("Fix bug")).getByTitle("Scheduled for 2026-11-18").textContent).toBe("18/11");
    expect(within(rowOf("Fix bug")).getByRole("img", { name: "In progress" })).toBeTruthy();
    expect(within(rowOf("Fix bug")).getByText("Doing")).toBeTruthy();
    expect(within(rowOf("Blocked thing")).getByText("Blocked")).toBeTruthy();
  });

  it("shows the empty state for no tasks and for filters that match nothing", () => {
    mount({ tasks: [] });
    expect(screen.getByText("No open tasks.")).toBeTruthy();
    expect(screen.queryByText(/T today - M tomorrow/)).toBeNull();
  });

  it("narrows by search text and says when nothing matches", () => {
    mount();
    const search = screen.getByLabelText("Search the backlog");
    fireEvent.change(search, { target: { value: "bug" } });
    expect(titles()).toEqual(["Fix bug"]);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("Nothing matches these filters.")).toBeTruthy();
    expect(titles()).toEqual([]);
  });

  it("filters by project and keeps the choice", () => {
    mount();
    const select = screen.getByLabelText("Filter by project") as HTMLSelectElement;
    expect(within(select).getByRole("option", { name: "All projects (4)" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "beta" } });
    expect(titles()).toEqual(["Plan trip", "Blocked thing"]);
    expect(stored()).toMatchObject({ projectId: "beta" });
    fireEvent.change(select, { target: { value: "" } });
    expect(titles()).toHaveLength(4);
  });

  it("toggles status filters and stores them", () => {
    mount();
    const hold = screen.getByRole("button", { name: "Hold" });
    expect(hold.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(hold);
    expect(hold.getAttribute("aria-pressed")).toBe("true");
    expect(titles()).toContain("On hold");
    expect(stored()).toMatchObject({ statuses: ["todo", "doing", "blocked", "hold"] });
    fireEvent.click(screen.getByRole("button", { name: "To-do" }));
    expect(titles()).not.toContain("Write docs");
  });

  it("restores filters stored earlier and falls back to the defaults for garbage", () => {
    window.localStorage.setItem(BACKLOG_FILTERS_KEY, JSON.stringify({ v: 2, projectId: "beta", statuses: ["hold"], hiddenPriorities: [], showInToday: true }));
    mount();
    expect(titles()).toEqual(["On hold"]);
  });

  it("survives storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mount();
    expect(titles()).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Hold" }));
    expect(titles()).toContain("On hold");
  });

  it("filters by priority from the filters menu and reports it in a chip", () => {
    mount();
    openFilters();
    const panel = screen.getByRole("group", { name: "Filters" });
    const none = within(panel).getByLabelText(/No priority/) as HTMLInputElement;
    expect(none.checked).toBe(false);
    fireEvent.click(none);
    expect(titles()).toContain("Triage inbox");
    fireEvent.click(within(panel).getByRole("button", { name: "None" }));
    expect(titles()).toEqual([]);
    expect(screen.getByText("Priority: None")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "All" }));
    expect(titles()).toHaveLength(5);
    fireEvent.click(within(panel).getByLabelText(/^P1/));
    expect(titles()).not.toContain("Write docs");
    expect(screen.getByText(/^Priority: /)).toBeTruthy();
  });

  it("removes the priority chip to show every priority again", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /^Remove filter Priority: / }));
    expect(titles()).toContain("Triage inbox");
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
  });

  it("hides the tasks already in Today on request and offers removing that chip", () => {
    mount({ inToday: new Set(["t4"]) });
    expect(within(rowOf("Plan trip")).getByText("in Today").getAttribute("title")).toBe("Already in today's focus");
    expect(within(rowOf("Plan trip")).queryByRole("button", { name: /Schedule/ })).toBeNull();
    expect(rowOf("Plan trip").getAttribute("draggable")).toBe("false");
    openFilters();
    const toggle = screen.getByLabelText(/Show tasks already in Today/) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(titles()).not.toContain("Plan trip");
    fireEvent.click(screen.getByRole("button", { name: "Remove filter Hiding tasks in Today" }));
    expect(titles()).toContain("Plan trip");
  });

  it("explains an in-Today task of another day", () => {
    mount({ inToday: new Set(["t4"]), date: "2026-11-20" });
    expect(within(rowOf("Plan trip")).getByText("in Today").getAttribute("title")).toBe("Already in the focus of 2026-11-20");
  });

  it("resets the filters from the menu", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Hold" }));
    openFilters();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(titles()).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Hold" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("excludes the tasks the parent says to leave out", () => {
    mount({ excluded: new Set(["t1", "t2"]) });
    expect(titles()).toEqual(["Plan trip", "Blocked thing"]);
  });

  it("schedules with the button for today or for the viewed day", () => {
    const view = mount();
    fireEvent.click(within(rowOf("Fix bug")).getByRole("button", { name: "Schedule Fix bug for today" }));
    expect(view.onSchedule).toHaveBeenCalledWith(t2, TODAY);
    view.rerender({ date: "2026-11-20" });
    const button = within(rowOf("Fix bug")).getByRole("button", { name: "Schedule Fix bug for 2026-11-20" });
    expect(button.textContent).toBe("+ Day");
    fireEvent.click(button);
    expect(view.onSchedule).toHaveBeenLastCalledWith(t2, "2026-11-20");
  });

  it("opens a task by clicking its title and disables busy rows", () => {
    const view = mount({ busyIds: new Set(["t2"]) });
    fireEvent.click(screen.getByText("Write docs"));
    expect(view.onOpen).toHaveBeenCalledWith(t1);
    const busy = rowOf("Fix bug");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("draggable")).toBe("false");
    expect((within(busy).getByRole("button", { name: /Schedule/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("drives the keyboard shortcuts of a focused row", () => {
    const view = mount();
    const row = focusRow("Write docs");
    key(row, "t");
    expect(view.onSchedule).toHaveBeenLastCalledWith(t1, TODAY);
    key(row, "M");
    expect(view.onSchedule).toHaveBeenLastCalledWith(t1, TOMORROW);
    key(row, "d");
    expect(view.onDone).toHaveBeenCalledWith(t1);
    key(row, "s");
    expect(view.onDoing).toHaveBeenCalledWith(t1);
    key(row, "Enter");
    expect(view.onOpen).toHaveBeenCalledWith(t1);
  });

  it("does not start a task that cannot change state and ignores unknown keys and modifiers", () => {
    const view = mount();
    key(focusRow("Blocked thing"), "s");
    expect(view.onDoing).not.toHaveBeenCalled();
    key(rowOf("Blocked thing"), "q");
    key(rowOf("Blocked thing"), "t", { ctrlKey: true });
    expect(view.onSchedule).not.toHaveBeenCalled();
  });

  it("does not schedule a task that is already in Today but still allows tomorrow", () => {
    const view = mount({ inToday: new Set(["t4"]) });
    const row = focusRow("Plan trip");
    key(row, "t");
    expect(view.onSchedule).not.toHaveBeenCalled();
    key(row, "m");
    expect(view.onSchedule).toHaveBeenCalledWith(t4, TOMORROW);
  });

  it("moves between rows with j, k and the arrows and stops at the ends", () => {
    mount();
    const first = focusRow("Write docs");
    key(first, "k");
    expect(document.activeElement).toBe(first);
    key(first, "j");
    expect(document.activeElement).toBe(rowOf("Fix bug"));
    key(rowOf("Fix bug"), "ArrowDown");
    expect(document.activeElement).toBe(rowOf("Plan trip"));
    key(rowOf("Plan trip"), "ArrowUp");
    expect(document.activeElement).toBe(rowOf("Fix bug"));
    const last = focusRow("Blocked thing");
    key(last, "j");
    expect(document.activeElement).toBe(last);
  });

  it("ignores keys that come from inside the row", () => {
    const view = mount();
    focusRow("Write docs");
    fireEvent.keyDown(screen.getByText("Write docs"), { key: "t" });
    expect(view.onSchedule).not.toHaveBeenCalled();
  });

  it("gives focus back to the list after a keyboard action removes the row", () => {
    const view = mount();
    key(focusRow("Fix bug"), "t");
    view.rerender({ excluded: new Set(["t2"]) });
    expect(document.activeElement).toBe(rowOf("Plan trip"));
  });

  it("does not steal focus from another control after an action", () => {
    const view = mount();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    key(focusRow("Fix bug"), "t");
    outside.focus();
    view.rerender({ excluded: new Set(["t2"]) });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("starts a drag with the task as payload and reports drag activity", () => {
    const view = mount();
    const dataTransfer = { setData: vi.fn(), effectAllowed: "" };
    const row = rowOf("Fix bug");
    fireEvent.dragStart(row, { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith(TODAY_DRAG_MIME, JSON.stringify({ projectId: "alpha", line: 3, raw: "- [ ] t2" }));
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "Fix bug");
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(view.onDragActive).toHaveBeenLastCalledWith(true);
    fireEvent.dragEnd(row);
    expect(view.onDragActive).toHaveBeenLastCalledWith(false);
  });

  it("pages long lists with the show more buttons", () => {
    const many = Array.from({ length: 40 }, (_unused, index) => boardTask(`m${index}`, "alpha", 100 + index, { title: `Many ${index}`, priority: 1 }));
    mount({ tasks: many });
    expect(titles()).toHaveLength(20);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Backlog 40");
    const button = document.querySelector(".show-more__btn") as HTMLElement;
    fireEvent.click(button);
    expect(titles().length).toBeGreaterThan(20);
  });
});
