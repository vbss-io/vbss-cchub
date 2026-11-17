import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WorkspaceRecord } from "../delegation";
import type { RoutineStreamEvent } from "../routines-api";
import { routineRecord, routineRun } from "../test-support/u5-fixtures";
import type { RoutineDetail, RoutineRecord, RoutineRunRecord } from "../types";
import { RoutinesView } from "./RoutinesView";

const api = vi.hoisted(() => ({
  fetchRoutines: vi.fn<() => Promise<unknown>>(),
  fetchInbox: vi.fn<(unreadOnly: boolean, limit?: number) => Promise<unknown>>(),
  fetchRoutineSettings: vi.fn<() => Promise<unknown>>(),
  fetchRoutineDetail: vi.fn<(id: string) => Promise<unknown>>(),
  createRoutine: vi.fn<(input: unknown) => Promise<unknown>>(),
  updateRoutine: vi.fn<(id: string, patch: unknown) => Promise<unknown>>(),
  deleteRoutine: vi.fn<(id: string) => Promise<unknown>>(),
  runRoutineNow: vi.fn<(id: string) => Promise<unknown>>(),
  setRoutineEnabled: vi.fn<(id: string, enabled: boolean) => Promise<unknown>>(),
  saveRoutineSettings: vi.fn<(settings: unknown) => Promise<unknown>>(),
  markInboxRead: vi.fn<(id: string) => Promise<unknown>>(),
  markInboxUnread: vi.fn<(id: string) => Promise<unknown>>(),
  markInboxAllRead: vi.fn<() => Promise<unknown>>(),
  previewSchedule: vi.fn<(schedule: unknown) => Promise<unknown>>(),
}));

vi.mock("../routines-api", () => api);

vi.mock("../components/ShowMore", () => ({
  ClampScope: ({ children }: { children: ReactNode }) => <>{children}</>,
  ClampText: ({ children, className }: { children: string; className: string }) => <p className={className}>{children}</p>,
  ShowMoreList: <T,>({ items, render, wrap }: { items: T[]; render: (item: T) => ReactNode; wrap: (rows: ReactNode) => ReactNode }) => <>{wrap(items.map(render))}</>,
}));

const NOW = new Date(2026, 10, 16, 15, 0).getTime();
const at = (hour: number, minute: number): number => new Date(2026, 10, 16, hour, minute).getTime();

const workspaces = [{ name: "vbss", file: "vbss.code-workspace", contextPath: null, repos: [], error: null }] as WorkspaceRecord[];

const listOf = (routines: RoutineRecord[], extra: Partial<{ gate: string | null; schedulerGate: string | null }> = {}) => ({ routines, gate: null, schedulerGate: null, unread: 0, ...extra });

