import { afterEach, expect, test } from "vitest";
import { hubBase } from "./api";
import * as memory from "./memory-api";
import { json, stubFetch, type FetchStub } from "./test-support/u5-fetch";

let stub: FetchStub;
const root = `${hubBase}/delegation/memory`;

afterEach(() => {
  stub.restore();
});

test("every memory endpoint uses the delegation/memory base with the right method and body", async () => {
  stub = stubFetch(() => json({ ok: true }));
  const cases: [() => Promise<unknown>, string, string, unknown][] = [
    [() => memory.fetchHistoryStatus(), "GET", "/history/status", undefined],
    [() => memory.searchHistory("q=a&limit=5"), "GET", "/history/search?q=a&limit=5", undefined],
    [() => memory.runHistoryIndex(), "POST", "/history/run", undefined],
    [() => memory.rebuildHistoryIndex(), "POST", "/history/rebuild", undefined],
    [() => memory.clearHistoryIndex(), "DELETE", "/history", undefined],
    [() => memory.fetchHandoffPreview("my ws"), "GET", "/handoff/preview?workspace=my%20ws", undefined],
    [() => memory.setHandoffWorkspace("a/b", true), "PUT", "/handoff/workspaces/a%2Fb", { enabled: true }],
    [() => memory.fetchDaySummary("2026-11-16"), "GET", "/day-summary?date=2026-11-16", undefined],
    [() => memory.writeDaySummary("2026-11-16", "digest", 5, "w1"), "POST", "/day-summary/write", { date: "2026-11-16", digest: "digest", writeId: "w1", baseUpdatedAt: 5 }],
    [() => memory.writeDaySummary("2026-11-16", "digest", null, "w2"), "POST", "/day-summary/write", { date: "2026-11-16", digest: "digest", writeId: "w2" }],
  ];
  for (const [call, method, path, body] of cases) {
    await expect(call()).resolves.toEqual({ ok: true });
    const sent = stub.last();
    expect(sent.url).toBe(`${root}${path}`);
    expect(sent.method).toBe(method);
    expect(sent.body).toEqual(body);
    expect(sent.headers).toEqual(body === undefined ? undefined : { "content-type": "application/json" });
  }
});

test("searchHistory forwards the abort signal", async () => {
  stub = stubFetch(() => json({}));
  const controller = new AbortController();
  await memory.searchHistory("q=x", controller.signal);
  expect(stub.last().signal).toBe(controller.signal);
});

test("a non-2xx answer throws MemoryApiError with message, status and body", async () => {
  stub = stubFetch(() => json({ error: "index busy" }, 409));
  const error = await memory.runHistoryIndex().catch((err: unknown) => err);
  expect(error).toBeInstanceOf(memory.MemoryApiError);
  expect(error).toMatchObject({ message: "index busy", status: 409, body: { error: "index busy" } });
});

test("a non-2xx answer without a message falls back to the status, and empty success bodies resolve to null", async () => {
  stub = stubFetch(() => ({ status: 503, text: "not json" }));
  await expect(memory.fetchHistoryStatus()).rejects.toMatchObject({ message: "request failed (503)", status: 503, body: null });
  stub.restore();
  stub = stubFetch(() => ({ status: 200, text: "" }));
  await expect(memory.fetchHistoryStatus()).resolves.toBeNull();
  stub.restore();
  stub = stubFetch(() => ({ status: 200, text: "{broken" }));
  await expect(memory.fetchHistoryStatus()).resolves.toBeNull();
});

test("a network failure propagates", async () => {
  stub = stubFetch(() => new Error("offline"));
  await expect(memory.clearHistoryIndex()).rejects.toThrow("offline");
});
