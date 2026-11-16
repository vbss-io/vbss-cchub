import type { RoutineInput, RoutineRecord, RoutineRunRecord, RoutineRunStatus, RoutineSchedule, RoutineTrigger } from "./types";

export type ScheduleKind = RoutineSchedule["kind"];

export type RoutineTarget = "workspace" | "cwd";

export interface RoutineForm {
  name: string;
  prompt: string;
  target: RoutineTarget;
  workspace: string;
  repo: string;
  cwd: string;
  runner: "claude" | "codex";
  scheduleKind: ScheduleKind;
  time: string;
  days: number[];
  everyHours: string;
  enabled: boolean;
}

export const DEFAULT_TIME = "09:00";

export const NAME_MAX = 80;

export const PROMPT_MAX = 20_000;

export const EVERY_HOURS_MIN = 1;

export const EVERY_HOURS_MAX = 168;

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const WEEKDAY_SHORT: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTH_SHORT: readonly string[] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const WORKDAYS: readonly number[] = [1, 2, 3, 4, 5];

const WEEKEND: readonly number[] = [0, 6];

export const SCHEDULE_KINDS: readonly { key: ScheduleKind; label: string }[] = [
  { key: "daily", label: "Every day" },
  { key: "weekdays", label: "Chosen days" },
  { key: "interval", label: "Every N hours" },
];

export const emptyRoutineForm = (workspace = ""): RoutineForm => ({
  name: "",
  prompt: "",
  target: "workspace",
  workspace,
  repo: "",
  cwd: "",
  runner: "claude",
  scheduleKind: "daily",
  time: DEFAULT_TIME,
  days: [...WORKDAYS],
  everyHours: "6",
  enabled: true,
});

export function formFromRoutine(routine: RoutineRecord): RoutineForm {
  const base = emptyRoutineForm(routine.workspace ?? "");
  const schedule = routine.schedule;
  return {
    ...base,
    name: routine.name,
    prompt: routine.prompt,
    target: routine.cwd !== null ? "cwd" : "workspace",
    repo: routine.repo ?? "",
    cwd: routine.cwd ?? "",
    runner: routine.runner,
    enabled: routine.enabled,
    scheduleKind: schedule.kind,
    time: schedule.kind === "interval" ? DEFAULT_TIME : schedule.time,
    days: schedule.kind === "weekdays" ? [...schedule.days] : base.days,
    everyHours: schedule.kind === "interval" ? String(schedule.everyHours) : base.everyHours,
  };
}

export const toggleDay = (days: readonly number[], day: number): number[] =>
  (days.includes(day) ? days.filter((item) => item !== day) : [...days, day]).sort((a, b) => a - b);

const parseHours = (raw: string): number | null => {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= EVERY_HOURS_MIN && value <= EVERY_HOURS_MAX ? value : null;
};

