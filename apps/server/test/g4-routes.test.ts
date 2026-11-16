import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { makeSandbox, startServer, waitFor, type RunningServer } from "./helpers.js";

const box = makeSandbox("cch-g4-");
const env = {
  HUB_DELEGATION: "1",
  HUB_ROUTINES_BOOT_DELAY_MS: "0",
  HUB_ROUTINES_TICK_MS: "400",
  FAKE_CLAUDE_COST: "0.1",
  FAKE_CLAUDE_DELAY_MS: "50",
  USERPROFILE: box.home,
  HOME: box.home,
  HUB_GH_BIN: join(box.tmp, "no-gh-here.exe"),
};
let hub: RunningServer | null = null;
let base = "";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

async function http(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
}

async function boot(): Promise<void> {
  hub = await startServer(box, env);
  base = hub.base;
}

async function stop(): Promise<void> {
  const child = hub?.child;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
    child.kill();
  });
}

interface CostJson {
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  runs: number;
  pricedRuns: number;
}

interface InboxItem {
  id: string;
  routineId: string;
  taskId: string | null;
  trigger: string;
  status: string;
  summary: string | null;
  note: string | null;
  read: boolean;
  cost: CostJson;
}

interface RoutineJson {
  id: string;
  nextFireAt: number | null;
  enabled: boolean;
  running: boolean;
  cost: CostJson;
}

const inbox = async (): Promise<{ unread: number; items: InboxItem[] }> => (await http("GET", "/delegation/routines/inbox")).json as { unread: number; items: InboxItem[] };

const inboxItem = (match: (item: InboxItem) => boolean): Promise<InboxItem> =>
  waitFor(async () => (await inbox()).items.find(match) ?? null, 20000);

const taskSettled = (id: string, runs: number) =>
  waitFor(async () => {
    const detail = (await http("GET", `/delegation/tasks/${id}`)).json as { task: { status: string }; runs: unknown[]; cost: CostJson };
    return detail.runs.length >= runs && !["running", "pending"].includes(detail.task.status) ? detail : null;
  }, 20000);

const hhmm = (at: number): string => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

before(async () => {
  git(box.repoA, "init", "-b", "main");
  git(box.repoA, "config", "user.name", "Test");
  git(box.repoA, "config", "user.email", "test@example.com");
  git(box.repoA, "config", "core.autocrlf", "false");
  writeFileSync(join(box.repoA, "app.ts"), "const a = 1;\nlet b = 2;\nconst c = 3;\n");
  git(box.repoA, "add", "-A");
  git(box.repoA, "commit", "-m", "base");
  await boot();
  await http("PUT", "/delegation/settings", { workspacesRoot: box.root, features: { delegated: true } });
});

after(async () => {
  await stop();
  try {
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    void 0;
  }
});

