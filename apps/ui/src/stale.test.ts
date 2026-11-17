import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isEmpty, isStale } from "./stale";
import type { SessionRecord } from "./types";

const NOW = Date.parse("2026-11-16T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const session = (patch: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: "s1",
  status: "idle",
  cwd: null,
  source: null,
  hostPid: null,
  title: null,
  customTitle: null,
  lastMessage: null,
  model: "m",
  tokensIn: null,
  tokensOut: null,
  contextTokens: 10,
  archivedAt: null,
  startedAt: NOW - 3_600_000,
  updatedAt: NOW,
  ...patch,
});

test("a session untouched for more than the stale window is stale", () => {
  expect(isStale(session({ updatedAt: NOW - 3_600_000 }))).toBe(false);
  expect(isStale(session({ updatedAt: NOW - 5 * 3_600_000 }))).toBe(true);
});

test("archived and ended sessions are never stale", () => {
  const old = NOW - 10 * 3_600_000;
  expect(isStale(session({ updatedAt: old, archivedAt: NOW - 1 }))).toBe(false);
  expect(isStale(session({ updatedAt: old, status: "ended" }))).toBe(false);
});

test("a session with no model and no context is empty only after the grace period", () => {
  expect(isEmpty(session({ model: null, contextTokens: null, startedAt: NOW - 30_000 }))).toBe(false);
  expect(isEmpty(session({ model: null, contextTokens: null, startedAt: NOW - 200_000 }))).toBe(true);
});

test("a session with a model or context tokens is not empty", () => {
  expect(isEmpty(session({ model: "m", contextTokens: null, startedAt: NOW - 200_000 }))).toBe(false);
  expect(isEmpty(session({ model: null, contextTokens: 5, startedAt: NOW - 200_000 }))).toBe(false);
});
