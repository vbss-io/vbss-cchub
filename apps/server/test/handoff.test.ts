import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { freePort, makeSandbox, startServer, waitFor, type RunningServer } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, "..", "hooks", "notify.mjs");
const box = makeSandbox("cch-g3-handoff-");
let hub: RunningServer;
let slowHub: Server;
let slowPort = 0;

const PREVIOUS = "prev0001-0000-4000-8000-000000000001";
const CURRENT = "curr0002-0000-4000-8000-000000000002";

async function http(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${hub.base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
}

const localDate = (when = new Date()): string =>
  `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;

function runHook(port: number, input: Record<string, unknown>): Promise<{ code: number | null; ms: number; stdout: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: box.home,
      USERPROFILE: box.home,
      HUB_HOST_TARGET: "127.0.0.1",
      HUB_PORT: String(port),
      HUB_SKIP: "0",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    };
    for (const key of ["HUB_DELEGATED", "HUB_SHARE_LABEL", "HUB_HOOK_INLINE", "HUB_TRACK_SDK", "CLAUDE_PID"]) delete env[key];
    const child = spawn(process.execPath, [hook], { env, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, ms: Date.now() - started, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

const startInput = (cwd: string, source = "startup") => ({ hook_event_name: "SessionStart", session_id: CURRENT, cwd, source });

interface Preview {
  workspace: string;
  enabled: boolean;
  text: string | null;
  chars: number;
  sessions: { sessionId: string; keyPoints: string[] }[];
  openLoops: { title: string; status: string }[];
}

before(async () => {
  hub = await startServer(box, { HUB_DELEGATION: "1", HUB_SHARE_PORT: "0" });
  const saved = await http("PUT", "/delegation/settings", { workspacesRoot: box.root, secondBrainRoot: box.brain });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  await http("POST", "/hook", { kind: "session_start", sessionId: PREVIOUS, cwd: box.repoA, title: "Refactor the invoice parser", client: "terminal" });
  await http("POST", "/hook", { kind: "stop", sessionId: PREVIOUS, cwd: box.repoA, title: "Refactor the invoice parser", client: "terminal" });
  const trail = join(box.brain, "trail");
  mkdirSync(trail, { recursive: true });
  writeFileSync(
    join(trail, `${localDate()}.md`),
    [
      `# Sessions`,
      "",
      `<!-- session:${PREVIOUS} START -->`,
      "",
      "## `prev0001` · 09:00 → 09:30 · 12 turns",
      "",
      `\`${box.repoA}\``,
      "",
      "- split the parser into lexer and reader",
      "- decided to keep the CSV export",
      "",
      `<!-- session:${PREVIOUS} END -->`,
      "",
    ].join("\n"),
  );
  mkdirSync(join(box.brain, "projects"), { recursive: true });
  writeFileSync(
    join(box.brain, "projects", "pilot.md"),
    ["---", "workspace: pilot", "---", "", "# Pilot", "", "## Open loops", "", "- [ ] write the migration note #p2", "- [-] ship the parser", "- [ ] BLOCK - wait for the vendor - no reply", "- [x] old done thing ✅ 2026-01-01", "", "## Done loops", "", "- [x] done earlier ✅ 2026-01-02", ""].join("\n"),
  );
  slowHub = createServer((req, res) => {
    if (req.method === "POST") {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    }
  });
  await new Promise<void>((resolve) => slowHub.listen(0, "127.0.0.1", resolve));
  const address = slowHub.address();
  slowPort = typeof address === "object" && address ? address.port : 0;
});

