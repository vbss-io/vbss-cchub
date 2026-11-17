import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HubEvents } from "../api";
import type { DelegationSettings, LimitsSnapshot, TaskRecord, UsageSummary } from "../delegation";
import { installTauri, removeTauri, type MonitorFake, type TauriFake } from "../test-support/u3-tauri";
import { limitsSnapshot, permission, session, settings, task } from "../test-support/u3-fixtures";
import type { LimitsForecast, WindowForecast, PermissionRequestRecord, PermissionRequestSummary, SessionRecord } from "../types";

const realSetTimeout = globalThis.setTimeout.bind(globalThis);

const hub = vi.hoisted(() => ({ handlers: null as HubEvents | null, unsubscribe: vi.fn() }));
const api = vi.hoisted(() => ({
  hubBase: "http://127.0.0.1:4317",
  fetchSessions: vi.fn<() => Promise<SessionRecord[]>>(),
  focusSession: vi.fn(async () => ({ ok: true })),
  reportUiError: vi.fn(async () => undefined),
  subscribe: vi.fn((handlers: HubEvents) => {
    hub.handlers = handlers;
    return hub.unsubscribe;
  }),
  fetchPermissions: vi.fn<() => Promise<PermissionRequestRecord[]>>(),
  decidePermission: vi.fn(async () => "done"),
  releasePermission: vi.fn(async () => "done"),
  openSession: vi.fn(async () => ({ ok: true })),
}));
const delegation = vi.hoisted(() => ({
  fetchLimits: vi.fn<() => Promise<LimitsSnapshot | null>>(),
  fetchUsageSummary: vi.fn<() => Promise<unknown>>(),
  getSettings: vi.fn<() => Promise<DelegationSettings>>(),
  listTasks: vi.fn<() => Promise<TaskRecord[]>>(),
  updateSettings: vi.fn<(patch: unknown) => Promise<DelegationSettings>>(),
}));
const ops = vi.hoisted(() => ({ forecast: null as LimitsForecast | null }));

vi.mock("../api", () => api);
vi.mock("../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../delegation")>()), ...delegation }));
vi.mock("../use-ops", () => ({ useLimitsForecast: () => ops.forecast }));

import { Widget } from "./Widget";

const handlers = (): HubEvents => {
  if (!hub.handlers) throw new Error("not subscribed");
  return hub.handlers;
};

let fake: TauriFake | null = null;

const monitor = (overrides: Partial<MonitorFake> = {}): MonitorFake => ({
  scaleFactor: 1,
  position: { x: 0, y: 0 },
  size: { width: 1920, height: 1080 },
  workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
  ...overrides,
});

const setTauri = (): TauriFake => {
  fake = installTauri("widget");
  fake.on("plugin:window|current_monitor", () => monitor());
  fake.on("plugin:window|get_all_windows", () => ["main", "widget"]);
  return fake;
};

const tauriFake = (): TauriFake => {
  if (!fake) throw new Error("tauri not installed");
  return fake;
};

const flush = () =>
  act(async () => {
    await new Promise<void>((resolve) => realSetTimeout(resolve, 25));
  });

const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
    await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
  });

const usageSummary = (): UsageSummary => ({
  days: 7,
  providers: {
    claude: { today: { read: 1500, output: 500, messages: 12 }, week: { read: 20_000, output: 4_000 } },
    codex: null,
  },
});

interface Boot {
  settings?: DelegationSettings;
  sessions?: SessionRecord[];
  tasks?: TaskRecord[];
}

const boot = async (options: Boot = {}) => {
  delegation.getSettings.mockResolvedValue(options.settings ?? settings());
  api.fetchSessions.mockResolvedValue(options.sessions ?? []);
  delegation.listTasks.mockResolvedValue(options.tasks ?? []);
  const view = render(<Widget />);
  await flush();
  return view;
};

const openPanel = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Open CC Hub widget" }));
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
  hub.handlers = null;
  hub.unsubscribe.mockClear();
  for (const fn of Object.values(api)) if (typeof fn !== "string") fn.mockClear();
  for (const fn of Object.values(delegation)) fn.mockReset();
  api.fetchPermissions.mockResolvedValue([]);
  api.focusSession.mockResolvedValue({ ok: true });
  delegation.fetchLimits.mockResolvedValue(limitsSnapshot());
  delegation.fetchUsageSummary.mockResolvedValue(usageSummary());
  delegation.updateSettings.mockResolvedValue(settings());
  ops.forecast = null;
  localStorage.clear();
  removeTauri();
  fake = null;
});

