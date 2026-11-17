import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { routineRun } from "../test-support/u5-fixtures";
import { RoutineRunRow } from "./RoutineRunRow";

vi.mock("./ShowMore", () => ({ ClampText: ({ children, className }: { children: string; className: string }) => <p className={className}>{children}</p> }));

const NOW = new Date(2026, 10, 16, 15, 0).getTime();
const at = (hour: number, minute: number): number => new Date(2026, 10, 16, hour, minute).getTime();

const setup = (run = routineRun({ startedAt: at(12, 30) }), props: Partial<Parameters<typeof RoutineRunRow>[0]> = {}) => {
  const onOpen = vi.fn();
  const onToggleRead = vi.fn();
  const view = render(
    <ul>
      <RoutineRunRow run={run} now={NOW} showName onOpen={onOpen} onToggleRead={onToggleRead} {...props} />
    </ul>,
  );
  return { onOpen, onToggleRead, ...view };
};

test("a finished unread run shows its status, name, trigger and time, and is highlighted as unread", () => {
  setup();
  expect(screen.getByText("OK").getAttribute("data-status")).toBe("completed");
  expect(screen.getByText("Morning triage")).toBeTruthy();
  expect(screen.getByText("Scheduled · Today 12:30")).toBeTruthy();
  expect(document.querySelector("li")?.className).toContain("rt__run--unread");
  expect(screen.getByText("All clear").className).toBe("rt__summary");
});

test("a read run is not highlighted and the name falls back or hides", () => {
  const first = setup(routineRun({ read: true, routineName: null, startedAt: at(12, 30) }));
  expect(document.querySelector("li")?.className).not.toContain("rt__run--unread");
  expect(screen.getByText("Routine")).toBeTruthy();
  first.unmount();
  setup(routineRun({ startedAt: at(12, 30) }), { showName: false });
  expect(screen.queryByText("Morning triage")).toBeNull();
});

test("a running run is never marked unread and has no read toggle", () => {
  setup(routineRun({ status: "running", read: false, startedAt: at(14, 0) }));
  expect(document.querySelector("li")?.className).not.toContain("rt__run--unread");
  expect(screen.getByText("Running").className).toContain("tag--go");
  expect(screen.queryByRole("button", { name: /Mark/ })).toBeNull();
});

test("the due time is shown for a catch-up run instead of the start time", () => {
  setup(routineRun({ trigger: "catch-up", dueAt: at(9, 0), startedAt: at(12, 30) }));
  expect(screen.getByText("Catch-up · Today 09:00")).toBeTruthy();
});

test("Open run opens the run's task and only exists when there is a task", async () => {
  const { onOpen, unmount } = setup();
  await userEvent.click(screen.getByRole("button", { name: "Open run" }));
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "run1", taskId: "t1" }));
  unmount();
  setup(routineRun({ taskId: null }));
  expect(screen.queryByRole("button", { name: "Open run" })).toBeNull();
});

test("the read toggle flips its label with the state and calls back with the run", async () => {
  const unread = setup();
  await userEvent.click(screen.getByRole("button", { name: "Mark read" }));
  expect(unread.onToggleRead).toHaveBeenCalledWith(expect.objectContaining({ id: "run1" }));
  unread.unmount();
  setup(routineRun({ read: true }));
  expect(screen.getByRole("button", { name: "Mark unread" })).toBeTruthy();
});

test("without a toggle callback the read button is not shown", () => {
  setup(routineRun(), { onToggleRead: undefined });
  expect(screen.queryByRole("button", { name: /Mark/ })).toBeNull();
});

test("the detail line joins the note and the failure, and missed runs explain the skipped slots", () => {
  const failed = setup(routineRun({ status: "failed", note: "retried", error: "exit 1", summary: null }));
  expect(screen.getByText("retried · exit 1").className).toBe("rt__detail");
  expect(document.querySelector(".rt__summary")).toBeNull();
  failed.unmount();
  setup(routineRun({ status: "missed", missedSlots: 3, taskId: null }));
  expect(screen.getByText("3 runs skipped while the hub was off")).toBeTruthy();
});

test("the cost shows with a tooltip when the run has priced cost", () => {
  setup(routineRun({ cost: { costUsd: 0.42, tokensIn: 100, tokensOut: 50, runs: 1, pricedRuns: 1 } }));
  const cost = screen.getByText("$0.42");
  expect(cost.title).toContain("1 run");
});

test("a run without a summary, detail or cost shows only its header", () => {
  setup(routineRun({ summary: null }));
  expect(document.querySelector(".rt__detail")).toBeNull();
  expect(document.querySelector(".rt__summary")).toBeNull();
});
