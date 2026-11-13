import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoardProject, BoardTask, WorkspaceRecord } from "./delegation";
import { buildCaptureItems, buildCommandItems, buildSessionItems, buildTaskItems, buildViewItems, buildWorkspaceItems, CAPTURE_PREFILL, PALETTE_SESSION_CAP, parseCaptureQuery, type SessionActions } from "./palette-items";
import { SETTINGS_SECTIONS } from "./settings-sections";
import type { CodexSessionRecord, SessionRecord } from "./types";

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

  it("skips disabled views and lists every settings section", () => {
    const items = buildViewItems(views, () => undefined);
    assert.deepEqual(ids(items).slice(0, 2), ["view:sessions", "view:settings"]);
    assert.equal(items.filter((entry) => entry.id.startsWith("settings:")).length, SETTINGS_SECTIONS.length);
    assert.equal(items.every((entry) => entry.kind === "view"), true);
  });

  it("navigates with the view key and the settings section", () => {
    const calls: [string, string | null | undefined][] = [];
    const items = buildViewItems(views, (view, param) => calls.push([view, param]));
    items.find((entry) => entry.id === "view:sessions")?.run();
    items.find((entry) => entry.id === "settings:hooks")?.run();
    assert.deepEqual(calls, [
      ["sessions", undefined],
      ["settings", "hooks"],
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