afterEach(() => {
  cleanup();
  removeTauri();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("shows a connecting state until the settings arrive", async () => {
  delegation.getSettings.mockReturnValue(new Promise(() => undefined));
  api.fetchSessions.mockResolvedValue([]);
  delegation.listTasks.mockResolvedValue([]);
  render(<Widget />);
  await flush();
  expect(screen.getByText("Connecting to the hub...")).toBeTruthy();
  expect(document.querySelector(".wgd")?.getAttribute("data-widget-enabled")).toBe("pending");
});

test("retries loading the settings every three seconds", async () => {
  delegation.getSettings.mockRejectedValueOnce(new Error("down")).mockResolvedValue(settings());
  api.fetchSessions.mockResolvedValue([]);
  delegation.listTasks.mockResolvedValue([]);
  render(<Widget />);
  await flush();
  expect(screen.getByText("Connecting to the hub...")).toBeTruthy();
  await advance(3000);
  await flush();
  expect(screen.getByRole("button", { name: "Open CC Hub widget" })).toBeTruthy();
});

test("a disabled widget offers to turn itself on and opens the panel optimistically", async () => {
  await boot({ settings: settings({ widget: false }) });
  expect(screen.getByText("Widget is off")).toBeTruthy();
  expect(document.querySelector(".wgd")?.getAttribute("data-widget-enabled")).toBe("0");
  delegation.updateSettings.mockResolvedValue(settings({ widget: true }));
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  await flush();
  expect(delegation.updateSettings).toHaveBeenCalledWith({ features: { widget: true } });
  expect(document.querySelector(".wgd")?.getAttribute("data-widget-enabled")).toBe("1");
  expect(screen.getByRole("tab", { name: /Sessions/ })).toBeTruthy();
});

test("a failed turn on shows the reason and keeps the off state", async () => {
  await boot({ settings: settings({ widget: false }) });
  delegation.updateSettings.mockRejectedValue(new Error("hub refused"));
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  await flush();
  expect(screen.getByText("Could not turn it on: hub refused")).toBeTruthy();
  expect(screen.getByText("Widget is off")).toBeTruthy();
});

test("open settings jumps to the plugins settings in a new tab", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await boot({ settings: settings({ widget: false }) });
  fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
  await flush();
  expect(open).toHaveBeenCalledWith(expect.stringContaining("#/settings/plugins"), "_blank", "noopener");
});

test("the collapsed tab counts sessions that need the user and the panel opens on click", async () => {
  await boot({ sessions: [session({ sessionId: "s1", status: "waiting", title: "Waiting one" }), session({ sessionId: "s2", status: "active", title: "Busy one" })] });
  const tab = screen.getByRole("button", { name: "Open CC Hub widget" });
  expect(tab.querySelector(".wgd-pip")?.textContent).toBe("1");
  expect(tab.querySelector(".wgd-pip")?.getAttribute("title")).toBe("1 need you");
  fireEvent.click(tab);
  await flush();
  expect(screen.getByLabelText("Collapse widget")).toBeTruthy();
  const state = document.querySelector(".wgd-state") as HTMLElement;
  expect(state.textContent).toBe("2 live · 0 idle · 1 need you");
  expect(within(document.querySelector(".wg-sec--needs") as HTMLElement).getByText("Waiting one")).toBeTruthy();
  expect(within(document.querySelector(".wg-sec--running") as HTMLElement).getByText("Busy one")).toBeTruthy();
});

test("an empty hub says it is quiet", async () => {
  await boot();
  await openPanel();
  expect(screen.getByText("All quiet, nothing running right now.")).toBeTruthy();
  expect(document.querySelector(".wgd-pip")).toBeNull();
});

test("idle sessions are listed muted and the extra ones are counted", async () => {
  const many = Array.from({ length: 10 }, (_, index) => session({ sessionId: `idle-${index}`, status: "idle", title: `Idle ${index}`, seenAt: Date.now() + 1000, unread: false }));
  await boot({ sessions: many });
  await openPanel();
  const section = document.querySelector(".wg-sec--idle") as HTMLElement;
  expect(within(section).getAllByRole("button")).toHaveLength(8);
  expect(within(section).getByText("+2 more")).toBeTruthy();
  expect(section.querySelector(".wg-row--muted")).not.toBeNull();
});

test("a favorite session shows a star, a custom title wins and clicking a row focuses the session and collapses", async () => {
  await boot({ sessions: [session({ sessionId: "fav", status: "active", title: "Plain", customTitle: "Renamed", favoriteAt: 5, cwd: "C:/work/api" })] });
  await openPanel();
  const row = screen.getByRole("button", { name: /Renamed/ });
  expect(within(row).getByRole("img", { name: "Favorite" })).toBeTruthy();
  expect(row.getAttribute("title")).toBe("Renamed\nC:/work/api");
  fireEvent.click(row);
  await flush();
  expect(api.focusSession).toHaveBeenCalledWith("fav");
  expect(screen.getByRole("button", { name: "Open CC Hub widget" })).toBeTruthy();
});

test("ended, archived, hub-run and empty sessions are not shown", async () => {
  await boot({
    sessions: [
      session({ sessionId: "e", status: "ended", title: "Ended one" }),
      session({ sessionId: "a", status: "active", title: "Archived one", archivedAt: 1 }),
      session({ sessionId: "h", status: "active", title: "Hub run", client: "hub" }),
      session({ sessionId: "ok", status: "active", title: "Kept one" }),
    ],
  });
  await openPanel();
  expect(screen.queryByText("Ended one")).toBeNull();
  expect(screen.queryByText("Archived one")).toBeNull();
  expect(screen.queryByText("Hub run")).toBeNull();
  expect(screen.getByText("Kept one")).toBeTruthy();
});

test("delegated tasks appear in their sections and open the task in the hub", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await boot({
    tasks: [
      task({ id: "t-fail", title: "Failing task", status: "failed", updatedAt: Date.now() - 1000 }),
      task({ id: "t-att", title: "Attention task", status: "attention" }),
      task({ id: "t-run", title: "Running task", status: "running", runner: "codex", isolation: "worktree", branch: "feat/x" }),
      task({ id: "t-done", title: "Done task", status: "completed", updatedAt: Date.now() - 60_000 }),
      task({ id: "t-old", title: "Old done", status: "completed", updatedAt: Date.now() - 7_200_000 }),
      task({ id: "t-arch", title: "Archived task", status: "running", archivedAt: 1 }),
    ],
  });
  expect(screen.getByRole("button", { name: "Open CC Hub widget" }).querySelector(".wgd-pip")?.textContent).toBe("2");
  await openPanel();
  expect(within(document.querySelector(".wg-sec--needs") as HTMLElement).getAllByRole("button")).toHaveLength(2);
  expect(within(document.querySelector(".wg-sec--delegated") as HTMLElement).getByText("Running task")).toBeTruthy();
  expect(within(document.querySelector(".wg-sec--delegated") as HTMLElement).getByRole("img", { name: "Codex task" })).toBeTruthy();
  expect(within(document.querySelector(".wg-sec--done") as HTMLElement).getByText("Done task")).toBeTruthy();
  expect(screen.queryByText("Old done")).toBeNull();
  expect(screen.queryByText("Archived task")).toBeNull();
  fireEvent.click(screen.getByText("Running task"));
  await flush();
  expect(open).toHaveBeenCalledWith(expect.stringContaining("#/tasks/t-run"), "_blank", "noopener");
});

