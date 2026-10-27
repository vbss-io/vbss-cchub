import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardProject, BoardStatus, BoardTask } from "./delegation";
import {
  barGeometry,
  buildTimeline,
  clampSpanToRange,
  dayToX,
  formatDay,
  isTaskOverdue,
  localDayKey,
  parseDay,
  spanLabel,
  taskSpan,
  timelineRange,
  timelineScale,
  TIMELINE_MAX_AHEAD_DAYS,
  TIMELINE_MAX_BEHIND_DAYS,
  weekStart,
  xToDay,
  ZOOM_DAY_WIDTH,
} from "./timeline-model";

function project(id: string, title: string): BoardProject {
  return { id, name: id, title, parent: null, depth: 0, path: `/vault/${id}.md`, workspace: null, workspaceSource: null };
}

function task(projectId: string, line: number, title: string, status: BoardStatus = "todo", extra: Partial<BoardTask> = {}): BoardTask {
  return {
    id: `${projectId}#${line}`,
    projectId,
    line,
    raw: `- [ ] ${title}`,
    depth: 0,
    checkbox: status === "done" ? "done" : status === "doing" ? "doing" : "todo",
    prefix: null,
    status,
    title,
    reason: null,
    section: "open",
    doneAt: null,
    group: null,
    priority: null,
    notes: [],
    noteItems: [],
    subtasks: [],
    ...extra,
  };
}

const TODAY = "2026-10-27";
const day = (value: string): number => parseDay(value) as number;

test("parseDay and formatDay round-trip real dates and reject invalid ones", () => {
  assert.equal(formatDay(day("2026-10-27")), "2026-10-27");
  assert.equal(day("2026-10-28") - day("2026-10-27"), 1);
  assert.equal(day("2027-01-01") - day("2026-12-31"), 1);
  assert.equal(parseDay("2026-02-30"), null);
  assert.equal(parseDay("tomorrow"), null);
  assert.equal(parseDay(null), null);
  assert.equal(parseDay(undefined), null);
});

test("localDayKey uses the local calendar date", () => {
  assert.equal(localDayKey(new Date(2026, 9, 27, 23, 59, 59)), "2026-10-27");
  assert.equal(localDayKey(new Date(2026, 0, 5, 0, 0, 1)), "2026-01-05");
});

test("weekStart snaps any day back to its Monday", () => {
  assert.equal(formatDay(weekStart(day("2026-10-27"))), "2026-10-26");
  assert.equal(formatDay(weekStart(day("2026-10-26"))), "2026-10-26");
  assert.equal(formatDay(weekStart(day("2026-11-01"))), "2026-10-26");
});

test("taskSpan draws start to due as a bar, scheduled standing in for a missing start", () => {
  assert.deepEqual(taskSpan(task("a", 1, "x", "todo", { start: "2026-10-28", due: "2026-10-31" })), { kind: "bar", start: day("2026-10-28"), end: day("2026-10-31") });
  assert.deepEqual(taskSpan(task("a", 1, "x", "todo", { scheduled: "2026-10-29", due: "2026-10-31" })), { kind: "bar", start: day("2026-10-29"), end: day("2026-10-31") });
  assert.deepEqual(taskSpan(task("a", 1, "x", "todo", { start: "2026-10-28", scheduled: "2026-10-30", due: "2026-10-31" })), {
    kind: "bar",
    start: day("2026-10-28"),
    end: day("2026-10-31"),
  });
});

test("taskSpan handles due only, start only and inverted ranges", () => {
  assert.deepEqual(taskSpan(task("a", 1, "x", "todo", { due: "2026-10-31" })), { kind: "milestone", start: day("2026-10-31"), end: day("2026-10-31") });
  assert.deepEqual(taskSpan(task("a", 1, "x", "todo", { start: "2026-10-28" })), { kind: "open", start: day("2026-10-28"), end: day("2026-10-29") });
  assert.deepEqual(taskSpan(task("a", 1, "x", "todo", { scheduled: "2026-10-28" })), { kind: "open", start: day("2026-10-28"), end: day("2026-10-29") });
  assert.deepEqual(taskSpan(task("a", 1, "x", "todo", { start: "2026-11-05", due: "2026-10-31" })), { kind: "bar", start: day("2026-10-31"), end: day("2026-11-05") });
  assert.equal(taskSpan(task("a", 1, "x")), null);
  assert.equal(taskSpan(task("a", 1, "x", "todo", { due: "garbage" })), null);
});

