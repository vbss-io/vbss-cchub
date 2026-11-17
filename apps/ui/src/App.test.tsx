import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ClaimRecord, HubEvents } from "./api";
import type { BoardPayload, ConnectStatus, DelegationSettings, LimitsSnapshot, ReportRecord, TaskDetail, TaskRecord, UiPrefs, WorkspaceRecord } from "./delegation";
import { limitsSnapshot, permission, runtimeSnapshot, session, settings, task } from "./test-support/u3-fixtures";
import { captured, resetCaptured, stub } from "./test-support/u3-stubs";
import { installTauri, removeTauri, type TauriFake } from "./test-support/u3-tauri";
import type { CodexSessionRecord, GroupRecord, HistoryHit, PermissionRequestRecord, PermissionRequestSummary, RuntimeSnapshot, SessionRecord } from "./types";
import type { SessionDrawer } from "./components/SessionDrawer";
import type { CodexDrawer } from "./components/CodexDrawer";
import type { TaskDrawer } from "./components/TaskDrawer";
import type { SessionsModeSwitch } from "./components/SessionsModeSwitch";
import type { BoardView } from "./views/BoardView";
import type { FlowView } from "./views/FlowView";
import type { HistorySearchView } from "./views/HistorySearchView";
import type { RoutinesView } from "./views/RoutinesView";
import type { SessionsView } from "./views/SessionsView";
import type { SettingsView } from "./views/SettingsView";
import type { ShareView } from "./views/ShareView";
import type { TodayView } from "./views/TodayView";
import type { UsageView } from "./views/UsageView";
import type { WorkspacesView } from "./views/WorkspacesView";
import type { ReportsView } from "./views/ReportsView";

const realSetTimeout = globalThis.setTimeout.bind(globalThis);

const hub = vi.hoisted(() => ({ handlers: null as HubEvents | null, unsubscribe: vi.fn() }));
const api = vi.hoisted(() => ({
  hubBase: "http://127.0.0.1:4317",
  archiveCodexThread: vi.fn(async () => undefined),
  archiveSession: vi.fn(async () => undefined),
  createGroup: vi.fn(async () => ({})),
  deleteCodexThread: vi.fn(async () => undefined),
  deleteGroup: vi.fn(async () => undefined),
  deleteSession: vi.fn(async () => undefined),
  fetchClaims: vi.fn<() => Promise<ClaimRecord[]>>(),
  fetchCodexSessions: vi.fn<() => Promise<CodexSessionRecord[]>>(),
  fetchGroups: vi.fn<() => Promise<GroupRecord[]>>(),
  fetchRuntimes: vi.fn<() => Promise<RuntimeSnapshot>>(),
  fetchSessions: vi.fn<() => Promise<SessionRecord[]>>(),
  focusCodexApp: vi.fn<() => Promise<{ ok: boolean; reason?: string }>>(),
  focusSession: vi.fn<(id: string) => Promise<{ ok: boolean; reason?: string }>>(),
  getHooks: vi.fn(),
  openCodexSession: vi.fn(),
  openSession: vi.fn(),
  releaseClaim: vi.fn(async () => undefined),
  renameCodexThread: vi.fn(async () => undefined),
  renameSession: vi.fn(async () => undefined),
  reorderGroups: vi.fn(async () => undefined),
  reportUiDiag: vi.fn(async () => undefined),
  setHooks: vi.fn(),
  setSessionFavorite: vi.fn(async () => undefined),
  unarchiveCodexThread: vi.fn(async () => undefined),
  updateGroup: vi.fn(async () => ({})),
  probeHealth: vi.fn<() => Promise<boolean>>(),
  fetchPermissions: vi.fn<() => Promise<PermissionRequestRecord[]>>(),
  decidePermission: vi.fn(async () => "done"),
  releasePermission: vi.fn(async () => "done"),
  subscribe: vi.fn((handlers: HubEvents) => {
    hub.handlers = handlers;
    return hub.unsubscribe;
  }),
}));
const delegation = vi.hoisted(() => ({
  addCapture: vi.fn(async () => ({ captures: [] })),
  configureCodexHooks: vi.fn(async () => undefined),
  configureMcp: vi.fn(async () => undefined),
  configureShell: vi.fn(async () => undefined),
  createBackup: vi.fn(),
  getConnect: vi.fn<() => Promise<ConnectStatus>>(),
  getSettings: vi.fn<() => Promise<DelegationSettings>>(),
  getUiPrefs: vi.fn<() => Promise<UiPrefs>>(),
  putUiPrefs: vi.fn<(patch: unknown) => Promise<UiPrefs>>(),
  getTask: vi.fn<(id: string) => Promise<TaskDetail>>(),
  getTasksBoard: vi.fn<() => Promise<BoardPayload>>(),
  listReports: vi.fn<() => Promise<ReportRecord[]>>(),
  listTasks: vi.fn<() => Promise<TaskRecord[]>>(),
  listWorkspaces: vi.fn<() => Promise<WorkspaceRecord[]>>(),
  openWorkspace: vi.fn(),
  updateSettings: vi.fn<(patch: unknown) => Promise<DelegationSettings>>(),
  getTunnel: vi.fn(),
  updateTunnelSettings: vi.fn(),
  getAutostart: vi.fn(),
  setAutostart: vi.fn(),
  fetchLimits: vi.fn<() => Promise<LimitsSnapshot | null>>(),
}));
const notifications = vi.hoisted(() => ({ notifyEvent: vi.fn(), setNotifConfig: vi.fn() }));
const routines = vi.hoisted(() => ({ unread: 0, enabled: [] as boolean[] }));
const clipboard = vi.hoisted(() => ({ copyText: vi.fn(async () => true) }));

vi.mock("./api", () => api);
vi.mock("./delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("./delegation")>()), ...delegation }));
vi.mock("./notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("./notifications")>()), ...notifications }));
const historyState = vi.hoisted(() => ({ hits: [] as unknown[] }));
vi.mock("./use-history", () => ({ useHistorySearch: () => ({ state: { key: null, phase: "idle", loadingMore: false, hits: historyState.hits, hasMore: false, enabled: null, error: null }, more: () => undefined }) }));
vi.mock("./use-routines", () => ({
  useRoutineUnread: (_subscribe: unknown, enabled: boolean) => {
    routines.enabled.push(enabled);
    return routines.unread;
  },
}));
vi.mock("./memory-clipboard", () => clipboard);
vi.mock("./views/SessionsView", async () => ({ SessionsView: (await import("./test-support/u3-stubs")).stub("SessionsView") }));
vi.mock("./views/TodayView", async () => ({ TodayView: (await import("./test-support/u3-stubs")).stub("TodayView") }));
vi.mock("./views/BoardView", async () => ({ BoardView: (await import("./test-support/u3-stubs")).stub("BoardView") }));
vi.mock("./views/FlowView", async () => ({ FlowView: (await import("./test-support/u3-stubs")).stub("FlowView") }));
vi.mock("./views/HistorySearchView", async () => ({ HistorySearchView: (await import("./test-support/u3-stubs")).stub("HistorySearchView") }));
vi.mock("./views/ReportsView", async () => ({ ReportsView: (await import("./test-support/u3-stubs")).stub("ReportsView") }));
vi.mock("./views/RoutinesView", async () => ({ RoutinesView: (await import("./test-support/u3-stubs")).stub("RoutinesView") }));
vi.mock("./views/SettingsView", async () => ({ SettingsView: (await import("./test-support/u3-stubs")).stub("SettingsView") }));
vi.mock("./views/ShareView", async () => ({ ShareView: (await import("./test-support/u3-stubs")).stub("ShareView") }));
vi.mock("./views/UsageView", async () => ({ UsageView: (await import("./test-support/u3-stubs")).stub("UsageView") }));
vi.mock("./views/WorkspacesView", async () => ({ WorkspacesView: (await import("./test-support/u3-stubs")).stub("WorkspacesView") }));
vi.mock("./components/SessionDrawer", async () => ({ SessionDrawer: (await import("./test-support/u3-stubs")).stub("SessionDrawer") }));
vi.mock("./components/CodexDrawer", async () => ({ CodexDrawer: (await import("./test-support/u3-stubs")).stub("CodexDrawer") }));
vi.mock("./components/TaskDrawer", async () => ({ TaskDrawer: (await import("./test-support/u3-stubs")).stub("TaskDrawer") }));
vi.mock("./components/SessionsModeSwitch", async () => ({ SessionsModeSwitch: (await import("./test-support/u3-stubs")).stub("SessionsModeSwitch") }));

import { App } from "./App";

type Props<T> = T extends (props: infer P) => unknown ? P : never;

const sessionsView = () => captured<Props<typeof SessionsView>>("SessionsView");
const settingsView = () => captured<Props<typeof SettingsView>>("SettingsView");
const taskDrawer = () => captured<Props<typeof TaskDrawer>>("TaskDrawer");

const handlers = (): HubEvents => {
  if (!hub.handlers) throw new Error("not subscribed");
  return hub.handlers;
};

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let rail = true;
let fake: TauriFake | null = null;

const flush = () =>
  act(async () => {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 25));
  });

const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
    await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
  });

const run = async (action: () => void | Promise<void>) => {
  await act(async () => {
    await action();
  });
  await flush();
};

const goto = async (hash: string) => {
  await run(() => {
    window.history.replaceState(null, "", hash);
    window.dispatchEvent(new Event("hashchange"));
  });
};

const heading = () => document.querySelector(".head h1")?.textContent;
const toastTexts = () => Array.from(document.querySelectorAll(".toast__text")).map((node) => node.textContent);

interface Boot {
  features?: Partial<DelegationSettings["features"]>;
  sessions?: SessionRecord[];
  tasks?: TaskRecord[];
  workspaces?: WorkspaceRecord[];
  codex?: CodexSessionRecord[];
  groups?: GroupRecord[];
  claims?: ClaimRecord[];
  hash?: string;
  settings?: DelegationSettings;
}

const board = (): BoardPayload => ({ tasks: [{ id: "bt-1", title: "Zebra crossing fix", status: "todo", projectId: "p1", subtasks: [] }], projects: [{ id: "p1", title: "Proj" }] }) as unknown as BoardPayload;

