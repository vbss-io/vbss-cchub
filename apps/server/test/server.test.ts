import { userInfo } from "node:os";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fixtures, makeSandbox, sandboxEnv, serverDir, startServer, waitFor, type RunningServer } from "./helpers.js";

const box = makeSandbox("cch-e2e-");
const children: ChildProcess[] = [];
let hub: RunningServer;
let base = "";
let taskId = "";

interface HttpResult {
  status: number;
  json: unknown;
}

async function http(
  method: string,
  path: string,
  opts: { origin?: string; body?: unknown; rawBody?: string } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin) headers.origin = opts.origin;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
}

interface Detail {
  task: { id: string; title: string; status: string; sessionId: string | null; cwd: string; addDirs: string[]; runner: string; repo: string | null };
  runs: { seq: number; kind: string; runner: string; status: string; result: string | null; error: string | null; sessionId: string | null }[];
  reports: { text: string; kind: string }[];
}

const settled = (status: string): boolean => !["pending", "running"].includes(status);

const waitSettled = (id: string): Promise<Detail> =>
  waitFor(async () => {
    const res = await http("GET", `/delegation/tasks/${id}`);
    const detail = res.json as Detail;
    return settled(detail.task.status) ? detail : null;
  }, 15000);

const normalize = (path: string): string => resolve(path).toLowerCase();

