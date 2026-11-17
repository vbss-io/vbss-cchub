import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "cch-s2-runner-"));
const here = dirname(fileURLToPath(import.meta.url));
const capture = join(tmp, "argv.json");
process.env.HUB_DATA_DIR = join(tmp, "data");
process.env.HUB_HOME = join(tmp, "home");
process.env.HUB_PORT = "4395";
process.env.HUB_CLAUDE_BIN = process.execPath;
process.env.HUB_CLAUDE_ARGS_PREFIX = JSON.stringify([join(here, "helpers", "s2-fake-claude.mjs")]);
process.env.HUB_SHARE_ENV_PASSTHROUGH = "S2_ARGV_CAPTURE";
process.env.S2_ARGV_CAPTURE = capture;
delete process.env.HUB_RESOURCE_DIR;

type Runners = typeof import("../src/share-runner.js");
type Types = typeof import("../src/share-types.js");
let runners: Runners;
let types: Types;
let config: typeof import("../src/config.js").config;

before(async () => {
  runners = await import("../src/share-runner.js");
  types = await import("../src/share-types.js");
  ({ config } = await import("../src/config.js"));
});

after(async () => {
  runners.killAllRunners("test over");
  const { db } = await import("../src/db.js");
  if (db.open) db.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

let counter = 0;

function runnerOf(profile: import("../src/share-types.js").RunProfile, extra: Partial<import("../src/share-runner.js").RunnerTarget> = {}, idleMs = 60_000, timeoutMs = 20_000) {
  counter += 1;
  return runners.runnerFor(`s2-runner-${counter}`, { cwd: tmp, addDirs: [], resumeSessionId: null, forkSession: false, artifactsRoot: null, profile, systemPrompt: "guardrail", model: null, label: `Asker ${counter}`, ...extra }, null, idleMs, timeoutMs);
}

const readArgs = (): { argv: string[]; label: string | null } => JSON.parse(readFileSync(capture, "utf8")) as { argv: string[]; label: string | null };

describe("answers and events", () => {
  it("streams text, tool summaries and the denials of the final result", async () => {
    const runner = runnerOf(types.askProfile("low"));
    const events: string[] = [];
    const answer = await runner.ask("tools", (event) => events.push(`${event.kind}:${event.text}`));
    assert.equal(answer.ok, true, answer.error ?? "");
    assert.equal(answer.text, "streamed text");
    assert.deepEqual(answer.denied, ["Bash", "Edit"]);
    assert.ok(events.includes("tool:Bash ls -la"));
    assert.ok(events.includes("tool:Read C:/x/a.txt"));
    assert.ok(events.includes("tool:Grep needle"));
    assert.ok(events.includes("tool:Glob C:/x"));
    assert.ok(events.includes("tool:WebFetch https://example.com"));
    assert.ok(events.includes("tool:Task sub work"));
    assert.ok(events.includes("tool:Agent do it"));
    assert.ok(events.includes("tool:Search q"));
    assert.ok(events.includes("tool:Empty"));
    assert.ok(events.includes("tool:NoInput"));
    assert.ok(events.includes("tool:ArrayInput"));
    assert.ok(!events.some((item) => item.includes("from a subagent")));
    assert.ok(events.includes("text:streamed "));
    assert.ok(events.includes("status:session started"));
    assert.equal(events[events.length - 1], "status:finished");
    assert.equal(runner.busy, false);
    assert.equal(runner.alive, true);
    const second = await runner.ask("plain", () => undefined);
    assert.equal(second.text, "echo: plain");
    assert.equal(runner.spawns, 1);
  });

  it("prefers the explicit result text and ignores a malformed denial list", async () => {
    const runner = runnerOf(types.askProfile("medium"));
    const answer = await runner.ask("result-text", () => undefined);
    assert.equal(answer.text, "explicit result");
    assert.deepEqual(answer.denied, []);
  });

  it("reports a failed result by its first error, its subtype or a generic message", async () => {
    const runner = runnerOf(types.askProfile("low"));
    const withError = await runner.ask("fail", () => undefined);
    assert.equal(withError.ok, false);
    assert.equal(withError.error, "boom");
    assert.equal(withError.text, null);
    assert.equal((await runner.ask("fail-subtype", () => undefined)).error, "error_max_turns");
    assert.equal((await runner.ask("fail-flag", () => undefined)).error, "success");
    assert.equal((await runner.ask("fail-unknown", () => undefined)).error, "the answer failed");
  });

  it("refuses a second question while one is being answered", async () => {
    const runner = runnerOf(types.askProfile("low"), {}, 60_000, 800);
    const events: string[] = [];
    const pending = runner.ask("hang", (event) => events.push(event.text));
    assert.equal(runner.busy, true);
    const refused = await runner.ask("another", () => undefined);
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "another question is being answered");
    const timedOut = await pending;
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.error ?? "", /timed out after \d+ min/);
    assert.ok(events.some((item) => item.startsWith("error: timed out")));
    assert.equal(runner.alive, false);
  });
});