test("delegated sections are hidden when the delegated plugin is off", async () => {
  await boot({ settings: settings({ delegated: false }), tasks: [task({ id: "t-run", title: "Running task", status: "running" })] });
  await openPanel();
  expect(screen.queryByText("Running task")).toBeNull();
  expect(screen.getByText("All quiet, nothing running right now.")).toBeTruthy();
});

test("hub events update sessions, tasks and settings live", async () => {
  await boot();
  act(() => handlers().onSession(session({ sessionId: "live-1", status: "active", title: "Live one" })));
  await openPanel();
  expect(screen.getByText("Live one")).toBeTruthy();
  act(() => handlers().onRemoved?.("live-1"));
  expect(screen.queryByText("Live one")).toBeNull();
  delegation.listTasks.mockResolvedValue([task({ id: "t-new", title: "New task", status: "running" })]);
  act(() => handlers().onDelegation?.("t-new"));
  await flush();
  expect(screen.getByText("New task")).toBeTruthy();
  act(() => handlers().onSettings?.(settings({}, { widget: { edge: "left", rings: { claude: false, codex: false }, panel: "sessions", autostart: true } })));
  expect(document.querySelector(".wgd")?.getAttribute("data-edge")).toBe("left");
});

test("an invalid edge falls back to the right edge and a widget feature flag of false turns it off", async () => {
  await boot({ settings: settings({}, { widget: { edge: "bottom", rings: { claude: false, codex: false }, panel: "sessions", autostart: true } as unknown as DelegationSettings["widget"] }) });
  expect(document.querySelector(".wgd")?.getAttribute("data-edge")).toBe("right");
  act(() => handlers().onSettings?.(settings({ widget: false })));
  expect(screen.getByText("Widget is off")).toBeTruthy();
});

