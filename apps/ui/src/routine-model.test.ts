import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPayload,
  catchUpLabel,
  catchUpOptions,
  describeSchedule,
  emptyRoutineForm,
  formFromRoutine,
  formProblem,
  formatClock,
  formatLocalTime,
  gateNote,
  creatorLabel,
  isRoutineTask,
  markAll,
  markItem,
  nextFireLabel,
  routineIdOfTask,
  runDetail,
  runTone,
  scheduleFromForm,
  sessionsBadgeWithRoutines,
  routineFailureNotice,
  shouldNotifyTask,
  targetLabel,
  toggleDay,
  unreadOf,
  WEEKDAY_SHORT,
  type RoutineForm,
} from "./routine-model";
import type { CostTotals, RoutineRecord, RoutineRunRecord } from "./types";

const at = (day: number, hour: number, minute = 0): number => new Date(2026, 10, day, hour, minute).getTime();

const noCost: CostTotals = { costUsd: null, tokensIn: null, tokensOut: null, runs: 0, pricedRuns: 0 };

const filled = (patch: Partial<RoutineForm> = {}): RoutineForm => ({ ...emptyRoutineForm("vbss"), name: "Morning triage", prompt: "Check the board", ...patch });

const routine = (patch: Partial<RoutineRecord> = {}): RoutineRecord => ({
  id: "r1",
  name: "Morning triage",
  prompt: "Check the board",
  workspace: "vbss",
  repo: null,
  cwd: null,
  runner: "claude",
  model: null,
  schedule: { kind: "daily", time: "09:00" },
  enabled: true,
  anchorAt: 0,
  nextFireAt: null,
  lastFiredAt: null,
  createdAt: 0,
  updatedAt: 0,
  running: false,
  lastRun: null,
  cost: noCost,
  ...patch,
});

const run = (patch: Partial<RoutineRunRecord> = {}): RoutineRunRecord => ({
  id: "x1",
  routineId: "r1",
  routineName: "Morning triage",
  taskId: "t1",
  trigger: "schedule",
  status: "completed",
  dueAt: null,
  startedAt: 0,
  finishedAt: null,
  summary: null,
  error: null,
  note: null,
  missedSlots: null,
  read: false,
  readAt: null,
  cost: noCost,
  ...patch,
});

describe("scheduleFromForm", () => {
  it("builds a daily schedule from the time", () => {
    assert.deepEqual(scheduleFromForm(filled({ scheduleKind: "daily", time: "07:30" })), { kind: "daily", time: "07:30" });
  });

  it("builds a weekdays schedule with sorted unique days", () => {
    assert.deepEqual(scheduleFromForm(filled({ scheduleKind: "weekdays", time: "18:05", days: [5, 1, 1, 3] })), { kind: "weekdays", days: [1, 3, 5], time: "18:05" });
  });

  it("builds an interval schedule from whole hours", () => {
    assert.deepEqual(scheduleFromForm(filled({ scheduleKind: "interval", everyHours: " 6 " })), { kind: "interval", everyHours: 6 });
  });

  it("rejects a bad time, no days and bad hours with a message", () => {
    assert.equal(typeof scheduleFromForm(filled({ time: "9:00" })), "string");
    assert.equal(typeof scheduleFromForm(filled({ time: "24:00" })), "string");
    assert.equal(typeof scheduleFromForm(filled({ scheduleKind: "weekdays", days: [] })), "string");
    assert.equal(typeof scheduleFromForm(filled({ scheduleKind: "interval", everyHours: "0" })), "string");
    assert.equal(typeof scheduleFromForm(filled({ scheduleKind: "interval", everyHours: "169" })), "string");
    assert.equal(typeof scheduleFromForm(filled({ scheduleKind: "interval", everyHours: "1.5" })), "string");
  });
});

