import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHealth, type ClaimRecord } from "../api";
import { cancelTask, type WorkspaceRecord } from "../delegation";
import { archiveTask, listArchivedTasks, retryTask } from "../delegation-actions";
import { codexRecord, NOW, sessionRecord, taskRecord } from "../test-support/u4-fixtures";
import type { CodexSessionRecord, GroupRecord, SessionRecord } from "../types";
import { useTaskCosts } from "../use-ops";
import { SessionsView } from "./SessionsView";

vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../api")>()), fetchHealth: vi.fn() }));

vi.mock("../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../delegation")>()), cancelTask: vi.fn() }));

vi.mock("../delegation-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../delegation-actions")>()),
  archiveTask: vi.fn(),
  listArchivedTasks: vi.fn(),
  retryTask: vi.fn(),
}));

vi.mock("../use-ops", () => ({ useTaskCosts: vi.fn() }));

vi.mock("../use-task-detail", async (importOriginal) => ({ ...(await importOriginal<typeof import("../use-task-detail")>()), useArchiveSupport: () => true }));

const healthMock = vi.mocked(fetchHealth);
const cancelMock = vi.mocked(cancelTask);
const archiveMock = vi.mocked(archiveTask);
const archivedMock = vi.mocked(listArchivedTasks);
const retryMock = vi.mocked(retryTask);
const costsMock = vi.mocked(useTaskCosts);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  healthMock.mockReset();
  healthMock.mockResolvedValue({ ok: true, hostname: "my-pc" });
  cancelMock.mockReset();
  cancelMock.mockResolvedValue({ ok: true });
  archiveMock.mockReset();
  archiveMock.mockResolvedValue(undefined);
  archivedMock.mockReset();
  archivedMock.mockResolvedValue([]);
  retryMock.mockReset();
  retryMock.mockResolvedValue(undefined);
  costsMock.mockReset();
  costsMock.mockReturnValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

const workspaces: WorkspaceRecord[] = [
  { name: "api-ws", file: "C:/ws/api.json", contextPath: "C:/ws/api", repos: [{ name: "api", path: "C:/work/api" }], error: null },
];

const byId = (...records: SessionRecord[]): Record<string, SessionRecord> => Object.fromEntries(records.map((record) => [record.sessionId, record]));

type Props = Parameters<typeof SessionsView>[0];

const baseProps = (): Props => ({
  sessions: {},
  claims: [],
  groups: [],
  workspaces,
  codexSessions: [],
  codexAppRunning: false,
  tasks: [],
  delegatedEnabled: false,
  hubEnabled: true,
  hubTick: 0,
  origin: "all",
  needsYouTop: false,
  selectedTaskId: null,
  mode: "list",
  tick: 0,
  onOrigin: vi.fn(),
  onOpen: vi.fn(),
  onFocus: vi.fn(),
  onOpenSession: vi.fn(),
  onOpenCodexSession: vi.fn(),
  onArchive: vi.fn(),
  onDelete: vi.fn(),
  onRename: vi.fn(),
  onFavorite: vi.fn(),
  onOpenCodex: vi.fn(),
  onRenameCodex: vi.fn(),
  onArchiveCodex: vi.fn(),
  onUnarchiveCodex: vi.fn(),
  onDeleteCodex: vi.fn(),
  onOpenTask: vi.fn(),
  onTasksChanged: vi.fn().mockResolvedValue(undefined),
  onOpenSettings: vi.fn(),
  onError: vi.fn(),
});

const setup = async (overrides: Partial<Props> = {}) => {
  const props = { ...baseProps(), ...overrides };
  const view = render(<SessionsView {...props} />);
  await act(async () => {
    await Promise.resolve();
  });
  return { props, ...view };
};

const names = (): string[] => screen.queryAllByRole("article").map((card) => card.querySelector(".card__name")?.textContent ?? "");

const pill = (label: RegExp | string) => screen.getByRole("button", { name: label });

const live = (id: string, title: string, overrides: Partial<SessionRecord> = {}): SessionRecord => sessionRecord({ sessionId: id, title, ...overrides });

