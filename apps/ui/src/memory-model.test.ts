import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSearchQuery,
  canSearch,
  conflictUpdatedAt,
  DEFAULT_HISTORY_FILTERS,
  formatBuildTime,
  formatBytes,
  handoffView,
  historyEmptyText,
  historyKey,
  historyReducer,
  historyStats,
  hitOpenPlan,
  indexStateLine,
  INITIAL_HISTORY_STATE,
  memorySettingsOf,
  mergeHits,
  periodFrom,
  splitHighlights,
  summaryFailure,
  summaryPreviewView,
  writeOutcomeText,
  type HistoryFilters,
  type HistoryState,
} from "./memory-model";
import type { DaySummary, HistoryHit, HistoryIndexStatus, HistorySearchResult } from "./types";

const hit = (id: number, patch: Partial<HistoryHit> = {}): HistoryHit => ({
  messageId: id,
  sessionId: `s-${id}`,
  client: "claude",
  title: null,
  cwd: null,
  workspace: null,
  role: "user",
  at: 1_700_000_000_000,
  seq: id,
  snippet: "text",
  highlights: [],
  matches: 1,
  ...patch,
});

const result = (hits: HistoryHit[], patch: Partial<HistorySearchResult> = {}): HistorySearchResult => ({
  enabled: true,
  engine: "fts",
  query: "q",
  tokens: ["q"],
  hits,
  offset: 0,
  limit: 20,
  hasMore: false,
  ...patch,
});

const status = (patch: Partial<HistoryIndexStatus> = {}): HistoryIndexStatus => ({
  enabled: true,
  engine: "fts",
  running: false,
  progress: null,
  files: 4,
  sessions: 3,
  rows: 1200,
  textBytes: 2048,
  dbBytes: 5 * 1024 * 1024,
  lastBuildMs: 2500,
  lastBuildAt: null,
  lastRun: null,
  lastError: null,
  roots: { claude: "", codex: "" },
  ...patch,
});

const filters = (patch: Partial<HistoryFilters> = {}): HistoryFilters => ({ ...DEFAULT_HISTORY_FILTERS, ...patch });

describe("search query building", () => {
  const now = new Date(2026, 10, 15, 10, 0, 0);

  it("trims the text and always sends sort, group and paging", () => {
    const params = new URLSearchParams(buildSearchQuery(filters({ q: "  deploy  " }), 0, 20, now));
    assert.equal(params.get("q"), "deploy");
    assert.equal(params.get("sort"), "relevance");
    assert.equal(params.get("group"), "message");
    assert.equal(params.get("limit"), "20");
    assert.equal(params.get("offset"), "0");
    assert.equal(params.has("client"), false);
    assert.equal(params.has("workspace"), false);
    assert.equal(params.has("from"), false);
  });

  it("adds client, workspace, period start and session grouping when set", () => {
    const params = new URLSearchParams(buildSearchQuery(filters({ q: "x", client: "codex", workspace: "C:\\w\\a", period: "week", sort: "recent", group: true }), 40, 20, now));
    assert.equal(params.get("client"), "codex");
    assert.equal(params.get("workspace"), "C:\\w\\a");
    assert.equal(params.get("from"), "2026-11-09");
    assert.equal(params.get("sort"), "recent");
    assert.equal(params.get("group"), "session");
    assert.equal(params.get("offset"), "40");
  });

  it("computes the period start in local days", () => {
    assert.equal(periodFrom("any", now), null);
    assert.equal(periodFrom("today", now), "2026-11-15");
    assert.equal(periodFrom("week", now), "2026-11-09");
    assert.equal(periodFrom("month", now), "2026-10-17");
    assert.equal(periodFrom("week", new Date(2026, 0, 3)), "2025-12-28");
  });

  it("needs two letters before it searches", () => {
    assert.equal(canSearch(""), false);
    assert.equal(canSearch(" a "), false);
    assert.equal(canSearch("ab"), true);
  });

  it("keeps one debounce key per query and filter set, ignoring surrounding spaces", () => {
    assert.equal(historyKey(filters({ q: "abc" }), 20), historyKey(filters({ q: " abc " }), 20));
    assert.notEqual(historyKey(filters({ q: "abc" }), 20), historyKey(filters({ q: "abd" }), 20));
    assert.notEqual(historyKey(filters({ q: "abc" }), 20), historyKey(filters({ q: "abc", client: "claude" }), 20));
    assert.notEqual(historyKey(filters({ q: "abc" }), 20), historyKey(filters({ q: "abc" }), 5));
    assert.notEqual(historyKey(filters({ q: "abc" }), 20), historyKey(filters({ q: "abc", group: true }), 20));
  });
});

