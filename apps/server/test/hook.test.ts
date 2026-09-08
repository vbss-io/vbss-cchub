import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const hook = join(here, "..", "hooks", "notify.mjs");
const transcript = join(here, "fixtures", "transcript-sample.jsonl");

interface Received {
  kind: string;
  sessionId: string;
  cwd: string | null;
  title: string | null;
  claudePid: number | null;
}

let server: Server;
let port = 0;
const received: Received[] = [];
let waiters: ((body: Received) => void)[] = [];

const nextHook = (): Promise<Received> =>
  new Promise((resolve) => {
    waiters.push(resolve);
  });

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as Received;
      received.push(body);
      for (const waiter of waiters.splice(0)) waiter(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

after(() => {
  server.close();
});

function runHook(env: Record<string, string>, input: Record<string, unknown>): Promise<{ code: number | null; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [hook], {
      env: { ...process.env, HUB_HOST_TARGET: "127.0.0.1", HUB_PORT: String(port), HUB_SKIP: "0", ...env },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("exit", (code) => resolve({ code, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("hub hook", () => {
  it("returns immediately and posts the event from a detached worker", async () => {
    const arrival = nextHook();
    const run = await runHook({ CLAUDE_PID: String(process.pid) }, { hook_event_name: "UserPromptSubmit", session_id: "hook-detached", cwd: "C:/x", transcript_path: transcript });
    assert.equal(run.code, 0);
    assert.ok(run.ms < 3_000, `hook took ${run.ms} ms`);
    const body = await Promise.race([arrival, new Promise<Received>((_, reject) => setTimeout(() => reject(new Error("no hook within 15 s")), 15_000))]);
    assert.equal(body.kind, "user_prompt");
    assert.equal(body.sessionId, "hook-detached");
    assert.equal(body.cwd, "C:/x");
    assert.equal(body.claudePid, process.pid);
  });

  it("still posts inline when HUB_HOOK_INLINE=1", async () => {
    const run = await runHook({ HUB_HOOK_INLINE: "1" }, { hook_event_name: "Stop", session_id: "hook-inline", cwd: "C:/y", transcript_path: transcript });
    assert.equal(run.code, 0);
    const body = received.find((item) => item.sessionId === "hook-inline");
    assert.ok(body, "inline hook posted before exiting");
    assert.equal(body.kind, "stop");
  });
});
