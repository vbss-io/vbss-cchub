import assert from "node:assert/strict";
import { test } from "vitest";
import type { UsageDay, UsageTotals } from "./delegation";
import { contextTone, dayBarHeights, parseUsageTab, resetLabel, sharePercent, shortProject, sortRows, sourceNote, stepUsageTab, timeAgo, usageResponseState } from "./usage-format";

const totals = (read: number): UsageTotals => ({ read, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, messages: 0 });
const day = (name: string, claude: number, codex: number): UsageDay => ({ day: name, claude: totals(claude), codex: totals(codex) });

test("sortRows sorts numbers descending by default without mutating the input", () => {
  const rows = [{ n: 2 }, { n: 9 }, { n: 5 }];
  assert.deepEqual(sortRows(rows, (row) => row.n).map((row) => row.n), [9, 5, 2]);
  assert.deepEqual(rows.map((row) => row.n), [2, 9, 5]);
});

test("sortRows sorts ascending and keeps ties in original order", () => {
  const rows = [{ id: "a", n: 1 }, { id: "b", n: 1 }, { id: "c", n: 0 }];
  assert.deepEqual(sortRows(rows, (row) => row.n, "asc").map((row) => row.id), ["c", "a", "b"]);
  assert.deepEqual(sortRows(rows, (row) => row.n, "desc").map((row) => row.id), ["a", "b", "c"]);
});

test("sortRows compares strings", () => {
  const rows = [{ s: "opus" }, { s: "fable" }, { s: "sonnet" }];
  assert.deepEqual(sortRows(rows, (row) => row.s, "asc").map((row) => row.s), ["fable", "opus", "sonnet"]);
});

test("dayBarHeights scales segments to the busiest day", () => {
  const bars = dayBarHeights([day("d1", 50, 50), day("d2", 25, 0), day("d3", 0, 0)]);
  assert.deepEqual(bars.map((bar) => bar.total), [100, 25, 0]);
  assert.deepEqual([bars[0]?.claude, bars[0]?.codex], [50, 50]);
  assert.equal(bars[1]?.claude, 25);
});

test("dayBarHeights returns zeros when nothing was read", () => {
  assert.deepEqual(dayBarHeights([day("d1", 0, 0)]).map((bar) => bar.total), [0]);
  assert.deepEqual(dayBarHeights([]), []);
});

test("contextTone flags p90 above 300k and 600k", () => {
  assert.equal(contextTone(120_000), "go");
  assert.equal(contextTone(300_000), "go");
  assert.equal(contextTone(300_001), "pend");
  assert.equal(contextTone(600_000), "pend");
  assert.equal(contextTone(600_001), "hold");
  assert.equal(contextTone(Number.NaN), "go");
});

