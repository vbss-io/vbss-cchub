import { afterEach, expect, test } from "vitest";
import { hubBase } from "./api";
import { fetchForecast, fetchHealthReport, runFix } from "./ops-api";
import { json, stubFetch, type FetchStub } from "./test-support/u5-fetch";

let stub: FetchStub;

afterEach(() => {
  stub.restore();
});

test("fetchForecast and fetchHealthReport read the delegation ops endpoints", async () => {
  stub = stubFetch(() => json({ checkedAt: 1 }));
  await expect(fetchForecast()).resolves.toEqual({ checkedAt: 1 });
  expect(stub.last()).toMatchObject({ method: "GET", url: `${hubBase}/delegation/limits/forecast` });
  await expect(fetchHealthReport()).resolves.toEqual({ checkedAt: 1 });
  expect(stub.last()).toMatchObject({ method: "GET", url: `${hubBase}/delegation/health` });
});

test("runFix posts the plan with its body, or without a body when the plan has none", async () => {
  stub = stubFetch(() => json({ ok: true }));
  await expect(runFix({ kind: "api", label: "Fix", method: "POST", path: "/delegation/hooks/install", body: { client: "claude" } })).resolves.toBeUndefined();
  expect(stub.last()).toMatchObject({ method: "POST", url: `${hubBase}/delegation/hooks/install`, body: { client: "claude" } });
  await runFix({ kind: "api", label: "Fix", method: "POST", path: "/delegation/x", body: null });
  expect(stub.last()).toMatchObject({ url: `${hubBase}/delegation/x`, body: undefined, headers: undefined });
});

test("runFix rejects with the hub error message", async () => {
  stub = stubFetch(() => json({ error: "cannot fix" }, 500));
  await expect(runFix({ kind: "api", label: "Fix", method: "POST", path: "/p", body: null })).rejects.toThrow("cannot fix");
});
