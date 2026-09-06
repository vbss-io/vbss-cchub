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
  it("keeps the client, claude pid and transcript path of a session", () => {
    const session = db.applyHook(payload({ client: "vscode", claudePid: process.pid, transcriptPath: "C:\\t\\s.jsonl" }));
    assert.equal(session.client, "vscode");
    assert.equal(session.claudePid, process.pid);
    assert.equal(session.transcriptPath, "C:\\t\\s.jsonl");
    assert.equal(session.stale, false);
    const later = db.applyHook(payload({ kind: "user_prompt", client: null }));
    assert.equal(later.client, "vscode");
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
