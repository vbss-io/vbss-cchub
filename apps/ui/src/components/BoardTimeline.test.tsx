import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TimelineZoom } from "../board-model";
import type { BoardTask } from "../delegation";
import { makeProject, makeTask } from "../test-support/u2-fixtures";
import { BoardTimeline } from "./BoardTimeline";

const projects = [makeProject("p1", { title: "Alpha" }), makeProject("p2", { title: "Beta" })];

const tasks: BoardTask[] = [
  makeTask("bar", { title: "Build bar", line: 1, status: "doing", start: "2026-11-10", due: "2026-11-20", priority: 0 }),
  makeTask("late", { title: "Late one", line: 2, status: "todo", due: "2026-11-01", repeat: "every week" }),
  makeTask("open", { title: "Open start", line: 3, status: "todo", scheduled: "2026-11-18" }),
  makeTask("fin", { title: "Finished", line: 4, status: "done", due: "2026-11-05" }),
  makeTask("none", { title: "No dates", line: 5, priority: 2 }),
  makeTask("other", { title: "Other project", projectId: "p2", line: 1, due: "2026-11-25" }),
];

const baseProps = {
  tasks,
  projects,
  projectOrder: ["p1", "p2"],
  breadcrumbs: new Map([
    ["p1", "Alpha"],
    ["p2", "Beta"],
  ]),
  zoom: "month" as TimelineZoom,
  today: "2026-11-16",
  collapsed: new Set<string>(),
  undatedOpen: false,
  jumpToToday: 0,
};

const setup = (props: Partial<Parameters<typeof BoardTimeline>[0]> = {}) => {
  const handlers = { onToggleGroup: vi.fn(), onToggleUndated: vi.fn(), onOpen: vi.fn() };
  const view = render(<BoardTimeline {...baseProps} {...handlers} {...props} />);
  return { ...handlers, ...view };
};

