import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import type { RunRequest } from "../src/executor.js";

const tmp = mkdtempSync(join(tmpdir(), "cch-startup-"));
const home = join(tmp, "home");
const cwd = join(tmp, "work");
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const capture = join(tmp, "capture.json");
mkdirSync(join(home, ".claude"), { recursive: true });
mkdirSync(cwd, { recursive: true });

process.env.HUB_HOME = home;
process.env.HUB_DATA_DIR = join(tmp, "data");
process.env.HUB_PORT = "4398";
process.env.HUB_CLAUDE_BIN = process.execPath;
process.env.HUB_CLAUDE_ARGS_PREFIX = JSON.stringify([join(fixtures, "fake-claude.mjs")]);
process.env.HUB_SKIP = "1";
process.env.FAKE_CLAUDE_CAPTURE = capture;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.CLAUDE_CODE_SIMPLE;

type Executor = typeof import("../src/executor.js");
let executor: Executor;

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  runner: "claude",
  cwd,
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

function installHubContext(projects: Record<string, unknown> = {}): void {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { cchub: { type: "stdio", command: "node", args: ["mcp.js"] } }, projects }));
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node notify.mjs", timeout: 10 }] }] } }),
  );
}

before(async () => {
  executor = await import("../src/executor.js");
});

beforeEach(() => {
  rmSync(join(home, ".claude.json"), { force: true });
  rmSync(join(home, ".claude", "settings.json"), { force: true });
});

describe("startup guard against bare mode", () => {
  it("fails a run fast when the hub MCP server and the SessionStart hooks did not load", async () => {
    installHubContext();
    const started = Date.now();
    const outcome = await withEnv({ FAKE_CLAUDE_INIT: "bare", FAKE_CLAUDE_DELAY_MS: "5000" }, () => executor.runTask(request()));
    assert.equal(outcome.status, "failed");
    assert.ok(outcome.error?.startsWith(executor.BARE_MODE_ERROR), outcome.error ?? "");
    assert.match(outcome.error ?? "", /Missing: cchub MCP server, SessionStart hooks\./);
    assert.equal(outcome.result, null);
    assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
  });

  it("completes when init lists the hub MCP server and the SessionStart hook ran", async () => {
    installHubContext();
    const events: string[] = [];
    const outcome = await executor.runTask(request({ onEvent: (event) => events.push(`${event.kind}:${event.text}`) }));
    assert.equal(outcome.status, "completed", outcome.error ?? "");
    assert.ok(events.includes("status:session started"));
  });

  it("fails when no system/init event arrives before the first turn", async () => {
    const outcome = await withEnv({ FAKE_CLAUDE_INIT: "none" }, () => executor.runTask(request()));
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error ?? "", /No system\/init event arrived before the first turn/);
  });

  it("fails when init carries no auth source", async () => {
    const outcome = await withEnv({ FAKE_CLAUDE_INIT: "nokey" }, () => executor.runTask(request()));
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error ?? "", /Missing: auth source\./);
  });

  it("expects only what the run loads: no hub MCP under --strict-mcp-config, none when nothing is installed", async () => {
    const bareEmpty = await withEnv({ FAKE_CLAUDE_INIT: "bare" }, () => executor.runTask(request()));
    assert.equal(bareEmpty.status, "completed", bareEmpty.error ?? "");
    installHubContext();
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: true, hooks: {} }));
    const strict = await withEnv({ FAKE_CLAUDE_INIT: "bare" }, () => executor.runTask(request({ strictMcpConfig: true })));
    assert.equal(strict.status, "completed", strict.error ?? "");
  });

  it("does not expect the hub MCP server in a project that disabled it", async () => {
    installHubContext({ [cwd.replace(/\\/g, "/")]: { disabledMcpServers: ["cchub"] } });
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    const outcome = await withEnv({ FAKE_CLAUDE_INIT: "bare" }, () => executor.runTask(request()));
    assert.equal(outcome.status, "completed", outcome.error ?? "");
  });

  it("does not expect a SessionStart hook that only fires for some sources", async () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "node other.mjs" }] }] } }),
    );
    const outcome = await withEnv({ FAKE_CLAUDE_INIT: "bare" }, () => executor.runTask(request({ resumeSessionId: "s-resume" })));
    assert.equal(outcome.status, "completed", outcome.error ?? "");
  });

  it("expects the SessionStart hooks of a guarded run, which come from --settings", async () => {
    const outcome = await withEnv({ FAKE_CLAUDE_INIT: "bare", HUB_SHARE_ENV_PASSTHROUGH: "FAKE_CLAUDE_INIT" }, () => executor.runTask(request({ guard: "readonly" })));
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error ?? "", /Missing: SessionStart hooks\./);
  });

  it("never forwards CLAUDE_CODE_SIMPLE to a delegated run", async () => {
    installHubContext();
    const outcome = await withEnv({ CLAUDE_CODE_SIMPLE: "1" }, () => executor.runTask(request()));
    assert.equal(outcome.status, "completed", outcome.error ?? "");
    assert.equal((JSON.parse(readFileSync(capture, "utf8")) as { prompt: string }).prompt, "hello");
  });
});

after(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