let listeners: Set<(event: RoutineStreamEvent) => void>;
const subscribe = (listener: (event: RoutineStreamEvent) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  listeners = new Set();
  for (const mock of Object.values(api)) mock.mockReset();
  api.fetchRoutines.mockResolvedValue(listOf([]));
  api.fetchInbox.mockResolvedValue({ items: [], unread: 0 });
  api.fetchRoutineSettings.mockResolvedValue({ catchUpHours: 12 });
  api.fetchRoutineDetail.mockResolvedValue({ ...routineRecord(), runs: [] } as RoutineDetail);
  api.createRoutine.mockResolvedValue(routineRecord());
  api.updateRoutine.mockResolvedValue(routineRecord());
  api.deleteRoutine.mockResolvedValue({ ok: true });
  api.runRoutineNow.mockResolvedValue(routineRun());
  api.setRoutineEnabled.mockResolvedValue(routineRecord());
  api.saveRoutineSettings.mockResolvedValue({ catchUpHours: 24 });
  api.markInboxRead.mockResolvedValue({ item: routineRun(), unread: 0 });
  api.markInboxUnread.mockResolvedValue({ item: routineRun(), unread: 1 });
  api.markInboxAllRead.mockResolvedValue({ changed: 1, unread: 0 });
  api.previewSchedule.mockResolvedValue({ next: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

const setup = (props: Partial<Parameters<typeof RoutinesView>[0]> = {}) => {
  const onOpenTask = vi.fn();
  const onError = vi.fn();
  const view = render(<RoutinesView workspaces={workspaces} subscribe={subscribe} enabled onOpenTask={onOpenTask} onError={onError} {...props} />);
  return { onOpenTask, onError, ...view };
};

const loaded = async (): Promise<void> => {
  await waitFor(() => expect(api.fetchRoutineSettings).toHaveBeenCalled());
  await act(async () => undefined);
};

const section = (name: string): HTMLElement => screen.getByRole("region", { name });
const card = (name: string): HTMLElement => {
  const node = [...document.querySelectorAll<HTMLElement>(".rt__card")].find((item) => item.querySelector(".rt__name")?.textContent === name);
  if (!node) throw new Error(`no card ${name}`);
  return node;
};

const inboxRuns = (): RoutineRunRecord[] => [
  routineRun({ id: "u1", routineName: "Triage", status: "completed", read: false, startedAt: at(12, 0), summary: "Unread one" }),
  routineRun({ id: "r1", routineName: "Backup", status: "failed", read: true, startedAt: at(8, 0), error: "boom", summary: null, taskId: "t2" }),
  routineRun({ id: "run1", routineName: "Cleanup", status: "running", read: false, startedAt: at(14, 0), summary: null, taskId: "t3" }),
];

test("when the Delegated plugin is off the view explains how to turn it on", () => {
  setup({ enabled: false });
  expect(screen.getByText("Routines need the Delegated plugin. Turn it on in Settings, Plugins.")).toBeTruthy();
  expect(api.fetchRoutines).not.toHaveBeenCalled();
});

test("shows the gate note and the load error", async () => {
  api.fetchRoutines.mockResolvedValue(listOf([], { gate: "Delegation is paused", schedulerGate: "scheduler off" }));
  const first = setup();
  expect((await screen.findByRole("status")).textContent).toBe("Delegation is paused");
  first.unmount();
  api.fetchRoutines.mockRejectedValue(new Error("hub down"));
  setup();
  expect((await screen.findByRole("alert")).textContent).toBe("hub down");
});

test("with no routines yet the view invites the user to create one", async () => {
  setup();
  expect(await screen.findByText(/No routines yet\. A routine runs a prompt on a schedule/)).toBeTruthy();
  expect(screen.getByText("Nothing unread. Results of your routines show up here.")).toBeTruthy();
});

test("the inbox shows unread results first, with a filter for all and an unread count", async () => {
  api.fetchInbox.mockResolvedValue({ items: inboxRuns(), unread: 2 });
  setup();
  const inbox = within(section("Inbox"));
  expect(await inbox.findByText("Triage")).toBeTruthy();
  expect(inbox.queryByText("Backup")).toBeNull();
  expect(inbox.getByRole("button", { name: /Unread/ }).textContent).toContain("2");
  expect(inbox.getByRole("button", { name: /Unread/ }).getAttribute("aria-pressed")).toBe("true");
  await userEvent.click(inbox.getByRole("button", { name: "All" }));
  expect(inbox.getByText("Backup")).toBeTruthy();
  expect(inbox.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
  await userEvent.click(inbox.getByRole("button", { name: /Unread/ }));
  expect(inbox.queryByText("Backup")).toBeNull();
});

test("an empty All list says no routine has finished", async () => {
  setup();
  await loaded();
  await userEvent.click(within(section("Inbox")).getByRole("button", { name: "All" }));
  expect(screen.getByText("No routine has finished yet.")).toBeTruthy();
});

test("opening an unread result marks it read, opens the task and tells the hub", async () => {
  api.fetchInbox.mockResolvedValue({ items: inboxRuns(), unread: 2 });
  const { onOpenTask } = setup();
  const inbox = within(section("Inbox"));
  await inbox.findByText("Triage");
  await userEvent.click(inbox.getAllByRole("button", { name: "Open run" })[0] as HTMLElement);
  expect(onOpenTask).toHaveBeenCalledWith("t1");
  expect(api.markInboxRead).toHaveBeenCalledWith("u1");
  expect(inbox.getByRole("button", { name: /Unread/ }).textContent).toContain("1");
});

test("opening a running result opens the task without marking it read", async () => {
  api.fetchInbox.mockResolvedValue({ items: inboxRuns(), unread: 2 });
  const { onOpenTask } = setup();
  const inbox = within(section("Inbox"));
  await inbox.findByText("Triage");
  const opens = inbox.getAllByRole("button", { name: "Open run" });
  await userEvent.click(opens[opens.length - 1] as HTMLElement);
  expect(onOpenTask).toHaveBeenCalledWith("t3");
  expect(api.markInboxRead).not.toHaveBeenCalled();
});

test("opening a result that is already read opens the task only", async () => {
  api.fetchInbox.mockResolvedValue({ items: inboxRuns(), unread: 2 });
  const { onOpenTask } = setup();
  const inbox = within(section("Inbox"));
  await inbox.findByText("Triage");
  await userEvent.click(inbox.getByRole("button", { name: "All" }));
  await userEvent.click(inbox.getAllByRole("button", { name: "Open run" })[1] as HTMLElement);
  expect(onOpenTask).toHaveBeenCalledWith("t2");
  expect(api.markInboxRead).not.toHaveBeenCalled();
});

test("the read toggle updates the list at once and calls the matching hub endpoint", async () => {
  api.fetchInbox.mockResolvedValue({ items: inboxRuns(), unread: 2 });
  setup();
  const inbox = within(section("Inbox"));
  await inbox.findByText("Triage");
  await userEvent.click(inbox.getByRole("button", { name: "Mark read" }));
  expect(api.markInboxRead).toHaveBeenCalledWith("u1");
  expect(inbox.queryByText("Triage")).toBeNull();
  await userEvent.click(inbox.getByRole("button", { name: "All" }));
  await userEvent.click(inbox.getAllByRole("button", { name: "Mark unread" })[0] as HTMLElement);
  expect(api.markInboxUnread).toHaveBeenCalledWith("u1");
});

test("a failed read toggle reports the error and reloads the inbox", async () => {
  api.fetchInbox.mockResolvedValue({ items: inboxRuns(), unread: 2 });
  api.markInboxRead.mockRejectedValueOnce(new Error("conflict"));
  const { onError } = setup();
  const inbox = within(section("Inbox"));
  await inbox.findByText("Triage");
  const loads = api.fetchRoutines.mock.calls.length;
  await userEvent.click(inbox.getByRole("button", { name: "Mark read" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("conflict"));
  await waitFor(() => expect(api.fetchRoutines.mock.calls.length).toBeGreaterThan(loads));
});

test("Mark all read clears the unread count and is disabled with nothing unread", async () => {
  api.fetchInbox.mockResolvedValue({ items: inboxRuns(), unread: 2 });
  setup();
  const inbox = within(section("Inbox"));
  await inbox.findByText("Triage");
  await userEvent.click(inbox.getByRole("button", { name: "Mark all read" }));
  expect(api.markInboxAllRead).toHaveBeenCalledTimes(1);
  expect(inbox.getByRole("button", { name: /Unread/ }).textContent).toContain("0");
  expect((inbox.getByRole("button", { name: "Mark all read" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a failed Mark all read reports a generic error for a non-error rejection", async () => {
  api.fetchInbox.mockResolvedValue({ items: inboxRuns(), unread: 2 });
  api.markInboxAllRead.mockRejectedValueOnce("odd");
  const { onError } = setup();
  await within(section("Inbox")).findByText("Triage");
  await userEvent.click(screen.getByRole("button", { name: "Mark all read" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not update the inbox."));
});

test("a routine card shows its schedule, agent, target, next run and last result", async () => {
  api.fetchRoutines.mockResolvedValue(
    listOf([
      routineRecord({
        nextFireAt: at(18, 0),
        schedule: { kind: "weekdays", days: [1, 2, 3, 4, 5], time: "09:00" },
        runner: "codex",
        repo: "cchub",
        cost: { costUsd: 1.5, tokensIn: 10, tokensOut: 5, runs: 3, pricedRuns: 3 },
        lastRun: routineRun({ status: "failed", startedAt: at(9, 0) }),
      }),
    ]),
  );
  setup();
  const routines = within(section("Routines"));
  await routines.findByText("Morning triage");
  const node = card("Morning triage");
  expect(node.textContent).toContain("Next Today 18:00");
  expect(node.textContent).toContain("Weekdays at 09:00 · Codex · vbss / cchub");
  expect(node.textContent).toContain("$1.50 total");
  expect(node.textContent).toContain("Last run Failed Today 09:00");
});

test("a paused routine says so and offers Resume, a running one cannot be run or deleted", async () => {
  api.fetchRoutines.mockResolvedValue(listOf([routineRecord({ id: "p", name: "Paused one", enabled: false }), routineRecord({ id: "q", name: "Busy one", running: true, nextFireAt: null })]));
  setup();
  await within(section("Routines")).findByText("Paused one");
  expect(card("Paused one").className).toContain("rt__card--paused");
  expect(within(card("Paused one")).getByText("Paused")).toBeTruthy();
  expect(within(card("Paused one")).getByRole("button", { name: "Resume" })).toBeTruthy();
  expect(within(card("Busy one")).getByText("Running now")).toBeTruthy();
  expect((within(card("Busy one")).getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(card("Busy one")).getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a routine with no scheduled time or last run shows the placeholder", async () => {
  api.fetchRoutines.mockResolvedValue(listOf([routineRecord({ nextFireAt: null, cwd: "C:/work", workspace: null })]));
  setup();
  await within(section("Routines")).findByText("Morning triage");
  expect(card("Morning triage").textContent).toContain("Not scheduled");
  expect(card("Morning triage").textContent).toContain("C:/work");
  expect(card("Morning triage").textContent).not.toContain("Last run");
});

test("Run now starts the routine then reloads, locking the buttons meanwhile", async () => {
  api.fetchRoutines.mockResolvedValue(listOf([routineRecord()]));
  let finish: (value: unknown) => void = () => undefined;
  api.runRoutineNow.mockReturnValueOnce(new Promise((done) => (finish = done)));
  setup();
  await within(section("Routines")).findByText("Morning triage");
  const loads = api.fetchRoutines.mock.calls.length;
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "Run now" }));
  expect(api.runRoutineNow).toHaveBeenCalledWith("r1");
  expect((within(card("Morning triage")).getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish(routineRun()));
  await waitFor(() => expect(api.fetchRoutines.mock.calls.length).toBeGreaterThan(loads));
  await waitFor(() => expect((within(card("Morning triage")).getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(false));
});

test("Pause and Resume flip the enabled flag", async () => {
  api.fetchRoutines.mockResolvedValue(listOf([routineRecord(), routineRecord({ id: "p", name: "Paused one", enabled: false })]));
  setup();
  await within(section("Routines")).findByText("Morning triage");
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "Pause" }));
  expect(api.setRoutineEnabled).toHaveBeenCalledWith("r1", false);
  await userEvent.click(within(card("Paused one")).getByRole("button", { name: "Resume" }));
  expect(api.setRoutineEnabled).toHaveBeenCalledWith("p", true);
});

test("a failing action reports the error with a fallback for non-errors", async () => {
  api.fetchRoutines.mockResolvedValue(listOf([routineRecord()]));
  api.runRoutineNow.mockRejectedValueOnce(new Error("agent offline")).mockRejectedValueOnce("odd");
  const { onError } = setup();
  await within(section("Routines")).findByText("Morning triage");
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "Run now" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("agent offline"));
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "Run now" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not start the routine."));
});

test("Delete asks first and removes the routine only after confirming", async () => {
  api.fetchRoutines.mockResolvedValue(listOf([routineRecord()]));
  setup();
  await within(section("Routines")).findByText("Morning triage");
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "Delete" }));
  const dialog = screen.getByRole("dialog", { name: 'Delete "Morning triage"?' });
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(api.deleteRoutine).not.toHaveBeenCalled();
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "Delete" }));
  await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
  expect(api.deleteRoutine).toHaveBeenCalledWith("r1");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("the missed runs setting lists the choices and saves a new one", async () => {
  setup();
  await loaded();
  const select = screen.getByLabelText("Catch up a missed run") as HTMLSelectElement;
  await waitFor(() => expect(select.disabled).toBe(false));
  expect(select.value).toBe("12");
  expect([...select.options].map((option) => option.textContent)).toEqual(["Never catch up", "Within 1 hour", "Within 3 hours", "Within 6 hours", "Within 12 hours", "Within 24 hours", "Within 48 hours", "Within 72 hours"]);
  api.fetchRoutineSettings.mockResolvedValue({ catchUpHours: 24 });
  await userEvent.selectOptions(select, "24");
  expect(api.saveRoutineSettings).toHaveBeenCalledWith({ catchUpHours: 24 });
  await waitFor(() => expect((screen.getByLabelText("Catch up a missed run") as HTMLSelectElement).value).toBe("24"));
});

test("the missed runs setting is disabled until the settings arrive", () => {
  api.fetchRoutineSettings.mockReturnValue(new Promise(() => undefined));
  setup();
  expect((screen.getByLabelText("Catch up a missed run") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByLabelText("Catch up a missed run") as HTMLSelectElement).value).toBe("12");
});

test("New routine opens the form, disables itself, and a created routine closes the form and reloads", async () => {
  api.fetchRoutines.mockResolvedValue(listOf([]));
  setup();
  await loaded();
  await userEvent.click(screen.getByRole("button", { name: "New routine" }));
  expect(screen.getByRole("region", { name: "New routine" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "New routine" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/No routines yet/)).toBeNull();
  await userEvent.type(screen.getByPlaceholderText("Morning triage"), "Triage");
  await userEvent.type(screen.getByPlaceholderText("Read the board, list what is blocked and write a short summary."), "Check");
  const loads = api.fetchRoutines.mock.calls.length;
  await userEvent.click(screen.getByRole("button", { name: "Create routine" }));
  expect(api.createRoutine).toHaveBeenCalledWith(expect.objectContaining({ name: "Triage", prompt: "Check", workspace: "vbss", schedule: { kind: "daily", time: "09:00" } }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "New routine" })).toBeNull());
  expect(api.fetchRoutines.mock.calls.length).toBeGreaterThan(loads);
});

test("a failed save keeps the form open and reports the error", async () => {
  api.createRoutine.mockRejectedValueOnce(new Error("name taken"));
  const { onError } = setup();
  await loaded();
  await userEvent.click(screen.getByRole("button", { name: "New routine" }));
  await userEvent.type(screen.getByPlaceholderText("Morning triage"), "Triage");
  await userEvent.type(screen.getByPlaceholderText("Read the board, list what is blocked and write a short summary."), "Check");
  await userEvent.click(screen.getByRole("button", { name: "Create routine" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("name taken"));
  expect(screen.getByRole("region", { name: "New routine" })).toBeTruthy();
});

test("Edit opens the form with the routine, saves through update and Cancel closes it", async () => {
  api.fetchRoutines.mockResolvedValue(listOf([routineRecord()]));
  setup();
  await within(section("Routines")).findByText("Morning triage");
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "Edit" }));
  expect(screen.getByRole("region", { name: "Edit routine" })).toBeTruthy();
  expect((within(card("Morning triage")).getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("region", { name: "Edit routine" })).toBeNull();
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "Edit" }));
  await userEvent.type(screen.getByPlaceholderText("Morning triage"), " v2");
  await userEvent.click(screen.getByRole("button", { name: "Save routine" }));
  expect(api.updateRoutine).toHaveBeenCalledWith("r1", expect.objectContaining({ name: "Morning triage v2" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Edit routine" })).toBeNull());
});

test("History loads the runs of the routine and hides them again", async () => {
  api.fetchRoutines.mockResolvedValue(listOf([routineRecord()]));
  let finish: (value: unknown) => void = () => undefined;
  api.fetchRoutineDetail.mockReturnValue(new Promise((done) => (finish = done)));
  const { onOpenTask } = setup();
  await within(section("Routines")).findByText("Morning triage");
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "History" }));
  expect(within(card("Morning triage")).getByText("Loading the history...")).toBeTruthy();
  await act(async () => finish({ ...routineRecord(), runs: [routineRun({ id: "h1", routineName: "Morning triage", summary: "History one" }), routineRun({ id: "h2", summary: "History two", status: "failed" })] }));
  expect(await within(card("Morning triage")).findByText("History one")).toBeTruthy();
  expect(api.fetchRoutineDetail).toHaveBeenCalledWith("r1");
  expect(within(card("Morning triage")).getByRole("button", { name: "History" }).getAttribute("aria-expanded")).toBe("true");
  await userEvent.click(within(card("Morning triage")).getAllByRole("button", { name: "Open run" })[0] as HTMLElement);
  expect(onOpenTask).toHaveBeenCalledWith("t1");
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "History" }));
  expect(within(card("Morning triage")).queryByText("History one")).toBeNull();
});

