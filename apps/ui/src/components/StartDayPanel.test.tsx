import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeYesterday, composeDaily, DailyExistsError, prepareDaily, type BoardTask, type DailyPrepare, type DailyYesterdayTask, type TodayData } from "../delegation";
import { boardTask, DAY, prepareOf, todayData, todayEntry } from "../test-support/u1-fixtures";
import { StartDayPanel } from "./StartDayPanel";

vi.mock("../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../delegation")>()), prepareDaily: vi.fn(), closeYesterday: vi.fn(), composeDaily: vi.fn() }));

const prepare = vi.mocked(prepareDaily);
const close = vi.mocked(closeYesterday);
const compose = vi.mocked(composeDaily);

const line = (n: number, text: string, patch: Partial<DailyYesterdayTask> = {}): DailyYesterdayTask => ({ line: n, depth: 0, state: "todo", checked: false, text, raw: `- [ ] ${text}`, ...patch });

const yesterdayPrepare = (patch: Partial<DailyPrepare> = {}): DailyPrepare =>
  prepareOf({
    yesterday: {
      date: "2026-11-15",
      path: "/y.md",
      closed: false,
      tasks: [line(3, "Write report"), line(4, "Fix bug", { state: "doing", block: "  - note" }), line(5, "Shipped", { state: "done", checked: true })],
    },
    yesterdayTrail: { path: "/t.md", bullets: ["Did the thing", "Met the team"] },
    ...patch,
  });

const carriedTask = boardTask("carry", "alpha", 9, { title: "Carried task", scheduled: "2026-11-14", status: "doing" });

interface Options {
  date?: string;
  isToday?: boolean;
  noteExists?: boolean;
  data?: TodayData;
  tasks?: readonly BoardTask[];
  busyIds?: ReadonlySet<string>;
}

const mount = (options: Options = {}) => {
  const handlers = {
    onBring: vi.fn<(task: BoardTask) => void>(),
    onTomorrow: vi.fn<(task: BoardTask) => void>(),
    onDrop: vi.fn<(task: BoardTask) => void>(),
    onBringAll: vi.fn<() => void>(),
    onOpenTask: vi.fn<(task: BoardTask) => void>(),
    onCreated: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onRefine: vi.fn<() => void>(),
    onClassic: vi.fn<() => void>(),
    onClose: vi.fn<() => void>(),
    onError: vi.fn<(text: string) => void>(),
  };
  const element = (next: Options) => (
    <StartDayPanel
      date={next.date ?? DAY}
      isToday={next.isToday ?? true}
      noteExists={next.noteExists ?? false}
      data={next.data ?? todayData({ dailyExists: false, carriedOver: [todayEntry(carriedTask, "Alpha")] })}
      tasks={next.tasks ?? []}
      busyIds={next.busyIds ?? new Set()}
      {...handlers}
    />
  );
  const view = render(element(options));
  return { ...handlers, rerender: (next: Options) => view.rerender(element(next)) };
};

const ready = async () => {
  await waitFor(() => expect((screen.getByRole("button", { name: /Create/ }) as HTMLButtonElement).disabled).toBe(false));
};

