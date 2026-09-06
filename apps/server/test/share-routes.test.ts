import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { freePort, makeSandbox, startServer, type RunningServer } from "./helpers.js";

const box = makeSandbox("cch-share-routes-");
let hub: RunningServer;
let sharePort = 0;

interface ShareView {
  id: string;
  key: string;
  state: string;
  trust: string;
  links: { local: string; lan: string | null; public: string | null };
}

const headers = { "content-type": "application/json", origin: "" };

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${hub.base}${path}`, { method, headers: { ...headers, origin: hub.base }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

before(async () => {
  sharePort = await freePort();
  hub = await startServer(box, { HUB_DELEGATION: "1", HUB_SHARE_PORT: String(sharePort) });
  await call("PUT", "/delegation/settings", { workspacesRoot: box.root });
});

describe("share management on the hub", () => {
  it("creates, lists, pauses, documents and deletes shares", async () => {
    const created = await call("POST", "/delegation/shares", { label: "Will", workspace: "pilot", repo: "repo-a", trust: "low", expiresInHours: 2 });
    assert.equal(created.status, 201);
    const share = created.json as unknown as ShareView;
    assert.equal(share.state, "active");
    assert.ok(share.links.local.includes(`:${sharePort}/share/${share.id}?key=${share.key}`));
    assert.equal(share.links.public, null);

    const list = (await call("GET", "/delegation/shares")).json as unknown as ShareView[];
    assert.equal(list.length, 1);

    const remote = await fetch(share.links.local);
    assert.equal(remote.status, 200);
    assert.match(await remote.text(), /repository: repo-a/);

    const doc = await fetch(`${hub.base}/delegation/shares/${share.id}/doc?base=local`, { headers: { origin: hub.base } });
    assert.equal(doc.status, 200);
    assert.match(await doc.text(), new RegExp(`127\\.0\\.0\\.1:${sharePort}/share/${share.id}/ask`));

    const paused = await call("PATCH", `/delegation/shares/${share.id}`, { paused: true });
    assert.equal((paused.json as unknown as ShareView).state, "paused");
    assert.equal((await fetch(share.links.local)).status, 423);

    const revoked = await call("PATCH", `/delegation/shares/${share.id}`, { revoke: true });
    assert.equal((revoked.json as unknown as ShareView).state, "revoked");
    assert.equal((await call("DELETE", `/delegation/shares/${share.id}`)).status, 200);
    assert.equal((await call("GET", "/delegation/shares")).json.length, 0);
  });

  it("validates workspace, trust and session", async () => {
    assert.equal((await call("POST", "/delegation/shares", { workspace: "nope" })).status, 404);
    assert.equal((await call("POST", "/delegation/shares", { workspace: "pilot", trust: "root" })).status, 400);
    assert.equal((await call("POST", "/delegation/shares", { workspace: "pilot", sessionId: "missing" })).status, 404);
  });

  it("answers from a forked session when the share pins one", async () => {
    await fetch(`${hub.base}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "session_start", sessionId: "sess-fork", cwd: box.repoA, title: "Nexus doubts" }),
    });
    const created = await call("POST", "/delegation/shares", { label: "Will", workspace: "pilot", sessionId: "sess-fork", trust: "low" });
    assert.equal(created.status, 201);
    const share = created.json as unknown as ShareView;
    const res = await fetch(`${share.links.local.split("?")[0]}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${share.key}` },
      body: JSON.stringify({ question: "what did we decide" }),
    });
    assert.equal(res.status, 200);
    const answer = (await res.json()) as { answer: string };
    assert.equal(answer.answer, "continued: what did we decide");
    const capture = JSON.parse(readFileSync(box.claudeCapture, "utf8")) as { argv: string[]; cwd: string };
    assert.equal(capture.cwd, box.repoA);
    assert.equal(capture.argv[capture.argv.indexOf("--resume") + 1], "sess-fork");
    assert.ok(capture.argv.includes("--fork-session"));
    assert.match(capture.argv[capture.argv.indexOf("--append-system-prompt") + 1] ?? "", /Nexus doubts/);
    const activity = (await call("GET", "/delegation/shares/activity")).json as unknown as { label: string; status: string; answer: string }[];
    assert.equal(activity[0]?.label, "Will");
    assert.equal(activity[0]?.status, "completed");
  });

  it("refuses to pin a session that runs outside the workspace", async () => {
    await fetch(`${hub.base}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "session_start", sessionId: "sess-outside", cwd: box.home, title: "Vault notes" }),
    });
    const res = await call("POST", "/delegation/shares", { label: "Will", workspace: "pilot", sessionId: "sess-outside" });
    assert.equal(res.status, 400);
    assert.match(String(res.json.error), /runs outside the "pilot" workspace/);
  });

  it("rotates the key on demand", async () => {
    const created = (await call("POST", "/delegation/shares", { label: "Will", workspace: "pilot" })).json as unknown as ShareView;
    const rotated = (await call("PATCH", `/delegation/shares/${created.id}`, { rotate: true })).json as unknown as ShareView;
    assert.notEqual(rotated.key, created.key);
    assert.equal((await fetch(created.links.local)).status, 401);
    assert.equal((await fetch(rotated.links.local)).status, 200);
  });

  it("reports the tunnel state without a tunnel", async () => {
    const status = (await call("GET", "/delegation/tunnel")).json as { state: string; sharePort: number; localUrl: string; publicUrl: string | null };
    assert.equal(status.state, "stopped");
    assert.equal(status.sharePort, sharePort);
    assert.equal(status.localUrl, `http://127.0.0.1:${sharePort}`);
    assert.equal(status.publicUrl, null);
    assert.equal((await call("POST", "/delegation/tunnel/stop")).status, 200);
  });

  it("keeps the share port out of the main hub and the hub out of the share port", async () => {
    assert.equal((await fetch(`${hub.base}/share/x?key=y`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${sharePort}/api/health`)).status, 404);
  });
});

after(async () => {
  hub.child.kill();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});
