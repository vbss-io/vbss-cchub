import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoardProject, BoardTask, WorkspaceRecord } from "./delegation";
import { buildCaptureItems, buildCommandItems, buildHistoryItems, buildSessionItems, buildTaskItems, buildViewItems, buildWorkspaceItems, CAPTURE_PREFILL, PALETTE_SESSION_CAP, parseCaptureQuery, type SessionActions } from "./palette-items";
import { settingsTabs } from "./settings-sections";
import type { CodexSessionRecord, HistoryHit, SessionRecord } from "./types";

const ids = (items: { id: string }[]) => items.map((entry) => entry.id);

const session = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: id,
  status: "active",
  cwd: `C:/repos/${id}`,
  source: null,
  hostPid: null,
  title: null,
  customTitle: null,
  lastMessage: null,
  model: null,
  tokensIn: null,
  tokensOut: null,
  contextTokens: null,
  archivedAt: null,
  startedAt: 1,
  updatedAt: 1,
  ...extra,
});

const thread = (id: string, extra: Partial<CodexSessionRecord> = {}): CodexSessionRecord => ({
  id,
  title: `Thread ${id}`,
  cwd: `C:/repos/${id}`,
  originator: null,
  source: null,
  threadSource: null,
  client: "desktop",
  status: "idle",
  turns: 1,
  lastMessage: null,
  file: "x",
  startedAt: 1,
  updatedAt: 1,
  origin: "user",
  hubTaskId: null,
  customTitle: null,
  archivedAt: null,
  hidden: false,
  ...extra,
} as CodexSessionRecord);

const workspace = (name: string, repoPaths: string[]): WorkspaceRecord => ({
  name,
  file: `${name}.code-workspace`,
  contextPath: null,
  repos: repoPaths.map((path) => ({ name: path.split("/").pop() ?? path, path })) as WorkspaceRecord["repos"],
  error: null,
});

const task = (id: string, title: string, extra: Partial<BoardTask> = {}): BoardTask => ({
  id,
  projectId: "proj",
  line: 1,
  raw: "- [ ] x",
  depth: 0,
  checkbox: " ",
  prefix: null,
  status: "todo",
  title,
  reason: null,
  section: "open",
  doneAt: null,
  group: null,
  priority: null,
  notes: [],
  noteItems: [],
  subtasks: [],
  ...extra,
} as BoardTask);

