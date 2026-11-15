import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { makeSandbox, startServer, waitFor, type RunningServer } from "./helpers.js";

const box = makeSandbox("cch-auto-");
let hub: RunningServer;

interface Detail {
  task: { id: string; status: string; sandbox: string | null };
  runs: { status: string; permissionMode: string | null; error: string | null }[];
}

async function http(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${hub.base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
}

const waitSettled = (id: string): Promise<Detail> =>
  waitFor(async () => {
    const detail = (await http("GET", `/delegation/tasks/${id}`)).json as Detail;
    return ["pending", "running"].includes(detail.task.status) ? null : detail;
  }, 15000);

async function delegate(body: Record<string, unknown>): Promise<Detail> {
  const created = await http("POST", "/delegation/tasks", { workspace: "pilot", ...body });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return waitSettled((created.json as Detail).task.id);
}

const argvOf = (path: string): string[] => (JSON.parse(readFileSync(path, "utf8")) as { argv: string[] }).argv;
const after1 = (argv: string[], flag: string): string | undefined => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

before(async () => {
  hub = await startServer(box, { HUB_DELEGATION: "1", FAKE_CLAUDE_DELAY_MS: "0" });
  await http("PUT", "/delegation/settings", { workspacesRoot: box.root, features: { delegated: true, workspaces: true } });
});

describe("auto (guarded) autonomy", () => {
  it("stores the auto level and runs Claude in auto mode with permission prompts off", async () => {
    const saved = await http("PUT", "/delegation/settings", { autonomy: "auto" });
    assert.equal(saved.status, 200);
    assert.equal((saved.json as { autonomy: string }).autonomy, "auto");
    assert.equal(((await http("GET", "/delegation/settings")).json as { autonomy: string }).autonomy, "auto");
    const detail = await delegate({ prompt: "guarded" });
    assert.equal(detail.task.status, "completed", detail.runs[0]?.error ?? "");
    const argv = argvOf(box.claudeCapture);
    assert.equal(after1(argv, "--permission-mode"), "auto");
    assert.equal(after1(argv, "--permission-prompts"), "none");
    assert.ok(!argv.includes("--dangerously-skip-permissions"));
    assert.equal(detail.runs[0]?.permissionMode, "auto");
  });

  it("still honours plan and keeps Codex sandboxed under auto", async () => {
    await delegate({ prompt: "plan it", permissionMode: "plan" });
    const plan = argvOf(box.claudeCapture);
    assert.equal(after1(plan, "--permission-mode"), "plan");
    assert.equal(after1(plan, "--permission-prompts"), undefined);
    await delegate({ prompt: "codex guarded", runner: "codex" });
    const codex = argvOf(box.codexCapture);
    assert.ok(!codex.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.equal(after1(codex, "-s"), "workspace-write");
  });

  it("keeps full as the default and the other levels unchanged", async () => {
    assert.equal((await http("PUT", "/delegation/settings", { autonomy: "loud" })).status, 400);
    assert.equal((await http("PUT", "/delegation/settings", { autonomy: "full" })).status, 200);
    await delegate({ prompt: "full again" });
    const full = argvOf(box.claudeCapture);
    assert.equal(after1(full, "--permission-mode"), "bypassPermissions");
    assert.equal(after1(full, "--permission-prompts"), undefined);
  });
});

after(async () => {
  hub.child.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
