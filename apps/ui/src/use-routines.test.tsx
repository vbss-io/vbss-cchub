import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { RoutineStreamEvent } from "./routines-api";
import type { RoutineRunRecord, RoutineSettings, RoutinesList } from "./types";
import { useRoutines, useRoutineUnread } from "./use-routines";

const api = vi.hoisted(() => ({
  fetchRoutines: vi.fn<() => Promise<unknown>>(),
  fetchInbox: vi.fn<(unreadOnly: boolean, limit?: number) => Promise<unknown>>(),
  fetchRoutineSettings: vi.fn<() => Promise<unknown>>(),
  fetchUnreadCount: vi.fn<() => Promise<number>>(),
}));

vi.mock("./routines-api", () => api);

const list = { routines: [{ id: "r1" }] } as unknown as RoutinesList;
const settings = { retentionDays: 7 } as unknown as RoutineSettings;
const run = (id: string): RoutineRunRecord => ({ id }) as unknown as RoutineRunRecord;

interface Bus {
  subscribe: (listener: (event: RoutineStreamEvent) => void) => () => void;
  emit: (event: RoutineStreamEvent) => void;
  unsubscribed: () => number;
}

const bus = (): Bus => {
  const listeners = new Set<(event: RoutineStreamEvent) => void>();
  let unsubscribed = 0;
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        unsubscribed += 1;
        listeners.delete(listener);
      };
    },
    emit: (event) => listeners.forEach((listener) => listener(event)),
    unsubscribed: () => unsubscribed,
  };
};

beforeEach(() => {
  api.fetchRoutines.mockReset().mockResolvedValue(list);
  api.fetchInbox.mockReset().mockResolvedValue({ items: [run("i1")], unread: 1 });
  api.fetchRoutineSettings.mockReset().mockResolvedValue(settings);
  api.fetchUnreadCount.mockReset().mockResolvedValue(2);
});

afterEach(() => {
  vi.useRealTimers();
});

test("useRoutines loads the list, the inbox and the settings together", async () => {
  const events = bus();
  const { result } = renderHook(() => useRoutines(events.subscribe, true));
  expect(result.current.loaded).toBe(false);
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current).toMatchObject({ list, settings, error: null });
  expect(result.current.inbox).toEqual([run("i1")]);
  expect(api.fetchInbox).toHaveBeenCalledWith(false, 50);
});

test("useRoutines does nothing while disabled", () => {
  const events = bus();
  const { result } = renderHook(() => useRoutines(events.subscribe, false));
  expect(api.fetchRoutines).not.toHaveBeenCalled();
  expect(result.current.loaded).toBe(false);
});

test("useRoutines reports a load failure with the hub message or a default and marks itself loaded", async () => {
  api.fetchRoutines.mockRejectedValueOnce(new Error("hub down"));
  const events = bus();
  const { result } = renderHook(() => useRoutines(events.subscribe, true));
  await waitFor(() => expect(result.current.error).toBe("hub down"));
  expect(result.current.loaded).toBe(true);
  api.fetchRoutines.mockRejectedValueOnce("odd");
  await act(async () => result.current.reload());
  expect(result.current.error).toBe("Could not load the routines.");
  await act(async () => result.current.reload());
  expect(result.current.error).toBeNull();
});

test("useRoutines coalesces a burst of stream events into one reload", async () => {
  const events = bus();
  const { result } = renderHook(() => useRoutines(events.subscribe, true));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(api.fetchRoutines).toHaveBeenCalledTimes(1);
  vi.useFakeTimers();
  act(() => {
    events.emit({ kind: "routines" });
    events.emit({ kind: "routines-inbox", unread: 3 });
    events.emit({ kind: "routines" });
  });
  await act(async () => vi.advanceTimersByTimeAsync(149));
  expect(api.fetchRoutines).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(2));
  expect(api.fetchRoutines).toHaveBeenCalledTimes(2);
});

test("useRoutines unsubscribes and drops a pending reload on unmount", async () => {
  const events = bus();
  const { result, unmount } = renderHook(() => useRoutines(events.subscribe, true));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  vi.useFakeTimers();
  act(() => events.emit({ kind: "routines" }));
  unmount();
  expect(events.unsubscribed()).toBe(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(api.fetchRoutines).toHaveBeenCalledTimes(1);
});

test("useRoutines lets the caller replace the inbox and the settings locally", async () => {
  const events = bus();
  const { result } = renderHook(() => useRoutines(events.subscribe, true));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  act(() => {
    result.current.setInbox([run("x")]);
    result.current.setSettings({ retentionDays: 30 } as unknown as RoutineSettings);
  });
  expect(result.current.inbox).toEqual([run("x")]);
  expect(result.current.settings).toEqual({ retentionDays: 30 });
});

test("useRoutines ignores the answer of a reload that was superseded", async () => {
  let slow: (value: unknown) => void = () => undefined;
  api.fetchRoutines.mockReturnValueOnce(new Promise((done) => (slow = done)));
  const events = bus();
  const { result } = renderHook(() => useRoutines(events.subscribe, true));
  api.fetchRoutines.mockResolvedValueOnce({ routines: [{ id: "new" }] });
  await act(async () => result.current.reload());
  await act(async () => slow({ routines: [{ id: "old" }] }));
  expect(result.current.list).toEqual({ routines: [{ id: "new" }] });
});

test("useRoutines ignores the failure of a reload that was superseded", async () => {
  let slow: (reason: Error) => void = () => undefined;
  api.fetchRoutines.mockReturnValueOnce(new Promise((_, fail) => (slow = fail)));
  const events = bus();
  const { result } = renderHook(() => useRoutines(events.subscribe, true));
  await act(async () => result.current.reload());
  await act(async () => slow(new Error("late failure")));
  expect(result.current.error).toBeNull();
  expect(result.current.list).toEqual(list);
});

test("useRoutineUnread starts at zero, loads the count and follows inbox events", async () => {
  const events = bus();
  const { result } = renderHook(() => useRoutineUnread(events.subscribe, true));
  expect(result.current).toBe(0);
  await waitFor(() => expect(result.current).toBe(2));
  act(() => events.emit({ kind: "routines-inbox", unread: 5 }));
  expect(result.current).toBe(5);
  api.fetchUnreadCount.mockResolvedValueOnce(7);
  act(() => events.emit({ kind: "routines" }));
  await waitFor(() => expect(result.current).toBe(7));
});

test("useRoutineUnread resets to zero when disabled and tolerates failures and late answers", async () => {
  const events = bus();
  const { result, rerender, unmount } = renderHook(({ enabled }) => useRoutineUnread(events.subscribe, enabled), { initialProps: { enabled: true } });
  await waitFor(() => expect(result.current).toBe(2));
  rerender({ enabled: false });
  await waitFor(() => expect(result.current).toBe(0));
  api.fetchUnreadCount.mockRejectedValueOnce(new Error("down"));
  rerender({ enabled: true });
  await waitFor(() => expect(api.fetchUnreadCount).toHaveBeenCalledTimes(2));
  expect(result.current).toBe(0);
  let late: (value: number) => void = () => undefined;
  api.fetchUnreadCount.mockReturnValueOnce(new Promise((done) => (late = done)));
  rerender({ enabled: false });
  rerender({ enabled: true });
  unmount();
  await act(async () => late(9));
  expect(result.current).toBe(0);
  expect(events.unsubscribed()).toBeGreaterThan(0);
});
