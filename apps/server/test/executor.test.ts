import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type { RunRequest } from "../src/executor.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-exec-"));
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const claudeCapture = join(dataDir, "claude-capture.json");
const codexCapture = join(dataDir, "codex-capture.json");

process.env.HUB_DATA_DIR = dataDir;
process.env.HUB_PORT = "4399";
process.env.HUB_CLAUDE_BIN = process.execPath;
process.env.HUB_CLAUDE_ARGS_PREFIX = JSON.stringify([join(fixtures, "fake-claude.mjs")]);
process.env.HUB_CODEX_BIN = process.execPath;
process.env.HUB_CODEX_ARGS_PREFIX = JSON.stringify([join(fixtures, "fake-codex.mjs")]);
process.env.HUB_SKIP = "1";
process.env.FAKE_CLAUDE_CAPTURE = claudeCapture;
process.env.FAKE_CODEX_CAPTURE = codexCapture;
delete process.env.HUB_RESOURCE_DIR;

type Executor = typeof import("../src/executor.js");
let runTask: Executor["runTask"];

interface Capture {
  argv: string[];
  cwd: string;
  prompt: string;
  env?: { HUB_TRACK_SDK: string | null; HUB_SKIP: string | null; HUB_PORT: string | null };
}

const readCapture = (path: string): Capture => JSON.parse(readFileSync(path, "utf8")) as Capture;

const request = (overrides: Partial<RunRequest>): RunRequest => ({
  runner: "claude",
  cwd: dataDir,
  addDirs: [],
  prompt: "hello",
  systemContext: null,
  model: null,
  permissionMode: null,
  sandbox: null,
  sessionId: null,
  resumeSessionId: null,
  ...overrides,
});

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
  }
}

const pair = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];

before(async () => {
  ({ runTask } = await import("../src/executor.js"));
});