export function scheduleFromForm(form: RoutineForm): RoutineSchedule | string {
  if (form.scheduleKind === "interval") {
    const everyHours = parseHours(form.everyHours);
    return everyHours === null ? `Hours must be a whole number from ${EVERY_HOURS_MIN} to ${EVERY_HOURS_MAX}.` : { kind: "interval", everyHours };
  }
  if (!TIME_PATTERN.test(form.time)) return "Pick a time of day.";
  if (form.scheduleKind === "daily") return { kind: "daily", time: form.time };
  const days = [...new Set(form.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
  return days.length === 0 ? "Pick at least one day." : { kind: "weekdays", days, time: form.time };
}

export function formProblem(form: RoutineForm): string | null {
  const name = form.name.trim();
  if (name.length === 0) return "Give the routine a name.";
  if (name.length > NAME_MAX) return `The name can have up to ${NAME_MAX} characters.`;
  const prompt = form.prompt.trim();
  if (prompt.length === 0) return "Write what the routine should do.";
  if (prompt.length > PROMPT_MAX) return `The prompt can have up to ${PROMPT_MAX.toLocaleString("en-US")} characters.`;
  if (form.target === "workspace" && form.workspace.trim().length === 0) return "Pick a workspace.";
  if (form.target === "cwd" && form.cwd.trim().length === 0) return "Enter the folder to run in.";
  const schedule = scheduleFromForm(form);
  return typeof schedule === "string" ? schedule : null;
}

export function buildPayload(form: RoutineForm): RoutineInput | string {
  const problem = formProblem(form);
  if (problem !== null) return problem;
  const schedule = scheduleFromForm(form);
  if (typeof schedule === "string") return schedule;
  const target =
    form.target === "cwd" ? { cwd: form.cwd.trim() } : { workspace: form.workspace.trim(), repo: form.repo.trim().length > 0 ? form.repo.trim() : null };
  return { name: form.name.trim(), prompt: form.prompt.trim(), runner: form.runner, schedule, enabled: form.enabled, ...target };
}

const clockOf = (hour: number, minute: number): string => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

export const formatClock = (at: number): string => {
  const date = new Date(at);
  return clockOf(date.getHours(), date.getMinutes());
};

const dayStart = (at: number): number => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

export function formatLocalTime(at: number, now: number): string {
  const date = new Date(at);
  const clock = clockOf(date.getHours(), date.getMinutes());
  const gap = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  if (gap === 0) return `Today ${clock}`;
  if (gap === 1) return `Tomorrow ${clock}`;
  if (gap === -1) return `Yesterday ${clock}`;
  if (gap > 1 && gap < 7) return `${WEEKDAY_SHORT[date.getDay()] ?? ""} ${clock}`;
  return `${MONTH_SHORT[date.getMonth()] ?? ""} ${date.getDate()} ${clock}`;
}

const sameDays = (days: readonly number[], expected: readonly number[]): boolean => days.length === expected.length && expected.every((day) => days.includes(day));

export function describeSchedule(schedule: RoutineSchedule): string {
  if (schedule.kind === "daily") return `Every day at ${schedule.time}`;
  if (schedule.kind === "interval") return schedule.everyHours === 1 ? "Every hour" : `Every ${schedule.everyHours} hours`;
  const days = [...schedule.days].sort((a, b) => a - b);
  if (days.length === 7) return `Every day at ${schedule.time}`;
  if (sameDays(days, WORKDAYS)) return `Weekdays at ${schedule.time}`;
  if (sameDays(days, WEEKEND)) return `Weekends at ${schedule.time}`;
  return `${days.map((day) => WEEKDAY_SHORT[day] ?? "").join(", ")} at ${schedule.time}`;
}

export function nextFireLabel(routine: Pick<RoutineRecord, "enabled" | "nextFireAt" | "running">, now: number): string {
  if (!routine.enabled) return "Paused";
  if (routine.running) return "Running now";
  if (routine.nextFireAt === null) return "Not scheduled";
  return `Next ${formatLocalTime(routine.nextFireAt, now)}`;
}

export const RUN_STATUS_LABEL: Readonly<Record<RoutineRunStatus, string>> = {
  running: "Running",
  completed: "OK",
  attention: "Needs you",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  missed: "Missed",
  skipped: "Skipped",
};

export type RoutineTone = "go" | "pend" | "hold" | "muted";

export const runTone = (status: RoutineRunStatus): RoutineTone => {
  if (status === "running") return "go";
  if (status === "attention" || status === "missed") return "pend";
  if (status === "failed" || status === "interrupted") return "hold";
  return "muted";
};

export const TRIGGER_LABEL: Readonly<Record<RoutineTrigger, string>> = {
  schedule: "Scheduled",
  "catch-up": "Catch-up",
  manual: "Run now",
};

export const runOpens = (run: Pick<RoutineRunRecord, "taskId">): boolean => run.taskId !== null;

export function runDetail(run: Pick<RoutineRunRecord, "status" | "note" | "error" | "summary" | "missedSlots">): string | null {
  const parts: string[] = [];
  if (run.note) parts.push(run.note);
  if (run.status === "missed" && run.missedSlots !== null && run.missedSlots > 0 && !run.note) parts.push(`${run.missedSlots} run${run.missedSlots === 1 ? "" : "s"} skipped while the hub was off`);
  if (run.error && (run.status === "failed" || run.status === "interrupted")) parts.push(run.error);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export const runWhen = (run: Pick<RoutineRunRecord, "startedAt" | "dueAt">, now: number): string => formatLocalTime(run.dueAt ?? run.startedAt, now);

export const isRoutineTask = (task: { createdBy: string | null }): boolean => task.createdBy !== null && task.createdBy.startsWith("routine:");

export const shouldNotifyTask = (task: { createdBy: string | null }): boolean => !isRoutineTask(task);

export const creatorLabel = (createdBy: string | null, fallback: string): string => {
  if (createdBy === null) return fallback;
  if (createdBy.startsWith("routine:")) return "routine";
  if (createdBy.startsWith("review:")) return "review";
  return createdBy;
};

export const routineIdOfTask = (task: { createdBy: string | null }): string | null => (isRoutineTask(task) ? (task.createdBy ?? "").slice("routine:".length) : null);

export const markItem = (items: readonly RoutineRunRecord[], id: string, read: boolean, at: number): RoutineRunRecord[] =>
  items.map((item) => (item.id === id ? { ...item, read, readAt: read ? at : null } : item));

export const markAll = (items: readonly RoutineRunRecord[], at: number): RoutineRunRecord[] => items.map((item) => (item.read ? item : { ...item, read: true, readAt: at }));

export const unreadOf = (items: readonly RoutineRunRecord[]): number => items.filter((item) => !item.read).length;

export interface NavBadge {
  count: number;
  quiet: boolean;
  title: string;
}

export function sessionsBadgeWithRoutines(baseTitle: string, attention: number, unread: number): NavBadge {
  const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
  if (attention > 0) {
    const tail = unread > 0 ? `; ${plural(unread, "routine result")} unread` : "";
    return { count: attention, quiet: false, title: `${baseTitle}${tail}` };
  }
  if (unread > 0) return { count: unread, quiet: true, title: `${baseTitle}: ${plural(unread, "routine result")} unread` };
  return { count: 0, quiet: false, title: baseTitle };
}

export const CATCH_UP_CHOICES: readonly number[] = [0, 1, 3, 6, 12, 24, 48, 72];

export const catchUpLabel = (hours: number): string => (hours === 0 ? "Never catch up" : hours === 1 ? "Within 1 hour" : `Within ${hours} hours`);

export const catchUpOptions = (current: number): { value: number; label: string }[] =>
  [...new Set([...CATCH_UP_CHOICES, current])].sort((a, b) => a - b).map((value) => ({ value, label: catchUpLabel(value) }));

export const targetLabel = (routine: Pick<RoutineRecord, "workspace" | "repo" | "cwd">): string => {
  if (routine.cwd !== null) return routine.cwd;
  return routine.repo ? `${routine.workspace ?? ""} / ${routine.repo}` : (routine.workspace ?? "");
};

export function gateNote(gate: string | null, schedulerGate: string | null): string | null {
  return gate ?? schedulerGate;
}
