import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as api from "./api";
import { json, stubFetch, type FetchStub } from "./test-support/u5-fetch";

let stub: FetchStub;

const restub = (...args: Parameters<typeof stubFetch>): void => {
  stub.restore();
  stub = stubFetch(...args);
};

beforeEach(() => {
  stub = stubFetch(() => json({}));
});

afterEach(() => {
  stub.restore();
});

const base = api.hubBase;

test("hubBase is an http origin for the hub", () => {
  expect(base).toMatch(/^https?:\/\/[^/]+$/);
});

test("fetchHealth reads /api/health and rejects with the status on a non-2xx answer", async () => {
  restub(() => json({ ok: true, hostname: "pc" }));
  await expect(api.fetchHealth()).resolves.toEqual({ ok: true, hostname: "pc" });
  expect(stub.last()).toMatchObject({ url: `${base}/api/health`, method: "GET" });
  restub(() => json({}, 503));
  await expect(api.fetchHealth()).rejects.toThrow("/api/health failed (503)");
});

test("probeHealth is true for ok, false for non-2xx and false when the network throws", async () => {
  await expect(api.probeHealth()).resolves.toBe(true);
  expect(stub.last().signal).toBeInstanceOf(AbortSignal);
  restub(() => json({}, 500));
  await expect(api.probeHealth()).resolves.toBe(false);
  restub(() => new Error("offline"));
  await expect(api.probeHealth()).resolves.toBe(false);
});

test("read endpoints build the expected URL and return the parsed body", async () => {
  const cases: [() => Promise<unknown>, string][] = [
    [() => api.fetchSessions(), "/api/sessions"],
    [() => api.fetchRuntimes(), "/api/runtimes"],
    [() => api.fetchCodexSessions(), "/api/codex/sessions"],
    [() => api.fetchCodexLive("a/b"), "/api/codex/a%2Fb/live?limit=40"],
    [() => api.fetchCodexLive("x", 5), "/api/codex/x/live?limit=5"],
    [() => api.fetchAgents("s 1"), "/api/sessions/s%201/agents"],
    [() => api.fetchSessionLive("s1"), "/api/sessions/s1/live?limit=40"],
    [() => api.fetchSessionLiveSummary("s1", 9), "/api/sessions/s1/live?limit=9&subagents=summary"],
    [() => api.fetchSubagentLive("s1", "a/1"), "/api/sessions/s1/live?subagent=a%2F1"],
    [() => api.getHooks(), "/api/hooks"],
    [() => api.fetchPermissions(), "/api/permissions"],
    [() => api.fetchGroups(), "/api/groups"],
    [() => api.fetchClaims(), "/api/claims"],
    [() => api.fetchClaims("C:/repo x"), "/api/claims?repoPath=C%3A%2Frepo%20x"],
    [() => api.fetchSessionAsks("s1"), "/api/sessions/s1/asks"],
  ];
  for (const [call, path] of cases) {
    stub.calls.length = 0;
    await expect(call()).resolves.toEqual({});
    expect(stub.last()).toMatchObject({ url: `${base}${path}`, method: "GET", body: undefined });
  }
});

