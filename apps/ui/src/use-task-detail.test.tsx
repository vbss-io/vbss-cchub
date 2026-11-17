import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelTask, continueTask, getTask, getTaskEvents, type TaskDetail } from "./delegation";
import { archiveTask, discardTaskWorktree, getTaskWorktree, mergeTaskWorktree, probeArchiveSupport, retryTask, unarchiveTask } from "./delegation-actions";
import { makeDetail, makeEvent, makeRun, makeTaskRecord, makeWorktree } from "./test-support/u2-task-fixtures";
import type { RunEventMessage } from "./types";
import { retryPermission, useArchiveSupport, useTaskDetail } from "./use-task-detail";

vi.mock("./delegation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./delegation")>()),
  getTask: vi.fn(),
  getTaskEvents: vi.fn(),
  cancelTask: vi.fn(),
  continueTask: vi.fn(),
}));

vi.mock("./delegation-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./delegation-actions")>()),
  archiveTask: vi.fn(),
  unarchiveTask: vi.fn(),
  discardTaskWorktree: vi.fn(),
  getTaskWorktree: vi.fn(),
  mergeTaskWorktree: vi.fn(),
  probeArchiveSupport: vi.fn(),
  retryTask: vi.fn(),
}));

const get = vi.mocked(getTask);
const events = vi.mocked(getTaskEvents);
const worktree = vi.mocked(getTaskWorktree);
const probe = vi.mocked(probeArchiveSupport);

const sharedDetail = (id = "t1"): TaskDetail => makeDetail(makeTaskRecord(id), { runs: [makeRun("r1", id)] });

