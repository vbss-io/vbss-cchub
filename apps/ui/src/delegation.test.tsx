import { afterEach, expect, test } from "vitest";
import { hubBase } from "./api";
import * as d from "./delegation";
import { json, stubFetch, type FetchStub } from "./test-support/u5-fetch";

let stub: FetchStub;
const root = `${hubBase}/delegation`;

afterEach(() => {
  stub.restore();
});

type Case = [string, () => Promise<unknown>, string, string, unknown];

const target = { projectId: "p1", line: 4, raw: "- [ ] x" } as unknown as d.BoardTarget;

const cases: Case[] = [
  ["getSettings", () => d.getSettings(), "GET", "/settings", undefined],
  ["updateSettings", () => d.updateSettings({ features: { tasks: true } } as d.SettingsPatch), "PUT", "/settings", { features: { tasks: true } }],
  ["getBackups", () => d.getBackups(), "GET", "/backups", undefined],
  ["createBackup", () => d.createBackup(), "POST", "/backups", undefined],
  ["refreshLimits", () => d.refreshLimits(), "POST", "/limits/refresh", undefined],
  ["changeClaudeStatusline install", () => d.changeClaudeStatusline("install"), "POST", "/limits/claude-source/install", undefined],
  ["changeClaudeStatusline uninstall", () => d.changeClaudeStatusline("uninstall"), "POST", "/limits/claude-source/uninstall", undefined],
  ["saveClaudeLimitsSource", () => d.saveClaudeLimitsSource({ privateFallback: true, freshMinutes: 3 }), "PUT", "/limits/claude-source", { privateFallback: true, freshMinutes: 3 }],
  ["rescanUsage", () => d.rescanUsage(), "POST", "/usage/rescan", undefined],
  ["getToday", () => d.getToday("2026-11-16"), "GET", "/today/2026-11-16", undefined],
  ["scheduleTask", () => d.scheduleTask("2026-11-16", { projectId: "p", line: 1, raw: "r" } as d.TodayScheduleTarget), "POST", "/today/2026-11-16/schedule", { projectId: "p", line: 1, raw: "r" }],
  ["addCapture", () => d.addCapture("2026-11-16", "idea"), "POST", "/today/2026-11-16/capture", { text: "idea" }],
  ["promoteCapture", () => d.promoteCapture("2026-11-16", { index: 0 } as unknown as d.TodayPromoteTarget), "POST", "/today/2026-11-16/promote", { index: 0 }],
  ["addMeeting", () => d.addMeeting("2026-11-16", "sync"), "POST", "/today/2026-11-16/meeting", { text: "sync" }],
  ["createTodayNote", () => d.createTodayNote("2026-11-16"), "POST", "/today/2026-11-16/create", undefined],
  ["linkTick", () => d.linkTick("2026-11-16", { lineIndex: 2 } as unknown as d.TodayLinkTickInput), "POST", "/today/2026-11-16/link-tick", { lineIndex: 2 }],
  ["migrateToday", () => d.migrateToday("2026-11-16"), "POST", "/today/2026-11-16/migrate", undefined],
  ["reorderFocus", () => d.reorderFocus("2026-11-16", { from: 1, to: 2 } as unknown as d.TodayReorderInput), "POST", "/today/2026-11-16/reorder", { from: 1, to: 2 }],
  ["clearToday", () => d.clearToday("2026-11-16"), "POST", "/today/2026-11-16/clear", undefined],
  ["undoClearToday", () => d.undoClearToday("2026-11-16", "tok"), "POST", "/today/2026-11-16/clear/undo", { token: "tok" }],
  ["getTodaySubtasks", () => d.getTodaySubtasks("2026-11-16", "p 1", 7), "GET", "/today/2026-11-16/subtasks?projectId=p%201&line=7", undefined],
  ["planTodaySubtask", () => d.planTodaySubtask("2026-11-16", { projectId: "p", line: 1, raw: "r", planned: true }), "POST", "/today/2026-11-16/subtasks", { projectId: "p", line: 1, raw: "r", planned: true }],
  ["listWorkspaces", () => d.listWorkspaces(), "GET", "/workspaces", undefined],
  ["createWorkspace", () => d.createWorkspace("ws", ["a", "b"]), "POST", "/workspaces", { name: "ws", repos: ["a", "b"] }],
  ["updateWorkspace", () => d.updateWorkspace("w/s", ["a"]), "PUT", "/workspaces/w%2Fs", { repos: ["a"] }],
  ["deleteWorkspace plain", () => d.deleteWorkspace("ws", false), "DELETE", "/workspaces/ws", undefined],
  ["deleteWorkspace with context", () => d.deleteWorkspace("ws", true), "DELETE", "/workspaces/ws?context=1", undefined],
  ["openWorkspace", () => d.openWorkspace("ws"), "POST", "/workspaces/ws/open", undefined],
  ["getConnect", () => d.getConnect(), "GET", "/connect", undefined],
  ["configureShell", () => d.configureShell("bash", "install"), "POST", "/connect/shell", { shell: "bash", action: "install" }],
  ["configureMcp", () => d.configureMcp("codex", "uninstall"), "POST", "/connect/mcp", { client: "codex", action: "uninstall" }],
  ["getCodexHooks", () => d.getCodexHooks(), "GET", "/connect/codex-hooks", undefined],
  ["configureCodexHooks", () => d.configureCodexHooks("install"), "POST", "/connect/codex-hooks", { action: "install" }],
  ["listTasks default", () => d.listTasks(), "GET", "/tasks?limit=100", undefined],
  ["listTasks archived", () => d.listTasks(5, true), "GET", "/tasks?limit=5&archived=1", undefined],
  ["listTasksByOrigin", () => d.listTasksByOrigin("s 1", 9), "GET", "/tasks?origin=s%201&limit=9", undefined],
  ["getTask", () => d.getTask("t/1"), "GET", "/tasks/t%2F1", undefined],
  ["getTaskEvents", () => d.getTaskEvents("t1"), "GET", "/tasks/t1/events", undefined],
  ["continueTask", () => d.continueTask("t1", { prompt: "go", model: "m" }), "POST", "/tasks/t1/continue", { prompt: "go", model: "m" }],
  ["cancelTask", () => d.cancelTask("t1"), "POST", "/tasks/t1/cancel", undefined],
  ["getWorktree", () => d.getWorktree("t1"), "GET", "/tasks/t1/worktree", undefined],
  ["mergeWorktree", () => d.mergeWorktree("t1"), "POST", "/tasks/t1/merge", undefined],
  ["discardWorktree", () => d.discardWorktree("t1"), "POST", "/tasks/t1/worktree/discard", undefined],
  ["archiveTask", () => d.archiveTask("t1"), "POST", "/tasks/t1/archive", undefined],
  ["unarchiveTask", () => d.unarchiveTask("t1"), "POST", "/tasks/t1/unarchive", undefined],
  ["listReports", () => d.listReports(), "GET", "/reports?limit=50", undefined],
  ["createReport", () => d.createReport({ text: "done", kind: "result", taskId: "t1" }), "POST", "/reports", { text: "done", kind: "result", taskId: "t1", source: "hub-ui" }],
  ["listShares", () => d.listShares(), "GET", "/shares", undefined],
  ["createShare", () => d.createShare({ label: "x", expiresInHours: null } as unknown as d.CreateShareInput), "POST", "/shares", { label: "x", expiresInHours: null }],
  ["updateShare", () => d.updateShare("s/1", { paused: true }), "PATCH", "/shares/s%2F1", { paused: true }],
  ["deleteShare", () => d.deleteShare("s1"), "DELETE", "/shares/s1", undefined],
  ["listShareActivity", () => d.listShareActivity(), "GET", "/shares/activity?limit=40", undefined],
  ["listShareRequests", () => d.listShareRequests("s1", 3), "GET", "/shares/s1/requests?limit=3", undefined],
  ["getTunnel", () => d.getTunnel(), "GET", "/tunnel", undefined],
  ["startTunnel", () => d.startTunnel(), "POST", "/tunnel/start", undefined],
  ["stopTunnel", () => d.stopTunnel(), "POST", "/tunnel/stop", undefined],
  ["updateTunnelSettings", () => d.updateTunnelSettings({ authtoken: "t", domain: null }), "PUT", "/tunnel/settings", { authtoken: "t", domain: null }],
  ["getFirewall", () => d.getFirewall(), "GET", "/tunnel/firewall", undefined],
  ["getFirewall forced", () => d.getFirewall(true), "GET", "/tunnel/firewall?force=1", undefined],
  ["allowFirewall", () => d.allowFirewall(), "POST", "/tunnel/firewall", undefined],
  ["getAutostart", () => d.getAutostart(), "GET", "/system/autostart", undefined],
  ["setAutostart", () => d.setAutostart(true), "PUT", "/system/autostart", { enabled: true }],
  ["listShareFiles", () => d.listShareFiles("s1"), "GET", "/shares/s1/files", undefined],
  ["getDaily", () => d.getDaily(), "GET", "/daily", undefined],
  ["prepareDaily", () => d.prepareDaily("2026-11-16"), "GET", "/daily/2026-11-16/prepare", undefined],
  ["closeYesterday", () => d.closeYesterday("2026-11-16", { done: [] } as unknown as d.DailyCloseYesterdayInput), "POST", "/daily/2026-11-16/close-yesterday", { done: [] }],
  ["getDailyEntry", () => d.getDailyEntry("2026-11-16"), "GET", "/daily/2026-11-16", undefined],
  ["generateDaily bare", () => d.generateDaily("2026-11-16"), "POST", "/daily/2026-11-16/generate", {}],
  ["generateDaily trimmed", () => d.generateDaily("2026-11-16", "  focus  ", "  ctx "), "POST", "/daily/2026-11-16/generate", { focus: "focus", context: "ctx" }],
  ["generateDaily blank", () => d.generateDaily("2026-11-16", "   ", ""), "POST", "/daily/2026-11-16/generate", {}],
  ["listDailySessions", () => d.listDailySessions("2026-11-16"), "GET", "/daily/sessions?date=2026-11-16", undefined],
  ["getTasksBoard", () => d.getTasksBoard(), "GET", "/tasks-board", undefined],
  ["patchBoardItem", () => d.patchBoardItem(target, { status: "done" }), "PATCH", "/tasks-board/item", { ...target, status: "done" }],
  ["createBoardItem", () => d.createBoardItem({ projectId: "p", title: "t" }), "POST", "/tasks-board/item", { projectId: "p", title: "t" }],
  ["addBoardNote", () => d.addBoardNote(target, "note"), "POST", "/tasks-board/note", { ...target, text: "note" }],
  ["editBoardNote", () => d.editBoardNote(target, "edit"), "PATCH", "/tasks-board/note", { ...target, text: "edit" }],
  ["deleteBoardNote", () => d.deleteBoardNote(target), "DELETE", "/tasks-board/note", target],
  ["openBoardProjectInEditor", () => d.openBoardProjectInEditor("p1"), "POST", "/tasks-board/open", { projectId: "p1" }],
  ["sweepBoardDone all", () => d.sweepBoardDone(), "POST", "/tasks-board/sweep-done", {}],
  ["sweepBoardDone project", () => d.sweepBoardDone("p1"), "POST", "/tasks-board/sweep-done", { projectId: "p1" }],
  ["getDailyLinks", () => d.getDailyLinks("2026-11-16"), "GET", "/tasks-board/daily-links?date=2026-11-16", undefined],
  ["addBoardTaskToDaily bare", () => d.addBoardTaskToDaily(target), "POST", "/tasks-board/add-to-daily", target],
  ["addBoardTaskToDaily dated", () => d.addBoardTaskToDaily(target, "2026-11-16"), "POST", "/tasks-board/add-to-daily", { ...target, date: "2026-11-16" }],
  ["syncBoardTaskToDaily bare", () => d.syncBoardTaskToDaily(target), "POST", "/tasks-board/sync-daily", target],
  ["syncBoardTaskToDaily dated", () => d.syncBoardTaskToDaily(target, "2026-11-16"), "POST", "/tasks-board/sync-daily", { ...target, date: "2026-11-16" }],
  ["syncBoardFromDaily bare", () => d.syncBoardFromDaily(3), "POST", "/tasks-board/sync-from-daily", { line: 3 }],
  ["syncBoardFromDaily dated", () => d.syncBoardFromDaily(3, "2026-11-16"), "POST", "/tasks-board/sync-from-daily", { line: 3, date: "2026-11-16" }],
  ["delegateBoardTask", () => d.delegateBoardTask({ ...target, prompt: "do it" } as d.BoardDelegateInput), "POST", "/tasks-board/delegate", { ...target, prompt: "do it" }],
  ["moveBoardItem", () => d.moveBoardItem(target, "up"), "POST", "/tasks-board/move", { ...target, direction: "up" }],
  ["reparentBoardTask", () => d.reparentBoardTask(target, { line: 1, raw: "r" }), "POST", "/tasks-board/reparent", { ...target, parent: { line: 1, raw: "r" } }],
  ["reparentBoardTask to root", () => d.reparentBoardTask(target, null), "POST", "/tasks-board/reparent", { ...target, parent: null }],
  ["moveBoardTaskToProject", () => d.moveBoardTaskToProject(target, "p2", { line: 1, raw: "r" }), "POST", "/tasks-board/move-to-project", { ...target, targetProjectId: "p2", parent: { line: 1, raw: "r" } }],
  ["moveBoardTaskToProject root", () => d.moveBoardTaskToProject(target, "p2", null), "POST", "/tasks-board/move-to-project", { ...target, targetProjectId: "p2" }],
  ["getTrail", () => d.getTrail(), "GET", "/trail", undefined],
  ["flushTrail all", () => d.flushTrail(), "POST", "/trail/flush", {}],
  ["flushTrail session", () => d.flushTrail("s1"), "POST", "/trail/flush", { sessionId: "s1" }],
];