test("reconnecting reloads the settings and the approvals", async () => {
  await boot();
  delegation.getSettings.mockClear();
  api.fetchPermissions.mockClear();
  act(() => handlers().onOpen?.());
  await flush();
  expect(delegation.getSettings).toHaveBeenCalledTimes(1);
  expect(api.fetchPermissions).toHaveBeenCalled();
});

test("approvals are listed in the panel and codex approvals count as needing the user", async () => {
  await boot();
  const record = permission({ id: "ap-1", agent: "codex", sessionId: "cx-1", title: "Codex run", expiresAt: Date.now() + 600_000 });
  api.fetchPermissions.mockResolvedValue([record]);
  const { toolInput: _input, cwd: _cwd, turnId: _turn, ...summary } = record;
  act(() => handlers().onPermissionRequest?.(summary as PermissionRequestSummary));
  await flush();
  expect(screen.getByRole("button", { name: "Open CC Hub widget" }).querySelector(".wgd-pip")?.textContent).toBe("1");
  await openPanel();
  const block = document.querySelector(".wg-sec--approvals") as HTMLElement;
  expect(within(block).getByText(/1 approval waiting/)).toBeTruthy();
  expect(within(block).getByRole("group", { name: "Permission request for Bash" })).toBeTruthy();
  act(() => handlers().onPermissionResolved?.({ id: "ap-1", agent: "codex", sessionId: "cx-1", outcome: "allow", at: 1 }));
  expect(document.querySelector(".wg-sec--approvals")).toBeNull();
});

test("the tabs switch to usage, remember the choice and load limits and usage", async () => {
  await boot();
  await openPanel();
  fireEvent.click(screen.getByRole("tab", { name: "Usage" }));
  await flush();
  expect(localStorage.getItem("widget.tab")).toBe("usage");
  expect(delegation.fetchLimits).toHaveBeenCalled();
  expect(delegation.fetchUsageSummary).toHaveBeenCalled();
  const cards = document.querySelectorAll(".wgd-card");
  expect(cards).toHaveLength(2);
  const claude = cards[0] as HTMLElement;
  expect(within(claude).getByText("Claude")).toBeTruthy();
  expect(within(claude).getByText("Read 1.5k · Output 500")).toBeTruthy();
  expect(within(claude).getByText("12 messages")).toBeTruthy();
  expect(within(claude).getByText("Last 7 days")).toBeTruthy();
  expect(within(claude).getAllByText(/^(42|85)%$/)).toHaveLength(2);
  expect(within(claude).getByText(/Opus/)).toBeTruthy();
  const codex = cards[1] as HTMLElement;
  expect(within(codex).getByText("No usage recorded.")).toBeTruthy();
  expect(within(codex).getAllByText(/^(10|20)%$/)).toHaveLength(2);
});

test("the stored tab preference is used and cleared when the configured panel changes", async () => {
  localStorage.setItem("widget.tab", "usage");
  await boot();
  await openPanel();
  expect(screen.getByRole("tab", { name: "Usage" }).getAttribute("aria-selected")).toBe("true");
  act(() => handlers().onSettings?.(settings({}, { widget: { edge: "right", rings: { claude: false, codex: false }, panel: "usage", autostart: true } })));
  act(() => handlers().onSettings?.(settings({}, { widget: { edge: "right", rings: { claude: false, codex: false }, panel: "sessions", autostart: true } })));
  expect(localStorage.getItem("widget.tab")).toBeNull();
  expect(screen.getByRole("tab", { name: /Sessions/ }).getAttribute("aria-selected")).toBe("true");
});

