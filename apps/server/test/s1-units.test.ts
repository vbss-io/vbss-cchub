import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it, mock } from "node:test";
import { s1Sandbox } from "./helpers/s1-env.js";

const outside = join(process.env.TMP ?? process.env.TEMP ?? ".", `cch-s1-units-opener-${process.pid}`);
mkdirSync(outside, { recursive: true });
const opener = join(outside, "opener.mjs");
const openCapture = join(outside, "opened.txt");
writeFileSync(
  opener,
  [
    'import { appendFileSync } from "node:fs";',
    "const url = process.argv[2] ?? \"\";",
    "appendFileSync(process.env.S1_OPEN_CAPTURE, `${url}\\n`);",
    'if (url.includes("fail")) process.exit(1);',
  ].join("\n"),
);

const box = s1Sandbox("cch-s1-units-", { HUB_URL_OPENER: JSON.stringify([process.execPath, opener]), S1_OPEN_CAPTURE: openCapture });

const logged: string[] = [];
mock.method(console, "log", (...args: unknown[]) => {
  logged.push(args.map(String).join(" "));
});
await import("../src/upgrade-backup.js");
const upgradeLogs = [...logged];
mock.restoreAll();

const { focusWindow } = await import("../src/focus.js");
const { codexThreadUrl, openUrl, platformOpener, vscodeSessionUrl } = await import("../src/deep-links.js");
const { appExecutable, autostartStatus, setAutostart } = await import("../src/autostart.js");
const hooks = await import("../src/hooks-control.js");
const { ensureExtension } = await import("../src/ensure-extension.js");
const live = await import("../src/codex-live.js");
const { markCodexRolloutAfterRun, rolloutChangedSinceHubRun } = await import("../src/codex-rollout-mark.js");
const { getCodexRolloutMark, saveCodexRolloutMark } = await import("../src/delegation-store.js");
const helpers = await import("../src/route-helpers.js");
const { BadRequestError, NotFoundError } = await import("../src/delegation-launch.js");
const { WorktreeError } = await import("../src/worktrees.js");
const { db } = await import("../src/db.js");

const SAMPLE_THREAD = "01a0aaaa-0000-7000-8000-000000000001";