describe("splitHighlights", () => {
  it("splits the snippet around each range", () => {
    assert.deepEqual(splitHighlights("fix the deploy now", [[8, 14]]), [
      { text: "fix the ", hit: false },
      { text: "deploy", hit: true },
      { text: " now", hit: false },
    ]);
  });

  it("returns the whole text when there is no range", () => {
    assert.deepEqual(splitHighlights("plain", []), [{ text: "plain", hit: false }]);
  });

  it("merges overlaps, clamps to the text and drops empty or inverted ranges", () => {
    assert.deepEqual(
      splitHighlights("abcdef", [
        [1, 3],
        [2, 5],
        [9, 12],
        [4, 4],
        [5, 2],
      ]),
      [
        { text: "a", hit: false },
        { text: "bcde", hit: true },
        { text: "f", hit: false },
      ],
    );
  });

  it("handles ranges at both ends and an ellipsis prefix", () => {
    assert.deepEqual(
      splitHighlights("…foo bar", [
        [1, 4],
        [5, 8],
      ]),
      [
        { text: "…", hit: false },
        { text: "foo", hit: true },
        { text: " ", hit: false },
        { text: "bar", hit: true },
      ],
    );
  });
});

describe("history state", () => {
  const ready = (hits: HistoryHit[], key = "k"): HistoryState => ({ ...INITIAL_HISTORY_STATE, key, phase: "ready", hits, enabled: true });

  it("keeps the old hits while a new query loads, then replaces them", () => {
    const start = historyReducer(ready([hit(1)]), { type: "start", key: "k2", append: false });
    assert.equal(start.phase, "loading");
    assert.equal(start.hits.length, 1);
    const done = historyReducer(start, { type: "done", key: "k2", result: result([hit(2)], { hasMore: true }), append: false });
    assert.deepEqual(done.hits.map((item) => item.messageId), [2]);
    assert.equal(done.hasMore, true);
    assert.equal(done.phase, "ready");
  });

  it("ignores a late answer for an older key", () => {
    const start = historyReducer(ready([hit(1)]), { type: "start", key: "k2", append: false });
    const late = historyReducer(start, { type: "done", key: "k", result: result([hit(9)]), append: false });
    assert.equal(late, start);
    const lateFail = historyReducer(start, { type: "fail", key: "k", message: "boom" });
    assert.equal(lateFail, start);
  });

  it("appends a page without repeating a message", () => {
    const more = historyReducer(historyReducer(ready([hit(1), hit(2)]), { type: "start", key: "k", append: true }), {
      type: "done",
      key: "k",
      result: result([hit(2), hit(3)]),
      append: true,
    });
    assert.deepEqual(more.hits.map((item) => item.messageId), [1, 2, 3]);
    assert.equal(more.loadingMore, false);
  });

  it("records a failure and clears it on the next start", () => {
    const failed = historyReducer(ready([]), { type: "fail", key: "k", message: "offline" });
    assert.equal(failed.phase, "error");
    assert.equal(failed.error, "offline");
    assert.equal(historyReducer(failed, { type: "start", key: "k", append: false }).error, null);
  });

  it("resets to the initial state", () => {
    assert.equal(historyReducer(ready([hit(1)]), { type: "reset" }), INITIAL_HISTORY_STATE);
  });

  it("merges by message id", () => {
    assert.deepEqual(mergeHits([hit(1)], [hit(1), hit(2)]).map((item) => item.messageId), [1, 2]);
  });
});

describe("historyEmptyText", () => {
  const ready = (hits: HistoryHit[], enabled = true): HistoryState => ({ ...INITIAL_HISTORY_STATE, key: "k", phase: "ready", hits, enabled });

  it("says the index is off", () => {
    assert.match(historyEmptyText({ state: ready([], false), query: "abc", status: null }) ?? "", /index is off/);
    assert.match(historyEmptyText({ state: INITIAL_HISTORY_STATE, query: "", status: status({ enabled: false }) }) ?? "", /index is off/);
  });

  it("shows progress while the index builds", () => {
    const text = historyEmptyText({ state: INITIAL_HISTORY_STATE, query: "", status: status({ running: true, progress: { done: 3, total: 10 } }) });
    assert.match(text ?? "", /Building the index \(3 of 10 files\)/);
  });

  it("explains an empty result, and mentions the build when it is still running", () => {
    assert.equal(historyEmptyText({ state: ready([]), query: " zzz ", status: status() }), 'Nothing found for "zzz".');
    assert.match(historyEmptyText({ state: ready([]), query: "zzz", status: status({ running: true, progress: { done: 1, total: 2 } }) }) ?? "", /still building/);
  });

  it("asks for a query before searching and stays quiet when there are results", () => {
    assert.match(historyEmptyText({ state: INITIAL_HISTORY_STATE, query: "a", status: status() }) ?? "", /at least two letters/);
    assert.equal(historyEmptyText({ state: ready([hit(1)]), query: "abc", status: status() }), null);
  });

  it("reports a failed search", () => {
    assert.equal(historyEmptyText({ state: { ...INITIAL_HISTORY_STATE, phase: "error", error: "offline", enabled: true }, query: "abc", status: null }), "offline");
  });
});