describe("SessionsView list", () => {
  it("shows the live sessions as cards under their workspace group and opens one", async () => {
    const { props } = await setup({ sessions: byId(live("s1", "Alpha"), live("s2", "Beta", { cwd: "C:/elsewhere/tool" })) });
    expect(names().sort()).toEqual(["Alpha", "Beta"]);
    expect(screen.getByRole("button", { name: /api-ws/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ungrouped/ })).toBeTruthy();
    fireEvent.click(screen.getByText("Alpha"));
    expect(props.onOpen).toHaveBeenCalledWith("s1");
  });

  it("says there are no live sessions when the list is empty", async () => {
    await setup();
    expect(screen.getByText(/No live sessions\./)).toBeTruthy();
  });

  it("offers the Ended list when only ended sessions exist", async () => {
    await setup({ sessions: byId(live("s1", "Done", { status: "ended" })) });
    expect(screen.getByText(/1 ended/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "open the Ended list" }));
    expect(names()).toEqual(["Done"]);
  });

  it("counts the origin totals and highlights the selected origin", async () => {
    const { props } = await setup({ sessions: byId(live("s1", "A")), codexSessions: [codexRecord()], delegatedEnabled: true, tasks: [taskRecord()] });
    const origins = within(screen.getByRole("group", { name: "Origin" }));
    expect(origins.getByRole("button", { name: /^All 3/ }).getAttribute("aria-pressed")).toBe("true");
    expect(origins.getByRole("button", { name: /^Claude 1/ })).toBeTruthy();
    fireEvent.click(origins.getByRole("button", { name: /^Codex 1/ }));
    expect(props.onOrigin).toHaveBeenCalledWith("codex");
  });

  it("hides the delegated origin when delegation is off", async () => {
    await setup({ origin: "delegated" });
    expect(screen.queryByRole("button", { name: /^Delegated/ })).toBeNull();
  });

  it("groups by a custom match pattern and orders configured groups first", async () => {
    const groups: GroupRecord[] = [{ id: "g1", name: "Tools", match: "tool", position: 0 }];
    await setup({ groups, sessions: byId(live("s1", "Alpha", { cwd: "C:/Users/me/tool-a" }), live("s2", "Beta")) });
    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings[0]).toContain("Tools");
    expect(headings[0]).toContain("1");
  });

  it("collapses a group, remembers it and expands it again", async () => {
    const view = await setup({ sessions: byId(live("s1", "Alpha")) });
    fireEvent.click(screen.getByRole("button", { name: /api-ws/ }));
    expect(names()).toEqual([]);
    expect(JSON.parse(localStorage.getItem("hub.collapsedGroups") ?? "[]")).toEqual(["api-ws"]);
    view.unmount();
    await setup({ sessions: byId(live("s1", "Alpha")) });
    expect(names()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /api-ws/ }));
    expect(names()).toEqual(["Alpha"]);
    expect(JSON.parse(localStorage.getItem("hub.collapsedGroups") ?? "[]")).toEqual([]);
  });

  it("ignores bad or unreadable stored groups", async () => {
    localStorage.setItem("hub.collapsedGroups", "{not json");
    const first = await setup({ sessions: byId(live("s1", "Alpha")) });
    expect(names()).toEqual(["Alpha"]);
    first.unmount();
    localStorage.setItem("hub.collapsedGroups", JSON.stringify("nope"));
    const second = await setup({ sessions: byId(live("s1", "Alpha")) });
    expect(names()).toEqual(["Alpha"]);
    second.unmount();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await setup({ sessions: byId(live("s1", "Alpha")) });
    fireEvent.click(screen.getByRole("button", { name: /api-ws/ }));
    expect(names()).toEqual([]);
    setItem.mockRestore();
  });

  it("shows how many sessions in a collapsed group need you", async () => {
    await setup({ sessions: byId(live("s1", "Alpha", { status: "waiting" })) });
    fireEvent.click(screen.getByRole("button", { name: /api-ws/ }));
    expect(screen.getByText("1 need you")).toBeTruthy();
  });

  it("passes claims, forks, peers and remote source to the cards", async () => {
    const claims: ClaimRecord[] = [
      { id: "c1", sessionId: "s1", sessionTitle: null, repoPath: "C:/r", paths: ["a"], note: null, createdAt: NOW, expiresAt: NOW + 1000 },
      { id: "c2", sessionId: "s1", sessionTitle: null, repoPath: "C:/r", paths: ["b"], note: null, createdAt: NOW, expiresAt: NOW + 1000 },
      { id: "c3", sessionId: null, sessionTitle: null, repoPath: "C:/r", paths: ["c"], note: null, createdAt: NOW, expiresAt: NOW + 1000 },
    ];
    await setup({
      claims,
      sessions: byId(live("s1", "Alpha", { source: "other-pc", forkOf: "s2" }), live("s2", "Parent"), live("s3", "Third", { forkOf: "unknown-id-1234", source: "MY-PC" })),
    });
    const alpha = screen.getByText("Alpha").closest("article") as HTMLElement;
    const note = within(alpha).getByRole("note").getAttribute("title") ?? "";
    expect(note).toContain("from other-pc");
    expect(note).toContain("claims 2 files");
    expect(note).toContain("fork of Parent");
    expect(note).toContain("more here");
    const third = screen.getByText("Third").closest("article") as HTMLElement;
    const thirdNote = within(third).getByRole("note").getAttribute("title") ?? "";
    expect(thirdNote).toContain("fork of unknown-");
    expect(thirdNote).not.toContain("from MY-PC");
  });

  it("treats a source as remote when the hostname is unknown", async () => {
    healthMock.mockRejectedValue(new Error("down"));
    await setup({ sessions: byId(live("s1", "Alpha", { source: "somewhere" })) });
    expect(within(screen.getByRole("article")).getByRole("note").getAttribute("title")).toContain("from somewhere");
  });

  it("names untitled sessions by their project folder or short id when sorting by name", async () => {
    await setup({
      sessions: byId(live("sess-zed1", "", { title: null, cwd: "C:/work/zed/" }), live("s2", "Mid"), live("aaaa-1234", "", { title: null, cwd: null })),
    });
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "name" } });
    expect(names()).toEqual(["Mid", "aaaa-123", "sess-zed"]);
    fireEvent.change(screen.getByPlaceholderText("search title, folder, message"), { target: { value: "zed" } });
    expect(names()).toEqual(["sess-zed"]);
  });
});