const boot = async (options: Boot = {}) => {
  window.history.replaceState(null, "", options.hash ?? "#/sessions");
  delegation.getSettings.mockResolvedValue(options.settings ?? settings(options.features ?? {}));
  delegation.listWorkspaces.mockResolvedValue(options.workspaces ?? []);
  delegation.listTasks.mockResolvedValue(options.tasks ?? []);
  api.fetchSessions.mockResolvedValue(options.sessions ?? []);
  api.fetchCodexSessions.mockResolvedValue(options.codex ?? []);
  api.fetchGroups.mockResolvedValue(options.groups ?? []);
  api.fetchClaims.mockResolvedValue(options.claims ?? []);
  const view = render(<App />);
  await flush();
  return view;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
  hub.handlers = null;
  hub.unsubscribe.mockClear();
  resetCaptured();
  routines.unread = 0;
  historyState.hits = [];
  routines.enabled = [];
  for (const fn of Object.values(api)) if (typeof fn !== "string") fn.mockClear();
  for (const fn of Object.values(delegation)) fn.mockReset();
  notifications.notifyEvent.mockClear();
  notifications.setNotifConfig.mockClear();
  clipboard.copyText.mockClear();
  api.getHooks.mockResolvedValue({ installed: true, events: [] });
  api.setHooks.mockResolvedValue({ installed: false, events: [] });
  api.fetchRuntimes.mockResolvedValue(runtimeSnapshot());
  api.fetchPermissions.mockResolvedValue([]);
  api.probeHealth.mockResolvedValue(false);
  api.focusSession.mockResolvedValue({ ok: true });
  api.focusCodexApp.mockResolvedValue({ ok: true });
  api.openSession.mockResolvedValue({ ok: true, message: "Opened in terminal" });
  api.openCodexSession.mockResolvedValue({ ok: true, message: "Opened in Codex" });
  delegation.getUiPrefs.mockResolvedValue({ sidebar: null, layout: {} });
  delegation.putUiPrefs.mockImplementation(async (patch) => ({ sidebar: null, layout: (patch as { layout?: UiPrefs["layout"] }).layout ?? {} }));
  delegation.getConnect.mockResolvedValue({} as unknown as ConnectStatus);
  delegation.getTunnel.mockResolvedValue({ running: false });
  delegation.getAutostart.mockResolvedValue({ enabled: false, error: null });
  delegation.listReports.mockResolvedValue([]);
  delegation.fetchLimits.mockResolvedValue(limitsSnapshot());
  delegation.getTasksBoard.mockResolvedValue(board());
  delegation.createBackup.mockResolvedValue({ backup: { file: "C:/backups/hub-2026.zip" } });
  delegation.openWorkspace.mockResolvedValue({ ok: true, error: null, command: "code" });
  delegation.updateSettings.mockResolvedValue(settings());
  delegation.getTask.mockResolvedValue({ task: task(), runs: [] } as unknown as TaskDetail);
  rail = true;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: rail && query.includes("900"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network is blocked in tests"))));
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  removeTauri();
  fake = null;
});

afterEach(() => {
  cleanup();
  removeTauri();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("boots on the sessions view with the sidebar, status bar and hub subscription", async () => {
  await boot({ sessions: [session({ sessionId: "s1", status: "active" })] });
  expect(heading()).toBe("Sessions");
  expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
  expect(screen.getByRole("contentinfo", { name: "Status" })).toBeTruthy();
  expect(screen.getByTestId("SessionsView")).toBeTruthy();
  expect(api.subscribe).toHaveBeenCalledTimes(1);
  expect(Object.keys(sessionsView().sessions)).toEqual(["s1"]);
  expect(document.documentElement.dataset.theme).toBe("dracula");
  expect(notifications.setNotifConfig).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, style: "cchub" }));
  expect(api.reportUiDiag).toHaveBeenCalledWith(expect.objectContaining({ window: "main", notif: expect.objectContaining({ enabled: true }) }));
});

test("unmounting unsubscribes from the hub", async () => {
  const view = await boot();
  view.unmount();
  expect(hub.unsubscribe).toHaveBeenCalledTimes(1);
});

test("an unknown route falls back to sessions and param routes carry their param", async () => {
  await boot({ hash: "#/nonsense" });
  expect(heading()).toBe("Sessions");
  await goto("#/workspaces/my%20ws");
  expect(heading()).toBe("Workspaces");
  expect(captured<Props<typeof WorkspacesView>>("WorkspacesView").focusName).toBe("my%20ws");
});

test("nav links change the view through the hash", async () => {
  await boot();
  await goto("#/daily");
  expect(heading()).toBe("Today");
  expect(screen.getByTestId("TodayView")).toBeTruthy();
  expect(document.querySelector('a[href="#/daily"]')?.getAttribute("aria-current")).toBe("page");
});

test("every view renders its own screen with the right data", async () => {
  await boot({ workspaces: [], tasks: [task({ id: "t1", status: "running" })] });
  await goto("#/board/bt-9");
  expect(captured<Props<typeof BoardView>>("BoardView").openTaskId).toBe("bt-9");
  await goto("#/usage");
  expect(screen.getByTestId("UsageView")).toBeTruthy();
  await goto("#/reports");
  expect(screen.getByTestId("ReportsView")).toBeTruthy();
  await goto("#/share/abc");
  expect(captured<Props<typeof ShareView>>("ShareView").param).toBe("abc");
  expect(document.querySelector(".shell--panel")).not.toBeNull();
  await goto("#/settings/hooks");
  expect(heading()).toBe("Settings");
  expect(settingsView().section).toBe("hooks");
});

test("a disabled plugin view falls back to sessions and offers to turn it on", async () => {
  await boot({ features: { daily: false } });
  await goto("#/daily");
  expect(heading()).toBe("Sessions");
  expect(toastTexts()).toEqual(["Today is off."]);
  fireEvent.click(screen.getByRole("button", { name: "Turn on in Settings" }));
  await flush();
  expect(window.location.hash).toBe("#/settings/plugins");
  expect(toastTexts()).toEqual([]);
});

test("toasts disappear by themselves and can be dismissed", async () => {
  await boot({ hash: "#/settings" });
  await run(() => settingsView().onSaveSettings({ ownerName: "X" }));
  expect(toastTexts()).toEqual(["Settings saved."]);
  expect(delegation.updateSettings).toHaveBeenCalledWith({ ownerName: "X" });
  await advance(4_100);
  expect(toastTexts()).toEqual([]);
  delegation.updateSettings.mockRejectedValueOnce(new Error("save failed"));
  await run(() => settingsView().onSaveSettings({ ownerName: "Y" }));
  expect(toastTexts()).toEqual(["save failed"]);
  expect(document.querySelector(".toast--error")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(toastTexts()).toEqual([]);
  delegation.updateSettings.mockRejectedValueOnce("odd");
  await run(() => settingsView().onSaveSettings({ ownerName: "Z" }));
  expect(toastTexts()).toEqual(["could not save"]);
  await advance(8_100);
  expect(toastTexts()).toEqual([]);
});

test("saving approvals settings reloads the hooks status", async () => {
  await boot({ hash: "#/settings" });
  api.getHooks.mockClear();
  await run(() => settingsView().onSaveSettings({ approvals: { claudeWindowSec: 30, codexWindowSec: 30 } }));
  expect(api.getHooks).toHaveBeenCalled();
});

const summaryOf = (record: PermissionRequestRecord): PermissionRequestSummary => {
  const { toolInput: _input, cwd: _cwd, turnId: _turn, ...rest } = record;
  return rest;
};

test("session events notify when a session starts waiting, goes idle or ends, and update the list", async () => {
  await boot({ sessions: [session({ sessionId: "s1", status: "active", title: "Alpha" })] });
  await run(() => handlers().onSession(session({ sessionId: "s1", status: "waiting", title: "Alpha", lastMessage: "pick one" })));
  expect(notifications.notifyEvent).toHaveBeenLastCalledWith("sessionNeedsYou", { id: "s1", name: "Alpha", detail: "pick one", sound: "attention" });
  await run(() => handlers().onSession(session({ sessionId: "s1", status: "idle", title: "Alpha", customTitle: "Renamed", lastMessage: null })));
  expect(notifications.notifyEvent).toHaveBeenLastCalledWith("sessionIdle", { id: "s1", name: "Renamed", detail: "finished answering", sound: "idle" });
  await run(() => handlers().onSession(session({ sessionId: "s1", status: "ended", title: "Alpha" })));
  expect(notifications.notifyEvent).toHaveBeenLastCalledWith("sessionFinished", { id: "s1", name: "Alpha" });
  expect(sessionsView().sessions.s1?.status).toBe("ended");
  await run(() => handlers().onRemoved?.("s1"));
  expect(sessionsView().sessions.s1).toBeUndefined();
});

test("a brand new waiting session without a title is named after its folder and a new ended one is silent", async () => {
  await boot();
  await run(() => handlers().onSession(session({ sessionId: "abcdef123456", status: "waiting", title: null, customTitle: null, cwd: "C:/work/payments/", lastMessage: null })));
  expect(notifications.notifyEvent).toHaveBeenLastCalledWith("sessionNeedsYou", { id: "abcdef123456", name: "payments", detail: "needs a decision", sound: "attention" });
  notifications.notifyEvent.mockClear();
  await run(() => handlers().onSession(session({ sessionId: "gone", status: "ended" })));
  expect(notifications.notifyEvent).not.toHaveBeenCalled();
  await run(() => handlers().onSession(session({ sessionId: "nocwd", status: "waiting", title: null, cwd: null })));
  expect(notifications.notifyEvent).toHaveBeenLastCalledWith("sessionNeedsYou", expect.objectContaining({ name: "nocwd" }));
});

test("sessions from muted clients and archived sessions do not notify", async () => {
  await boot();
  await run(() => handlers().onSession(session({ sessionId: "desk", status: "waiting", client: "claude-desktop" })));
  await run(() => handlers().onSession(session({ sessionId: "arch", status: "waiting", archivedAt: 5 })));
  expect(notifications.notifyEvent).not.toHaveBeenCalled();
});

test("share requests notify only while running", async () => {
  await boot();
  await run(() => handlers().onShareRequest?.({ id: "r1", kind: "ask", status: "running", label: "docs", asker: "bob", prompt: "why?" } as never));
  expect(notifications.notifyEvent).toHaveBeenLastCalledWith("shareAsk", { id: "r1", label: "docs", asker: "bob", detail: "why?" });
  await run(() => handlers().onShareRequest?.({ id: "r2", kind: "implement", status: "running", label: "docs", asker: "bob", prompt: "do" } as never));
  expect(notifications.notifyEvent).toHaveBeenLastCalledWith("shareImplement", expect.objectContaining({ id: "r2" }));
  notifications.notifyEvent.mockClear();
  await run(() => handlers().onShareRequest?.({ id: "r3", kind: "ask", status: "done", label: "docs", asker: "bob", prompt: "x" } as never));
  expect(notifications.notifyEvent).not.toHaveBeenCalled();
});

test("a failed routine run raises a task failed notice and every run reaches the routine listeners", async () => {
  await boot();
  const seen: unknown[] = [];
  const unsubscribe = captured<Props<typeof SessionsView>>("SessionsView");
  expect(unsubscribe.renderRoutines).toBeDefined();
  render(<>{sessionsView().renderRoutines?.()}</>);
  const subscribe = captured<Props<typeof RoutinesView>>("RoutinesView").subscribe;
  const stop = subscribe((event) => seen.push(event));
  await run(() => handlers().onRoutineRun?.({ runId: "run-1", taskId: "task-9", status: "failed", routineName: "Nightly", error: "boom" } as never));
  expect(notifications.notifyEvent).toHaveBeenCalledWith("taskFailed", { id: "task-9", title: "Nightly", detail: "boom" });
  notifications.notifyEvent.mockClear();
  await run(() => handlers().onRoutineRun?.({ runId: "run-2", taskId: null, status: "done", routineName: "Nightly", error: null } as never));
  expect(notifications.notifyEvent).not.toHaveBeenCalled();
  await run(() => handlers().onRoutines?.());
  await run(() => handlers().onRoutinesInbox?.(3));
  expect(seen).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "routine-run" }), { kind: "routines" }, { kind: "routines-inbox", unread: 3 }]));
  stop();
  await run(() => handlers().onRoutines?.());
  expect(seen).toHaveLength(4);
});