describe("hitOpenPlan", () => {
  const known = { claude: (id: string) => id === "c1", codex: (id: string) => id === "x1" };

  it("opens the drawer when the hub knows the session", () => {
    assert.deepEqual(hitOpenPlan({ client: "claude", sessionId: "c1" }, known), { kind: "claude-drawer", sessionId: "c1" });
    assert.deepEqual(hitOpenPlan({ client: "codex", sessionId: "x1" }, known), { kind: "codex-drawer", sessionId: "x1" });
  });

  it("falls back to the open route for an unknown session", () => {
    assert.deepEqual(hitOpenPlan({ client: "claude", sessionId: "c2" }, known), { kind: "claude-open", sessionId: "c2" });
    assert.deepEqual(hitOpenPlan({ client: "codex", sessionId: "x2" }, known), { kind: "codex-open", sessionId: "x2" });
  });

  it("has nothing to open without a session id", () => {
    assert.deepEqual(hitOpenPlan({ client: "claude", sessionId: null }, known), { kind: "none" });
  });
});

describe("index stats", () => {
  it("formats sizes and build times", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(900), "900 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(5 * 1024 * 1024), "5 MB");
    assert.equal(formatBytes(120 * 1024 * 1024), "120 MB");
    assert.equal(formatBuildTime(null), "not built yet");
    assert.equal(formatBuildTime(420), "420 ms");
    assert.equal(formatBuildTime(2500), "2.5 s");
    assert.equal(formatBuildTime(125_000), "2 min 5 s");
  });

  it("lists sessions, messages, size and last build", () => {
    assert.deepEqual(historyStats(status()), [
      { label: "Sessions", value: "3" },
      { label: "Messages", value: "1,200" },
      { label: "Index size", value: "5 MB" },
      { label: "Last full build", value: "2.5 s" },
    ]);
  });

  it("describes the index state in plain words", () => {
    assert.equal(indexStateLine(null), "Checking...");
    assert.equal(indexStateLine(status({ enabled: false })), "Off");
    assert.equal(indexStateLine(status({ running: true, progress: { done: 2, total: 9 } })), "Building: 2 of 9 files");
    assert.equal(indexStateLine(status({ lastError: "disk full" })), "Stopped: disk full");
    assert.equal(indexStateLine(status({ sessions: 0 })), "Nothing indexed yet");
    assert.equal(indexStateLine(status()), "Ready");
  });

  it("fills memory settings that an older hub does not send", () => {
    assert.deepEqual(memorySettingsOf(null), { historyIndex: true, handoffWorkspaces: [], summaryHeading: "Day summary" });
    assert.deepEqual(memorySettingsOf({ memory: { handoffWorkspaces: ["a"] } }), { historyIndex: true, handoffWorkspaces: ["a"], summaryHeading: "Day summary" });
  });
});

describe("handoffView", () => {
  const preview = (text: string | null) => ({ workspace: "vbss", enabled: false, sessions: [], openLoops: [], text, chars: text?.length ?? 0 });

  it("shows the text with its size against the cap", () => {
    assert.deepEqual(handoffView(preview("hello")), { kind: "text", text: "hello", size: "5 of 1500 characters" });
  });

  it("says plainly when there is nothing to carry over", () => {
    const view = handoffView(preview(null));
    assert.equal(view.kind, "empty");
    assert.match(view.text, /Nothing to carry over/);
  });
});

describe("day summary states", () => {
  const summary = (patch: Partial<DaySummary> = {}): DaySummary => ({
    date: "2026-11-15",
    heading: "Day summary",
    sessions: [],
    tasks: [],
    reports: [],
    commits: [],
    empty: false,
    block: "b",
    markdown: "## Day summary\n\nb",
    ...patch,
  });

  it("maps a conflict to the reload message", () => {
    assert.deepEqual(summaryFailure(409, "changed"), { kind: "conflict", text: "The daily changed, reload" });
  });

  it("explains a missing daily, a disabled feature and a missing vault", () => {
    assert.equal(summaryFailure(404, "x").kind, "missing-daily");
    assert.equal(summaryFailure(400, "the daily feature is disabled").kind, "daily-off");
    assert.equal(summaryFailure(400, "second brain root not set").kind, "no-vault");
    assert.deepEqual(summaryFailure(500, "boom"), { kind: "other", text: "boom" });
  });

  it("reads the new base from a conflict body", () => {
    assert.equal(conflictUpdatedAt({ error: "x", content: "", updatedAt: 1234 }), 1234);
    assert.equal(conflictUpdatedAt({ updatedAt: "no" }), null);
    assert.equal(conflictUpdatedAt(null), null);
  });

  it("blocks the write when there is nothing to say or no daily", () => {
    assert.deepEqual(summaryPreviewView(summary(), true), { markdown: "## Day summary\n\nb", canWrite: true, note: null });
    assert.equal(summaryPreviewView(summary({ empty: true }), true).canWrite, false);
    const noDaily = summaryPreviewView(summary(), false);
    assert.equal(noDaily.canWrite, false);
    assert.equal(noDaily.markdown, "## Day summary\n\nb");
    assert.match(noDaily.note ?? "", /no daily note/);
  });

  it("reports whether the daily changed", () => {
    assert.equal(writeOutcomeText({ changed: true }, "Day summary"), 'Written to the daily under "Day summary".');
    assert.equal(writeOutcomeText({ changed: false }, "Day summary"), "The daily already has this summary.");
  });
});
