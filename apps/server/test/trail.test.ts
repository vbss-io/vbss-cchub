import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeSandbox, startServer, waitFor, type RunningServer, type Sandbox } from "./helpers.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-trail-store-"));
const brain = join(dataDir, "brain");
mkdirSync(brain, { recursive: true });
const capturePath = join(dataDir, "capture.jsonl");
const fakeModel = join(dataDir, "fake-model.mjs");

const FAKE_MODEL_SOURCE = `
import { appendFileSync, readFileSync, existsSync } from "node:fs";
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");
const capture = process.env.FAKE_TRAIL_CAPTURE;
appendFileSync(capture, JSON.stringify({ argv, stdin, env: { HUB_SKIP: process.env.HUB_SKIP ?? null, CLAUDE_HOOK_BYPASS: process.env.CLAUDE_HOOK_BYPASS ?? null, HUB_TASK_ID: process.env.HUB_TASK_ID ?? null } }) + "\\n");
const call = readFileSync(capture, "utf8").split("\\n").filter(Boolean).length;
const mode = existsSync(process.env.FAKE_TRAIL_MODE_FILE) ? readFileSync(process.env.FAKE_TRAIL_MODE_FILE, "utf8").trim() : "ok";
const failCalls = (mode.startsWith("failat:") ? mode.slice(7).split(",") : []).map(Number);
if (mode === "fail" || failCalls.includes(call)) { process.stderr.write("boom"); process.exit(1); }
const schema = JSON.parse(flag("--json-schema"));
const max = schema.properties.bullets.maxItems;
const system = flag("--system-prompt") ?? "";
let bullets;
if (system.includes("compress the running bullet list")) bullets = ["merged-a", "merged-b"];
else if (mode === "empty") bullets = [];
else if (mode === "question") bullets = ["qual repo tem esse arquivo?"];
else if (mode === "long") bullets = [Array(60).fill("palavra").join(" ")];
else if (mode === "secret") bullets = ["set password: hunter2hunter2xyz in the env"];
else if (max === 1) bullets = ["light-" + call];
else if (max === 3) bullets = ["m" + call + "a", "m" + call + "b"];
else bullets = ["h" + call + "a", "h" + call + "b", "h" + call + "c", "h" + call + "d"];
process.stdout.write(JSON.stringify({ type: "result", structured_output: { language: "en", bullets, redacted: false } }));
`;

const modeFile = join(dataDir, "mode.txt");
writeFileSync(fakeModel, FAKE_MODEL_SOURCE);
process.env.HUB_DATA_DIR = dataDir;
process.env.HUB_CLAUDE_BIN = process.execPath;
process.env.HUB_CLAUDE_ARGS_PREFIX = JSON.stringify([fakeModel]);
process.env.FAKE_TRAIL_CAPTURE = capturePath;
process.env.FAKE_TRAIL_MODE_FILE = modeFile;
process.env.HUB_SKIP = "0";
process.env.HUB_TASK_ID = "leaky-task";
delete process.env.HUB_RESOURCE_DIR;
delete process.env.HUB_WORKSPACES_ROOT;
delete process.env.HUB_EDITOR;
delete process.env.HUB_SECOND_BRAIN;

type Store = typeof import("../src/delegation-store.js");
type Db = typeof import("../src/db.js");
type Trail = typeof import("../src/trail.js");
type Brain = typeof import("../src/second-brain.js");
type Sse = typeof import("../src/sse.js");
let store: Store;
let db: Db;
let trail: Trail;
let sb: Brain;
let sse: Sse;

before(async () => {
  store = await import("../src/delegation-store.js");
  db = await import("../src/db.js");
  trail = await import("../src/trail.js");
  sb = await import("../src/second-brain.js");
  sse = await import("../src/sse.js");
});

const setMode = (mode: string): void => writeFileSync(modeFile, mode);
const calls = (): { argv: string[]; stdin: string; env: Record<string, string | null> }[] =>
  existsSync(capturePath)
    ? readFileSync(capturePath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { argv: string[]; stdin: string; env: Record<string, string | null> })
    : [];
const argOf = (call: { argv: string[] }, name: string): string | null => {
  const index = call.argv.indexOf(name);
  return index >= 0 ? (call.argv[index + 1] ?? null) : null;
};