test.each(cases)("%s sends the expected method, URL and JSON body", async (_name, run, method, path, body) => {
  stub = stubFetch(() => json({ ok: true }));
  await expect(run()).resolves.toEqual({ ok: true });
  const sent = stub.last();
  expect(sent.url).toBe(`${root}${path}`);
  expect(sent.method).toBe(method);
  expect(sent.body).toEqual(body);
});

test("call rejects with the server message, falls back to the status, and returns null for non-JSON success", async () => {
  stub = stubFetch(() => json({ error: "denied" }, 403));
  await expect(d.listShares()).rejects.toThrow("denied");
  stub.restore();
  stub = stubFetch(() => ({ status: 500, text: "oops", contentType: "text/plain" }));
  await expect(d.listShares()).rejects.toThrow("request failed (500)");
  stub.restore();
  stub = stubFetch(() => ({ status: 200, text: "plain", contentType: "text/plain" }));
  await expect(d.listShares()).resolves.toBeNull();
  stub.restore();
  stub = stubFetch(() => ({ status: 200, text: "", contentType: null }));
  await expect(d.listShares()).resolves.toBeNull();
});

test("typed errors map 404 on settings, backups, ui-prefs and today", async () => {
  stub = stubFetch(() => json({ error: "missing" }, 404));
  await expect(d.getSettings()).rejects.toBeInstanceOf(d.DelegationDisabledError);
  await expect(d.getBackups()).rejects.toBeInstanceOf(d.BackupsUnavailableError);
  await expect(d.putUiPrefs({})).rejects.toBeInstanceOf(d.UiPrefsUnavailableError);
  await expect(d.getToday("2026-11-16")).rejects.toThrow("missing");
  await expect(d.getToday("2026-11-16")).rejects.not.toBeInstanceOf(d.TodayUnavailableError);
  stub.restore();
  stub = stubFetch(() => ({ status: 404, text: "Not Found", contentType: "text/html" }));
  await expect(d.getToday("2026-11-16")).rejects.toBeInstanceOf(d.TodayUnavailableError);
  await expect(d.getToday("2026-11-16")).rejects.toThrow("Today is not available on this hub");
  await expect(d.listShares()).rejects.toThrow("request failed (404)");
});