describe("SessionsView filters", () => {
  const mixed = (): Record<string, SessionRecord> =>
    byId(
      live("s1", "Active one"),
      live("s2", "Idle one", { status: "idle" }),
      live("s3", "Waiting one", { status: "waiting" }),
      live("s4", "Ended one", { status: "ended" }),
      live("s5", "Archived one", { archivedAt: 5 }),
      live("s6", "Stale one", { updatedAt: NOW - 5 * 3_600_000 }),
      live("s7", "Fav one", { favoriteAt: 5, status: "ended" }),
    );

  it("filters by status pills and shows the live counts", async () => {
    await setup({ sessions: mixed() });
    expect(names().sort()).toEqual(["Active one", "Idle one", "Waiting one"]);
    expect(pill(/^Active 1/)).toBeTruthy();
    fireEvent.click(pill(/^Active/));
    expect(names()).toEqual(["Active one"]);
    fireEvent.click(pill(/^Idle/));
    expect(names()).toEqual(["Idle one"]);
    fireEvent.click(pill(/^Needs you/));
    expect(names()).toEqual(["Waiting one"]);
    fireEvent.click(pill(/^Favorites/));
    expect(names()).toEqual(["Fav one"]);
    fireEvent.click(within(document.querySelector(".filters") as HTMLElement).getByRole("button", { name: /^All/ }));
    expect(names()).toHaveLength(3);
  });

  it("shows the extra buckets from Show also and resets with the empty option", async () => {
    await setup({ sessions: mixed() });
    const select = screen.getByLabelText("Show also");
    fireEvent.change(select, { target: { value: "ended" } });
    expect(names().sort()).toEqual(["Ended one", "Fav one"]);
    expect(select.className).toContain("select--also-on");
    fireEvent.change(select, { target: { value: "archived" } });
    expect(names()).toEqual(["Archived one"]);
    fireEvent.change(select, { target: { value: "stale" } });
    expect(names()).toEqual(["Stale one"]);
    fireEvent.change(select, { target: { value: "waiting" } });
    expect(names()).toEqual(["Waiting one"]);
    fireEvent.change(select, { target: { value: "" } });
    expect(names()).toHaveLength(3);
  });

  it("filters by the search text over title, folder and last message", async () => {
    await setup({ sessions: byId(live("s1", "Alpha", { lastMessage: "refactor the parser" }), live("s2", "Beta", { cwd: "C:/work/other" })) });
    const input = screen.getByPlaceholderText("search title, folder, message");
    fireEvent.change(input, { target: { value: "parser" } });
    expect(names()).toEqual(["Alpha"]);
    fireEvent.change(input, { target: { value: "other" } });
    expect(names()).toEqual(["Beta"]);
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText("Nothing matches this filter.")).toBeTruthy();
  });

  it("sorts by recent and by name from the Filters menu", async () => {
    const sessions = byId(live("s1", "Zed", { updatedAt: NOW - 1000 }), live("s2", "Abe", { updatedAt: NOW - 90_000 }), live("s3", "Mia", { updatedAt: NOW - 50_000 }));
    await setup({ sessions });
    expect(names()).toEqual(["Zed", "Mia", "Abe"]);
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "name" } });
    expect(names()).toEqual(["Abe", "Mia", "Zed"]);
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "recent" } });
    expect(names()).toEqual(["Zed", "Mia", "Abe"]);
    expect(screen.getByRole("button", { name: "Filters (1)" })).toBeTruthy();
  });

  it("sorts by status by default, waiting first", async () => {
    await setup({ sessions: byId(live("s1", "Active", { updatedAt: NOW - 1000 }), live("s2", "Waiting", { status: "waiting", updatedAt: NOW - 90_000 }), live("s3", "Idle", { status: "idle", updatedAt: NOW - 50_000 })) });
    expect(names()).toEqual(["Waiting", "Idle", "Active"]);
  });

  it("filters by client and shows live counts per client", async () => {
    await setup({ sessions: byId(live("s1", "Term", { client: "terminal" }), live("s2", "Code", { client: "vscode" }), live("s3", "Share", { client: "share" }), live("s4", "Head", { client: "headless" })), codexSessions: [codexRecord({ title: "Thread" })] });
    expect(names().sort()).toEqual(["Code", "Term", "Thread"]);
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const select = screen.getByLabelText("Client");
    fireEvent.change(select, { target: { value: "vscode" } });
    expect(names()).toEqual(["Code"]);
    fireEvent.change(select, { target: { value: "share" } });
    expect(names()).toEqual(["Share"]);
    fireEvent.change(select, { target: { value: "hub" } });
    expect(names().sort()).toEqual(["Head", "Share"]);
    fireEvent.change(select, { target: { value: "codex" } });
    expect(names()).toEqual(["Thread"]);
  });

  it("drops the client filter when the origin changes and hides Codex from the Claude origin", async () => {
    const view = await setup({ sessions: byId(live("s1", "Term")), codexSessions: [codexRecord({ title: "Thread" })], origin: "claude" });
    expect(names()).toEqual(["Term"]);
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    expect(within(screen.getByLabelText("Client")).queryByRole("option", { name: /Codex threads/ })).toBeNull();
    view.rerender(<SessionsView {...baseProps()} sessions={byId(live("s1", "Term"))} codexSessions={[codexRecord({ title: "Thread" })]} origin="codex" />);
    expect(names()).toEqual(["Thread"]);
    expect(screen.queryByRole("button", { name: /^Filters/ })?.textContent).toContain("Filters");
  });

  it("resets the favorites filter when the origin no longer includes Claude", async () => {
    const props = { ...baseProps(), sessions: mixed(), codexSessions: [codexRecord()] };
    const view = render(<SessionsView {...props} />);
    fireEvent.click(pill(/^Favorites/));
    view.rerender(<SessionsView {...props} origin="codex" />);
    expect(screen.queryByRole("button", { name: /^Favorites/ })).toBeNull();
    expect(names()).toEqual(["Fix build"]);
  });
});