test("usage that is switched off, loading, missing or scanning explains itself", async () => {
  await boot({ settings: settings({ usage: false, limits: false }, { widget: { edge: "right", rings: { claude: false, codex: false }, panel: "usage", autostart: true } }) });
  await openPanel();
  expect(screen.getAllByText("Turn on Usage in Settings › Plugins to see tokens.")).toHaveLength(2);
  expect(screen.getAllByText("Turn on Limits in Settings › Plugins to see how much of your plan is left.")).toHaveLength(2);
});

test("a scanning usage summary shows the scanning note and a null one asks for a newer hub", async () => {
  delegation.fetchUsageSummary.mockResolvedValue({ scanning: true, startedAt: 1, files: 3 });
  delegation.fetchLimits.mockResolvedValue(null);
  await boot({ settings: settings({}, { widget: { edge: "right", rings: { claude: false, codex: false }, panel: "usage", autostart: true } }) });
  await openPanel();
  expect(screen.getAllByText("Scanning transcripts...").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Limits need a newer hub.")).toHaveLength(2);
  delegation.fetchUsageSummary.mockResolvedValue(null);
  fireEvent.mouseEnter(document.querySelector(".wgd-panel") as HTMLElement);
  await advance(3000);
  await flush();
  expect(screen.getAllByText("Usage needs a newer hub.")).toHaveLength(2);
});

test("limits without a login show the provider warning and gauges honour a window reset", async () => {
  const snapshot = limitsSnapshot();
  delegation.fetchLimits.mockResolvedValue({
    ...snapshot,
    claude: { source: "none", error: "no Claude Code login found", fiveHour: { utilization: 0, resetsAt: null }, sevenDay: { utilization: 0, resetsAt: null }, models: [] },
    codex: { source: "rollout", primary: { usedPercent: 5, resetsAt: null, reset: true }, secondary: { usedPercent: 120, resetsAt: null } },
  });
  ops.forecast = null;
  await boot({ settings: settings({}, { widget: { edge: "right", rings: { claude: false, codex: false }, panel: "usage", autostart: true } }) });
  await openPanel();
  expect(screen.getByText("no Claude Code login found")).toBeTruthy();
  expect(screen.getByText("reset · 0%")).toBeTruthy();
  expect(screen.getByText("100%")).toBeTruthy();
  expect(screen.getByText("reset time unknown")).toBeTruthy();
});

test("a codex provider without data says it is not tracked or has no session data", async () => {
  delegation.fetchLimits.mockResolvedValue({ updatedAt: 1, claude: null, codex: { source: "none", error: "", primary: { usedPercent: 0, resetsAt: null }, secondary: { usedPercent: 0, resetsAt: null } } });
  await boot({ settings: settings({}, { widget: { edge: "right", rings: { claude: false, codex: false }, panel: "usage", autostart: true } }) });
  await openPanel();
  expect(screen.getByText("no Codex session data found")).toBeTruthy();
  expect(screen.getByText("Limits are not tracked for Claude.")).toBeTruthy();
});

test("rings with weekly limits are drawn on the collapsed tab", async () => {
  await boot({ settings: settings({}, { widget: { edge: "right", rings: { claude: true, codex: true }, panel: "sessions", autostart: true } }) });
  const rings = document.querySelectorAll(".wgd-ring");
  expect(rings).toHaveLength(2);
  expect(rings[0]?.getAttribute("title")).toMatch(/^Claude 7 d: 85%/);
  expect(rings[1]?.getAttribute("title")).toMatch(/^Codex 7 d: 20%/);
  expect(rings[0]?.className).toContain("wgd-ring--");
});

test("the usage forecast line is shown when the hub has one", async () => {
  ops.forecast = {
    claude: { fiveHour: { exhaustsBeforeReset: true, exhaustsAt: Date.now() + 3_600_000 } as unknown as WindowForecast, sevenDay: null },
    codex: { primary: null, secondary: null },
  };
  await boot({ settings: settings({}, { widget: { edge: "right", rings: { claude: false, codex: false }, panel: "usage", autostart: true } }) });
  await openPanel();
  expect(screen.getByText(/At this pace the 5h window runs out at/)).toBeTruthy();
});

test("Escape collapses the open panel", async () => {
  await boot();
  await openPanel();
  fireEvent.keyDown(window, { key: "Escape" });
  await flush();
  expect(screen.getByRole("button", { name: "Open CC Hub widget" })).toBeTruthy();
  fireEvent.keyDown(window, { key: "a" });
});

test("the collapse button closes the panel", async () => {
  await boot();
  await openPanel();
  fireEvent.click(screen.getByLabelText("Collapse widget"));
  await flush();
  expect(screen.getByRole("button", { name: "Open CC Hub widget" })).toBeTruthy();
});

test("the panel collapses by itself after three seconds and leaving re-arms a shorter timer", async () => {
  await boot();
  await openPanel();
  await advance(2900);
  expect(screen.queryByRole("button", { name: "Open CC Hub widget" })).toBeNull();
  await advance(200);
  expect(screen.getByRole("button", { name: "Open CC Hub widget" })).toBeTruthy();
  await openPanel();
  const panel = document.querySelector(".wgd-panel") as HTMLElement;
  fireEvent.mouseEnter(panel);
  await advance(10_000);
  expect(screen.queryByRole("button", { name: "Open CC Hub widget" })).toBeNull();
  fireEvent.mouseMove(panel);
  fireEvent.mouseLeave(panel);
  await advance(1400);
  expect(screen.queryByRole("button", { name: "Open CC Hub widget" })).toBeNull();
  await advance(200);
  expect(screen.getByRole("button", { name: "Open CC Hub widget" })).toBeTruthy();
});

test("a focused text field or a typed answer keeps the panel open", async () => {
  await boot({ sessions: [session({ sessionId: "s1", status: "waiting", title: "Waiting one" })] });
  const record = permission({
    id: "ask-1",
    toolName: "AskUserQuestion",
    toolInput: { questions: [{ question: "Which?", header: "", multiSelect: false, options: [{ label: "a", description: "" }] }] },
    expiresAt: Date.now() + 600_000,
  });
  api.fetchPermissions.mockResolvedValue([record]);
  const { toolInput: _input, cwd: _cwd, turnId: _turn, ...summary } = record;
  act(() => handlers().onPermissionRequest?.(summary as PermissionRequestSummary));
  await flush();
  await openPanel();
  const field = screen.getByLabelText("Other answer for: Which?") as HTMLInputElement;
  field.focus();
  await advance(3100);
  expect(screen.queryByRole("button", { name: "Open CC Hub widget" })).toBeNull();
  field.blur();
  fireEvent.change(field, { target: { value: "draft" } });
  await advance(1600);
  expect(screen.queryByRole("button", { name: "Open CC Hub widget" })).toBeNull();
  fireEvent.change(field, { target: { value: "" } });
  await advance(1600);
  expect(screen.getByRole("button", { name: "Open CC Hub widget" })).toBeTruthy();
});

test("the footer opens the hub and the usage view", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await boot();
  await openPanel();
  fireEvent.click(screen.getByRole("button", { name: "Open hub" }));
  await flush();
  expect(open).toHaveBeenLastCalledWith(expect.stringContaining("#/sessions"), "_blank", "noopener");
  await openPanel();
  fireEvent.click(document.querySelector(".wgd-foot .wgd-link") as HTMLElement);
  await flush();
  expect(open).toHaveBeenLastCalledWith(expect.stringContaining("#/usage"), "_blank", "noopener");
});