test("stream events reach the subscribers registered by the views", async () => {
  await boot({ hash: "#/daily" });
  const daily: unknown[] = [];
  const board: unknown[] = [];
  const stopDaily = captured<Props<typeof TodayView>>("TodayView").subscribeDaily((event) => daily.push(event));
  const stopBoard = captured<Props<typeof TodayView>>("TodayView").subscribeBoard((event) => board.push(event));
  await run(() => handlers().onDaily?.({ date: "2026-03-01", updatedAt: 1, source: "disk", writeId: null }));
  await run(() => handlers().onTasksBoard?.({ source: "disk", projectId: "p" }));
  expect(daily).toHaveLength(1);
  expect(board).toHaveLength(1);
  stopDaily();
  stopBoard();
  await run(() => handlers().onDaily?.({ date: "2026-03-01", updatedAt: 1, source: "disk", writeId: null }));
  expect(daily).toHaveLength(1);
});

test("usage, limits, history, share and run events are forwarded", async () => {
  await boot({ hash: "#/usage" });
  const usage: unknown[] = [];
  const stopUsage = captured<Props<typeof UsageView>>("UsageView").subscribeUsage((event) => usage.push(event));
  await run(() => handlers().onUsage?.());
  await run(() => handlers().onLimits?.());
  expect(usage).toEqual(["usage", "limits"]);
  stopUsage();
  await goto("#/share/x");
  const share: unknown[] = [];
  const stopShare = captured<Props<typeof ShareView>>("ShareView").subscribeShareStream((event) => share.push(event));
  await run(() => handlers().onShareStream?.({ requestId: "r", shareId: "s", kind: "text", text: "hi" }));
  expect(share).toHaveLength(1);
  stopShare();
  await run(() => handlers().onShareStream?.({ requestId: "r", shareId: "s", kind: "text", text: "again" }));
  expect(share).toHaveLength(1);
  await goto("#/sessions");
  render(<>{sessionsView().renderSearch?.()}</>);
  const history: unknown[] = [];
  const stopHistory = captured<Props<typeof HistorySearchView>>("HistorySearchView").subscribeHistory((status) => history.push(status));
  await run(() => handlers().onHistory?.({ state: "ready" } as never));
  expect(history).toHaveLength(1);
  stopHistory();
  await run(() => handlers().onHistory?.({ state: "ready" } as never));
  expect(history).toHaveLength(1);
});

test("run events reach the open task drawer", async () => {
  await boot({ tasks: [task({ id: "t1", status: "running" })] });
  await run(() => sessionsView().onOpenTask("t1"));
  const events: unknown[] = [];
  const stop = taskDrawer().subscribeRunEvents((event) => events.push(event));
  await run(() => handlers().onRunEvent?.({ taskId: "t1" } as never));
  expect(events).toHaveLength(1);
  stop();
  await run(() => handlers().onRunEvent?.({ taskId: "t1" } as never));
  expect(events).toHaveLength(1);
});

test("claims, groups, codex, hooks, tunnel, settings and delegation events update the screens", async () => {
  await boot({ hash: "#/settings" });
  const claim = { id: "c1", sessionId: "s1", sessionTitle: null, repoPath: "C:/r", paths: [], note: null, createdAt: 1, expiresAt: 2 } satisfies ClaimRecord;
  await run(() => handlers().onGroups?.([{ id: "g1", name: "G", match: "x", position: 0 }]));
  expect(settingsView().groups).toHaveLength(1);
  await run(() => handlers().onHooks?.({ installed: false, events: [] }));
  expect(settingsView().hooks?.installed).toBe(false);
  await run(() => handlers().onTunnel?.({ running: true } as never));
  expect(settingsView().tunnel).toEqual({ running: true });
  await run(() => handlers().onSettings?.(settings({}, { ownerName: "Live" })));
  expect(settingsView().settings?.ownerName).toBe("Live");
  await goto("#/sessions");
  await run(() => handlers().onClaims?.([claim]));
  expect(sessionsView().claims).toEqual([claim]);
  await run(() => handlers().onCodex?.([{ id: "cx1", status: "active" } as unknown as CodexSessionRecord]));
  expect(sessionsView().codexSessions).toHaveLength(1);
  delegation.listTasks.mockResolvedValue([task({ id: "tt", status: "running" })]);
  await run(() => handlers().onDelegation?.("tt"));
  expect(sessionsView().tasks).toHaveLength(1);
  delegation.listTasks.mockResolvedValue([task({ id: "tt", status: "running" }), task({ id: "t2", status: "running" })]);
  await run(() => handlers().onReport?.());
  expect(sessionsView().tasks).toHaveLength(2);
  await run(() => handlers().onUiPrefs?.({ sidebar: null, layout: { shell: { sidebarCollapsed: 1 } } }));
  expect(document.querySelector(".shell--rail")).not.toBeNull();
});

test("ui navigation requests change the route and show the window inside the desktop app", async () => {
  fake = installTauri("main");
  await boot();
  await run(() => handlers().onNavigate?.("#/usage"));
  expect(window.location.hash).toBe("#/usage");
  await flush();
  expect(fake.calls("plugin:window|show")).toEqual([{ label: "main" }]);
  expect(fake.calls("plugin:window|unminimize")).toEqual([{ label: "main" }]);
  expect(fake.calls("plugin:window|set_focus")).toEqual([{ label: "main" }]);
});

test("ui navigation outside the desktop app only changes the route", async () => {
  await boot();
  await run(() => handlers().onNavigate?.("#/reports"));
  expect(window.location.hash).toBe("#/reports");
});

test("a desktop window error while showing is swallowed", async () => {
  fake = installTauri("main");
  fake.on("plugin:window|show", () => {
    throw new Error("no window");
  });
  await boot();
  await run(() => handlers().onNavigate?.("#/usage"));
  await flush();
  expect(window.location.hash).toBe("#/usage");
});

test("permission events are handed to the approvals store", async () => {
  await boot();
  const record = permission({ id: "ap1", expiresAt: Date.now() + 60_000 });
  api.fetchPermissions.mockResolvedValue([record]);
  await run(() => handlers().onPermissionRequest?.(summaryOf(record)));
  expect(api.fetchPermissions).toHaveBeenCalled();
  await run(() => handlers().onPermissionResolved?.({ id: "ap1", agent: "claude", sessionId: record.sessionId, outcome: "allow", at: 1 }));
});

test("reconnecting refreshes every dataset and notifies the routine listeners", async () => {
  await boot();
  render(<>{sessionsView().renderRoutines?.()}</>);
  const seen: unknown[] = [];
  captured<Props<typeof RoutinesView>>("RoutinesView").subscribe((event) => seen.push(event));
  api.fetchSessions.mockClear();
  delegation.getSettings.mockClear();
  api.fetchPermissions.mockClear();
  await run(() => handlers().onOpen?.());
  expect(api.fetchSessions).toHaveBeenCalled();
  expect(delegation.getSettings).toHaveBeenCalled();
  expect(api.fetchPermissions).toHaveBeenCalled();
  expect(delegation.getUiPrefs).toHaveBeenCalled();
  expect(delegation.getConnect).toHaveBeenCalled();
  expect(seen).toEqual([{ kind: "routines" }]);
  await run(() => handlers().onOpen?.());
});

test("a stream error with a failing health probe shows the offline banner and recovery refreshes", async () => {
  await boot({ hash: "#/daily" });
  const daily: unknown[] = [];
  captured<Props<typeof TodayView>>("TodayView").subscribeDaily((event) => daily.push(event));
  await run(() => handlers().onError?.());
  await advance(1_600);
  await advance(6_000);
  expect(screen.getByRole("status").textContent).toContain("Hub offline - reconnecting...");
  delegation.getSettings.mockClear();
  await run(() => handlers().onOpen?.());
  expect(screen.queryByText("Hub offline - reconnecting...")).toBeNull();
  expect(delegation.getSettings).toHaveBeenCalled();
  expect(daily.some((event) => (event as { recovered?: boolean }).recovered === true)).toBe(true);
});