test("mutating endpoints send the right method, URL and JSON body", async () => {
  const cases: [() => Promise<unknown>, string, string, unknown][] = [
    [() => api.renameCodexThread("c/1", "New"), "PATCH", "/api/codex/c%2F1", { title: "New" }],
    [() => api.archiveCodexThread("c1"), "POST", "/api/codex/c1/archive", undefined],
    [() => api.unarchiveCodexThread("c1"), "POST", "/api/codex/c1/unarchive", undefined],
    [() => api.deleteCodexThread("c1"), "DELETE", "/api/codex/c1", undefined],
    [() => api.setHooks(true), "POST", "/api/hooks/install", undefined],
    [() => api.setHooks(false), "POST", "/api/hooks/uninstall", undefined],
    [() => api.focusSession("s 1"), "POST", "/api/sessions/s%201/focus", undefined],
    [() => api.focusCodexApp(), "POST", "/api/codex/focus", undefined],
    [() => api.archiveSession("s1"), "POST", "/api/sessions/s1/archive", undefined],
    [() => api.setSessionFavorite("s1", true), "POST", "/api/sessions/s1/favorite", { favorite: true }],
    [() => api.deleteSession("s1"), "DELETE", "/api/sessions/s1", undefined],
    [() => api.renameSession("s1", "T"), "PATCH", "/api/sessions/s1", { title: "T" }],
    [() => api.createGroup("G", "repo"), "POST", "/api/groups", { name: "G", match: "repo" }],
    [() => api.updateGroup("g/1", { name: "H" }), "PATCH", "/api/groups/g%2F1", { name: "H" }],
    [() => api.deleteGroup("g1"), "DELETE", "/api/groups/g1", undefined],
    [() => api.reorderGroups(["a", "b"]), "POST", "/api/groups/reorder", { ids: ["a", "b"] }],
    [() => api.releaseClaim("c1"), "DELETE", "/api/claims/c1", undefined],
    [() => api.getDesktopNotifyStatus(), "GET", "/api/notify/status", undefined],
    [() => api.getDesktopNotifyStatus(true), "GET", "/api/notify/status?force=1", undefined],
  ];
  for (const [call, method, path, body] of cases) {
    stub.calls.length = 0;
    await call();
    const sent = stub.last();
    expect(sent.url).toBe(`${base}${path}`);
    expect(sent.method).toBe(method);
    expect(sent.body).toEqual(body);
    expect(sent.headers).toEqual(body === undefined ? undefined : { "content-type": "application/json" });
  }
});

test("send surfaces the server error, falls back to the status and rejects a malformed success", async () => {
  restub(() => json({ error: "nope" }, 400));
  await expect(api.archiveSession("s1")).rejects.toThrow("nope");
  restub(() => ({ status: 500, text: "" }));
  await expect(api.archiveSession("s1")).rejects.toThrow("/api/sessions/s1/archive failed (500)");
  restub(() => ({ status: 200, text: "" }));
  await expect(api.archiveSession("s1")).resolves.toBeNull();
  restub(() => ({ status: 200, text: "{bad" }));
  await expect(api.archiveSession("s1")).rejects.toThrow();
});

test("markSessionSeen swallows both success and failure", async () => {
  await expect(api.markSessionSeen("s1")).resolves.toBeUndefined();
  expect(stub.last()).toMatchObject({ method: "POST", url: `${base}/api/sessions/s1/seen` });
  restub(() => new Error("down"));
  await expect(api.markSessionSeen("s1")).resolves.toBeUndefined();
});

test("openSession and openCodexSession normalise the hub answer", async () => {
  restub(() => json({ ok: true, method: "url", url: "vscode://x", reason: "r", focused: false }));
  await expect(api.openSession("s 1")).resolves.toEqual({ ok: true, method: "url", url: "vscode://x", reason: "r", focused: false });
  expect(stub.last()).toMatchObject({ method: "POST", url: `${base}/api/sessions/s%201/open` });
  restub(() => json({ ok: false }));
  await expect(api.openCodexSession("c1")).resolves.toEqual({ ok: false, method: "focus" });
  expect(stub.last().url).toBe(`${base}/api/codex/c1/open`);
  restub(() => json({ error: "boom" }, 500));
  await expect(api.openSession("s1")).resolves.toEqual({ ok: false, method: "focus", reason: "boom" });
  restub(() => ({ status: 502, text: "<html>" }));
  await expect(api.openSession("s1")).resolves.toEqual({ ok: false, method: "focus", reason: "request failed (502)" });
  restub(() => ({ status: 502, text: "" }));
  await expect(api.openSession("s1")).resolves.toMatchObject({ ok: false, reason: "request failed (502)" });
});

