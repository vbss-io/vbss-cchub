export const ROUTINE_SCHEDULE_KINDS = ["daily", "weekdays", "interval"] as const;

export type RoutineScheduleKind = (typeof ROUTINE_SCHEDULE_KINDS)[number];

export type RoutineSchedule =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; days: number[]; time: string }
  | { kind: "interval"; everyHours: number };

export const INTERVAL_HOURS_MIN = 1;
export const INTERVAL_HOURS_MAX = 168;
export const ON_TIME_GRACE_MS = 2 * 60_000;
const HOUR_MS = 3_600_000;
const MAX_COUNTED_MISSES = 500;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseTime(time: string): { hours: number; minutes: number } | null {
  const match = TIME_RE.exec(time);
  return match ? { hours: Number(match[1]), minutes: Number(match[2]) } : null;
}

export function parseSchedule(raw: unknown): RoutineSchedule | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "schedule must be an object";
  const value = raw as Record<string, unknown>;
  if (value.kind === "interval") {
    const hours = value.everyHours;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < INTERVAL_HOURS_MIN || hours > INTERVAL_HOURS_MAX) {
      return `schedule.everyHours must be an integer between ${INTERVAL_HOURS_MIN} and ${INTERVAL_HOURS_MAX}`;
    }
    return { kind: "interval", everyHours: hours };
  }
  if (value.kind !== "daily" && value.kind !== "weekdays") return `schedule.kind must be one of: ${ROUTINE_SCHEDULE_KINDS.join(", ")}`;
  if (typeof value.time !== "string" || parseTime(value.time) === null) return "schedule.time must be HH:MM (24h, local time)";
  if (value.kind === "daily") return { kind: "daily", time: value.time };
  const days = value.days;
  if (!Array.isArray(days) || days.length === 0 || !days.every((day) => typeof day === "number" && Number.isInteger(day) && day >= 0 && day <= 6)) {
    return "schedule.days must be a non-empty array of weekdays 0 (Sunday) to 6 (Saturday)";
  }
  return { kind: "weekdays", days: [...new Set(days as number[])].sort((a, b) => a - b), time: value.time };
}

const allDays = [0, 1, 2, 3, 4, 5, 6];

function localSlot(base: Date, offsetDays: number, hours: number, minutes: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays, hours, minutes, 0, 0);
}

function clockSlots(schedule: Exclude<RoutineSchedule, { kind: "interval" }>): { hours: number; minutes: number; days: number[] } {
  const time = parseTime(schedule.time) ?? { hours: 0, minutes: 0 };
  return { ...time, days: schedule.kind === "weekdays" ? schedule.days : allDays };
}

export function nextFireAfter(schedule: RoutineSchedule, after: number, anchor: number): number {
  if (schedule.kind === "interval") {
    const step = schedule.everyHours * HOUR_MS;
    if (after < anchor) return anchor;
    return anchor + (Math.floor((after - anchor) / step) + 1) * step;
  }
  const { hours, minutes, days } = clockSlots(schedule);
  const base = new Date(after);
  for (let offset = 0; offset <= 8; offset += 1) {
    const slot = localSlot(base, offset, hours, minutes);
    if (slot.getTime() > after && days.includes(slot.getDay())) return slot.getTime();
  }
  return localSlot(base, 7, hours, minutes).getTime();
}

export function lastDueAtOrBefore(schedule: RoutineSchedule, at: number, anchor: number): number | null {
  if (schedule.kind === "interval") {
    const step = schedule.everyHours * HOUR_MS;
    if (at < anchor) return null;
    return anchor + Math.floor((at - anchor) / step) * step;
  }
  const { hours, minutes, days } = clockSlots(schedule);
  const base = new Date(at);
  for (let offset = 0; offset >= -8; offset -= 1) {
    const slot = localSlot(base, offset, hours, minutes);
    if (slot.getTime() <= at && days.includes(slot.getDay())) return slot.getTime();
  }
  return null;
}

export function upcomingFires(schedule: RoutineSchedule, after: number, anchor: number, count: number): number[] {
  const out: number[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    cursor = nextFireAfter(schedule, cursor, anchor);
    out.push(cursor);
  }
  return out;
}

export type DueAction = "wait" | "run" | "catch-up" | "missed";

export interface DueDecision {
  action: DueAction;
  dueAt: number | null;
  missedSlots: number;
  nextFireAt: number;
}

export interface DueInput {
  schedule: RoutineSchedule;
  anchor: number;
  nextFireAt: number;
  now: number;
  catchUpMs: number;
  graceMs?: number;
}

function countSlots(schedule: RoutineSchedule, from: number, to: number, anchor: number): number {
  let count = 0;
  let cursor = from;
  while (cursor <= to && count < MAX_COUNTED_MISSES) {
    count += 1;
    cursor = nextFireAfter(schedule, cursor, anchor);
  }
  return count;
}

export function decideDue(input: DueInput): DueDecision {
  const { schedule, anchor, nextFireAt, now } = input;
  if (now < nextFireAt) return { action: "wait", dueAt: null, missedSlots: 0, nextFireAt };
  const latest = lastDueAtOrBefore(schedule, now, anchor);
  const dueAt = latest !== null && latest >= nextFireAt ? latest : nextFireAt;
  const next = nextFireAfter(schedule, now, anchor);
  const lateness = now - dueAt;
  const slots = countSlots(schedule, nextFireAt, now, anchor);
  if (lateness <= (input.graceMs ?? ON_TIME_GRACE_MS)) return { action: "run", dueAt, missedSlots: Math.max(slots - 1, 0), nextFireAt: next };
  if (lateness < input.catchUpMs) return { action: "catch-up", dueAt, missedSlots: Math.max(slots - 1, 0), nextFireAt: next };
  return { action: "missed", dueAt, missedSlots: slots, nextFireAt: next };
}

export function detectClockJump(previousTickAt: number | null, now: number, tickMs: number): boolean {
  if (previousTickAt === null) return false;
  return now - previousTickAt > tickMs * 3 || now < previousTickAt - 60_000;
}
