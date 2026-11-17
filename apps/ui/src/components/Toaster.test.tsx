import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HubEvents, ToastCard } from "../api";
import type { TaskDetail } from "../delegation";
import { permission, session, task } from "../test-support/u3-fixtures";
import { installTauri, removeTauri, type MonitorFake, type TauriFake } from "../test-support/u3-tauri";
import type { PermissionRequestRecord, PermissionRequestSummary, SessionRecord } from "../types";

const hub = vi.hoisted(() => ({ handlers: null as HubEvents | null, unsubscribe: vi.fn() }));
const api = vi.hoisted(() => ({
  hubBase: "http://127.0.0.1:4317",
  fetchSessions: vi.fn<() => Promise<SessionRecord[]>>(),
  focusSession: vi.fn<(id: string) => Promise<{ ok: boolean; reason?: string }>>(),
  reportUiDiag: vi.fn(async () => undefined),
  reportUiError: vi.fn(async () => undefined),
  requestNavigate: vi.fn(async () => undefined),
  subscribe: vi.fn((handlers: HubEvents) => {
    hub.handlers = handlers;
    return hub.unsubscribe;
  }),
  fetchPermissions: vi.fn<() => Promise<PermissionRequestRecord[]>>(),
  decidePermission: vi.fn(async () => "done"),
  releasePermission: vi.fn(async () => "done"),
  openSession: vi.fn(async () => ({ ok: true })),
}));
const delegation = vi.hoisted(() => ({ getTask: vi.fn<(id: string) => Promise<TaskDetail>>() }));
vi.mock("../api", () => api);
vi.mock("../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../delegation")>()), getTask: delegation.getTask }));
import { Toaster } from "./Toaster";

const monitor = (overrides: Partial<MonitorFake> = {}): MonitorFake => ({
  scaleFactor: 2,
  position: { x: 0, y: 0 },
  size: { width: 3840, height: 2160 },
  workArea: { position: { x: 0, y: 0 }, size: { width: 3840, height: 2080 } },
  ...overrides,
});

let fake: TauriFake | null = null;

const setTauri = (on: boolean): TauriFake | null => {
  if (on) {
    fake = installTauri("toast");
    fake.on("plugin:window|current_monitor", () => monitor());
  } else {
    removeTauri();
    fake = null;
  }
  return fake;
};

const tauriFake = (): TauriFake => {
  if (!fake) throw new Error("tauri is not installed");
  return fake;
};



const taskDetail = (overrides: Partial<ReturnType<typeof task>> = {}): TaskDetail => ({ task: task(overrides), runs: [] }) as unknown as TaskDetail;

const handlers = (): HubEvents => {
  if (!hub.handlers) throw new Error("not subscribed");
  return hub.handlers;
};

const card = (kind: ToastCard["kind"], id: string, title: string, body = "", at = Date.now()): ToastCard => ({ kind, id, title, body, at });

const realWait = (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

const settle = () =>
  act(async () => {
    await realWait(15);
  });

const advance = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
    await realWait(15);
  });

const push = async (toast: ToastCard) => {
  act(() => handlers().onToast?.(toast));
  await settle();
};

const cards = () => Array.from(document.querySelectorAll(".tcard[role='button']"));

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
  hub.handlers = null;
  hub.unsubscribe.mockClear();
  for (const fn of Object.values(api)) if (typeof fn !== "string") fn.mockClear();
  api.fetchSessions.mockResolvedValue([session({ sessionId: "s-1", status: "waiting", cwd: "C:/work/api", agentsRunning: 2 })]);
  api.fetchPermissions.mockResolvedValue([]);
  api.focusSession.mockResolvedValue({ ok: true });
  delegation.getTask.mockResolvedValue(taskDetail({ id: "t-1", status: "failed", workspace: "api", isolation: "worktree", branch: "feat/x" }));
  localStorage.clear();
  setTauri(false);
});