describe("StartDayPanel", () => {
  beforeEach(() => {
    prepare.mockReset();
    close.mockReset();
    compose.mockReset();
    window.localStorage.clear();
    prepare.mockResolvedValue(yesterdayPrepare());
    close.mockResolvedValue({ date: DAY, updatedAt: 1, closed: true });
    compose.mockResolvedValue({ date: DAY, path: "/d.md", exists: true, content: "", updatedAt: 1 });
  });

  it("shows a loading state until yesterday is read, then lists carried tasks, open lines and done lines", async () => {
    mount();
    expect(screen.getByRole("status").textContent).toBe("Reading yesterday's note…");
    expect((screen.getByRole("button", { name: "Create today's note" }) as HTMLButtonElement).disabled).toBe(true);
    expect(prepare).toHaveBeenCalledWith(DAY);
    await ready();
    expect(screen.getByRole("button", { name: "Carried task" })).toBeTruthy();
    expect(screen.getByText("Write report")).toBeTruthy();
    expect(screen.getByText("Fix bug")).toBeTruthy();
    expect(screen.getByText("Done yesterday (1)")).toBeTruthy();
    expect(screen.getByText("Shipped")).toBeTruthy();
    expect(screen.getByText("Did the thing", { exact: false })).toBeTruthy();
    expect(screen.getByText("From yesterday").closest("h4")?.textContent).toContain("3");
    expect(screen.getAllByRole("img", { name: "In progress" })).toHaveLength(2);
    expect(screen.getByText("14/11")).toBeTruthy();
  });

  it("shows the load error and retries", async () => {
    prepare.mockRejectedValueOnce(new Error("hub down"));
    mount({ data: todayData({ dailyExists: false }) });
    expect((await screen.findByRole("alert")).textContent).toContain("hub down");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("falls back to a generic text when the load rejection is not an error", async () => {
    prepare.mockRejectedValueOnce("x");
    mount({ data: todayData({ dailyExists: false }) });
    expect((await screen.findByRole("alert")).textContent).toContain("could not load yesterday");
  });

  it("says nothing came from yesterday when there is no previous note", async () => {
    prepare.mockResolvedValue(prepareOf());
    mount({ data: todayData({ dailyExists: false }) });
    expect(await screen.findByText("Nothing from yesterday.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bring all" })).toBeNull();
  });

  it("says nothing is left open when yesterday only had done lines", async () => {
    prepare.mockResolvedValue(
      prepareOf({ yesterday: { date: "2026-11-15", path: "/y.md", closed: true, tasks: [line(5, "Shipped", { state: "done", checked: true })] } }),
    );
    mount({ data: todayData({ dailyExists: false }) });
    expect(await screen.findByText("Nothing left open from yesterday.")).toBeTruthy();
    expect(screen.queryByLabelText(/Close yesterday's note/)).toBeNull();
  });

  it("drives the task actions of a carried item", async () => {
    const view = mount();
    await ready();
    const row = within(screen.getByRole("button", { name: "Carried task" }).closest("li") as HTMLElement);
    fireEvent.click(row.getByRole("button", { name: "Bring to today" }));
    expect(view.onBring).toHaveBeenCalledWith(carriedTask);
    fireEvent.click(row.getByRole("button", { name: "Tomorrow" }));
    expect(view.onTomorrow).toHaveBeenCalledWith(carriedTask);
    fireEvent.click(row.getByRole("button", { name: "Drop" }));
    expect(view.onDrop).toHaveBeenCalledWith(carriedTask);
    fireEvent.click(row.getByRole("button", { name: "Carried task" }));
    expect(view.onOpenTask).toHaveBeenCalledWith(carriedTask);
  });

  it("uses the day wording for a past or future day and disables busy tasks", async () => {
    mount({ isToday: false, busyIds: new Set(["carry"]), date: "2026-11-20" });
    const row = within((await screen.findByRole("button", { name: "Carried task" })).closest("li") as HTMLElement);
    expect((row.getByRole("button", { name: "Bring here" }) as HTMLButtonElement).disabled).toBe(true);
    expect((row.getByRole("button", { name: "Tomorrow" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Bring all" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Create note" })).toBeTruthy();
  });

  it("lets the user bring or drop a line from the note and undo the choice", async () => {
    mount({ data: todayData({ dailyExists: false }) });
    await ready();
    const row = screen.getByText("Write report").closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Bring to today" }));
    expect(within(row).getByText("Brought")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Undo" }));
    expect(within(row).queryByText("Brought")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Drop" }));
    expect(within(row).getByText("Dropped")).toBeTruthy();
    expect(row.querySelector(".today__struck")).not.toBeNull();
  });

  it("brings every pending line and the carried tasks with Bring all", async () => {
    const view = mount();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Bring all" }));
    expect(view.onBringAll).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Brought")).toHaveLength(2);
  });

  it("does not call onBringAll when nothing is carried over", async () => {
    const view = mount({ data: todayData({ dailyExists: false }) });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Bring all" }));
    expect(view.onBringAll).not.toHaveBeenCalled();
    expect(screen.getAllByText("Brought")).toHaveLength(2);
  });

  it("disables Bring all when every open item is a busy task", async () => {
    prepare.mockResolvedValue(prepareOf());
    mount({ busyIds: new Set(["carry"]) });
    await waitFor(() => expect(screen.getByRole("button", { name: "Bring all" })).toBeTruthy());
    expect((screen.getByRole("button", { name: "Bring all" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes yesterday, composes the note with the summary, meetings and brought lines, then reports it", async () => {
    const view = mount({ data: todayData({ dailyExists: false }) });
    await ready();
    window.localStorage.setItem(`hub.daily.plan.${DAY}`, "{}");
    const row = screen.getByText("Fix bug").closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Bring to today" }));
    fireEvent.change(screen.getByLabelText("Meetings, one per line"), { target: { value: "Standup\nReview" } });
    fireEvent.click(screen.getByRole("button", { name: "Create today's note" }));
    await waitFor(() => expect(view.onCreated).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalledWith(DAY, { yesterday: "2026-11-15", tasks: [] });
    expect(compose).toHaveBeenCalledWith(DAY, {
      focus: [{ project: null, text: "Fix bug", block: "  - note" }],
      meetings: ["Standup", "Review"],
      briefing: "Did the thing\nMet the team",
    });
    expect(window.localStorage.getItem(`hub.daily.plan.${DAY}`)).toBeNull();
  });

  it("skips closing yesterday and the summary when both boxes are unchecked", async () => {
    const view = mount({ data: todayData({ dailyExists: false }) });
    await ready();
    fireEvent.click(screen.getByLabelText("Use as the note's summary"));
    fireEvent.click(screen.getByLabelText("Close yesterday's note (2026-11-15)"));
    fireEvent.click(screen.getByRole("button", { name: "Create today's note" }));
    await waitFor(() => expect(view.onCreated).toHaveBeenCalled());
    expect(close).not.toHaveBeenCalled();
    expect(compose).toHaveBeenCalledWith(DAY, { focus: [], meetings: [] });
  });

  it("hides the summary and close boxes when there is no trail and yesterday was already closed", async () => {
    prepare.mockResolvedValue(prepareOf({ yesterday: { date: "2026-11-15", path: "/y.md", closed: true, tasks: [] } }));
    const view = mount({ data: todayData({ dailyExists: false }) });
    await waitFor(() => expect((screen.getByRole("button", { name: "Create today's note" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText("Yesterday's summary")).toBeNull();
    expect(screen.queryByLabelText(/Close yesterday's note/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create today's note" }));
    await waitFor(() => expect(view.onCreated).toHaveBeenCalled());
    expect(close).not.toHaveBeenCalled();
  });

  it("reports an existing note and still notifies the parent", async () => {
    compose.mockRejectedValue(new DailyExistsError("exists", 5));
    const view = mount({ data: todayData({ dailyExists: false }) });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Create today's note" }));
    expect((await screen.findByText("A note for this day already exists.")).getAttribute("role")).toBe("alert");
    expect(view.onCreated).toHaveBeenCalledTimes(1);
    expect(view.onError).not.toHaveBeenCalled();
  });

  it("shows other creation errors inline and sends them to onError", async () => {
    compose.mockRejectedValue(new Error("disk full"));
    const view = mount({ data: todayData({ dailyExists: false }) });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Create today's note" }));
    expect((await screen.findByText("disk full")).getAttribute("role")).toBe("alert");
    expect(view.onError).toHaveBeenCalledWith("disk full");
    expect(view.onCreated).not.toHaveBeenCalled();
  });

  it("uses a generic creation error for a non-error rejection", async () => {
    compose.mockRejectedValue("x");
    const view = mount({ data: todayData({ dailyExists: false }) });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Create today's note" }));
    await waitFor(() => expect(view.onError).toHaveBeenCalledWith("could not create the note"));
  });

  it("still creates when clearing the stored draft throws", async () => {
    const view = mount({ data: todayData({ dailyExists: false }) });
    await ready();
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    fireEvent.click(screen.getByRole("button", { name: "Create today's note" }));
    await waitFor(() => expect(view.onCreated).toHaveBeenCalledTimes(1));
    remove.mockRestore();
  });

  it("shows the creating label while the note is being written", async () => {
    let release: () => void = () => undefined;
    close.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ date: DAY, updatedAt: 1, closed: true });
      }),
    );
    mount({ data: todayData({ dailyExists: false }) });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Create today's note" }));
    expect((await screen.findByRole("button", { name: "Creating…" })).hasAttribute("disabled")).toBe(true);
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Create today's note" })).toBeTruthy());
  });

  it("offers the assistant and the classic planner", async () => {
    const view = mount({ data: todayData({ dailyExists: false }) });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Refine with assistant" }));
    fireEvent.click(screen.getByRole("button", { name: "Classic planner" }));
    expect(view.onRefine).toHaveBeenCalledTimes(1);
    expect(view.onClassic).toHaveBeenCalledTimes(1);
  });

  it("when the note exists it shows a hint and Close instead of the creation form", async () => {
    const view = mount({ noteExists: true });
    await waitFor(() => expect(screen.getByText(/Today's note already exists/)).toBeTruthy());
    expect(screen.queryByLabelText("Meetings, one per line")).toBeNull();
    expect(screen.queryByRole("button", { name: /Create/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(view.onClose).toHaveBeenCalledTimes(1);
  });

  it("reloads yesterday and forgets choices when the date changes", async () => {
    const view = mount({ data: todayData({ dailyExists: false }) });
    await ready();
    const row = screen.getByText("Write report").closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Bring to today" }));
    expect(screen.getByText("Brought")).toBeTruthy();
    view.rerender({ date: "2026-11-17", data: todayData({ dailyExists: false }) });
    await waitFor(() => expect(prepare).toHaveBeenCalledWith("2026-11-17"));
    await waitFor(() => expect(screen.queryByText("Brought")).toBeNull());
  });
});