describe("G4 routines API", () => {
  let routineId = "";

  it("starts empty: no routine is created by default", async () => {
    const res = await http("GET", "/delegation/routines");
    assert.equal(res.status, 200);
    assert.deepEqual((res.json as { routines: unknown[] }).routines, []);
    assert.equal((res.json as { unread: number }).unread, 0);
  });

  it("validates the routine body", async () => {
    assert.equal((await http("POST", "/delegation/routines", { name: "x", prompt: "y", workspace: "pilot" })).status, 400);
    assert.equal((await http("POST", "/delegation/routines", { name: "x", prompt: "y", workspace: "nope", schedule: { kind: "daily", time: "09:00" } })).status, 404);
    assert.equal((await http("POST", "/delegation/routines", { name: "x", prompt: "y", cwd: "relative/dir", schedule: { kind: "daily", time: "09:00" } })).status, 400);
    assert.equal((await http("POST", "/delegation/routines", { name: "x", prompt: "y", workspace: "pilot", cwd: box.repoB, schedule: { kind: "daily", time: "09:00" } })).status, 400);
    assert.equal((await http("POST", "/delegation/routines", { name: "", prompt: "y", workspace: "pilot", schedule: { kind: "daily", time: "09:00" } })).status, 400);
  });

  it("creates, pauses and resumes a routine", async () => {
    const created = await http("POST", "/delegation/routines", { name: "morning sweep", prompt: "sweep the repo", workspace: "pilot", repo: "repo-a", schedule: { kind: "weekdays", days: [1, 2, 3, 4, 5], time: "07:00" } });
    assert.equal(created.status, 201);
    const routine = created.json as RoutineJson & { repo: string };
    routineId = routine.id;
    assert.equal(routine.repo, "repo-a");
    assert.ok((routine.nextFireAt ?? 0) > Date.now());
    assert.equal(((await http("PATCH", `/delegation/routines/${routineId}`, { enabled: false })).json as RoutineJson).nextFireAt, null);
    assert.ok((((await http("PATCH", `/delegation/routines/${routineId}`, { enabled: true })).json as RoutineJson).nextFireAt ?? 0) > Date.now());
    const preview = (await http("POST", "/delegation/routines/schedule/preview", { schedule: { kind: "interval", everyHours: 2 } })).json as { next: number[] };
    assert.equal(preview.next.length, 5);
  });

  it("runs now through the delegation path and lands an unread inbox item with summary and cost", async () => {
    const started = await http("POST", `/delegation/routines/${routineId}/run`);
    assert.equal(started.status, 201);
    const runId = (started.json as { id: string }).id;
    const item = await inboxItem((entry) => entry.id === runId);
    assert.equal(item.status, "completed");
    assert.equal(item.trigger, "manual");
    assert.match(item.summary ?? "", /handled: sweep the repo/);
    assert.equal(item.read, false);
    assert.equal(item.cost.costUsd, 0.1);
    const task = (await http("GET", `/delegation/tasks/${item.taskId}`)).json as { task: { createdBy: string } };
    assert.equal(task.task.createdBy, `routine:${routineId}`);
    const read = await http("POST", `/delegation/routines/inbox/${runId}/read`);
    assert.equal((read.json as { item: InboxItem }).item.read, true);
    const detail = (await http("GET", `/delegation/routines/${routineId}`)).json as RoutineJson & { runs: InboxItem[] };
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.cost.costUsd, 0.1);
  });

  it("refuses Run now while the Delegated plugin is off", async () => {
    await http("PUT", "/delegation/settings", { features: { delegated: false } });
    try {
      assert.equal((await http("POST", `/delegation/routines/${routineId}/run`)).status, 409);
    } finally {
      await http("PUT", "/delegation/settings", { features: { delegated: true } });
    }
  });

  it("validates the catch-up setting", async () => {
    assert.deepEqual((await http("GET", "/delegation/routines/settings")).json, { catchUpHours: 12 });
    assert.equal((await http("PUT", "/delegation/routines/settings", { catchUpHours: 100 })).status, 400);
    assert.deepEqual((await http("PUT", "/delegation/routines/settings", { catchUpHours: 6 })).json, { catchUpHours: 6 });
    await http("PUT", "/delegation/routines/settings", { catchUpHours: 12 });
  });

  it("runs a Codex routine in a plain cwd and keeps its token usage", async () => {
    const created = (await http("POST", "/delegation/routines", { name: "codex tidy", prompt: "tidy", cwd: box.repoB, runner: "codex", schedule: { kind: "interval", everyHours: 24 } })).json as RoutineJson;
    const runId = ((await http("POST", `/delegation/routines/${created.id}/run`)).json as { id: string }).id;
    const item = await inboxItem((entry) => entry.id === runId);
    assert.equal(item.status, "completed");
    assert.equal(item.cost.costUsd, null);
    assert.equal(item.cost.tokensIn, 10);
    assert.equal(item.cost.tokensOut, 5);
    assert.equal((await http("DELETE", `/delegation/routines/${created.id}`)).status, 200);
    assert.equal((await http("GET", `/delegation/routines/${created.id}`)).status, 404);
  });

  it("after a restart, catches up a slot missed within the window once and marks an older one missed", async () => {
    const now = Date.now();
    const recent = (await http("POST", "/delegation/routines", { name: "recent", prompt: "recent work", workspace: "pilot", schedule: { kind: "daily", time: hhmm(now - 2 * 3_600_000) } })).json as RoutineJson;
    const old = (await http("POST", "/delegation/routines", { name: "old", prompt: "old work", workspace: "pilot", schedule: { kind: "daily", time: hhmm(now - 20 * 3_600_000) } })).json as RoutineJson;
    await stop();
    const file = new Database(join(box.dataDir, "hub.db"));
    const slot = (hoursAgo: number): number => {
      const at = new Date(now - hoursAgo * 3_600_000);
      at.setSeconds(0, 0);
      return at.getTime();
    };
    file.prepare(`UPDATE hub_routines SET next_fire_at = ? WHERE id = ?`).run(slot(2), recent.id);
    file.prepare(`UPDATE hub_routines SET next_fire_at = ? WHERE id = ?`).run(slot(20), old.id);
    file.close();
    await boot();
    const caught = await inboxItem((entry) => entry.routineId === recent.id && entry.status === "completed");
    assert.equal(caught.trigger, "catch-up");
    assert.match(caught.note ?? "", /hub was off/);
    const missed = await inboxItem((entry) => entry.routineId === old.id);
    assert.equal(missed.status, "missed");
    assert.equal(missed.taskId, null);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
    const runs = (await http("GET", `/delegation/routines/${recent.id}/runs`)).json as InboxItem[];
    assert.equal(runs.length, 1);
    assert.equal(((await http("GET", `/delegation/routines/${old.id}/runs`)).json as InboxItem[]).length, 1);
  });
});