afterEach(() => {
  setTauri(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("subscribes to the hub on mount and unsubscribes on unmount", () => {
  const view = render(<Toaster />);
  expect(api.subscribe).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(hub.unsubscribe).toHaveBeenCalledTimes(1);
});

test("an informative toast shows its look, session context and disappears after six seconds", async () => {
  render(<Toaster />);
  await push(card("sessionIdle", "s-1", "Turn finished · api", "all done", Date.now()));
  const view = screen.getByRole("button", { name: "Finished: api" });
  expect(within(view).getByText("Finished")).toBeTruthy();
  expect(within(view).getByText("all done")).toBeTruthy();
  expect(within(view).getByText("work/api")).toBeTruthy();
  expect(within(view).getByText("just now")).toBeTruthy();
  expect(within(view).getByRole("note").textContent).toBe("+1");
  expect(api.reportUiDiag).toHaveBeenCalledWith(expect.objectContaining({ window: "toast", lastToast: "Turn finished · api" }));
  await advance(5_000);
  expect(cards()).toHaveLength(1);
  await advance(1_500);
  expect(cards()).toHaveLength(0);
});

test("an attention toast stays until the session stops waiting", async () => {
  render(<Toaster />);
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "approve?"));
  await advance(60_000);
  expect(cards()).toHaveLength(1);
  expect(screen.getByText("Needs you", { selector: ".tcard__status" })).toBeTruthy();
  act(() => handlers().onSession(session({ sessionId: "s-1", status: "active" })));
  expect(cards()).toHaveLength(0);
});

test("a session toast also leaves when the session is removed or its facts say it stopped waiting", async () => {
  render(<Toaster />);
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "approve?"));
  act(() => handlers().onSession(session({ sessionId: "s-1", status: "waiting" })));
  expect(cards()).toHaveLength(1);
  act(() => handlers().onRemoved?.("s-1"));
  expect(cards()).toHaveLength(0);
  api.fetchSessions.mockResolvedValue([session({ sessionId: "s-2", status: "active" })]);
  await push(card("sessionNeedsYou", "s-2", "Session needs you · web", "approve?"));
  expect(cards()).toHaveLength(0);
});

test("a session unknown to the hub keeps the toast without context", async () => {
  api.fetchSessions.mockResolvedValue([]);
  render(<Toaster />);
  await push(card("sessionNeedsYou", "ghost", "Session needs you · ghost", "wait"));
  expect(cards()).toHaveLength(1);
  expect(within(cards()[0] as HTMLElement).getByText("Session")).toBeTruthy();
});

test("a failing context lookup keeps the toast", async () => {
  api.fetchSessions.mockRejectedValue(new Error("down"));
  render(<Toaster />);
  await push(card("sessionIdle", "s-9", "Turn finished · web", "ok"));
  expect(cards()).toHaveLength(1);
});

test("a failed task toast shows the worktree context, stays, and leaves when the task is no longer failed", async () => {
  render(<Toaster />);
  await push(card("taskFailed", "t-1", "Task failed · Build", "exit 1"));
  const view = screen.getByRole("button", { name: "Failed: Build" });
  expect(within(view).getByText("Delegated")).toBeTruthy();
  expect(within(view).getByText("api")).toBeTruthy();
  expect(within(view).getByRole("note").getAttribute("title")).toBe("worktree · feat/x");
  await advance(30_000);
  expect(cards()).toHaveLength(1);
  delegation.getTask.mockResolvedValue(taskDetail({ id: "t-1", status: "completed" }));
  act(() => handlers().onDelegation?.("t-1"));
  await settle();
  expect(cards()).toHaveLength(0);
});

test("task events for unrelated or informative cards do not refetch the task", async () => {
  render(<Toaster />);
  await push(card("taskCompleted", "t-2", "Delegated task finished · Docs", "ok"));
  delegation.getTask.mockClear();
  act(() => handlers().onDelegation?.("t-2"));
  act(() => handlers().onDelegation?.("other"));
  await settle();
  expect(delegation.getTask).not.toHaveBeenCalled();
});

