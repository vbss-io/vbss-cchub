import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PermissionRequestRecord, PermissionRequestSummary } from "./types";
import { permission } from "./test-support/u3-fixtures";

const api = vi.hoisted(() => ({
  fetchPermissions: vi.fn<() => Promise<PermissionRequestRecord[]>>(),
  decidePermission: vi.fn(async () => "done" as const),
  releasePermission: vi.fn(async () => "done" as const),
}));

vi.mock("./api", () => api);

import { ApprovalsProvider, useApprovals, useApprovalsStore } from "./approvals-context";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  api.fetchPermissions.mockReset();
  api.fetchPermissions.mockResolvedValue([]);
  api.decidePermission.mockClear();
  api.releasePermission.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const summary = (record: PermissionRequestRecord): PermissionRequestSummary => {
  const { toolInput: _input, cwd: _cwd, turnId: _turn, ...rest } = record;
  return rest;
};

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

test("the default context outside a provider is empty and its actions resolve", async () => {
  const { result } = renderHook(() => useApprovals());
  expect(result.current.list).toEqual([]);
  expect(result.current.forSession("claude", "x")).toEqual([]);
  await expect(result.current.decide("a", "allow", "")).resolves.toBeUndefined();
  await expect(result.current.answer("a", {})).resolves.toBeUndefined();
  await expect(result.current.release("a")).resolves.toBeUndefined();
});

test("reload replaces the list sorted by creation time and ignores a failing fetch", async () => {
  const a = permission({ id: "a", createdAt: 200, expiresAt: Date.now() + 60_000 });
  const b = permission({ id: "b", createdAt: 100, expiresAt: Date.now() + 60_000 });
  api.fetchPermissions.mockResolvedValueOnce([a, b]);
  const { result } = renderHook(() => useApprovalsStore());
  act(() => result.current.handlers.reload());
  await settle();
  expect(result.current.list.map((item) => item.id)).toEqual(["b", "a"]);
  api.fetchPermissions.mockRejectedValueOnce(new Error("down"));
  act(() => result.current.handlers.reload());
  await settle();
  expect(result.current.list.map((item) => item.id)).toEqual(["b", "a"]);
});

test("a permission request is added as pending and filled in by the details fetch", async () => {
  const record = permission({ id: "r1", toolInput: { command: "ls" }, expiresAt: Date.now() + 60_000 });
  api.fetchPermissions.mockResolvedValue([record]);
  const { result } = renderHook(() => useApprovalsStore());
  act(() => result.current.handlers.onPermissionRequest(summary(record)));
  expect(result.current.list).toHaveLength(1);
  expect(result.current.list[0]?.pendingDetails).toBe(true);
  await settle();
  expect(result.current.list[0]?.pendingDetails).toBeUndefined();
  expect(result.current.list[0]?.toolInput).toEqual({ command: "ls" });
});

test("details are retried every 1.5 seconds until the hub returns them", async () => {
  const record = permission({ id: "r2", toolInput: { command: "pwd" }, expiresAt: Date.now() + 60_000 });
  api.fetchPermissions.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([record]);
  const { result } = renderHook(() => useApprovalsStore());
  act(() => result.current.handlers.onPermissionRequest(summary(record)));
  await settle();
  expect(result.current.list[0]?.pendingDetails).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(result.current.list[0]?.pendingDetails).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(result.current.list[0]?.pendingDetails).toBeUndefined();
  const calls = api.fetchPermissions.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(api.fetchPermissions.mock.calls.length).toBe(calls);
});

test("a failing details retry keeps the pending entry", async () => {
  const record = permission({ id: "r3", expiresAt: Date.now() + 60_000 });
  api.fetchPermissions.mockRejectedValue(new Error("down"));
  const { result } = renderHook(() => useApprovalsStore());
  act(() => result.current.handlers.onPermissionRequest(summary(record)));
  await settle();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(result.current.list[0]?.pendingDetails).toBe(true);
});