function makeEmitter() {
  const listeners = new Set<(event: RunEventMessage) => void>();
  return {
    subscribe: (listener: (event: RunEventMessage) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (event: Partial<RunEventMessage> & Pick<RunEventMessage, "taskId" | "runId" | "kind" | "text">) => {
      for (const listener of [...listeners]) listener(event as RunEventMessage);
    },
    count: () => listeners.size,
  };
}

const setup = (taskId = "t1", tick = 0) => {
  const emitter = makeEmitter();
  const onRefresh = vi.fn(() => Promise.resolve());
  const onError = vi.fn();
  const view = renderHook(({ id, tickValue }) => useTaskDetail(id, tickValue, emitter.subscribe, onRefresh, onError), { initialProps: { id: taskId, tickValue: tick } });
  return { ...view, emitter, onRefresh, onError };
};

beforeEach(() => {
  for (const mock of [get, events, worktree, probe, vi.mocked(archiveTask), vi.mocked(unarchiveTask), vi.mocked(cancelTask), vi.mocked(mergeTaskWorktree), vi.mocked(discardTaskWorktree), vi.mocked(retryTask), vi.mocked(continueTask)]) {
    mock.mockReset();
  }
  probe.mockResolvedValue(true);
  get.mockImplementation((id) => Promise.resolve(sharedDetail(id)));
  events.mockResolvedValue([]);
});

describe("retryPermission", () => {
  it("grants bypass only for the autonomous retry", () => {
    expect(retryPermission("autonomous")).toBe("bypassPermissions");
    expect(retryPermission("plain")).toBeNull();
  });
});

describe("useArchiveSupport", () => {
  it("starts optimistic and follows the probe result", async () => {
    probe.mockResolvedValue(false);
    const { result } = renderHook(() => useArchiveSupport());
    expect(result.current).toBe(true);
    await waitFor(() => expect(result.current).toBe(false));
  });
});

describe("useTaskDetail loading", () => {
  it("loads the task and its events", async () => {
    events.mockResolvedValue([makeEvent(1, "r1", "t1", "text", "hello")]);
    const { result } = setup();
    expect(result.current.detail).toBeNull();
    await waitFor(() => expect(result.current.detail?.task.id).toBe("t1"));
    expect(get).toHaveBeenCalledWith("t1");
    expect(events).toHaveBeenCalledWith("t1");
    expect(result.current.logLines).toEqual([{ key: "1", kind: "text", text: "hello" }]);
    expect(result.current.worktree).toBeNull();
    expect(worktree).not.toHaveBeenCalled();
    expect(result.current.archiveSupported).toBe(true);
  });

  it("fetches the worktree status for isolated tasks and tolerates its failure", async () => {
    get.mockResolvedValue(makeDetail(makeTaskRecord("t1", { isolation: "worktree" })));
    worktree.mockResolvedValue(makeWorktree());
    const first = setup();
    await waitFor(() => expect(first.result.current.worktree?.branch).toBe("task/t1"));
    first.unmount();
    worktree.mockRejectedValue(new Error("gone"));
    const second = setup();
    await waitFor(() => expect(second.result.current.detail).not.toBeNull());
    expect(second.result.current.worktree).toBeNull();
    expect(second.onError).not.toHaveBeenCalled();
  });

  it("reports a load failure through onError", async () => {
    get.mockRejectedValue(new Error("hub down"));
    const { onError } = setup();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("hub down"));
  });

  it("uses a generic message for non-Error load failures", async () => {
    get.mockRejectedValue("nope");
    const { onError } = setup();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("failed to load task"));
  });

  it("stays quiet when the failure arrives after unmount", async () => {
    let reject: (reason: unknown) => void = () => undefined;
    get.mockReturnValue(new Promise((_, fail) => {
      reject = fail;
    }));
    const { unmount, onError } = setup();
    unmount();
    reject(new Error("late"));
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reloads when the tick changes", async () => {
    const { rerender, result } = setup("t1", 0);
    await waitFor(() => expect(result.current.detail).not.toBeNull());
    rerender({ id: "t1", tickValue: 1 });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("clears the previous task while loading another and drops the stale response", async () => {
    let finishFirst: (detail: TaskDetail) => void = () => undefined;
    get.mockImplementationOnce(() => new Promise<TaskDetail>((done) => {
      finishFirst = done;
    }));
    const { rerender, result } = setup("t1");
    rerender({ id: "t2", tickValue: 0 });
    await waitFor(() => expect(result.current.detail?.task.id).toBe("t2"));
    await act(async () => {
      finishFirst(sharedDetail("t1"));
      await Promise.resolve();
    });
    expect(result.current.detail?.task.id).toBe("t2");
  });

  it("drops a response that became stale while the worktree status was loading", async () => {
    let finishWorktree: (info: ReturnType<typeof makeWorktree>) => void = () => undefined;
    get.mockImplementation((id) => Promise.resolve(makeDetail(makeTaskRecord(id, { isolation: "worktree" }))));
    worktree.mockImplementationOnce(() => new Promise((done) => {
      finishWorktree = done;
    }));
    const { rerender, result } = setup("t1");
    await waitFor(() => expect(worktree).toHaveBeenCalledTimes(1));
    worktree.mockResolvedValue(makeWorktree({ branch: "task/t2" }));
    rerender({ id: "t2", tickValue: 0 });
    await waitFor(() => expect(result.current.worktree?.branch).toBe("task/t2"));
    await act(async () => {
      finishWorktree(makeWorktree({ branch: "task/t1" }));
      await Promise.resolve();
    });
    expect(result.current.detail?.task.id).toBe("t2");
    expect(result.current.worktree?.branch).toBe("task/t2");
  });
});

describe("useTaskDetail live output", () => {
  it("appends streamed events of this task, merging consecutive text and ignoring other tasks", async () => {
    const { result, emitter } = setup();
    await waitFor(() => expect(result.current.detail).not.toBeNull());
    act(() => {
      emitter.emit({ taskId: "other", runId: "r1", kind: "text", text: "ignored" });
      emitter.emit({ taskId: "t1", runId: "r1", kind: "text", text: "hel" });
      emitter.emit({ taskId: "t1", runId: "r1", kind: "text", text: "lo" });
      emitter.emit({ taskId: "t1", runId: "r1", kind: "tool", text: "Read" });
      emitter.emit({ taskId: "t1", runId: "r1", kind: "text", text: "again" });
    });
    expect(result.current.logLines.map((item) => [item.kind, item.text])).toEqual([
      ["text", "hello"],
      ["tool", "Read"],
      ["text", "again"],
    ]);
    expect(result.current.logLines[0]?.key).toBe("r1-0");
  });

  it("starts a fresh buffer when a new run begins and shows nothing for a run that is not the latest", async () => {
    const { result, emitter } = setup();
    await waitFor(() => expect(result.current.detail).not.toBeNull());
    act(() => emitter.emit({ taskId: "t1", runId: "r1", kind: "text", text: "first" }));
    act(() => emitter.emit({ taskId: "t1", runId: "rX", kind: "text", text: "other run" }));
    expect(result.current.logLines).toEqual([]);
    act(() => emitter.emit({ taskId: "t1", runId: "r1", kind: "text", text: "back" }));
    expect(result.current.logLines.map((item) => item.text)).toEqual(["back"]);
  });

  it("falls back to the persisted events of the latest run and none without runs", async () => {
    get.mockResolvedValue(makeDetail(makeTaskRecord("t1"), { runs: [makeRun("r1", "t1"), makeRun("r2", "t1", { seq: 2 })] }));
    events.mockResolvedValue([makeEvent(1, "r1", "t1", "text", "old"), makeEvent(2, "r2", "t1", "status", "new")]);
    const first = setup();
    await waitFor(() => expect(first.result.current.logLines).toEqual([{ key: "2", kind: "status", text: "new" }]));
    first.unmount();
    get.mockResolvedValue(makeDetail(makeTaskRecord("t1")));
    const second = setup();
    await waitFor(() => expect(second.result.current.detail).not.toBeNull());
    expect(second.result.current.logLines).toEqual([]);
  });

  it("unsubscribes on unmount", async () => {
    const { unmount, emitter } = setup();
    expect(emitter.count()).toBe(1);
    unmount();
    expect(emitter.count()).toBe(0);
    await Promise.resolve();
  });
});

describe("useTaskDetail actions", () => {
  const ready = async () => {
    const view = setup();
    await waitFor(() => expect(view.result.current.detail).not.toBeNull());
    get.mockClear();
    return view;
  };

  it.each([
    ["archive", archiveTask, (state: ReturnType<typeof setup>["result"]["current"]) => state.archive(), ["t1"]],
    ["unarchive", unarchiveTask, (state: ReturnType<typeof setup>["result"]["current"]) => state.unarchive(), ["t1"]],
    ["merge", mergeTaskWorktree, (state: ReturnType<typeof setup>["result"]["current"]) => state.merge(), ["t1"]],
    ["discard", discardTaskWorktree, (state: ReturnType<typeof setup>["result"]["current"]) => state.discard(), ["t1"]],
  ])("%s calls the API, refreshes the list and reloads the task", async (_name, api, run, args) => {
    vi.mocked(api).mockResolvedValue(undefined);
    const { result, onRefresh } = await ready();
    act(() => run(result.current));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledWith(...args);
    await waitFor(() => expect(get).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("cancels the task", async () => {
    vi.mocked(cancelTask).mockResolvedValue({ ok: true });
    const { result, onRefresh } = await ready();
    act(() => result.current.cancel());
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(cancelTask).toHaveBeenCalledWith("t1");
  });

  it("retries with the permission of the chosen mode", async () => {
    vi.mocked(retryTask).mockResolvedValue(undefined);
    const { result } = await ready();
    act(() => result.current.retry("autonomous"));
    await waitFor(() => expect(retryTask).toHaveBeenCalledWith("t1", "bypassPermissions"));
    await waitFor(() => expect(result.current.busy).toBe(false));
    act(() => result.current.retry("plain"));
    await waitFor(() => expect(retryTask).toHaveBeenLastCalledWith("t1", null));
  });

  it("is busy while an action runs", async () => {
    let finish: () => void = () => undefined;
    vi.mocked(archiveTask).mockReturnValue(new Promise<void>((done) => {
      finish = done;
    }));
    const { result } = await ready();
    act(() => result.current.archive());
    await waitFor(() => expect(result.current.busy).toBe(true));
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("sends a follow-up and reports success", async () => {
    vi.mocked(continueTask).mockResolvedValue(sharedDetail());
    const { result } = await ready();
    let ok = false;
    await act(async () => {
      ok = await result.current.sendContinue("keep going");
    });
    expect(ok).toBe(true);
    expect(continueTask).toHaveBeenCalledWith("t1", { prompt: "keep going" });
  });

  it("reports an action failure through onError and returns false from a follow-up", async () => {
    vi.mocked(continueTask).mockRejectedValue(new Error("refused"));
    vi.mocked(archiveTask).mockRejectedValue("weird");
    const { result, onError, onRefresh } = await ready();
    let ok = true;
    await act(async () => {
      ok = await result.current.sendContinue("x");
    });
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith("refused");
    act(() => result.current.archive());
    await waitFor(() => expect(onError).toHaveBeenCalledWith("action failed"));
    expect(onRefresh).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.busy).toBe(false));
  });
});
