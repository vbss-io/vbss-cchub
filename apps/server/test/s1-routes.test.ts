import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fixtures } from "./helpers.js";
import { s1Listen, s1Request, s1Sandbox, type S1Listening } from "./helpers/s1-env.js";

const box = s1Sandbox("cch-s1-routes-", { HUB_DELEGATION: "1" });

const { createApp, defaultAppDeps } = await import("../src/app.js");
const { applyHook, archiveSession, db } = await import("../src/db.js");
const { beginRun, createTask, finishRun, getSettings, updateSettings } = await import("../src/delegation-store.js");
const { onBroadcast } = await import("../src/sse.js");
const types = await import("../src/delegation-types.js");
const { backupsRouteDeps } = await import("../src/backups-routes.js");

const transcript = join(fixtures, "transcript-sample.jsonl");
const events: { event: string; data: unknown }[] = [];
onBroadcast((event, data) => {
  events.push({ event, data });
});

let web: S1Listening;

before(async () => {
  mkdirSync(box.dataDir, { recursive: true });
  web = await s1Listen(createApp({ dataDir: box.dataDir, staticDir: null, previewMode: false, devSeed: false }, defaultAppDeps));
});

after(async () => {
  await web.close();
  if (db.open) db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const http = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => s1Request(web.base, method, path, body, headers);
const errorOf = (json: unknown): string => (json as { error: string }).error;

function hook(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "session_start" as const,
    sessionId,
    cwd: null,
    source: null,
    hostPid: null,
    shellPid: null,
    title: null,
    message: null,
    notificationType: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    contextTokens: null,
    agentId: null,
    agentType: null,
    client: null,
    claudePid: null,
    transcriptPath: null,
    agentMessage: null,
    shareLabel: null,
    ...extra,
  };
}

function task(title: string, extra: Partial<Parameters<typeof createTask>[0]> = {}) {
  return createTask({
    title,
    prompt: `${title} prompt`,
    workspace: "pilot",
    repo: null,
    cwd: box.repoA,
    addDirs: [],
    runner: "claude",
    model: null,
    permissionMode: null,
    sandbox: null,
    createdBy: null,
    originSessionId: null,
    originClient: null,
    ...extra,
  });
}

describe("delegation guard", () => {
  it("refuses an untrusted origin on the guarded routes", async () => {
    const res = await http("GET", "/delegation/settings", undefined, { origin: "http://evil.test" });
    assert.equal(res.status, 403);
  });
});

describe("settings routes", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["runTimeoutMinutes", { runTimeoutMinutes: "abc" }],
    ["runTimeoutMinutes", { runTimeoutMinutes: types.RUN_TIMEOUT_MAX + 1 }],
    ["ownerName", { ownerName: "" }],
    ["ownerName", { ownerName: "x".repeat(61) }],
    ["autonomy", { autonomy: "reckless" }],
    ["workspacesRoot", { workspacesRoot: join(box.tmp, "missing") }],
    ["editorCommand", { editorCommand: " " }],
    ["secondBrainRoot", { secondBrainRoot: join(box.tmp, "missing") }],
    ["features.daily", { features: { daily: "yes" } }],
    ["daily.runner", { daily: { runner: "gpt" } }],
    ["daily.closedKey", { daily: { closedKey: "" } }],
    ["daily.wikilinks", { daily: { wikilinks: "yes" } }],
    ["daily.focusSource", { daily: { focusSource: "random" } }],
    ["daily.projectOrder", { daily: { projectOrder: ["ok", "bad\nline"] } }],
    ["daily.projectOrder", { daily: { projectOrder: "a" } }],
    ["daily.headings.focus", { daily: { headings: { focus: "" } } }],
    ["daily.headings.meetings", { daily: { headings: { meetings: "" } } }],
    ["daily.headings.sessions", { daily: { headings: { sessions: "" } } }],
    ["daily.headings.captures", { daily: { headings: { captures: "a\nb" } } }],
    ["tasks.root", { tasks: { root: 5 } }],
    ["tasks.section", { tasks: { section: "a\nb" } }],
    ["tasks.prefixes", { tasks: { prefixes: null } }],
    ["tasks.prefixes", { tasks: { prefixes: ["BLOCK"] } }],
    ["tasks.prefixes.blocked", { tasks: { prefixes: { blocked: [""] } } }],
    ["tasks.prefixes.hold", { tasks: { prefixes: { hold: "HOLD" } } }],
    ["tasks.prefixes.archived", { tasks: { prefixes: { archived: [] } } }],
    ["tasks.separator", { tasks: { separator: "x" } }],
    ["tasks.exclude", { tasks: { exclude: [1] } }],
    ["tasks.workspaceKey", { tasks: { workspaceKey: "a b" } }],
    ["tasks.parentKey", { tasks: { parentKey: 3 } }],
    ["tasks.delegatePrompt", { tasks: { delegatePrompt: 5 } }],
    ["tasks.markDoingOnDelegate", { tasks: { markDoingOnDelegate: "yes" } }],
    ["tasks.reasonSeparator", { tasks: { reasonSeparator: " " } }],
    ["tasks.doneSection", { tasks: { doneSection: 5 } }],
    ["tasks.doneStamp", { tasks: { doneStamp: "no token" } }],
    ["tasks.priorityTag", { tasks: { priorityTag: "a b" } }],
    ["tasks.priorityTag", { tasks: { priorityTag: 5 } }],
    ["tasks.priorityLevels", { tasks: { priorityLevels: 1.5 } }],
    ["trail.detail", { trail: { detail: "ultra" } }],
    ["trail.model", { trail: { model: "" } }],
    ["trail.model", { trail: { model: "m".repeat(81) } }],
    ["trail.hubEvents", { trail: { hubEvents: "yes" } }],
    ["widget.edge", { widget: { edge: "bottom" } }],
    ["widget.panel", { widget: { panel: "tasks" } }],
    ["widget.autostart", { widget: { autostart: "yes" } }],
    ["widget.rings.claude", { widget: { rings: { claude: "yes" } } }],
    ["limits.claude", { limits: { claude: "yes" } }],
    ["limits.refreshMinutes", { limits: { refreshMinutes: types.LIMITS_REFRESH_MAX + 1 } }],
    ["usage.days", { usage: { days: types.USAGE_DAYS_MIN - 1 } }],
    ["approvals.claudeWindowSec", { approvals: { claudeWindowSec: 1.5 } }],
    ["memory.historyIndex", { memory: { historyIndex: "yes" } }],
    ["memory.handoffWorkspaces", { memory: { handoffWorkspaces: [""] } }],
    ["memory.summaryHeading", { memory: { summaryHeading: "#" } }],
  ];

  for (const [field, body] of bad) {
    it(`rejects an invalid ${field}`, async () => {
      const res = await http("PUT", "/delegation/settings", body);
      assert.equal(res.status, 400, JSON.stringify(res.json));
      assert.ok(errorOf(res.json).includes(field.split(".").at(-1)!), errorOf(res.json));
    });
  }

  it("applies a full valid patch, broadcasts it and returns it from GET", async () => {
    const res = await http("PUT", "/delegation/settings", {
      runTimeoutMinutes: "30",
      ownerName: " Vitor ",
      autonomy: "auto",
      workspacesRoot: box.root,
      editorCommand: ` ${process.execPath} `,
      secondBrainRoot: box.brain,
      features: { daily: false, trail: false, usage: true, limits: true, tasks: true, flow: true, delegated: true, workspaces: true, reports: true, share: false, widget: true },
      daily: {
        dir: "diario",
        template: "",
        prompt: "summarize",
        runner: "codex",
        closedKey: "closed",
        wikilinks: true,
        focusSource: "list",
        projectOrder: [" a ", "b", "a"],
        headings: { focus: "Foco", meetings: "Reunioes", sessions: "Sessoes", captures: " Capturas " },
      },
      tasks: {
        root: " ",
        section: " Open loops ",
        prefixes: { blocked: [" BLOCK ", "BLOCK"], hold: ["HOLD"], archived: ["ARCHIVED"] },
        separator: " - ",
        exclude: ["_*", "_*"],
        workspaceKey: " workspace ",
        parentKey: "parent",
        delegatePrompt: "  ",
        markDoingOnDelegate: true,
        reasonSeparator: " - ",
        doneSection: " Done ",
        doneStamp: ` ${types.TASKS_DATE_TOKEN}`,
        priorityTag: " p ",
        priorityLevels: 5,
      },
      trail: { dir: "trail", prompt: null, detail: "high", model: " haiku ", hubEvents: true },
      widget: { edge: "left", panel: "usage", autostart: false, rings: { claude: true, codex: false } },
      limits: { claude: true, codex: false, codexLive: false, refreshMinutes: 10 },
      usage: { days: 14 },
      approvals: { claudeWindowSec: 120, codexWindowSec: 30 },
      memory: { historyIndex: false, handoffWorkspaces: [" pilot ", "pilot"], summaryHeading: "## Resumo" },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const settings = res.json as ReturnType<typeof getSettings>;
    assert.equal(settings.runTimeoutMinutes, 30);
    assert.equal(settings.ownerName, "Vitor");
    assert.equal(settings.editorCommand, process.execPath);
    assert.deepEqual(settings.daily.projectOrder, ["a", "b"]);
    assert.equal(settings.daily.headings.captures, "Capturas");
    assert.equal(settings.tasks.root, null);
    assert.deepEqual(settings.tasks.prefixes.blocked, ["BLOCK"]);
    assert.equal(settings.tasks.delegatePrompt, null);
    assert.equal(settings.trail.model, "haiku");
    assert.deepEqual(settings.memory.handoffWorkspaces, ["pilot"]);
    assert.equal(settings.memory.summaryHeading, "Resumo");
    assert.ok(events.some((item) => item.event === "settings"));
    const read = await http("GET", "/delegation/settings");
    assert.equal((read.json as { ownerName: string }).ownerName, "Vitor");
  });

  it("accepts nulls, empty feature patches and delegate prompts", async () => {
    const res = await http("PUT", "/delegation/settings", {
      workspacesRoot: box.root,
      secondBrainRoot: null,
      features: {},
      tasks: { root: null, delegatePrompt: "Do {{task}}", prefixes: {} },
      trail: { model: null },
      widget: { rings: {} },
      limits: {},
      usage: {},
      approvals: {},
      memory: {},
      daily: {},
    });
    assert.equal(res.status, 200);
    const settings = res.json as ReturnType<typeof getSettings>;
    assert.equal(settings.secondBrainRoot, null);
    assert.equal(settings.tasks.delegatePrompt, "Do {{task}}");
    assert.equal(settings.trail.model, null);
  });
});

describe("system, health and plugins routes", () => {
  it("reads the autostart status and validates the toggle", async () => {
    const status = await http("GET", "/delegation/system/autostart");
    assert.equal(status.status, 200);
    assert.equal((status.json as { enabled: boolean }).enabled, false);
    assert.equal((await http("PUT", "/delegation/system/autostart", { enabled: "yes" })).status, 400);
    const enable = await http("PUT", "/delegation/system/autostart", { enabled: true });
    assert.equal(enable.status, 409);
    assert.match(errorOf(enable.json), /executable was not found/);
    const disable = await http("PUT", "/delegation/system/autostart", { enabled: false });
    assert.equal(disable.status, 409);
    assert.equal((disable.json as { enabled: boolean }).enabled, false);
    assert.equal(typeof (disable.json as { error: string }).error, "string");
  });

  it("returns the health report", async () => {
    const res = await http("GET", "/delegation/health");
    assert.equal(res.status, 200);
    assert.equal(typeof res.json, "object");
  });

  it("lists plugins with their enabled state", async () => {
    updateSettings({ features: { share: false, reports: true } });
    const plugins = (await http("GET", "/delegation/plugins")).json as { id: string; enabled: boolean }[];
    assert.equal(plugins.find((plugin) => plugin.id === "core")?.enabled, true);
    assert.equal(plugins.find((plugin) => plugin.id === "share")?.enabled, false);
    assert.equal(plugins.find((plugin) => plugin.id === "reports")?.enabled, true);
  });
});

describe("brain and backups routes", () => {
  it("answers 404 while no second brain is linked and today's note once it is", async () => {
    updateSettings({ secondBrainRoot: null });
    assert.equal((await http("GET", "/delegation/brain/today")).status, 404);
    updateSettings({ secondBrainRoot: join(box.tmp, "gone") });
    assert.equal((await http("GET", "/delegation/brain/today")).status, 404);
    updateSettings({ secondBrainRoot: box.brain });
    const res = await http("GET", "/delegation/brain/today");
    assert.equal(res.status, 200);
    assert.equal(typeof res.json, "object");
    updateSettings({ secondBrainRoot: null });
  });

  it("lists backups and writes a manual one", async () => {
    const created = await http("POST", "/delegation/backups");
    assert.equal(created.status, 201);
    const file = (created.json as { backup: { file: string } }).backup.file;
    assert.ok(readdirSync(join(box.dataDir, "backups")).some((name) => file.endsWith(name)));
    const summary = await http("GET", "/delegation/backups");
    assert.equal(summary.status, 200);
    assert.ok(JSON.stringify(summary.json).includes("manual"));
  });
});

describe("overview route", () => {
  before(() => {
    updateSettings({ workspacesRoot: box.root, autonomy: "full" });
    applyHook(hook("ov-active", { cwd: box.repoA, client: "terminal", kind: "user_prompt", model: "opus" }));
    applyHook(hook("ov-waiting", { cwd: box.repoA, kind: "permission_request", model: "opus" }));
    applyHook(hook("ov-idle", { cwd: box.repoB, kind: "stop", client: "vscode", model: "opus" }));
    applyHook(hook("ov-ended", { kind: "session_end", model: "opus" }));
    applyHook(hook("ov-stale", { model: "opus" }), Date.now() - 48 * 3_600_000);
    applyHook(hook("ov-archived", { model: "opus" }));
    archiveSession("ov-archived");
    const running = task("running task");
    beginRun({ taskId: running.id, kind: "launch", runner: "claude", prompt: "p", model: null, permissionMode: null, sessionId: null });
    const failed = task("failed task", { cwd: box.repoB });
    const run = beginRun({ taskId: failed.id, kind: "launch", runner: "claude", prompt: "p", model: null, permissionMode: null, sessionId: null });
    finishRun({ runId: run.id, taskId: failed.id, status: "failed", effectiveModel: null, sessionId: null, result: null, error: "x".repeat(400), exitCode: 1 });
  });

  it("summarizes sessions, tasks, crowded folders, claims and workspaces", async () => {
    const res = await http("GET", "/delegation/overview");
    assert.equal(res.status, 200);
    const body = res.json as {
      sessions: { counts: Record<string, number>; byClient: Record<string, number>; attention: { sessionId: string; workspace: string | null }[]; active: { sessionId: string }[] };
      tasks: { inFlight: { title: string }[]; attention: { title: string; lastError: string | null }[]; recent: unknown[] };
      crowdedFolders: { path: string; agents: number }[];
      delegation: { autonomy: string; note: string };
      workspaces: { name: string; repos: number }[];
      codexSessions: { id: string }[];
    };
    assert.ok(body.sessions.counts.active! >= 1);
    assert.ok(body.sessions.counts.waiting! >= 1);
    assert.ok(body.sessions.counts.idle! >= 1);
    assert.ok(body.sessions.counts.ended! >= 1);
    assert.ok(body.sessions.counts.stale! >= 1);
    assert.ok(body.sessions.byClient.unknown! >= 1);
    assert.equal(body.sessions.attention.find((item) => item.sessionId === "ov-waiting")?.workspace, "pilot");
    assert.ok(body.sessions.active.some((item) => item.sessionId === "ov-active"));
    assert.ok(body.tasks.inFlight.some((item) => item.title === "running task"));
    const failed = body.tasks.attention.find((item) => item.title === "failed task");
    assert.ok(failed?.lastError?.endsWith("…"));
    assert.ok(body.crowdedFolders.some((folder) => folder.path === box.repoA && folder.agents >= 3));
    assert.equal(body.delegation.autonomy, "full");
    assert.match(body.delegation.note, /without permission prompts/);
    assert.deepEqual(body.workspaces, [{ name: "pilot", repos: 2 }]);
    assert.ok(Array.isArray(body.codexSessions));
  });

  it("explains the safe autonomy note", async () => {
    updateSettings({ autonomy: "safe" });
    const body = (await http("GET", "/delegation/overview")).json as { delegation: { note: string } };
    assert.match(body.delegation.note, /acceptEdits/);
  });
});

describe("workspaces routes", () => {
  it("needs a root and a name to create a workspace", async () => {
    updateSettings({ workspacesRoot: null });
    assert.equal((await http("POST", "/delegation/workspaces", { name: "x" })).status, 400);
    assert.equal((await http("PUT", "/delegation/workspaces/x", { repos: [] })).status, 400);
    assert.equal((await http("DELETE", "/delegation/workspaces/x")).status, 400);
    updateSettings({ workspacesRoot: box.root });
    assert.equal((await http("POST", "/delegation/workspaces", { name: " " })).status, 400);
  });

  it("creates, updates, opens and deletes a workspace", async () => {
    updateSettings({ editorCommand: process.execPath });
    const created = await http("POST", "/delegation/workspaces", { name: " second ", repos: [box.repoA] });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal((created.json as { name: string }).name, "second");
    assert.equal((await http("POST", "/delegation/workspaces", { name: "second" })).status, 400);
    const updated = await http("PUT", "/delegation/workspaces/second", { repos: [box.repoA, box.repoB] });
    assert.equal(updated.status, 200);
    assert.equal((await http("PUT", "/delegation/workspaces/ghost", { repos: [] })).status, 400);
    const list = (await http("GET", "/delegation/workspaces")).json as { name: string }[];
    assert.deepEqual(list.map((item) => item.name).sort(), ["pilot", "second"]);
    assert.equal((await http("POST", "/delegation/workspaces/ghost/open")).status, 404);
    const opened = await http("POST", "/delegation/workspaces/second/open");
    assert.equal((opened.json as { ok: boolean }).ok, true);
    const removed = await http("DELETE", "/delegation/workspaces/second?context=1");
    assert.equal(removed.status, 200);
    assert.equal((await http("DELETE", "/delegation/workspaces/ghost?context=true")).status, 400);
  });
});

describe("ui prefs routes", () => {
  const bad: [string, unknown][] = [
    ["body must be an object", [1]],
    ["sidebar must be an object", { sidebar: "x" }],
    ["sidebar.order must be an array", { sidebar: { order: "x", pinned: [] } }],
    ["at most", { sidebar: { order: Array.from({ length: 41 }, (_, i) => `v${i}`), pinned: ["a"] } }],
    ["items must match", { sidebar: { order: ["Bad Key"], pinned: ["a"] } }],
    ["needs at least one item", { sidebar: { order: ["a"], pinned: [] } }],
    ["layout must be an object", { layout: 5 }],
    ["screen keys must match", { layout: { "Bad!": {} } }],
    ["layout.board must be an object", { layout: { board: 5 } }],
    ["keys must match", { layout: { board: { "bad key": 1 } } }],
    ["must be a number between", { layout: { board: { left: -1 } } }],
    ["accepts at most 10 keys", { layout: { board: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 1])) } }],
    ["accepts at most 40 screens", { layout: Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`s${i}`, {}])) }],
  ];

  for (const [message, body] of bad) {
    it(`rejects ${message}`, async () => {
      const res = await http("PUT", "/delegation/ui-prefs", body);
      assert.equal(res.status, 400);
      assert.ok(errorOf(res.json).includes(message), errorOf(res.json));
    });
  }

  it("stores the sidebar and layout and broadcasts them", async () => {
    const res = await http("PUT", "/delegation/ui-prefs", { sidebar: { order: ["sessions", "tasks"], pinned: ["sessions"] }, layout: { board: { left: 320 } } });
    assert.equal(res.status, 200);
    assert.deepEqual((res.json as { sidebar: unknown }).sidebar, { order: ["sessions", "tasks"], pinned: ["sessions"] });
    assert.ok(events.some((item) => item.event === "ui-prefs"));
    const cleared = await http("PUT", "/delegation/ui-prefs", { sidebar: null });
    assert.equal((cleared.json as { sidebar: unknown }).sidebar, null);
    const read = await http("GET", "/delegation/ui-prefs");
    assert.equal((read.json as { layout: { board: { left: number } } }).layout.board.left, 320);
  });
});