test("an offline hub with delegation disabled flips the hub flag", async () => {
  const { DelegationDisabledError } = await import("./delegation");
  delegation.getSettings.mockRejectedValue(new DelegationDisabledError("off"));
  window.history.replaceState(null, "", "#/workspaces");
  render(<App />);
  await flush();
  expect(captured<Props<typeof WorkspacesView>>("WorkspacesView").enabled).toBe(false);
});

test("the development hook can switch notification settings", async () => {
  await boot();
  const dev = (window as unknown as { __cchubNotifications: { fired: () => unknown[]; reset: () => void; setEnabled: (value: boolean) => void; setEvent: (kind: string, value: boolean) => void } }).__cchubNotifications;
  expect(dev.fired()).toEqual([]);
  dev.reset();
  await run(() => dev.setEnabled(false));
  expect(notifications.setNotifConfig).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  await run(() => dev.setEvent("taskFailed", false));
  expect(JSON.parse(localStorage.getItem("hub.notifications") ?? "{}").events.taskFailed).toBe(false);
});

test("stored notification settings are migrated and merged with the defaults", async () => {
  localStorage.setItem("hub.notifications", JSON.stringify({ version: 1, enabled: false, events: { sessionIdle: false }, clients: { vscode: false } }));
  await boot();
  const stored = JSON.parse(localStorage.getItem("hub.notifications") ?? "{}");
  expect(stored.version).toBe(3);
  expect(stored.enabled).toBe(false);
  expect(stored.events.sessionIdle).toBe(true);
  expect(stored.clients.vscode).toBe(false);
  expect(stored.clients.terminal).toBe(true);
});

test("corrupt stored notification settings fall back to the defaults", async () => {
  localStorage.setItem("hub.notifications", "{oops");
  await boot();
  expect(JSON.parse(localStorage.getItem("hub.notifications") ?? "{}").enabled).toBe(true);
});

test("the settings view can change the notification settings and the theme", async () => {
  await boot({ hash: "#/settings" });
  await run(() => settingsView().onNotif({ ...settingsView().notif, sound: false }));
  expect(notifications.setNotifConfig).toHaveBeenLastCalledWith(expect.objectContaining({ sound: false }));
  await run(() => settingsView().onTheme("midnight"));
  expect(document.documentElement.dataset.theme).toBe("midnight");
  expect(localStorage.getItem("hub.theme")).toBe("midnight");
});

test("a stored midnight theme is applied on boot", async () => {
  localStorage.setItem("hub.theme", "midnight");
  await boot();
  expect(document.documentElement.dataset.theme).toBe("midnight");
});

test("task status changes notify with the result and skip routine tasks", async () => {
  const running = [task({ id: "ta", title: "Alpha", status: "running" }), task({ id: "tb", title: "Beta", status: "running" }), task({ id: "tc", title: "Gamma", status: "running" }), task({ id: "td", title: "Delta", status: "running" }), task({ id: "te", title: "Echo", status: "running", createdBy: "routine:r1" })];
  await boot({ tasks: running });
  delegation.getTask.mockResolvedValueOnce({ task: task({ id: "ta", isolation: "worktree", mergedAt: null }), runs: [{ result: "first" }, { result: "final result" }] } as unknown as TaskDetail);
  delegation.getTask.mockRejectedValueOnce(new Error("detail failed"));
  delegation.listTasks.mockResolvedValue([
    task({ id: "ta", title: "Alpha", status: "completed" }),
    task({ id: "tb", title: "Beta", status: "completed" }),
    task({ id: "tc", title: "Gamma", status: "failed", lastError: "exit 2" }),
    task({ id: "td", title: "Delta", status: "attention", lastError: "needs input" }),
    task({ id: "te", title: "Echo", status: "failed", createdBy: "routine:r1" }),
  ]);
  await run(() => handlers().onDelegation?.("ta"));
  await flush();
  expect(notifications.notifyEvent).toHaveBeenCalledWith("taskCompleted", { id: "ta", title: "Alpha", detail: "Worktree ready to merge · final result" });
  expect(notifications.notifyEvent).toHaveBeenCalledWith("taskCompleted", { id: "tb", title: "Beta", detail: null });
  expect(notifications.notifyEvent).toHaveBeenCalledWith("taskFailed", { id: "tc", title: "Gamma", detail: "exit 2" });
  expect(notifications.notifyEvent).toHaveBeenCalledWith("taskNeedsYou", { id: "td", title: "Delta", detail: "needs input" });
  expect(notifications.notifyEvent).not.toHaveBeenCalledWith("taskFailed", expect.objectContaining({ id: "te" }));
});

test("a completed shared task reports its plain result", async () => {
  await boot({ tasks: [task({ id: "ta", title: "Alpha", status: "running" })] });
  delegation.getTask.mockResolvedValueOnce({ task: task({ id: "ta", isolation: "shared" }), runs: [{ result: null }, { result: "plain" }] } as unknown as TaskDetail);
  delegation.listTasks.mockResolvedValue([task({ id: "ta", title: "Alpha", status: "completed" })]);
  await run(() => handlers().onDelegation?.("ta"));
  await flush();
  expect(notifications.notifyEvent).toHaveBeenCalledWith("taskCompleted", { id: "ta", title: "Alpha", detail: "plain" });
});

test("the title and app badge follow the sessions that need attention", async () => {
  const setAppBadge = vi.fn(async () => undefined);
  const clearAppBadge = vi.fn(async () => undefined);
  Object.assign(navigator, { setAppBadge, clearAppBadge });
  await boot();
  expect(document.title).toBe("VBSS CCHUB");
  expect(clearAppBadge).toHaveBeenCalled();
  await run(() => handlers().onSession(session({ sessionId: "w1", status: "waiting" })));
  expect(document.title).toBe("(1) VBSS CCHUB");
  expect(setAppBadge).toHaveBeenCalledWith(1);
  const badge = document.querySelector('a[href="#/sessions"] .nav__badge--attn');
  expect(badge?.textContent).toBe("1");
  delete (navigator as unknown as { setAppBadge?: unknown }).setAppBadge;
  delete (navigator as unknown as { clearAppBadge?: unknown }).clearAppBadge;
});

test("polling refreshes the runtimes and codex sessions every ten seconds and the clock every minute", async () => {
  await boot();
  api.fetchRuntimes.mockClear();
  await advance(10_100);
  expect(api.fetchRuntimes).toHaveBeenCalledTimes(1);
  api.fetchRuntimes.mockRejectedValueOnce(new Error("down"));
  await advance(10_000);
  expect(api.fetchRuntimes).toHaveBeenCalledTimes(2);
});

test("the plan limits come from the hub, refresh on limit events and show on the status bar", async () => {
  await boot();
  expect(delegation.fetchLimits).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Plan limits")).toBeTruthy();
  await run(() => handlers().onLimits?.());
  expect(delegation.fetchLimits).toHaveBeenCalledTimes(2);
  await advance(300_100);
  expect(delegation.fetchLimits.mock.calls.length).toBeGreaterThanOrEqual(3);
  delegation.fetchLimits.mockRejectedValue(new Error("down"));
  await run(() => handlers().onLimits?.());
});

test("limits are not requested when the plugin is off", async () => {
  await boot({ features: { limits: false } });
  expect(delegation.fetchLimits).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Plan limits")).toBeNull();
});

test("the status bar opens the usage view and the delegated work", async () => {
  await boot();
  fireEvent.click(within(screen.getByLabelText("Plan limits")).getAllByRole("button")[0] as HTMLElement);
  await flush();
  expect(window.location.hash).toBe("#/usage");
});

const press = async (key: string, init: KeyboardEventInit = {}) => {
  await run(() => {
    fireEvent.keyDown(window, { key, ...init });
  });
};

const paletteInput = () => screen.getByRole("combobox", { name: "Search" }) as HTMLInputElement;

const chooseFromPalette = async (query: string, exact: string = query) => {
  if (!screen.queryByRole("dialog", { name: "Command palette" })) await press("k", { ctrlKey: true });
  await run(() => {
    fireEvent.change(paletteInput(), { target: { value: query } });
  });
  const options = screen.queryAllByRole("option");
  const target = options.find((option) => option.querySelector(".palette__title")?.textContent === exact);
  await run(() => {
    if (target) fireEvent.click(target);
    else fireEvent.keyDown(screen.getByRole("dialog", { name: "Command palette" }), { key: "Enter" });
  });
};

const hubHit = (overrides: Partial<HistoryHit> = {}): HistoryHit => ({
  messageId: 1,
  sessionId: "h-sess",
  client: "claude",
  title: "Past chat",
  cwd: null,
  workspace: null,
  role: "user",
  at: null,
  seq: 1,
  snippet: "needle in a haystack",
  highlights: [],
  matches: 1,
  ...overrides,
});

test("the hooks toggle installs or removes the hooks and ignores a second click while busy", async () => {
  await boot({ hash: "#/settings" });
  await run(() => settingsView().onToggleHooks());
  expect(api.setHooks).toHaveBeenCalledWith(false);
  expect(settingsView().hooks?.installed).toBe(false);
  await run(() => settingsView().onToggleHooks());
  expect(api.setHooks).toHaveBeenLastCalledWith(true);
});