test("isTaskOverdue needs a past due date on a task that is still open", () => {
  const today = day(TODAY);
  assert.equal(isTaskOverdue(task("a", 1, "x", "todo", { due: "2026-10-26" }), today), true);
  assert.equal(isTaskOverdue(task("a", 1, "x", "doing", { due: "2026-10-26" }), today), true);
  assert.equal(isTaskOverdue(task("a", 1, "x", "todo", { due: "2026-10-27" }), today), false);
  assert.equal(isTaskOverdue(task("a", 1, "x", "done", { due: "2026-10-01" }), today), false);
  assert.equal(isTaskOverdue(task("a", 1, "x", "archived", { due: "2026-10-01" }), today), false);
  assert.equal(isTaskOverdue(task("a", 1, "x"), today), false);
});

test("timelineRange without dates starts on a Monday, covers today and spans whole weeks", () => {
  const range = timelineRange([], day(TODAY), "month");
  assert.equal(formatDay(range.start), "2026-10-12");
  assert.equal(range.dayCount, 91);
  assert.equal(range.dayWidth, ZOOM_DAY_WIDTH.month);
  assert.equal(range.end, range.start + range.dayCount - 1);
  assert.ok(range.start <= day(TODAY) && day(TODAY) <= range.end);
});

test("timelineRange grows to include far away tasks and keeps whole weeks", () => {
  const far = taskSpan(task("a", 1, "x", "todo", { start: "2026-06-01", due: "2027-03-15" }));
  assert.ok(far);
  const range = timelineRange([far], day(TODAY), "week");
  assert.equal(range.dayCount % 7, 0);
  assert.equal(weekStart(range.start), range.start);
  assert.ok(range.start <= day("2026-06-01"));
  assert.ok(range.end >= day("2027-03-15"));
});

test("timelineRange picks a wider day width as the zoom gets closer", () => {
  assert.ok(ZOOM_DAY_WIDTH.week > ZOOM_DAY_WIDTH.month);
  assert.ok(ZOOM_DAY_WIDTH.month > ZOOM_DAY_WIDTH.quarter);
  assert.equal(timelineRange([], day(TODAY), "week").dayWidth, ZOOM_DAY_WIDTH.week);
  assert.equal(timelineRange([], day(TODAY), "quarter").dayWidth, ZOOM_DAY_WIDTH.quarter);
});

test("dayToX and xToDay are inverse and barGeometry covers every day of the span", () => {
  const range = timelineRange([], day(TODAY), "month");
  const w = range.dayWidth;
  assert.equal(dayToX(range.start, range), 0);
  assert.equal(dayToX(range.start + 3, range), 3 * w);
  assert.equal(xToDay(3 * w, range), range.start + 3);
  assert.equal(xToDay(3 * w + w - 1, range), range.start + 3);
  const bar = barGeometry({ kind: "bar", start: range.start + 2, end: range.start + 4 }, range);
  assert.deepEqual(bar, { left: 2 * w, width: 3 * w });
  const mark = barGeometry({ kind: "milestone", start: range.start + 5, end: range.start + 5 }, range);
  assert.deepEqual(mark, { left: 5 * w, width: w });
  const open = barGeometry({ kind: "open", start: range.start + 1, end: range.start + 2 }, range);
  assert.deepEqual(open, { left: w, width: 2 * w });
});

test("timelineScale month zoom: month headers and a label on every Monday", () => {
  const range = timelineRange([], day(TODAY), "month");
  const scale = timelineScale(range, "month");
  const w = range.dayWidth;
  assert.deepEqual(scale.top.slice(0, 2).map((tick) => tick.label), ["Oct 2026", "Nov 2026"]);
  assert.equal(scale.top[0]?.left, 0);
  assert.equal(scale.top[0]?.width, 20 * w);
  assert.equal(scale.top[1]?.left, 20 * w);
  assert.equal(scale.top[1]?.width, 30 * w);
  assert.equal(scale.top.reduce((sum, tick) => sum + tick.width, 0), range.dayCount * w);
  assert.deepEqual(scale.bottom.slice(0, 3).map((tick) => tick.label), ["12", "19", "26"]);
  assert.equal(scale.bottom[1]?.left, 7 * w);
  assert.equal(scale.bottom[1]?.width, 7 * w);
});