function transcriptOf(count: number, tag = "t"): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      JSON.stringify(
        i % 2 === 0
          ? { type: "user", message: { role: "user", content: `${tag} question ${i}` } }
          : { type: "assistant", message: { content: [{ type: "text", text: `${tag} answer ${i}` }, { type: "tool_use", name: "Bash", input: {} }] } },
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

const today = (): string => sb.localDate();

function hookPayload(sessionId: string, transcriptPath: string | null, client: string | null = "terminal") {
  return {
    kind: "stop" as const,
    sessionId,
    cwd: "C:/work/repo-a",
    source: null,
    hostPid: null,
    shellPid: null,
    title: null,
    message: null,
    notificationType: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    contextTokens: null,
    agentId: null,
    agentType: null,
    client,
    claudePid: null,
    transcriptPath,
    agentMessage: null,
    shareLabel: null,
  };
}

function newSession(id: string, turns: number, client: string | null = "terminal"): string {
  const path = join(dataDir, `${id}.jsonl`);
  writeFileSync(path, transcriptOf(turns, id));
  db.applyHook(hookPayload(id, path, client));
  return path;
}

function seedState(id: string, lastTurns = 0): void {
  db.saveTrailState({ sessionId: id, lastTurns, firstStarted: Date.now() - 3_600_000, lastUpdate: Date.now() - 3_600_000, bulletsToday: 0, day: today() });
}

const trailFile = (): string => join(brain, "trail", `${today()}.md`);

async function summarize(id: string, kind: "stop" | "session_end", force = false): Promise<boolean> {
  const queued = trail.scheduleTrail(id, kind, force);
  await trail.whenTrailIdle();
  return queued;
}

describe("trail settings", () => {
  it("defaults to off with the light level and merges nested partial updates", () => {
    const defaults = store.getSettings();
    assert.equal(defaults.features.trail, false);
    assert.deepEqual(defaults.trail, { dir: null, detail: "light", model: "haiku", prompt: null, hubEvents: true });

    const detail = store.updateSettings({ trail: { detail: "high" } });
    assert.deepEqual(detail.trail, { dir: null, detail: "high", model: "haiku", prompt: null, hubEvents: true });
    assert.equal(detail.features.daily, false);

    const merged = store.updateSettings({ features: { trail: true }, trail: { dir: "logs/trail", hubEvents: false, prompt: "custom" } });
    assert.equal(merged.features.trail, true);
    assert.equal(merged.features.daily, false);
    assert.deepEqual(merged.trail, { dir: "logs/trail", detail: "high", model: "haiku", prompt: "custom", hubEvents: false });

    const cleared = store.updateSettings({ trail: { model: null, dir: null, prompt: null, detail: "light", hubEvents: true } });
    assert.deepEqual(cleared.trail, { dir: null, detail: "light", model: null, prompt: null, hubEvents: true });
    assert.equal(store.updateSettings({ features: { trail: false } }).features.trail, false);
    store.updateSettings({ trail: { model: "haiku" } });
  });

  it("resolves the trail dir against the root unless it is absolute", () => {
    assert.equal(trail.trailDirFor("/vault", { dir: null }), join("/vault", "trail"));
    assert.equal(trail.trailDirFor("/vault", { dir: "fontes/sessions" }), join("/vault", "fontes/sessions"));
    assert.equal(trail.trailDirFor("/vault", { dir: dataDir }), dataDir);
  });
});

describe("transcript delta reading", () => {
  it("counts raw user and assistant lines, clips each turn and marks tool use", () => {
    const raw = [
      JSON.stringify({ type: "ai-title", aiTitle: "x" }),
      "not json",
      JSON.stringify({ type: "user", message: { content: "x".repeat(5000) } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
      "",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }, { type: "tool_use", name: "Bash", input: {} }] } }),
      JSON.stringify({ type: "summary" }),
    ].join("\n");
    const all = trail.readTurns(raw, 0);
    assert.equal(all.totalRaw, 4);
    assert.deepEqual(
      all.turns.map((turn) => ({ role: turn.role, len: turn.text.length, rawIdx: turn.rawIdx })),
      [
        { role: "user", len: 4000, rawIdx: 0 },
        { role: "assistant", len: "[tool Read]".length, rawIdx: 1 },
        { role: "assistant", len: "done\n[tool Bash]".length, rawIdx: 3 },
      ],
    );
    assert.equal(all.turns[1]?.text, "[tool Read]");
    assert.equal(all.turns[2]?.text, "done\n[tool Bash]");
    const delta = trail.readTurns(raw, 2);
    assert.equal(delta.totalRaw, 4);
    assert.deepEqual(delta.turns.map((turn) => turn.rawIdx), [3]);
  });
});

describe("redaction", () => {
  it("masks known secret shapes and reports it", () => {
    const cases = [
      "key sk-ant-abcdefghijklmnopqrstuvwxyz0123",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi",
      "url postgres://user:s3cretpass@host/db",
      "password: hunter2hunter2xyz",
      "aws AKIAABCDEFGHIJKLMNOP",
    ];
    for (const text of cases) {
      const out = trail.redact(text);
      assert.equal(out.redacted, true, text);
      assert.match(out.text, /\[REDACTED\]/);
    }
    assert.deepEqual(trail.redact("fixed the timezone bug in api"), { text: "fixed the timezone bug in api", redacted: false });
  });
});