after(async () => {
  slowHub.closeAllConnections();
  slowHub.close();
  hub.child.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("session handoff", () => {
  it("previews the last sessions with trail key points and the open loops of the linked project", async () => {
    const res = await http("GET", "/delegation/memory/handoff/preview?workspace=pilot");
    assert.equal(res.status, 200);
    const preview = res.json as Preview;
    assert.equal(preview.enabled, false);
    assert.ok(preview.text);
    assert.match(preview.text, /"pilot" workspace/);
    assert.match(preview.text, /Refactor the invoice parser \(claude\)/);
    assert.match(preview.text, /  - split the parser into lexer and reader/);
    assert.match(preview.text, /- \[doing\] ship the parser/);
    assert.match(preview.text, /- write the migration note/);
    assert.match(preview.text, /- \[blocked\] wait for the vendor/);
    assert.doesNotMatch(preview.text, /old done thing|done earlier/);
    assert.equal(preview.chars, preview.text.length);
    assert.ok(preview.chars <= 1500);
    assert.equal(preview.openLoops[0]?.status, "doing");
  });

  it("keeps the hook route quiet while the workspace has not opted in", async () => {
    const res = await http("GET", `/delegation/memory/handoff/hook?cwd=${encodeURIComponent(box.repoA)}&sessionId=${CURRENT}`);
    assert.deepEqual(res.json, { workspace: "pilot", text: null });
    const run = await runHook(hub.port, startInput(box.repoA));
    assert.equal(run.code, 0);
    assert.equal(run.stdout, "");
  });

  it("injects the context on startup once the workspace opts in, and stays quiet on resume or outside it", async () => {
    const opted = await http("PUT", "/delegation/memory/handoff/workspaces/pilot", { enabled: true });
    assert.equal(opted.status, 200);
    assert.deepEqual((opted.json as { handoffWorkspaces: string[] }).handoffWorkspaces, ["pilot"]);
    const run = await runHook(hub.port, startInput(box.repoA));
    assert.equal(run.code, 0);
    const out = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(out.hookSpecificOutput.additionalContext, /Refactor the invoice parser/);
    assert.match(out.hookSpecificOutput.additionalContext, /decided to keep the CSV export/);
    assert.ok(out.hookSpecificOutput.additionalContext.length <= 1500);
    const sessionsInText = await http("GET", `/delegation/memory/handoff/hook?cwd=${encodeURIComponent(box.repoA)}&sessionId=${PREVIOUS}`);
    assert.doesNotMatch((sessionsInText.json as { text: string | null }).text ?? "", /Refactor the invoice parser/);
    assert.equal((await runHook(hub.port, startInput(box.repoA, "resume"))).stdout, "");
    assert.equal((await runHook(hub.port, startInput(box.tmp))).stdout, "");
  });

  it("prints nothing and stays fast when the hub is down or slow", async () => {
    const downPort = await freePort();
    const down = await runHook(downPort, startInput(box.repoA));
    assert.equal(down.code, 0);
    assert.equal(down.stdout, "");
    assert.ok(down.ms < 1000, `hook took ${down.ms} ms with the hub down`);
    const slow = await runHook(slowPort, startInput(box.repoA));
    assert.equal(slow.code, 0);
    assert.equal(slow.stdout, "");
    assert.ok(slow.ms < 1500, `hook took ${slow.ms} ms with a hub that never answers`);
  });

  it("caps the text at 1500 characters and turns off again", async () => {
    const many = Array.from({ length: 40 }, (_, index) => `- [ ] long open loop number ${index} ${"with plenty of words ".repeat(6)}`);
    writeFileSync(join(box.brain, "projects", "pilot.md"), ["---", "workspace: pilot", "---", "", "## Open loops", "", ...many, ""].join("\n"));
    const preview = (await http("GET", "/delegation/memory/handoff/preview?workspace=pilot")).json as Preview;
    assert.ok(preview.text);
    assert.ok(preview.chars <= 1500, `${preview.chars}`);
    assert.equal(preview.enabled, true);
    const off = await http("PUT", "/delegation/memory/handoff/workspaces/pilot", { enabled: false });
    assert.deepEqual((off.json as { handoffWorkspaces: string[] }).handoffWorkspaces, []);
    assert.equal((await runHook(hub.port, startInput(box.repoA))).stdout, "");
  });

  it("validates the memory settings and exposes them with the other settings", async () => {
    const bad = await http("PUT", "/delegation/settings", { memory: { historyIndex: "yes" } });
    assert.equal(bad.status, 400);
    const badHeading = await http("PUT", "/delegation/settings", { memory: { summaryHeading: "" } });
    assert.equal(badHeading.status, 400);
    const saved = await http("PUT", "/delegation/settings", { memory: { summaryHeading: "## Resumo do dia", handoffWorkspaces: ["pilot", "pilot"] } });
    assert.equal(saved.status, 200);
    assert.deepEqual((saved.json as { memory: unknown }).memory, { historyIndex: true, handoffWorkspaces: ["pilot"], summaryHeading: "Resumo do dia" });
    const status = await waitFor(async () => {
      const res = await http("GET", "/delegation/memory/history/status");
      return res.status === 200 ? (res.json as { enabled: boolean; engine: string }) : null;
    }, 5000);
    assert.equal(status.enabled, true);
    assert.equal(status.engine, "fts");
  });
});