test("getUiPrefs normalises the payload and falls back to empty prefs when the hub has no endpoint", async () => {
  stub = stubFetch(() => json({ sidebar: { order: ["a"], pinned: ["b"] }, layout: { board: { w: 2, bad: "x" } } }));
  await expect(d.getUiPrefs()).resolves.toEqual({ sidebar: { order: ["a"], pinned: ["b"] }, layout: { board: { w: 2 } } });
  expect(stub.last()).toMatchObject({ method: "GET", url: `${root}/ui-prefs` });
  stub.restore();
  stub = stubFetch(() => json({ error: "gone" }, 404));
  await expect(d.getUiPrefs()).resolves.toEqual({ sidebar: null, layout: {} });
  stub.restore();
  stub = stubFetch(() => json({ error: "broken" }, 500));
  await expect(d.getUiPrefs()).rejects.toThrow("broken");
});

test("putUiPrefs normalises the saved prefs", async () => {
  stub = stubFetch(() => json({ sidebar: null, layout: { a: { b: 1 } } }));
  await expect(d.putUiPrefs({ layout: { a: { b: 1 } } })).resolves.toEqual({ sidebar: null, layout: { a: { b: 1 } } });
});

test("optional reads return the body on success and null on a non-2xx answer or a network error", async () => {
  stub = stubFetch(() => json([{ name: "p" }]));
  await expect(d.fetchPlugins()).resolves.toEqual([{ name: "p" }]);
  expect(stub.last()).toMatchObject({ method: "GET", url: `${root}/plugins` });
  await expect(d.fetchLimits()).resolves.toEqual([{ name: "p" }]);
  expect(stub.last().url).toBe(`${root}/limits`);
  await d.fetchClaudeLimitsSource();
  expect(stub.last().url).toBe(`${root}/limits/claude-source`);
  stub.restore();
  stub = stubFetch(() => json({}, 404));
  await expect(d.fetchLimits()).resolves.toBeNull();
  stub.restore();
  stub = stubFetch(() => new Error("offline"));
  await expect(d.fetchPlugins()).resolves.toBeNull();
  await expect(d.fetchClaudeLimitsSource()).resolves.toBeNull();
});