describe("connect routes", () => {
  it("returns the connect status with the codex hooks status", async () => {
    const res = await http("GET", "/delegation/connect");
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(typeof (res.json as { codexHooks: unknown }).codexHooks, "object");
    const hooks = await http("GET", "/delegation/connect/codex-hooks");
    assert.equal((hooks.json as { installed: boolean }).installed, false);
  });

  it("validates the shell and mcp requests", async () => {
    assert.equal((await http("POST", "/delegation/connect/shell", {})).status, 400);
    assert.equal((await http("POST", "/delegation/connect/shell", { shell: "fish" })).status, 400);
    assert.equal((await http("POST", "/delegation/connect/shell", { shell: "bash", action: "zap" })).status, 400);
    assert.equal((await http("POST", "/delegation/connect/mcp", {})).status, 400);
    assert.equal((await http("POST", "/delegation/connect/mcp", { client: "claude-desktop", action: "zap" })).status, 400);
    assert.equal((await http("POST", "/delegation/connect/codex-hooks", { action: "zap" })).status, 400);
  });

  it("answers 500 when the shell profile cannot be written", async () => {
    const rc = join(box.home, ".bashrc");
    rmSync(rc, { force: true });
    mkdirSync(rc);
    const res = await http("POST", "/delegation/connect/shell", { shell: "bash" });
    assert.equal(res.status, 500);
    assert.equal(typeof errorOf(res.json), "string");
    rmSync(rc, { recursive: true, force: true });
  });

  it("installs and removes the bash shell hook in the fake home", async () => {
    const installed = await http("POST", "/delegation/connect/shell", { shell: "bash" });
    assert.equal(installed.status, 200, JSON.stringify(installed.json));
    assert.ok(existsSync(join(box.home, ".bashrc")));
    const removed = await http("POST", "/delegation/connect/shell", { shell: "bash", action: "uninstall" });
    assert.equal(removed.status, 200);
  });

  it("configures the Claude Desktop mcp entry in the fake home", async () => {
    const res = await http("POST", "/delegation/connect/mcp", { client: "claude-desktop" });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const removed = await http("POST", "/delegation/connect/mcp", { client: "claude-desktop", action: "uninstall" });
    assert.equal(removed.status, 200);
  });

  it("installs and removes the codex hooks", async () => {
    const installed = await http("POST", "/delegation/connect/codex-hooks", {});
    assert.equal((installed.json as { installed: boolean }).installed, true);
    const removed = await http("POST", "/delegation/connect/codex-hooks", { action: "uninstall" });
    assert.equal((removed.json as { installed: boolean }).installed, false);
  });
});