describe("SessionsView needs you band", () => {
  it("lifts needy runs into a Needs you band when enabled", async () => {
    await setup({ needsYouTop: true, sessions: byId(live("s1", "Quiet"), live("s2", "Blocked", { status: "waiting" })) });
    const band = screen.getByRole("region", { name: "Needs you" });
    expect(within(band).getByText("Blocked")).toBeTruthy();
    expect(within(band).queryByText("Quiet")).toBeNull();
    expect(screen.getByText("Quiet")).toBeTruthy();
  });

  it("keeps runs in their groups when the band is off", async () => {
    await setup({ needsYouTop: false, sessions: byId(live("s2", "Blocked", { status: "waiting" })) });
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  it("counts band runs on their group header", async () => {
    await setup({ needsYouTop: true, sessions: byId(live("s2", "Blocked", { status: "waiting" })) });
    expect(screen.getByText("1 need you")).toBeTruthy();
  });
});

describe("SessionsView Codex threads", () => {
  it("lists threads with the right actions and states", async () => {
    const { props } = await setup({ codexSessions: [codexRecord({ title: "Thread" })], codexAppRunning: true });
    fireEvent.click(screen.getByText("Thread"));
    expect(props.onOpenCodex).toHaveBeenCalledWith("codex-0001-aaaa");
    expect(screen.getByRole("button", { name: /Focus app/ })).toBeTruthy();
  });

  it("hides hidden threads and puts waiting threads in the needs you count", async () => {
    await setup({ codexSessions: [codexRecord({ id: "c1", title: "Hidden", hidden: true }), codexRecord({ id: "c2", title: "Waiting", status: "waiting" }), codexRecord({ id: "c3", title: "Old", archivedAt: 5 }), codexRecord({ id: "c4", title: "Gone", status: "ended" })] });
    expect(names()).toEqual(["Waiting"]);
    expect(pill(/^Needs you 1/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Show also"), { target: { value: "archived" } });
    expect(names()).toEqual(["Old"]);
  });

  it("searches thread titles", async () => {
    await setup({ codexSessions: [codexRecord({ id: "c1", title: "Build" }), codexRecord({ id: "c2", title: "Deploy", customTitle: "Ship" })] });
    fireEvent.change(screen.getByPlaceholderText("search title, folder, message"), { target: { value: "ship" } });
    expect(names()).toEqual(["Ship"]);
  });
});

describe("SessionsView delegated", () => {
  const tasks = (): ReturnType<typeof taskRecord>[] => [
    taskRecord({ id: "t1", title: "Running job", status: "running" }),
    taskRecord({ id: "t2", title: "Broken job", status: "failed", lastError: "exit 1" }),
    taskRecord({ id: "t3", title: "Finished job", status: "completed", updatedAt: NOW - 1000 }),
  ];

  it("shows the summary and the task cards and opens one", async () => {
    const { props } = await setup({ origin: "delegated", delegatedEnabled: true, tasks: tasks() });
    expect(screen.getByText(/1 running · 1 need you · 1 done today · 1 failed/)).toBeTruthy();
    expect(names()).toEqual(expect.arrayContaining(["Running job", "Broken job"]));
    fireEvent.click(screen.getByText("Running job"));
    expect(props.onOpenTask).toHaveBeenCalledWith("t1");
  });

  it("asks for costs of the visible tasks only when delegated", async () => {
    await setup({ origin: "delegated", delegatedEnabled: true, tasks: tasks(), hubTick: 3 });
    expect(costsMock).toHaveBeenCalledWith(expect.arrayContaining(["t1", "t2"]), 3, true);
    expect(costsMock.mock.calls.at(-1)?.[0]).not.toContain("t3");
  });

  it("cancels a running task and refreshes", async () => {
    const { props } = await setup({ origin: "delegated", delegatedEnabled: true, tasks: tasks() });
    const card = screen.getByText("Running job").closest("article") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Cancel" }));
    await waitFor(() => expect(props.onTasksChanged).toHaveBeenCalledTimes(1));
    expect(cancelMock).toHaveBeenCalledWith("t1");
  });

  it("retries a failed task and archives a finished one", async () => {
    const { props } = await setup({ origin: "delegated", delegatedEnabled: true, tasks: [...tasks(), taskRecord({ id: "t4", title: "Stuck", status: "attention", lastError: "perm" })], filter: undefined } as Partial<Props>);
    const failed = screen.getByText("Broken job").closest("article") as HTMLElement;
    fireEvent.click(within(failed).getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry" }));
    await waitFor(() => expect(retryMock).toHaveBeenCalledWith("t2", null));
    const stuck = screen.getByText("Stuck").closest("article") as HTMLElement;
    fireEvent.click(within(stuck).getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry autonomous" }));
    await waitFor(() => expect(retryMock).toHaveBeenCalledWith("t4", "bypassPermissions"));
    fireEvent.click(within(failed).getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(archiveMock).toHaveBeenCalledWith("t2"));
    expect(props.onTasksChanged).toHaveBeenCalledTimes(3);
  });

  it("reports a failed task action and keeps going", async () => {
    cancelMock.mockRejectedValueOnce(new Error("hub refused"));
    const { props } = await setup({ origin: "delegated", delegatedEnabled: true, tasks: tasks() });
    const card = screen.getByText("Running job").closest("article") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Cancel" }));
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith("hub refused"));
    cancelMock.mockRejectedValueOnce("odd");
    fireEvent.click(within(card).getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Cancel" }));
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith("action failed"));
  });

  it("loads archived tasks when the Archived list is open", async () => {
    archivedMock.mockResolvedValue([taskRecord({ id: "t9", title: "Old job", status: "completed", archivedAt: 5 })]);
    await setup({ origin: "delegated", delegatedEnabled: true, tasks: tasks() });
    fireEvent.change(screen.getByLabelText("Show also"), { target: { value: "archived" } });
    await waitFor(() => expect(names()).toEqual(["Old job"]));
    expect(screen.getByRole("option", { name: "Archived" })).toBeTruthy();
  });

  it("survives a failing archived list", async () => {
    archivedMock.mockRejectedValue(new Error("x"));
    await setup({ origin: "delegated", delegatedEnabled: true, tasks: tasks() });
    fireEvent.change(screen.getByLabelText("Show also"), { target: { value: "archived" } });
    await waitFor(() => expect(archivedMock).toHaveBeenCalled());
    expect(names()).toEqual([]);
  });

  it("folds a Codex thread run by a task into the task card", async () => {
    await setup({
      delegatedEnabled: true,
      origin: "all",
      tasks: [taskRecord({ id: "t1", title: "Delegated run", runner: "codex", sessionId: "codex-0001-aaaa" })],
      codexSessions: [codexRecord({ origin: "hub", hubTaskId: "t1", title: "Folded thread" })],
    });
    expect(names()).toEqual(["Delegated run"]);
    expect(screen.queryByText("Folded thread")).toBeNull();
  });

  it("shows the thread on its own when delegation is off", async () => {
    await setup({ delegatedEnabled: false, codexSessions: [codexRecord({ origin: "hub", hubTaskId: "t1", title: "Thread" })], tasks: [taskRecord({ id: "t1", sessionId: "codex-0001-aaaa" })] });
    expect(names()).toEqual(["Thread"]);
  });

  it("hides tasks when a Claude only client filter is active", async () => {
    await setup({ origin: "all", delegatedEnabled: true, tasks: tasks(), sessions: byId(live("s1", "Term")) });
    expect(names()).toContain("Running job");
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "terminal" } });
    expect(names()).toEqual(["Term"]);
  });

  it("explains that the hub surface is off", async () => {
    const { props } = await setup({ origin: "delegated", delegatedEnabled: true, hubEnabled: false });
    fireEvent.click(screen.getByRole("button", { name: "Open connections" }));
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("explains that nothing was delegated yet", async () => {
    const { props } = await setup({ origin: "delegated", delegatedEnabled: true });
    expect(screen.getByText("hub_delegate")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect the clients" }));
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("names the delegated tasks in the empty states when there are only filtered ones", async () => {
    await setup({ origin: "delegated", delegatedEnabled: true, tasks: [taskRecord({ id: "t3", status: "completed", updatedAt: NOW - 10 * 24 * 3_600_000, title: "Ancient" })] });
    expect(screen.getByText(/No live delegated tasks\. 1 ended/)).toBeTruthy();
  });

  it("explains an empty Codex origin", async () => {
    await setup({ origin: "codex" });
    expect(screen.getByText(/No live Codex threads\./)).toBeTruthy();
  });

  it("explains an empty Claude origin and names the client filter when active", async () => {
    await setup({ origin: "claude", sessions: byId(live("s1", "Done", { status: "ended", client: "vscode" })) });
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "vscode" } });
    expect(screen.getByText(/No live Claude Code · VS Code\. 1 ended/)).toBeTruthy();
  });

  it("describes delegated runs in the help text", async () => {
    await setup({ delegatedEnabled: true });
    fireEvent.click(screen.getByRole("button", { name: "About this view" }));
    expect(screen.getByText(/A delegated task folds the hub session that runs it\./)).toBeTruthy();
  });

  it("describes the plain help text without delegation", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "About this view" }));
    expect(screen.getByText(/Hub runs are headless sessions the hub launches/)).toBeTruthy();
  });
});

