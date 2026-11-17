import { afterEach, expect, test } from "vitest";
import { hubBase } from "./api";
import { errorText, HubRequestError, hubRequest } from "./hub-request";
import { json, stubFetch, type FetchStub } from "./test-support/u5-fetch";

let stub: FetchStub;

afterEach(() => {
  stub.restore();
});

test("hubRequest sends a bodyless GET without headers and returns the parsed JSON", async () => {
  stub = stubFetch(() => json({ a: 1 }));
  await expect(hubRequest<{ a: number }>("GET", "/x/y")).resolves.toEqual({ a: 1 });
  expect(stub.last()).toMatchObject({ url: `${hubBase}/x/y`, method: "GET", headers: undefined, body: undefined });
});

test("hubRequest sends the body as JSON with a content-type header and forwards the abort signal", async () => {
  stub = stubFetch(() => json({ ok: true }));
  const controller = new AbortController();
  await hubRequest("POST", "/save", { n: 2 }, controller.signal);
  const sent = stub.last();
  expect(sent.method).toBe("POST");
  expect(sent.headers).toEqual({ "content-type": "application/json" });
  expect(sent.body).toEqual({ n: 2 });
  expect(sent.signal).toBe(controller.signal);
});

test("hubRequest returns null for an empty or non-JSON success body", async () => {
  stub = stubFetch(() => ({ status: 200, text: "" }));
  await expect(hubRequest("GET", "/empty")).resolves.toBeNull();
  stub.restore();
  stub = stubFetch(() => ({ status: 200, text: "<html>" }));
  await expect(hubRequest("GET", "/html")).resolves.toBeNull();
});

test("hubRequest throws HubRequestError carrying the server message, status and body", async () => {
  stub = stubFetch(() => json({ error: "busy", detail: 7 }, 409));
  const error = await hubRequest("POST", "/lock").catch((err: unknown) => err);
  expect(error).toBeInstanceOf(HubRequestError);
  expect(error).toMatchObject({ message: "busy", status: 409, body: { error: "busy", detail: 7 } });
});

test("hubRequest falls back to the status when the error body has no message or is not JSON", async () => {
  stub = stubFetch(() => ({ status: 500, text: "boom" }));
  await expect(hubRequest("GET", "/a")).rejects.toMatchObject({ message: "request failed (500)", status: 500, body: null });
  stub.restore();
  stub = stubFetch(() => json({ other: true }, 400));
  await expect(hubRequest("GET", "/b")).rejects.toMatchObject({ message: "request failed (400)", body: { other: true } });
});

test("hubRequest lets a network failure propagate", async () => {
  stub = stubFetch(() => new Error("offline"));
  await expect(hubRequest("GET", "/c")).rejects.toThrow("offline");
});

test("errorText returns the error message, or the fallback for empty messages and non-errors", () => {
  expect(errorText(new Error("bad"), "fallback")).toBe("bad");
  expect(errorText(new Error(""), "fallback")).toBe("fallback");
  expect(errorText("string", "fallback")).toBe("fallback");
  expect(errorText(null, "fallback")).toBe("fallback");
});
