import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { relativeTime } from "./time";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const ago = (ms: number): number => Date.now() - ms;

test("relativeTime says now under a minute, then minutes, hours and days", () => {
  expect(relativeTime(ago(0))).toBe("now");
  expect(relativeTime(ago(59_000))).toBe("now");
  expect(relativeTime(ago(60_000))).toBe("1m ago");
  expect(relativeTime(ago(59 * 60_000))).toBe("59m ago");
  expect(relativeTime(ago(60 * 60_000))).toBe("1h ago");
  expect(relativeTime(ago(23 * 3_600_000 + 59 * 60_000))).toBe("23h ago");
  expect(relativeTime(ago(24 * 3_600_000))).toBe("1d ago");
  expect(relativeTime(ago(72 * 3_600_000))).toBe("3d ago");
});