describe("formProblem", () => {
  it("accepts a complete form", () => {
    assert.equal(formProblem(filled()), null);
  });

  it("asks for each missing piece in order", () => {
    assert.match(formProblem(filled({ name: "  " })) ?? "", /name/i);
    assert.match(formProblem(filled({ prompt: "" })) ?? "", /what the routine should do/i);
    assert.match(formProblem(filled({ workspace: "" })) ?? "", /workspace/i);
    assert.match(formProblem(filled({ target: "cwd", cwd: "" })) ?? "", /folder/i);
  });

  it("limits the name length", () => {
    assert.match(formProblem(filled({ name: "x".repeat(81) })) ?? "", /80/);
  });
});

describe("buildPayload", () => {
  it("sends workspace and repo without cwd", () => {
    const payload = buildPayload(filled({ repo: " vbss-cchub " }));
    assert.deepEqual(payload, {
      name: "Morning triage",
      prompt: "Check the board",
      runner: "claude",
      schedule: { kind: "daily", time: "09:00" },
      enabled: true,
      workspace: "vbss",
      repo: "vbss-cchub",
    });
  });

  it("sends a null repo when empty so an edit can clear it", () => {
    const payload = buildPayload(filled());
    assert.deepEqual(typeof payload === "string" ? null : payload.repo, null);
  });

  it("sends cwd alone for a folder target", () => {
    const payload = buildPayload(filled({ target: "cwd", cwd: " C:\\tmp\\scratch ", workspace: "vbss", runner: "codex", enabled: false }));
    assert.deepEqual(payload, {
      name: "Morning triage",
      prompt: "Check the board",
      runner: "codex",
      schedule: { kind: "daily", time: "09:00" },
      enabled: false,
      cwd: "C:\\tmp\\scratch",
    });
  });

  it("returns the problem text for an invalid form", () => {
    assert.equal(typeof buildPayload(filled({ name: "" })), "string");
  });
});

describe("formFromRoutine", () => {
  it("round trips a weekdays routine through the form and back to the same payload", () => {
    const source = routine({ schedule: { kind: "weekdays", days: [1, 2, 3], time: "08:15" }, repo: "vbss-cchub", runner: "codex", enabled: false });
    const payload = buildPayload(formFromRoutine(source));
    assert.deepEqual(payload, {
      name: "Morning triage",
      prompt: "Check the board",
      runner: "codex",
      schedule: { kind: "weekdays", days: [1, 2, 3], time: "08:15" },
      enabled: false,
      workspace: "vbss",
      repo: "vbss-cchub",
    });
  });

  it("round trips an interval routine with a folder target", () => {
    const source = routine({ workspace: null, cwd: "C:\\tmp\\scratch", schedule: { kind: "interval", everyHours: 12 } });
    const form = formFromRoutine(source);
    assert.equal(form.target, "cwd");
    assert.equal(form.everyHours, "12");
    assert.deepEqual(buildPayload(form), {
      name: "Morning triage",
      prompt: "Check the board",
      runner: "claude",
      schedule: { kind: "interval", everyHours: 12 },
      enabled: true,
      cwd: "C:\\tmp\\scratch",
    });
  });
});

describe("toggleDay", () => {
  it("adds and removes days keeping them sorted", () => {
    assert.deepEqual(toggleDay([1, 3], 2), [1, 2, 3]);
    assert.deepEqual(toggleDay([1, 2, 3], 2), [1, 3]);
    assert.deepEqual(toggleDay([], 0), [0]);
  });
});

describe("describeSchedule", () => {
  it("names the common shapes", () => {
    assert.equal(describeSchedule({ kind: "daily", time: "09:00" }), "Every day at 09:00");
    assert.equal(describeSchedule({ kind: "weekdays", days: [1, 2, 3, 4, 5], time: "09:00" }), "Weekdays at 09:00");
    assert.equal(describeSchedule({ kind: "weekdays", days: [6, 0], time: "10:30" }), "Weekends at 10:30");
    assert.equal(describeSchedule({ kind: "weekdays", days: [0, 1, 2, 3, 4, 5, 6], time: "10:30" }), "Every day at 10:30");
    assert.equal(describeSchedule({ kind: "weekdays", days: [5, 1], time: "07:00" }), "Mon, Fri at 07:00");
    assert.equal(describeSchedule({ kind: "interval", everyHours: 1 }), "Every hour");
    assert.equal(describeSchedule({ kind: "interval", everyHours: 6 }), "Every 6 hours");
  });
});

