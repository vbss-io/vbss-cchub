import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, type ProcessRow } from "../src/runtimes.js";

const row = (pid: number, name: string, commandLine: string, executablePath = ""): ProcessRow => ({
  pid,
  parentPid: 1,
  name,
  commandLine,
  executablePath,
});

describe("runtime classification", () => {
  it("separates Claude Code sessions, headless runs, Claude Desktop, Codex app and Codex CLI", () => {
    const snapshot = classify(
      [
        row(10, "claude.exe", "C:\\Users\\me\\.local\\bin\\claude.exe --dangerously-skip-permissions", "C:\\Users\\me\\.local\\bin\\claude.exe"),
        row(11, "claude.exe", "C:\\Users\\me\\.local\\bin\\claude.exe -p --output-format stream-json", "C:\\Users\\me\\.local\\bin\\claude.exe"),
        row(20, "claude.exe", "\"C:\\Program Files\\WindowsApps\\Claude_1.0_x64__abc\\app\\Claude.exe\"", "C:\\Program Files\\WindowsApps\\Claude_1.0_x64__abc\\app\\Claude.exe"),
        row(21, "claude.exe", "\"C:\\Program Files\\WindowsApps\\Claude_1.0_x64__abc\\app\\Claude.exe\" --type=gpu-process", "C:\\Program Files\\WindowsApps\\Claude_1.0_x64__abc\\app\\Claude.exe"),
        row(30, "codex.exe", "C:\\x\\codex.exe -c features.code_mode_host=true app-server --analytics", "C:\\x\\codex.exe"),
        row(31, "codex.exe", "C:\\x\\codex.exe exec --json -", "C:\\x\\codex.exe"),
        row(32, "codex.exe", "C:\\x\\codex.exe mcp-server", "C:\\x\\codex.exe"),
      ],
      123,
    );
    assert.deepEqual(snapshot.claudeCode, { running: true, count: 2, pids: [10, 11], headless: 1 });
    assert.deepEqual(snapshot.claudeDesktop, { running: true, count: 1, pids: [20] });
    assert.deepEqual(snapshot.codexApp, { running: true, count: 1, pids: [30] });
    assert.deepEqual(snapshot.codexCli, { running: true, count: 1, pids: [31] });
    assert.equal(snapshot.scannedAt, 123);
  });

  it("reports nothing running on an empty scan", () => {
    const snapshot = classify([], 1);
    assert.equal(snapshot.claudeCode.running, false);
    assert.equal(snapshot.codexApp.running, false);
  });
});