test("isScanning accepts only objects flagged scanning", () => {
  expect(d.isScanning({ scanning: true })).toBe(true);
  expect(d.isScanning({ scanning: false })).toBe(false);
  expect(d.isScanning(null)).toBe(false);
  expect(d.isScanning("scanning")).toBe(false);
});

test("fetchUsageSummary returns the summary, a scanning marker, or null", async () => {
  const summary = { providers: { claude: {} } };
  stub = stubFetch(() => json(summary));
  await expect(d.fetchUsageSummary()).resolves.toEqual(summary);
  expect(stub.last().url).toBe(`${root}/usage/summary`);
  stub.restore();
  stub = stubFetch(() => json({ ready: true }));
  await expect(d.fetchUsageSummary()).resolves.toEqual({ scanning: true, startedAt: null, files: null });
  stub.restore();
  stub = stubFetch(() => json({ scanning: true, startedAt: 5, files: 12 }, 202));
  await expect(d.fetchUsageSummary()).resolves.toEqual({ scanning: true, startedAt: 5, files: 12 });
  stub.restore();
  stub = stubFetch(() => json({ scanning: true, startedAt: "x", files: Number.NaN }, 202));
  await expect(d.fetchUsageSummary()).resolves.toEqual({ scanning: true, startedAt: null, files: null });
  stub.restore();
  stub = stubFetch(() => ({ status: 202, text: "garbage" }));
  await expect(d.fetchUsageSummary()).resolves.toEqual({ scanning: true, startedAt: null, files: null });
  stub.restore();
  stub = stubFetch(() => json({ error: "x" }, 500));
  await expect(d.fetchUsageSummary()).resolves.toBeNull();
  stub.restore();
  stub = stubFetch(() => new Error("offline"));
  await expect(d.fetchUsageSummary()).resolves.toBeNull();
});

