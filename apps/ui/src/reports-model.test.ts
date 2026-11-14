import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReportRecord } from "./delegation";
import {
  ALL_WORKSPACES,
  DEFAULT_REPORT_FILTERS,
  NO_WORKSPACE,
  filterReports,
  kindCounts,
  matchesQuery,
  parseStoredReportFilters,
  reportMeta,
  resolveWorkspace,
  workspaceOptions,
} from "./reports-model";

let seq = 0;
const report = (overrides: Partial<ReportRecord>): ReportRecord => {
  seq += 1;
  return { id: `r${seq}`, taskId: null, sessionId: null, workspace: null, kind: "note", text: "text", source: null, createdAt: seq, ...overrides };
};

const sample: ReportRecord[] = [
  report({ kind: "result", workspace: "vbss", source: "claude-code", sessionId: "abcdef1234567", text: "Deployed the fix" }),
  report({ kind: "progress", workspace: "vbss", source: "codex", text: "Halfway through the migration" }),
  report({ kind: "blocked", workspace: "preview", source: "claude-desktop", taskId: "task-0042", text: "Cannot reach staging" }),
  report({ kind: "note", workspace: null, source: "cli", text: "Bump the changelog" }),
  report({ kind: "result", workspace: "preview", text: "Refactor done" }),
];

test("filterReports with the defaults returns everything in order", () => {
  assert.deepEqual(filterReports(sample, DEFAULT_REPORT_FILTERS), sample);
});

test("filterReports narrows by kind, workspace and query together", () => {
  assert.equal(filterReports(sample, { ...DEFAULT_REPORT_FILTERS, kind: "result" }).length, 2);
  assert.equal(filterReports(sample, { ...DEFAULT_REPORT_FILTERS, workspace: "preview" }).length, 2);
  assert.equal(filterReports(sample, { kind: "result", workspace: "preview", query: "" }).length, 1);
  assert.equal(filterReports(sample, { kind: "all", workspace: ALL_WORKSPACES, query: "migration" }).length, 1);
  assert.equal(filterReports(sample, { kind: "result", workspace: "preview", query: "deployed" }).length, 0);
});

test("filterReports can select reports without a workspace", () => {
  const found = filterReports(sample, { ...DEFAULT_REPORT_FILTERS, workspace: NO_WORKSPACE });
  assert.deepEqual(
    found.map((item) => item.text),
    ["Bump the changelog"],
  );
});

test("matchesQuery looks at text, client, workspace, session id and task id, ignoring case and padding", () => {
  const item = sample[0] as ReportRecord;
  assert.ok(matchesQuery(item, "  DEPLOYED "));
  assert.ok(matchesQuery(item, "claude-code"));
  assert.ok(matchesQuery(item, "VBSS"));
  assert.ok(matchesQuery(item, "abcdef12"));
  assert.ok(matchesQuery(sample[2] as ReportRecord, "task-0042"));
  assert.ok(!matchesQuery(item, "nothing like this"));
  assert.ok(matchesQuery(item, "   "));
});

test("kindCounts keeps the plain per-kind totals with no other filter", () => {
  assert.deepEqual(kindCounts(sample, DEFAULT_REPORT_FILTERS), { all: 5, result: 2, progress: 1, blocked: 1, note: 1 });
});

test("kindCounts follows the workspace and search but not the selected kind", () => {
  assert.deepEqual(kindCounts(sample, { kind: "blocked", workspace: "preview", query: "" }), { all: 2, result: 1, progress: 0, blocked: 1, note: 0 });
  assert.deepEqual(kindCounts(sample, { kind: "note", workspace: ALL_WORKSPACES, query: "the" }), { all: 3, result: 1, progress: 1, blocked: 0, note: 1 });
});

test("workspaceOptions counts per workspace, sorts by name and adds a no-workspace entry last", () => {
  assert.deepEqual(workspaceOptions(sample), [
    { value: "preview", label: "preview", count: 2 },
    { value: "vbss", label: "vbss", count: 2 },
    { value: NO_WORKSPACE, label: "No workspace", count: 1 },
  ]);
  assert.deepEqual(workspaceOptions([]), []);
});

test("resolveWorkspace falls back to all when the stored workspace no longer exists", () => {
  const options = workspaceOptions(sample);
  assert.equal(resolveWorkspace(options, "vbss"), "vbss");
  assert.equal(resolveWorkspace(options, "gone"), ALL_WORKSPACES);
  assert.equal(resolveWorkspace(options, ALL_WORKSPACES), ALL_WORKSPACES);
});

test("parseStoredReportFilters reads valid values and ignores corrupt ones", () => {
  assert.deepEqual(parseStoredReportFilters(JSON.stringify({ kind: "blocked", workspace: "vbss" })), { kind: "blocked", workspace: "vbss" });
  assert.deepEqual(parseStoredReportFilters(JSON.stringify({ kind: "weird", workspace: 4 })), { kind: "all", workspace: ALL_WORKSPACES });
  assert.deepEqual(parseStoredReportFilters("{broken"), { kind: "all", workspace: ALL_WORKSPACES });
  assert.deepEqual(parseStoredReportFilters(null), { kind: "all", workspace: ALL_WORKSPACES });
  assert.deepEqual(parseStoredReportFilters("7"), { kind: "all", workspace: ALL_WORKSPACES });
});

test("reportMeta joins client and a short session id", () => {
  assert.equal(reportMeta({ source: "claude-code", sessionId: "abcdef1234567" }), "claude-code · session abcdef12");
  assert.equal(reportMeta({ source: null, sessionId: "abcdef1234567" }), "session abcdef12");
  assert.equal(reportMeta({ source: "cli", sessionId: null }), "cli");
  assert.equal(reportMeta({ source: null, sessionId: null }), "");
});