test("timelineScale week zoom labels every day and flags weekends", () => {
  const range = timelineRange([], day(TODAY), "week");
  const scale = timelineScale(range, "week");
  assert.equal(scale.bottom.length, range.dayCount);
  assert.deepEqual(scale.bottom.slice(0, 7).map((tick) => tick.weekend), [false, false, false, false, false, true, true]);
  assert.equal(scale.bottom[0]?.title, "Mon 19 Oct");
  assert.equal(scale.bottom[0]?.width, range.dayWidth);
});

test("timelineScale quarter zoom groups by quarter and labels each month", () => {
  const range = timelineRange([], day(TODAY), "quarter");
  const scale = timelineScale(range, "quarter");
  assert.deepEqual(scale.top.slice(0, 3).map((tick) => tick.label), ["Q3 2026", "Q4 2026", "Q1 2027"]);
  assert.deepEqual(scale.bottom.slice(0, 3).map((tick) => tick.label), ["Sep", "Oct", "Nov"]);
  assert.equal(scale.bottom.reduce((sum, tick) => sum + tick.width, 0), range.dayCount * range.dayWidth);
});

test("buildTimeline groups dated tasks by project in the given order and collects undated ones", () => {
  const projects = [project("acme", "Acme"), project("globex", "Globex")];
  const tasks = [
    task("acme", 1, "No dates"),
    task("acme", 2, "Late job", "todo", { start: "2026-10-20", due: "2026-10-25", priority: 1 }),
    task("globex", 3, "Ship", "doing", { due: "2026-10-30" }),
    task("acme", 4, "Early job", "todo", { start: "2026-10-18", due: "2026-10-26" }),
  ];
  const layout = buildTimeline(tasks, projects, ["globex", "acme"], TODAY, "month");
  assert.deepEqual(layout.groups.map((group) => group.project.id), ["globex", "acme"]);
  assert.deepEqual(layout.groups[1]?.rows.map((row) => row.task.title), ["Early job", "Late job"]);
  assert.deepEqual(layout.undated.map((item) => item.title), ["No dates"]);
  assert.equal(layout.groups[1]?.rows[0]?.overdue, true);
  assert.equal(layout.groups[0]?.rows[0]?.overdue, false);
  assert.equal(layout.groups[0]?.rows[0]?.span?.kind, "milestone");
});

test("buildTimeline nests dated subtasks under their parent, keeping an undated parent as context", () => {
  const projects = [project("acme", "Acme")];
  const dated = task("acme", 3, "Child dated", "todo", { start: "2026-10-29", due: "2026-10-30" });
  const plain = task("acme", 4, "Child plain");
  const nested = task("acme", 5, "Deep", "todo", { due: "2026-11-02" });
  const mid = task("acme", 6, "Mid", "todo", { subtasks: [nested] });
  const parent = task("acme", 2, "Parent", "todo", { subtasks: [dated, plain, mid] });
  const loner = task("acme", 7, "Loner", "todo", { subtasks: [task("acme", 8, "Nothing")] });
  const layout = buildTimeline([parent, loner], projects, [], TODAY, "month");
  const rows = layout.groups[0]?.rows ?? [];
  assert.deepEqual(
    rows.map((row) => [row.task.title, row.depth, row.span === null ? "none" : row.span.kind]),
    [
      ["Parent", 0, "none"],
      ["Child dated", 1, "bar"],
      ["Mid", 1, "none"],
      ["Deep", 2, "milestone"],
    ],
  );
  assert.deepEqual(layout.undated.map((item) => item.title), ["Loner"]);
});

