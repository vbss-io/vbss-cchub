import { afterEach, expect, test } from "vitest";
import { hubBase } from "./api";
import * as routines from "./routines-api";
import { json, stubFetch, type FetchStub } from "./test-support/u5-fetch";
import type { RoutineInput, RoutineSchedule, RoutineSettings } from "./types";

let stub: FetchStub;
const root = `${hubBase}/delegation/routines`;

afterEach(() => {
  stub.restore();
});

test("routine CRUD calls use the right method, URL and body", async () => {
  stub = stubFetch(() => json({ id: "r1" }));
  const input = { name: "Daily" } as unknown as RoutineInput;
  const cases: [() => Promise<unknown>, string, string, unknown][] = [
    [() => routines.fetchRoutines(), "GET", "", undefined],
    [() => routines.fetchRoutineDetail("r/1"), "GET", "/r%2F1", undefined],
    [() => routines.createRoutine(input), "POST", "", input],
    [() => routines.updateRoutine("r1", { name: "New" }), "PATCH", "/r1", { name: "New" }],
    [() => routines.setRoutineEnabled("r1", false), "PATCH", "/r1", { enabled: false }],
    [() => routines.deleteRoutine("r1"), "DELETE", "/r1", undefined],
    [() => routines.runRoutineNow("r1"), "POST", "/r1/run", undefined],
    [() => routines.fetchRoutineSettings(), "GET", "/settings", undefined],
  ];
  for (const [call, method, path, body] of cases) {
    await expect(call()).resolves.toEqual({ id: "r1" });
    const sent = stub.last();
    expect(sent.url).toBe(`${root}${path}`);
    expect(sent.method).toBe(method);
    expect(sent.body).toEqual(body);
  }
});

test("previewSchedule posts the schedule and saveRoutineSettings puts the settings", async () => {
  stub = stubFetch(() => json({ next: [1, 2] }));
  const schedule = { kind: "daily", time: "09:00" } as unknown as RoutineSchedule;
  await expect(routines.previewSchedule(schedule)).resolves.toEqual({ next: [1, 2] });
  expect(stub.last()).toMatchObject({ method: "POST", url: `${root}/schedule/preview`, body: { schedule } });
  const settings = { retentionDays: 7 } as unknown as RoutineSettings;
  await routines.saveRoutineSettings(settings);
  expect(stub.last()).toMatchObject({ method: "PUT", url: `${root}/settings`, body: settings });
});

test("inbox endpoints build the unread filter and the per-item actions", async () => {
  stub = stubFetch(() => json({ items: [], unread: 3 }));
  await routines.fetchInbox(false);
  expect(stub.last().url).toBe(`${root}/inbox?limit=50`);
  await routines.fetchInbox(true, 10);
  expect(stub.last().url).toBe(`${root}/inbox?unread=1&limit=10`);
  await expect(routines.fetchUnreadCount()).resolves.toBe(3);
  expect(stub.last().url).toBe(`${root}/inbox?unread=1&limit=1`);
  await routines.markInboxRead("i/1");
  expect(stub.last()).toMatchObject({ method: "POST", url: `${root}/inbox/i%2F1/read` });
  await routines.markInboxUnread("i1");
  expect(stub.last()).toMatchObject({ method: "POST", url: `${root}/inbox/i1/unread` });
  await routines.markInboxAllRead();
  expect(stub.last()).toMatchObject({ method: "POST", url: `${root}/inbox/read-all` });
});

test("a failing routines call rejects with the server message", async () => {
  stub = stubFetch(() => json({ error: "invalid schedule" }, 400));
  await expect(routines.createRoutine({} as RoutineInput)).rejects.toThrow("invalid schedule");
});