describe("buildViewItems", () => {
  const views = [
    { key: "sessions", label: "Sessions", subtitle: "all", enabled: true },
    { key: "daily", label: "Today", subtitle: "day", enabled: false },
    { key: "settings", label: "Settings", subtitle: "cfg", enabled: true },
  ];

  it("skips disabled views and lists a settings item per tab", () => {
    const tabs = settingsTabs({ daily: true, trail: false, usage: false, limits: false, tasks: false, share: false, widget: false });
    const items = buildViewItems(views, () => undefined, tabs);
    assert.deepEqual(ids(items).slice(0, 2), ["view:sessions", "view:settings"]);
    assert.deepEqual(
      ids(items).filter((id) => id.startsWith("settings:")),
      ["settings:general", "settings:appearance", "settings:plugins", "settings:plugin-sessions", "settings:plugin-today", "settings:memory", "settings:connections", "settings:health", "settings:notifications", "settings:groups", "settings:about"],
    );
    assert.equal(items.every((entry) => entry.kind === "view"), true);
  });

  it("titles each settings item with its tab and keeps the old section names searchable", () => {
    const items = buildViewItems(views, () => undefined, settingsTabs(null));
    assert.equal(items.find((entry) => entry.id === "settings:connections")?.title, "Settings › Connections");
    assert.equal(items.find((entry) => entry.id === "settings:connections")?.keywords?.includes("hooks"), true);
    assert.equal(items.find((entry) => entry.id === "settings:general")?.keywords?.includes("paths"), true);
    assert.equal(items.find((entry) => entry.id === "settings:about")?.keywords?.includes("support"), true);
  });

  it("only offers plugin tabs of enabled plugins", () => {
    const off = ids(buildViewItems(views, () => undefined, settingsTabs({ daily: false, trail: false, usage: false, limits: false, tasks: false, share: false, widget: false })));
    assert.equal(off.includes("settings:plugin-today"), false);
    assert.equal(off.includes("settings:plugin-share"), false);
    const on = ids(buildViewItems(views, () => undefined, settingsTabs({ daily: true, trail: true, usage: true, limits: true, tasks: true })));
    assert.deepEqual(
      on.filter((id) => id.startsWith("settings:")).slice(3, 10),
      ["settings:plugin-sessions", "settings:plugin-today", "settings:plugin-tasks", "settings:plugin-usage", "settings:plugin-share", "settings:plugin-trail", "settings:plugin-widget"],
    );
  });

  it("titles a plugin page Settings › <Plugin> and opens it through its plugin route", () => {
    const calls: [string, string | null | undefined][] = [];
    const items = buildViewItems(views, (view, param) => calls.push([view, param]), settingsTabs({ daily: true, trail: false, usage: false, limits: false, tasks: true, share: false, widget: false }));
    const tasks = items.find((entry) => entry.id === "settings:plugin-tasks");
    assert.equal(tasks?.title, "Settings › Tasks");
    assert.equal(tasks?.keywords?.includes("board"), true);
    tasks?.run();
    assert.deepEqual(calls, [["settings", "plugin-tasks"]]);
  });

  it("navigates with the view key and the settings tab", () => {
    const calls: [string, string | null | undefined][] = [];
    const items = buildViewItems(views, (view, param) => calls.push([view, param]), settingsTabs(null));
    items.find((entry) => entry.id === "view:sessions")?.run();
    items.find((entry) => entry.id === "settings:connections")?.run();
    assert.deepEqual(calls, [
      ["sessions", undefined],
      ["settings", "connections"],
    ]);
  });
});

describe("buildSessionItems", () => {
  const calls: string[] = [];
  const actions: SessionActions = {
    classify: (entry) => (entry.sessionId === "skip" ? null : entry.status === "ended" ? "recent" : "live"),
    focus: (id) => calls.push(`focus:${id}`),
    open: (id) => calls.push(`open:${id}`),
    focusCodex: () => calls.push("focus-codex"),
    openCodex: (id) => calls.push(`open-codex:${id}`),
  };
  const workspaces = [workspace("vbss", ["C:/repos/live"])];

  it("drops skipped sessions and hidden or archived threads, newest first", () => {
    const items = buildSessionItems(
      [session("old", { updatedAt: 5 }), session("skip"), session("live", { updatedAt: 50, customTitle: "Fix login" })],
      [thread("a", { updatedAt: 20 }), thread("hid", { hidden: true }), thread("arc", { archivedAt: 3 })],
      workspaces,
      actions,
    );
    assert.deepEqual(ids(items), ["session:live", "codex:a", "session:old"]);
    assert.equal(items[0]?.title, "Fix login");
    assert.equal(items[0]?.subtitle, "vbss · active");
  });

  it("focuses live sessions and opens the drawer for recent ones", () => {
    calls.length = 0;
    const items = buildSessionItems([session("live"), session("done", { status: "ended" })], [thread("t1"), thread("t2", { status: "ended" })], [], actions);
    for (const entry of items) entry.run();
    assert.deepEqual(calls.sort(), ["focus-codex", "focus:live", "open-codex:t2", "open:done"]);
  });

  it("falls back to the folder name and caps the list", () => {
    const untitled = buildSessionItems([session("proj-x")], [], [], actions);
    assert.equal(untitled[0]?.title, "proj-x");
    const many = Array.from({ length: PALETTE_SESSION_CAP + 20 }, (_, index) => session(`s${index}`, { updatedAt: index }));
    assert.equal(buildSessionItems(many, [], [], actions).length, PALETTE_SESSION_CAP);
  });
});