test("unmounting unsubscribes from the hub", async () => {
  const view = await boot();
  view.unmount();
  expect(hub.unsubscribe).toHaveBeenCalledTimes(1);
});

test("inside the desktop app the widget docks collapsed on its edge and shows itself", async () => {
  const tauri = setTauri();
  await boot();
  await flush();
  expect(tauri.calls("plugin:window|set_size")).toHaveLength(1);
  const position = tauri.calls("plugin:window|set_position")[0] as { value: { Logical: { x: number; y: number } } };
  expect(position.value.Logical.x).toBeGreaterThan(1500);
  expect(tauri.calls("plugin:window|set_always_on_top")).toEqual([{ label: "widget", value: true }]);
  expect(tauri.calls("plugin:window|set_focusable")).toEqual([{ label: "widget", value: false }]);
  expect(tauri.calls("plugin:window|show")).toHaveLength(1);
});

test("without autostart the first dock does not show the window", async () => {
  const tauri = setTauri();
  await boot({ settings: settings({}, { widget: { edge: "right", rings: { claude: false, codex: false }, panel: "sessions", autostart: false } }) });
  await flush();
  expect(tauri.calls("plugin:window|set_size")).toHaveLength(1);
  expect(tauri.calls("plugin:window|show")).toHaveLength(0);
});

