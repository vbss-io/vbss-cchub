import assert from "node:assert/strict";
import { test } from "node:test";
import { carryOverFromYesterday, focusPreviewLines, parseMeetings, parseNewItems } from "./daily-plan";
import type { DailyYesterdayTask } from "./delegation";

test("parseNewItems splits project from text on the first ' - '", () => {
  const items = parseNewItems("Equatorial - Fix GeoServer prod\nWorkai - Ship export");
  assert.deepEqual(items, [
    { project: "Equatorial", text: "Fix GeoServer prod" },
    { project: "Workai", text: "Ship export" },
  ]);
});

test("parseNewItems keeps project null when there is no separator", () => {
  const items = parseNewItems("Review PR backlog");
  assert.deepEqual(items, [{ project: null, text: "Review PR backlog" }]);
});

test("parseNewItems drops blank and whitespace-only lines", () => {
  const items = parseNewItems("  \nEquatorial - Fix\n\n   \n");
  assert.deepEqual(items, [{ project: "Equatorial", text: "Fix" }]);
});

test("parseNewItems trims extra spaces around project and text", () => {
  const items = parseNewItems("  Equatorial   -   Fix GeoServer  ");
  assert.deepEqual(items, [{ project: "Equatorial", text: "Fix GeoServer" }]);
});

test("parseMeetings trims and drops blank lines", () => {
  const meetings = parseMeetings("  09:30 Today (Murilo)  \n\n10:00 Dra. Michely\n   ");
  assert.deepEqual(meetings, ["09:30 Today (Murilo)", "10:00 Dra. Michely"]);
});

test("parseMeetings returns an empty list for blank input", () => {
  assert.deepEqual(parseMeetings("   \n  \n"), []);
});

test("focusPreviewLines links the project only when wikilinks is enabled", () => {
  const items = [
    { project: "Equatorial", text: "Fix GeoServer" },
    { project: null, text: "Standalone item" },
  ];
  assert.deepEqual(focusPreviewLines(items, true), ["- [ ] [[Equatorial]] - Fix GeoServer", "- [ ] Standalone item"]);
  assert.deepEqual(focusPreviewLines(items, false), ["- [ ] Equatorial - Fix GeoServer", "- [ ] Standalone item"]);
});

test("carryOverFromYesterday falls back to !doneStates when a task has no explicit carry state", () => {
  const tasks: DailyYesterdayTask[] = [
    { line: 4, depth: 0, checked: true, text: "Done thing", raw: "- [x] Done thing", block: "b1" },
    { line: 5, depth: 0, checked: false, text: "Open thing", raw: "- [ ] Open thing", block: "b2" },
  ];
  const items = carryOverFromYesterday(tasks, {}, {});
  assert.deepEqual(items, [{ project: null, text: "Open thing", block: "b2" }]);
});

test("carryOverFromYesterday excludes a task marked done, regardless of its original checked state", () => {
  const tasks: DailyYesterdayTask[] = [
    { line: 5, depth: 0, checked: false, text: "Reopened then closed again", raw: "- [ ] ...", block: "b1" },
  ];
  const items = carryOverFromYesterday(tasks, { 5: true }, { 5: false });
  assert.deepEqual(items, []);
});

test("carryOverFromYesterday includes a task marked carry, regardless of its done state", () => {
  const tasks: DailyYesterdayTask[] = [
    { line: 6, depth: 0, checked: true, text: "Done but pulled back in", raw: "- [x] ...", block: "b2" },
  ];
  const items = carryOverFromYesterday(tasks, { 6: true }, { 6: true });
  assert.deepEqual(items, [{ project: null, text: "Done but pulled back in", block: "b2" }]);
});

test("carryOverFromYesterday excludes a task that is neither done nor carried", () => {
  const tasks: DailyYesterdayTask[] = [
    { line: 7, depth: 0, checked: false, text: "Left in limbo", raw: "- [ ] ...", block: "b3" },
  ];
  const items = carryOverFromYesterday(tasks, { 7: false }, { 7: false });
  assert.deepEqual(items, []);
});

test("carryOverFromYesterday returns an empty list when everything is done", () => {
  const tasks: DailyYesterdayTask[] = [
    { line: 1, depth: 0, checked: true, text: "Done thing", raw: "- [x] Done thing", block: "b1" },
  ];
  assert.deepEqual(carryOverFromYesterday(tasks, {}, {}), []);
});