describe("limits and claude source routes", () => {
  it("reads limits, the forecast and a refresh", async () => {
    updateSettings({ limits: { claude: false, codex: false, codexLive: false } });
    const limits = await http("GET", "/delegation/limits");
    assert.equal(limits.status, 200, JSON.stringify(limits.json));
    const forecast = await http("GET", "/delegation/limits/forecast");
    assert.equal(forecast.status, 200);
    const refresh = await http("POST", "/delegation/limits/refresh");
    assert.equal(refresh.status, 200);
  });

  it("reads and updates the claude source preferences", async () => {
    const read = await http("GET", "/delegation/limits/claude-source");
    assert.equal(read.status, 200);
    assert.equal((read.json as { privateFallback: boolean }).privateFallback, true);
    assert.equal((await http("PUT", "/delegation/limits/claude-source", [1])).status, 400);
    assert.equal((await http("PUT", "/delegation/limits/claude-source", { privateFallback: "no" })).status, 400);
    assert.equal((await http("PUT", "/delegation/limits/claude-source", { freshMinutes: 0.5 })).status, 400);
    const updated = await http("PUT", "/delegation/limits/claude-source", { privateFallback: false, freshMinutes: 30 });
    assert.deepEqual({ fallback: (updated.json as { privateFallback: boolean }).privateFallback, fresh: (updated.json as { freshMinutes: number }).freshMinutes }, { fallback: false, fresh: 30 });
    const back = await http("PUT", "/delegation/limits/claude-source", { privateFallback: true });
    assert.equal((back.json as { privateFallback: boolean }).privateFallback, true);
  });

  it("accepts statusline reports and rejects malformed ones", async () => {
    assert.equal((await http("POST", "/delegation/limits/claude-source/report", [1])).status, 400);
    assert.equal((await http("POST", "/delegation/limits/claude-source/report", { rateLimits: {} })).status, 400);
    const resets = Math.floor(Date.now() / 1000) + 3600;
    const ok = await http("POST", "/delegation/limits/claude-source/report", {
      sessionId: "s".repeat(250),
      rateLimits: { five_hour: { used_percentage: 12, resets_at: resets }, seven_day: { used_percentage: 40, resets_at: resets }, other: 1 },
    });
    assert.equal(ok.status, 204);
    const anonymous = await http("POST", "/delegation/limits/claude-source/report", { rateLimits: { five_hour: { used_percentage: 13, resets_at: resets }, seven_day: 5 } });
    assert.equal(anonymous.status, 204);
    const read = await http("GET", "/delegation/limits/claude-source");
    assert.notEqual((read.json as { lastReportAt: number | null }).lastReportAt, null);
  });

  it("installs and removes the statusline wrapper in the fake claude home", async () => {
    const installed = await http("POST", "/delegation/limits/claude-source/install");
    assert.equal(installed.status, 200, JSON.stringify(installed.json));
    assert.equal((installed.json as { statusline: { installed: boolean } }).statusline.installed, true);
    const removed = await http("POST", "/delegation/limits/claude-source/uninstall");
    assert.equal((removed.json as { statusline: { installed: boolean } }).statusline.installed, false);
  });
});

