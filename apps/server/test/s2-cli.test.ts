import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { serverDir } from "./helpers.js";
import { startFakeHub, type FakeHub } from "./helpers/s2-hooks.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-s2-cli-"));
let hub: FakeHub;

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], input: unknown, env: Record<string, string | undefined> = {}): Promise<CliRun> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, HUB_DATA_DIR: dataDir, HUB_URL: `http://127.0.0.1:${hub.port}` };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(serverDir, "src", "cli.ts"), ...args], { cwd: serverDir, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input));
  });
}

before(async () => {
  hub = await startFakeHub((request) => ({ body: { echoed: request.path } }));
});

after(async () => {
  await hub.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const lastRequest = () => hub.requests[hub.requests.length - 1];

describe("cli commands", () => {
  const mapped: [Record<string, unknown>, string, string][] = [
    [{ action: "overview" }, "GET", "/delegation/overview"],
    [{ action: "settings" }, "GET", "/delegation/settings"],
    [{ action: "set-settings", workspacesRoot: "C:/ws", editorCommand: "code", secondBrainRoot: "C:/brain" }, "PUT", "/delegation/settings"],
    [{ action: "set-settings" }, "PUT", "/delegation/settings"],
    [{ action: "workspaces" }, "GET", "/delegation/workspaces"],
    [{ action: "create-workspace", name: "new", repos: ["C:/r"] }, "POST", "/delegation/workspaces"],
    [{ action: "update-workspace", workspace: "my ws", repos: [] }, "PUT", "/delegation/workspaces/my%20ws"],
    [{ action: "open", workspace: "w" }, "POST", "/delegation/workspaces/w/open"],
    [{ action: "connect" }, "GET", "/delegation/connect"],
    [{ action: "connect-shell", shell: "bash", do: "install" }, "POST", "/delegation/connect/shell"],
    [{ action: "connect-shell", shell: "bash" }, "POST", "/delegation/connect/shell"],
    [{ action: "connect-mcp", client: "claude", do: "remove" }, "POST", "/delegation/connect/mcp"],
    [{ action: "list", status: "running", limit: 3 }, "GET", "/delegation/tasks"],
    [{ action: "list" }, "GET", "/delegation/tasks"],
    [{ action: "get", taskId: "t 1" }, "GET", "/delegation/tasks/t%201"],
    [{ action: "delegate", prompt: "do it", workspace: "w", title: "T", repo: "r", runner: "codex", model: "m", permissionMode: "plan", sandbox: "read-only", source: "script" }, "POST", "/delegation/tasks"],
    [{ action: "create", prompt: "do it", workspace: "w" }, "POST", "/delegation/tasks"],
    [{ action: "continue", taskId: "t1", prompt: "more", model: "m", permissionMode: "plan" }, "POST", "/delegation/tasks/t1/continue"],
    [{ action: "cancel", taskId: "t1" }, "POST", "/delegation/tasks/t1/cancel"],
    [{ action: "report", text: "done", kind: "result", taskId: "t1", sessionId: "s1", workspace: "w", source: "me" }, "POST", "/delegation/reports"],
    [{ action: "report", text: "bare" }, "POST", "/delegation/reports"],
    [{ action: "reports", taskId: "t1", limit: 4 }, "GET", "/delegation/reports"],
    [{ action: "brain" }, "GET", "/delegation/brain/today"],
    [{ action: "sessions" }, "GET", "/api/sessions"],
    [{ action: "codex-sessions" }, "GET", "/api/codex/sessions"],
    [{ action: "runtimes" }, "GET", "/api/runtimes"],
    [{ action: "focus", sessionId: "s 1" }, "POST", "/api/sessions/s%201/focus"],
  ];

  for (const [command, method, path] of mapped) {
    it(`sends ${String(command.action)} to ${method} ${path}`, async () => {
      const run = await cli([], command);
      assert.equal(run.code ?? 0, 0, run.stderr);
      const sent = lastRequest();
      assert.equal(sent?.method, method);
      assert.equal(sent?.path, path);
      assert.match(run.stdout, /"echoed"/);
      assert.ok(run.stdout.endsWith("\n"));
    });
  }

  it("sends the right bodies and drops empty optional fields", async () => {
    await cli([], { action: "delegate", prompt: "do it", workspace: "w", repo: "", runner: "codex", model: "m" });
    const delegate = lastRequest()?.body;
    assert.equal(delegate?.source, "cli");
    assert.equal(delegate?.repo, undefined);
    assert.equal(delegate?.runner, "codex");
    await cli([], { action: "list", status: "failed", limit: 9 });
    assert.equal(lastRequest()?.query.get("status"), "failed");
    assert.equal(lastRequest()?.query.get("limit"), "9");
    await cli([], { action: "list", status: "", limit: null });
    assert.equal(lastRequest()?.query.get("status"), null);
    await cli([], { action: "connect-shell", shell: "pwsh", do: "install" });
    assert.deepEqual(lastRequest()?.body, { shell: "pwsh", action: "install" });
    await cli([], { action: "set-settings", workspacesRoot: "C:/ws" });
    assert.deepEqual(lastRequest()?.body, { workspacesRoot: "C:/ws" });
    await cli([], { action: "report", text: "t" });
    assert.equal(lastRequest()?.body?.source, "cli");
  });

  it("reports the hub's error body and a failing exit code", async () => {
    hub.routes = () => ({ status: 409, body: { error: "busy" } });
    const run = await cli([], { action: "cancel", taskId: "t1" });
    assert.equal(run.code, 1);
    assert.match(run.stdout, /busy/);
    hub.routes = (request) => ({ body: { echoed: request.path } });
  });

  it("explains unusable commands", async () => {
    const cases: [unknown, RegExp][] = [
      ["", /empty stdin/],
      ["   ", /empty stdin/],
      [{ nothing: true }, /missing "action"/],
      [{ action: 5 }, /missing "action"/],
      [{ action: "explode" }, /unknown action "explode"/],
      [{ action: "get" }, /missing "taskId"/],
      [{ action: "get", taskId: "   " }, /missing "taskId"/],
      [{ action: "delegate", workspace: "w" }, /missing "prompt"/],
      [{ action: "report" }, /missing "text"/],
      [{ action: "focus", sessionId: 3 }, /missing "sessionId"/],
      ["{ not json", /JSON|Unexpected|Expected/],
    ];
    for (const [input, message] of cases) {
      const run = await cli([], input);
      assert.equal(run.code, 1, JSON.stringify(input));
      assert.match(run.stderr, message, JSON.stringify(input));
    }
  });
});

describe("cli hub address", () => {
  it("prints a clear error when the hub cannot be reached", async () => {
    const run = await cli([], { action: "overview" }, { HUB_URL: "http://127.0.0.1:1/" });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /cannot reach the hub at http:\/\/127\.0\.0\.1:1\/delegation\/overview: /);
  });

  it("builds the address from the configured host and port when HUB_URL is blank", async () => {
    for (const host of ["0.0.0.0", "::", "::1", "127.0.0.1"]) {
      const run = await cli([], { action: "overview" }, { HUB_URL: "   ", HUB_HOST: host, HUB_PORT: "1" });
      assert.equal(run.code, 1);
      const expected = host === "::1" ? "http://[::1]:1" : "http://127.0.0.1:1";
      assert.ok(run.stderr.includes(`cannot reach the hub at ${expected}/delegation/overview`), `${host}: ${run.stderr}`);
    }
    const trimmed = await cli([], { action: "overview" }, { HUB_URL: `  http://127.0.0.1:${hub.port}/  ` });
    assert.equal(trimmed.code ?? 0, 0, trimmed.stderr);
  });
});
