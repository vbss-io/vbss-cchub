import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ probeHealth: vi.fn<() => Promise<boolean>>() }));

vi.mock("./api", () => api);

import { useHubConnection } from "./use-hub-connection";

beforeEach(() => {
  vi.useFakeTimers();
  api.probeHealth.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

test("starts online and does not probe while the stream is healthy", async () => {
  const { result } = renderHook(() => useHubConnection(() => undefined));
  expect(result.current.offline).toBe(false);
  await advance(10_000);
  expect(api.probeHealth).not.toHaveBeenCalled();
});

test("a stream error starts probing and goes offline after the threshold when health keeps failing", async () => {
  api.probeHealth.mockResolvedValue(false);
  const { result } = renderHook(() => useHubConnection(() => undefined));
  act(() => result.current.streamError());
  await advance(0);
  expect(api.probeHealth).toHaveBeenCalledTimes(1);
  expect(result.current.offline).toBe(false);
  await advance(6_000);
  expect(api.probeHealth.mock.calls.length).toBeGreaterThan(3);
  expect(result.current.offline).toBe(true);
});

test("reopening the stream after an outage reports recovery once and stops probing", async () => {
  api.probeHealth.mockResolvedValue(false);
  const onRecovered = vi.fn();
  const { result } = renderHook(() => useHubConnection(onRecovered));
  act(() => result.current.streamError());
  await advance(6_000);
  expect(result.current.offline).toBe(true);
  expect(onRecovered).not.toHaveBeenCalled();
  act(() => result.current.streamOpen());
  expect(result.current.offline).toBe(false);
  expect(onRecovered).toHaveBeenCalledTimes(1);
  const probes = api.probeHealth.mock.calls.length;
  await advance(5_000);
  expect(api.probeHealth.mock.calls.length).toBe(probes);
});

test("a healthy probe clears a short stream error without reporting recovery", async () => {
  api.probeHealth.mockResolvedValue(true);
  const onRecovered = vi.fn();
  const { result } = renderHook(() => useHubConnection(onRecovered));
  act(() => result.current.streamError());
  await advance(100);
  expect(result.current.offline).toBe(false);
  expect(onRecovered).not.toHaveBeenCalled();
  const probes = api.probeHealth.mock.calls.length;
  await advance(5_000);
  expect(api.probeHealth.mock.calls.length).toBe(probes);
});

test("calls the latest recovery callback", async () => {
  api.probeHealth.mockResolvedValue(false);
  const first = vi.fn();
  const second = vi.fn();
  const { result, rerender } = renderHook(({ cb }) => useHubConnection(cb), { initialProps: { cb: first } });
  act(() => result.current.streamError());
  await advance(6_000);
  rerender({ cb: second });
  act(() => result.current.streamOpen());
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
});

test("ignores a probe answer that arrives after the probing effect was cleaned up", async () => {
  let release: (ok: boolean) => void = () => undefined;
  api.probeHealth.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const { result } = renderHook(() => useHubConnection(() => undefined));
  act(() => result.current.streamError());
  await advance(0);
  act(() => result.current.streamOpen());
  await act(async () => {
    release(false);
  });
  expect(result.current.offline).toBe(false);
});