describe("reports routes", () => {
  it("validates and creates reports", async () => {
    assert.equal((await http("POST", "/delegation/reports", { text: " " })).status, 400);
    assert.equal((await http("POST", "/delegation/reports", { text: "x", kind: "rant" })).status, 400);
    assert.equal((await http("POST", "/delegation/reports", { text: "x", taskId: "ghost" })).status, 404);
    const owner = task("reported task");
    const full = await http("POST", "/delegation/reports", { text: " shipped ", kind: "result", taskId: owner.id, workspace: "pilot", source: "test", sessionId: "s1" });
    assert.equal(full.status, 201);
    assert.equal((full.json as { text: string }).text, "shipped");
    const plain = await http("POST", "/delegation/reports", { text: "plain note" });
    assert.equal((plain.json as { kind: string }).kind, "note");
    const byTask = (await http("GET", `/delegation/reports?taskId=${owner.id}&limit=5`)).json as { text: string }[];
    assert.deepEqual(byTask.map((report) => report.text), ["shipped"]);
    const all = (await http("GET", "/delegation/reports?limit=abc")).json as unknown[];
    assert.ok(all.length >= 2);
    assert.ok(events.some((item) => item.event === "report"));
  });
});

describe("trail routes", () => {
  it("reports the trail status and flushes sessions", async () => {
    const status = await http("GET", "/delegation/trail");
    assert.equal(status.status, 200);
    assert.equal(typeof status.json, "object");
    const all = await http("POST", "/delegation/trail/flush");
    assert.equal(typeof (all.json as { scheduled: number }).scheduled, "number");
    assert.equal((await http("POST", "/delegation/trail/flush", { sessionId: "ghost" })).status, 404);
    applyHook(hook("trail-bare", { model: "opus" }));
    assert.equal((await http("POST", "/delegation/trail/flush", { sessionId: "trail-bare" })).status, 404);
    applyHook(hook("trail-real", { model: "opus", transcriptPath: transcript }));
    const one = await http("POST", "/delegation/trail/flush", { sessionId: "trail-real" });
    assert.equal(one.status, 200);
  });
});