describe("block format and upsert", () => {
  const A = "aaaaaaaa-1111";
  const B = "bbbbbbbb-2222";
  const C = "cccccccc-3333";
  const block = (id: string, bullets: string[], extra: Partial<Parameters<Trail["buildBlock"]>[0]> = {}): string =>
    trail.buildBlock({ sessionId: id, cwd: "C:/repo", startedHHMM: "09:05", updatedHHMM: "10:20", turns: 42, bullets, redacted: false, partialThrough: 0, ...extra });

  it("builds the reference block byte for byte", () => {
    assert.equal(
      block(A, ["one", "two"], { partialThrough: 30, redacted: true }),
      [
        "<!-- session:aaaaaaaa-1111 START -->",
        "",
        "## `aaaaaaaa` · 09:05 → 10:20 · 42 turns · parcial até turn 30 ⚠️ redacted",
        "",
        "`C:/repo`",
        "",
        "- one",
        "- two",
        "",
        "<!-- session:aaaaaaaa-1111 END -->",
      ].join("\n"),
    );
    assert.match(block(A, []), /\n_\(sem detalhe capturado\)_\n/);
    assert.match(block(A, ["x"]), /^<!-- session:aaaaaaaa-1111 START -->\n\n## `aaaaaaaa` · 09:05 → 10:20 · 42 turns\n\n/);
  });

  it("creates, upserts in place and keeps the Hub section last", async () => {
    const dir = mkdtempSync(join(dataDir, "upsert-"));
    const file = join(dir, "2026-09-30.md");
    const header = "---\ntype: fonte\ncreated: 2026-09-30\nupdated: 2026-09-30\ntags: [fonte, session]\n---\n\n# Sessions — 2026-09-30\n";

    sb.upsertSessionBlock(file, A, "2026-09-30", block(A, ["first"]));
    assert.equal(readFileSync(file, "utf8"), `${header}\n${block(A, ["first"])}\n`);

    sb.upsertSessionBlock(file, B, "2026-09-30", block(B, ["second"]));
    assert.equal(readFileSync(file, "utf8"), `${header}\n${block(A, ["first"])}\n\n${block(B, ["second"])}\n`);

    sb.upsertSessionBlock(file, A, "2026-09-30", block(A, ["first", "again"]));
    assert.equal(readFileSync(file, "utf8"), `${header}\n${block(A, ["first", "again"])}\n\n${block(B, ["second"])}\n`);

    sb.appendHubSource(dir, "delegated x\nmultiline", new Date(2026, 8, 30, 9, 7), { dir, unified: true });
    await sb.whenBrainWritesIdle();
    sb.appendHubSource(dir, "report y", new Date(2026, 8, 30, 9, 8), { dir, unified: true });
    await sb.whenBrainWritesIdle();
    const withHub = `${header}\n${block(A, ["first", "again"])}\n\n${block(B, ["second"])}\n\n## Hub\n\n- 09:07 · delegated x multiline\n- 09:08 · report y\n`;
    assert.equal(readFileSync(file, "utf8"), withHub);

    sb.upsertSessionBlock(file, C, "2026-09-30", block(C, ["third"]));
    assert.equal(
      readFileSync(file, "utf8"),
      `${header}\n${block(A, ["first", "again"])}\n\n${block(B, ["second"])}\n\n${block(C, ["third"])}\n\n## Hub\n\n- 09:07 · delegated x multiline\n- 09:08 · report y\n`,
    );
    assert.deepEqual(sb.readBlockBullets(readFileSync(file, "utf8"), A), ["first", "again"]);
    assert.deepEqual(sb.readAllBlockBullets(readFileSync(file, "utf8")), ["first", "again", "second", "third"]);
    assert.equal(sb.countSessionBlocks(readFileSync(file, "utf8")), 3);
    assert.equal(existsSync(`${file}.lock`), false);
    assert.equal(trail.readBlockStart(readFileSync(file, "utf8"), B), "09:05");
  });
});

describe("reference file layout", () => {
  const A = "aaaaaaaa-1111";
  const B = "bbbbbbbb-2222";
  const block = (id: string, bullet: string): string =>
    trail.buildBlock({ sessionId: id, cwd: "C:/repo", startedHHMM: "09:05", updatedHHMM: "10:20", turns: 42, bullets: [bullet], redacted: false, partialThrough: 0 });
  const header = (created: string, updated: string): string =>
    `---\ntype: fonte\ncreated: ${created}\nupdated: ${updated}\ntags: [fonte, session]\n---\n\n# Sessions — ${created}\n`;

  it("new file with one block and two hub lines, blank lines exactly as the reference", async () => {
    const dir = mkdtempSync(join(dataDir, "layout-a-"));
    const file = join(dir, "2026-09-30.md");
    sb.upsertSessionBlock(file, A, "2026-09-30", block(A, "first"));
    sb.appendHubSource(dir, "delegated x", new Date(2026, 8, 30, 9, 7), { dir, unified: true });
    await sb.whenBrainWritesIdle();
    sb.appendHubSource(dir, "report y", new Date(2026, 8, 30, 9, 8), { dir, unified: true });
    await sb.whenBrainWritesIdle();
    assert.equal(readFileSync(file, "utf8"), `${header("2026-09-30", "2026-09-30")}\n${block(A, "first")}\n\n## Hub\n\n- 09:07 · delegated x\n- 09:08 · report y\n`);
  });

  it("a second block lands after the first and the Hub section stays last", async () => {
    const dir = mkdtempSync(join(dataDir, "layout-b-"));
    const file = join(dir, "2026-09-30.md");
    sb.upsertSessionBlock(file, A, "2026-09-30", block(A, "first"));
    sb.appendHubSource(dir, "delegated x", new Date(2026, 8, 30, 9, 7), { dir, unified: true });
    await sb.whenBrainWritesIdle();
    sb.upsertSessionBlock(file, B, "2026-09-30", block(B, "second"));
    assert.equal(
      readFileSync(file, "utf8"),
      `${header("2026-09-30", "2026-09-30")}\n${block(A, "first")}\n\n${block(B, "second")}\n\n## Hub\n\n- 09:07 · delegated x\n`,
    );
  });

  it("a file born from a hub line gets the same header and refreshes updated on every write", async () => {
    const dir = mkdtempSync(join(dataDir, "layout-c-"));
    const file = join(dir, "2026-09-30.md");
    sb.appendHubSource(dir, "delegated x", new Date(2026, 8, 30, 9, 7), { dir, unified: true });
    await sb.whenBrainWritesIdle();
    assert.equal(readFileSync(file, "utf8"), `${header("2026-09-30", "2026-09-30")}\n## Hub\n\n- 09:07 · delegated x\n`);
    sb.upsertSessionBlock(file, A, "2026-10-01", block(A, "first"));
    assert.equal(readFileSync(file, "utf8"), `${header("2026-09-30", "2026-10-01")}\n${block(A, "first")}\n\n## Hub\n\n- 09:07 · delegated x\n`);
    sb.appendHubSource(dir, "report y", new Date(2026, 8, 30, 10, 0), { dir, unified: true });
    await sb.whenBrainWritesIdle();
    assert.match(readFileSync(file, "utf8"), /^---\ntype: fonte\ncreated: 2026-09-30\nupdated: 2026-09-30\n/);
    assert.match(readFileSync(file, "utf8"), /\n## Hub\n\n- 09:07 · delegated x\n- 10:00 · report y\n$/);
  });
});

describe("throttle decisions", () => {
  const minutes = (n: number): number => n * 60_000;
  const now = 1_000_000_000_000;

  it("runs the first time and never without new turns", () => {
    assert.equal(trail.shouldSummarize(null, now, 0, "stop", "medium"), false);
    assert.equal(trail.shouldSummarize(null, now, 3, "stop", "light"), true);
    assert.equal(trail.shouldSummarize({ lastTurns: 10, lastUpdate: now - minutes(99) }, now, 10, "session_end", "high"), false);
  });

  it("medium is the reference: 10 minutes or 5 turns, session end always", () => {
    const state = { lastTurns: 10, lastUpdate: now - minutes(5) };
    assert.equal(trail.shouldSummarize(state, now, 12, "stop", "medium"), false);
    assert.equal(trail.shouldSummarize(state, now, 15, "stop", "medium"), true);
    assert.equal(trail.shouldSummarize({ lastTurns: 10, lastUpdate: now - minutes(11) }, now, 11, "stop", "medium"), true);
    assert.equal(trail.shouldSummarize(state, now, 11, "session_end", "medium"), true);
  });

  it("light waits 30 minutes or 20 turns", () => {
    assert.equal(trail.shouldSummarize({ lastTurns: 0, lastUpdate: now - minutes(29) }, now, 19, "stop", "light"), false);
    assert.equal(trail.shouldSummarize({ lastTurns: 0, lastUpdate: now - minutes(29) }, now, 20, "stop", "light"), true);
    assert.equal(trail.shouldSummarize({ lastTurns: 5, lastUpdate: now - minutes(31) }, now, 6, "stop", "light"), true);
    assert.equal(trail.shouldSummarize({ lastTurns: 5, lastUpdate: now - minutes(1) }, now, 6, "session_end", "light"), true);
  });

  it("high summarizes on every stop that has new turns", () => {
    assert.equal(trail.shouldSummarize({ lastTurns: 5, lastUpdate: now }, now, 6, "stop", "high"), true);
    assert.equal(trail.shouldSummarize({ lastTurns: 5, lastUpdate: now }, now, 5, "stop", "high"), false);
  });

  it("exposes the level constants", () => {
    assert.deepEqual(
      Object.entries(trail.TRAIL_LEVELS).map(([level, rules]) => [level, rules.window, rules.throttleMinutes, rules.throttleTurns, rules.maxBullets, rules.cap, rules.maxWindows]),
      [
        ["light", 120, 30, 20, 1, 5, 3],
        ["medium", 80, 10, 5, 3, null, 3],
        ["high", 60, 0, 0, 6, null, 6],
      ],
    );
  });
});

describe("model output parsing", () => {
  it("reads structured_output, a JSON result string or a bare payload", () => {
    const payload = { language: "pt", bullets: ["a", "b"], redacted: false };
    assert.deepEqual(trail.parseModelOutput(JSON.stringify({ structured_output: payload })), payload);
    assert.deepEqual(trail.parseModelOutput(JSON.stringify({ result: JSON.stringify(payload) })), payload);
    assert.deepEqual(trail.parseModelOutput(JSON.stringify(payload)), payload);
    assert.equal(trail.parseModelOutput("nope"), null);
    assert.equal(trail.parseModelOutput(JSON.stringify({ result: "plain text" })), null);
  });
});

describe("summarization with the fake model", () => {
  const events: { date: string; sessionId: string; bullets: number }[] = [];
  let unsubscribe: () => void = () => undefined;

  before(() => {
    store.updateSettings({ secondBrainRoot: brain, features: { trail: true }, trail: { detail: "medium", model: "haiku", prompt: null, dir: null, hubEvents: true } });
    unsubscribe = sse.onBroadcast((event, data) => {
      if (event === "trail") events.push(data as { date: string; sessionId: string; bullets: number });
    });
  });

  after(() => unsubscribe());

  it("does nothing while the feature is off and skips hub runs", async () => {
    store.updateSettings({ features: { trail: false } });
    newSession("off-session", 6);
    assert.equal(trail.scheduleTrail("off-session", "session_end"), false);
    store.updateSettings({ features: { trail: true } });
    newSession("hub-run", 6, "hub");
    await summarize("hub-run", "session_end");
    assert.equal(calls().length, 0);
    assert.equal(existsSync(trailFile()), false);
    assert.equal(trail.isHubRun(db.getSession("hub-run")!), true);
    assert.equal(trail.isHubRun(db.getSession("off-session")!), false);
  });

  it("summarizes a session into the trail file with the reference cli contract", async () => {
    const id = "s1111111-aaaa";
    newSession(id, 10);
    await summarize(id, "session_end");

    const made = calls();
    assert.equal(made.length, 1);
    const call = made[0]!;
    assert.ok(call.argv.includes("--print"));
    assert.equal(argOf(call, "--model"), "haiku");
    assert.equal(argOf(call, "--effort"), "low");
    assert.ok(call.argv.includes("--no-session-persistence"));
    assert.ok(call.argv.includes("--disable-slash-commands"));
    assert.equal(argOf(call, "--output-format"), "json");
    assert.equal(argOf(call, "--max-budget-usd"), "0.10");
    assert.equal(argOf(call, "--setting-sources"), "");
    assert.equal(argOf(call, "--tools"), "");
    assert.ok(call.argv.includes("--strict-mcp-config"));
    assert.equal(call.argv.includes("--bare"), false);
    assert.match(argOf(call, "--system-prompt")!, /You have no tools and no file access: summarize only the turns given; never ask questions\./);
    assert.equal(call.argv.includes("--append-system-prompt"), false);
    assert.deepEqual(JSON.parse(argOf(call, "--json-schema")!), {
      type: "object",
      required: ["language", "bullets", "redacted"],
      properties: {
        language: { type: "string" },
        bullets: { type: "array", items: { type: "string", maxLength: 140 }, minItems: 1, maxItems: 3 },
        redacted: { type: "boolean" },
      },
      additionalProperties: false,
    });
    assert.match(argOf(call, "--system-prompt")!, /1-3 bullets, each at most 100 characters, one clause, no trailing details/);
    assert.match(call.stdin, /^Session cwd: repo-a\n\nNew turns:\n<user>\ns1111111-aaaa question 0\n<\/user>/);
    assert.match(call.stdin, /<assistant>\ns1111111-aaaa answer 1\n\[tool Bash\]\n<\/assistant>/);
    assert.equal(call.env.HUB_SKIP, "1");
    assert.equal(call.env.CLAUDE_HOOK_BYPASS, "1");
    assert.equal(call.env.HUB_TASK_ID, null);

    const content = readFileSync(trailFile(), "utf8");
    assert.match(content, new RegExp(`^---\\ntype: fonte\\ncreated: ${today()}\\nupdated: ${today()}\\ntags: \\[fonte, session\\]\\n---\\n\\n# Sessions — ${today()}\\n`));
    assert.match(content, /<!-- session:s1111111-aaaa START -->\n\n## `s1111111` · \d\d:\d\d → \d\d:\d\d · 10 turns\n\n`C:\/work\/repo-a`\n\n- m1a\n- m1b\n\n<!-- session:s1111111-aaaa END -->\n$/);
    const state = db.getTrailState(id)!;
    assert.equal(state.lastTurns, 10);
    assert.equal(state.bulletsToday, 2);
    assert.equal(state.day, today());
    assert.deepEqual(events.at(-1), { date: today(), sessionId: id, bullets: 2 });
    assert.equal(trail.trailStatus().lastError, null);
  });

  it("throttles stops, appends the delta on session end and keeps the start time", async () => {
    const id = "s1111111-aaaa";
    const path = join(dataDir, `${id}.jsonl`);
    const before = readFileSync(trailFile(), "utf8");
    const start = /· (\d\d:\d\d) →/.exec(before)![1];
    appendFileSync(path, transcriptOf(4, "more"));
    await summarize(id, "stop");
    assert.equal(calls().length, 1);
    assert.equal(readFileSync(trailFile(), "utf8"), before);

    await summarize(id, "session_end");
    assert.equal(calls().length, 2);
    const after = readFileSync(trailFile(), "utf8");
    assert.match(after, /· 14 turns\n/);
    assert.match(after, /- m1a\n- m1b\n- m2a\n- m2b\n/);
    assert.equal(new RegExp(`· ${start} →`).test(after), true);
    assert.equal(db.getTrailState(id)!.lastTurns, 14);
  });

  it("summarizes a long delta in windows of the level size", async () => {
    const id = "s2222222-bbbb";
    newSession(id, 170);
    seedState(id);
    const baseline = calls().length;
    await summarize(id, "session_end");
    const made = calls().slice(baseline);
    assert.equal(made.length, 3);
    assert.equal((made[0]!.stdin.match(/<user>|<assistant>/g) ?? []).length, 80);
    assert.equal((made[2]!.stdin.match(/<user>|<assistant>/g) ?? []).length, 10);
    assert.equal(sb.readBlockBullets(readFileSync(trailFile(), "utf8"), id).length, 6);
  });

  it("checkpoints at the last good window and resumes from there after a failure", async () => {
    const id = "s3333333-cccc";
    newSession(id, 170);
    seedState(id);
    const baseline = calls().length;
    setMode(`failat:${baseline + 2},${baseline + 3}`);
    await summarize(id, "session_end");
    setMode("ok");
    let content = readFileSync(trailFile(), "utf8");
    assert.match(content, /· 170 turns · parcial até turn 80\n/);
    assert.equal(sb.readBlockBullets(content, id).length, 2);
    assert.equal(db.getTrailState(id)!.lastTurns, 80);
    assert.match(trail.trailStatus().lastError ?? "", /model exited 1: boom/);

    const resumeBaseline = calls().length;
    await summarize(id, "session_end");
    assert.equal(calls().length - resumeBaseline, 2);
    content = readFileSync(trailFile(), "utf8");
    assert.doesNotMatch(content.split(`session:${id} END`)[0]!.split(`session:${id} START`)[1]!, /parcial/);
    assert.equal(sb.readBlockBullets(content, id).length, 6);
    assert.equal(db.getTrailState(id)!.lastTurns, 170);
    assert.equal(trail.trailStatus().lastError, null);
  });

  it("writes nothing and keeps the checkpoint when every attempt fails", async () => {
    const id = "s4444444-dddd";
    newSession(id, 8);
    setMode("fail");
    await summarize(id, "session_end");
    setMode("ok");
    assert.equal(db.getTrailState(id), null);
    assert.doesNotMatch(readFileSync(trailFile(), "utf8"), /s4444444/);
    await summarize(id, "session_end");
    assert.equal(db.getTrailState(id)!.lastTurns, 8);
    assert.match(readFileSync(trailFile(), "utf8"), /s4444444-dddd START/);
  });

  it("redacts secrets in model bullets and flags the heading", async () => {
    const id = "s5555555-eeee";
    newSession(id, 6);
    setMode("secret");
    await summarize(id, "session_end");
    setMode("ok");
    const content = readFileSync(trailFile(), "utf8");
    assert.doesNotMatch(content, /hunter2/);
    assert.match(content, /- set \[REDACTED\] in the env/);
    assert.match(content, /## `s5555555` · \d\d:\d\d → \d\d:\d\d · 6 turns ⚠️ redacted/);
  });

  it("keeps every level prompt tool-free and accepts question-like bullets without filtering", async () => {
    for (const level of ["light", "medium", "high"] as const) {
      assert.match(trail.systemPromptFor({ dir: null, detail: level, model: null, prompt: null, hubEvents: true }), /You have no tools and no file access: summarize only the turns given; never ask questions\./);
    }
    const id = "sQQQQQQQ-7777";
    newSession(id, 6);
    setMode("question");
    await summarize(id, "session_end");
    setMode("ok");
    assert.deepEqual(sb.readBlockBullets(readFileSync(trailFile(), "utf8"), id), ["qual repo tem esse arquivo?"]);
  });

  it("honours a custom prompt and a null model", async () => {
    const id = "s6666666-ffff";
    newSession(id, 6);
    store.updateSettings({ trail: { prompt: "CUSTOM SYSTEM PROMPT", model: null } });
    const baseline = calls().length;
    await summarize(id, "session_end");
    const call = calls()[baseline]!;
    assert.equal(argOf(call, "--system-prompt"), "CUSTOM SYSTEM PROMPT");
    assert.equal(argOf(call, "--model"), "haiku");
    store.updateSettings({ trail: { prompt: null, model: "haiku" } });
  });

  it("hard-clips over-long bullets at a word boundary and sends a per-bullet maxLength", async () => {
    const id = "sGGGGGGG-1212";
    newSession(id, 6);
    setMode("long");
    const baseline = calls().length;
    await summarize(id, "session_end");
    setMode("ok");
    const call = calls()[baseline]!;
    const items = (JSON.parse(argOf(call, "--json-schema")!) as { properties: { bullets: { items: { maxLength: number } } } }).properties.bullets.items;
    assert.equal(items.maxLength, 140);
    const [bullet] = sb.readBlockBullets(readFileSync(trailFile(), "utf8"), id);
    assert.ok(bullet!.length <= 161, String(bullet!.length));
    assert.ok(bullet!.endsWith("…"));
    assert.ok(bullet!.length > 100);
    assert.equal(bullet!.slice(0, -1).split(" ").every((word) => word === "palavra"), true);
    assert.equal(trail.clipBullet("short one", 160), "short one");
    assert.equal(trail.clipBullet("x".repeat(300), 160), `${"x".repeat(160)}…`);
    assert.equal(trail.TRAIL_LEVELS.high.schemaChars, 200);
    assert.equal(trail.TRAIL_LEVELS.high.clipChars, 220);
  });

  it("uses the level prompt and schema for light and high", async () => {
    const light = "s7777777-1111";
    const high = "s8888888-2222";
    newSession(light, 6);
    newSession(high, 6);
    store.updateSettings({ trail: { detail: "light" } });
    let baseline = calls().length;
    await summarize(light, "session_end");
    let call = calls()[baseline]!;
    assert.match(argOf(call, "--system-prompt")!, /Exactly 1 bullet, at most 100 characters, one clause, no trailing details/);
    assert.equal((JSON.parse(argOf(call, "--json-schema")!) as { properties: { bullets: { maxItems: number; minItems: number } } }).properties.bullets.maxItems, 1);
    assert.equal((JSON.parse(argOf(call, "--json-schema")!) as { properties: { bullets: { minItems: number } } }).properties.bullets.minItems, 1);
    assert.match(argOf(call, "--system-prompt")!, /Always return exactly ONE bullet: when the window had no concrete outcome, describe what was being worked on, phrased as in-progress/);
    assert.doesNotMatch(argOf(call, "--system-prompt")!, /empty bullets array/);
    store.updateSettings({ trail: { detail: "high" } });
    baseline = calls().length;
    await summarize(high, "session_end");
    call = calls()[baseline]!;
    assert.match(argOf(call, "--system-prompt")!, /3-6 bullets, each <= 140 chars/);
    assert.match(argOf(call, "--system-prompt")!, /files and repos touched/);
    assert.equal(sb.readBlockBullets(readFileSync(trailFile(), "utf8"), high).length, 4);
    store.updateSettings({ trail: { detail: "medium" } });
  });

  it("light asks the model to rewrite the list once the per-session cap is reached", async () => {
    const id = "s9999999-3333";
    newSession(id, 6);
    const existing = ["one", "two", "three", "four", "five"];
    const file = trailFile();
    sb.upsertSessionBlock(file, id, today(), trail.buildBlock({ sessionId: id, cwd: "C:/work/repo-a", startedHHMM: "08:00", updatedHHMM: "08:30", turns: 3, bullets: existing, redacted: false, partialThrough: 0 }));
    store.updateSettings({ trail: { detail: "light" } });
    const baseline = calls().length;
    await summarize(id, "session_end");
    const made = calls().slice(baseline);
    assert.equal(made.length, 2);
    assert.match(argOf(made[1]!, "--system-prompt")!, /at most 5 bullets/);
    assert.match(argOf(made[1]!, "--system-prompt")!, /You have no tools and no file access/);
    assert.match(argOf(made[1]!, "--system-prompt")!, /Output JSON ONLY, no preamble/);
    assert.match(made[1]!.stdin, /Existing bullets:\n- one\n- two\n- three\n- four\n- five\n\nNew bullets:\n- light-\d+/);
    assert.equal((JSON.parse(argOf(made[1]!, "--json-schema")!) as { properties: { bullets: { maxItems: number } } }).properties.bullets.maxItems, 5);
    const content = readFileSync(file, "utf8");
    assert.deepEqual(sb.readBlockBullets(content, id), ["merged-a", "merged-b"]);
    assert.match(content, /## `s9999999` · 08:00 → \d\d:\d\d · 6 turns/);
    assert.equal(db.getTrailState(id)!.bulletsToday, 2);
    store.updateSettings({ trail: { detail: "medium" } });
  });

  it("light always produces a block and treats an empty model answer as a failed window", async () => {
    store.updateSettings({ trail: { detail: "light" } });
    const quiet = "sAAAAAAA-4444";
    newSession(quiet, 6);
    const emptyBaseline = calls().length;
    setMode("empty");
    await summarize(quiet, "session_end");
    setMode("ok");
    assert.equal(calls().length - emptyBaseline, 2);
    assert.doesNotMatch(readFileSync(trailFile(), "utf8"), /sAAAAAAA/);
    assert.equal(db.getTrailState(quiet), null);
    assert.match(trail.trailStatus().lastError ?? "", /model returned no bullets/);
    await summarize(quiet, "session_end");
    assert.equal(sb.readBlockBullets(readFileSync(trailFile(), "utf8"), quiet).length, 1);
    assert.equal(db.getTrailState(quiet)!.lastTurns, 6);
    assert.equal(trail.trailStatus().lastError, null);

    const busy = "sBBBBBBB-5555";
    newSession(busy, 6);
    const baseline = calls().length;
    await summarize(busy, "session_end");
    assert.equal(calls().length - baseline, 1);
    assert.equal(sb.readBlockBullets(readFileSync(trailFile(), "utf8"), busy).length, 1);
    store.updateSettings({ trail: { detail: "medium" } });
  });

  it("on first sight summarizes only the most recent window and persists that checkpoint", async () => {
    store.updateSettings({ trail: { detail: "light" } });
    const id = "sDDDDDDD-8888";
    const path = newSession(id, 300);
    const baseline = calls().length;
    await summarize(id, "stop");
    const made = calls().slice(baseline);
    assert.equal(made.length, 1);
    assert.equal((made[0]!.stdin.match(/<user>|<assistant>/g) ?? []).length, 120);
    assert.ok(made[0]!.stdin.includes(`${id} question 180\n`));
    assert.ok(!made[0]!.stdin.includes(`${id} answer 179\n`));
    assert.ok(made[0]!.stdin.includes(`${id} answer 299\n`));
    const state = db.getTrailState(id)!;
    assert.equal(state.lastTurns, 300);
    assert.equal(state.firstStarted, db.getSession(id)!.startedAt);
    assert.match(readFileSync(trailFile(), "utf8"), /· 300 turns\n/);
    appendFileSync(path, transcriptOf(2, "later"));
    const flushBaseline = calls().length;
    assert.equal(trail.flushTrail(id), 1);
    await trail.whenTrailIdle();
    assert.equal(calls().length - flushBaseline, 1);
    assert.equal(db.getTrailState(id)!.lastTurns, 302);

    const flushed = "sEEEEEEE-9999";
    newSession(flushed, 300);
    const forceBaseline = calls().length;
    await summarize(flushed, "stop", true);
    assert.equal(calls().length - forceBaseline, 1);
    assert.equal(db.getTrailState(flushed)!.lastTurns, 300);
    store.updateSettings({ trail: { detail: "medium" } });
  });

  it("processes at most three windows per trigger and resumes from the checkpoint on the next one", async () => {
    store.updateSettings({ trail: { detail: "light" } });
    const id = "sFFFFFFF-0000";
    newSession(id, 510);
    seedState(id, 10);
    const baseline = calls().length;
    await summarize(id, "stop");
    assert.equal(calls().length - baseline, 3);
    assert.equal(db.getTrailState(id)!.lastTurns, 370);
    assert.match(readFileSync(trailFile(), "utf8"), /· 510 turns · parcial até turn 370\n/);
    assert.equal(sb.readBlockBullets(readFileSync(trailFile(), "utf8"), id).length, 3);

    const nextBaseline = calls().length;
    await summarize(id, "stop");
    assert.equal(calls().length - nextBaseline, 2);
    assert.equal(db.getTrailState(id)!.lastTurns, 510);
    const content = readFileSync(trailFile(), "utf8");
    assert.equal(sb.readBlockBullets(content, id).length, 5);
    assert.doesNotMatch(content.split(`session:${id} END`)[0]!.split(`session:${id} START`)[1]!, /parcial/);
    store.updateSettings({ trail: { detail: "medium" } });
  });

  it("forces a flush past the throttle but only when there are new turns", async () => {
    const id = "s1111111-aaaa";
    const path = join(dataDir, `${id}.jsonl`);
    const baseline = calls().length;
    await summarize(id, "stop", true);
    assert.equal(calls().length, baseline);
    appendFileSync(path, transcriptOf(2, "flush"));
    assert.equal(trail.flushTrail(id), 1);
    await trail.whenTrailIdle();
    assert.equal(calls().length, baseline + 1);
    assert.equal(db.getTrailState(id)!.lastTurns, 16);
    const live = trail.flushTrail(null);
    await trail.whenTrailIdle();
    assert.ok(live >= 1);
  });
});

describe("unified hub section", () => {
  before(() => {
    store.updateSettings({ secondBrainRoot: brain, features: { trail: true }, trail: { hubEvents: true, dir: null } });
  });

  it("writes hub events under the trailing Hub section instead of fontes/hub", async () => {
    const file = sb.appendHubSource(brain, "task completed · vbss · fix", new Date());
    await sb.whenBrainWritesIdle();
    assert.equal(file, trailFile());
    assert.equal(existsSync(sb.hubSourcePath(brain, today())), false);
    const content = readFileSync(trailFile(), "utf8");
    assert.match(content, /\n## Hub\n\n- \d\d:\d\d · task completed · vbss · fix\n$/);
    assert.equal(content.match(/^## Hub$/gm)?.length, 1);
    sb.appendHubSource(brain, "report note · hello", new Date());
    await sb.whenBrainWritesIdle();
    const status = trail.trailStatus();
    assert.equal(status.today.hubLines, 2);
    assert.equal(status.today.exists, true);
    assert.ok(status.today.sessions >= 1);
    assert.equal(status.today.path, trailFile());
  });

  it("returns the trail as sessions and the Hub section as hub", () => {
    const brainNow = sb.brainToday(brain);
    assert.equal(brainNow.sessionsPath, trailFile());
    assert.match(brainNow.sessions ?? "", /# Sessions/);
    assert.equal(brainNow.hubPath, trailFile());
    assert.match(brainNow.hub ?? "", /^- \d\d:\d\d · task completed · vbss · fix\n- \d\d:\d\d · report note · hello$/);
    assert.doesNotMatch(brainNow.hub ?? "", /session:/);
  });

  it("keeps the Hub section after blocks written later", async () => {
    const id = "sCCCCCCC-6666";
    newSession(id, 6);
    await summarize(id, "session_end");
    const content = readFileSync(trailFile(), "utf8");
    assert.ok(content.indexOf(`session:${id} END`) < content.indexOf("## Hub"));
    assert.equal(content.match(/^## Hub$/gm)?.length, 1);
  });

  it("falls back to the legacy hub file when hub events are excluded or the feature is off", () => {
    store.updateSettings({ trail: { hubEvents: false } });
    const legacy = sb.appendHubSource(brain, "legacy line", new Date());
    assert.equal(legacy, sb.hubSourcePath(brain, today()));
    assert.match(readFileSync(legacy, "utf8"), /# Hub — /);
    assert.doesNotMatch(readFileSync(trailFile(), "utf8"), /legacy line/);
    const brainNow = sb.brainToday(brain);
    assert.equal(brainNow.sessionsPath, trailFile());
    assert.match(brainNow.hub ?? "", /legacy line/);

    store.updateSettings({ features: { trail: false }, trail: { hubEvents: true } });
    const off = sb.appendHubSource(brain, "off line", new Date());
    assert.equal(off, sb.hubSourcePath(brain, today()));
    assert.equal(sb.brainToday(brain).sessionsPath, null);
  });
});

describe("non-blocking brain writes", () => {
  it("a foreign lock delays but never loses hub lines and leaves the event loop free", async () => {
    store.updateSettings({ secondBrainRoot: brain, features: { trail: true }, trail: { hubEvents: true, dir: "locktrail" } });
    const dir = join(brain, "locktrail");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${today()}.md`);
    const lock = `${file}.lock`;
    writeFileSync(lock, "999999");
    const started = performance.now();
    const first = sb.appendHubSource(brain, "locked one", new Date());
    const second = sb.appendHubSource(brain, "locked two", new Date());
    assert.ok(performance.now() - started < 100);
    assert.equal(first, file);
    assert.equal(second, file);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 20);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    clearInterval(timer);
    assert.ok(ticks >= 40, `event loop ticked ${ticks} times`);
    assert.equal(existsSync(file), false);
    rmSync(lock);
    await sb.whenBrainWritesIdle();
    const content = readFileSync(file, "utf8");
    assert.ok(content.indexOf("locked one") > 0 && content.indexOf("locked one") < content.indexOf("locked two"));
    assert.equal(existsSync(lock), false);
    const brainNow = sb.brainToday(brain);
    assert.equal(brainNow.sessionsPath, file);
    assert.match(brainNow.hub ?? "", /locked one/);
    assert.match(brainNow.hub ?? "", /locked two/);
    store.updateSettings({ trail: { dir: null } });
  });

  it("takes over a stale foreign lock", async () => {
    store.updateSettings({ trail: { dir: "staletrail" } });
    const dir = join(brain, "staletrail");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${today()}.md`);
    writeFileSync(`${file}.lock`, "999999");
    const old = new Date(Date.now() - 6 * 60_000);
    utimesSync(`${file}.lock`, old, old);
    sb.appendHubSource(brain, "after stale", new Date());
    await sb.whenBrainWritesIdle();
    assert.match(readFileSync(file, "utf8"), /after stale/);
    store.updateSettings({ trail: { dir: null } });
  });
});

describe("trail HTTP routes", () => {
  const box: Sandbox = makeSandbox("cch-trail-http-");
  const capture = join(box.tmp, "http-capture.jsonl");
  const mode = join(box.tmp, "http-mode.txt");
  let hub: RunningServer;

  async function http(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
  }

  const httpCalls = (): number => (existsSync(capture) ? readFileSync(capture, "utf8").split("\n").filter(Boolean).length : 0);
  const trailPath = (): string => join(box.brain, "mytrail", `${sb.localDate()}.md`);
  const transcript = join(box.tmp, "http-session.jsonl");

  async function postHook(kind: string, sessionId: string, extra: Record<string, unknown> = {}): Promise<number> {
    const res = await http("POST", "/hook", { kind, sessionId, cwd: "C:/work/repo-a", client: "terminal", transcriptPath: transcript, ...extra });
    return res.status;
  }

  before(async () => {
    writeFileSync(transcript, transcriptOf(10, "http"));
    hub = await startServer(box, {
      HUB_DELEGATION: "1",
      HUB_CLAUDE_ARGS_PREFIX: JSON.stringify([fakeModel]),
      FAKE_TRAIL_CAPTURE: capture,
      FAKE_TRAIL_MODE_FILE: mode,
    });
  });

  after(() => {
    hub.child.kill();
  });

  it("reports the idle status before a root is linked", async () => {
    const res = await http("GET", "/delegation/trail");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      enabled: false,
      dir: null,
      detail: "light",
      model: "haiku",
      hubEvents: true,
      today: { path: null, exists: false, sessions: 0, hubLines: 0 },
      queue: 0,
      running: null,
      lastError: null,
    });
  });

  it("validates and merges trail settings", async () => {
    assert.equal((await http("PUT", "/delegation/settings", { trail: { detail: "bogus" } })).status, 400);
    assert.equal((await http("PUT", "/delegation/settings", { trail: { model: 5 } })).status, 400);
    assert.equal((await http("PUT", "/delegation/settings", { trail: { hubEvents: "yes" } })).status, 400);
    assert.equal((await http("PUT", "/delegation/settings", { features: { trail: "on" } })).status, 400);
    const saved = await http("PUT", "/delegation/settings", { secondBrainRoot: box.brain, features: { trail: true }, trail: { detail: "medium", dir: "mytrail" } });
    assert.equal(saved.status, 200);
    const body = saved.json as { features: { daily: boolean; trail: boolean }; trail: Record<string, unknown> };
    assert.deepEqual(body.features, { daily: false, trail: true, usage: false, limits: false });
    assert.deepEqual(body.trail, { dir: "mytrail", detail: "medium", model: "haiku", prompt: null, hubEvents: true });
    const status = (await http("GET", "/delegation/trail")).json as { enabled: boolean; dir: string; detail: string };
    assert.equal(status.enabled, true);
    assert.equal(status.dir, join(box.brain, "mytrail"));
    assert.equal(status.detail, "medium");
  });

  it("summarizes on a stop hook and reports the day", async () => {
    assert.equal(await postHook("stop", "http-s1"), 200);
    await waitFor(async () => (existsSync(trailPath()) ? true : null), 15000);
    assert.equal(httpCalls(), 1);
    interface Status {
      queue: number;
      running: unknown;
      today: { path: string; exists: boolean; sessions: number; hubLines: number };
      lastError: string | null;
    }
    const status = await waitFor(async () => {
      const current = (await http("GET", "/delegation/trail")).json as Status;
      return current.queue === 0 && current.running === null ? current : null;
    }, 5000);
    assert.deepEqual(status.today, { path: trailPath(), exists: true, sessions: 1, hubLines: 0 });
    assert.equal(status.lastError, null);
    assert.match(readFileSync(trailPath(), "utf8"), /<!-- session:http-s1 START -->/);
    const day = sb.localDate();
    const written = readFileSync(trailPath(), "utf8").replace(/\d\d:\d\d → \d\d:\d\d/, "HH:MM → HH:MM");
    assert.equal(
      written,
      `---\ntype: fonte\ncreated: ${day}\nupdated: ${day}\ntags: [fonte, session]\n---\n\n# Sessions — ${day}\n\n<!-- session:http-s1 START -->\n\n## \`http-s1\` · HH:MM → HH:MM · 10 turns\n\n\`C:/work/repo-a\`\n\n- m1a\n- m1b\n\n<!-- session:http-s1 END -->\n`,
    );
  });

  it("ignores hub runs and hooks without a transcript", async () => {
    const baseline = httpCalls();
    assert.equal(await postHook("session_end", "http-hub", { client: "hub" }), 200);
    assert.equal(await postHook("stop", "http-none", { transcriptPath: undefined }), 200);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(httpCalls(), baseline);
  });

  it("folds hub reports into the trail file and serves it through brain/today", async () => {
    const report = await http("POST", "/delegation/reports", { text: "hello from the hub", kind: "note", source: "test" });
    assert.equal(report.status, 201);
    const status = (await http("GET", "/delegation/trail")).json as { today: { hubLines: number; sessions: number } };
    assert.equal(status.today.hubLines, 1);
    const brainNow = (await http("GET", "/delegation/brain/today")).json as { sessions: string; hub: string; hubPath: string; sessionsPath: string };
    assert.equal(brainNow.sessionsPath, trailPath());
    assert.equal(brainNow.hubPath, trailPath());
    assert.match(brainNow.hub, /hello from the hub/);
    assert.match(brainNow.sessions, /http-s1/);
    assert.equal(existsSync(join(box.brain, "fontes", "hub", `${sb.localDate()}.md`)), false);
  });

  it("answers reports and status without waiting on a foreign lock and keeps the hub line", async () => {
    const lock = `${trailPath()}.lock`;
    writeFileSync(lock, "999999");
    const started = performance.now();
    const report = await http("POST", "/delegation/reports", { text: "written under a lock", kind: "note", source: "test" });
    const reportMs = performance.now() - started;
    assert.equal(report.status, 201);
    assert.ok(reportMs < 200, `report took ${reportMs} ms`);
    const statusStarted = performance.now();
    assert.equal((await http("GET", "/delegation/trail")).status, 200);
    assert.ok(performance.now() - statusStarted < 200);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.doesNotMatch(readFileSync(trailPath(), "utf8"), /written under a lock/);
    rmSync(lock);
    await waitFor(async () => (readFileSync(trailPath(), "utf8").includes("written under a lock") ? true : null), 10000);
    const brainNow = (await http("GET", "/delegation/brain/today")).json as { hub: string };
    assert.match(brainNow.hub, /written under a lock/);
    assert.equal(existsSync(lock), false);
  });

  it("flushes one session or all live sessions past the throttle", async () => {
    assert.equal((await http("POST", "/delegation/trail/flush", { sessionId: "missing" })).status, 404);
    appendFileSync(transcript, transcriptOf(2, "again"));
    const one = await http("POST", "/delegation/trail/flush", { sessionId: "http-s1" });
    assert.deepEqual(one.json, { scheduled: 1 });
    await waitFor(async () => (readFileSync(trailPath(), "utf8").includes("· 12 turns") ? true : null), 15000);
    const baseline = httpCalls();
    appendFileSync(transcript, transcriptOf(2, "third"));
    const all = await http("POST", "/delegation/trail/flush", {});
    assert.deepEqual(all.json, { scheduled: 1 });
    await waitFor(async () => (readFileSync(trailPath(), "utf8").includes("· 14 turns") ? true : null), 15000);
    assert.equal(httpCalls(), baseline + 1);
  });

  it("schedules nothing when the feature is switched off", async () => {
    await http("PUT", "/delegation/settings", { features: { trail: false } });
    const baseline = httpCalls();
    assert.deepEqual((await http("POST", "/delegation/trail/flush", {})).json, { scheduled: 0 });
    appendFileSync(transcript, transcriptOf(2, "off"));
    assert.equal(await postHook("session_end", "http-s1"), 200);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(httpCalls(), baseline);
  });
});

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    return;
  }
});
