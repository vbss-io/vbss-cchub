import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { applyCodexOverlay, classifyCodexClient, parseRollout, scanCodexSessions, stripInjectedContext } from "../src/codex-sessions.js";

const tmp = mkdtempSync(join(tmpdir(), "cch-s2-codex-"));
const NOW = Date.parse("2026-11-16T12:00:00.000Z");

after(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const line = (value: unknown): string => JSON.stringify(value);
let counter = 0;

function rollout(lines: string[], mtimeMs = NOW - 60_000): string {
  counter += 1;
  const file = join(tmp, `rollout-${counter}.jsonl`);
  writeFileSync(file, lines.join("\n"));
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

const meta = (payload: Record<string, unknown>, at = "2026-11-16T11:00:00.000Z") => line({ timestamp: at, type: "session_meta", payload });
const message = (role: string, content: unknown, at = "2026-11-16T11:00:01.000Z") => line({ timestamp: at, type: "response_item", payload: { type: "message", role, content } });

describe("rollout parsing edge cases", () => {
  it("ignores rollouts without a usable session meta", () => {
    assert.equal(parseRollout(rollout([message("user", "hello")]), NOW), null);
    assert.equal(parseRollout(rollout([line({ type: "session_meta" })]), NOW), null);
    assert.equal(parseRollout(rollout([line({ type: "session_meta", payload: "text" })]), NOW), null);
    assert.equal(parseRollout(rollout([meta({ cwd: "C:/x" })]), NOW), null);
    assert.equal(parseRollout(rollout([meta({ id: 42 })]), NOW), null);
    assert.equal(parseRollout(rollout(["not json", "[1,2]", "7", "null"]), NOW), null);
  });

  it("accepts a session_id, a string or part-list message and keeps non-object lines out of the way", () => {
    const file = rollout([
      "[1,2,3]",
      "42",
      meta({ session_id: "thread-alt", cwd: "C:/work/project", timestamp: "not a date", originator: "codex_cli_rs", source: "cli", thread_source: "user" }),
      message("user", [{ text: "part one" }, { image: "x" }, null, { text: "part two" }]),
      message("assistant", "plain string answer with enough text"),
      message("assistant", [{ nothing: true }]),
      message("developer", "ignored role"),
      line({ timestamp: "2026-11-16T11:00:02.000Z", type: "event_msg", payload: null }),
      line({ timestamp: "2026-11-16T11:00:03.000Z", type: "event_msg", payload: { type: "task_started" } }),
      line({ timestamp: "2026-11-16T11:00:04.000Z", type: "event_msg", payload: { type: "task_complete" } }),
      line({ timestamp: "2026-11-16T11:00:05.000Z", type: "event_msg", payload: { type: "task_started" } }),
    ]);
    const record = parseRollout(file, NOW);
    assert.ok(record);
    assert.equal(record.id, "thread-alt");
    assert.equal(record.title, "part one\npart two".split("\n")[0]);
    assert.equal(record.lastMessage, "plain string answer with enough text");
    assert.equal(record.turns, 1);
    assert.equal(record.threadSource, "user");
    assert.equal(record.client, "codex-cli");
    assert.equal(record.status, "active");
    assert.ok(record.startedAt > 0);
  });

  it("titles a thread without any user prompt after its folder, or generically", () => {
    assert.equal(parseRollout(rollout([meta({ id: "t1", cwd: "C:/work/my-project" })]), NOW)?.title, "my-project");
    assert.equal(parseRollout(rollout([meta({ id: "t2" })]), NOW)?.title, "codex");
    assert.equal(parseRollout(rollout([meta({ id: "t3" }), message("user", "x".repeat(300))]), NOW)?.title.length, 100);
  });

  it("classifies the client and strips injected context", () => {
    assert.equal(classifyCodexClient(null, null), "codex-cli");
    assert.equal(classifyCodexClient("Codex Desktop", null), "codex-app");
    assert.equal(classifyCodexClient("codex_exec", null), "codex-exec");
    assert.equal(classifyCodexClient(null, "exec"), "codex-exec");
    assert.equal(classifyCodexClient(null, "VSCode"), "codex-vscode");
    assert.equal(stripInjectedContext("   plain text  "), "plain text");
    assert.equal(stripInjectedContext("<environment_context>never closed"), "");
    assert.equal(stripInjectedContext("<environment_context>cwd</environment_context>\nreal question"), "real question");
    assert.equal(stripInjectedContext("You are running inside the hub with no separator"), "");
    assert.equal(stripInjectedContext("You are running inside the hub\n\n---\n\nthe real prompt"), "the real prompt");
    assert.equal(stripInjectedContext("<realtime_delegation><source>user</source><input>do the thing</input></realtime_delegation>"), "do the thing");
    assert.equal(stripInjectedContext("<realtime_delegation><source>transcript_tail_flush</source><input>noise</input></realtime_delegation>after"), "after");
    assert.equal(stripInjectedContext("<environment_context>a</environment_context>".repeat(10)), "<environment_context>a</environment_context>".repeat(2));
  });
});

describe("scanning the dated session folders", () => {
  it("skips unreadable and unrelated entries, sorts by recency and honours the limit and window", () => {
    const root = join(tmp, "codex-home", "sessions");
    const day = (offset: number): string => {
      const at = new Date(NOW - offset * 86_400_000);
      return join(root, String(at.getFullYear()), String(at.getMonth() + 1).padStart(2, "0"), String(at.getDate()).padStart(2, "0"));
    };
    for (const offset of [0, 1, 20]) mkdirSync(day(offset), { recursive: true });
    const write = (offset: number, name: string, content: string, ageMs: number): void => {
      const file = join(day(offset), name);
      writeFileSync(file, content);
      utimesSync(file, new Date(NOW - ageMs), new Date(NOW - ageMs));
    };
    write(0, "rollout-new.jsonl", meta({ id: "new-thread", cwd: "C:/a" }), 1_000);
    write(1, "rollout-old.jsonl", meta({ id: "old-thread", cwd: "C:/b" }), 90_000_000);
    write(20, "rollout-ancient.jsonl", meta({ id: "ancient-thread" }), 20 * 86_400_000);
    write(0, "notes.txt", "not a rollout", 1_000);
    write(0, "rollout-empty.jsonl", "", 1_000);
    mkdirSync(join(day(0), "rollout-dir.jsonl"), { recursive: true });
    const records = scanCodexSessions(root, { now: NOW });
    assert.deepEqual(records.map((item) => item.id), ["new-thread", "old-thread"]);
    assert.deepEqual(scanCodexSessions(root, { now: NOW, limit: 1 }).map((item) => item.id), ["new-thread"]);
    assert.deepEqual(scanCodexSessions(root, { now: NOW, days: 30 }).map((item) => item.id), ["new-thread", "old-thread", "ancient-thread"]);
    assert.deepEqual(scanCodexSessions(root, { now: NOW + 1000 }).map((item) => item.id), ["new-thread", "old-thread"]);
    assert.deepEqual(scanCodexSessions(join(tmp, "missing-root"), { now: NOW }), []);
  });
});

describe("overlay", () => {
  const base = (id: string, over: Record<string, unknown> = {}) => ({ id, title: "title", cwd: null, originator: null, source: null, threadSource: null, client: "codex-cli", turns: 0, lastMessage: null, startedAt: 0, updatedAt: 0, file: "f", origin: null, hubTaskId: null, customTitle: null, archivedAt: null, hidden: false, status: "idle", ...over }) as never;

  it("marks hub threads, keeps running ones live and prefers the task title when there is one", () => {
    const records = [base("a"), base("b"), base("c"), base("d")];
    const result = applyCodexOverlay(records, {
      links: [
        { threadId: "a", taskId: "ta", latestRunStatus: "completed", taskTitle: "Task A" },
        { threadId: "b", taskId: "tb", latestRunStatus: "running", taskTitle: null },
      ],
      overrides: [
        { id: "c", customTitle: "Mine", archivedAt: 5, hidden: false },
        { id: "d", customTitle: null, archivedAt: null, hidden: true },
      ],
    });
    assert.deepEqual(result.map((item) => item.id), ["a", "b", "c"]);
    assert.equal(result[0]?.status, "ended");
    assert.equal(result[0]?.title, "Task A");
    assert.equal(result[0]?.origin, "hub");
    assert.equal(result[0]?.hubTaskId, "ta");
    assert.equal(result[1]?.status, "idle");
    assert.equal(result[1]?.title, "title");
    assert.equal(result[2]?.customTitle, "Mine");
    assert.equal(result[2]?.archivedAt, 5);
    assert.equal(applyCodexOverlay(records).length, 4);
    assert.equal(applyCodexOverlay(records, {})[0]?.origin, null);
  });
});
