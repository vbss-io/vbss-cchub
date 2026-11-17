import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubtaskQueue } from "./subtask-queue";

describe("createSubtaskQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the writes one at a time in request order and drains once", async () => {
    const sent: string[] = [];
    const onDrained = vi.fn();
    const queue = createSubtaskQueue({ send: async (id, planned) => void sent.push(`${id}:${planned}`), onFailed: vi.fn(), onDrained }, 50);
    queue.request("b", true, false);
    queue.request("a", true, false);
    queue.request("c", false, true);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent).toEqual(["b:true", "a:true", "c:false"]);
    expect(onDrained).toHaveBeenCalledTimes(1);
  });

  it("collapses a double request into no write and does not drain", async () => {
    const send = vi.fn(async () => undefined);
    const onDrained = vi.fn();
    const queue = createSubtaskQueue({ send, onFailed: vi.fn(), onDrained }, 50);
    queue.request("a", true, false);
    queue.request("a", false, false);
    await vi.advanceTimersByTimeAsync(50);
    expect(send).not.toHaveBeenCalled();
    expect(onDrained).not.toHaveBeenCalled();
  });

  it("reports a failure, goes back to the known state and keeps going", async () => {
    const sent: string[] = [];
    const onFailed = vi.fn();
    const onDrained = vi.fn();
    const queue = createSubtaskQueue(
      {
        send: async (id) => {
          if (id === "a") throw new Error("boom");
          sent.push(id);
        },
        onFailed,
        onDrained,
      },
      0,
    );
    queue.request("a", true, false);
    queue.request("b", true, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(onFailed).toHaveBeenCalledWith("a", expect.any(Error));
    expect(sent).toEqual(["b"]);
    expect(onDrained).toHaveBeenCalledTimes(1);
  });

  it("starts a new run for requests made after a drain", async () => {
    const send = vi.fn(async () => undefined);
    const onDrained = vi.fn();
    const queue = createSubtaskQueue({ send, onFailed: vi.fn(), onDrained }, 0);
    queue.request("a", true, false);
    await vi.advanceTimersByTimeAsync(0);
    queue.request("a", false, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onDrained).toHaveBeenCalledTimes(2);
  });
});