test("History says there are no runs yet, also when the history cannot be loaded", async () => {
  api.fetchRoutines.mockResolvedValue(listOf([routineRecord()]));
  setup();
  await within(section("Routines")).findByText("Morning triage");
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "History" }));
  expect(await within(card("Morning triage")).findByText("No runs yet.")).toBeTruthy();
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "History" }));
  api.fetchRoutineDetail.mockRejectedValueOnce(new Error("down"));
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "History" }));
  expect(await within(card("Morning triage")).findByText("No runs yet.")).toBeTruthy();
});

test("a history answer that arrives after the card was collapsed is dropped", async () => {
  api.fetchRoutines.mockResolvedValue(listOf([routineRecord()]));
  let finish: (value: unknown) => void = () => undefined;
  api.fetchRoutineDetail.mockReturnValueOnce(new Promise((done) => (finish = done)));
  setup();
  await within(section("Routines")).findByText("Morning triage");
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "History" }));
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "History" }));
  await act(async () => finish({ ...routineRecord(), runs: [routineRun({ summary: "late" })] }));
  expect(screen.queryByText("late")).toBeNull();
});

test("a history failure that arrives after the card was collapsed is dropped", async () => {
  api.fetchRoutines.mockResolvedValue(listOf([routineRecord()]));
  let fail: (reason: Error) => void = () => undefined;
  api.fetchRoutineDetail.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
  setup();
  await within(section("Routines")).findByText("Morning triage");
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "History" }));
  await userEvent.click(within(card("Morning triage")).getByRole("button", { name: "History" }));
  await act(async () => fail(new Error("late")));
  expect(screen.queryByText("No runs yet.")).toBeNull();
});

test("a routines event from the hub reloads the list", async () => {
  api.fetchRoutines.mockResolvedValueOnce(listOf([])).mockResolvedValue(listOf([routineRecord({ name: "Fresh one" })]));
  setup();
  await loaded();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: NOW });
  act(() => listeners.forEach((listener) => listener({ kind: "routines" })));
  await act(async () => vi.advanceTimersByTimeAsync(200));
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  expect(await within(section("Routines")).findByText("Fresh one")).toBeTruthy();
});

test("the relative times move on every minute", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: NOW });
  api.fetchRoutines.mockResolvedValue(listOf([routineRecord({ nextFireAt: at(15, 30) })]));
  setup();
  await within(section("Routines")).findByText("Morning triage");
  expect(card("Morning triage").textContent).toContain("Next Today 15:30");
  vi.setSystemTime(new Date(2026, 10, 17, 9, 0));
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(card("Morning triage").textContent).toContain("Next Yesterday 15:30");
});
