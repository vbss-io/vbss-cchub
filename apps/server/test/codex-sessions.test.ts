import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { classifyCodexClient, parseRollout, scanCodexSessions } from "../src/codex-sessions.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "rollout-sample.jsonl");
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