function runCli(command: unknown, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolveCli) => {
    const cli = spawn(process.execPath, ["--import", "tsx", join(serverDir, "src", "cli.ts")], {
      cwd: serverDir,
      env: sandboxEnv(box, { HUB_PORT: String(hub.port), ...extraEnv }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    cli.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    cli.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    cli.on("close", (code) => resolveCli({ code, out, err }));
    cli.stdin.end(JSON.stringify(command));
  });
}

before(async () => {
  hub = await startServer(box, { HUB_DELEGATION: "1" });
  children.push(hub.child);
  base = hub.base;
});

describe("hub surface", () => {
  it("is 404 on a hub started without HUB_DELEGATION=1", async () => {
    const other = await startServer(box, {});
    const res = await fetch(`${other.base}/delegation/settings`);
    assert.equal(res.status, 404);
    other.child.kill();
  });

  it("rejects untrusted browser origins and accepts the desktop app origin", async () => {
    assert.equal((await http("GET", "/delegation/settings", { origin: "https://evil.example.com" })).status, 403);
    assert.equal((await http("GET", "/delegation/settings", { origin: "http://localhost:3000" })).status, 403);
    assert.equal((await http("GET", "/delegation/settings", { origin: "http://tauri.localhost" })).status, 200);
  });

  it("answers malformed JSON with a JSON error", async () => {
    const res = await http("POST", "/delegation/tasks", { rawBody: "{bad" });
    assert.equal(res.status, 400);
    assert.ok(typeof (res.json as { error?: unknown }).error === "string");
  });

  it("stores settings, discovers workspaces and creates or updates them", async () => {
    assert.deepEqual((await http("GET", "/delegation/settings")).json, { workspacesRoot: null, editorCommand: "code", secondBrainRoot: null, autonomy: "full", ownerName: userInfo().username, runTimeoutMinutes: 60 });
    assert.equal((await http("PUT", "/delegation/settings", { body: { workspacesRoot: join(box.tmp, "nope") } })).status, 400);
    const saved = await http("PUT", "/delegation/settings", { body: { workspacesRoot: box.root, secondBrainRoot: box.brain } });
    assert.equal(saved.status, 200);
    const workspaces = (await http("GET", "/delegation/workspaces")).json as { name: string; contextPath: string | null; repos: { name: string }[] }[];
    assert.deepEqual(workspaces.map((w) => w.name), ["pilot"]);
    assert.equal(normalize(workspaces[0]?.contextPath ?? ""), normalize(box.contextDir));
    assert.deepEqual(workspaces[0]?.repos.map((r) => r.name), ["repo-a", "repo-b"]);

    const created = await http("POST", "/delegation/workspaces", { body: { name: "second", repos: [box.repoB] } });
    assert.equal(created.status, 201);
    assert.deepEqual((created.json as { repos: { name: string }[] }).repos.map((r) => r.name), ["repo-b"]);
    const updated = await http("PUT", "/delegation/workspaces/second", { body: { repos: [box.repoA, box.repoB] } });
    assert.equal(updated.status, 200);
    assert.equal((updated.json as { repos: unknown[] }).repos.length, 2);
    assert.equal((await http("POST", "/delegation/workspaces", { body: { name: "second", repos: [] } })).status, 400);
    assert.equal((await http("POST", "/delegation/workspaces/ghost/open")).status, 404);
  });

  it("validates task input and names what is available instead of guessing", async () => {
    assert.equal((await http("POST", "/delegation/tasks", { body: { prompt: "x" } })).status, 400);
    const ghost = await http("POST", "/delegation/tasks", { body: { prompt: "x", workspace: "ghost" } });
    assert.equal(ghost.status, 404);
    assert.match((ghost.json as { error: string }).error, /available: pilot, second/);
    const repo = await http("POST", "/delegation/tasks", { body: { prompt: "x", workspace: "pilot", repo: "nope" } });
    assert.equal(repo.status, 404);
    assert.match((repo.json as { error: string }).error, /available: repo-a, repo-b/);
    assert.equal((await http("POST", "/delegation/tasks", { body: { prompt: "x", workspace: "pilot", permissionMode: "yolo" } })).status, 400);
    assert.equal((await http("POST", "/delegation/tasks", { body: { prompt: "x", workspace: "pilot", runner: "gemini" } })).status, 400);
  });

  it("runs a Claude task in the workspace context with every repo attached", async () => {
    const created = await http("POST", "/delegation/tasks", {
      body: { prompt: "ping\nsecond line", workspace: "pilot", repo: "Repo-A", permissionMode: "acceptEdits", source: "test" },
    });
    assert.equal(created.status, 201);
    const initial = created.json as Detail;
    taskId = initial.task.id;
    assert.equal(initial.task.title, "ping");
    assert.equal(initial.task.repo, "repo-a");
    assert.equal(normalize(initial.task.cwd), normalize(box.contextDir));
    assert.deepEqual(initial.task.addDirs.map(normalize).sort(), [normalize(box.repoA), normalize(box.repoB)].sort());

    const detail = await waitSettled(taskId);
    assert.equal(detail.task.status, "completed");
    assert.equal(detail.runs[0]?.result, "handled: ping\nsecond line");
    assert.ok(detail.task.sessionId);

    const capture = JSON.parse(readFileSync(box.claudeCapture, "utf8")) as { argv: string[]; cwd: string; env: { HUB_TRACK_SDK: string | null; HUB_SKIP: string | null } };
    assert.equal(normalize(capture.cwd), normalize(box.contextDir));
    assert.equal(capture.argv.filter((arg) => arg === "--add-dir").length, 2);
    const context = capture.argv[capture.argv.indexOf("--append-system-prompt") + 1] ?? "";
    assert.match(context, /"pilot" workspace/);
    assert.match(context, /- repo-a: /);
    assert.match(context, /targets the "repo-a" repository/);
    assert.equal(capture.env.HUB_TRACK_SDK, "1");
    assert.equal(capture.env.HUB_SKIP, null);
  });

  it("continues the same session and rejects a concurrent continuation", async () => {
    const [a, b] = await Promise.all([
      http("POST", `/delegation/tasks/${taskId}/continue`, { body: { prompt: "again" } }),
      http("POST", `/delegation/tasks/${taskId}/continue`, { body: { prompt: "again" } }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    const detail = await waitSettled(taskId);
    const last = detail.runs[detail.runs.length - 1]!;
    assert.equal(last.kind, "continue");
    assert.equal(last.result, "continued: again");
    assert.equal(last.sessionId, detail.runs[0]?.sessionId);
  });

  it("runs delegations autonomously by default and safely when asked", async () => {
    const auto = await http("POST", "/delegation/tasks", { body: { prompt: "auto", workspace: "pilot" } });
    assert.equal(auto.status, 201);
    await waitSettled((auto.json as Detail).task.id);
    let capture = JSON.parse(readFileSync(box.claudeCapture, "utf8")) as { argv: string[] };
    assert.equal(capture.argv[capture.argv.indexOf("--permission-mode") + 1], "bypassPermissions");
    assert.equal((await http("PUT", "/delegation/settings", { body: { autonomy: "safe" } })).status, 200);
    const safe = await http("POST", "/delegation/tasks", { body: { prompt: "safe", workspace: "pilot" } });
    await waitSettled((safe.json as Detail).task.id);
    capture = JSON.parse(readFileSync(box.claudeCapture, "utf8")) as { argv: string[] };
    assert.equal(capture.argv[capture.argv.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal((await http("PUT", "/delegation/settings", { body: { autonomy: "loud" } })).status, 400);
    await http("PUT", "/delegation/settings", { body: { autonomy: "full" } });
  });

  it("runs and resumes a Codex task", async () => {
    const created = await http("POST", "/delegation/tasks", { body: { prompt: "codex please", workspace: "pilot", runner: "codex" } });
    assert.equal(created.status, 201);
    const id = (created.json as Detail).task.id;
    let detail = await waitSettled(id);
    assert.equal(detail.task.runner, "codex");
    assert.equal(detail.task.status, "completed");
    assert.equal(detail.runs[0]?.result, "codex: codex please");
    assert.match(detail.task.sessionId ?? "", /^thread-/);
    const capture = JSON.parse(readFileSync(box.codexCapture, "utf8")) as { argv: string[]; prompt: string };
    assert.ok(capture.argv.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(!capture.argv.includes("-s"));
    assert.match(capture.prompt, /"pilot" workspace[\s\S]*---\n\ncodex please$/);
    await http("POST", `/delegation/tasks/${id}/continue`, { body: { prompt: "more" } });
    detail = await waitSettled(id);
    assert.equal(detail.runs[1]?.kind, "continue");
    assert.equal(detail.runs[1]?.result, "resumed: more");
  });

  it("cancels a running task and relaunches one that never got a session", async () => {
    const created = await http("POST", "/delegation/tasks", { body: { prompt: "sleep:8000", workspace: "pilot" } });
    const id = (created.json as Detail).task.id;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await http("POST", `/delegation/tasks/${id}/cancel`)).status, 202);
    let detail = await waitSettled(id);
    assert.equal(detail.task.status, "cancelled");
    assert.equal((await http("POST", `/delegation/tasks/${id}/cancel`)).status, 409);
    assert.equal((await http("POST", `/delegation/tasks/${id}/continue`, { body: { prompt: "retry" } })).status, 201);
    detail = await waitSettled(id);
    assert.equal(detail.task.status, "completed");
  });

  it("collects reports, exposes them on the task and in the overview, and writes the second brain source", async () => {
    const bad = await http("POST", "/delegation/reports", { body: { text: "x", taskId: "ghost" } });
    assert.equal(bad.status, 404);
    const created = await http("POST", "/delegation/reports", { body: { text: "halfway there", kind: "progress", taskId, source: "codex" } });
    assert.equal(created.status, 201);
    const detail = (await http("GET", `/delegation/tasks/${taskId}`)).json as Detail;
    assert.equal(detail.reports[0]?.text, "halfway there");
    const list = (await http("GET", `/delegation/reports?limit=5`)).json as { text: string }[];
    assert.equal(list[0]?.text, "halfway there");
    const overview = (await http("GET", "/delegation/overview")).json as {
      runtimes: { claudeCode: unknown };
      sessions: { counts: Record<string, number> };
      codexSessions: { id: string }[];
      tasks: { recent: unknown[] };
      reports: { text: string }[];
      workspaces: { name: string }[];
    };
    assert.ok("claudeCode" in overview.runtimes);
    assert.equal(overview.reports[0]?.text, "halfway there");
    assert.ok(overview.tasks.recent.length >= 3);
    assert.deepEqual(overview.workspaces.map((w) => w.name), ["pilot", "second"]);
    assert.ok(overview.codexSessions.some((s) => s.id === "01a0aaaa-0000-7000-8000-000000000001"));
    const brain = (await http("GET", "/delegation/brain/today")).json as { hub: string | null };
    assert.match(brain.hub ?? "", /task delegated · pilot\/repo-a · ping \(claude, via test\)/);
    assert.match(brain.hub ?? "", /report progress · codex — halfway there/);
  });

  it("streams run events and serves them per task", async () => {
    const created = await http("POST", "/delegation/tasks", { body: { prompt: "tool: stream me", workspace: "pilot" } });
    const id = (created.json as Detail).task.id;
    await waitSettled(id);
    const events = (await http("GET", `/delegation/tasks/${id}/events`)).json as { kind: string; text: string }[];
    assert.equal(events[0]?.kind, "status");
    assert.ok(events.some((event) => event.kind === "tool" && event.text === "Bash echo hi"));
    assert.ok(events.some((event) => event.kind === "text" && event.text === "handled: tool: stream me"));
    assert.equal(events[events.length - 1]?.text, "finished");
    assert.equal((await http("GET", "/delegation/tasks/ghost/events")).status, 404);
  });

  it("archives a settled task, hides it from the default list and validates the run timeout", async () => {
    const created = await http("POST", "/delegation/tasks", { body: { prompt: "archive me", workspace: "pilot" } });
    const id = (created.json as Detail).task.id;
    await waitSettled(id);
    const archived = await http("POST", `/delegation/tasks/${id}/archive`);
    assert.equal(archived.status, 200);
    assert.equal(typeof (archived.json as { archivedAt: number }).archivedAt, "number");
    const list = (await http("GET", "/delegation/tasks?limit=200")).json as { id: string }[];
    assert.equal(list.some((task) => task.id === id), false);
    const withArchived = (await http("GET", "/delegation/tasks?limit=200&archived=1")).json as { id: string }[];
    assert.equal(withArchived.some((task) => task.id === id), true);
    const unarchived = await http("POST", `/delegation/tasks/${id}/unarchive`);
    assert.equal((unarchived.json as { archivedAt: number | null }).archivedAt, null);
    assert.equal((await http("POST", "/delegation/tasks/ghost/archive")).status, 404);

    const running = await http("POST", "/delegation/tasks", { body: { prompt: "sleep:8000", workspace: "pilot" } });
    const runningId = (running.json as Detail).task.id;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await http("POST", `/delegation/tasks/${runningId}/archive`)).status, 409);
    await http("POST", `/delegation/tasks/${runningId}/cancel`);
    await waitSettled(runningId);

    assert.equal((await http("PUT", "/delegation/settings", { body: { runTimeoutMinutes: 2 } })).status, 400);
    assert.equal((await http("PUT", "/delegation/settings", { body: { runTimeoutMinutes: 120 } })).status, 200);
    assert.equal(((await http("GET", "/delegation/settings")).json as { runTimeoutMinutes: number }).runTimeoutMinutes, 120);
    await http("PUT", "/delegation/settings", { body: { runTimeoutMinutes: 60 } });
  });

  it("cancels a delegated run that overruns the configured timeout", async () => {
    const tbox = makeSandbox("cch-timeout-");
    const tserver = await startServer(tbox, { HUB_DELEGATION: "1", HUB_DELEGATION_TIMEOUT_MIN: "0.05" });
    try {
      await fetch(`${tserver.base}/delegation/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspacesRoot: tbox.root }),
      });
      const created = await fetch(`${tserver.base}/delegation/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "sleep:6000", workspace: "pilot" }),
      });
      const id = ((await created.json()) as Detail).task.id;
      const detail = await waitFor(async () => {
        const res = await fetch(`${tserver.base}/delegation/tasks/${id}`);
        const value = (await res.json()) as Detail;
        return settled(value.task.status) ? value : null;
      }, 15000);
      assert.equal(detail.task.status, "cancelled");
      assert.match(detail.runs[0]?.error ?? "", /timed out after/);
    } finally {
      tserver.child.kill();
      await new Promise((r) => setTimeout(r, 400));
      try {
        rmSync(tbox.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* sqlite file can linger on Windows; temp dir is disposable */
      }
    }
  });

  it("deletes workspaces with or without their context folder", async () => {
    await http("POST", "/delegation/workspaces", { body: { name: "temp-del", repos: [box.repoA] } });
    const kept = await http("DELETE", "/delegation/workspaces/temp-del");
    assert.equal(kept.status, 200);
    assert.equal((kept.json as { contextDeleted: boolean }).contextDeleted, false);
    assert.ok(existsSync(join(box.root, "temp-del")));
    await http("POST", "/delegation/workspaces", { body: { name: "temp-del2", repos: [box.repoA] } });
    const removed = await http("DELETE", "/delegation/workspaces/temp-del2?context=1");
    assert.equal((removed.json as { contextDeleted: boolean }).contextDeleted, true);
    assert.ok(!existsSync(join(box.root, "temp-del2")));
    assert.equal((await http("DELETE", "/delegation/workspaces/temp-del2")).status, 400);
    assert.deepEqual(((await http("GET", "/delegation/workspaces")).json as { name: string }[]).map((w) => w.name), ["pilot", "second"]);
  });

  it("exposes a live view of a session: transcript tail, client and subagent activity", async () => {
    const dir = join(box.tmp, "transcripts");
    mkdirSync(join(dir, "live-1", "subagents"), { recursive: true });
    copyFileSync(join(fixtures, "transcript-sample.jsonl"), join(dir, "live-1.jsonl"));
    copyFileSync(join(fixtures, "agent-sample.jsonl"), join(dir, "live-1", "subagents", "agent-a1.jsonl"));
    await http("POST", "/hook", { body: { kind: "session_start", sessionId: "live-1", cwd: box.repoA, client: "claude-desktop", claudePid: process.pid, transcriptPath: join(dir, "live-1.jsonl") } });
    await http("POST", "/hook", { body: { kind: "subagent_start", sessionId: "live-1", agentId: "a1", agentType: "Explore" } });
    const live = (await http("GET", "/api/sessions/live-1/live")).json as {
      session: { client: string; claudePid: number };
      transcript: { role: string; text: string }[];
      agents: { agentId: string; agentType: string; transcript: { text: string }[] }[];
    };
    assert.equal(live.session.client, "claude-desktop");
    assert.equal(live.session.claudePid, process.pid);
    assert.equal(live.transcript.length, 5);
    assert.equal(live.transcript[4]?.text, "Done: patched the retry.");
    assert.equal(live.agents[0]?.agentType, "Explore");
    assert.equal(live.agents[0]?.transcript[2]?.text, "8");
    assert.equal((await http("GET", "/api/sessions/nope/live")).status, 404);
    const overview = (await http("GET", "/delegation/overview")).json as { sessions: { byClient: Record<string, number>; counts: { stale: number } } };
    assert.ok((overview.sessions.byClient["claude-desktop"] ?? 0) >= 1);
    assert.equal(typeof overview.sessions.counts.stale, "number");
  });

  it("tracks subagents reported by the hooks and lists Codex sessions and runtimes", async () => {
    const hook = (kind: string, extra: Record<string, unknown> = {}) =>
      http("POST", "/hook", { body: { kind, sessionId: "sess-1", cwd: box.repoA, ...extra } });
    await hook("session_start");
    await hook("subagent_start", { agentId: "agent-1", agentType: "Explore" });
    await hook("subagent_start", { agentId: "agent-2", agentType: "Plan" });
    let session = ((await http("GET", "/api/sessions")).json as { sessionId: string; agentsRunning: number; agentsTotal: number; status: string }[]).find((s) => s.sessionId === "sess-1")!;
    assert.equal(session.agentsRunning, 2);
    assert.equal(session.status, "active");
    await hook("subagent_stop", { agentId: "agent-1", agentType: "Explore" });
    session = ((await http("GET", "/api/sessions")).json as typeof session[]).find((s) => s.sessionId === "sess-1")!;
    assert.equal(session.agentsRunning, 1);
    assert.equal(session.agentsTotal, 2);
    const agents = (await http("GET", "/api/sessions/sess-1/agents")).json as { agentId: string; status: string; agentType: string }[];
    assert.deepEqual(agents.map((a) => [a.agentId, a.status]), [["agent-1", "ended"], ["agent-2", "running"]]);
    await hook("session_end");
    assert.equal(((await http("GET", "/api/sessions/sess-1/agents")).json as { status: string }[]).every((a) => a.status === "ended"), true);

    const raw = await http("POST", "/hook/raw?source=wsl", { body: { hook_event_name: "SubagentStart", session_id: "sess-2", agent_id: "agent-9", agent_type: "general-purpose", cwd: box.repoB } });
    assert.equal(raw.status, 200);
    assert.equal((raw.json as { agentsRunning: number }).agentsRunning, 1);

    const runtimes = (await http("GET", "/api/runtimes")).json as { claudeCode: { count: number }; scannedAt: number };
    assert.ok(typeof runtimes.claudeCode.count === "number");
    const codex = (await http("GET", "/api/codex/sessions")).json as { id: string; title: string; client: string }[];
    assert.equal(codex[0]?.title, "Fix the flaky test in repo-a");
    assert.equal(codex[0]?.client, "codex-app");
  });

  it("renames, archives and hides a Codex thread and serves its live timeline", async () => {
    const id = "01a0aaaa-0000-7000-8000-000000000001";
    const live = (await http("GET", `/api/codex/${id}/live`)).json as { entries: { role: string; tool: string | null; text: string }[] };
    assert.deepEqual(live.entries.map((entry) => [entry.role, entry.tool, entry.text]), [
      ["user", null, "Fix the flaky test in repo-a\nand report back"],
      ["assistant", null, "Looking into the flaky test."],
      ["tool", "shell", "npm test"],
      ["result", null, "3 tests passed"],
    ]);
    assert.equal((await http("GET", "/api/codex/ghost-id/live")).status, 404);

    const renamed = await http("PATCH", `/api/codex/${id}`, { body: { title: "Flaky hunt" } });
    assert.equal((renamed.json as { customTitle: string }).customTitle, "Flaky hunt");
    const archived = await http("POST", `/api/codex/${id}/archive`);
    assert.equal(typeof (archived.json as { archivedAt: number }).archivedAt, "number");
    const unarchived = await http("POST", `/api/codex/${id}/unarchive`);
    assert.equal((unarchived.json as { archivedAt: number | null }).archivedAt, null);

    const deleted = await http("DELETE", `/api/codex/${id}`);
    assert.deepEqual(deleted.json, { ok: true });
    const list = (await http("GET", "/api/codex/sessions")).json as { id: string }[];
    assert.equal(list.some((session) => session.id === id), false);
  });

  it("reports connect status inside the sandbox home and installs the Codex MCP entry", async () => {
    const status = (await http("GET", "/delegation/connect")).json as {
      shell: { bash: { path: string; installed: boolean } };
      mcp: { codex: { path: string; installed: boolean } };
      server: { command: string };
    };
    assert.equal(normalize(status.shell.bash.path), normalize(join(box.home, ".bashrc")));
    assert.equal(status.mcp.codex.installed, false);
    const installed = await http("POST", "/delegation/connect/mcp", { body: { client: "codex" } });
    assert.equal((installed.json as { installed: boolean }).installed, true);
    assert.match(readFileSync(join(box.codexHome, "config.toml"), "utf8"), /\[mcp_servers\.cchub\]/);
    const shell = await http("POST", "/delegation/connect/shell", { body: { shell: "bash" } });
    assert.equal((shell.json as { installed: boolean }).installed, true);
    assert.match(readFileSync(join(box.home, ".bashrc"), "utf8"), /WORKSPACES_ROOT/);
    assert.equal((await http("POST", "/delegation/connect/mcp", { body: { client: "nope" } })).status, 400);
  });

  it("is driven by the CLI from another process", async () => {
    const got = await runCli({ action: "get", taskId });
    assert.equal(got.code, 0, got.err);
    assert.equal((JSON.parse(got.out) as Detail).task.id, taskId);
    const overview = await runCli({ action: "overview" });
    assert.equal(overview.code, 0, overview.err);
    const delegated = await runCli({ action: "delegate", workspace: "pilot", prompt: "from cli" });
    assert.equal(delegated.code, 0, delegated.err);
    const detail = await waitSettled((JSON.parse(delegated.out) as Detail).task.id);
    assert.equal(detail.runs[0]?.result, "handled: from cli");
    const report = await runCli({ action: "report", text: "cli note", kind: "note" });
    assert.equal(report.code, 0, report.err);
    const down = await runCli({ action: "list" }, { HUB_URL: "http://127.0.0.1:1" });
    assert.equal(down.code, 1);
    assert.match(down.err, /cannot reach the hub/);
  });
});

after(async () => {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode != null || child.signalCode != null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.kill();
        }),
    ),
  );
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  } catch {
    /* Windows can keep the sqlite file locked briefly after exit; the temp dir is disposable */
  }
});
