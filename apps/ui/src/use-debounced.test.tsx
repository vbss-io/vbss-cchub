import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useDebouncedCallback } from "./use-debounced";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("the callback fires once with the latest arguments after the delay", () => {
  const callback = vi.fn();
  const { result } = renderHook(() => useDebouncedCallback(callback, 300));
  result.current("a");
  vi.advanceTimersByTime(200);
  result.current("b");
  vi.advanceTimersByTime(299);
  expect(callback).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(callback).toHaveBeenCalledWith("b");
});

test("the default delay is 400ms", () => {
  const callback = vi.fn();
  const { result } = renderHook(() => useDebouncedCallback(callback));
  result.current(1);
  vi.advanceTimersByTime(399);
  expect(callback).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(callback).toHaveBeenCalledWith(1);
});

test("flush runs the pending call immediately and a second flush does nothing", () => {
  const callback = vi.fn();
  const { result } = renderHook(() => useDebouncedCallback(callback, 300));
  result.current("x");
  result.current.flush();
  expect(callback).toHaveBeenCalledWith("x");
  result.current.flush();
  vi.advanceTimersByTime(1000);
  expect(callback).toHaveBeenCalledTimes(1);
});

test("flush without a pending call does nothing", () => {
  const callback = vi.fn();
  const { result } = renderHook(() => useDebouncedCallback(callback, 300));
  result.current.flush();
  expect(callback).not.toHaveBeenCalled();
});

test("cancel drops the pending call", () => {
  const callback = vi.fn();
  const { result } = renderHook(() => useDebouncedCallback(callback, 300));
  result.current("x");
  result.current.cancel();
  result.current.cancel();
  vi.advanceTimersByTime(1000);
  expect(callback).not.toHaveBeenCalled();
});

test("the debounced function keeps its identity and calls the latest callback and delay", () => {
  const first = vi.fn();
  const second = vi.fn();
  const { result, rerender } = renderHook(({ callback, delay }) => useDebouncedCallback(callback, delay), { initialProps: { callback: first, delay: 300 } });
  const initial = result.current;
  rerender({ callback: second, delay: 50 });
  expect(result.current).toBe(initial);
  result.current("late");
  vi.advanceTimersByTime(50);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith("late");
});

test("unmounting flushes the pending call", () => {
  const callback = vi.fn();
  const { result, unmount } = renderHook(() => useDebouncedCallback(callback, 300));
  result.current("last");
  unmount();
  expect(callback).toHaveBeenCalledWith("last");
});