after(() => {
  db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  rmSync(outside, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

describe("upgrade-backup", () => {
  it("writes no backup and logs nothing when there is no database yet", () => {
    assert.deepEqual(upgradeLogs, []);
    assert.equal(existsSync(join(box.dataDir, "backups")), false);
  });
});

describe("focusWindow", () => {
  it("refuses off Windows and without a window hint", async () => {
    assert.deepEqual(await focusWindow(10, "C:/x", async () => undefined, "linux"), { ok: false, reason: "not windows" });
    assert.deepEqual(await focusWindow(null, null, async () => undefined, "win32"), { ok: false, reason: "no window hint (pid/cwd)" });
    assert.deepEqual(await focusWindow(0, null, async () => undefined, "win32"), { ok: false, reason: "no window hint (pid/cwd)" });
  });

  it("runs the focus script with the pid and the cwd", async () => {
    const seen: { file: string; args: string[]; options: { windowsHide: boolean; timeout: number } }[] = [];
    const result = await focusWindow(
      42,
      "C:/repo",
      async (file, args, options) => {
        seen.push({ file, args, options });
      },
      "win32",
    );
    assert.deepEqual(result, { ok: true });
    assert.equal(seen[0]?.file, "powershell");
    assert.ok(seen[0]?.args.some((arg) => arg.replace(/\\/g, "/").endsWith("scripts/focus.ps1")));
    assert.deepEqual(seen[0]?.args.slice(-4), ["-HostPid", "42", "-Cwd", "C:/repo"]);
    assert.deepEqual(seen[0]?.options, { windowsHide: true, timeout: 15_000 });
    await focusWindow(
      null,
      "C:/only-cwd",
      async (_file, args) => {
        seen.push({ file: "second", args, options: { windowsHide: true, timeout: 0 } });
      },
      "win32",
    );
    assert.deepEqual(seen[1]?.args.slice(-4), ["-HostPid", "0", "-Cwd", "C:/only-cwd"]);
    await focusWindow(
      7,
      null,
      async (_file, args) => {
        seen.push({ file: "third", args, options: { windowsHide: true, timeout: 0 } });
      },
      "win32",
    );
    assert.deepEqual(seen[2]?.args.slice(-2), ["-Cwd", ""]);
  });

  it("maps exit code 2 to a closed window and anything else to a failure", async () => {
    const failWith = (code: number) => async () => {
      throw Object.assign(new Error("exit"), { code });
    };
    assert.deepEqual(await focusWindow(1, null, failWith(2), "win32"), { ok: false, reason: "window not found (session closed?)" });
    assert.deepEqual(await focusWindow(1, null, failWith(1), "win32"), { ok: false, reason: "focus failed" });
  });

  it("uses the real platform and runner by default", async () => {
    const result = await focusWindow(null, null);
    assert.equal(result.ok, false);
  });
});

describe("deep links", () => {
  it("builds encoded VS Code and Codex links", () => {
    assert.equal(vscodeSessionUrl("a b/c"), "vscode://anthropic.claude-code/open?session=a%20b%2Fc");
    assert.equal(codexThreadUrl("t/1"), "codex://threads/t%2F1");
  });

  it("picks the platform opener", () => {
    assert.deepEqual(platformOpener("win32"), ["rundll32", "url.dll,FileProtocolHandler"]);
    assert.deepEqual(platformOpener("darwin"), ["open"]);
    assert.deepEqual(platformOpener("linux"), ["xdg-open"]);
    assert.ok(platformOpener().length >= 1);
  });

  it("refuses links outside the allowed schemes", async () => {
    assert.deepEqual(await openUrl("https://example.com"), { ok: false, url: "https://example.com", reason: "link scheme not allowed" });
  });

  it("opens allowed links with the configured opener and reports failures", async () => {
    const ok = await openUrl(codexThreadUrl("thread-1"));
    assert.deepEqual(ok, { ok: true, url: "codex://threads/thread-1" });
    const failed = await openUrl(codexThreadUrl("fail-1"));
    assert.deepEqual(failed, { ok: false, url: "codex://threads/fail-1", reason: "the link could not be opened" });
    assert.deepEqual(readFileSync(openCapture, "utf8").trim().split(/\r?\n/), ["codex://threads/thread-1", "codex://threads/fail-1"]);
  });
});

describe("autostart", () => {
  const exe = join(box.tmp, "vbss-cchub.exe");

  it("finds the app executable from HUB_APP_EXE only when it exists", () => {
    delete process.env.HUB_APP_EXE;
    assert.equal(appExecutable(), null);
    process.env.HUB_APP_EXE = join(box.tmp, "missing.exe");
    assert.equal(appExecutable(), null);
    writeFileSync(exe, "");
    process.env.HUB_APP_EXE = `\\\\?\\${exe}`;
    assert.equal(appExecutable(), exe);
  });

  it("reports unsupported off Windows", async () => {
    const status = await autostartStatus(async () => ({ stdout: "" }), () => "linux");
    assert.deepEqual(status, { supported: false, enabled: false, exe, error: null });
    const set = await setAutostart(true, async () => ({ stdout: "" }), () => "linux");
    assert.equal(set.error, "start with the OS is only wired for Windows");
  });

  it("reads the Run value and compares it with the executable", async () => {
    const commands: string[] = [];
    const matching = await autostartStatus(async (command) => {
      commands.push(command);
      return { stdout: `"${exe.toUpperCase()}"\r\n` };
    }, () => "win32");
    assert.deepEqual(matching, { supported: true, enabled: true, exe, error: null });
    assert.match(commands[0] ?? "", /Get-ItemProperty -Path 'HKCU:\\Software\\vbss-cchub-g0b-s1-missing-key' -Name 'VBSS CCHUB'/);
    const other = await autostartStatus(async () => ({ stdout: '"C:/other.exe"' }), () => "win32");
    assert.equal(other.enabled, false);
    const empty = await autostartStatus(async () => ({ stdout: "" }), () => "win32");
    assert.equal(empty.enabled, false);
  });

  it("counts any Run value as enabled when the executable is unknown", async () => {
    delete process.env.HUB_APP_EXE;
    const status = await autostartStatus(async () => ({ stdout: '"C:/anything.exe"' }), () => "win32");
    assert.deepEqual(status, { supported: false, enabled: true, exe: null, error: null });
    const set = await setAutostart(true, async () => ({ stdout: "" }), () => "win32");
    assert.equal(set.error, "the app executable was not found; use the installed app");
    process.env.HUB_APP_EXE = exe;
  });

  it("reports read failures", async () => {
    const failed = await autostartStatus(async () => {
      throw new Error("access denied");
    }, () => "win32");
    assert.deepEqual(failed, { supported: true, enabled: false, exe, error: "access denied" });
    const odd = await autostartStatus(async () => {
      throw "weird";
    }, () => "win32");
    assert.equal(odd.error, "registry read failed");
  });

  it("writes and removes the Run value, then re-reads the status", async () => {
    const commands: string[] = [];
    let stored = "";
    const shell = async (command: string) => {
      commands.push(command);
      if (command.startsWith("if (-not")) stored = `"${exe}"`;
      if (command.startsWith("Remove-ItemProperty")) stored = "";
      return { stdout: command.startsWith("(Get-ItemProperty") ? stored : "" };
    };
    const enabled = await setAutostart(true, shell, () => "win32");
    assert.equal(enabled.enabled, true);
    assert.match(commands[0] ?? "", /Set-ItemProperty .* -Value '".*vbss-cchub\.exe"'/);
    const disabled = await setAutostart(false, shell, () => "win32");
    assert.equal(disabled.enabled, false);
    assert.match(commands[2] ?? "", /^Remove-ItemProperty/);
  });

  it("reports write failures", async () => {
    const failed = await setAutostart(false, async () => {
      throw new Error("locked");
    }, () => "win32");
    assert.deepEqual(failed, { supported: true, enabled: false, exe, error: "locked" });
    const odd = await setAutostart(true, async () => {
      throw 1;
    }, () => "win32");
    assert.equal(odd.error, "registry write failed");
  });
});

describe("hooks control", () => {
  type Call = { file: string; args: string[]; options?: { timeout: number } };

  it("computes the permission hook timeout", () => {
    assert.equal(hooks.permissionHookTimeoutSec(0), hooks.PERMISSION_HOOK_OFF_TIMEOUT_SEC);
    assert.equal(hooks.permissionHookTimeoutSec(60), 60 + hooks.PERMISSION_HOOK_MARGIN_SEC);
  });

  it("runs configure for Windows and parses the last JSON line", async () => {
    const calls: Call[] = [];
    const result = await hooks.windowsHooks("install", async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: 'noise\r\n{"installed":true,"outdated":false}\r\nnot json\0\n' };
    });
    assert.deepEqual(result, { installed: true, outdated: false });
    assert.equal(calls[0]?.file, process.execPath);
    assert.ok(calls[0]?.args[0]?.replace(/\\/g, "/").endsWith("hooks/configure.mjs"));
    assert.equal(calls[0]?.args[1], "install");
    assert.deepEqual(calls[0]?.args.slice(-2), ["--permission-timeout", "330"]);
    assert.ok(!calls[0]?.args.includes("--runner"));
  });

  it("returns an empty object when configure prints no JSON", async () => {
    assert.deepEqual(await hooks.windowsHooks("status", async () => ({ stdout: "nothing here\n" })), {});
  });

  it("reads the real hooks status from the fake home by default", async () => {
    const status = await hooks.windowsHooks("status");
    assert.equal(status.installed, false);
  });

  it("configures every WSL distro except Docker's and reports per-distro errors", async () => {
    const calls: Call[] = [];
    const exec = async (file: string, args: string[], options?: { timeout: number }) => {
      calls.push({ file, args, options });
      if (file === "wsl" && args[0] === "-l") return { stdout: "U\0b\0u\0n\0t\0u\0\r\n\r\ndocker-desktop\r\ndocker-desktop-data\r\nNoUser\r\nBroken\r\nOdd\r\n" };
      if (file === "wsl" && args[1] === "NoUser") throw new Error("no distro");
      if (file === "wsl") return { stdout: "me\0\n" };
      const distro = args[args.indexOf("--source") + 1];
      if (distro === "wsl-Broken") throw new Error("configure crashed");
      if (distro === "wsl-Odd") throw "odd failure";
      return { stdout: '{"installed":true,"outdated":true}' };
    };
    const results = await hooks.wslHooks("status", exec);
    assert.deepEqual(results, [
      { distro: "Ubuntu", installed: true, outdated: true },
      { distro: "NoUser", error: "user not found" },
      { distro: "Broken", error: "configure crashed" },
      { distro: "Odd", error: "odd failure" },
    ]);
    const configureCall = calls.find((call) => call.file === process.execPath && call.args.includes("wsl-Ubuntu"));
    assert.ok(configureCall?.args.includes("\\\\wsl$\\Ubuntu\\home\\me\\.claude\\settings.json"));
    const notify = configureCall?.args[configureCall.args.indexOf("--notify") + 1] ?? "";
    assert.match(notify, /^\/mnt\/[a-z]\/.*\/hooks\/notify\.sh$/);
    assert.equal(calls[0]?.options?.timeout, 8000);
  });

  it("treats an empty whoami as a missing user and a failed listing as no distros", async () => {
    const empty = await hooks.wslHooks("status", async (_file, args) => ({ stdout: args[0] === "-l" ? "Solo\n" : "\0\n" }));
    assert.deepEqual(empty, [{ distro: "Solo", error: "user not found" }]);
    const none = await hooks.wslHooks("status", async () => {
      throw new Error("wsl missing");
    });
    assert.deepEqual(none, []);
  });

  it("merges the Windows and WSL status", () => {
    assert.deepEqual(hooks.mergeHooks({ installed: true, outdated: "yes", extra: 1 }, [{ distro: "U" }]), { installed: true, outdated: false, extra: 1, wsl: [{ distro: "U" }] });
    assert.deepEqual(hooks.mergeHooks({}, []), { installed: false, outdated: false, wsl: [] });
  });
});

describe("ensureExtension without a resource dir", () => {
  it("leaves the VS Code extensions folder alone", () => {
    const extRoot = join(box.home, ".vscode", "extensions");
    mkdirSync(extRoot, { recursive: true });
    ensureExtension();
    assert.deepEqual(readdirSync(extRoot), []);
  });
});

describe("codex live state", () => {
  const facts = (event: Parameters<typeof live.recordCodexHook>[0]["event"], extra: Partial<Parameters<typeof live.recordCodexHook>[0]> = {}) => ({
    event,
    sessionId: "live-1",
    cwd: null,
    transcriptPath: null,
    model: null,
    toolName: null,
    toolInput: null,
    lastAssistantMessage: null,
    delegated: false,
    ...extra,
  });

  it("recognizes hook events", () => {
    assert.equal(live.isCodexHookEvent("Stop"), true);
    assert.equal(live.isCodexHookEvent("Nope"), false);
    assert.equal(live.isCodexHookEvent(3), false);
  });

  it("records hook facts and keeps earlier details", () => {
    live.clearCodexLive();
    const first = live.recordCodexHook(facts("SessionStart", { cwd: "C:/repo", transcriptPath: "C:/r.jsonl" }), 1000);
    assert.deepEqual(first, { sessionId: "live-1", status: "idle", cwd: "C:/repo", transcriptPath: "C:/r.jsonl", lastMessage: null, startedAt: 1000, updatedAt: 1000, interactiveAt: 1000 });
    const second = live.recordCodexHook(facts("Stop", { lastAssistantMessage: `  ${"m".repeat(400)}  `, delegated: true }), 2000);
    assert.equal(second.cwd, "C:/repo");
    assert.equal(second.lastMessage?.length, 300);
    assert.equal(second.startedAt, 1000);
    assert.equal(second.interactiveAt, 1000);
    const third = live.recordCodexHook(facts("UserPromptSubmit"), 3000);
    assert.equal(third.lastMessage, second.lastMessage);
    const delegated = live.recordCodexHook(facts("SessionStart", { sessionId: "live-2", delegated: true }), 3000);
    assert.equal(delegated.interactiveAt, null);
  });

  it("knows which sessions are open elsewhere and expires old ones", () => {
    assert.equal(live.openElsewhere("live-1", 3000), true);
    assert.equal(live.openElsewhere("live-2", 3000), false);
    assert.equal(live.openElsewhere("ghost", 3000), false);
    assert.equal(live.openElsewhere("live-1", 3000 + 13 * 3_600_000), false);
    live.recordCodexHook(facts("SessionEnd", { sessionId: "live-3" }), 3000);
    assert.equal(live.openElsewhere("live-3", 3000), false);
    assert.equal(live.listCodexLive(3000).length, 3);
    assert.deepEqual(live.listCodexLive(3000 + 13 * 3_600_000), []);
  });

  it("derives the permission move of each event", () => {
    assert.equal(live.codexSessionMove(facts("PostToolUse")), null);
    assert.equal(live.codexSessionMove(facts("PostToolUse", { toolName: "shell" }))?.scope, "tool");
    for (const event of ["Stop", "Interrupt", "UserPromptSubmit", "SessionEnd"] as const) assert.equal(live.codexSessionMove(facts(event))?.scope, "session");
    assert.equal(live.codexSessionMove(facts("SessionStart")), null);
    assert.equal(live.codexSessionMove(facts("PermissionRequest")), null);
  });

  it("merges live states into the rollout records", () => {
    const record = (id: string, file: string, updatedAt: number, cwd: string | null = null) => ({
      id,
      title: id,
      cwd,
      originator: null,
      source: null,
      threadSource: null,
      client: "codex-cli" as const,
      status: "idle" as const,
      turns: 1,
      lastMessage: "from rollout",
      startedAt: 1,
      updatedAt,
      file,
      origin: null,
      hubTaskId: null,
      customTitle: null,
      archivedAt: null,
      hidden: false,
    });
    const state = (sessionId: string, extra: Partial<ReturnType<typeof live.recordCodexHook>> = {}) => ({
      sessionId,
      status: "active" as const,
      cwd: "C:/state",
      transcriptPath: null,
      lastMessage: null,
      startedAt: 1,
      updatedAt: 50,
      interactiveAt: 1,
      ...extra,
    });
    const merged = live.mergeCodexLive(
      [record("by-id", "C:/a.jsonl", 10), record("by-path", "C:\\Logs\\B.jsonl", 100, "C:/own"), record("plain", "C:/c.jsonl", 5)],
      [
        state("by-id", { lastMessage: "live message" }),
        state("other-id", { transcriptPath: "c:/logs/b.jsonl", updatedAt: 20 }),
        state("fresh", { cwd: null, transcriptPath: null, updatedAt: 70 }),
        state("fresh-cwd", { cwd: "C:/work/project", transcriptPath: "C:/f.jsonl", updatedAt: 60 }),
        state("gone", { status: "ended", updatedAt: 80 }),
      ],
    );
    assert.deepEqual(merged.map((item) => item.id), ["by-path", "fresh", "fresh-cwd", "by-id", "plain"]);
    const byId = merged.find((item) => item.id === "by-id");
    assert.deepEqual({ status: byId?.status, cwd: byId?.cwd, lastMessage: byId?.lastMessage, updatedAt: byId?.updatedAt }, { status: "active", cwd: "C:/state", lastMessage: "live message", updatedAt: 50 });
    const byPath = merged.find((item) => item.id === "by-path");
    assert.deepEqual({ cwd: byPath?.cwd, lastMessage: byPath?.lastMessage, updatedAt: byPath?.updatedAt }, { cwd: "C:/own", lastMessage: "from rollout", updatedAt: 100 });
    assert.equal(merged.find((item) => item.id === "fresh")?.title, "Codex session");
    assert.equal(merged.find((item) => item.id === "fresh")?.file, "");
    assert.equal(merged.find((item) => item.id === "fresh-cwd")?.title, "project");
    assert.equal(merged.find((item) => item.id === "plain")?.status, "idle");
  });
});

describe("codex rollout mark", () => {
  const rolloutFile = (): string => {
    const now = new Date();
    return join(box.codexHome, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"), "rollout-sample.jsonl");
  };

  it("ignores a missing thread id and reports no change without a mark", () => {
    markCodexRolloutAfterRun(null);
    assert.equal(rolloutChangedSinceHubRun(SAMPLE_THREAD), false);
  });

  it("records the rollout size after a run and detects later writes", () => {
    markCodexRolloutAfterRun(SAMPLE_THREAD);
    const mark = getCodexRolloutMark(SAMPLE_THREAD);
    assert.equal(mark?.file, rolloutFile());
    assert.equal(rolloutChangedSinceHubRun(SAMPLE_THREAD), false);
    appendFileSync(rolloutFile(), "\n");
    assert.equal(rolloutChangedSinceHubRun(SAMPLE_THREAD), true);
  });

  it("drops the mark of a thread whose rollout is gone", () => {
    saveCodexRolloutMark({ threadId: "ghost-thread", file: join(box.tmp, "gone.jsonl"), size: 1, mtimeMs: 1 });
    assert.equal(rolloutChangedSinceHubRun("ghost-thread"), false);
    markCodexRolloutAfterRun("ghost-thread");
    assert.equal(getCodexRolloutMark("ghost-thread"), null);
  });

  it("falls back to the current rollout when the marked file moved", () => {
    saveCodexRolloutMark({ threadId: SAMPLE_THREAD, file: join(box.tmp, "moved.jsonl"), size: 1, mtimeMs: 1 });
    assert.equal(rolloutChangedSinceHubRun(SAMPLE_THREAD), true);
  });
});

describe("route helpers", () => {
  const capture = () => {
    const out: { status: number; body: unknown } = { status: 0, body: null };
    const res = {
      status(code: number) {
        out.status = code;
        return { json: (body: unknown) => void (out.body = body) };
      },
    };
    return { out, res };
  };

  it("normalizes strings and string arrays", () => {
    assert.equal(helpers.asString(" x "), " x ");
    assert.equal(helpers.asString("  "), null);
    assert.equal(helpers.asString(1), null);
    assert.deepEqual(helpers.asStringArray(["a", 1, "b"]), ["a", "b"]);
    assert.deepEqual(helpers.asStringArray("a"), []);
  });

  it("checks enumerated values", () => {
    assert.equal(helpers.oneOf(undefined, ["a", "b"], "mode"), null);
    assert.equal(helpers.oneOf("b", ["a", "b"], "mode"), "b");
    assert.throws(() => helpers.oneOf("c", ["a", "b"], "mode"), (err: unknown) => err instanceof BadRequestError && err.message === "mode must be one of: a, b");
  });

  it("maps errors to status codes", () => {
    const cases: [unknown, number, unknown][] = [
      [new WorktreeError("dirty", 409, ["a.ts"]), 409, { error: "dirty", files: ["a.ts"] }],
      [new WorktreeError("missing", 404), 404, { error: "missing" }],
      [new BadRequestError("bad"), 400, { error: "bad" }],
      [new NotFoundError("nope"), 404, { error: "nope" }],
      [new Error("boom"), 500, { error: "boom" }],
      ["text", 500, { error: "request failed" }],
    ];
    for (const [err, status, body] of cases) {
      const { out, res } = capture();
      helpers.sendError(res, err);
      assert.deepEqual(out, { status, body });
    }
  });

  it("clips text and adds the port range end to a task", () => {
    assert.equal(helpers.clipText("abcdef", 3), "abc…");
    assert.equal(helpers.clipText("abc", 3), "abc");
    const base = { portBase: null } as unknown as Parameters<typeof helpers.taskJson>[0];
    assert.equal(helpers.taskJson(base).portEnd, null);
    const withPorts = { portBase: 5100 } as unknown as Parameters<typeof helpers.taskJson>[0];
    assert.ok((helpers.taskJson(withPorts).portEnd ?? 0) > 5100);
  });
});