test("an archived failed task is pruned and a failing refetch keeps the card", async () => {
  render(<Toaster />);
  await push(card("taskFailed", "t-1", "Task failed · Build", "exit 1"));
  delegation.getTask.mockRejectedValue(new Error("gone"));
  act(() => handlers().onDelegation?.("t-1"));
  await settle();
  expect(cards()).toHaveLength(1);
  delegation.getTask.mockResolvedValue(taskDetail({ id: "t-1", status: "failed", archivedAt: 5 }));
  act(() => handlers().onDelegation?.("t-1"));
  await settle();
  expect(cards()).toHaveLength(0);
});

test("a share toast has no context lookup and links to the share", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  render(<Toaster />);
  await push(card("shareAsk", "share-1", "Ask on share docs", "alice: hi"));
  expect(api.fetchSessions).not.toHaveBeenCalled();
  expect(delegation.getTask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Answering: docs" }));
  expect(open).toHaveBeenCalledWith(expect.stringContaining("#/share/share-1"), "_blank", "noopener");
  expect(cards()).toHaveLength(0);
});

test("a repeated toast for the same subject replaces the previous card", async () => {
  render(<Toaster />);
  await push(card("sessionIdle", "s-1", "Turn finished · api", "first"));
  await push(card("sessionIdle", "s-1", "Turn finished · api", "second"));
  expect(cards()).toHaveLength(1);
  expect(screen.getByText("second")).toBeTruthy();
});

test("hovering pauses the countdown and leaving resumes it", async () => {
  render(<Toaster />);
  await push(card("sessionIdle", "s-1", "Turn finished · api", "ok"));
  const stack = document.querySelector(".toaster__stack") as HTMLElement;
  fireEvent.mouseEnter(stack);
  await advance(20_000);
  expect(cards()).toHaveLength(1);
  fireEvent.mouseMove(stack);
  await advance(20_000);
  expect(cards()).toHaveLength(1);
  fireEvent.mouseLeave(stack);
  await advance(6_500);
  expect(cards()).toHaveLength(0);
});

test("window blur and a hidden page resume the countdown even while the pointer was over the stack", async () => {
  render(<Toaster />);
  await push(card("sessionIdle", "s-1", "Turn finished · api", "ok"));
  const stack = document.querySelector(".toaster__stack") as HTMLElement;
  fireEvent.mouseEnter(stack);
  await advance(10_000);
  expect(cards()).toHaveLength(1);
  act(() => {
    window.dispatchEvent(new Event("blur"));
  });
  await advance(6_500);
  expect(cards()).toHaveLength(0);
  await push(card("sessionIdle", "s-3", "Turn finished · web", "ok"));
  fireEvent.mouseEnter(stack);
  await advance(10_000);
  expect(cards()).toHaveLength(1);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await advance(6_500);
  expect(cards()).toHaveLength(0);
  visibility.mockRestore();
});

test("the document mouseleave and window focus events are handled", async () => {
  render(<Toaster />);
  await push(card("sessionIdle", "s-1", "Turn finished · api", "ok"));
  fireEvent.mouseEnter(document.querySelector(".toaster__stack") as HTMLElement);
  act(() => {
    document.documentElement.dispatchEvent(new Event("mouseleave"));
  });
  await advance(6_500);
  expect(cards()).toHaveLength(0);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(cards()).toHaveLength(0);
});

test("the dismiss button removes the card without opening anything", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  render(<Toaster />);
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "approve?"));
  fireEvent.mouseDown(screen.getByRole("button", { name: "Dismiss" }));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(cards()).toHaveLength(0);
  expect(open).not.toHaveBeenCalled();
});

test("clicking a session toast outside the desktop app opens the sessions view in a new tab", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  render(<Toaster />);
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "approve?"));
  fireEvent.click(screen.getByRole("button", { name: "Needs you: api" }));
  expect(open).toHaveBeenCalledWith(expect.stringContaining("#/sessions"), "_blank", "noopener");
  expect(cards()).toHaveLength(0);
});