test("timeAgo buckets minutes, hours and days", () => {
  const now = 10_000_000_000;
  assert.equal(timeAgo(now - 20_000, now), "just now");
  assert.equal(timeAgo(now - 5 * 60_000, now), "5m ago");
  assert.equal(timeAgo(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(timeAgo(now - 49 * 3_600_000, now), "2d ago");
  assert.equal(timeAgo(now + 60_000, now), "just now");
});

test("sharePercent rounds and clamps", () => {
  assert.equal(sharePercent(0.234), "23");
  assert.equal(sharePercent(0), "0");
  assert.equal(sharePercent(2), "100");
  assert.equal(sharePercent(Number.NaN), "0");
});

test("shortProject prefers the cwd basename and falls back to the encoded folder tail", () => {
  assert.equal(shortProject("C--x", "C:\\Users\\vbss\\Projetos\\vbss-cchub\\"), "vbss-cchub");
  assert.equal(shortProject("C--x", "/home/vbss/vbss-cchub"), "vbss-cchub");
  assert.equal(shortProject("C--Users-vbss-Documentos-Projetos--workspaces-ws-acme", null), "ws-acme");
  assert.equal(shortProject("C--Users-vbss-Documentos-Projetos-VBSS-vbss-partner-hub"), "VBSS-vbss-partner-hub");
  assert.equal(shortProject("te"), "te");
});

test("sourceNote labels live, cache and local session sources", () => {
  assert.equal(sourceNote("api"), "live");
  assert.equal(sourceNote("live"), "live");
  assert.equal(sourceNote("cache"), "from local cache");
  assert.equal(sourceNote("rollout"), "from local session");
  assert.equal(sourceNote("none"), null);
  assert.equal(sourceNote(undefined), null);
});

test("usageResponseState maps a 202 to scanning regardless of the body", () => {
  assert.equal(usageResponseState(202, { scanning: true, startedAt: 1, files: null }), "scanning");
  assert.equal(usageResponseState(202, { days: 7, scanning: true, providers: null }), "scanning");
  assert.equal(usageResponseState(202, null), "scanning");
});

test("usageResponseState treats a 200 report as ready and a 200 scanning body as scanning", () => {
  assert.equal(usageResponseState(200, { days: 7, totals: {} }), "ready");
  assert.equal(usageResponseState(200, { scanning: true }), "scanning");
  assert.equal(usageResponseState(200, null), "unavailable");
});

test("usageResponseState treats other statuses as unavailable", () => {
  assert.equal(usageResponseState(404, { error: "not found" }), "unavailable");
  assert.equal(usageResponseState(500, null), "unavailable");
});

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-14T12:00:00.000Z");

test("resetLabel counts down a plausible reset inside its window", () => {
  assert.deepEqual(resetLabel(NOW + 3 * HOUR + 11 * 60_000, NOW, "fiveHour"), { kind: "countdown", text: "3h 11m" });
  assert.deepEqual(resetLabel(NOW + 4 * DAY + 11 * HOUR, NOW, "sevenDay"), { kind: "countdown", text: "4d 11h" });
  assert.deepEqual(resetLabel(Math.round((NOW + HOUR) / 1000), NOW, "fiveHour"), { kind: "countdown", text: "1h" });
});

test("resetLabel refuses the 1219d countdown the fake Codex snapshot produced", () => {
  const fixtureReset = 1_900_000_000_000;
  assert.deepEqual(resetLabel(fixtureReset, Date.parse("2026-11-14T08:00:00.000Z"), "fiveHour"), { kind: "unknown" });
  assert.deepEqual(resetLabel(1_900_500_000_000, NOW, "sevenDay"), { kind: "unknown" });
});

test("resetLabel enforces 6h for the 5h window and 8d for the 7d window", () => {
  assert.equal(resetLabel(NOW + 6 * HOUR, NOW, "fiveHour").kind, "countdown");
  assert.equal(resetLabel(NOW + 6 * HOUR + 60_000, NOW, "fiveHour").kind, "unknown");
  assert.equal(resetLabel(NOW + 8 * DAY, NOW, "sevenDay").kind, "countdown");
  assert.equal(resetLabel(NOW + 8 * DAY + 60_000, NOW, "sevenDay").kind, "unknown");
  assert.equal(resetLabel(NOW + 7 * HOUR, NOW, "sevenDay").kind, "countdown");
});

test("resetLabel treats a reset time well in the past as unknown and a just-passed one as now", () => {
  assert.deepEqual(resetLabel(NOW - 30_000, NOW, "fiveHour"), { kind: "countdown", text: "now" });
  assert.deepEqual(resetLabel(NOW - 10 * 60_000, NOW, "fiveHour"), { kind: "unknown" });
  assert.deepEqual(resetLabel(NOW - 3 * DAY, NOW, "sevenDay"), { kind: "unknown" });
});

test("resetLabel without a reset time is silent unless the caller requires one", () => {
  assert.deepEqual(resetLabel(null, NOW, "fiveHour"), { kind: "none" });
  assert.deepEqual(resetLabel(null, NOW, "fiveHour", true), { kind: "unknown" });
  assert.deepEqual(resetLabel(Number.NaN, NOW, "sevenDay", true), { kind: "unknown" });
});

test("parseUsageTab accepts the three tabs and falls back to model", () => {
  assert.equal(parseUsageTab("project"), "project");
  assert.equal(parseUsageTab("session"), "session");
  assert.equal(parseUsageTab("model"), "model");
  assert.equal(parseUsageTab("bogus"), "model");
  assert.equal(parseUsageTab(null), "model");
  assert.equal(parseUsageTab(undefined), "model");
});

test("stepUsageTab wraps with the arrows and jumps with Home and End", () => {
  assert.equal(stepUsageTab("model", "ArrowRight"), "project");
  assert.equal(stepUsageTab("session", "ArrowRight"), "model");
  assert.equal(stepUsageTab("model", "ArrowLeft"), "session");
  assert.equal(stepUsageTab("project", "ArrowLeft"), "model");
  assert.equal(stepUsageTab("project", "Home"), "model");
  assert.equal(stepUsageTab("model", "End"), "session");
  assert.equal(stepUsageTab("model", "Enter"), null);
});