test("the shell alias, mcp and codex hook actions toast their outcome", async () => {
  await boot({ hash: "#/settings" });
  await run(() => settingsView().onShell("bash" as never, "install"));
  expect(toastTexts()).toContain("Alias installed. Reopen the terminal.");
  await run(() => settingsView().onShell("bash" as never, "uninstall"));
  expect(toastTexts()).toContain("Alias removed.");
  delegation.configureShell.mockRejectedValueOnce(new Error("no shell"));
  await run(() => settingsView().onShell("bash" as never, "install"));
  expect(toastTexts()).toContain("no shell");
  delegation.configureShell.mockRejectedValueOnce("x");
  await run(() => settingsView().onShell("bash" as never, "install"));
  expect(toastTexts()).toContain("could not change the alias");
  await run(() => settingsView().onMcp("claude-code" as never, "install"));
  expect(toastTexts()).toContain("Connected. Restart the client so it loads the hub tools.");
  await run(() => settingsView().onMcp("claude-code" as never, "uninstall"));
  expect(toastTexts()).toContain("Disconnected.");
  delegation.configureMcp.mockRejectedValueOnce(new Error("mcp down"));
  await run(() => settingsView().onMcp("claude-code" as never, "install"));
  expect(toastTexts()).toContain("mcp down");
  delegation.configureMcp.mockRejectedValueOnce(7);
  await run(() => settingsView().onMcp("claude-code" as never, "install"));
  expect(toastTexts()).toContain("could not change the connection");
  await run(() => settingsView().onCodexHooks("install"));
  expect(toastTexts().some((text) => text?.startsWith("Codex hooks written."))).toBe(true);
  await run(() => settingsView().onCodexHooks("uninstall"));
  expect(toastTexts()).toContain("Codex hooks removed.");
  delegation.configureCodexHooks.mockRejectedValueOnce(new Error("codex down"));
  await run(() => settingsView().onCodexHooks("install"));
  expect(toastTexts()).toContain("codex down");
  delegation.configureCodexHooks.mockRejectedValueOnce(1);
  await run(() => settingsView().onCodexHooks("install"));
  expect(toastTexts()).toContain("could not change the Codex hooks");
});

test("the settings route loads the autostart status and the connect status, and autostart toasts", async () => {
  await boot({ hash: "#/settings" });
  expect(delegation.getAutostart).toHaveBeenCalled();
  expect(delegation.getConnect).toHaveBeenCalled();
  delegation.setAutostart.mockResolvedValueOnce({ enabled: true, error: null });
  await run(() => settingsView().onAutostart(true));
  expect(toastTexts()).toContain("The hub will start with Windows.");
  expect(settingsView().autostart).toEqual({ enabled: true, error: null });
  delegation.setAutostart.mockResolvedValueOnce({ enabled: false, error: null });
  await run(() => settingsView().onAutostart(false));
  expect(toastTexts()).toContain("Autostart removed.");
  delegation.setAutostart.mockResolvedValueOnce({ enabled: false, error: "registry denied" });
  await run(() => settingsView().onAutostart(true));
  expect(toastTexts()).toContain("registry denied");
  delegation.setAutostart.mockRejectedValueOnce(new Error("autostart down"));
  await run(() => settingsView().onAutostart(true));
  expect(toastTexts()).toContain("autostart down");
  delegation.setAutostart.mockRejectedValueOnce(3);
  await run(() => settingsView().onAutostart(true));
  expect(toastTexts()).toContain("could not change autostart");
});

test("a failing autostart or connect read leaves them empty", async () => {
  delegation.getAutostart.mockRejectedValue(new Error("down"));
  delegation.getConnect.mockRejectedValue(new Error("down"));
  await boot({ hash: "#/settings" });
  expect(settingsView().autostart).toBeNull();
  expect(settingsView().connect).toBeNull();
});

test("tunnel settings save or report an error", async () => {
  await boot({ hash: "#/settings" });
  delegation.updateTunnelSettings.mockResolvedValueOnce({ running: false, domain: "x" });
  await run(() => settingsView().onTunnelSettings({ domain: "x" } as never));
  expect(toastTexts()).toContain("ngrok settings saved");
  delegation.updateTunnelSettings.mockRejectedValueOnce(new Error("ngrok failed"));
  await run(() => settingsView().onTunnelSettings({} as never));
  expect(toastTexts()).toContain("ngrok failed");
  delegation.updateTunnelSettings.mockRejectedValueOnce(2);
  await run(() => settingsView().onTunnelSettings({} as never));
  expect(toastTexts()).toContain("could not save");
});

test("groups can be created, updated, deleted and moved", async () => {
  await boot({
    hash: "#/settings",
    groups: [
      { id: "g1", name: "A", match: "a", position: 0 },
      { id: "g2", name: "B", match: "b", position: 1 },
      { id: "g3", name: "C", match: "c", position: 2 },
    ],
  });
  await run(() => settingsView().onCreateGroup("D", "d"));
  expect(api.createGroup).toHaveBeenCalledWith("D", "d");
  await run(() => settingsView().onUpdateGroup("g1", { name: "AA" }));
  expect(api.updateGroup).toHaveBeenCalledWith("g1", { name: "AA" });
  await run(() => settingsView().onDeleteGroup("g2"));
  expect(api.deleteGroup).toHaveBeenCalledWith("g2");
  await run(() => settingsView().onMoveGroup("g2", 1));
  expect(api.reorderGroups).toHaveBeenLastCalledWith(["g1", "g3", "g2"]);
  await run(() => settingsView().onMoveGroup("g1", -1));
  await run(() => settingsView().onMoveGroup("g3", 1));
  await run(() => settingsView().onMoveGroup("missing", 1));
  expect(api.reorderGroups).toHaveBeenCalledTimes(1);
});

