import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { WorkspaceRecord } from "../delegation";
import { emptyRoutineForm, formFromRoutine } from "../routine-model";
import { routineRecord } from "../test-support/u5-fixtures";
import { RoutineForm } from "./RoutineForm";

const api = vi.hoisted(() => ({ previewSchedule: vi.fn<(schedule: unknown) => Promise<{ next: number[] }>>() }));

vi.mock("../routines-api", () => ({ previewSchedule: api.previewSchedule }));

const workspaces = [
  { name: "vbss", file: "vbss.code-workspace", contextPath: null, repos: [{ name: "cchub", path: "C:/cchub" }, { name: "ui", path: "C:/ui" }], error: null },
  { name: "space", file: "space.code-workspace", contextPath: null, repos: [], error: null },
] as WorkspaceRecord[];

beforeEach(() => {
  api.previewSchedule.mockReset().mockResolvedValue({ next: [] });
});

const setup = (props: Partial<Parameters<typeof RoutineForm>[0]> = {}) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const view = render(<RoutineForm initial={null} workspaces={workspaces} editing={false} busy={false} onSubmit={onSubmit} onCancel={onCancel} {...props} />);
  return { onSubmit, onCancel, ...view };
};

const textbox = (placeholder: string): HTMLInputElement => screen.getByPlaceholderText(placeholder) as HTMLInputElement;
const select = (label: string): HTMLSelectElement => screen.getByText(label, { selector: "span" }).closest("label")?.querySelector("select") as HTMLSelectElement;
const create = (): HTMLButtonElement => screen.getByRole("button", { name: "Create routine" }) as HTMLButtonElement;

const fillBasics = async (): Promise<void> => {
  await userEvent.type(textbox("Morning triage"), "Triage");
  await userEvent.type(textbox("Read the board, list what is blocked and write a short summary."), "Check the board");
};

test("a new routine starts empty on the first workspace and asks for a name first", () => {
  setup();
  expect(screen.getByRole("region", { name: "New routine" })).toBeTruthy();
  expect(select("Workspace").value).toBe("vbss");
  expect(create().disabled).toBe(true);
  expect(screen.getByText("Give the routine a name.")).toBeTruthy();
});

test("the problem line follows the form and Create is enabled once everything is valid", async () => {
  setup();
  await userEvent.type(textbox("Morning triage"), "Triage");
  expect(screen.getByText("Write what the routine should do.")).toBeTruthy();
  await userEvent.type(textbox("Read the board, list what is blocked and write a short summary."), "Check");
  expect(screen.queryByText(/Give the routine|Write what/)).toBeNull();
  expect(create().disabled).toBe(false);
});

test("Create sends the payload of a workspace routine with the chosen repo and agent", async () => {
  const { onSubmit } = setup();
  await fillBasics();
  await userEvent.selectOptions(select("Repo"), "ui");
  await userEvent.selectOptions(select("Agent"), "codex");
  await userEvent.click(screen.getByRole("checkbox", { name: "Turned on" }));
  await userEvent.click(create());
  expect(onSubmit).toHaveBeenCalledWith({
    name: "Triage",
    prompt: "Check the board",
    runner: "codex",
    schedule: { kind: "daily", time: "09:00" },
    enabled: false,
    workspace: "vbss",
    repo: "ui",
  });
});

test("changing the workspace resets the repo and lists that workspace's repos", async () => {
  setup();
  await userEvent.selectOptions(select("Repo"), "cchub");
  await userEvent.selectOptions(select("Workspace"), "space");
  expect(select("Repo").value).toBe("");
  expect([...select("Repo").options].map((option) => option.value)).toEqual([""]);
  await userEvent.selectOptions(select("Workspace"), "vbss");
  expect([...select("Repo").options].map((option) => option.value)).toEqual(["", "cchub", "ui"]);
});

test("a folder target swaps the workspace pickers for a folder input and sends the cwd", async () => {
  const { onSubmit } = setup();
  await fillBasics();
  await userEvent.selectOptions(select("Runs in"), "cwd");
  expect(screen.queryByText("Workspace")).toBeNull();
  expect(screen.getByText("Enter the folder to run in.")).toBeTruthy();
  await userEvent.type(textbox("Absolute path of a folder"), "C:/work");
  await userEvent.click(create());
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ cwd: "C:/work", name: "Triage" }));
  await userEvent.selectOptions(select("Runs in"), "workspace");
  expect(select("Workspace")).toBeTruthy();
});

test("with no workspaces the picker offers a placeholder and the form asks for one", async () => {
  setup({ workspaces: [] });
  expect(select("Workspace").value).toBe("");
  expect(within(select("Workspace")).getByText("Pick a workspace")).toBeTruthy();
  await fillBasics();
  expect(screen.getByText("Pick a workspace.")).toBeTruthy();
  expect(create().disabled).toBe(true);
});

test("editing starts from the routine, shows the edit labels and keeps a workspace that no longer exists", async () => {
  const routine = routineRecord({ workspace: "gone", repo: "old", runner: "codex", schedule: { kind: "weekdays", days: [1, 3], time: "07:30" } });
  const { onSubmit } = setup({ initial: formFromRoutine(routine), editing: true });
  expect(screen.getByRole("region", { name: "Edit routine" })).toBeTruthy();
  expect(textbox("Morning triage").value).toBe("Morning triage");
  expect(select("Workspace").value).toBe("gone");
  expect(within(select("Workspace")).getByText("gone")).toBeTruthy();
  expect(select("Agent").value).toBe("codex");
  await userEvent.click(screen.getByRole("button", { name: "Save routine" }));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ workspace: "gone", repo: "old", runner: "codex", schedule: { kind: "weekdays", days: [1, 3], time: "07:30" } }));
});