test("buildTimeline orders top-level rows by their earliest date, then priority", () => {
  const projects = [project("acme", "Acme")];
  const tasks = [
    task("acme", 1, "B", "todo", { due: "2026-10-30", priority: 2 }),
    task("acme", 2, "A", "todo", { due: "2026-10-30", priority: 0 }),
    task("acme", 3, "C", "todo", { start: "2026-10-28", due: "2026-11-10" }),
  ];
  const layout = buildTimeline(tasks, projects, [], TODAY, "month");
  assert.deepEqual(layout.groups[0]?.rows.map((row) => row.task.title), ["C", "A", "B"]);
});

test("buildTimeline places the today line in the middle of the today column and tolerates empty input", () => {
  const empty = buildTimeline([], [], [], TODAY, "month");
  assert.deepEqual(empty.groups, []);
  assert.deepEqual(empty.undated, []);
  assert.equal(empty.todayX, dayToX(day(TODAY), empty.range) + empty.range.dayWidth / 2);
  const week = buildTimeline([], [], [], TODAY, "week");
  assert.ok(week.todayX > 0 && week.todayX < week.range.dayCount * week.range.dayWidth);
});

test("buildTimeline sizes the range from every dated row including subtasks", () => {
  const projects = [project("acme", "Acme")];
  const child = task("acme", 2, "Child", "todo", { due: "2027-06-01" });
  const parent = task("acme", 1, "Parent", "todo", { start: "2026-10-28", due: "2026-10-30", subtasks: [child] });
  const layout = buildTimeline([parent], projects, [], TODAY, "month");
  assert.ok(layout.range.end >= day("2027-06-01"));
});

test("timelineRange clamps typo dates so the day count stays bounded", () => {
  const typo = taskSpan(task("a", 1, "x", "todo", { start: "2026-10-28", due: "2206-01-01" }));
  const ancient = taskSpan(task("a", 1, "x", "todo", { due: "2001-01-01" }));
  assert.ok(typo && ancient);
  for (const zoom of ["week", "month", "quarter"] as const) {
    const range = timelineRange([typo, ancient], day(TODAY), zoom);
    assert.ok(range.dayCount < 2100, `${zoom} ${range.dayCount}`);
    assert.ok(range.end <= day(TODAY) + TIMELINE_MAX_AHEAD_DAYS + 60);
    assert.ok(range.start >= day(TODAY) - TIMELINE_MAX_BEHIND_DAYS - 60);
    assert.equal(range.dayCount % 7, 0);
  }
});

test("timelineRange still grows to dates inside the allowed window", () => {
  const near = taskSpan(task("a", 1, "x", "todo", { due: "2028-10-01" }));
  assert.ok(near);
  assert.ok(timelineRange([near], day(TODAY), "month").end >= day("2028-10-01"));
});

test("clampSpanToRange pins spans outside the range to the edge and reports which side", () => {
  const range = timelineRange([], day(TODAY), "month");
  const inside = { kind: "bar" as const, start: range.start + 3, end: range.start + 9 };
  assert.deepEqual(clampSpanToRange(inside, range), { span: inside, clip: "none" });
  const after = clampSpanToRange({ kind: "milestone", start: day("2206-01-01"), end: day("2206-01-01") }, range);
  assert.equal(after.clip, "after");
  assert.deepEqual(after.span, { kind: "milestone", start: range.end, end: range.end });
  const before = clampSpanToRange({ kind: "open", start: day("2001-01-01"), end: day("2001-01-02") }, range);
  assert.equal(before.clip, "before");
  assert.deepEqual(before.span, { kind: "open", start: range.start, end: range.start });
  const across = clampSpanToRange({ kind: "bar", start: range.start - 40, end: range.end + 40 }, range);
  assert.equal(across.clip, "both");
  assert.deepEqual(across.span, { kind: "bar", start: range.start, end: range.end });
  const leftEdge = clampSpanToRange({ kind: "bar", start: range.start - 5, end: range.start + 2 }, range);
  assert.equal(leftEdge.clip, "before");
  assert.deepEqual(leftEdge.span, { kind: "bar", start: range.start, end: range.start + 2 });
});

