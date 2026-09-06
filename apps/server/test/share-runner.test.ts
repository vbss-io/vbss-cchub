import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "cch-runner-"));
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const capture = join(tmp, "capture.json");
process.env.HUB_DATA_DIR = join(tmp, "data");
process.env.HUB_PORT = "4397";
process.env.HUB_CLAUDE_BIN = process.execPath;
process.env.HUB_CLAUDE_ARGS_PREFIX = JSON.stringify([join(fixtures, "fake-claude.mjs")]);
process.env.HUB_SHARE_ENV_PASSTHROUGH = "FAKE_CLAUDE_CAPTURE,FAKE_CLAUDE_DELAY_MS,FAKE_CLAUDE_MODE";
process.env.FAKE_CLAUDE_CAPTURE = capture;
process.env.FAKE_CLAUDE_DELAY_MS = "60";
delete process.env.HUB_RESOURCE_DIR;

type RunnerModule = typeof import("../src/share-runner.js");
type Types = typeof import("../src/share-types.js");
let runners: RunnerModule;
let types: Types;

interface Capture {
  argv: string[];
  prompt: string;
  turns: number;
  pid: number;
  env: { HUB_PORT: string | null; HUB_SHARE_LABEL: string | null; HUB_GUARD_SHELL: string | null };
}

const readCapture = (): Capture => JSON.parse(readFileSync(capture, "utf8")) as Capture;

before(async () => {
  runners = await import("../src/share-runner.js");
  types = await import("../src/share-types.js");
});

describe("persistent share runner", () => {
  it("recovers a stale fork id by forking the owner again, then by a fresh session", async () => {
    const stale = runners.runnerFor(
      "s4:Eve",
      { cwd: tmp, addDirs: [], resumeSessionId: "orig-4", forkSession: true, artifactsRoot: null, profile: types.askProfile("low"), systemPrompt: "g", model: null, label: "Eve" },
      "stale-fork",
      60_000,
      10_000,
    );
    const events: string[] = [];
    const answer = await stale.ask("hello", (event) => events.push(`${event.kind}:${event.text}`));
    assert.equal(answer.ok, true, answer.error ?? "");
    assert.equal(answer.established, true);
    assert.notEqual(answer.sessionId, "stale-fork");
    assert.equal(stale.spawns, 2);
    assert.ok(events.includes("status:session restarted"));
    const cap = readCapture();
    const at = cap.argv.indexOf("--resume");
    assert.deepEqual(cap.argv.slice(at, at + 3), ["--resume", "orig-4", "--fork-session"]);
    stale.kill("done");
    const gone = runners.runnerFor(
      "s5:Eve",
      { cwd: tmp, addDirs: [], resumeSessionId: "stale-owner", forkSession: true, artifactsRoot: null, profile: types.askProfile("low"), systemPrompt: "g", model: null, label: "Eve" },
      "stale-fork-2",
      60_000,
      10_000,
    );
    const fresh = await gone.ask("hello again", () => undefined);
    assert.equal(fresh.ok, true, fresh.error ?? "");
    assert.equal(gone.spawns, 3);
    assert.ok(readCapture().argv.includes("--session-id"));
    assert.ok(readCapture().argv.includes("--max-turns"));
    gone.kill("done");
  });

  it("keeps one claude process across questions and streams deltas", async () => {
    const runner = runners.runnerFor(
      "s1:Will",
      { cwd: tmp, addDirs: [], resumeSessionId: "orig-1", forkSession: true, artifactsRoot: null, profile: types.askProfile("low"), systemPrompt: "guard", model: null, label: "Will" },
      null,
      60_000,
      10_000,
    );
    const deltas: string[] = [];
    const first = await runner.ask("first question", (event) => {
      if (event.kind === "text") deltas.push(event.text);
    });
    assert.equal(first.ok, true);
    assert.equal(first.text, "continued: first question");
    assert.ok(deltas.join("").includes("continued: first question"));
    const one = readCapture();
    assert.ok(one.argv.includes("--input-format"));
    assert.equal(one.argv[one.argv.indexOf("--resume") + 1], "orig-1");
    assert.ok(one.argv.includes("--fork-session"));
    assert.ok(one.argv.includes("--restricted"));
    assert.equal(one.env.HUB_SHARE_LABEL, "Will");
    assert.equal(one.env.HUB_GUARD_SHELL, "0");
    assert.equal(one.turns, 1);
    const second = await runner.ask("second question", () => undefined);
    assert.equal(second.ok, true);
    const two = readCapture();
    assert.equal(two.turns, 2);
    assert.equal(two.pid, one.pid);
    assert.equal(runner.spawns, 1);
    assert.ok(first.sessionId);
    assert.equal(second.sessionId, first.sessionId);
  });

  it("respawns with --resume of the fork after the process dies and refuses overlapping questions", async () => {
    const runner = runners.runnerFor(
      "s2:Ana",
      { cwd: tmp, addDirs: [], resumeSessionId: null, forkSession: false, artifactsRoot: null, profile: types.askProfile("high"), systemPrompt: "guard", model: null, label: "Ana" },
      null,
      60_000,
      10_000,
    );
    const first = await runner.ask("hello", () => undefined);
    assert.equal(first.ok, true);
    const forkId = first.sessionId;
    assert.ok(forkId);
    const died = await runner.ask("die", () => undefined);
    assert.equal(died.ok, false);
    assert.match(died.error ?? "", /exited/);
    const again = await runner.ask("after crash", () => undefined);
    assert.equal(again.ok, true);
    assert.equal(again.text, "continued: after crash");
    const cap = readCapture();
    assert.equal(cap.argv[cap.argv.indexOf("--resume") + 1], forkId);
    assert.ok(!cap.argv.includes("--fork-session"));
    assert.equal(cap.env.HUB_GUARD_SHELL, "1");
    assert.equal(runner.spawns, 2);
    const overlapping = runner.ask("sleep:800", () => undefined);
    const rejected = await runner.ask("too soon", () => undefined);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error ?? "", /another question/);
    assert.equal((await overlapping).ok, true);
  });

  it("adopts a stored fork id and kills runners by prefix", async () => {
    const runner = runners.runnerFor("s3:Bob", { cwd: tmp, addDirs: [], resumeSessionId: "orig-3", forkSession: true, artifactsRoot: null, profile: types.askProfile("low"), systemPrompt: "g", model: null, label: "Bob" }, "fork-stored", 60_000, 10_000);
    const answer = await runner.ask("hi again", () => undefined);
    assert.equal(answer.ok, true);
    const cap = readCapture();
    assert.equal(cap.argv[cap.argv.indexOf("--resume") + 1], "fork-stored");
    assert.ok(!cap.argv.includes("--fork-session"));
    assert.equal(runners.liveRunners().some((item) => item.key === "s3:Bob"), true);
    assert.equal(runners.killRunners("s3:", "revoked"), 1);
    assert.equal(runners.liveRunners().some((item) => item.key === "s3:Bob"), false);
  });
});

after(async () => {
  runners.killAllRunners("test over");
  const { db } = await import("../src/db.js");
  db.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
