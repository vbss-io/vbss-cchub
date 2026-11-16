import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { serverDir } from "./helpers.js";
import { decideDue, detectClockJump, lastDueAtOrBefore, nextFireAfter, parseSchedule, upcomingFires, type RoutineSchedule } from "../src/routine-schedule.js";

const local = (y: number, m: number, d: number, h = 0, mi = 0): number => new Date(y, m - 1, d, h, mi, 0, 0).getTime();
const HOUR = 3_600_000;

describe("routine schedule parsing", () => {
  it("accepts the three schedule kinds and rejects bad input", () => {
    assert.deepEqual(parseSchedule({ kind: "daily", time: "07:30" }), { kind: "daily", time: "07:30" });
    assert.deepEqual(parseSchedule({ kind: "weekdays", days: [5, 1, 1, 3], time: "18:00" }), { kind: "weekdays", days: [1, 3, 5], time: "18:00" });
    assert.deepEqual(parseSchedule({ kind: "interval", everyHours: 6 }), { kind: "interval", everyHours: 6 });
    assert.equal(typeof parseSchedule({ kind: "daily", time: "7:30" }), "string");
    assert.equal(typeof parseSchedule({ kind: "daily", time: "24:00" }), "string");
    assert.equal(typeof parseSchedule({ kind: "weekdays", days: [], time: "08:00" }), "string");
    assert.equal(typeof parseSchedule({ kind: "weekdays", days: [7], time: "08:00" }), "string");
    assert.equal(typeof parseSchedule({ kind: "interval", everyHours: 0 }), "string");
    assert.equal(typeof parseSchedule({ kind: "interval", everyHours: 1.5 }), "string");
    assert.equal(typeof parseSchedule({ kind: "cron", expr: "* * * * *" }), "string");
    assert.equal(typeof parseSchedule(null), "string");
  });
});

