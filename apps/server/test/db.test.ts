import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { HookPayload } from "../src/types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-db-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;

type Db = typeof import("../src/db.js");
let db: Db;

const payload = (overrides: Partial<HookPayload>): HookPayload => ({
  kind: "session_start",
  sessionId: "s-1",
  cwd: "C:\\work\\repo",
  source: "host",
  hostPid: null,
  shellPid: null,
  title: null,
  message: null,
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
  ...overrides,
});

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  const pid = child.pid ?? 0;
  await new Promise((resolve) => child.on("close", resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));
  return pid;
}

before(async () => {
  db = await import("../src/db.js");
});

describe("sessions", () => {
  it("keeps the folder a session started in when later hooks report another cwd", () => {
    db.applyHook(payload({ sessionId: "s-cwd", kind: "session_start", cwd: "C:\\work\\repo" }));
    const moved = db.applyHook(payload({ sessionId: "s-cwd", kind: "user_prompt", cwd: "C:\\work\\repo\\docs\\deep" }));
    assert.equal(moved.cwd, "C:\\work\\repo");
    const restarted = db.applyHook(payload({ sessionId: "s-cwd", kind: "session_start", cwd: "C:\\other" }));
    assert.equal(restarted.cwd, "C:\\other");
  });

  it("keeps the client, claude pid and transcript path of a session", () => {
    const session = db.applyHook(payload({ client: "vscode", claudePid: process.pid, transcriptPath: "C:\\t\\s.jsonl" }));
    assert.equal(session.client, "vscode");
    assert.equal(session.claudePid, process.pid);
    assert.equal(session.transcriptPath, "C:\\t\\s.jsonl");
    assert.equal(session.stale, false);
    assert.equal(session.forkOf, null);
    const later = db.applyHook(payload({ kind: "user_prompt", client: null }));
    assert.equal(later.client, "vscode");
  });

  it("resolves the parent session of a share fork", () => {
    db.applyHook(payload({ sessionId: "s-parent" }));
    db.applyHook(payload({ sessionId: "s-fork", client: "share" }));
    db.db
      .prepare(
        `INSERT INTO hub_share_forks (share_id, asker, session_id, parent_session_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("share-1", "asker-1", "s-fork", "s-parent", Date.now(), Date.now());
    assert.equal(db.getSession("s-fork")?.forkOf, "s-parent");
    assert.equal(db.getSession("s-parent")?.forkOf, null);
  });

  it("ends sessions whose Claude process is gone and leaves live ones alone", async () => {
    const gone = await deadPid();
    db.applyHook(payload({ sessionId: "s-dead", claudePid: gone, client: "terminal" }));
    db.applyHook(payload({ sessionId: "s-dead", kind: "subagent_start", agentId: "ag-1", agentType: "Explore" }));
    db.applyHook(payload({ sessionId: "s-alive", claudePid: process.pid }));
    const ended = db.endDeadSessions();
    assert.deepEqual(ended.map((session) => session.sessionId), ["s-dead"]);
    assert.equal(db.getSession("s-dead")?.status, "ended");
    assert.equal(db.getSession("s-dead")?.lastMessage, "process exited");
    assert.equal(db.listAgents("s-dead")[0]?.status, "ended");
    assert.equal(db.getSession("s-alive")?.status, "active");
    assert.deepEqual(db.endDeadSessions(), []);
  });

  it("flags sessions that went silent for hours as stale", () => {
    db.applyHook(payload({ sessionId: "s-old", kind: "notification", message: "waiting" }));
    db.db.prepare(`UPDATE sessions SET updated_at = ? WHERE session_id = ?`).run(Date.now() - 5 * 3_600_000, "s-old");
    const old = db.getSession("s-old");
    assert.equal(old?.status, "waiting");
    assert.equal(old?.stale, true);
    assert.equal(db.getSession("s-alive")?.stale, false);
  });

  it("folds Claude Desktop scratch helpers into the original session", () => {
    db.applyHook(
      payload({ sessionId: "d-parent", client: "claude-desktop", hostPid: 9100, cwd: "C:\\work\\repo" }),
    );
    db.applyHook(
      payload({
        sessionId: "d-help-1",
        client: "claude-desktop",
        hostPid: 9100,
        cwd: "C:\\Users\\v\\AppData\\Roaming\\Claude\\scratch-workspaces\\a1",
      }),
    );
    db.applyHook(
      payload({
        sessionId: "d-help-2",
        client: "claude-desktop",
        hostPid: 9100,
        cwd: "C:/Users/v/AppData/Roaming/Claude/scratch-workspaces/b2",
      }),
    );
    db.applyHook(
      payload({
        sessionId: "d-help-2",
        kind: "session_end",
        client: "claude-desktop",
        hostPid: 9100,
        cwd: "C:/Users/v/AppData/Roaming/Claude/scratch-workspaces/b2",
      }),
    );

    assert.equal(db.getSession("d-help-1")?.helperOf, "d-parent");
    assert.equal(db.getSession("d-help-2")?.helperOf, "d-parent");
    const parent = db.getSession("d-parent");
    assert.equal(parent?.helperOf, null);
    assert.equal(parent?.helpersTotal, 2);
    assert.equal(parent?.helpers, 1);
    assert.equal(db.getSession("s-alive")?.helpersTotal, 0);
  });

  it("leaves a scratch helper with no Desktop parent unparented", () => {
    db.applyHook(
      payload({
        sessionId: "d-orphan",
        client: "claude-desktop",
        hostPid: 9200,
        cwd: "C:\\Users\\v\\AppData\\Roaming\\Claude\\scratch-workspaces\\z9",
      }),
    );
    assert.equal(db.getSession("d-orphan")?.helperOf, null);
  });

  it("finds a session by its claude/host/shell pid and counts delegated tasks", () => {
    db.applyHook(payload({ sessionId: "s-origin", claudePid: 424242, hostPid: 424243, client: "terminal" }));
    assert.equal(db.sessionByPid(424242)?.sessionId, "s-origin");
    assert.equal(db.sessionByPid(424243)?.sessionId, "s-origin");
    assert.equal(db.sessionByPid(999999), null);
    assert.equal(db.getSession("s-origin")?.delegatedTasks, 0);
    assert.equal(db.getSession("s-origin")?.delegatedRunning, 0);
    const now = Date.now();
    const insertTask = db.db.prepare(
      `INSERT INTO hub_tasks (id, title, prompt, workspace, repo, cwd, add_dirs, runner, status, origin_session_id, origin_client, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertTask.run("task-origin", "t", "p", "pilot", null, "C:\\work\\repo", "[]", "claude", "running", "s-origin", "claude-code", now, now);
    insertTask.run("task-done", "t", "p", "pilot", null, "C:\\work\\repo", "[]", "claude", "completed", "s-origin", "claude-code", now, now);
    assert.equal(db.getSession("s-origin")?.delegatedTasks, 2);
    assert.equal(db.getSession("s-origin")?.delegatedRunning, 1);
  });

  it("sets and clears the favorite flag of a session", () => {
    db.applyHook(payload({ sessionId: "s-fav", client: "terminal" }));
    const before = db.getSession("s-fav");
    assert.equal(before?.favoriteAt, null);
    const favorited = db.setSessionFavorite("s-fav", true);
    assert.equal(typeof favorited?.favoriteAt, "number");
    assert.equal(db.getSession("s-fav")?.favoriteAt, favorited?.favoriteAt);
    const cleared = db.setSessionFavorite("s-fav", false);
    assert.equal(cleared?.favoriteAt, null);
    assert.equal(db.setSessionFavorite("ghost", true), null);
  });

  it("records the last assistant message of a subagent", () => {
    db.applyHook(payload({ sessionId: "s-alive", kind: "subagent_start", agentId: "ag-2", agentType: "Plan" }));
    db.applyHook(payload({ sessionId: "s-alive", kind: "subagent_stop", agentId: "ag-2", agentType: "Plan", agentMessage: "plan ready" }));
    const agent = db.listAgents("s-alive").find((item) => item.agentId === "ag-2");
    assert.equal(agent?.status, "ended");
    assert.equal(agent?.lastMessage, "plan ready");
  });
});

after(() => {
  db.db.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it("ends a session on demand with a message and never twice", () => {
  db.applyHook(payload({ sessionId: "run-sess", kind: "user_prompt", client: "hub" }));
  const ended = db.endSession("run-sess", "run completed");
  assert.equal(ended?.status, "ended");
  assert.equal(ended?.lastMessage, "run completed");
  assert.equal(db.endSession("run-sess", "again"), null);
});

it("meta hooks update title, model and pids without touching status or updated_at", () => {
  const before = db.applyHook(payload({ sessionId: "meta-sess", kind: "stop", cwd: "C:/m" }), 1_000);
  const after = db.applyMeta(payload({ sessionId: "meta-sess", kind: "meta", title: "Named later", model: "claude-opus-4-8", claudePid: process.pid, client: "vscode" }));
  assert.equal(after?.status, before.status);
  assert.equal(after?.updatedAt, before.updatedAt);
  assert.equal(after?.title, "Named later");
  assert.equal(after?.model, "claude-opus-4-8");
  assert.equal(after?.claudePid, process.pid);
  assert.equal(after?.client, "vscode");
  assert.equal(db.applyMeta(payload({ sessionId: "nope", kind: "meta" })), null);
});

it("subagent events never change the session status", () => {
  db.applyHook(payload({ sessionId: "sub-sess", kind: "stop" }));
  const afterStop = db.applyHook(payload({ sessionId: "sub-sess", kind: "subagent_stop", agentId: "a1", agentType: "Explore" }));
  assert.equal(afterStop.status, "idle");
  db.applyHook(payload({ sessionId: "sub-sess", kind: "notification" }));
  const afterStart = db.applyHook(payload({ sessionId: "sub-sess", kind: "subagent_start", agentId: "a2", agentType: "Explore" }));
  assert.equal(afterStart.status, "waiting");
  const fresh = db.applyHook(payload({ sessionId: "sub-fresh", kind: "subagent_start", agentId: "a3", agentType: "Explore" }));
  assert.equal(fresh.status, "active");
});