test("only the four newest cards are visible and the rest are counted", async () => {
  api.fetchSessions.mockResolvedValue([]);
  render(<Toaster />);
  for (let index = 0; index < 6; index += 1) await push(card("sessionNeedsYou", `n-${index}`, `Session needs you · s${index}`, "x"));
  expect(cards()).toHaveLength(4);
  expect(screen.getByText("+2 more")).toBeTruthy();
});

test("the development hook can push and clear toasts", async () => {
  api.fetchSessions.mockResolvedValue([]);
  render(<Toaster />);
  const dev = (window as unknown as { __cchubToaster: { push: (toast: ToastCard) => void; clear: () => void } }).__cchubToaster;
  act(() => dev.push(card("shareImplement", "x1", "Implement on share docs", "do it")));
  await settle();
  expect(screen.getByRole("button", { name: "Implementing: docs" })).toBeTruthy();
  act(() => dev.clear());
  expect(cards()).toHaveLength(0);
});

test("reconnecting reloads approvals and revalidates waiting cards against the hub", async () => {
  render(<Toaster />);
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "approve?"));
  await push(card("taskFailed", "t-1", "Task failed · Build", "exit 1"));
  api.fetchSessions.mockResolvedValue([session({ sessionId: "s-1", status: "active" })]);
  delegation.getTask.mockResolvedValue(taskDetail({ id: "t-1", status: "completed" }));
  api.fetchPermissions.mockClear();
  act(() => handlers().onOpen?.());
  await settle();
  expect(api.fetchPermissions).toHaveBeenCalled();
  expect(cards()).toHaveLength(0);
});

test("reconnecting with a failing session fetch keeps the cards", async () => {
  render(<Toaster />);
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "approve?"));
  api.fetchSessions.mockRejectedValue(new Error("down"));
  act(() => handlers().onOpen?.());
  await settle();
  expect(cards()).toHaveLength(1);
});

const request = (overrides: Partial<PermissionRequestRecord> = {}): PermissionRequestRecord => permission({ expiresAt: Date.now() + 600_000, ...overrides });

const summaryOf = (record: PermissionRequestRecord): PermissionRequestSummary => {
  const { toolInput: _input, cwd: _cwd, turnId: _turn, ...rest } = record;
  return rest;
};

const addApproval = async (record: PermissionRequestRecord) => {
  api.fetchPermissions.mockResolvedValue([record]);
  act(() => handlers().onPermissionRequest?.(summaryOf(record)));
  await settle();
};

test("a pending approval is shown as a needs-you card that can be dismissed locally", async () => {
  render(<Toaster />);
  await addApproval(request());
  const group = screen.getByRole("group", { name: "Permission request: Bash" });
  expect(within(group).getByText("Needs you")).toBeTruthy();
  expect(within(group).getByText("npm test")).toBeTruthy();
  fireEvent.click(within(group).getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("group", { name: "Permission request: Bash" })).toBeNull();
});

test("a resolved approval disappears from the toaster", async () => {
  render(<Toaster />);
  const record = request();
  await addApproval(record);
  act(() => handlers().onPermissionResolved?.({ id: record.id, agent: "claude", sessionId: record.sessionId, outcome: "allow", at: 1 }));
  expect(screen.queryByRole("group", { name: "Permission request: Bash" })).toBeNull();
});

test("approval cards are hidden when the cchub style or the needs-you event is off", async () => {
  localStorage.setItem("hub.notifications", JSON.stringify({ style: "windows" }));
  render(<Toaster />);
  await addApproval(request());
  expect(screen.queryByRole("group", { name: "Permission request: Bash" })).toBeNull();
});

test("an approval hides the matching session needs-you toast", async () => {
  render(<Toaster />);
  await push(card("sessionNeedsYou", "sess-0001-aaaa", "Session needs you · api", "approve?"));
  expect(cards()).toHaveLength(1);
  await addApproval(request({ sessionId: "sess-0001-aaaa" }));
  expect(cards()).toHaveLength(0);
});