describe("formatLocalTime", () => {
  const now = at(16, 14, 30);

  it("uses today, tomorrow and yesterday in the local calendar", () => {
    assert.equal(formatLocalTime(at(16, 18, 5), now), "Today 18:05");
    assert.equal(formatLocalTime(at(17, 9, 0), now), "Tomorrow 09:00");
    assert.equal(formatLocalTime(at(15, 23, 59), now), "Yesterday 23:59");
  });

  it("uses the weekday inside the next week and the date after that", () => {
    const later = at(19, 7, 0);
    assert.equal(formatLocalTime(later, now), `${WEEKDAY_SHORT[new Date(later).getDay()]} 07:00`);
    assert.equal(formatLocalTime(at(25, 7, 0), now), "Nov 25 07:00");
  });

  it("treats a time just after local midnight as the next day", () => {
    assert.equal(formatLocalTime(at(17, 0, 5), at(16, 23, 50)), "Tomorrow 00:05");
  });

  it("formats the clock as 24 hour HH:MM", () => {
    assert.equal(formatClock(at(16, 5, 7)), "05:07");
    assert.equal(formatClock(at(16, 23, 0)), "23:00");
  });
});

describe("nextFireLabel", () => {
  const now = at(16, 14, 30);

  it("shows the next fire in local time", () => {
    assert.equal(nextFireLabel(routine({ nextFireAt: at(17, 9, 0) }), now), "Next Tomorrow 09:00");
  });

  it("shows paused for a disabled routine even with a stored time", () => {
    assert.equal(nextFireLabel(routine({ enabled: false, nextFireAt: at(17, 9, 0) }), now), "Paused");
  });

  it("shows running while a run is in progress", () => {
    assert.equal(nextFireLabel(routine({ running: true, nextFireAt: at(17, 9, 0) }), now), "Running now");
  });

  it("says not scheduled without a time", () => {
    assert.equal(nextFireLabel(routine({ nextFireAt: null }), now), "Not scheduled");
  });
});

describe("runTone and runDetail", () => {
  it("colours only states that need a look", () => {
    assert.equal(runTone("running"), "go");
    assert.equal(runTone("completed"), "muted");
    assert.equal(runTone("failed"), "hold");
    assert.equal(runTone("interrupted"), "hold");
    assert.equal(runTone("attention"), "pend");
    assert.equal(runTone("missed"), "pend");
    assert.equal(runTone("skipped"), "muted");
  });

  it("explains a missed run with its slot count when the server gave no note", () => {
    assert.equal(runDetail(run({ status: "missed", missedSlots: 3 })), "3 runs skipped while the hub was off");
    assert.equal(runDetail(run({ status: "missed", missedSlots: 1 })), "1 run skipped while the hub was off");
  });

  it("prefers the server note and adds the error of a failed run", () => {
    assert.equal(runDetail(run({ status: "missed", missedSlots: 3, note: "older than 12 hours" })), "older than 12 hours");
    assert.equal(runDetail(run({ status: "failed", error: "exit 1" })), "exit 1");
    assert.equal(runDetail(run({ status: "completed", error: "ignored" })), null);
  });
});

