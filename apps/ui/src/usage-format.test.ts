import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageDay, UsageTotals } from "./delegation";
import { contextTone, dayBarHeights, sharePercent, shortProject, sortRows, sourceNote, timeAgo } from "./usage-format";

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
  assert.equal(shortProject("C--Users-vbss-Documentos-Projetos--workspaces-sn-equatorial", null), "sn-equatorial");
  assert.equal(shortProject("C--Users-vbss-Documentos-Projetos-VBSS-vbss-gameficare-hub"), "VBSS-vbss-gameficare-hub");
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
