import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { overrideRuntimeRunner, runtimeSnapshot } from "../src/runtimes.js";

const realPlatform = process.platform;
const setPlatform = (value: string): void => {
  Object.defineProperty(process, "platform", { value, configurable: true });
};

afterEach(() => {
  setPlatform(realPlatform);
  overrideRuntimeRunner(null);
});

type Call = { file: string; args: string[] };

function fakeRunner(stdout: string | (() => string), calls: Call[] = []) {
  return (async (file: string, args: string[]) => {
    calls.push({ file, args });
    return { stdout: typeof stdout === "function" ? stdout() : stdout, stderr: "" };
  }) as never;
}

describe("runtime scan on Windows", () => {
  it("classifies the processes PowerShell reports, whether it prints a list or a single object", async () => {
    setPlatform("win32");
    const calls: Call[] = [];
    const rows = [
      { ProcessId: 10, ParentProcessId: 1, Name: "claude.exe", CommandLine: "claude --resume x", ExecutablePath: "C:\\Users\\a\\.local\\bin\\claude.exe" },
      { ProcessId: 11, ParentProcessId: 1, Name: "claude.exe", CommandLine: "claude -p hi", ExecutablePath: null },
      { ProcessId: 12, ParentProcessId: 1, Name: "Claude.exe", CommandLine: "C:\\WindowsApps\\Claude_1\\claude.exe", ExecutablePath: "C:\\Program Files\\WindowsApps\\Claude_1.0\\claude.exe" },
      { ProcessId: 13, ParentProcessId: 1, Name: "codex.exe", CommandLine: "codex", ExecutablePath: "C:\\bin\\codex.exe" },
      { ProcessId: 14, ParentProcessId: 1, Name: "codex.exe", CommandLine: "codex app-server", ExecutablePath: "C:\\bin\\codex.exe" },
      { Name: "ChatGPT.exe" },
    ];
    overrideRuntimeRunner(fakeRunner(JSON.stringify(rows), calls));
    const snapshot = await runtimeSnapshot();
    assert.equal(snapshot.error, null);
    assert.deepEqual(snapshot.claudeCode.pids, [10, 11]);
    assert.equal(snapshot.claudeCode.headless, 1);
    assert.deepEqual(snapshot.claudeDesktop.pids, [12]);
    assert.deepEqual(snapshot.codexCli.pids, [13]);
    assert.equal(snapshot.codexApp.running, false);
    assert.equal(calls[0]?.file, "powershell");
    assert.match(calls[0]?.args.join(" ") ?? "", /Get-CimInstance Win32_Process/);

    overrideRuntimeRunner(fakeRunner(JSON.stringify(rows[0])));
    const single = await runtimeSnapshot();
    assert.deepEqual(single.claudeCode.pids, [10]);
  });

  it("returns an empty scan for blank output and reports a failed scan as an error snapshot", async () => {
    setPlatform("win32");
    overrideRuntimeRunner(fakeRunner("   \r\n"));
    const empty = await runtimeSnapshot();
    assert.equal(empty.error, null);
    assert.equal(empty.claudeCode.running, false);
    overrideRuntimeRunner(
      (async () => {
        throw new Error("powershell is not available");
      }) as never,
    );
    const failed = await runtimeSnapshot();
    assert.equal(failed.error, "powershell is not available");
    assert.equal(failed.claudeCode.count, 0);
    overrideRuntimeRunner((async () => Promise.reject("plain failure")) as never);
    assert.equal((await runtimeSnapshot()).error, "process scan failed");
    overrideRuntimeRunner(fakeRunner("{ not json"));
    assert.match((await runtimeSnapshot()).error ?? "", /JSON|Unexpected|Expected/);
  });

  it("serves a recent scan from the cache and shares one scan between concurrent callers", async () => {
    setPlatform("win32");
    let scans = 0;
    overrideRuntimeRunner(
      (async () => {
        scans += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { stdout: "[]", stderr: "" };
      }) as never,
    );
    const [first, second] = await Promise.all([runtimeSnapshot(), runtimeSnapshot()]);
    assert.equal(first, second);
    const again = await runtimeSnapshot();
    assert.equal(again, first);
    assert.equal(scans, 1);
  });
});

describe("runtime scan on Unix", () => {
  it("reads ps output, skipping unrelated programs and malformed lines", async () => {
    setPlatform("linux");
    const calls: Call[] = [];
    const output = [
      "  100     1 claude         claude --resume abc",
      "  101   100 /usr/bin/codex /usr/bin/codex --foo",
      "  102     1 bash           bash",
      "garbage line",
      "  103     1 Codex          codex exec",
      "",
    ].join("\n");
    overrideRuntimeRunner(fakeRunner(output, calls));
    const snapshot = await runtimeSnapshot();
    assert.equal(snapshot.error, null);
    assert.deepEqual(snapshot.claudeCode.pids, [100]);
    assert.deepEqual(snapshot.codexCli.pids, [101, 103]);
    assert.equal(calls[0]?.file, "ps");
  });

  it("reports a missing ps as an error snapshot", async () => {
    setPlatform("darwin");
    overrideRuntimeRunner(
      (async () => {
        throw new Error("spawn ps ENOENT");
      }) as never,
    );
    assert.equal((await runtimeSnapshot()).error, "spawn ps ENOENT");
  });
});