test("clampSpanToRange draws a span that lies wholly outside the range as an edge marker inside the track", () => {
  for (const zoom of ["week", "month", "quarter"] as const) {
    for (const [from, to, edge] of [
      ["2000-01-01", "2020-01-01", "before"],
      ["2000-01-01", "2000-01-01", "before"],
      ["2090-01-01", "2100-12-31", "after"],
    ] as const) {
      const span = { kind: "bar" as const, start: day(from), end: day(to) };
      const range = timelineRange([span], day(TODAY), zoom);
      const clamped = clampSpanToRange(span, range);
      const at = edge === "before" ? range.start : range.end;
      assert.equal(clamped.clip, edge, `${zoom} ${from}`);
      assert.deepEqual(clamped.span, { kind: "bar", start: at, end: at }, `${zoom} ${from}`);
      const geometry = barGeometry(clamped.span, range);
      assert.ok(geometry.left >= 0, `${zoom} ${from}`);
      assert.ok(geometry.width <= range.dayWidth, `${zoom} ${from}`);
      assert.ok(geometry.left + geometry.width <= range.dayCount * range.dayWidth, `${zoom} ${from}`);
    }
  }
});

test("clampSpanToRange clips a span overlapping the range to the range", () => {
  const span = { kind: "bar" as const, start: day("2000-01-01"), end: day("2100-12-31") };
  const range = timelineRange([span], day(TODAY), "month");
  const clamped = clampSpanToRange(span, range);
  assert.equal(clamped.clip, "both");
  assert.deepEqual(clamped.span, { kind: "bar", start: range.start, end: range.end });
  const geometry = barGeometry(clamped.span, range);
  assert.equal(geometry.left, 0);
  assert.equal(geometry.width, range.dayCount * range.dayWidth);
});

test("buildTimeline keeps a far-past bar next to a near task inside the track", () => {
  const projects = [project("acme", "Acme")];
  const ancient = task("acme", 1, "Ancient", "todo", { start: "2000-01-01", due: "2020-01-01" });
  const soon = task("acme", 2, "Soon", "todo", { due: "2026-11-06" });
  const layout = buildTimeline([ancient, soon], projects, [], TODAY, "quarter");
  const row = layout.groups[0]?.rows.find((item) => item.task.id === ancient.id);
  assert.ok(row?.visible);
  assert.equal(row.clip, "before");
  assert.deepEqual([row.visible.start, row.visible.end], [layout.range.start, layout.range.start]);
  const geometry = barGeometry(row.visible, layout.range);
  assert.ok(geometry.left + geometry.width <= layout.range.dayCount * layout.range.dayWidth);
});

test("buildTimeline draws out-of-range tasks clamped at the edge and keeps them reachable", () => {
  const projects = [project("acme", "Acme")];
  const typo = task("acme", 1, "Typo", "todo", { start: "2026-10-28", due: "2206-01-01" });
  const normal = task("acme", 2, "Normal", "todo", { start: "2026-10-28", due: "2026-10-30" });
  const layout = buildTimeline([typo, normal], projects, [], TODAY, "week");
  assert.ok(layout.range.dayCount < 2100);
  const rows = layout.groups[0]?.rows ?? [];
  const typoRow = rows.find((row) => row.task.id === typo.id);
  const normalRow = rows.find((row) => row.task.id === normal.id);
  assert.ok(typoRow && normalRow);
  assert.equal(typoRow.clip, "after");
  assert.equal(typoRow.visible?.end, layout.range.end);
  assert.equal(typoRow.span?.end, day("2206-01-01"));
  assert.equal(normalRow.clip, "none");
  assert.deepEqual(normalRow.visible, normalRow.span);
  const geometry = typoRow.visible ? barGeometry(typoRow.visible, layout.range) : null;
  assert.ok(geometry && geometry.left + geometry.width <= layout.range.dayCount * layout.range.dayWidth);
});

test("spanLabel describes the dates a bar, a diamond or an open bar stands for", () => {
  assert.equal(spanLabel({ kind: "bar", start: day("2026-10-28"), end: day("2026-10-31") }), "28/10 - 31/10");
  assert.equal(spanLabel({ kind: "milestone", start: day("2026-10-31"), end: day("2026-10-31") }), "Due 31/10");
  assert.equal(spanLabel({ kind: "open", start: day("2026-10-28"), end: day("2026-10-29") }), "From 28/10");
});