test("decidePermission posts the decision and maps 404 to gone, 2xx to done and errors to throws", async () => {
  await expect(api.decidePermission("p/1", { behavior: "allow", answers: { q: "a" } })).resolves.toBe("done");
  expect(stub.last()).toMatchObject({ method: "POST", url: `${base}/api/permissions/p%2F1/decision`, body: { behavior: "allow", answers: { q: "a" } } });
  expect(stub.last().headers).toEqual({ "content-type": "application/json" });
  restub(() => ({ status: 404 }));
  await expect(api.decidePermission("p1", { behavior: "deny", message: "no" })).resolves.toBe("gone");
  restub(() => json({ error: "bad state" }, 409));
  await expect(api.decidePermission("p1", { behavior: "deny" })).rejects.toThrow("bad state");
  restub(() => ({ status: 500, text: "oops" }));
  await expect(api.decidePermission("p1", { behavior: "deny" })).rejects.toThrow("decision failed (500)");
});

test("releasePermission posts to /release with the same outcome mapping", async () => {
  await expect(api.releasePermission("p1")).resolves.toBe("done");
  expect(stub.last()).toMatchObject({ method: "POST", url: `${base}/api/permissions/p1/release`, body: undefined });
  restub(() => ({ status: 404 }));
  await expect(api.releasePermission("p1")).resolves.toBe("gone");
  restub(() => ({ status: 500 }));
  await expect(api.releasePermission("p1")).rejects.toThrow("release failed (500)");
});

test("sendDesktopNotification posts the title, body and optional subject", async () => {
  restub(() => json({ ok: true, via: "windows-toast", reason: null }));
  await expect(api.sendDesktopNotification("T", "B")).resolves.toEqual({ ok: true, via: "windows-toast", reason: null });
  expect(stub.last()).toMatchObject({ method: "POST", url: `${base}/api/notify`, body: { title: "T", body: "B" } });
  const subject = { kind: "session", id: "s1" } as unknown as Parameters<typeof api.sendDesktopNotification>[2];
  await api.sendDesktopNotification("T", "B", subject);
  expect(stub.last().body).toEqual({ title: "T", body: "B", subject });
});

test("fire-and-forget posts hit the right URL and never reject", async () => {
  const card = { kind: "done", id: "t1", title: "x", body: "y" } as unknown as Parameters<typeof api.sendToast>[0];
  await api.sendToast(card);
  expect(stub.last()).toMatchObject({ method: "POST", url: `${base}/api/toast`, body: { id: "t1", title: "x", body: "y" } });
  await api.reportUiDiag({ a: 1 });
  expect(stub.last()).toMatchObject({ url: `${base}/api/ui/diag`, body: { a: 1 } });
  await api.requestNavigate("#/board");
  expect(stub.last()).toMatchObject({ url: `${base}/api/ui/navigate`, body: { hash: "#/board" } });
  const error = new Error("kaboom");
  await api.reportUiError("board", error, "stack-of-components");
  expect(stub.last()).toMatchObject({ url: `${base}/api/ui-error`, body: { view: "board", message: "kaboom", stack: error.stack, componentStack: "stack-of-components" } });
  await api.reportUiError("board", Object.assign(new Error("m"), { stack: undefined }), null);
  expect(stub.last().body).toMatchObject({ stack: "", componentStack: "" });
  restub(() => new Error("down"));
  await expect(api.sendToast(card)).resolves.toBeUndefined();
  await expect(api.reportUiDiag({})).resolves.toBeUndefined();
  await expect(api.requestNavigate("#/x")).resolves.toBeUndefined();
  await expect(api.reportUiError("v", new Error("e"), null)).resolves.toBeUndefined();
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (event: Event) => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: Event) => void): void {
    this.listeners.set(name, listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(name: string, payload?: unknown): void {
    const listener = this.listeners.get(name);
    if (!listener) throw new Error(`no listener for ${name}`);
    listener(new MessageEvent(name, { data: JSON.stringify(payload ?? null) }));
  }
}

const openSource = (): FakeEventSource => {
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!source) throw new Error("no source");
  return source;
};