describe("SessionsView modes", () => {
  it("renders the mode switch in the header", async () => {
    await setup({ modeSwitch: <div data-testid="mode-switch">switch</div> });
    expect(screen.getByTestId("mode-switch")).toBeTruthy();
  });

  it("renders the map with the shared search controls and hides the list chrome", async () => {
    const renderMap = vi.fn((controls: { query: string; onQuery: (value: string) => void; origin: string }) => (
      <div data-testid="map">
        <span>{`origin:${controls.origin} q:${controls.query}`}</span>
        <button onClick={() => controls.onQuery("needle")}>search</button>
      </div>
    ));
    const view = await setup({ mode: "map", renderMap, sessions: byId(live("s1", "Alpha")) });
    expect(screen.getByTestId("map").textContent).toContain("origin:all q:");
    expect(screen.queryByRole("button", { name: "About this view" })).toBeNull();
    expect(screen.queryByPlaceholderText("search title, folder, message")).toBeNull();
    expect(view.container.querySelector(".view--runs-map")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "search" }));
    expect(screen.getByTestId("map").textContent).toContain("q:needle");
  });

  it("renders search and routines overlays without the origin chips", async () => {
    const view = await setup({ mode: "search", renderSearch: () => <div data-testid="search">search view</div> });
    expect(screen.getByTestId("search")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Origin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "About this view" })).toBeNull();
    view.unmount();
    await setup({ mode: "routines", renderRoutines: () => <div data-testid="routines">routines view</div> });
    expect(screen.getByTestId("routines")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Origin" })).toBeNull();
  });

  it("falls back to the list when the mode has no renderer", async () => {
    await setup({ mode: "map", sessions: byId(live("s1", "Alpha")) });
    expect(names()).toEqual(["Alpha"]);
    expect(screen.getByRole("group", { name: "Origin" })).toBeTruthy();
  });
});