describe("backups failures", () => {
  it("answers 500 when the backups folder is blocked by a file", async () => {
    const dir = join(box.dataDir, "backups");
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    writeFileSync(dir, "not a folder");
    const created = await http("POST", "/delegation/backups");
    assert.equal(created.status, 500);
    assert.equal(typeof errorOf(created.json), "string");
    const summary = await http("GET", "/delegation/backups");
    assert.equal(summary.status, 200);
    assert.deepEqual((summary.json as { backups: unknown[] }).backups, []);
    rmSync(dir, { force: true });
  });

  it("answers 500 with a generic message when reading or writing throws a non error", async () => {
    const { summary, backup } = backupsRouteDeps;
    backupsRouteDeps.summary = () => {
      throw new Error("summary broke");
    };
    backupsRouteDeps.backup = async () => {
      throw "odd";
    };
    try {
      const read = await http("GET", "/delegation/backups");
      assert.deepEqual({ status: read.status, json: read.json }, { status: 500, json: { error: "summary broke" } });
      const write = await http("POST", "/delegation/backups");
      assert.deepEqual({ status: write.status, json: write.json }, { status: 500, json: { error: "backup failed" } });
      backupsRouteDeps.summary = () => {
        throw 5;
      };
      const odd = await http("GET", "/delegation/backups");
      assert.deepEqual(odd.json, { error: "backups read failed" });
    } finally {
      backupsRouteDeps.summary = summary;
      backupsRouteDeps.backup = backup;
    }
  });
});

describe("routes when the hub database is gone", () => {
  before(async () => {
    await http("PUT", "/delegation/settings", { secondBrainRoot: null, workspacesRoot: null, tasks: { root: null }, features: { daily: false, trail: false, tasks: false } });
    db.close();
  });

  it("answers JSON 500 errors instead of hanging", async () => {
    for (const path of ["/delegation/overview", "/delegation/health", "/delegation/connect", "/delegation/limits", "/delegation/ui-prefs"]) {
      const res = await http("GET", path);
      assert.equal(res.status, 500, path);
      assert.equal(typeof errorOf(res.json), "string", path);
    }
    const refresh = await http("POST", "/delegation/limits/refresh");
    assert.equal(refresh.status, 500);
  });

  it("separates ui prefs read and write failures from validation errors", async () => {
    const read = await http("PUT", "/delegation/ui-prefs", { layout: {} });
    assert.equal(read.status, 500);
    const write = await http("PUT", "/delegation/ui-prefs", { sidebar: null });
    assert.equal(write.status, 500);
    assert.notEqual(errorOf(read.json), "");
    assert.notEqual(errorOf(write.json), "");
  });
});