describe("process failures", () => {
  it("reports the last meaningful stderr line when the process exits mid-answer", async () => {
    const runner = runnerOf(types.askProfile("low"));
    const crashed = await runner.ask("crash", () => undefined);
    assert.equal(crashed.ok, false);
    assert.equal(crashed.error, "claude exited (5): fatal: the model exploded");
    const bare = await runnerOf(types.askProfile("low")).ask("crash-bare", () => undefined);
    assert.equal(bare.error, "claude exited with code 1");
  });

  it("restarts once after a stale session and gives up on a persistently stale one", async () => {
    const runner = runnerOf(types.askProfile("low"));
    const events: string[] = [];
    const answer = await runner.ask("stale", (event) => events.push(event.text));
    assert.equal(answer.ok, false);
    assert.equal(answer.error, "the conversation to continue no longer exists");
    assert.ok(events.includes("session restarted"));
    assert.ok(runner.spawns >= 2);
  });

  it("answers with a clear error when the binary cannot be started", async () => {
    const original = config.claudeBin;
    (config as { claudeBin: string }).claudeBin = join(tmp, "no-such-claude");
    try {
      const runner = runnerOf(types.askProfile("low"));
      const answer = await runner.ask("hello", () => undefined);
      assert.equal(answer.ok, false);
      assert.match(answer.error ?? "", /could not start claude: /);
    } finally {
      (config as { claudeBin: string }).claudeBin = original;
    }
  });

  it("kills a busy runner with a reason and ignores a runner that never started", async () => {
    const runner = runnerOf(types.askProfile("low"));
    const pending = runner.ask("hang", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    runner.kill("owner revoked the share");
    const answer = await pending;
    assert.equal(answer.error, "owner revoked the share");
    runnerOf(types.askProfile("low")).kill("never started");
  });
});

describe("process arguments", () => {
  it("passes the profile of each trust level to the process", async () => {
    for (const [trust, profile] of [["low", types.askProfile("low")], ["medium", types.askProfile("medium")], ["high", types.askProfile("high")], ["total", types.askProfile("total")], ["implement-high", types.implementProfile("high")], ["implement-medium", types.implementProfile("medium")]] as const) {
      const runner = runnerOf(profile, { model: "fake-model", addDirs: [join(tmp, "extra")], artifactsRoot: join(tmp, "artifacts") });
      const answer = await runner.ask("hello", () => undefined);
      assert.equal(answer.ok, true, `${trust}: ${answer.error ?? ""}`);
      const { argv, label } = readArgs();
      assert.ok(label?.startsWith("Asker "), trust);
      assert.equal(argv.includes("--restricted"), profile.restricted, trust);
      assert.equal(argv.includes("--strict-mcp-config"), profile.strictMcpConfig, trust);
      assert.equal(argv.includes("--permission-prompts"), profile.permissionPrompts !== undefined, trust);
      assert.equal(argv.includes("--max-turns"), profile.maxTurns !== undefined, trust);
      assert.equal(argv.includes("--tools"), (profile.tools?.length ?? 0) > 0, trust);
      assert.equal(argv.includes("--allowedTools"), (profile.allowedTools?.length ?? 0) > 0, trust);
      assert.equal(argv.includes("--disallowedTools"), (profile.disallowedTools?.length ?? 0) > 0, trust);
      assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2), ["--model", "fake-model"]);
      assert.deepEqual(argv.slice(argv.indexOf("--add-dir"), argv.indexOf("--add-dir") + 2), ["--add-dir", join(tmp, "extra")]);
      assert.equal(argv[argv.indexOf("--permission-mode") + 1], profile.permissionMode, trust);
    }
  });

  it("resumes the adopted session and forks the owner's session once", async () => {
    const adopted = runners.runnerFor("s2-adopt", { cwd: tmp, addDirs: [], resumeSessionId: "owner-1", forkSession: true, artifactsRoot: null, profile: types.askProfile("low"), systemPrompt: "g", model: null, label: "Adopt" }, "own-fork-1", 60_000, 10_000);
    await adopted.ask("hello", () => undefined);
    assert.deepEqual(readArgs().argv.slice(readArgs().argv.indexOf("--resume"), readArgs().argv.indexOf("--resume") + 2), ["--resume", "own-fork-1"]);
    const forker = runnerOf(types.askProfile("low"), { resumeSessionId: "owner-2", forkSession: true });
    await forker.ask("hello", () => undefined);
    const forkArgs = readArgs().argv;
    assert.deepEqual(forkArgs.slice(forkArgs.indexOf("--resume"), forkArgs.indexOf("--resume") + 3), ["--resume", "owner-2", "--fork-session"]);
    const fresh = runnerOf(types.askProfile("low"));
    await fresh.ask("hello", () => undefined);
    assert.ok(readArgs().argv.includes("--session-id"));
  });
});

describe("runner registry", () => {
  it("reuses a runner by key, lists live ones, kills by prefix and removes idle runners", async () => {
    const first = runners.runnerFor("s2-reg:one", { cwd: tmp, addDirs: [], resumeSessionId: null, forkSession: false, artifactsRoot: null, profile: types.askProfile("low"), systemPrompt: "g", model: null, label: "One" }, null, 80, 10_000);
    assert.equal(runners.runnerFor("s2-reg:one", { cwd: tmp, addDirs: [], resumeSessionId: null, forkSession: false, artifactsRoot: null, profile: types.askProfile("low"), systemPrompt: "g", model: null, label: "One" }, null, 80, 10_000), first);
    await first.ask("hello", () => undefined);
    assert.ok(runners.liveRunners().some((item) => item.key === "s2-reg:one" && item.alive));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(!runners.liveRunners().some((item) => item.key === "s2-reg:one"));
    const second = runners.runnerFor("s2-reg:two", { cwd: tmp, addDirs: [], resumeSessionId: null, forkSession: false, artifactsRoot: null, profile: types.askProfile("low"), systemPrompt: "g", model: null, label: "Two" }, null, 0, 10_000);
    await second.ask("hello", () => undefined);
    assert.equal(runners.killRunners("s2-reg:", "cleanup"), 1);
    assert.equal(runners.killRunners("s2-reg:", "cleanup"), 0);
    runners.killAllRunners("done");
    assert.equal(runners.liveRunners().length, 0);
  });
});
