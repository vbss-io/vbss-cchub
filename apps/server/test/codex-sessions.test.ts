import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
  applyCodexOverlay,
  stripInjectedContext,
  classifyCodexClient,
  codexLiveEntries,
  parseRollout,
  scanCodexSessions,
} from "../src/codex-sessions.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = join(fixturesDir, "rollout-sample.jsonl");
const execFixture = join(fixturesDir, "rollout-exec-sample.jsonl");
const tmp = mkdtempSync(join(tmpdir(), "cch-codex-"));

describe("codex rollouts", () => {
  it("reads the thread meta, the first real user prompt and the in-turn state", () => {
    const mtime = statSync(fixture).mtimeMs;
    const record = parseRollout(fixture, mtime + 60_000)!;
    assert.equal(record.id, "01a0aaaa-0000-7000-8000-000000000001");
    assert.equal(record.cwd, "C:\\work\\sample");
    assert.equal(record.originator, "Codex Desktop");
    assert.equal(record.threadSource, "voice_chat");
    assert.equal(record.title, "Fix the flaky test in repo-a");
    assert.equal(record.client, "codex-app");
    assert.equal(record.turns, 1);
    assert.equal(record.status, "active");
    assert.equal(parseRollout(fixture, mtime + 30 * 60_000)?.status, "idle");
    assert.equal(parseRollout(fixture, mtime + 13 * 3_600_000)?.status, "ended");
  });

  it("tells the Codex app, the CLI, exec runs and the VS Code extension apart", () => {
    assert.equal(classifyCodexClient("Codex Desktop", "vscode"), "codex-app");
    assert.equal(classifyCodexClient("codex_exec", "user"), "codex-exec");
    assert.equal(classifyCodexClient("codex_cli_rs", "vscode"), "codex-vscode");
    assert.equal(classifyCodexClient("codex_cli_rs", "cli"), "codex-cli");
    assert.equal(classifyCodexClient(null, null), "codex-cli");
  });

  it("skips injected context blocks and titles from the first real user prompt", () => {
    const dir = mkdtempSync(join(tmpdir(), "cch-inject-"));
    const file = join(dir, "rollout.jsonl");
    const line = (payload: unknown) => JSON.stringify({ type: "response_item", payload });
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "inj-1", cwd: "C:\\work\\x", source: "cli" } }),
        line({ type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\nbe nice" }] }),
        line({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n</environment_context>" }] }),
        line({ type: "message", role: "user", content: [{ type: "input_text", text: "Actually build the parser" }] }),
        "",
      ].join("\n"),
    );
    const record = parseRollout(file, Date.now())!;
    assert.equal(record.title, "Actually build the parser");
    rmSync(dir, { recursive: true, force: true });
  });

  it("ends a finished exec rollout once its turn closed and the file is stale", () => {
    const mtime = statSync(execFixture).mtimeMs;
    assert.equal(parseRollout(execFixture, mtime + 30_000)?.status, "idle");
    assert.equal(parseRollout(execFixture, mtime + 3 * 60_000)?.status, "ended");
    assert.equal(parseRollout(execFixture, mtime + 3 * 60_000)?.source, "exec");
  });

  it("strips injected blocks and the hub context but keeps the real prompt", () => {
    assert.equal(stripInjectedContext("<environment_context>\ncwd: x\n</environment_context>\n\nFix the login bug"), "Fix the login bug");
    assert.equal(stripInjectedContext("<recommended_plugins>\na\n</recommended_plugins>\n<user_instructions>\nb\n</user_instructions>\n\nSecond prompt"), "Second prompt");
    assert.equal(stripInjectedContext("You are running inside the \"vbss\" workspace, launched by the CC Hub (task 1).\nWorking directory: C:/x\n\n---\n\nReply with the git hash"), "Reply with the git hash");
    assert.equal(stripInjectedContext("# AGENTS.md instructions for repo\n\nlong text without a closing tag"), "");
    assert.equal(stripInjectedContext("plain prompt"), "plain prompt");
  });

  it("titles hub-launched threads with the task title", () => {
    const record = parseRollout(fixture, statSync(fixture).mtimeMs + 60_000)!;
    const [merged] = applyCodexOverlay([record], {
      links: [{ threadId: record.id, taskId: "task-9", latestRunStatus: "completed", taskTitle: "Autonomy check (codex)" }],
      overrides: [],
    });
    assert.equal(merged?.title, "Autonomy check (codex)");
  });

  it("keeps app/cli rollouts mtime-based and marks hub-linked threads via the overlay", () => {
    const mtime = statSync(fixture).mtimeMs;
    const record = parseRollout(fixture, mtime + 30 * 60_000)!;
    assert.equal(record.status, "idle");
    assert.equal(record.origin, null);
    const [merged] = applyCodexOverlay([record], {
      links: [{ threadId: record.id, taskId: "task-9", latestRunStatus: "completed" }],
      overrides: [],
    });
    assert.equal(merged?.origin, "hub");
    assert.equal(merged?.hubTaskId, "task-9");
    assert.equal(merged?.status, "ended");
  });

  it("merges custom title and archived state and drops hidden threads in the overlay", () => {
    const record = parseRollout(fixture, statSync(fixture).mtimeMs + 60_000)!;
    const [merged] = applyCodexOverlay([record], {
      overrides: [{ id: record.id, customTitle: "My thread", archivedAt: 123, hidden: false }],
    });
    assert.equal(merged?.customTitle, "My thread");
    assert.equal(merged?.archivedAt, 123);
    const hidden = applyCodexOverlay([record], {
      overrides: [{ id: record.id, customTitle: null, archivedAt: null, hidden: true }],
    });
    assert.deepEqual(hidden, []);
  });

  it("builds a live timeline from the rollout, skipping injected context", () => {
    const entries = codexLiveEntries(fixture);
    assert.deepEqual(
      entries.map((entry) => [entry.role, entry.tool, entry.text]),
      [
        ["user", null, "Fix the flaky test in repo-a\nand report back"],
        ["assistant", null, "Looking into the flaky test."],
        ["tool", "shell", "npm test"],
        ["result", null, "3 tests passed"],
      ],
    );
    assert.equal(codexLiveEntries(fixture, 2).length, 2);
  });

  it("scans the dated session folders of a Codex home", () => {
    const now = new Date();
    const day = join(
      tmp,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );
    mkdirSync(day, { recursive: true });
    copyFileSync(fixture, join(day, "rollout-sample.jsonl"));
    const found = scanCodexSessions(tmp, { now: now.getTime() });
    assert.equal(found.length, 1);
    assert.equal(found[0]?.id, "01a0aaaa-0000-7000-8000-000000000001");
    assert.deepEqual(scanCodexSessions(join(tmp, "missing")), []);
  });
});

after(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
