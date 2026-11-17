import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { s2InitRepo, s2Sandbox, s2StartHub, s2Until, type S2Hub } from "./helpers/s2-env.js";

const box = s2Sandbox("cch-s2-launch-", { HUB_DELEGATION: "1" });

const { db } = await import("../src/db.js");
const launch = await import("../src/delegation-launch.js");
const store = await import("../src/delegation-store.js");
const shares = await import("../src/share-store.js");
const dbModule = await import("../src/db.js");

let hub: S2Hub;

before(async () => {
  s2InitRepo(box.repoA);
  hub = await s2StartHub(box);
  const res = await hub.http("PUT", "/delegation/settings", { workspacesRoot: box.root, autonomy: "full" });
  assert.equal(res.status, 200, res.text);
});

after(async () => {
  launch.abortActiveRuns("test over");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await hub.close();
  if (db.open) db.close();
  delete process.env.HUB_DELEGATION_TIMEOUT_MIN;
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const waitIdle = (taskId: string): Promise<true> => s2Until(() => (launch.isTaskActive(taskId) ? null : true), 20_000);

const captured = (): { argv: string[]; env: Record<string, string | null> } => JSON.parse(readFileSync(box.claudeCapture, "utf8")) as { argv: string[]; env: Record<string, string | null> };

describe("created-by markers", () => {
  it("reads the share label, id and trust out of the creator", () => {
    assert.equal(launch.shareLabelFromCreatedBy(null), null);
    assert.equal(launch.shareLabelFromCreatedBy("routine:abc"), null);
    assert.equal(launch.shareLabelFromCreatedBy("share:abc:Will Smith"), "Will Smith");
    assert.equal(launch.shareLabelFromCreatedBy("share:abc"), "abc");
    assert.equal(launch.shareIdFromCreatedBy(null), null);
    assert.equal(launch.shareIdFromCreatedBy("cli"), null);
    assert.equal(launch.shareIdFromCreatedBy("share:abc:Will"), "abc");
    assert.equal(launch.shareIdFromCreatedBy("share:abc"), "abc");
    assert.equal(launch.shareTrustFromCreatedBy(null), null);
    assert.equal(launch.shareTrustFromCreatedBy("mcp"), null);
    const share = shares.createShare({ label: "Trusty", workspace: "pilot", repo: null, sessionId: null, trust: "high", note: null, model: null, maxPerHour: null, expiresAt: null });
    assert.equal(launch.shareTrustFromCreatedBy(`share:${share.id}:Trusty`), "high");
    assert.equal(launch.shareTrustFromCreatedBy(`share:${share.id}`), "high");
    assert.equal(launch.shareTrustFromCreatedBy("share:gone:Ghost"), "low");
    assert.equal(launch.titleFrom("\n\n  First real line  \nsecond"), "First real line");
    assert.equal(launch.titleFrom("   "), "");
  });
});

describe("run lifecycle", () => {
  it("notifies listeners when a run finishes, survives a throwing listener and stops after unsubscribing", async () => {
    const seen: string[] = [];
    const stopGood = launch.onRunFinished((info) => seen.push(`${info.task.id}:${info.status}`));
    const stopBad = launch.onRunFinished(() => {
      throw new Error("listener blew up");
    });
    const detail = launch.delegateTask({ prompt: "listen", workspace: "pilot", repo: null, runner: null, model: null, permissionMode: null, sandbox: null, title: null, source: "test" });
    await waitIdle(detail.task.id);
    assert.deepEqual(seen, [`${detail.task.id}:completed`]);
    stopGood();
    stopBad();
    const again = launch.delegateTask({ prompt: "silent", workspace: "pilot", repo: null, runner: null, model: null, permissionMode: null, sandbox: null, title: "Titled", source: null });
    await waitIdle(again.task.id);
    assert.equal(seen.length, 1);
    assert.equal(again.task.title, "Titled");
  });

  it("rejects incomplete delegation and unknown workspaces", () => {
    const blank = { prompt: null, workspace: null, repo: null, runner: null, model: null, permissionMode: null, sandbox: null, title: null, source: null };
    assert.throws(() => launch.delegateTask(blank), launch.BadRequestError);
    assert.throws(() => launch.delegateTask({ ...blank, prompt: "p", workspace: "ghost" }), launch.NotFoundError);
    assert.throws(() => launch.delegateTask({ ...blank, prompt: "p", workspace: "pilot", repo: "ghost" }), /repo "ghost" is not in workspace/);
    assert.equal(launch.repoPathOf({ repo: null, workspace: "pilot" } as never), null);
    assert.equal(launch.repoPathOf({ repo: "repo-a", workspace: "ghost" } as never), null);
    assert.ok(launch.repoPathOf({ repo: "repo-a", workspace: "pilot" } as never)?.endsWith("repo-a"));
  });

  it("falls back to the shared checkout when a busy repo cannot take a worktree", async () => {
    const first = launch.delegateTask({ prompt: "sleep:30000", workspace: "pilot", repo: "repo-b", runner: null, model: null, permissionMode: null, sandbox: null, title: null, source: null });
    const second = launch.delegateTask({ prompt: "second", workspace: "pilot", repo: "repo-b", runner: null, model: null, permissionMode: null, sandbox: null, title: null, source: null });
    assert.equal(second.task.isolation, "shared");
    assert.equal(second.task.isolationReason, "default");
    assert.throws(() => launch.delegateTask({ prompt: "tree", workspace: "pilot", repo: "repo-b", runner: null, model: null, permissionMode: null, sandbox: null, title: null, source: null, isolation: "worktree" }), /not a git checkout/);
    assert.throws(() => launch.delegateTask({ prompt: "tree", workspace: "pilot", repo: null, runner: null, model: null, permissionMode: null, sandbox: null, title: null, source: null, isolation: "worktree" }), /requires a repo/);
    assert.equal(launch.abortRun(first.task.id, "cleanup"), true);
    assert.equal(launch.abortRun("no-such-task", "cleanup"), false);
    await waitIdle(first.task.id);
    await waitIdle(second.task.id);
  });
});

describe("task context", () => {
  it("tells the agent which files other agents have claimed in its repo", async () => {
    dbModule.applyHook({ kind: "session_start", sessionId: "claim-holder", cwd: box.repoA, source: null, hostPid: null, shellPid: null, title: "Holder", message: null, notificationType: null, model: null, tokensIn: null, tokensOut: null, contextTokens: null, agentId: null, agentType: null, client: null, claudePid: null, transcriptPath: null, agentMessage: null, shareLabel: null });
    const repoPath = launch.repoPathOf({ repo: "repo-a", workspace: "pilot" } as never) as string;
    dbModule.createClaim({ sessionId: "claim-holder", repoPath, paths: ["src/**"], note: "refactoring" });
    dbModule.createClaim({ sessionId: null, repoPath, paths: ["docs/a.md"] });
    const detail = launch.delegateTask({ prompt: "respect claims", workspace: "pilot", repo: "repo-a", runner: null, model: null, permissionMode: null, sandbox: null, title: null, source: null, isolation: "shared" });
    await waitIdle(detail.task.id);
    const argv = captured().argv;
    const context = argv[argv.indexOf("--append-system-prompt") + 1] ?? "";
    assert.match(context, /Files claimed by other agents in "repo-a"/);
    assert.match(context, /src\/\*\* \(session Holder, until .*, refactoring\)/);
    assert.match(context, /docs\/a\.md \(session [0-9a-f]{8}, until /);
    assert.match(context, /Ports reserved for this task: \d+-\d+/);
    assert.match(context, new RegExp(`launched by the CC Hub \\(task ${detail.task.id}\\)`));
  });

  it("gives share runs their guardrail and artifact folders", async () => {
    const full = shares.createShare({ label: "Full Trust", workspace: "pilot", repo: null, sessionId: null, trust: "total", note: null, model: null, maxPerHour: null, expiresAt: null });
    const low = shares.createShare({ label: "Low Trust", workspace: "pilot", repo: null, sessionId: null, trust: "low", note: null, model: null, maxPerHour: null, expiresAt: null });
    for (const [share, handsBack] of [[full, true], [low, false]] as const) {
      const detail = launch.delegateTask({ prompt: "share work", workspace: "pilot", repo: null, runner: null, model: null, permissionMode: "plan", sandbox: null, title: null, source: `share:${share.id}:${share.label}` });
      await waitIdle(detail.task.id);
      const argv = captured().argv;
      const context = argv[argv.indexOf("--append-system-prompt") + 1] ?? "";
      assert.ok(context.includes(share.label), "the guardrail names the share");
      assert.match(context, /Files the asker sent are in /);
      assert.equal(/To hand a file back to the asker/.test(context), handsBack, share.label);
    }
  });

  it("describes the worktree of an isolated task", async () => {
    const hold = launch.delegateTask({ prompt: "sleep:30000", workspace: "pilot", repo: "repo-a", runner: null, model: null, permissionMode: null, sandbox: null, title: null, source: null, isolation: "shared" });
    const tree = launch.delegateTask({ prompt: "in a tree", workspace: "pilot", repo: "repo-a", runner: null, model: null, permissionMode: null, sandbox: null, title: null, source: null });
    await waitIdle(tree.task.id);
    const argv = captured().argv;
    const context = argv[argv.indexOf("--append-system-prompt") + 1] ?? "";
    assert.match(context, /isolated git worktree of "repo-a"/);
    assert.match(context, /isolated this task automatically because another task is already working/);
    assert.equal(tree.task.isolation, "worktree");
    launch.abortRun(hold.task.id, "cleanup");
    await waitIdle(hold.task.id);
  });
});

describe("run timeout", () => {
  it("reads the timeout from the environment or the settings and aborts a run that overstays it", async () => {
    delete process.env.HUB_DELEGATION_TIMEOUT_MIN;
    store.updateSettings({ runTimeoutMinutes: 15 });
    assert.equal(launch.resolveRunTimeoutMs(), 15 * 60_000);
    process.env.HUB_DELEGATION_TIMEOUT_MIN = "  ";
    assert.equal(launch.resolveRunTimeoutMs(), 15 * 60_000);
    process.env.HUB_DELEGATION_TIMEOUT_MIN = "abc";
    assert.equal(launch.resolveRunTimeoutMs(), 0);
    process.env.HUB_DELEGATION_TIMEOUT_MIN = "-4";
    assert.equal(launch.resolveRunTimeoutMs(), 0);
    process.env.HUB_DELEGATION_TIMEOUT_MIN = "0.002";
    const detail = launch.delegateTask({ prompt: "sleep:30000", workspace: "pilot", repo: null, runner: null, model: null, permissionMode: null, sandbox: null, title: null, source: null });
    await waitIdle(detail.task.id);
    const done = store.getTaskDetail(detail.task.id);
    assert.notEqual(done?.task.status, "completed");
    assert.match(done?.runs[0]?.error ?? "", /timed out after/);
    process.env.HUB_DELEGATION_TIMEOUT_MIN = "6";
    const warned = launch.delegateTask({ prompt: "quick", workspace: "pilot", repo: null, runner: null, model: null, permissionMode: null, sandbox: null, title: null, source: null });
    await waitIdle(warned.task.id);
    assert.equal(store.getTaskDetail(warned.task.id)?.task.status, "completed");
    delete process.env.HUB_DELEGATION_TIMEOUT_MIN;
  });
});

describe("internal tasks", () => {
  it("creates a task with its own port range and runs it for a daily date", async () => {
    const task = launch.createInternalTask({ title: "Internal", prompt: "do the daily", workspace: "pilot", cwd: box.repoA, addDirs: [], runner: "claude", createdBy: "daily:test", dailyDate: "2026-11-16" });
    assert.ok(task.portBase !== null);
    assert.equal(task.dailyDate, "2026-11-16");
    launch.startRun(task, "launch", "do the daily", null, null);
    await waitIdle(task.id);
    assert.equal(store.getTask(task.id)?.status, "completed");
    const plain = launch.createInternalTask({ title: "Plain", prompt: "p", workspace: "pilot", cwd: box.repoA, addDirs: [], runner: "claude", createdBy: "x" });
    assert.equal(plain.dailyDate, null);
  });
});