test("chosen days toggle and an empty selection blocks the form", async () => {
  setup({ initial: { ...emptyRoutineForm("vbss"), name: "n", prompt: "p", scheduleKind: "weekdays" } });
  const days = within(screen.getByRole("group", { name: "Days" }));
  expect(days.getAllByRole("button").map((button) => button.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  expect(days.getByRole("button", { name: "Mon" }).getAttribute("aria-pressed")).toBe("true");
  expect(days.getByRole("button", { name: "Sat" }).getAttribute("aria-pressed")).toBe("false");
  await userEvent.click(days.getByRole("button", { name: "Sat" }));
  expect(days.getByRole("button", { name: "Sat" }).getAttribute("aria-pressed")).toBe("true");
  for (const name of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) await userEvent.click(days.getByRole("button", { name }));
  expect(screen.getByText("Pick at least one day.")).toBeTruthy();
  expect(create().disabled).toBe(true);
});

test("an interval schedule shows the hours input with its hint and validates the range", async () => {
  const { onSubmit } = setup({ initial: { ...emptyRoutineForm("vbss"), name: "n", prompt: "p", scheduleKind: "interval" } });
  expect(screen.queryByText("Time")).toBeNull();
  const hours = screen.getByText("Every (hours)").closest("label")?.querySelector("input") as HTMLInputElement;
  expect(hours.value).toBe("6");
  expect(screen.getByText("From 1 to 168 hours. Times are in this computer's local time.")).toBeTruthy();
  fireEvent.change(hours, { target: { value: "500" } });
  expect(screen.getByText("Hours must be a whole number from 1 to 168.")).toBeTruthy();
  expect(create().disabled).toBe(true);
  fireEvent.change(hours, { target: { value: "12" } });
  await userEvent.click(create());
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ schedule: { kind: "interval", everyHours: 12 } }));
});

test("switching the schedule kind and the time updates the payload", async () => {
  const { onSubmit } = setup();
  await fillBasics();
  await userEvent.selectOptions(select("Schedule"), "weekdays");
  expect(screen.getByRole("group", { name: "Days" })).toBeTruthy();
  fireEvent.change(screen.getByText("Time").closest("label")?.querySelector("input") as HTMLInputElement, { target: { value: "18:45" } });
  await userEvent.click(create());
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ schedule: { kind: "weekdays", days: [1, 2, 3, 4, 5], time: "18:45" } }));
});

test("an unfinished time blocks the form with a hint", () => {
  setup({ initial: { ...emptyRoutineForm("vbss"), name: "n", prompt: "p" } });
  fireEvent.change(screen.getByText("Time").closest("label")?.querySelector("input") as HTMLInputElement, { target: { value: "" } });
  expect(screen.getByText("Pick a time of day.")).toBeTruthy();
  expect(create().disabled).toBe(true);
});

test("the next run times are previewed from the hub after a short pause", async () => {
  const base = new Date(2026, 10, 16, 15, 0).getTime();
  const day = 86_400_000;
  api.previewSchedule.mockResolvedValue({ next: [base + 3_600_000, base + day + 3_600_000, base + 2 * day + 3_600_000, base + 3 * day + 3_600_000] });
  setup();
  expect(api.previewSchedule).not.toHaveBeenCalled();
  const line = await screen.findByText(/^Next: /);
  expect(api.previewSchedule).toHaveBeenCalledWith({ kind: "daily", time: "09:00" });
  expect((line.textContent ?? "").split(" · ")).toHaveLength(3);
});

test("a failing preview leaves no next-run line and an invalid schedule is not previewed", async () => {
  api.previewSchedule.mockRejectedValue(new Error("down"));
  const first = setup();
  await vi.waitFor(() => expect(api.previewSchedule).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(/^Next: /)).toBeNull();
  first.unmount();
  api.previewSchedule.mockClear();
  setup({ initial: { ...emptyRoutineForm("vbss"), scheduleKind: "interval", everyHours: "0" } });
  await new Promise((done) => setTimeout(done, 350));
  expect(api.previewSchedule).not.toHaveBeenCalled();
});

test("a preview answer that arrives after unmount or after the schedule changed is dropped", async () => {
  let finish: (value: { next: number[] }) => void = () => undefined;
  api.previewSchedule.mockReturnValueOnce(new Promise((done) => (finish = done)));
  const { unmount } = setup();
  await vi.waitFor(() => expect(api.previewSchedule).toHaveBeenCalledTimes(1));
  unmount();
  finish({ next: [Date.now() + 1000] });
  await Promise.resolve();
  expect(document.body.textContent).toBe("");
  let fail: (reason: Error) => void = () => undefined;
  api.previewSchedule.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
  const second = setup();
  await vi.waitFor(() => expect(api.previewSchedule).toHaveBeenCalledTimes(2));
  second.unmount();
  fail(new Error("late"));
  await Promise.resolve();
  expect(document.body.textContent).toBe("");
});

test("Cancel reports back and a busy form cannot be submitted", async () => {
  const { onCancel, onSubmit } = setup({ initial: { ...emptyRoutineForm("vbss"), name: "n", prompt: "p" }, busy: true });
  expect(create().disabled).toBe(true);
  await userEvent.click(create());
  expect(onSubmit).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("the name field is capped at 80 characters", () => {
  setup();
  expect(textbox("Morning triage").maxLength).toBe(80);
});