describe("buildWorkspaceItems", () => {
  it("creates an open-in-editor and a show item per workspace", () => {
    const calls: string[] = [];
    const items = buildWorkspaceItems([workspace("vbss", ["C:/a/one", "C:/a/two"])], { open: (name) => calls.push(`open:${name}`), show: (name) => calls.push(`show:${name}`) });
    assert.deepEqual(ids(items), ["workspace-open:vbss", "workspace-show:vbss"]);
    assert.equal(items[0]?.title, "Open vbss in editor");
    assert.equal(items[1]?.title, "Show vbss");
    for (const entry of items) entry.run();
    assert.deepEqual(calls, ["open:vbss", "show:vbss"]);
  });
});

describe("buildTaskItems", () => {
  const projects = [{ id: "proj", title: "Imaginaria" }] as BoardProject[];

  it("flattens subtasks and skips closed ones", () => {
    const tasks = [
      task("proj#1", "Parent", { subtasks: [task("proj#2", "Child"), task("proj#3", "Closed child", { status: "done" })] }),
      task("proj#4", "Archived", { status: "archived" }),
    ];
    const opened: string[] = [];
    const items = buildTaskItems(tasks, projects, (id) => opened.push(id));
    assert.deepEqual(ids(items), ["task:proj#1", "task:proj#2"]);
    assert.equal(items[0]?.subtitle, "Imaginaria · todo");
    items[1]?.run();
    assert.deepEqual(opened, ["proj#2"]);
  });
});

describe("buildCommandItems", () => {
  const base = { backupNow: () => undefined, toggleTheme: () => undefined, themeHint: "Switch to Midnight", installHooks: () => undefined };

  it("always offers backup, theme and hooks", () => {
    assert.deepEqual(ids(buildCommandItems(base)), ["command:backup-now", "command:toggle-theme", "command:install-hooks"]);
  });

  it("adds feature and desktop commands only when provided", () => {
    const run = () => undefined;
    const items = buildCommandItems({ ...base, newTask: run, startDay: run, planToday: run, refreshDaily: run, toggleWidget: run });
    assert.deepEqual(ids(items), [
      "command:new-task",
      "command:start-day",
      "command:plan-today",
      "command:refresh-daily",
      "command:backup-now",
      "command:toggle-theme",
      "command:toggle-widget",
      "command:install-hooks",
    ]);
  });

  it("offers Delegated work only when the Delegated plugin hands it an action", () => {
    assert.equal(ids(buildCommandItems(base)).includes("command:delegated-work"), false);
    const calls: string[] = [];
    const items = buildCommandItems({ ...base, openDelegated: () => calls.push("delegated") });
    const command = items.find((entry) => entry.id === "command:delegated-work");
    assert.equal(command?.title, "Delegated work");
    assert.equal(command?.subtitle, "Sessions › Delegated");
    command?.run();
    assert.deepEqual(calls, ["delegated"]);
  });

  it("offers Toggle sidebar with the Ctrl+B hint and the next state", () => {
    assert.equal(ids(buildCommandItems(base)).includes("command:toggle-sidebar"), false);
    let toggled = 0;
    const toggle = () => {
      toggled += 1;
    };
    const expanded = buildCommandItems({ ...base, sidebar: { toggle, collapsed: false } }).find((entry) => entry.id === "command:toggle-sidebar");
    const collapsed = buildCommandItems({ ...base, sidebar: { toggle, collapsed: true } }).find((entry) => entry.id === "command:toggle-sidebar");
    assert.equal(expanded?.title, "Toggle sidebar");
    assert.equal(expanded?.subtitle, "Collapse · Ctrl+B");
    assert.equal(collapsed?.subtitle, "Expand · Ctrl+B");
    expanded?.run();
    assert.equal(toggled, 1);
  });
});