test("open session on an approval opens the sessions view in the browser", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  render(<Toaster />);
  await addApproval(request());
  fireEvent.click(screen.getByRole("button", { name: "Open session" }));
  expect(open).toHaveBeenCalledWith(expect.stringContaining("#/sessions"), "_blank", "noopener");
});

test("open session on a codex approval asks the hub to navigate", async () => {
  setTauri(true);
  render(<Toaster />);
  await addApproval(request({ agent: "codex", id: "cx-1" }));
  fireEvent.click(screen.getByRole("button", { name: "Open session" }));
  await settle();
  expect(api.requestNavigate).toHaveBeenCalledWith("#/sessions");
});

test("inside the desktop app the toast window is sized, positioned and shown from the work area", async () => {
  const tauri = setTauri(true) as TauriFake;
  tauri.on("plugin:window|current_monitor", () => monitor());
  render(<Toaster />);
  await settle();
  expect(tauri.calls("plugin:window|hide")).toHaveLength(1);
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "approve?"));
  await settle();
  expect(tauri.calls("plugin:window|set_size")).toEqual([{ label: "toast", value: { Logical: { width: 380, height: 16 } } }]);
  expect(tauri.calls("plugin:window|set_position")).toEqual([{ label: "toast", value: { Logical: { x: 1524, y: 1008 } } }]);
  expect(tauri.calls("plugin:window|set_always_on_top")).toEqual([{ label: "toast", value: true }]);
  expect(tauri.calls("plugin:window|set_focusable")).toEqual([{ label: "toast", value: false }]);
  expect(tauri.calls("plugin:window|show")).toHaveLength(1);
  expect(api.reportUiDiag).toHaveBeenCalledWith(expect.objectContaining({ window: "toast", count: 1, position: { x: 1524, y: 1008 } }));
  act(() => handlers().onRemoved?.("s-1"));
  await settle();
  expect(tauri.calls("plugin:window|hide")).toHaveLength(2);
});

test("a monitor with an offset and a different scale places the window inside its work area", async () => {
  const tauri = setTauri(true) as TauriFake;
  tauri.on("plugin:window|current_monitor", () => monitor({ scaleFactor: 1, position: { x: 100, y: 50 }, workArea: { position: { x: 100, y: 50 }, size: { width: 1920, height: 1040 } } }));
  render(<Toaster />);
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "approve?"));
  await settle();
  expect(tauri.calls("plugin:window|set_position")[0]).toEqual({ label: "toast", value: { Logical: { x: 100 + 1920 - 380 - 16, y: 50 + 1040 - 16 - 16 } } });
});

test("without a monitor a default area is used", async () => {
  const tauri = setTauri(true) as TauriFake;
  tauri.on("plugin:window|current_monitor", () => null);
  render(<Toaster />);
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "approve?"));
  await settle();
  expect(tauri.calls("plugin:window|set_position")[0]).toEqual({ label: "toast", value: { Logical: { x: 1280 - 380 - 16, y: 720 - 16 - 16 } } });
});

test("a window error is reported to the hub instead of thrown, and an unsupported focusable call is tolerated", async () => {
  const tauri = setTauri(true) as TauriFake;
  tauri.on("plugin:window|show", () => {
    throw new Error("no window");
  });
  tauri.on("plugin:window|set_focusable", () => {
    throw new Error("old webview");
  });
  render(<Toaster />);
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "approve?"));
  await settle();
  expect(tauri.calls("plugin:window|show")).toHaveLength(1);
  expect(api.reportUiError).toHaveBeenCalledWith("toaster", expect.objectContaining({ message: "show: no window" }), null);
  expect(api.reportUiError).not.toHaveBeenCalledWith("toaster", expect.objectContaining({ message: expect.stringContaining("old webview") }), null);
});