describe("SessionsView codex card callbacks", () => {
  it("forwards rename, archive and delete for threads", async () => {
    const thread: CodexSessionRecord = codexRecord({ archivedAt: 9 });
    const { props } = await setup({ codexSessions: [thread] });
    fireEvent.change(screen.getByLabelText("Show also"), { target: { value: "archived" } });
    const card = screen.getByRole("article");
    fireEvent.click(within(card).getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unarchive" }));
    expect(props.onUnarchiveCodex).toHaveBeenCalledWith("codex-0001-aaaa");
    fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(card).getByRole("button", { name: "Confirm delete" }));
    expect(props.onDeleteCodex).toHaveBeenCalledWith("codex-0001-aaaa");
  });

  it("forwards session archive, favorite and rename", async () => {
    const { props } = await setup({ sessions: byId(live("s1", "Alpha")) });
    const card = screen.getByRole("article");
    fireEvent.click(within(card).getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(props.onArchive).toHaveBeenCalledWith("s1");
    fireEvent.click(within(card).getByRole("button", { name: /^Actions for/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Favorite" }));
    expect(props.onFavorite).toHaveBeenCalledWith("s1", true);
    fireEvent.click(within(card).getByRole("button", { name: /Focus/ }));
    expect(props.onFocus).toHaveBeenCalledWith("s1");
  });
});
