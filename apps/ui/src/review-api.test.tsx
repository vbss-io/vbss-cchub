import { afterEach, expect, test } from "vitest";
import { hubBase } from "./api";
import { HubRequestError } from "./hub-request";
import { fetchDiff, fetchGh, fetchTaskCost, fetchTaskCosts, isBusyError, sendReview } from "./review-api";
import { json, stubFetch, type FetchStub } from "./test-support/u5-fetch";
import type { ReviewComment } from "./types";

let stub: FetchStub;

afterEach(() => {
  stub.restore();
});

test("fetchDiff targets the task or session diff and builds the query from runId and file", async () => {
  stub = stubFetch(() => json({ files: [] }));
  await fetchDiff({ kind: "task", id: "t/1" });
  expect(stub.last()).toMatchObject({ method: "GET", url: `${hubBase}/delegation/tasks/t%2F1/diff` });
  await fetchDiff({ kind: "session", id: "s1" }, { runId: "r1", file: "src/a b.ts" });
  expect(stub.last().url).toBe(`${hubBase}/delegation/sessions/s1/diff?runId=r1&file=src%2Fa+b.ts`);
  await fetchDiff({ kind: "session", id: "s1" }, { file: "x" });
  expect(stub.last().url).toBe(`${hubBase}/delegation/sessions/s1/diff?file=x`);
});

test("fetchDiff and fetchGh forward the abort signal", async () => {
  stub = stubFetch(() => json({}));
  const controller = new AbortController();
  await fetchDiff({ kind: "task", id: "t1" }, {}, controller.signal);
  expect(stub.last().signal).toBe(controller.signal);
  await fetchGh({ kind: "task", id: "t1" }, controller.signal);
  expect(stub.last()).toMatchObject({ method: "GET", url: `${hubBase}/delegation/tasks/t1/gh`, signal: controller.signal });
});

test("sendReview posts the comments to the review endpoint", async () => {
  stub = stubFetch(() => json({ sent: true }));
  const comments = [{ file: "a.ts", line: 3, text: "fix" }] as unknown as ReviewComment[];
  await expect(sendReview({ kind: "session", id: "s 1" }, comments)).resolves.toEqual({ sent: true });
  expect(stub.last()).toMatchObject({ method: "POST", url: `${hubBase}/delegation/sessions/s%201/review`, body: { comments } });
});

test("isBusyError is true only for a 409 HubRequestError", () => {
  expect(isBusyError(new HubRequestError("busy", 409, null))).toBe(true);
  expect(isBusyError(new HubRequestError("other", 500, null))).toBe(false);
  expect(isBusyError(new Error("busy"))).toBe(false);
});

test("fetchTaskCosts skips the request for no ids and unwraps the tasks map otherwise", async () => {
  stub = stubFetch(() => json({ tasks: { "a/b": { total: 1 }, c: { total: 2 } } }));
  await expect(fetchTaskCosts([])).resolves.toEqual({});
  expect(stub.calls).toHaveLength(0);
  await expect(fetchTaskCosts(["a/b", "c"])).resolves.toEqual({ "a/b": { total: 1 }, c: { total: 2 } });
  expect(stub.last().url).toBe(`${hubBase}/delegation/costs?taskIds=a%2Fb,c`);
});

test("fetchTaskCost reads the per-task cost", async () => {
  stub = stubFetch(() => json({ total: 9 }));
  await expect(fetchTaskCost("t 1")).resolves.toEqual({ total: 9 });
  expect(stub.last()).toMatchObject({ method: "GET", url: `${hubBase}/delegation/tasks/t%201/cost` });
});