test("expanding makes the window focusable and collapsing shrinks it again", async () => {
  const tauri = setTauri();
  await boot();
  await flush();
  await openPanel();
  expect(tauri.calls("plugin:window|set_focusable").at(-1)).toEqual({ label: "widget", value: true });
  fireEvent.click(screen.getByLabelText("Collapse widget"));
  await flush();
  expect(tauri.calls("plugin:window|set_focusable").at(-1)).toEqual({ label: "widget", value: false });
});

test("a window api failure while docking is logged to the hub", async () => {
  const tauri = setTauri();
  tauri.on("plugin:window|current_monitor", () => {
    throw new Error("no monitor api");
  });
  await boot();
  await flush();
  expect(api.reportUiError).toHaveBeenCalledWith("widget", expect.objectContaining({ message: "dock: no monitor api" }), null);
});

test("a non-error failure is logged with its text", async () => {
  const tauri = setTauri();
  tauri.on("plugin:window|current_monitor", () => {
    throw "plain";
  });
  await boot();
  await flush();
  expect(api.reportUiError).toHaveBeenCalledWith("widget", expect.objectContaining({ message: "dock: plain" }), null);
});

test("individual window calls that fail do not stop the dock", async () => {
  const tauri = setTauri();
  tauri.on("plugin:window|set_size", () => {
    throw new Error("size refused");
  });
  tauri.on("plugin:window|set_focusable", () => {
    throw new Error("focusable refused");
  });
  await boot();
  await flush();
  expect(tauri.calls("plugin:window|show")).toHaveLength(1);
  expect(api.reportUiError).not.toHaveBeenCalled();
});