describe("next fire", () => {
  it("fires daily at the local wall-clock time, today if still ahead, else tomorrow", () => {
    const daily: RoutineSchedule = { kind: "daily", time: "10:30" };
    assert.equal(nextFireAfter(daily, local(2026, 11, 16, 9, 0), 0), local(2026, 11, 16, 10, 30));
    assert.equal(nextFireAfter(daily, local(2026, 11, 16, 10, 30), 0), local(2026, 11, 17, 10, 30));
    assert.equal(nextFireAfter(daily, local(2026, 11, 30, 23, 0), 0), local(2026, 12, 1, 10, 30));
    assert.equal(nextFireAfter(daily, local(2026, 12, 31, 12, 0), 0), local(2027, 1, 1, 10, 30));
  });

  it("fires only on the chosen weekdays", () => {
    const weekdays: RoutineSchedule = { kind: "weekdays", days: [1, 3, 5], time: "08:00" };
    const monday = local(2026, 11, 16, 9, 0);
    assert.equal(new Date(monday).getDay(), 1);
    assert.equal(nextFireAfter(weekdays, monday, 0), local(2026, 11, 18, 8, 0));
    assert.equal(nextFireAfter(weekdays, local(2026, 11, 20, 8, 0), 0), local(2026, 11, 23, 8, 0));
    assert.equal(nextFireAfter(weekdays, local(2026, 11, 15, 12, 0), 0), local(2026, 11, 16, 8, 0));
    const saturdayOnly: RoutineSchedule = { kind: "weekdays", days: [6], time: "06:15" };
    assert.equal(nextFireAfter(saturdayOnly, local(2026, 11, 21, 6, 15), 0), local(2026, 11, 28, 6, 15));
  });

  it("fires every N hours from the anchor", () => {
    const every: RoutineSchedule = { kind: "interval", everyHours: 4 };
    const anchor = local(2026, 11, 16, 1, 0);
    assert.equal(nextFireAfter(every, anchor, anchor), anchor + 4 * HOUR);
    assert.equal(nextFireAfter(every, anchor + 4 * HOUR + 1, anchor), anchor + 8 * HOUR);
    assert.equal(nextFireAfter(every, anchor - 10, anchor), anchor);
    assert.equal(lastDueAtOrBefore(every, anchor + 9 * HOUR, anchor), anchor + 8 * HOUR);
    assert.equal(lastDueAtOrBefore(every, anchor - 1, anchor), null);
    assert.deepEqual(upcomingFires(every, anchor, anchor, 3), [anchor + 4 * HOUR, anchor + 8 * HOUR, anchor + 12 * HOUR]);
  });

  it("finds the latest slot at or before a moment", () => {
    const daily: RoutineSchedule = { kind: "daily", time: "10:30" };
    assert.equal(lastDueAtOrBefore(daily, local(2026, 11, 16, 11, 0), 0), local(2026, 11, 16, 10, 30));
    assert.equal(lastDueAtOrBefore(daily, local(2026, 11, 16, 10, 0), 0), local(2026, 11, 15, 10, 30));
    const weekdays: RoutineSchedule = { kind: "weekdays", days: [1], time: "08:00" };
    assert.equal(lastDueAtOrBefore(weekdays, local(2026, 11, 22, 12, 0), 0), local(2026, 11, 16, 8, 0));
  });

  it("uses the operating system time zone, not a hardcoded one", () => {
    const script = `import { nextFireAfter } from ${JSON.stringify(new URL(`file:///${join(serverDir, "src", "routine-schedule.ts").replace(/\\/g, "/")}`).href)};
      const after = Date.UTC(2026, 10, 16, 12, 0);
      process.stdout.write(String(nextFireAfter({ kind: "daily", time: "10:30" }, after, 0)));`;
    const run = (tz: string): number =>
      Number(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: serverDir, env: { ...process.env, TZ: tz }, encoding: "utf8" }).trim());
    assert.equal(run("America/Sao_Paulo"), Date.UTC(2026, 10, 16, 13, 30));
    assert.equal(run("Asia/Tokyo"), Date.UTC(2026, 10, 17, 1, 30));
    assert.equal(run("UTC"), Date.UTC(2026, 10, 17, 10, 30));
  });
});

describe("due decision", () => {
  const daily: RoutineSchedule = { kind: "daily", time: "09:00" };
  const catchUpMs = 12 * HOUR;

  it("waits until the next fire time", () => {
    const next = local(2026, 11, 16, 9, 0);
    assert.equal(decideDue({ schedule: daily, anchor: 0, nextFireAt: next, now: next - 1, catchUpMs }).action, "wait");
  });

  it("runs on time within the grace window and moves to the next slot", () => {
    const next = local(2026, 11, 16, 9, 0);
    const decision = decideDue({ schedule: daily, anchor: 0, nextFireAt: next, now: next + 30_000, catchUpMs });
    assert.equal(decision.action, "run");
    assert.equal(decision.dueAt, next);
    assert.equal(decision.nextFireAt, local(2026, 11, 17, 9, 0));
    assert.equal(decision.missedSlots, 0);
  });

  it("catches up once when the slot was missed less than N hours ago", () => {
    const next = local(2026, 11, 16, 9, 0);
    const decision = decideDue({ schedule: daily, anchor: 0, nextFireAt: next, now: next + 3 * HOUR, catchUpMs });
    assert.equal(decision.action, "catch-up");
    assert.equal(decision.dueAt, next);
    assert.equal(decision.nextFireAt, local(2026, 11, 17, 9, 0));
  });

  it("marks the slot missed when it is older than the catch-up window", () => {
    const next = local(2026, 11, 16, 9, 0);
    const decision = decideDue({ schedule: daily, anchor: 0, nextFireAt: next, now: next + 13 * HOUR, catchUpMs });
    assert.equal(decision.action, "missed");
    assert.equal(decision.missedSlots, 1);
    assert.equal(decision.nextFireAt, local(2026, 11, 17, 9, 0));
    assert.equal(decideDue({ schedule: daily, anchor: 0, nextFireAt: next, now: next + HOUR, catchUpMs: 0 }).action, "missed");
  });

  it("never bursts: many missed interval slots become one decision for the latest slot", () => {
    const every: RoutineSchedule = { kind: "interval", everyHours: 1 };
    const anchor = local(2026, 11, 16, 0, 0);
    const now = anchor + 5 * HOUR + 20 * 60_000;
    const decision = decideDue({ schedule: every, anchor, nextFireAt: anchor + HOUR, now, catchUpMs });
    assert.equal(decision.action, "catch-up");
    assert.equal(decision.dueAt, anchor + 5 * HOUR);
    assert.equal(decision.missedSlots, 4);
    assert.equal(decision.nextFireAt, anchor + 6 * HOUR);
    assert.equal(decideDue({ schedule: every, anchor, nextFireAt: decision.nextFireAt, now: now + 1000, catchUpMs }).action, "wait");
  });

  it("detects a wall-clock jump after sleep or a clock change", () => {
    assert.equal(detectClockJump(null, 1000, 30_000), false);
    assert.equal(detectClockJump(0, 31_000, 30_000), false);
    assert.equal(detectClockJump(0, 10 * 60_000, 30_000), true);
    assert.equal(detectClockJump(10 * 60_000, 0, 30_000), true);
  });
});