test("subscribe wires every event to its handler and closes the source on cleanup", () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  const handlers = {
    onOpen: vi.fn(),
    onError: vi.fn(),
    onSession: vi.fn(),
    onCodex: vi.fn(),
    onRemoved: vi.fn(),
    onGroups: vi.fn(),
    onHooks: vi.fn(),
    onDelegation: vi.fn(),
    onReport: vi.fn(),
    onRunEvent: vi.fn(),
    onShareRequest: vi.fn(),
    onTunnel: vi.fn(),
    onShareStream: vi.fn(),
    onNavigate: vi.fn(),
    onToast: vi.fn(),
    onPermissionRequest: vi.fn(),
    onPermissionResolved: vi.fn(),
    onClaims: vi.fn(),
    onDaily: vi.fn(),
    onTasksBoard: vi.fn(),
    onTrail: vi.fn(),
    onSettings: vi.fn(),
    onLimits: vi.fn(),
    onUsage: vi.fn(),
    onHistory: vi.fn(),
    onRoutines: vi.fn(),
    onRoutineRun: vi.fn(),
    onRoutinesInbox: vi.fn(),
    onUiPrefs: vi.fn(),
  };
  const close = api.subscribe(handlers);
  const source = openSource();
  expect(source.url).toBe(`${base}/api/events`);
  source.onopen?.();
  source.onerror?.();
  expect(handlers.onOpen).toHaveBeenCalledTimes(1);
  expect(handlers.onError).toHaveBeenCalledTimes(1);

  const payload = { x: 1 };
  const direct: [string, ReturnType<typeof vi.fn>][] = [
    ["session", handlers.onSession],
    ["codex", handlers.onCodex],
    ["groups", handlers.onGroups],
    ["hooks", handlers.onHooks],
    ["run-event", handlers.onRunEvent],
    ["share-request", handlers.onShareRequest],
    ["tunnel", handlers.onTunnel],
    ["share-stream", handlers.onShareStream],
    ["toast", handlers.onToast],
    ["permission-request", handlers.onPermissionRequest],
    ["permission-resolved", handlers.onPermissionResolved],
    ["claims", handlers.onClaims],
    ["daily", handlers.onDaily],
    ["tasks", handlers.onTasksBoard],
    ["trail", handlers.onTrail],
    ["settings", handlers.onSettings],
    ["history", handlers.onHistory],
    ["routine-run", handlers.onRoutineRun],
  ];
  for (const [name, handler] of direct) {
    source.emit(name, payload);
    expect(handler).toHaveBeenCalledWith(payload);
  }
  source.emit("removed", { sessionId: "s9" });
  expect(handlers.onRemoved).toHaveBeenCalledWith("s9");
  source.emit("delegation", { taskId: "t9" });
  expect(handlers.onDelegation).toHaveBeenCalledWith("t9");
  source.emit("ui-navigate", { hash: "#/today" });
  expect(handlers.onNavigate).toHaveBeenCalledWith("#/today");
  source.emit("routines-inbox", { unread: 4 });
  expect(handlers.onRoutinesInbox).toHaveBeenCalledWith(4);
  for (const name of ["report", "limits", "usage", "routines"]) source.emit(name);
  expect(handlers.onReport).toHaveBeenCalledTimes(1);
  expect(handlers.onLimits).toHaveBeenCalledTimes(1);
  expect(handlers.onUsage).toHaveBeenCalledTimes(1);
  expect(handlers.onRoutines).toHaveBeenCalledTimes(1);
  source.emit("ui-prefs", { sidebar: { order: ["a"], pinned: [] }, layout: { board: { w: 3 } } });
  expect(handlers.onUiPrefs).toHaveBeenCalledWith({ sidebar: { order: ["a"], pinned: [] }, layout: { board: { w: 3 } } });

  close();
  expect(source.closed).toBe(true);
});

test("subscribe only needs onSession: optional handlers are skipped without errors", () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  const onSession = vi.fn();
  api.subscribe({ onSession });
  const source = openSource();
  source.onopen?.();
  source.onerror?.();
  for (const name of source.listeners.keys()) {
    if (name !== "session") expect(() => source.emit(name, {})).not.toThrow();
  }
  source.emit("session", { sessionId: "s1" });
  expect(onSession).toHaveBeenCalledTimes(1);
  expect(onSession).toHaveBeenCalledWith({ sessionId: "s1" });
});
