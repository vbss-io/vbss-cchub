import { beforeEach, expect, test, vi } from "vitest";
import type { NotifEventConfig } from "./notifications";

const notifyMock = vi.hoisted(() => ({ notify: vi.fn(async () => "none"), playSound: vi.fn(async () => undefined) }));

vi.mock("./notify", () => notifyMock);

import { DEFAULT_NOTIF_EVENTS, firedEvents, loadNotifEventConfig, notifyEvent, resetFired, setNotifConfig } from "./notifications";

const config = (overrides: Partial<NotifEventConfig> = {}): NotifEventConfig => ({
  enabled: true,
  desktop: true,
  sound: true,
  style: "both",
  events: { ...DEFAULT_NOTIF_EVENTS },
  ...overrides,
});

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let hubAccepts = true;

const posted = (path: string): unknown[] =>
  fetchMock.mock.calls.filter(([url]) => url.endsWith(path)).map(([, init]) => JSON.parse(String(init?.body ?? "null")) as unknown);

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 40));

beforeEach(() => {
  fetchMock.mockReset();
  hubAccepts = true;
  fetchMock.mockImplementation(async (url) => {
    if (url.endsWith("/api/notify")) {
      if (!hubAccepts) throw new Error("hub offline");
      return new Response(JSON.stringify({ ok: true, via: "windows-toast", reason: null }));
    }
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetchMock);
  notifyMock.notify.mockClear();
  notifyMock.playSound.mockClear();
  resetFired();
  localStorage.clear();
});

test("loadNotifEventConfig returns the defaults when nothing is stored", () => {
  expect(loadNotifEventConfig()).toEqual({ enabled: true, desktop: true, sound: true, style: "cchub", events: { ...DEFAULT_NOTIF_EVENTS } });
});

test("loadNotifEventConfig merges stored values over the defaults", () => {
  localStorage.setItem("hub.notifications", JSON.stringify({ enabled: false, style: "windows", events: { taskFailed: false } }));
  const loaded = loadNotifEventConfig();
  expect(loaded.enabled).toBe(false);
  expect(loaded.desktop).toBe(true);
  expect(loaded.style).toBe("windows");
  expect(loaded.events.taskFailed).toBe(false);
  expect(loaded.events.sessionIdle).toBe(true);
});

test("loadNotifEventConfig falls back to the defaults on corrupt storage", () => {
  localStorage.setItem("hub.notifications", "{not json");
  expect(loadNotifEventConfig().style).toBe("cchub");
  expect(loadNotifEventConfig().events).toEqual(DEFAULT_NOTIF_EVENTS);
});

test("notifyEvent does nothing when the event is switched off", async () => {
  setNotifConfig(config({ events: { ...DEFAULT_NOTIF_EVENTS, sessionIdle: false } }));
  notifyEvent("sessionIdle", { id: "off-1", name: "x" });
  await flush();
  expect(notifyMock.playSound).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(firedEvents()).toEqual([]);
});

test("a native-tagged event is sent through the hub, toasted, played and recorded", async () => {
  setNotifConfig(config());
  notifyEvent("sessionNeedsYou", { id: "s-1", name: "api", detail: "approve?" });
  await flush();
  expect(posted("/api/notify")).toEqual([{ title: "Session needs you · api", body: "approve?", subject: { kind: "sessionNeedsYou", id: "s-1" } }]);
  expect(notifyMock.notify).not.toHaveBeenCalled();
  expect(notifyMock.playSound).toHaveBeenCalledWith("attention");
  const log = firedEvents();
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({ kind: "sessionNeedsYou", id: "s-1", body: "approve?" });
  await vi.waitFor(() => {
    expect(posted("/api/toast")).toEqual([expect.objectContaining({ kind: "sessionNeedsYou", id: "s-1", title: "Session needs you · api" })]);
    expect(posted("/api/ui/diag")).toEqual([expect.objectContaining({ window: "main", lastFired: "Session needs you · api" })]);
  });
});

test("a failing hub delivery falls back to the generic notify", async () => {
  setNotifConfig(config({ style: "windows", sound: false }));
  hubAccepts = false;
  notifyEvent("taskFailed", { id: "t-2", title: "Lint", detail: "x" });
  await flush();
  expect(notifyMock.notify).toHaveBeenCalledWith("Task failed · Lint", "x");
  expect(posted("/api/toast")).toEqual([]);
  expect(notifyMock.playSound).not.toHaveBeenCalled();
});

test("an untagged event skips the hub route and goes straight to notify", async () => {
  setNotifConfig(config({ style: "windows" }));
  notifyEvent("taskCompleted", { id: "t-3", title: "Docs", detail: "ok" });
  await flush();
  expect(posted("/api/notify")).toEqual([]);
  expect(notifyMock.notify).toHaveBeenCalledWith("Delegated task finished · Docs", "ok");
});

test("the fired log keeps only the latest fifty events", async () => {
  setNotifConfig(config({ desktop: false, sound: false }));
  for (let index = 0; index < 55; index += 1) notifyEvent("sessionFinished", { id: `log-${index}`, name: `n${index}` });
  const log = firedEvents();
  expect(log).toHaveLength(50);
  expect(log[0]?.id).toBe("log-5");
  expect(log[49]?.id).toBe("log-54");
  resetFired();
  expect(firedEvents()).toEqual([]);
});