describe("G4 review, cost, gh, health and forecast", () => {
  let taskId = "";

  it("diffs a delegated run against its starting commit and sends the review as a follow-up", async () => {
    const created = await http("POST", "/delegation/tasks", { prompt: "change b", workspace: "pilot", repo: "repo-a" });
    assert.equal(created.status, 201);
    taskId = (created.json as { task: { id: string } }).task.id;
    await taskSettled(taskId, 1);
    writeFileSync(join(box.repoA, "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    writeFileSync(join(box.repoA, "notes.md"), "todo\n");
    const diff = (await http("GET", `/delegation/tasks/${taskId}/diff`)).json as { available: boolean; base: { kind: string }; files: { path: string; status: string }[] };
    assert.equal(diff.available, true);
    assert.equal(diff.base.kind, "start-commit");
    assert.deepEqual(diff.files.map((file) => [file.path, file.status]), [["app.ts", "modified"], ["notes.md", "untracked"]]);
    const sent = await http("POST", `/delegation/tasks/${taskId}/review`, { comments: [{ file: "app.ts", line: 2, text: "keep let here" }] });
    assert.equal(sent.status, 201);
    assert.equal((sent.json as { mode: string }).mode, "continue");
    assert.match((sent.json as { text: string }).text, /app\.ts:2\n  > const b = 2;\n  keep let here/);
    const detail = await taskSettled(taskId, 2);
    assert.equal(detail.runs.length, 2);
    const capture = JSON.parse(readFileSync(box.claudeCapture, "utf8")) as { prompt: string; argv: string[] };
    assert.match(capture.prompt, /app\.ts:2/);
    assert.ok(capture.argv.includes("--resume"));
    assert.equal(detail.cost.runs, 2);
    assert.equal(Math.round((detail.cost.costUsd ?? 0) * 100) / 100, 0.2);
  });

  it("aggregates cost per task", async () => {
    const one = (await http("GET", `/delegation/tasks/${taskId}/cost`)).json as CostJson;
    assert.equal(one.pricedRuns, 2);
    assert.equal(one.tokensIn, 300);
    const many = (await http("GET", `/delegation/costs?taskIds=${taskId},unknown-task`)).json as { tasks: Record<string, CostJson> };
    assert.equal(many.tasks[taskId]?.runs, 2);
    assert.equal(many.tasks["unknown-task"]?.runs, 0);
  });

  it("hides PR/CI when gh is absent", async () => {
    assert.deepEqual((await http("GET", `/delegation/tasks/${taskId}/gh`)).json, { available: false, reason: "gh is not installed" });
  });

  it("returns the review text of a plain session for the clipboard", async () => {
    await http("POST", "/hook", { kind: "session_start", sessionId: "g4-session", cwd: box.repoA });
    const diff = (await http("GET", "/delegation/sessions/g4-session/diff")).json as { available: boolean; base: { kind: string } };
    assert.equal(diff.available, true);
    assert.equal(diff.base.kind, "head");
    const review = (await http("POST", "/delegation/sessions/g4-session/review", { comments: [{ file: "notes.md", line: 1, text: "drop this" }] })).json as { mode: string; text: string };
    assert.equal(review.mode, "copy");
    assert.match(review.text, /notes\.md:1\n  > todo\n  drop this/);
    assert.equal((await http("GET", "/delegation/sessions/unknown/diff")).status, 404);
    assert.equal((await http("POST", "/delegation/sessions/g4-session/review", { comments: [] })).status, 400);
  });

  it("refuses a session cwd that is a UNC or relative path without running git or gh", async () => {
    const reason = "the working directory is not an absolute local path";
    for (const [id, cwd] of [["g4-unc", "\\\\server\\share\\repo"], ["g4-relative", "some/relative/dir"]] as const) {
      await http("POST", "/hook", { kind: "session_start", sessionId: id, cwd });
      assert.deepEqual((await http("GET", `/delegation/sessions/${id}/diff`)).json, { available: false, reason });
      assert.deepEqual((await http("GET", `/delegation/sessions/${id}/gh`)).json, { available: false, reason });
      const review = (await http("POST", `/delegation/sessions/${id}/review`, { comments: [{ file: "a.ts", line: 1, text: "x" }] })).json as { mode: string };
      assert.equal(review.mode, "copy");
    }
  });

  it("aggregates the health of every integration", async () => {
    const report = (await http("GET", "/delegation/health")).json as { state: string; items: { id: string; state: string }[] };
    assert.equal(report.items.length, 8);
    assert.ok(report.items.every((item) => ["ok", "warn", "off", "error"].includes(item.state)));
    assert.equal(report.items.find((item) => item.id === "share-tunnel")?.state, "off");
  });

  it("shows no forecast without samples", async () => {
    assert.deepEqual((await http("GET", "/delegation/limits/forecast")).json, { claude: { fiveHour: null, sevenDay: null }, codex: { primary: null, secondary: null } });
  });
});