test("fetchUsage returns the report, a scanning marker, or throws with the hub message", async () => {
  const report = { days: 7, totals: {} };
  stub = stubFetch(() => json(report));
  await expect(d.fetchUsage(7)).resolves.toEqual(report);
  expect(stub.last().url).toBe(`${root}/usage?days=7`);
  stub.restore();
  stub = stubFetch(() => json({ scanning: true, files: 3 }, 202));
  await expect(d.fetchUsage(30)).resolves.toEqual({ scanning: true, startedAt: null, files: 3 });
  stub.restore();
  stub = stubFetch(() => json({ error: "scan failed" }, 500));
  await expect(d.fetchUsage(7)).rejects.toThrow("scan failed");
  stub.restore();
  stub = stubFetch(() => ({ status: 503, text: "" }));
  await expect(d.fetchUsage(7)).rejects.toThrow("request failed (503)");
});

test("getShareDoc asks for the handoff in the chosen base and returns the text", async () => {
  stub = stubFetch(() => ({ text: "# handoff", contentType: "text/markdown" }));
  await expect(d.getShareDoc("s/1")).resolves.toBe("# handoff");
  expect(stub.last().url).toBe(`${root}/shares/s%2F1/doc?base=auto`);
  await d.getShareDoc("s1", "lan");
  expect(stub.last().url).toBe(`${root}/shares/s1/doc?base=lan`);
});