test("a resolved event removes the request", async () => {
  const record = permission({ id: "r4", expiresAt: Date.now() + 60_000 });
  api.fetchPermissions.mockResolvedValue([record]);
  const { result } = renderHook(() => useApprovalsStore());
  act(() => result.current.handlers.reload());
  await settle();
  expect(result.current.list).toHaveLength(1);
  act(() => result.current.handlers.onPermissionResolved({ id: "r4", agent: "claude", sessionId: record.sessionId, outcome: "allow", at: 1 }));
  expect(result.current.list).toEqual([]);
});

test("expired requests are pruned after the grace period", async () => {
  const record = permission({ id: "r5", expiresAt: Date.now() + 2_000 });
  api.fetchPermissions.mockResolvedValue([record]);
  const { result } = renderHook(() => useApprovalsStore());
  act(() => result.current.handlers.reload());
  await settle();
  expect(result.current.list).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_000);
  });
  expect(result.current.list).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(result.current.list).toEqual([]);
});

interface Seen {
  store: ReturnType<typeof useApprovalsStore> | null;
  value: ReturnType<typeof useApprovals> | null;
}

const mountProvider = (): { seen: Seen; store: () => ReturnType<typeof useApprovalsStore>; value: () => ReturnType<typeof useApprovals> } => {
  const seen: Seen = { store: null, value: null };
  function Probe() {
    seen.value = useApprovals();
    return null;
  }
  function Harness() {
    const store = useApprovalsStore();
    seen.store = store;
    return (
      <ApprovalsProvider store={store}>
        <Probe />
      </ApprovalsProvider>
    );
  }
  render(<Harness />);
  const need = <T,>(item: T | null): T => {
    if (item === null) throw new Error("not rendered");
    return item;
  };
  return { seen, store: () => need(seen.store), value: () => need(seen.value) };
};

test("the provider exposes decide, answer and release that call the hub and settle the request", async () => {
  const record = permission({ id: "p1", sessionId: "sess-a", expiresAt: Date.now() + 60_000 });
  const other = permission({ id: "p2", sessionId: "sess-b", expiresAt: Date.now() + 60_000 });
  api.fetchPermissions.mockResolvedValue([record, other]);
  const mounted = mountProvider();
  act(() => mounted.store().handlers.reload());
  await settle();
  expect(mounted.value().list).toHaveLength(2);
  expect(mounted.value().forSession("claude", "sess-a").map((item) => item.id)).toEqual(["p1"]);
  await act(async () => {
    await mounted.value().decide("p1", "deny", "no thanks");
  });
  expect(api.decidePermission).toHaveBeenCalledWith("p1", { behavior: "deny", message: "no thanks" });
  expect(mounted.store().list.map((item) => item.id)).toEqual(["p2"]);
  await act(async () => {
    await mounted.value().answer("p2", { Q: "A" });
  });
  expect(api.decidePermission).toHaveBeenLastCalledWith("p2", { behavior: "allow", answers: { Q: "A" } });
  expect(mounted.store().list).toEqual([]);
  api.fetchPermissions.mockResolvedValue([permission({ id: "p3", expiresAt: Date.now() + 60_000 })]);
  act(() => mounted.store().handlers.reload());
  await settle();
  await act(async () => {
    await mounted.value().release("p3");
  });
  expect(api.releasePermission).toHaveBeenCalledWith("p3");
  expect(mounted.store().list).toEqual([]);
});

test("the provider clock ticks every second while approvals are pending", async () => {
  const record = permission({ id: "t1", expiresAt: Date.now() + 60_000 });
  api.fetchPermissions.mockResolvedValue([record]);
  const mounted = mountProvider();
  act(() => mounted.store().handlers.reload());
  await settle();
  const first = mounted.value().now;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
  expect(mounted.value().now - first).toBeGreaterThanOrEqual(3_000);
});