describe("BoardTimeline", () => {
  it("renders the scale, a group per project and a row for each dated task", () => {
    const { container } = setup();
    expect(screen.getByRole("group", { name: "Task timeline" })).toBeTruthy();
    expect(container.querySelector(".tl__tick--top")?.textContent).toMatch(/\w{3} 20\d\d/);
    expect(screen.getByRole("button", { name: /Alpha/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /Beta/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open details of Build bar, 10/11 - 20/11" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open details of Late one, Due 01/11" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open details of Open start, From 18/11" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open details of No dates" })).toBeNull();
    expect(container.querySelector(".tl__today")?.getAttribute("title")).toBe("Today, 2026-11-16");
  });

  it("draws bars, open bars and milestones with their tone", () => {
    const { container } = setup();
    expect(container.querySelector(".tl__bar--doing")?.getAttribute("title")).toBe("Build bar (10/11 - 20/11)");
    expect(container.querySelector(".tl__bar--open")?.getAttribute("title")).toBe("Open start (From 18/11)");
    expect(container.querySelector(".tl__mark--overdue")?.closest(".tl__item")?.getAttribute("title")).toBe("Late one (Due 01/11)");
    expect(container.querySelector(".tl__mark--done")).toBeTruthy();
    expect(container.querySelector(".tl__mark--todo")).toBeTruthy();
  });

  it("shows priority, status tags and the repeat mark in the row label", () => {
    setup();
    const row = screen.getByRole("button", { name: "Open details of Late one, Due 01/11" });
    expect(within(row).getByText("To-Do")).toBeTruthy();
    expect(within(row).getByRole("img", { name: "Repeats: every week" })).toBeTruthy();
    expect(within(screen.getByRole("button", { name: "Open details of Build bar, 10/11 - 20/11" })).getByText("P0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open details of Finished, Due 05/11" }).className).toContain("tl__row--done");
  });

  it("opens a task by click and by Enter on the row, ignoring other keys and child events", async () => {
    const user = userEvent.setup();
    const { onOpen } = setup();
    const row = screen.getByRole("button", { name: "Open details of Build bar, 10/11 - 20/11" });
    await user.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "bar" }));
    row.focus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledTimes(2);
    await user.keyboard("a");
    expect(onOpen).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(within(row).getByText("Build bar"), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("toggles a project group and hides its rows while collapsed", async () => {
    const user = userEvent.setup();
    const { onToggleGroup, rerender } = setup();
    await user.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(onToggleGroup).toHaveBeenCalledWith("p1");
    rerender(<BoardTimeline {...baseProps} collapsed={new Set(["p1"])} onToggleGroup={onToggleGroup} onToggleUndated={() => undefined} onOpen={() => undefined} />);
    expect(screen.getByRole("button", { name: /Alpha/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Open details of Build bar/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Open details of Other project/ })).toBeTruthy();
  });

  it("uses the project title when no breadcrumb is known", () => {
    setup({ breadcrumbs: new Map() });
    expect(screen.getByRole("button", { name: /Alpha/ })).toBeTruthy();
  });

  it("lists the undated tasks when expanded and opens them by click, Enter and Space", async () => {
    const user = userEvent.setup();
    const { onOpen, onToggleUndated } = setup({ undatedOpen: true });
    await user.click(screen.getByText("No dates", { selector: ".board-group__name" }));
    expect(onToggleUndated).toHaveBeenCalledTimes(1);
    const item = screen.getByRole("button", { name: "Open details of No dates" });
    expect(within(item).getByText("P2")).toBeTruthy();
    expect(within(item).getByText("Alpha")).toBeTruthy();
    await user.click(item);
    item.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    await user.keyboard("a");
    expect(onOpen).toHaveBeenCalledTimes(3);
    fireEvent.keyDown(within(item).getByText("No dates"), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it("uses the breadcrumb for the undated project label", () => {
    const { container } = setup({ undatedOpen: true });
    expect(container.querySelector(".tl-undated__project")?.getAttribute("title")).toBe("Alpha");
  });

  it("keeps the undated list closed by default and reports when everything has dates", () => {
    const { rerender } = setup();
    expect(screen.queryByRole("button", { name: "Open details of No dates" })).toBeNull();
    expect((screen.getByText("No dates", { selector: ".board-group__name" }).closest("button") as HTMLElement).getAttribute("aria-expanded")).toBe("false");
    rerender(<BoardTimeline {...baseProps} tasks={[tasks[0] as BoardTask]} undatedOpen onToggleGroup={() => undefined} onToggleUndated={() => undefined} onOpen={() => undefined} />);
    expect(screen.getByText("Every task shown here has dates.")).toBeTruthy();
  });

  it("explains an empty timeline when nothing has dates", () => {
    setup({ tasks: [tasks[4] as BoardTask] });
    expect(screen.getByText(/No task has dates yet/)).toBeTruthy();
  });

  it("marks spans outside the supported range as clipped", () => {
    const far = [
      makeTask("past", { title: "Ancient", due: "2001-01-01" }),
      makeTask("future", { title: "Distant", due: "2099-01-01", line: 2 }),
      makeTask("wide", { title: "Everything", start: "2001-01-01", due: "2099-01-01", line: 3 }),
    ];
    const { container } = setup({ tasks: far });
    expect(screen.getByRole("button", { name: /Open details of Ancient, out of range \(2001-01-01 - 2001-01-01\)/ })).toBeTruthy();
    expect(container.querySelectorAll(".tl__item--clip-before").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll(".tl__item--clip-after").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('[title^="Everything (out of range"]')?.className).toContain("tl__item--clip-before");
    expect(container.querySelector('[title^="Everything (out of range"]')?.className).toContain("tl__item--clip-after");
  });

  it("indents subtasks and lists an undated parent with dated children", () => {
    const parent = makeTask("parent", { title: "Parent", subtasks: [makeTask("kid", { title: "Kid", line: 2, due: "2026-11-22", depth: 1 })] });
    const { container } = setup({ tasks: [parent] });
    expect(screen.getByRole("button", { name: "Open details of Parent" })).toBeTruthy();
    expect(container.querySelectorAll(".tl__item").length).toBe(1);
    const kid = screen.getByRole("button", { name: "Open details of Kid, Due 22/11" });
    expect((kid.querySelector(".tl__label") as HTMLElement).style.paddingLeft).toBe("calc(26px)");
    expect((screen.getByRole("button", { name: "Open details of Parent" }).querySelector(".tl__label") as HTMLElement).style.paddingLeft).toBe("calc(10px)");
  });

  it("renders the weekly, monthly and quarterly scales", () => {
    const week = setup({ zoom: "week" });
    expect(week.container.querySelectorAll(".tl__tick--bottom").length).toBeGreaterThan(20);
    week.unmount();
    const quarter = setup({ zoom: "quarter" });
    expect(quarter.container.querySelector(".tl__tick--top")?.textContent).toMatch(/^Q\d 20\d\d$/);
    expect(quarter.container.querySelector(".tl__tick--bottom")?.textContent).toMatch(/^[A-Z][a-z]{2}$/);
  });

  it("scrolls the track toward today on mount and when the jump counter changes", () => {
    const { rerender, container } = setup();
    const scroller = container.querySelector(".tl") as HTMLElement;
    scroller.scrollLeft = 0;
    rerender(<BoardTimeline {...baseProps} jumpToToday={1} onToggleGroup={() => undefined} onToggleUndated={() => undefined} onOpen={() => undefined} />);
    expect(scroller.scrollLeft).toBeGreaterThanOrEqual(0);
  });

  it("omits the today marker when the date is invalid", () => {
    const { container } = setup({ today: "not-a-day" });
    expect(container.querySelector(".tl__today")).toBeNull();
  });
});
