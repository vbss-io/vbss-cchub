import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, type ProcessRow } from "../src/runtimes.js";

const HUB_PID = 500;
const APP_DIR = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0\\app";
const CLI_EXE = "C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\896a0166b774037a\\codex.exe";

const row = (pid: number, parentPid: number, name: string, commandLine: string, executablePath: string): ProcessRow => ({
  pid,
  parentPid,
  name,
  commandLine,
  executablePath,
});

describe("codex app detection", () => {
  it("finds the Codex desktop app by its install folder and ignores its helpers and bundled app-server", () => {
    const snapshot = classify(
      [
        row(40, 1, "Codex.exe", `"${APP_DIR}\\Codex.exe"`, `${APP_DIR}\\Codex.exe`),
        row(41, 40, "Codex.exe", `"${APP_DIR}\\Codex.exe" --type=renderer`, `${APP_DIR}\\Codex.exe`),
        row(42, 40, "codex.exe", `"${APP_DIR}\\resources\\codex.exe" app-server --analytics-default-enabled`, `${APP_DIR}\\resources\\codex.exe`),
      ],
      1,
      HUB_PID,
    );
    assert.deepEqual(snapshot.codexApp, { running: true, count: 1, pids: [40] });
    assert.deepEqual(snapshot.codexCli, { running: false, count: 0, pids: [] });
  });

  it("never reports the hub's own app-server or its descendants as the Codex app or the CLI", () => {
    const snapshot = classify(
      [
        row(60, HUB_PID, "codex.exe", `${CLI_EXE} app-server --listen stdio://`, CLI_EXE),
        row(61, HUB_PID, "codex.exe", `${CLI_EXE} exec --json -`, CLI_EXE),
        row(62, 61, "codex.exe", `${CLI_EXE} exec --json -`, CLI_EXE),
      ],
      1,
      HUB_PID,
    );
    assert.equal(snapshot.codexApp.running, false);
    assert.equal(snapshot.codexCli.running, false);
  });

  it("does not take an app-server outside the app folder for the app, and keeps a user CLI session", () => {
    const snapshot = classify(
      [
        row(70, 9, "codex.exe", `${CLI_EXE} app-server`, CLI_EXE),
        row(71, 9, "codex.exe", `${CLI_EXE} --yolo`, CLI_EXE),
      ],
      1,
      HUB_PID,
    );
    assert.deepEqual(snapshot.codexApp.pids, []);
    assert.deepEqual(snapshot.codexCli.pids, [71]);
  });

  it("recognizes the macOS app bundle main process only", () => {
    const snapshot = classify(
      [
        row(80, 1, "Codex", "/Applications/Codex.app/Contents/MacOS/Codex", "/Applications/Codex.app/Contents/MacOS/Codex"),
        row(81, 80, "codex", "/Applications/Codex.app/Contents/Resources/codex app-server", "/Applications/Codex.app/Contents/Resources/codex"),
      ],
      1,
      HUB_PID,
    );
    assert.deepEqual(snapshot.codexApp.pids, [80]);
    assert.deepEqual(snapshot.codexCli.pids, []);
  });
});
