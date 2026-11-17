import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TaskRecord } from "./delegation";
import { folderPeers } from "./peers";
import type { SessionRecord } from "./types";

const NOW = Date.parse("2026-11-16T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const session = (patch: Partial<SessionRecord>): SessionRecord =>
  ({ sessionId: "s", status: "active", cwd: "C:/repo", archivedAt: null, helperOf: null, updatedAt: NOW, ...patch }) as SessionRecord;

const task = (patch: Partial<TaskRecord>): TaskRecord => ({ id: "t", status: "running", cwd: "C:/repo", isolation: "shared", ...patch }) as TaskRecord;

test("an empty or missing folder has no peers", () => {
  expect(folderPeers(null, [session({})], [task({})], {})).toBe(0);
  expect(folderPeers("", [session({})], [task({})], {})).toBe(0);
});

test("live sessions and shared running tasks in the same folder count, ignoring slashes, case and trailing separators", () => {
  const sessions = [session({ sessionId: "a", cwd: "c:\\Repo\\" }), session({ sessionId: "b", cwd: "C:/repo" })];
  const tasks = [task({ id: "t1", cwd: "C:/REPO/" }), task({ id: "t2", status: "pending" })];
  expect(folderPeers("C:\\repo", sessions, tasks, {})).toBe(4);
});

test("other folders, null folders, ended, archived, helper and stale sessions are not peers", () => {
  const sessions = [
    session({ sessionId: "other", cwd: "C:/other" }),
    session({ sessionId: "nocwd", cwd: null }),
    session({ sessionId: "ended", status: "ended" }),
    session({ sessionId: "archived", archivedAt: NOW - 1 }),
    session({ sessionId: "helper", helperOf: "parent" }),
    session({ sessionId: "stale", updatedAt: NOW - 10 * 3_600_000 }),
  ];
  expect(folderPeers("C:/repo", sessions, [], {})).toBe(0);
});

test("done, worktree-isolated and other-folder tasks are not peers", () => {
  const tasks = [task({ id: "done", status: "done" }), task({ id: "wt", isolation: "worktree" }), task({ id: "elsewhere", cwd: "C:/other" })];
  expect(folderPeers("C:/repo", [], tasks, {})).toBe(0);
});

test("the asking session and task are excluded from the count", () => {
  const sessions = [session({ sessionId: "me" }), session({ sessionId: "you" })];
  const tasks = [task({ id: "mine" }), task({ id: "yours" })];
  expect(folderPeers("C:/repo", sessions, tasks, { sessionId: "me", taskId: "mine" })).toBe(2);
  expect(folderPeers("C:/repo", sessions, tasks, {})).toBe(4);
});