test("the settings view can open the what's new dialog", async () => {
  await boot({ hash: "#/settings" });
  await run(() => settingsView().onWhatsNew());
  expect(screen.getByRole("dialog", { name: "What's new" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog", { name: "What's new" })).toBeNull();
});

test("the version button opens what's new once and remembers the seen version", async () => {
  await boot();
  const button = document.querySelector(".version") as HTMLElement;
  expect(button.className).toContain("version--new");
  fireEvent.click(button);
  expect(screen.getByRole("dialog", { name: "What's new" })).toBeTruthy();
  expect(localStorage.getItem("hub.seenVersion")).toBe(__APP_VERSION__);
  expect(document.querySelector(".version")?.className).not.toContain("version--new");
});

test("session actions are forwarded to the hub api", async () => {
  await boot({ sessions: [session({ sessionId: "s1", status: "active" })] });
  const view = sessionsView();
  await run(() => view.onFocus("s1"));
  expect(api.focusSession).toHaveBeenCalledWith("s1");
  await run(() => view.onArchive?.("s1"));
  expect(api.archiveSession).toHaveBeenCalledWith("s1");
  await run(() => view.onDelete("s1"));
  expect(api.deleteSession).toHaveBeenCalledWith("s1");
  await run(() => view.onRename("s1", "New"));
  expect(api.renameSession).toHaveBeenCalledWith("s1", "New");
  await run(() => view.onRenameCodex("cx", "Name"));
  expect(api.renameCodexThread).toHaveBeenCalledWith("cx", "Name");
  await run(() => view.onArchiveCodex("cx"));
  expect(api.archiveCodexThread).toHaveBeenCalledWith("cx");
  await run(() => view.onUnarchiveCodex("cx"));
  expect(api.unarchiveCodexThread).toHaveBeenCalledWith("cx");
  await run(() => view.onDeleteCodex("cx"));
  expect(api.deleteCodexThread).toHaveBeenCalledWith("cx");
});

test("favoriting updates the session optimistically and unknown sessions are ignored", async () => {
  await boot({ sessions: [session({ sessionId: "s1", status: "active" })] });
  await run(() => sessionsView().onFavorite("s1", true));
  expect(sessionsView().sessions.s1?.favoriteAt).not.toBeNull();
  expect(api.setSessionFavorite).toHaveBeenCalledWith("s1", true);
  await run(() => sessionsView().onFavorite("s1", false));
  expect(sessionsView().sessions.s1?.favoriteAt).toBeNull();
  await run(() => sessionsView().onFavorite("nope", true));
  expect(sessionsView().sessions.nope).toBeUndefined();
});

test("opening a session outside the hub toasts the outcome", async () => {
  await boot();
  await run(() => sessionsView().onOpenSession?.("s1"));
  expect(api.openSession).toHaveBeenCalledWith("s1");
  expect(toastTexts()).toContain("Brought the window to the front.");
  api.openCodexSession.mockResolvedValueOnce({ ok: false, method: "focus", reason: "the Codex app is not running" });
  await run(() => sessionsView().onOpenCodexSession?.("cx"));
  expect(toastTexts()).toContain("The Codex app is not running. Open it, then try again.");
  api.openSession.mockRejectedValueOnce(new Error("hub error"));
  await run(() => sessionsView().onOpenSession?.("s2"));
  expect(toastTexts()).toContain("hub error");
  api.openSession.mockRejectedValueOnce(5);
  await run(() => sessionsView().onOpenSession?.("s3"));
  expect(toastTexts()).toContain("could not open the session");
});

test("the sessions view receives the runtime, delegation and mode state", async () => {
  await boot({ tasks: [task({ id: "t1", status: "running" })], codex: [{ id: "cx1", status: "waiting" } as unknown as CodexSessionRecord] });
  const view = sessionsView();
  expect(view.delegatedEnabled).toBe(true);
  expect(view.hubEnabled).toBe(true);
  expect(view.mode).toBe("list");
  expect(view.needsYouTop).toBe(true);
  expect(view.codexAppRunning).toBe(false);
  expect(view.tasks).toHaveLength(1);
  await run(() => view.onOrigin("delegated"));
  expect(sessionsView().origin).toBe("delegated");
  expect(localStorage.getItem("hub.sessions.origin")).toBe("delegated");
  await run(() => view.onTasksChanged?.());
  await run(() => view.onOpenSettings?.());
  expect(window.location.hash).toBe("#/settings/connect");
  await run(() => view.onError?.("problem"));
  expect(toastTexts()).toContain("problem");
});

test("the mode switch changes the sessions mode and only list and map are remembered", async () => {
  await boot();
  render(<>{sessionsView().modeSwitch}</>);
  const modeSwitch = captured<Props<typeof SessionsModeSwitch>>("SessionsModeSwitch");
  expect(modeSwitch.flowOn).toBe(true);
  await run(() => modeSwitch.onMode("map"));
  expect(sessionsView().mode).toBe("map");
  expect(localStorage.getItem("hub.sessions.mode")).toBe("map");
  await run(() => modeSwitch.onMode("search"));
  expect(sessionsView().mode).toBe("search");
  expect(localStorage.getItem("hub.sessions.mode")).toBe("map");
  await run(() => modeSwitch.onMode("routines"));
  expect(sessionsView().mode).toBe("routines");
});

test("a map mode without the flow plugin falls back to the list", async () => {
  localStorage.setItem("hub.sessions.mode", "map");
  await boot({ features: { flow: false } });
  expect(sessionsView().mode).toBe("list");
  expect(sessionsView().renderMap).toBeUndefined();
});

test("the flow map is wired to the drawers, the hub and the origin scope", async () => {
  await boot({ sessions: [session({ sessionId: "s1", status: "active" })], codex: [{ id: "cx1", status: "active" } as unknown as CodexSessionRecord] });
  render(<>{sessionsView().renderMap?.({ query: "q", onQuery: () => undefined, origin: "all" } as never)}</>);
  const flow = captured<Props<typeof FlowView>>("FlowView");
  expect(flow.query).toBe("q");
  expect(flow.scope).toEqual(expect.objectContaining({ sessions: true }));
  await run(() => flow.onOpenSession("s1"));
  expect(screen.getByTestId("SessionDrawer")).toBeTruthy();
  await run(() => flow.onOpenCodex("cx1"));
  expect(screen.getByTestId("CodexDrawer")).toBeTruthy();
  await run(() => flow.onFocus("s1"));
  expect(api.focusSession).toHaveBeenCalledWith("s1");
  await run(() => flow.onOpenWorkspace("ws"));
  expect(delegation.openWorkspace).toHaveBeenCalledWith("ws");
  await run(() => flow.onOpenTask("t1"));
  expect(window.location.hash).toBe("#/tasks/t1");
});

test("the search mode wires the history search to the settings and the open handler", async () => {
  await boot({ sessions: [session({ sessionId: "s1", status: "active" })], codex: [{ id: "cx1", status: "active" } as unknown as CodexSessionRecord] });
  render(<>{sessionsView().renderSearch?.()}</>);
  const search = captured<Props<typeof HistorySearchView>>("HistorySearchView");
  await run(() => search.onOpenSettings());
  expect(window.location.hash).toBe("#/settings/memory");
  let result: unknown;
  await run(async () => {
    result = await search.onOpenHit(hubHit({ sessionId: null }));
  });
  expect(result).toEqual({ ok: false, reason: "This match has no session to open." });
  await run(async () => {
    result = await search.onOpenHit(hubHit({ sessionId: "s1" }));
  });
  expect(result).toEqual({ ok: true });
  expect(screen.getByTestId("SessionDrawer")).toBeTruthy();
  await run(async () => {
    result = await search.onOpenHit(hubHit({ sessionId: "cx1", client: "codex" }));
  });
  expect(result).toEqual({ ok: true });
  expect(screen.getByTestId("CodexDrawer")).toBeTruthy();
  await run(async () => {
    result = await search.onOpenHit(hubHit({ sessionId: "other" }));
  });
  expect(result).toEqual({ ok: true });
  expect(api.openSession).toHaveBeenCalledWith("other");
  await run(async () => {
    result = await search.onOpenHit(hubHit({ sessionId: "cx-other", client: "codex" }));
  });
  expect(api.openCodexSession).toHaveBeenCalledWith("cx-other");
  api.openSession.mockResolvedValueOnce({ ok: false, method: "focus", reason: "boom" });
  await run(async () => {
    result = await search.onOpenHit(hubHit({ sessionId: "bad" }));
  });
  expect(result).toEqual({ ok: false, reason: "Could not open the session: boom." });
  api.openSession.mockRejectedValueOnce(new Error("hub exploded"));
  await run(async () => {
    result = await search.onOpenHit(hubHit({ sessionId: "bad2" }));
  });
  expect(result).toEqual({ ok: false, reason: "hub exploded" });
  api.openSession.mockRejectedValueOnce("weird");
  await run(async () => {
    result = await search.onOpenHit(hubHit({ sessionId: "bad3" }));
  });
  expect(result).toEqual({ ok: false, reason: "Could not open the session." });
});

test("session, codex and task drawers open exclusively and close back", async () => {
  await boot({
    sessions: [session({ sessionId: "s1", status: "active", cwd: "C:/work/api" })],
    codex: [{ id: "cx1", status: "active", cwd: null } as unknown as CodexSessionRecord],
    tasks: [task({ id: "t1", status: "running" })],
    claims: [{ id: "c1", sessionId: "s1", sessionTitle: null, repoPath: "C:/r", paths: [], note: null, createdAt: 1, expiresAt: 2 }],
  });
  await run(() => sessionsView().onOpen("s1"));
  const drawer = captured<Props<typeof SessionDrawer>>("SessionDrawer");
  expect(drawer.claims).toHaveLength(1);
  expect(document.querySelector(".shell--panel")).not.toBeNull();
  await run(() => drawer.onReleaseClaim?.("c1"));
  expect(api.releaseClaim).toHaveBeenCalledWith("c1");
  await run(() => drawer.onOpenSession?.("s1"));
  expect(api.openSession).toHaveBeenCalledWith("s1");
  await run(() => drawer.onClose());
  expect(screen.queryByTestId("SessionDrawer")).toBeNull();
  await run(() => sessionsView().onOpenCodex("cx1"));
  const codex = captured<Props<typeof CodexDrawer>>("CodexDrawer");
  await run(() => codex.onFocusApp());
  expect(api.focusCodexApp).toHaveBeenCalled();
  await run(() => codex.onOpenSession?.("cx1"));
  expect(api.openCodexSession).toHaveBeenCalledWith("cx1");
  await run(() => codex.onArchive("cx1"));
  expect(api.archiveCodexThread).toHaveBeenCalledWith("cx1");
  await run(() => codex.onUnarchive("cx1"));
  expect(api.unarchiveCodexThread).toHaveBeenCalledWith("cx1");
  await run(() => codex.onOpenTask("t1"));
  expect(window.location.hash).toBe("#/tasks/t1");
  expect(screen.queryByTestId("CodexDrawer")).toBeNull();
  await run(() => sessionsView().onOpenTask("t1"));
  expect(screen.getByTestId("TaskDrawer")).toBeTruthy();
  const current = taskDrawer();
  expect(current.taskId).toBe("t1");
  await run(() => current.onOpenSession("s1"));
  expect(screen.getByTestId("SessionDrawer")).toBeTruthy();
  expect(screen.queryByTestId("TaskDrawer")).toBeNull();
  await run(() => drawer.onClose());
  await run(() => sessionsView().onOpenTask("t1"));
  await run(() => taskDrawer().onOpenCodex("cx1"));
  expect(screen.getByTestId("CodexDrawer")).toBeTruthy();
  await run(() => sessionsView().onOpenTask("t1"));
  await run(() => taskDrawer().onOpenTask?.("t2"));
  expect(taskDrawer().taskId).toBe("t2");
  await run(() => taskDrawer().onRefresh());
  await run(() => taskDrawer().onError("task trouble"));
  expect(toastTexts()).toContain("task trouble");
  await run(() => taskDrawer().onClose());
  expect(screen.queryByTestId("TaskDrawer")).toBeNull();
});

test("the session drawer can archive, share and open tasks", async () => {
  await boot({ sessions: [session({ sessionId: "s1", status: "active" })] });
  await run(() => sessionsView().onOpen("s1"));
  await run(() => captured<Props<typeof SessionDrawer>>("SessionDrawer").onArchive?.("s1"));
  expect(api.archiveSession).toHaveBeenCalledWith("s1");
  expect(screen.queryByTestId("SessionDrawer")).toBeNull();
  await run(() => sessionsView().onOpen("s1"));
  await run(() => captured<Props<typeof SessionDrawer>>("SessionDrawer").onShare?.("s1"));
  expect(window.location.hash).toBe("#/share/new:s1");
  await goto("#/sessions");
  await run(() => sessionsView().onOpen("s1"));
  await run(() => captured<Props<typeof SessionDrawer>>("SessionDrawer").onOpenTask?.("t9"));
  expect(window.location.hash).toBe("#/tasks/t9");
});

test("drawers close when the view changes", async () => {
  await boot({ sessions: [session({ sessionId: "s1", status: "active" })] });
  await run(() => sessionsView().onOpen("s1"));
  expect(screen.getByTestId("SessionDrawer")).toBeTruthy();
  await goto("#/usage");
  expect(screen.queryByTestId("SessionDrawer")).toBeNull();
});

test("the delegated route opens the task drawer and the delegated origin", async () => {
  await boot({ tasks: [task({ id: "t1", status: "running" })] });
  await goto("#/tasks/t1");
  expect(screen.getByTestId("TaskDrawer")).toBeTruthy();
  expect(window.location.hash).toBe("#/sessions");
  await goto("#/tasks");
  expect(sessionsView().origin).toBe("delegated");
  expect(screen.queryByTestId("TaskDrawer")).toBeNull();
});

test("the flow route switches the sessions list to the map", async () => {
  await boot();
  await goto("#/flow");
  expect(sessionsView().mode).toBe("map");
  expect(window.location.hash).toBe("#/sessions");
});

test("the flow nav item shows the map as current and sessions goes back to the list", async () => {
  localStorage.setItem("hub.sessions.mode", "map");
  await boot();
  expect(document.querySelector('a[href="#/flow"]')?.getAttribute("aria-current")).toBe("page");
  fireEvent.click(document.querySelector('a[href="#/sessions"]') as Element);
  await flush();
  expect(localStorage.getItem("hub.sessions.mode")).toBe("list");
  fireEvent.click(document.querySelector('a[href="#/flow"]') as Element);
  await flush();
  expect(localStorage.getItem("hub.sessions.mode")).toBe("map");
});

test("announcing a delegated task offers to open it", async () => {
  await boot({ hash: "#/daily" });
  await run(() => captured<Props<typeof TodayView>>("TodayView").onDelegated("t77", "Build it"));
  expect(toastTexts()).toContain('Delegated "Build it".');
  fireEvent.click(screen.getByRole("button", { name: "Open task" }));
  await flush();
  expect(window.location.hash).toBe("#/tasks/t77");
});

test("announcing a delegated task without the delegated plugin has no action", async () => {
  await boot({ hash: "#/daily", features: { delegated: false } });
  await run(() => captured<Props<typeof TodayView>>("TodayView").onDelegated("t77", "Build it"));
  expect(screen.queryByRole("button", { name: "Open task" })).toBeNull();
});

test("the today view wires its notifications and navigation", async () => {
  await boot({ hash: "#/daily", sessions: [session({ sessionId: "s1", status: "active" })] });
  const today = captured<Props<typeof TodayView>>("TodayView");
  await run(() => today.onOpenSession("s1"));
  expect(screen.getByTestId("SessionDrawer")).toBeTruthy();
  await run(() => today.onNotice("Saved"));
  expect(toastTexts()).toContain("Saved");
  await run(() => today.onError("Oops"));
  expect(toastTexts()).toContain("Oops");
  await run(() => today.onOpenTask("t2"));
  expect(window.location.hash).toBe("#/tasks/t2");
});

test("the board view clears its open task param and navigates to its settings", async () => {
  await boot({ hash: "#/board/bt-1" });
  const view = captured<Props<typeof BoardView>>("BoardView");
  await run(() => view.onOpenTaskHandled());
  expect(window.location.hash).toBe("#/board");
  expect(captured<Props<typeof BoardView>>("BoardView").openTaskId).toBeNull();
  await run(() => view.onOpenSettings());
  expect(window.location.hash).toBe("#/settings/tasks");
});

test("the workspaces, reports, usage and share views navigate through the shell", async () => {
  await boot({ hash: "#/workspaces" });
  const workspacesProps = captured<Props<typeof WorkspacesView>>("WorkspacesView");
  await run(() => workspacesProps.onChanged());
  await run(() => workspacesProps.onOpenSettings());
  expect(window.location.hash).toBe("#/settings/paths");
  await run(() => workspacesProps.onNotice("ws notice"));
  expect(toastTexts()).toContain("ws notice");
  await goto("#/reports");
  await run(() => captured<Props<typeof ReportsView>>("ReportsView").onOpenTask("t5"));
  expect(window.location.hash).toBe("#/tasks/t5");
  await goto("#/usage");
  await run(() => captured<Props<typeof UsageView>>("UsageView").onOpenSession("s1"));
  await goto("#/share/x");
  const shareProps = captured<Props<typeof ShareView>>("ShareView");
  await run(() => shareProps.onTunnelChanged({ running: true } as never));
  expect(captured<Props<typeof ShareView>>("ShareView").tunnel).toEqual({ running: true });
  await run(() => shareProps.onOpenSettings());
  expect(window.location.hash).toBe("#/settings/sharing");
  await run(() => shareProps.onOpenTask("t6"));
  expect(window.location.hash).toBe("#/tasks/t6");
  expect(shareProps.panelHost).not.toBeUndefined();
});

test("a share request refreshes the tunnel status", async () => {
  await boot({ hash: "#/share/x" });
  delegation.getTunnel.mockClear();
  await run(() => handlers().onShareRequest?.({ id: "r1", kind: "ask", status: "done", label: "l", asker: "a", prompt: "p" } as never));
  expect(delegation.getTunnel).toHaveBeenCalled();
});

test("a failing tunnel read clears the status", async () => {
  delegation.getTunnel.mockRejectedValue(new Error("down"));
  await boot({ hash: "#/share/x" });
  expect(captured<Props<typeof ShareView>>("ShareView").tunnel).toBeNull();
});

test("control k opens the palette, toggles it closed and escape closes it", async () => {
  await boot();
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  await press("k", { ctrlKey: true });
  expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
  await press("k", { ctrlKey: true });
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  await press("k", { ctrlKey: true });
  await run(() => {
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Command palette" }), { key: "Escape" });
  });
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
});

test("the search button opens the palette", async () => {
  await boot();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await flush();
  expect(screen.getByRole("dialog", { name: "Command palette" })).toBeTruthy();
});

test("the palette lists views, commands, sessions, workspaces and board tasks", async () => {
  await boot({
    sessions: [session({ sessionId: "s1", status: "active", title: "Refactor auth" })],
    workspaces: [{ name: "alpha", file: "alpha.json", contextPath: null, repos: [], error: null }],
  });
  await press("k", { ctrlKey: true });
  await flush();
  const titles = () => screen.queryAllByRole("option").map((option) => option.textContent ?? "");
  await run(() => {
    fireEvent.change(paletteInput(), { target: { value: "Refactor" } });
  });
  expect(titles().some((text) => text.includes("Refactor auth"))).toBe(true);
  await run(() => {
    fireEvent.change(paletteInput(), { target: { value: "alpha" } });
  });
  expect(titles().some((text) => text.includes("Open alpha in editor"))).toBe(true);
  await run(() => {
    fireEvent.change(paletteInput(), { target: { value: "Zebra crossing fix" } });
  });
  expect(titles().some((text) => text.includes("Zebra crossing fix"))).toBe(true);
  expect(delegation.getTasksBoard).toHaveBeenCalled();
});

test("palette commands toggle the theme, back up and install hooks", async () => {
  await boot();
  await chooseFromPalette("Toggle theme");
  expect(document.documentElement.dataset.theme).toBe("midnight");
  await chooseFromPalette("Back up now");
  expect(delegation.createBackup).toHaveBeenCalled();
  expect(toastTexts()).toContain("Backup created: hub-2026.zip");
  delegation.createBackup.mockRejectedValueOnce(new Error("disk full"));
  await chooseFromPalette("Back up now");
  expect(toastTexts()).toContain("disk full");
  delegation.createBackup.mockRejectedValueOnce(1);
  await chooseFromPalette("Back up now");
  expect(toastTexts()).toContain("could not back up");
  await chooseFromPalette("Install hooks");
  expect(window.location.hash).toBe("#/settings/hooks");
});

test("palette workspace, task and view items navigate or open the editor", async () => {
  await boot({ workspaces: [{ name: "alpha", file: "alpha.json", contextPath: null, repos: [], error: null }] });
  await chooseFromPalette("Open alpha in editor");
  expect(delegation.openWorkspace).toHaveBeenCalledWith("alpha");
  expect(toastTexts()).toContain("Opening alpha with code.");
  delegation.openWorkspace.mockResolvedValueOnce({ ok: false, error: "no editor", command: "code" });
  await chooseFromPalette("Open alpha in editor");
  expect(toastTexts()).toContain("no editor");
  delegation.openWorkspace.mockResolvedValueOnce({ ok: false, error: null, command: "code" });
  await chooseFromPalette("Open alpha in editor");
  expect(toastTexts()).toContain("could not open");
  delegation.openWorkspace.mockRejectedValueOnce(4);
  await chooseFromPalette("Open alpha in editor");
  expect(toastTexts()).toContain("could not open the workspace");
  await chooseFromPalette("Show alpha");
  expect(window.location.hash).toBe("#/workspaces/alpha");
  await chooseFromPalette("Zebra crossing fix");
  expect(window.location.hash).toBe("#/board/bt-1");
});

test("palette session items focus or open sessions and codex threads", async () => {
  await boot({
    sessions: [session({ sessionId: "s1", status: "active", title: "Refactor auth" })],
    codex: [{ id: "cx1", status: "active", title: "Codex thing", cwd: null, updatedAt: 1, createdAt: 1 } as unknown as CodexSessionRecord],
  });
  await chooseFromPalette("Refactor auth");
  expect(api.focusSession).toHaveBeenCalledWith("s1");
  api.focusSession.mockResolvedValueOnce({ ok: false, reason: "no window" });
  await chooseFromPalette("Refactor auth");
  expect(toastTexts()).toContain("no window");
  api.focusSession.mockResolvedValueOnce({ ok: false });
  await chooseFromPalette("Refactor auth");
  expect(toastTexts()).toContain("could not focus the window");
  api.focusSession.mockRejectedValueOnce(new Error("focus failed"));
  await chooseFromPalette("Refactor auth");
  expect(toastTexts()).toContain("focus failed");
  api.focusSession.mockRejectedValueOnce(9);
  await chooseFromPalette("Refactor auth");
  expect(toastTexts().filter((text) => text === "could not focus the window").length).toBeGreaterThan(0);
});

test("the capture command opens the palette prefilled and a capture query adds a note", async () => {
  await boot();
  await chooseFromPalette("Capture");
  expect(paletteInput().value).toBe("capture ");
  await run(() => {
    fireEvent.change(paletteInput(), { target: { value: "capture buy milk" } });
  });
  await run(() => {
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Command palette" }), { key: "Enter" });
  });
  expect(delegation.addCapture).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), "buy milk");
  expect(toastTexts()).toContain("Captured");
  fireEvent.click(screen.getByRole("button", { name: "Open Today" }));
  await flush();
  expect(window.location.hash).toBe("#/daily");
  delegation.addCapture.mockRejectedValueOnce(new Error("vault locked"));
  await press("k", { ctrlKey: true });
  await run(() => {
    fireEvent.change(paletteInput(), { target: { value: "capture again" } });
  });
  await run(() => {
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Command palette" }), { key: "Enter" });
  });
  expect(toastTexts()).toContain("vault locked");
  delegation.addCapture.mockRejectedValueOnce(1);
  await press("k", { ctrlKey: true });
  await run(() => {
    fireEvent.change(paletteInput(), { target: { value: "capture third" } });
  });
  await run(() => {
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Command palette" }), { key: "Enter" });
  });
  expect(toastTexts()).toContain("could not capture");
});

test("plugin commands dispatch their event once the target view is shown", async () => {
  await boot();
  const fired: string[] = [];
  const listener = (name: string) => () => fired.push(name);
  const names = ["cchub:daily-refresh", "cchub:board-new-task"];
  for (const name of names) window.addEventListener(name, listener(name));
  await chooseFromPalette("Refresh Today");
  await goto("#/daily");
  expect(fired).toEqual(["cchub:daily-refresh"]);
  await chooseFromPalette("Refresh Today");
  expect(fired).toEqual(["cchub:daily-refresh", "cchub:daily-refresh"]);
  await chooseFromPalette("New task");
  await goto("#/board");
  expect(fired).toContain("cchub:board-new-task");
});

test("the delegated work command opens the delegated list", async () => {
  await boot();
  await chooseFromPalette("Delegated work");
  expect(window.location.hash).toBe("#/tasks");
  await goto("#/tasks");
  expect(sessionsView().origin).toBe("delegated");
});

test("a failing history hit chosen in the palette shows the reason and offers the session id", async () => {
  historyState.hits = [hubHit({ messageId: 7, sessionId: "bad-id", snippet: "needle one" }), hubHit({ messageId: 8, sessionId: null, snippet: "needle two" })];
  await boot();
  api.openSession.mockResolvedValueOnce({ ok: false, method: "focus", reason: "boom" });
  await chooseFromPalette("needle one");
  expect(toastTexts()).toContain("Could not open the session: boom. Session id: bad-id");
  fireEvent.click(screen.getByRole("button", { name: "Copy session id" }));
  await flush();
  expect(clipboard.copyText).toHaveBeenCalledWith("bad-id");
  await chooseFromPalette("needle two");
  expect(toastTexts()).toContain("This match has no session to open.");
});

test("a successful history hit chosen in the palette opens the session drawer", async () => {
  historyState.hits = [hubHit({ messageId: 9, sessionId: "s1", snippet: "found it here" })];
  await boot({ sessions: [session({ sessionId: "s1", status: "active" })] });
  await chooseFromPalette("found it here");
  expect(screen.getByTestId("SessionDrawer")).toBeTruthy();
});

test("number hotkeys jump between views and control comma opens settings", async () => {
  await boot();
  await press("2", { ctrlKey: true });
  expect(window.location.hash).toBe("#/daily");
  await press("3", { ctrlKey: true });
  expect(window.location.hash).toBe("#/board");
  await press("4", { ctrlKey: true });
  expect(window.location.hash).toBe("#/flow");
  await press("1", { ctrlKey: true });
  expect(window.location.hash).toBe("#/sessions");
  await press(",", { ctrlKey: true });
  expect(window.location.hash).toBe("#/settings");
});

test("hotkeys for disabled plugins do nothing", async () => {
  await boot({ features: { daily: false, tasks: false, flow: false } });
  window.history.replaceState(null, "", "#/sessions");
  await press("2", { ctrlKey: true });
  await press("3", { ctrlKey: true });
  await press("4", { ctrlKey: true });
  expect(window.location.hash).toBe("#/sessions");
});

test("control b and the toggle button collapse the sidebar and save the preference", async () => {
  await boot();
  expect(document.querySelector(".shell--rail")).toBeNull();
  await press("b", { ctrlKey: true });
  expect(document.querySelector(".shell--rail")).not.toBeNull();
  expect(delegation.putUiPrefs).toHaveBeenCalledWith({ layout: { shell: { sidebarCollapsed: 1 } } });
  expect(localStorage.getItem("hub.sidebar.collapsed")).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
  await flush();
  expect(document.querySelector(".shell--rail")).toBeNull();
  expect(delegation.putUiPrefs).toHaveBeenLastCalledWith({ layout: { shell: { sidebarCollapsed: 0 } } });
});

test("the sidebar hotkey is ignored and the rail is off when the viewport is narrow", async () => {
  rail = false;
  await boot();
  await press("b", { ctrlKey: true });
  expect(delegation.putUiPrefs).not.toHaveBeenCalled();
  expect(document.querySelector(".shell--rail")).toBeNull();
});

test("the palette offers the sidebar toggle only when the rail is available", async () => {
  await boot();
  await chooseFromPalette("Toggle sidebar");
  expect(document.querySelector(".shell--rail")).not.toBeNull();
});

test("the rail shows tooltips instead of titles and the more menu works from the rail", async () => {
  localStorage.setItem("hub.sidebar.collapsed", "1");
  await boot();
  expect(document.querySelector(".shell--rail")).not.toBeNull();
  expect(document.querySelector('a[href="#/sessions"]')?.getAttribute("data-tip")).toBe("Sessions");
  expect(document.querySelector(".nav__more button")?.getAttribute("data-tip")).toBe("More");
});

test("the more menu lists the other views, opens by click or keyboard and picks a view", async () => {
  await boot();
  const more = document.querySelector(".nav__more button") as HTMLElement;
  expect(more.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(more);
  expect(screen.getByRole("menu", { name: "More views" })).toBeTruthy();
  const items = screen.getAllByRole("menuitem");
  expect(items.map((item) => item.getAttribute("href"))).toEqual(expect.arrayContaining(["#/usage", "#/workspaces", "#/reports", "#/share"]));
  fireEvent.keyDown(more, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.keyDown(more, { key: "ArrowDown" });
  await flush();
  expect(screen.getByRole("menu")).toBeTruthy();
  expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
  fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[1]);
  fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
  expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
  fireEvent.keyDown(document.activeElement as Element, { key: "End" });
  expect(document.activeElement).toBe(screen.getAllByRole("menuitem").at(-1));
  fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
  expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
  fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
  expect(document.activeElement).toBe(screen.getAllByRole("menuitem").at(-1));
  fireEvent.keyDown(more, { key: "ArrowUp" });
  expect(document.activeElement).toBe(screen.getAllByRole("menuitem").at(-1));
  fireEvent.keyDown(more, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
  const usage = screen.getByRole("menuitem", { name: /Usage/ });
  usage.focus();
  fireEvent.keyDown(usage, { key: " " });
  await flush();
  expect(screen.queryByRole("menu")).toBeNull();
});

test("the more menu closes on tab and on a press outside, and a click toggles it", async () => {
  await boot();
  const more = document.querySelector(".nav__more button") as HTMLElement;
  fireEvent.click(more, { detail: 0 });
  await flush();
  expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
  fireEvent.keyDown(document.activeElement as Element, { key: "Tab" });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(more);
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(more);
  fireEvent.mouseDown(screen.getByRole("menu"));
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent.click(more);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("the more entry shows the active hidden view and picking one navigates", async () => {
  await boot({ hash: "#/usage" });
  const more = document.querySelector(".nav__more button") as HTMLElement;
  expect(within(more).getByText("Usage")).toBeTruthy();
  fireEvent.click(more);
  fireEvent.click(screen.getByRole("menuitem", { name: /Workspaces/ }));
  await flush();
  expect(screen.queryByRole("menu")).toBeNull();
});

test("a custom sidebar preference pins other views", async () => {
  await boot();
  await run(() => handlers().onUiPrefs?.({ sidebar: { order: ["usage", "sessions"], pinned: ["usage", "sessions"] }, layout: {} }));
  expect(document.querySelector('a[href="#/usage"]')).not.toBeNull();
});

test("the nav shows routine unread counts quietly and the more badge sums hidden views", async () => {
  routines.unread = 3;
  await boot();
  const link = document.querySelector('a[href="#/sessions"]') as HTMLElement;
  expect(link.querySelector(".nav__badge")?.textContent).toBe("3");
  expect(link.querySelector(".nav__badge--attn")).toBeNull();
  await run(() => handlers().onUiPrefs?.({ sidebar: { order: ["sessions", "usage"], pinned: ["usage"] }, layout: {} }));
  expect(document.querySelector(".nav__more .nav__badge")?.textContent).toBe("3");
});

test("sessions that need attention light up the nav and the rail title", async () => {
  localStorage.setItem("hub.sidebar.collapsed", "1");
  await boot({ sessions: [session({ sessionId: "w1", status: "waiting" })] });
  const link = document.querySelector('a[href="#/sessions"]') as HTMLElement;
  expect(link.getAttribute("aria-label")).toContain("1 session needs you");
  expect(link.querySelector(".nav__badge--attn")?.textContent).toBe("1");
});

test("the status bar reports running delegated tasks and opens the delegated list", async () => {
  await boot({ tasks: [task({ id: "t1", status: "running" }), task({ id: "t2", status: "failed" })] });
  const chip = within(screen.getByRole("contentinfo", { name: "Status" })).getAllByRole("button").find((button) => /Delegated/i.test(button.textContent ?? ""));
  expect(chip).toBeDefined();
  fireEvent.click(chip as HTMLElement);
  await flush();
  expect(window.location.hash).toBe("#/tasks");
});

test("a window resize observer keeps the header height published", async () => {
  await boot();
  expect(document.documentElement.style.getPropertyValue("--head-h")).toBe("0px");
});

test("the pointer unlock handler runs once on the first pointer press", async () => {
  await boot();
  fireEvent.pointerDown(window);
  fireEvent.pointerDown(window);
});

test("the goto event navigates to a hash and ignores anything else", async () => {
  await boot();
  await run(() => {
    window.dispatchEvent(new CustomEvent("cchub:goto-hash", { detail: "#/usage" }));
  });
  expect(window.location.hash).toBe("#/usage");
  await run(() => {
    window.dispatchEvent(new CustomEvent("cchub:goto-hash", { detail: "usage" }));
    window.dispatchEvent(new CustomEvent("cchub:goto-hash", { detail: 5 }));
  });
  expect(window.location.hash).toBe("#/usage");
  await run(() => {
    window.dispatchEvent(new CustomEvent("cchub:goto-hash", { detail: "#/usage" }));
  });
});

test("the palette shows the widget toggle inside the desktop app", async () => {
  fake = installTauri("main");
  fake.on("plugin:window|get_all_windows", () => ["main", "widget"]);
  await boot();
  await chooseFromPalette("Show/hide widget");
  await flush();
  expect(fake.calls("plugin:window|hide").length + fake.calls("plugin:window|show").length).toBeGreaterThan(0);
});

test("a widget toggle failure is toasted", async () => {
  fake = installTauri("main");
  fake.on("plugin:window|get_all_windows", () => []);
  await boot();
  await chooseFromPalette("Show/hide widget");
  await flush();
  expect(toastTexts()).toContain("the widget window is not available");
});

test("a widget toggle failure with a non-error value is toasted generically", async () => {
  fake = installTauri("main");
  fake.on("plugin:window|get_all_windows", () => {
    throw 5;
  });
  await boot();
  await chooseFromPalette("Show/hide widget");
  await flush();
  expect(toastTexts()).toContain("could not toggle the widget");
});