test("a non-error window failure is reported with its text", async () => {
  const tauri = setTauri(true) as TauriFake;
  tauri.on("plugin:window|set_size", () => {
    throw "plain failure";
  });
  render(<Toaster />);
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "approve?"));
  await settle();
  expect(api.reportUiError).toHaveBeenCalledWith("toaster", expect.objectContaining({ message: "show: plain failure" }), null);
});

test("clicking a session toast in the desktop app focuses the session and falls back to navigating", async () => {
  setTauri(true);
  render(<Toaster />);
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "approve?"));
  fireEvent.click(screen.getByRole("button", { name: "Needs you: api" }));
  await settle();
  expect(api.focusSession).toHaveBeenCalledWith("s-1");
  expect(api.requestNavigate).not.toHaveBeenCalled();
  api.focusSession.mockResolvedValueOnce({ ok: false, reason: "no window" });
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "again"));
  fireEvent.click(screen.getByRole("button", { name: "Needs you: api" }));
  await settle();
  expect(api.requestNavigate).toHaveBeenCalledWith("#/sessions");
  expect(api.reportUiError).toHaveBeenCalledWith("toaster", expect.objectContaining({ message: "focus session: no window" }), null);
  api.focusSession.mockRejectedValueOnce(new Error("boom"));
  await push(card("sessionNeedsYou", "s-1", "Session needs you · api", "third"));
  fireEvent.click(screen.getByRole("button", { name: "Needs you: api" }));
  await settle();
  expect(api.reportUiError).toHaveBeenCalledWith("toaster", expect.objectContaining({ message: "focus session: boom" }), null);
  expect(api.requestNavigate).toHaveBeenCalledTimes(2);
});

test("clicking a task toast in the desktop app navigates to the task", async () => {
  setTauri(true);
  render(<Toaster />);
  await push(card("taskFailed", "t-1", "Task failed · Build", "exit 1"));
  fireEvent.click(screen.getByRole("button", { name: "Failed: Build" }));
  await settle();
  expect(api.requestNavigate).toHaveBeenCalledWith("#/tasks/t-1");
  expect(api.focusSession).not.toHaveBeenCalled();
});

test("a question approval lets the window take the keyboard when its text field is focused", async () => {
  setTauri(true);
  const record = request({
    id: "ask-1",
    toolName: "AskUserQuestion",
    toolInput: { questions: [{ question: "Which db?", header: "", multiSelect: false, options: [{ label: "pg", description: "" }] }] },
  });
  render(<Toaster />);
  await addApproval(record);
  await settle();
  const tauri = tauriFake();
  await userEvent.click(screen.getByLabelText("Other answer for: Which db?"));
  await settle();
  expect(tauri.calls("plugin:window|set_focusable").at(-1)).toEqual({ label: "toast", value: true });
  expect(tauri.calls("plugin:window|set_focus")).toHaveLength(1);
});

test("a failing keyboard grab is reported and not thrown", async () => {
  const tauri = setTauri(true) as TauriFake;
  tauri.on("plugin:window|set_focus", () => {
    throw new Error("no focus");
  });
  const record = request({
    id: "ask-2",
    toolName: "AskUserQuestion",
    toolInput: { questions: [{ question: "Which?", header: "", multiSelect: false, options: [{ label: "a", description: "" }] }] },
  });
  render(<Toaster />);
  await addApproval(record);
  await settle();
  await userEvent.click(screen.getByLabelText("Other answer for: Which?"));
  await settle();
  expect(api.reportUiError).toHaveBeenCalledWith("toaster", expect.objectContaining({ message: "keyboard: no focus" }), null);
});

test("outside the desktop app the keyboard grab is a no-op", async () => {
  const record = request({
    id: "ask-3",
    toolName: "AskUserQuestion",
    toolInput: { questions: [{ question: "Q3?", header: "", multiSelect: false, options: [{ label: "a", description: "" }] }] },
  });
  render(<Toaster />);
  await addApproval(record);
  await userEvent.click(screen.getByLabelText("Other answer for: Q3?"));
  await settle();
  expect(fake).toBeNull();
});