test("getShareDoc throws the hub error, or a default when the error body is not JSON", async () => {
  stub = stubFetch(() => json({ error: "share revoked" }, 410));
  await expect(d.getShareDoc("s1")).rejects.toThrow("share revoked");
  stub.restore();
  stub = stubFetch(() => ({ status: 500, text: "<html>" }));
  await expect(d.getShareDoc("s1")).rejects.toThrow("handoff unavailable");
  stub.restore();
  stub = stubFetch(() => json({}, 500));
  await expect(d.getShareDoc("s1")).rejects.toThrow("handoff unavailable");
});

test("shareFileUrl encodes the id and file name and marks inbound files", () => {
  const out = { name: "a b.txt", size: 1, modifiedAt: 0, direction: "out" } as const;
  expect(d.shareFileUrl("s/1", out)).toBe(`${root}/shares/s%2F1/files/a%20b.txt`);
  expect(d.shareFileUrl("s1", { ...out, direction: "in" })).toBe(`${root}/shares/s1/files/a%20b.txt?direction=in`);
});

test("composeDaily posts the body, returns the entry and maps 409 to DailyExistsError", async () => {
  const body = { focus: ["a"] } as unknown as d.DailyComposeInput;
  stub = stubFetch(() => json({ date: "2026-11-16" }));
  await expect(d.composeDaily("2026-11-16", body)).resolves.toEqual({ date: "2026-11-16" });
  expect(stub.last()).toMatchObject({ method: "POST", url: `${root}/daily/2026-11-16/compose`, body });
  stub.restore();
  stub = stubFetch(() => json({ error: "exists", updatedAt: 9 }, 409));
  const exists = await d.composeDaily("2026-11-16", body).catch((err: unknown) => err);
  expect(exists).toBeInstanceOf(d.DailyExistsError);
  expect(exists).toMatchObject({ message: "exists", updatedAt: 9 });
  stub.restore();
  stub = stubFetch(() => ({ status: 409, text: "" }));
  await expect(d.composeDaily("2026-11-16", body)).rejects.toMatchObject({ message: "diary exists", updatedAt: null });
  stub.restore();
  stub = stubFetch(() => json({ error: "bad" }, 400));
  await expect(d.composeDaily("2026-11-16", body)).rejects.toThrow("bad");
  stub.restore();
  stub = stubFetch(() => ({ status: 500, text: "" }));
  await expect(d.composeDaily("2026-11-16", body)).rejects.toThrow("request failed (500)");
});