describe("claude runner", () => {
  it("completes, keeps the default model, attaches context and reports through the hub hooks", async () => {
    const out = await runTask(
      request({ prompt: "hello world", systemContext: "Workspace map: repo-a at /x", addDirs: [dataDir] }),
    );
    assert.equal(out.status, "completed");
    assert.equal(out.result, "handled: hello world");
    assert.equal(out.effectiveModel, "fake-default-model");
    assert.ok(out.sessionId && out.sessionId.length > 0);
    const capture = readCapture(claudeCapture);
    assert.ok(!capture.argv.includes("--model"));
    assert.equal(pair(capture.argv, "--append-system-prompt"), "Workspace map: repo-a at /x");
    assert.equal(pair(capture.argv, "--add-dir"), dataDir);
    assert.equal(capture.env?.HUB_TRACK_SDK, "1");
    assert.equal(capture.env?.HUB_SKIP, null);
    assert.equal(capture.env?.HUB_PORT, "4399");
  });

  it("passes model and permission mode as separate argv entries", async () => {
    const out = await runTask(request({ prompt: "x", model: "sonnet", permissionMode: "acceptEdits" }));
    assert.equal(out.effectiveModel, "sonnet");
    const { argv } = readCapture(claudeCapture);
    assert.equal(pair(argv, "--model"), "sonnet");
    assert.equal(pair(argv, "--permission-mode"), "acceptEdits");
  });

  it("uses a fixed session id on launch and resumes it on continue", async () => {
    const launch = await runTask(request({ prompt: "start", sessionId: "sess-fixed" }));
    assert.equal(launch.sessionId, "sess-fixed");
    const resumed = await runTask(request({ prompt: "more", resumeSessionId: "sess-fixed" }));
    assert.equal(resumed.sessionId, "sess-fixed");
    assert.equal(resumed.result, "continued: more");
  });

  it("flags auto-denied tool permissions as attention", async () => {
    const out = await withEnv({ FAKE_CLAUDE_MODE: "denied" }, () => runTask(request({ prompt: "edit" })));
    assert.equal(out.status, "attention");
    assert.match(out.error ?? "", /permission denied for: Edit/);
  });

  it("keeps the subtype and errors of an error result", async () => {
    const out = await withEnv({ FAKE_CLAUDE_MODE: "error" }, () => runTask(request({ prompt: "boom" })));
    assert.equal(out.status, "failed");
    assert.match(out.error ?? "", /error_max_turns: Reached maximum number of turns/);
  });

  it("treats a login failure and a missing result as failed", async () => {
    const exit = await withEnv({ FAKE_CLAUDE_MODE: "exit" }, () => runTask(request({ prompt: "boom" })));
    assert.equal(exit.status, "failed");
    assert.match(exit.error ?? "", /claude login/);
    const silent = await withEnv({ FAKE_CLAUDE_MODE: "noresult" }, () => runTask(request({ prompt: "quiet" })));
    assert.equal(silent.status, "failed");
    assert.match(silent.error ?? "", /no result produced/);
  });

  it("fails without a session when the process cannot start", async () => {
    const out = await runTask(request({ cwd: join(dataDir, "missing-dir"), prompt: "x" }));
    assert.equal(out.status, "failed");
    assert.equal(out.sessionId, null);
  });

  it("cancels an in-flight run through the abort signal", async () => {
    const controller = new AbortController();
    const pending = runTask(request({ prompt: "sleep:5000", signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort(new Error("stop now"));
    const out = await pending;
    assert.equal(out.status, "cancelled");
    assert.equal(out.error, "stop now");
  });

  it("streams text deltas, tool calls and status changes through onEvent", async () => {
    const events: { kind: string; text: string }[] = [];
    const out = await runTask(request({ prompt: "tool: do it", onEvent: (event) => events.push(event) }));
    assert.equal(out.status, "completed");
    assert.ok(readCapture(claudeCapture).argv.includes("--include-partial-messages"));
    assert.equal(events[0]?.kind, "status");
    assert.ok(events.some((event) => event.kind === "tool" && event.text === "Bash echo hi"));
    const text = events.filter((event) => event.kind === "text").map((event) => event.text).join("");
    assert.equal(text, "handled: tool: do it");
    assert.equal(events[events.length - 1]?.text, "finished");
  });

  it("truncates oversized results and reassembles split lines", async () => {
    const big = await withEnv({ FAKE_CLAUDE_MODE: "big" }, () => runTask(request({ prompt: "big" })));
    assert.equal(big.result?.length, 200_000);
    const split = await withEnv({ FAKE_CLAUDE_MODE: "split" }, () => runTask(request({ prompt: "split" })));
    assert.equal(split.result, "handled: split");
  });
});

describe("codex runner", () => {
  it("launches codex exec in the workspace with every repo attached and the context prepended", async () => {
    const out = await runTask(
      request({
        runner: "codex",
        prompt: "do the thing",
        systemContext: "Workspace map",
        addDirs: [join(dataDir, "a"), join(dataDir, "b")],
        sandbox: "workspace-write",
        model: "gpt-x",
      }),
    );
    assert.equal(out.status, "completed");
    assert.equal(out.result, "codex: do the thing");
    assert.match(out.sessionId ?? "", /^thread-/);
    const capture = readCapture(codexCapture);
    assert.deepEqual(capture.argv.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
    assert.equal(pair(capture.argv, "-C"), dataDir);
    assert.equal(capture.argv.filter((arg) => arg === "--add-dir").length, 2);
    assert.equal(pair(capture.argv, "-s"), "workspace-write");
    assert.equal(pair(capture.argv, "-m"), "gpt-x");
    assert.equal(capture.argv[capture.argv.length - 1], "-");
    assert.ok(capture.prompt.startsWith("Workspace map\n\n---\n\ndo the thing"));
  });

  it("resumes a thread without re-sending the workspace flags", async () => {
    const out = await runTask(request({ runner: "codex", prompt: "again", resumeSessionId: "thread-abc" }));
    assert.equal(out.status, "completed");
    assert.equal(out.result, "resumed: again");
    assert.equal(out.sessionId, "thread-abc");
    const { argv } = readCapture(codexCapture);
    assert.deepEqual(argv.slice(0, 3), ["exec", "resume", "thread-abc"]);
    assert.ok(!argv.includes("-C"));
  });

  it("streams codex commands and messages through onEvent", async () => {
    const events: { kind: string; text: string }[] = [];
    const out = await runTask(request({ runner: "codex", prompt: "tool: list", onEvent: (event) => events.push(event) }));
    assert.equal(out.status, "completed");
    assert.ok(events.some((event) => event.kind === "tool" && event.text === "$ ls -la"));
    assert.ok(events.some((event) => event.kind === "text" && event.text === "codex: tool: list"));
    assert.equal(events[events.length - 1]?.text, "finished");
  });

  it("reports a failed turn with its message", async () => {
    const out = await withEnv({ FAKE_CODEX_MODE: "error" }, () => runTask(request({ runner: "codex", prompt: "x" })));
    assert.equal(out.status, "failed");
    assert.match(out.error ?? "", /usage limit reached/);
  });
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