describe("capture", () => {
  const base = { backupNow: () => undefined, toggleTheme: () => undefined, themeHint: "Switch to Midnight", installHooks: () => undefined };

  it("adds a Capture command only when provided", () => {
    const run = () => undefined;
    assert.equal(ids(buildCommandItems(base)).includes("command:capture"), false);
    const items = buildCommandItems({ ...base, startCapture: run });
    const command = items.find((entry) => entry.id === "command:capture");
    assert.equal(command?.title, "Capture…");
    assert.equal(command?.run, run);
  });

  it("keeps the plan and refresh commands labeled for Today", () => {
    const run = () => undefined;
    const items = buildCommandItems({ ...base, planToday: run, refreshDaily: run });
    assert.deepEqual(items.slice(0, 2).map((entry) => entry.subtitle), ["Today", "Today"]);
    assert.equal(items[1]?.title, "Refresh Today");
  });

  it("offers Start the day first and labels the wizard as the classic planner", () => {
    const start = () => undefined;
    const plan = () => undefined;
    const items = buildCommandItems({ ...base, startDay: start, planToday: plan });
    assert.deepEqual(items.slice(0, 2).map((entry) => [entry.id, entry.title, entry.subtitle]), [
      ["command:start-day", "Start the day", "Today"],
      ["command:plan-today", "Plan today (classic)", "Today"],
    ]);
    assert.equal(items[0]?.run, start);
    assert.equal(items[1]?.run, plan);
    assert.equal(ids(buildCommandItems({ ...base, planToday: plan })).includes("command:start-day"), false);
  });

  it("parses the capture and c: prefixes", () => {
    assert.equal(parseCaptureQuery("capture call Maria"), "call Maria");
    assert.equal(parseCaptureQuery("Capture   call Maria  "), "call Maria");
    assert.equal(parseCaptureQuery("c: buy milk"), "buy milk");
    assert.equal(parseCaptureQuery("C:buy milk"), "buy milk");
    assert.equal(parseCaptureQuery("capture"), null);
    assert.equal(parseCaptureQuery("capture   "), null);
    assert.equal(parseCaptureQuery("c:"), null);
    assert.equal(parseCaptureQuery("capturing things"), null);
    assert.equal(parseCaptureQuery("cache clear"), null);
    assert.equal(parseCaptureQuery(CAPTURE_PREFILL), null);
  });

  it("builds one Capture item that sends the text", () => {
    const sent: string[] = [];
    assert.deepEqual(buildCaptureItems("capture", (text) => sent.push(text)), []);
    const items = buildCaptureItems("c: ring the bank", (text) => sent.push(text));
    assert.equal(items.length, 1);
    assert.equal(items[0]?.title, "Capture: ring the bank");
    items[0]?.run();
    assert.deepEqual(sent, ["ring the bank"]);
  });
});

describe("buildHistoryItems", () => {
  const hit = (extra: Partial<HistoryHit> = {}): HistoryHit => ({
    messageId: 7,
    sessionId: "s7",
    client: "codex",
    title: "Fix login",
    cwd: "C:/repos/api",
    workspace: "C:/repos/api",
    role: "assistant",
    at: new Date(2026, 10, 15, 9, 5).getTime(),
    seq: 3,
    snippet: "…the login redirect",
    highlights: [[5, 10]],
    matches: 1,
    ...extra,
  });
  const space: WorkspaceRecord = { name: "shop", file: "x", contextPath: null, repos: [{ name: "api", path: "C:/repos/api" }], error: null };

  it("turns each hit into a History item with its highlights and a readable subtitle", () => {
    const opened: string[] = [];
    const [item] = buildHistoryItems([hit()], [space], (value) => opened.push(value.sessionId ?? ""));
    assert.equal(item?.id, "history:7");
    assert.equal(item?.kind, "history");
    assert.equal(item?.title, "…the login redirect");
    assert.deepEqual(item?.titleRanges, [[5, 10]]);
    assert.equal(item?.subtitle, "Codex · Fix login · shop · Assistant · 2026-11-15 09:05");
    item?.run();
    assert.deepEqual(opened, ["s7"]);
  });

  it("works without a title, a workspace or a date", () => {
    const [item] = buildHistoryItems([hit({ title: null, cwd: null, at: null, role: "user" })], [], () => undefined);
    assert.equal(item?.subtitle, "Codex · session s7 · You");
  });
});
