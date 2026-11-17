import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fixtures } from "./helpers.js";
import { s1Sandbox } from "./helpers/s1-env.js";

const box = s1Sandbox("cch-s1-live-");

const live = await import("../src/live.js");
const handoff = await import("../src/handoff.js");
const { applyHook, db } = await import("../src/db.js");
const { getSettings, updateSettings } = await import("../src/delegation-store.js");

const transcriptSample = readFileSync(join(fixtures, "transcript-sample.jsonl"), "utf8");
const projectsDir = join(box.home, ".claude", "projects");

const localDate = (when = new Date()): string =>
  `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;

function hook(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "session_start" as const,
    sessionId,
    cwd: null,
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
    client: null,
    claudePid: null,
    transcriptPath: null,
    agentMessage: null,
    shareLabel: null,
    ...extra,
  };
}

after(() => {
  db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

describe("live transcripts", () => {
  const cwd = "C:\\work\\live-repo";
  const projectDir = join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  const sessionFile = join(projectDir, "live-session.jsonl");

  before(() => {
    mkdirSync(join(projectDir, "live-session", "subagents", "workflows", "flow-1"), { recursive: true });
    writeFileSync(sessionFile, transcriptSample);
    writeFileSync(join(projectDir, "live-session", "subagents", "agent-direct.jsonl"), transcriptSample);
    writeFileSync(join(projectDir, "live-session", "subagents", "workflows", "stray.txt"), "x");
    writeFileSync(join(projectDir, "live-session", "subagents", "workflows", "flow-1", "agent-nested.jsonl"), transcriptSample);
    applyHook(hook("live-session", { cwd, model: "opus" }));
    applyHook(hook("live-session", { kind: "subagent_start", cwd, agentId: "direct", agentType: "Explore" }));
    applyHook(hook("live-session", { kind: "subagent_start", cwd, agentId: "nested", agentType: "Plan" }));
    applyHook(hook("live-session", { kind: "subagent_stop", cwd, agentId: "nested", agentType: "Plan" }));
    applyHook(hook("live-bare", { model: "opus" }));
  });

  it("finds subagent transcripts directly or inside a workflow folder", () => {
    assert.equal(live.subagentTranscriptPath(null, "live-session", "direct"), null);
    assert.equal(live.subagentTranscriptPath(sessionFile, "live-session", "direct"), join(projectDir, "live-session", "subagents", "agent-direct.jsonl"));
    assert.equal(live.subagentTranscriptPath(sessionFile, "live-session", "nested"), join(projectDir, "live-session", "subagents", "workflows", "flow-1", "agent-nested.jsonl"));
    assert.equal(live.subagentTranscriptPath(sessionFile, "live-session", "ghost"), null);
    assert.equal(live.subagentTranscriptPath(join(box.tmp, "x.jsonl"), "none", "ghost"), null);
  });

  it("guesses the transcript path from the cwd", () => {
    assert.equal(live.guessTranscriptIn(projectsDir, null, "live-session"), null);
    assert.equal(live.guessTranscriptIn(projectsDir, cwd, "live-session"), sessionFile);
    assert.equal(live.guessTranscriptIn(projectsDir, cwd, "ghost"), null);
    assert.equal(live.guessTranscriptPath(box.home, cwd, "live-session"), sessionFile);
  });

  it("returns the full live view with every agent transcript", async () => {
    assert.equal(await live.sessionLive("ghost"), null);
    const view = await live.sessionLive("live-session", 5);
    assert.equal(view?.session.transcriptPath, sessionFile);
    assert.ok((view?.transcript.length ?? 0) > 0);
    assert.deepEqual(view?.agents.map((agent) => agent.agentId).sort(), ["direct", "nested"]);
    assert.ok(view?.agents.every((agent) => agent.transcriptPath !== null && agent.transcript.length > 0));
    const bare = await live.sessionLive("live-bare");
    assert.equal(bare?.session.transcriptPath, null);
    assert.deepEqual(bare?.transcript, []);
  });

  it("summarizes the agents and counts the running ones", async () => {
    assert.equal(await live.sessionLiveSummary("ghost"), null);
    const summary = await live.sessionLiveSummary("live-session");
    assert.deepEqual(summary?.agentCounts, { total: 2, running: 1 });
    const again = await live.sessionLiveSummary("live-session");
    assert.deepEqual(again?.agentCounts, { total: 2, running: 1 });
  });

  it("returns one subagent or says what is missing", async () => {
    assert.equal(await live.subagentLive("ghost", "direct"), "no-session");
    assert.equal(await live.subagentLive("live-session", "ghost"), "no-agent");
    const found = await live.subagentLive("live-session", "nested");
    assert.ok(typeof found === "object" && found.agent.transcript.length > 0);
  });
});

describe("session handoff", () => {
  const PREVIOUS = "hand0001-0000-4000-8000-000000000001";
  const CURRENT = "hand0002-0000-4000-8000-000000000002";
  const trailFile = join(box.brain, "trail", `${localDate()}.md`);

  before(() => {
    updateSettings({ workspacesRoot: box.root, secondBrainRoot: null });
    applyHook(hook(PREVIOUS, { cwd: box.repoA, title: "Refactor the invoice parser", client: "terminal", kind: "stop" }));
    applyHook(hook("hand-untitled", { cwd: box.repoB, client: "terminal" }), Date.now() - 60_000);
    applyHook(hook("hand-hubrun", { cwd: box.repoA, client: "hub", title: "hub run" }));
    applyHook(hook("hand-elsewhere", { cwd: box.tmp, title: "elsewhere" }));
    applyHook(hook(CURRENT, { cwd: box.repoA, title: "current" }));
    mkdirSync(join(box.brain, "trail"), { recursive: true });
    writeFileSync(
      trailFile,
      [
        "# Sessions",
        "",
        `<!-- session:${PREVIOUS} START -->`,
        "",
        "## `hand0001` · 09:00 → 09:30 · 12 turns",
        "",
        "- first point",
        "- split the parser into lexer and reader",
        "- decided to keep the CSV export",
        "- added   spaced    words",
        "",
        `<!-- session:${PREVIOUS} END -->`,
        "",
      ].join("\n"),
    );
    mkdirSync(join(box.brain, "projects"), { recursive: true });
    writeFileSync(
      join(box.brain, "projects", "pilot.md"),
      ["---", "workspace: pilot", "---", "", "# Pilot", "", "## Open loops", "", "- [ ] write the migration note #p2", "- [ ] urgent thing #p1", "- [-] ship the parser", "- [ ] BLOCK - wait for the vendor - no reply", "- [x] old done thing ✅ 2026-01-01", ""].join("\n"),
    );
    writeFileSync(join(box.brain, "projects", "pilot-two.md"), ["---", "workspace: pilot", "---", "", "# Pilot Two", "", "## Open loops", "", "- [ ] second project task", ""].join("\n"));
    writeFileSync(join(box.brain, "projects", "other.md"), ["---", "workspace: other", "---", "", "# Other", "", "## Open loops", "", "- [ ] not ours", ""].join("\n"));
    const now = new Date();
    const day = join(box.codexHome, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
    const sample = readFileSync(join(day, "rollout-sample.jsonl"), "utf8");
    const cwdJson = JSON.stringify(box.repoA).slice(1, -1);
    writeFileSync(join(day, "rollout-handoff.jsonl"), sample.split("01a0aaaa-0000-7000-8000-000000000001").join("01a0aaaa-0000-7000-8000-0000000000h1").replace(/"cwd":"[^"]*"/g, `"cwd":"${cwdJson}"`));
  });

  it("is empty while no second brain is linked and no session matches", () => {
    const preview = handoff.handoffPreview(getSettings(), "nobody");
    assert.deepEqual({ sessions: preview.sessions, openLoops: preview.openLoops, text: preview.text, chars: preview.chars, enabled: preview.enabled }, { sessions: [], openLoops: [], text: null, chars: 0, enabled: false });
  });

  it("lists recent sessions without key points while no trail folder is linked", () => {
    const preview = handoff.handoffPreview(getSettings(), "pilot", CURRENT);
    assert.equal(preview.openLoops.length, 0);
    assert.ok(preview.sessions.some((session) => session.sessionId === PREVIOUS && session.keyPoints.length === 0));
    assert.ok(!preview.sessions.some((session) => session.sessionId === CURRENT || session.sessionId === "hand-hubrun" || session.sessionId === "hand-elsewhere"));
  });

  it("previews sessions with trail key points and the open loops of the linked projects", () => {
    updateSettings({ secondBrainRoot: box.brain, memory: { handoffWorkspaces: ["pilot"] } });
    const preview = handoff.handoffPreview(getSettings(), "pilot", CURRENT);
    assert.equal(preview.enabled, true);
    const previous = preview.sessions.find((session) => session.sessionId === PREVIOUS);
    assert.deepEqual(previous?.keyPoints, ["split the parser into lexer and reader", "decided to keep the CSV export", "added   spaced    words"]);
    assert.ok(preview.sessions.some((session) => session.client === "codex"));
    assert.ok(preview.sessions.some((session) => session.title === "untitled"));
    assert.deepEqual(preview.openLoops.map((loop) => `${loop.status}:${loop.title}`), [
      "doing:ship the parser",
      "todo:urgent thing",
      "todo:write the migration note",
      "todo:second project task",
      "blocked:wait for the vendor",
    ]);
    assert.ok(preview.text);
    assert.match(preview.text, /Open loops of the linked projects \(Pilot, Pilot Two\):/);
    assert.match(preview.text, /- \[doing\] ship the parser/);
    assert.match(preview.text, /\n- write the migration note/);
    assert.match(preview.text, /  - added spaced words/);
    assert.equal(preview.chars, preview.text.length);
  });

  it("injects the handoff only for an opted-in workspace", () => {
    assert.deepEqual(handoff.handoffForCwd(getSettings(), box.tmp, null), { workspace: null, text: null });
    const enabled = handoff.handoffForCwd(getSettings(), box.repoA, CURRENT);
    assert.equal(enabled.workspace, "pilot");
    assert.ok(enabled.text?.includes("Refactor the invoice parser"));
    updateSettings({ memory: { handoffWorkspaces: [] } });
    assert.deepEqual(handoff.handoffForCwd(getSettings(), box.repoA, CURRENT), { workspace: "pilot", text: null });
    assert.equal(handoff.isHandoffEnabled(getSettings(), "pilot"), false);
  });

  it("skips a trail entry it cannot read and a tasks root that is not a folder", () => {
    rmSync(trailFile, { force: true });
    mkdirSync(trailFile, { recursive: true });
    const unreadable = handoff.handoffPreview(getSettings(), "pilot", CURRENT);
    assert.ok(unreadable.sessions.every((session) => session.keyPoints.length === 0));
    rmSync(trailFile, { recursive: true, force: true });
    updateSettings({ tasks: { root: join(box.tmp, "not-a-folder.md") } });
    writeFileSync(join(box.tmp, "not-a-folder.md"), "x");
    assert.deepEqual(handoff.handoffPreview(getSettings(), "pilot", CURRENT).openLoops, []);
    updateSettings({ tasks: { root: null } });
  });

  it("renders a capped text, a single project heading and nothing for empty input", () => {
    assert.equal(handoff.renderHandoff("w", [], []), null);
    const single = handoff.renderHandoff("w", [], [{ project: "Solo", status: "todo", title: "only task" }]);
    assert.match(single ?? "", /Open loops of the linked project \(Solo\):\n- only task$/);
    const long = "x".repeat(170);
    const sessions = Array.from({ length: 3 }, (_, index) => ({ sessionId: `s${index}`, client: "claude" as const, title: long, updatedAt: Date.now(), keyPoints: [long, long, long] }));
    const capped = handoff.renderHandoff("w", sessions, []);
    assert.ok((capped?.length ?? 0) <= handoff.HANDOFF_MAX_CHARS);
    assert.ok((capped?.length ?? 0) > handoff.HANDOFF_MAX_CHARS - 200);
    assert.equal(handoff.renderHandoff("w".repeat(handoff.HANDOFF_MAX_CHARS), sessions, []), null);
  });
});