describe("routine tasks and notifications", () => {
  it("recognises tasks created by a routine", () => {
    assert.equal(isRoutineTask({ createdBy: "routine:abc" }), true);
    assert.equal(isRoutineTask({ createdBy: "review:abc" }), false);
    assert.equal(isRoutineTask({ createdBy: null }), false);
  });

  it("skips the generic notification only for routine tasks", () => {
    assert.equal(shouldNotifyTask({ createdBy: "routine:abc" }), false);
    assert.equal(shouldNotifyTask({ createdBy: "mcp" }), true);
    assert.equal(shouldNotifyTask({ createdBy: null }), true);
    const base = { runId: "run-1", taskId: "task-1", routineName: "nightly check", error: "error_max_turns" };
    assert.deepEqual(routineFailureNotice({ ...base, status: "failed" }), { id: "task-1", title: "nightly check", detail: "error_max_turns" });
    assert.deepEqual(routineFailureNotice({ ...base, taskId: null, routineName: null, status: "failed" }), { id: "run-1", title: "Routine", detail: "error_max_turns" });
    for (const status of ["completed", "running", "skipped", "missed", "cancelled", "interrupted", "attention"] as const) assert.equal(routineFailureNotice({ ...base, status }), null, status);
  });

  it("labels the creator of routine and review tasks without the internal id", () => {
    assert.equal(creatorLabel("routine:abc", "mcp"), "routine");
    assert.equal(creatorLabel("review:abc", "mcp"), "review");
    assert.equal(creatorLabel("claude-code", "mcp"), "claude-code");
    assert.equal(creatorLabel(null, "mcp"), "mcp");
  });

  it("reads the routine id from the creator", () => {
    assert.equal(routineIdOfTask({ createdBy: "routine:abc" }), "abc");
    assert.equal(routineIdOfTask({ createdBy: "mcp" }), null);
  });
});

describe("inbox helpers", () => {
  const items = [run({ id: "a", read: false }), run({ id: "b", read: true, readAt: 5 }), run({ id: "c", read: false })];

  it("counts unread items", () => {
    assert.equal(unreadOf(items), 2);
  });

  it("marks one item read and back to unread", () => {
    const read = markItem(items, "a", true, 100);
    assert.deepEqual(read.map((item) => [item.id, item.read, item.readAt]), [["a", true, 100], ["b", true, 5], ["c", false, null]]);
    assert.equal(unreadOf(read), 1);
    assert.equal(unreadOf(markItem(read, "a", false, 200)), 2);
  });

  it("marks all read without touching items already read", () => {
    const read = markAll(items, 300);
    assert.equal(unreadOf(read), 0);
    assert.equal(read.find((item) => item.id === "b")?.readAt, 5);
    assert.equal(read.find((item) => item.id === "a")?.readAt, 300);
  });
});

describe("sessionsBadgeWithRoutines", () => {
  it("keeps the attention count and mentions unread results in the title", () => {
    assert.deepEqual(sessionsBadgeWithRoutines("Sessions (2): 2 sessions need you", 2, 3), { count: 2, quiet: false, title: "Sessions (2): 2 sessions need you; 3 routine results unread" });
  });

  it("shows a quiet count when only routine results are unread", () => {
    assert.deepEqual(sessionsBadgeWithRoutines("Sessions", 0, 1), { count: 1, quiet: true, title: "Sessions: 1 routine result unread" });
  });

  it("shows nothing when nothing is waiting", () => {
    assert.deepEqual(sessionsBadgeWithRoutines("Sessions", 0, 0), { count: 0, quiet: false, title: "Sessions" });
  });
});

describe("catch-up choices", () => {
  it("labels hours and the never option", () => {
    assert.equal(catchUpLabel(0), "Never catch up");
    assert.equal(catchUpLabel(1), "Within 1 hour");
    assert.equal(catchUpLabel(12), "Within 12 hours");
  });

  it("keeps an unusual saved value in the list in order", () => {
    assert.deepEqual(catchUpOptions(5).map((option) => option.value), [0, 1, 3, 5, 6, 12, 24, 48, 72]);
    assert.deepEqual(catchUpOptions(12).map((option) => option.value), [0, 1, 3, 6, 12, 24, 48, 72]);
  });
});

describe("targetLabel and gateNote", () => {
  it("shows the folder or workspace with repo", () => {
    assert.equal(targetLabel({ workspace: null, repo: null, cwd: "C:\\tmp" }), "C:\\tmp");
    assert.equal(targetLabel({ workspace: "vbss", repo: "vbss-cchub", cwd: null }), "vbss / vbss-cchub");
    assert.equal(targetLabel({ workspace: "vbss", repo: null, cwd: null }), "vbss");
  });

  it("prefers the plugin gate over the scheduler gate", () => {
    assert.equal(gateNote("Delegated is off", "scheduler paused"), "Delegated is off");
    assert.equal(gateNote(null, "scheduler paused"), "scheduler paused");
    assert.equal(gateNote(null, null), null);
  });
});