test("a disabled widget in the desktop app docks compact, hides on request and opens settings in the main window", async () => {
  const tauri = setTauri();
  await boot({ settings: settings({ widget: false }) });
  await flush();
  expect(tauri.calls("plugin:window|show")).toHaveLength(0);
  expect(tauri.calls("plugin:window|set_focusable")).toEqual([{ label: "widget", value: true }]);
  fireEvent.click(screen.getByRole("button", { name: "Hide widget" }));
  await flush();
  expect(tauri.calls("plugin:window|hide")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
  await flush();
  expect(tauri.calls("plugin:window|show").some((call) => call.label === "main")).toBe(true);
  expect(tauri.calls("plugin:window|set_focus").some((call) => call.label === "main")).toBe(true);
  expect(tauri.calls("plugin:event|emit")).toEqual([{ event: "hub:navigate", payload: "#/settings/plugins" }]);
  expect(tauri.calls("plugin:window|hide")).toHaveLength(2);
});

test("a failing hide is logged", async () => {
  const tauri = setTauri();
  tauri.on("plugin:window|hide", () => {
    throw new Error("cannot hide");
  });
  await boot({ settings: settings({ widget: false }) });
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Hide widget" }));
  await flush();
  expect(api.reportUiError).toHaveBeenCalledWith("widget", expect.objectContaining({ message: "dismiss: cannot hide" }), null);
});

test("Escape hides the widget while it is off or connecting", async () => {
  const tauri = setTauri();
  await boot({ settings: settings({ widget: false }) });
  await flush();
  fireEvent.keyDown(window, { key: "Escape" });
  await flush();
  expect(tauri.calls("plugin:window|hide")).toHaveLength(1);
});

test("turning the widget off while it is visible hides the window", async () => {
  const tauri = setTauri();
  await boot();
  await flush();
  act(() => handlers().onSettings?.(settings({ widget: false })));
  await flush();
  expect(tauri.calls("plugin:window|hide")).toHaveLength(1);
  expect(screen.getByText("Widget is off")).toBeTruthy();
});

test("the widget:shown event re-docks a compact window when the widget is off", async () => {
  const tauri = setTauri();
  await boot({ settings: settings({ widget: false }) });
  await flush();
  const before = tauri.calls("plugin:window|set_size").length;
  tauri.emitEvent("widget:shown", null);
  await flush();
  expect(tauri.calls("plugin:window|set_size").length).toBe(before + 1);
});

test("the widget:shown event is ignored while the widget is on", async () => {
  const tauri = setTauri();
  await boot();
  await flush();
  const before = tauri.calls("plugin:window|set_size").length;
  tauri.emitEvent("widget:shown", null);
  await flush();
  expect(tauri.calls("plugin:window|set_size").length).toBe(before);
});

test("the widget re-docks when the monitor layout changes", async () => {
  const tauri = setTauri();
  await boot();
  await flush();
  await advance(700);
  const before = tauri.calls("plugin:window|set_size").length;
  tauri.on("plugin:window|current_monitor", () => monitor({ size: { width: 2560, height: 1440 }, workArea: { position: { x: 0, y: 0 }, size: { width: 2560, height: 1400 } } }));
  await advance(10_000);
  await flush();
  expect(tauri.calls("plugin:window|set_size").length).toBe(before + 1);
  await advance(10_000);
  await flush();
  expect(tauri.calls("plugin:window|set_size").length).toBe(before + 1);
});

test("dropping the collapsed tab elsewhere saves the offset and re-docks", async () => {
  const tauri = setTauri();
  await boot();
  await flush();
  await advance(700);
  const before = tauri.calls("plugin:window|set_size").length;
  tauri.emitEvent("tauri://move", { x: 1800, y: 300 });
  await advance(400);
  await flush();
  expect(localStorage.getItem("widget.offset.right")).not.toBeNull();
  expect(tauri.calls("plugin:window|set_size").length).toBe(before + 1);
});

test("a failing drop is logged", async () => {
  const tauri = setTauri();
  await boot();
  await flush();
  await advance(700);
  tauri.on("plugin:window|current_monitor", () => {
    throw new Error("monitor gone");
  });
  tauri.emitEvent("tauri://move", { x: 1800, y: 300 });
  await advance(400);
  await flush();
  expect(api.reportUiError).toHaveBeenCalledWith("widget", expect.objectContaining({ message: "drop: monitor gone" }), null);
});

test("moves made by the app itself or while open are not treated as drops", async () => {
  const tauri = setTauri();
  await boot();
  await flush();
  const before = tauri.calls("plugin:window|set_size").length;
  tauri.emitEvent("tauri://move", { x: 10, y: 10 });
  await advance(400);
  await flush();
  expect(tauri.calls("plugin:window|set_size").length).toBe(before);
});

test("dragging the collapsed tab asks the window to start dragging after a few pixels", async () => {
  const tauri = setTauri();
  await boot();
  await flush();
  const tab = screen.getByRole("button", { name: "Open CC Hub widget" });
  fireEvent.mouseDown(tab, { button: 0, screenX: 10, screenY: 10 });
  fireEvent.mouseMove(window, { screenX: 12, screenY: 11 });
  expect(tauri.calls("plugin:window|start_dragging")).toHaveLength(0);
  fireEvent.mouseMove(window, { screenX: 30, screenY: 30 });
  await flush();
  expect(tauri.calls("plugin:window|start_dragging")).toEqual([{ label: "widget" }]);
  fireEvent.mouseDown(tab, { button: 2, screenX: 10, screenY: 10 });
  fireEvent.mouseDown(tab, { button: 0, screenX: 10, screenY: 10 });
  fireEvent.mouseUp(window);
  fireEvent.mouseMove(window, { screenX: 90, screenY: 90 });
  await flush();
  expect(tauri.calls("plugin:window|start_dragging")).toHaveLength(1);
});

test("opening the hub from the panel shows and focuses the main window", async () => {
  const tauri = setTauri();
  await boot();
  await flush();
  await openPanel();
  fireEvent.click(screen.getByRole("button", { name: "Open hub" }));
  await flush();
  expect(tauri.calls("plugin:window|show").some((call) => call.label === "main")).toBe(true);
  expect(tauri.calls("plugin:event|emit")).toEqual([]);
});

test("limits and usage events refresh the usage tab and the tabs switch back to sessions", async () => {
  await boot();
  await openPanel();
  fireEvent.click(screen.getByRole("tab", { name: "Usage" }));
  await flush();
  delegation.fetchLimits.mockClear();
  delegation.fetchUsageSummary.mockClear();
  fireEvent.mouseEnter(document.querySelector(".wgd-panel") as HTMLElement);
  act(() => handlers().onLimits?.());
  await flush();
  expect(delegation.fetchLimits).toHaveBeenCalled();
  act(() => handlers().onUsage?.());
  await flush();
  expect(delegation.fetchUsageSummary).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: /Sessions/ }));
  await flush();
  expect(localStorage.getItem("widget.tab")).toBe("sessions");
  expect(screen.getByRole("tab", { name: /Sessions/ }).getAttribute("aria-selected")).toBe("true");
});
