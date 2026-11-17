import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { CostTotals, HealthReport, LimitsForecast } from "./types";
import { useHealth, useLimitsForecast, useTaskCosts } from "./use-ops";

const api = vi.hoisted(() => ({
  fetchTaskCosts: vi.fn<(ids: string[]) => Promise<Record<string, unknown>>>(),
  fetchForecast: vi.fn<() => Promise<unknown>>(),
  fetchHealthReport: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("./review-api", () => ({ fetchTaskCosts: api.fetchTaskCosts }));
vi.mock("./ops-api", () => ({ fetchForecast: api.fetchForecast, fetchHealthReport: api.fetchHealthReport }));

const cost = (total: number): CostTotals => ({ total }) as unknown as CostTotals;

beforeEach(() => {
  api.fetchTaskCosts.mockReset();
  api.fetchForecast.mockReset();
  api.fetchHealthReport.mockReset();
});

test("useTaskCosts fetches the costs of the ids and merges later answers into the map", async () => {
  api.fetchTaskCosts.mockResolvedValueOnce({ a: cost(1) }).mockResolvedValueOnce({ b: cost(2) });
  const { result, rerender } = renderHook(({ ids }) => useTaskCosts(ids, 0, true), { initialProps: { ids: ["a"] } });
  await waitFor(() => expect(result.current).toEqual({ a: cost(1) }));
  expect(api.fetchTaskCosts).toHaveBeenLastCalledWith(["a"]);
  rerender({ ids: ["a", "b"] });
  await waitFor(() => expect(result.current).toEqual({ a: cost(1), b: cost(2) }));
  expect(api.fetchTaskCosts).toHaveBeenLastCalledWith(["a", "b"]);
});

test("useTaskCosts refetches when the refresh key changes", async () => {
  api.fetchTaskCosts.mockResolvedValue({ a: cost(1) });
  const { rerender } = renderHook(({ refresh }) => useTaskCosts(["a"], refresh, true), { initialProps: { refresh: 0 } });
  await waitFor(() => expect(api.fetchTaskCosts).toHaveBeenCalledTimes(1));
  rerender({ refresh: 1 });
  await waitFor(() => expect(api.fetchTaskCosts).toHaveBeenCalledTimes(2));
});

test("useTaskCosts does nothing when disabled or without ids and ignores failures", async () => {
  const disabled = renderHook(() => useTaskCosts(["a"], 0, false));
  const empty = renderHook(() => useTaskCosts([], 0, true));
  expect(api.fetchTaskCosts).not.toHaveBeenCalled();
  expect(disabled.result.current).toEqual({});
  expect(empty.result.current).toEqual({});
  api.fetchTaskCosts.mockRejectedValueOnce(new Error("down"));
  const failing = renderHook(() => useTaskCosts(["z"], 0, true));
  await waitFor(() => expect(api.fetchTaskCosts).toHaveBeenCalledTimes(1));
  expect(failing.result.current).toEqual({});
});

test("useTaskCosts drops the answer when unmounted before it arrives", async () => {
  let resolve: (value: Record<string, unknown>) => void = () => undefined;
  api.fetchTaskCosts.mockReturnValueOnce(new Promise((done) => (resolve = done)));
  const { result, unmount } = renderHook(() => useTaskCosts(["a"], 0, true));
  unmount();
  await act(async () => resolve({ a: cost(1) }));
  expect(result.current).toEqual({});
});

test("useTaskCosts caps the request at 500 ids", async () => {
  api.fetchTaskCosts.mockResolvedValue({});
  const ids = Array.from({ length: 600 }, (_, index) => `t${index}`);
  renderHook(() => useTaskCosts(ids, 0, true));
  await waitFor(() => expect(api.fetchTaskCosts).toHaveBeenCalledTimes(1));
  expect(api.fetchTaskCosts.mock.calls[0]?.[0]).toHaveLength(500);
});

test("useLimitsForecast loads the forecast when enabled and clears it when disabled", async () => {
  const forecast = { horizon: 5 } as unknown as LimitsForecast;
  api.fetchForecast.mockResolvedValue(forecast);
  const { result, rerender } = renderHook(({ enabled }) => useLimitsForecast(enabled, 0), { initialProps: { enabled: true } });
  expect(result.current).toBeNull();
  await waitFor(() => expect(result.current).toEqual(forecast));
  rerender({ enabled: false });
  await waitFor(() => expect(result.current).toBeNull());
});

test("useLimitsForecast falls back to null on failure and ignores a late answer after unmount", async () => {
  api.fetchForecast.mockRejectedValueOnce(new Error("down"));
  const failing = renderHook(() => useLimitsForecast(true, 0));
  await waitFor(() => expect(api.fetchForecast).toHaveBeenCalledTimes(1));
  expect(failing.result.current).toBeNull();
  let resolve: (value: unknown) => void = () => undefined;
  api.fetchForecast.mockReturnValueOnce(new Promise((done) => (resolve = done)));
  const late = renderHook(() => useLimitsForecast(true, 1));
  late.unmount();
  await act(async () => resolve({ horizon: 1 }));
  expect(late.result.current).toBeNull();
  let reject: (reason: Error) => void = () => undefined;
  api.fetchForecast.mockReturnValueOnce(new Promise((_, fail) => (reject = fail)));
  const lateFail = renderHook(() => useLimitsForecast(true, 2));
  lateFail.unmount();
  await act(async () => reject(new Error("late")));
  expect(lateFail.result.current).toBeNull();
});

test("useHealth stays idle until enabled, then loads the report", async () => {
  const report = { checkedAt: 1, items: [] } as unknown as HealthReport;
  api.fetchHealthReport.mockResolvedValue(report);
  const { result, rerender } = renderHook(({ enabled }) => useHealth(enabled), { initialProps: { enabled: false } });
  expect(api.fetchHealthReport).not.toHaveBeenCalled();
  expect(result.current).toMatchObject({ report: null, error: null, loading: false });
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.report).toEqual(report));
  expect(result.current.loading).toBe(false);
  expect(result.current.error).toBeNull();
});

test("useHealth reports the hub error, then clears it after a successful refresh", async () => {
  api.fetchHealthReport.mockRejectedValueOnce(new Error("hub exploded"));
  const { result } = renderHook(() => useHealth(true));
  await waitFor(() => expect(result.current.error).toBe("hub exploded"));
  expect(result.current.loading).toBe(false);
  api.fetchHealthReport.mockResolvedValueOnce({ checkedAt: 2, items: [] });
  await act(async () => result.current.refresh());
  expect(result.current.error).toBeNull();
  expect(result.current.report).toEqual({ checkedAt: 2, items: [] });
});

test("useHealth uses the generic message for an error without text", async () => {
  api.fetchHealthReport.mockRejectedValueOnce("plain");
  const { result } = renderHook(() => useHealth(true));
  await waitFor(() => expect(result.current.error).toBe("Could not check the health of the hub."));
});

test("useHealth keeps only the latest refresh when two overlap", async () => {
  let first: (value: unknown) => void = () => undefined;
  let second: (value: unknown) => void = () => undefined;
  api.fetchHealthReport.mockReturnValueOnce(new Promise((done) => (first = done))).mockReturnValueOnce(new Promise((done) => (second = done)));
  const { result } = renderHook(() => useHealth(true));
  await act(async () => {
    void result.current.refresh();
  });
  await act(async () => second({ checkedAt: 2, items: [] }));
  await act(async () => first({ checkedAt: 1, items: [] }));
  expect(result.current.report).toEqual({ checkedAt: 2, items: [] });
  expect(result.current.loading).toBe(false);
});

test("useHealth ignores a stale failure that arrives after a newer refresh", async () => {
  let first: (reason: Error) => void = () => undefined;
  api.fetchHealthReport.mockReturnValueOnce(new Promise((_, fail) => (first = fail))).mockResolvedValueOnce({ checkedAt: 3, items: [] });
  const { result } = renderHook(() => useHealth(true));
  await act(async () => result.current.refresh());
  await act(async () => first(new Error("old failure")));
  expect(result.current.error).toBeNull();
  expect(result.current.report).toEqual({ checkedAt: 3, items: [] });
});