test("saveDailyEntry sends the base timestamp only when given and maps 409 to DailyConflictError", async () => {
  stub = stubFetch(() => json({ date: "d", path: "p", updatedAt: 2 }));
  await expect(d.saveDailyEntry("2026-11-16", "text", 5, "w1")).resolves.toEqual({ date: "d", path: "p", updatedAt: 2 });
  expect(stub.last()).toMatchObject({ method: "PUT", url: `${root}/daily/2026-11-16`, body: { content: "text", baseUpdatedAt: 5, writeId: "w1" } });
  await d.saveDailyEntry("2026-11-16", "text", undefined, "w2");
  expect(stub.last().body).toEqual({ content: "text", writeId: "w2" });
  await d.saveDailyEntry("2026-11-16", "text", null, "w3");
  expect(stub.last().body).toEqual({ content: "text", baseUpdatedAt: null, writeId: "w3" });
  stub.restore();
  stub = stubFetch(() => json({ error: "moved", content: "disk", updatedAt: 8 }, 409));
  const conflict = await d.saveDailyEntry("2026-11-16", "text", 1, "w").catch((err: unknown) => err);
  expect(conflict).toBeInstanceOf(d.DailyConflictError);
  expect(conflict).toMatchObject({ message: "moved", content: "disk", updatedAt: 8 });
  stub.restore();
  stub = stubFetch(() => ({ status: 409, text: "" }));
  await expect(d.saveDailyEntry("2026-11-16", "text", 1, "w")).rejects.toMatchObject({ message: "changed on disk", content: "", updatedAt: null });
  stub.restore();
  stub = stubFetch(() => json({ error: "bad" }, 500));
  await expect(d.saveDailyEntry("2026-11-16", "text", 1, "w")).rejects.toThrow("bad");
  stub.restore();
  stub = stubFetch(() => ({ status: 500, text: "" }));
  await expect(d.saveDailyEntry("2026-11-16", "text", 1, "w")).rejects.toThrow("request failed (500)");
});

test("organizeDailyFocus sends the base timestamp when known and maps 409 to DailyConflictError", async () => {
  stub = stubFetch(() => json({ changed: true, groups: 2 }));
  await expect(d.organizeDailyFocus("2026-11-16", 4)).resolves.toEqual({ changed: true, groups: 2 });
  expect(stub.last()).toMatchObject({ method: "POST", url: `${root}/daily/2026-11-16/organize-focus`, body: { baseUpdatedAt: 4 } });
  await d.organizeDailyFocus("2026-11-16", null);
  expect(stub.last().body).toEqual({});
  stub.restore();
  stub = stubFetch(() => json({ error: "moved", content: "disk", updatedAt: 8 }, 409));
  await expect(d.organizeDailyFocus("2026-11-16", 1)).rejects.toBeInstanceOf(d.DailyConflictError);
  stub.restore();
  stub = stubFetch(() => ({ status: 409, text: "" }));
  await expect(d.organizeDailyFocus("2026-11-16", 1)).rejects.toMatchObject({ message: "changed on disk" });
  stub.restore();
  stub = stubFetch(() => json({ error: "bad" }, 500));
  await expect(d.organizeDailyFocus("2026-11-16", 1)).rejects.toThrow("bad");
  stub.restore();
  stub = stubFetch(() => ({ status: 500, text: "" }));
  await expect(d.organizeDailyFocus("2026-11-16", 1)).rejects.toThrow("request failed (500)");
});

test("board writes map 409 to BoardConflictError with the current task and other failures to Error", async () => {
  const current = { line: 1 };
  stub = stubFetch(() => json({ error: "stale", current }, 409));
  const conflict = await d.patchBoardItem(target, { title: "x" }).catch((err: unknown) => err);
  expect(conflict).toBeInstanceOf(d.BoardConflictError);
  expect(conflict).toMatchObject({ message: "stale", current });
  stub.restore();
  stub = stubFetch(() => ({ status: 409, text: "" }));
  await expect(d.patchBoardItem(target, {})).rejects.toMatchObject({ message: "changed on disk", current: null });
  stub.restore();
  stub = stubFetch(() => json({ error: "invalid" }, 422));
  await expect(d.patchBoardItem(target, {})).rejects.toThrow("invalid");
  stub.restore();
  stub = stubFetch(() => ({ status: 500, text: "" }));
  await expect(d.patchBoardItem(target, {})).rejects.toThrow("request failed (500)");
});
