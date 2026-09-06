import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeSandbox, sandboxEnv, waitFor } from "./helpers.js";
import type { ShareRecord } from "../src/share-types.js";

const box = makeSandbox("cch-share-");
const env = sandboxEnv(box, { HUB_PORT: "4398", HUB_SHARE_PORT: "0", HUB_SHARE_SYNC_WAIT_MS: "3000" });
for (const key of ["HUB_RESOURCE_DIR", "HUB_WORKSPACES_ROOT", "HUB_EDITOR", "HUB_TRUSTED_ORIGINS", "HUB_SECOND_BRAIN"]) delete process.env[key];
for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;

type Store = typeof import("../src/share-store.js");
type Db = typeof import("../src/db.js");
let store: Store;
let db: Db;
let server: Server;
let base = "";

interface Capture {
  argv: string[];
  cwd: string;
  prompt: string;
  env: { HUB_TRACK_SDK: string | null; HUB_DELEGATED: string | null; HUB_PORT: string | null };
}

const readCapture = (): Capture => JSON.parse(readFileSync(box.claudeCapture, "utf8")) as Capture;
const flagValue = (argv: string[], flag: string): string | null => {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
};
const listAfter = (argv: string[], flag: string): string[] => {
  const index = argv.indexOf(flag);
  if (index < 0) return [];
  const out: string[] = [];
  for (let i = index + 1; i < argv.length && !argv[i]!.startsWith("--"); i += 1) out.push(argv[i]!);
  return out;
};

const url = (share: ShareRecord, path = ""): string => `${base}/share/${share.id}${path}`;
const auth = (share: ShareRecord): Record<string, string> => ({ authorization: `Bearer ${share.key}`, "content-type": "application/json" });

async function post(share: ShareRecord, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url(share, path), { method: "POST", headers: auth(share), body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const makeShare = (overrides: Partial<Parameters<Store["createShare"]>[0]> = {}): ShareRecord =>
  store.createShare({
    label: "Will",
    workspace: "pilot",
    repo: null,
    sessionId: null,
    trust: "low",
    note: "Context: the pilot workspace",
    model: null,
    maxPerHour: 30,
    expiresAt: null,
    ...overrides,
  });

before(async () => {
  db = await import("../src/db.js");
  store = await import("../src/share-store.js");
  const { updateSettings } = await import("../src/delegation-store.js");
  updateSettings({ workspacesRoot: box.root });
  const { createShareApp } = await import("../src/share-server.js");
  server = createShareApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

describe("share endpoint access", () => {
  it("greets on the root and refuses everything that is not a share route", async () => {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/api/sessions`)).status, 404);
    assert.equal((await fetch(`${base}/delegation/shares`)).status, 404);
  });

  it("requires the key and knows revoked, expired and paused shares", async () => {
    const share = makeShare();
    assert.equal((await fetch(url(share))).status, 401);
    assert.equal((await fetch(`${url(share)}?key=nope`)).status, 401);
    assert.equal((await fetch(`${base}/share/zzzz?key=${share.key}`)).status, 404);
    assert.equal((await fetch(`${url(share)}?key=${share.key}`)).status, 200);
    store.updateShare(share.id, { paused: true });
    assert.equal((await fetch(`${url(share)}?key=${share.key}`)).status, 423);
    store.updateShare(share.id, { paused: false, expiresAt: Date.now() - 1000 });
    assert.equal((await fetch(`${url(share)}?key=${share.key}`)).status, 410);
    store.updateShare(share.id, { expiresAt: null, revoked: true });
    assert.equal((await fetch(`${url(share)}?key=${share.key}`)).status, 410);
  });

  it("serves the handoff document with the key in the examples", async () => {
    const share = makeShare({ note: "Ask about the pilot" });
    const res = await fetch(`${url(share)}.md`, { headers: { authorization: `Bearer ${share.key}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    const doc = await res.text();
    assert.match(doc, /^CC Hub share · Will/);
    assert.match(doc, /Published by .* with CC Hub/);
    assert.match(doc, /X-Asker/);
    assert.match(doc, /openapi\.json/);
    assert.ok(doc.includes(`Bearer ${share.key}`));
    assert.ok(doc.includes(`${url(share)}/mcp`));
    assert.match(doc, /Trust level: Low\./);
    assert.match(doc, /> Ask about the pilot/);
    assert.ok(doc.includes(`${url(share)}/implement`));
    assert.ok(doc.includes(`${url(share)}/tasks`));
  });
});

describe("asking through a share", () => {
  it("refuses to stream an implementation and keeps no fork when the share is deleted mid-answer", async () => {
    const share = makeShare({ trust: "medium", label: "Gone" });
    const created = await post(share, "/implement", { prompt: "sleep:1200" });
    assert.equal(created.status, 201);
    const stream = await fetch(url(share, `/requests/${String(created.json.requestId)}/stream`), { headers: auth(share) });
    assert.equal(stream.status, 409);
    await waitFor(async () => (store.hasRunningImplement(share.id) ? null : true), 15000);
    const doomed = makeShare({ trust: "low", label: "Doomed" });
    const pending = post(doomed, "/ask", { question: "sleep:2500" });
    const { abortShareAsks } = await import("../src/share-service.js");
    const { liveRunners } = await import("../src/share-runner.js");
    await waitFor(async () => (liveRunners().some((runner) => runner.key === `${doomed.id}:Doomed` && runner.sessionId) ? true : null), 10000);
    abortShareAsks(doomed.id, "deleted");
    store.deleteShare(doomed.id);
    const result = await pending;
    assert.equal(result.status, 410);
    assert.equal(store.listShareForks(doomed.id).length, 0);
  });

  it("lets medium trust write only inside the share artifacts folder", async () => {
    const share = makeShare({ trust: "medium", label: "Writer" });
    const { status } = await post(share, "/ask", { question: "hand me a summary file" });
    assert.equal(status, 200);
    const capture = readCapture();
    assert.deepEqual(listAfter(capture.argv, "--tools"), ["Read", "Grep", "Glob", "LS", "Write"]);
    assert.deepEqual(listAfter(capture.argv, "--allowedTools"), ["Read", "Grep", "Glob", "LS", "Write"]);
    assert.ok(listAfter(capture.argv, "--disallowedTools").includes("Edit"));
    assert.ok(!listAfter(capture.argv, "--disallowedTools").includes("Write"));
    assert.ok(listAfter(capture.argv, "--disallowedTools").includes("Bash"));
    assert.equal((capture.env as { HUB_WRITE_SCOPE?: string | null }).HUB_WRITE_SCOPE, join(box.contextDir, "share-artifacts", share.id));
    assert.match(flagValue(capture.argv, "--append-system-prompt") ?? "", /only place you may write is the share artifacts folder/);
    const low = makeShare({ trust: "low", label: "Reader" });
    assert.equal((await post(low, "/ask", { question: "just read" })).status, 200);
    const lowCapture = readCapture();
    assert.deepEqual(listAfter(lowCapture.argv, "--tools"), ["Read", "Grep", "Glob", "LS"]);
    assert.equal((lowCapture.env as { HUB_WRITE_SCOPE?: string | null }).HUB_WRITE_SCOPE, null);
  });

  it("answers read-only with the guardrails and the workspace attached", async () => {
    const share = makeShare();
    const { status, json } = await post(share, "/ask", { question: "where is the config" });
    assert.equal(status, 200);
    assert.equal(json.status, "completed");
    assert.equal(json.answer, "handled: where is the config");
    const capture = readCapture();
    assert.equal(capture.cwd, box.contextDir);
    assert.equal(flagValue(capture.argv, "--permission-mode"), "dontAsk");
    assert.ok(capture.argv.includes("--input-format"));
    assert.ok(capture.argv.includes("--restricted"));
    assert.ok(capture.argv.includes("--strict-mcp-config"));
    assert.equal(flagValue(capture.argv, "--permission-prompts"), "none");
    assert.deepEqual(listAfter(capture.argv, "--tools"), ["Read", "Grep", "Glob", "LS"]);
    assert.deepEqual(listAfter(capture.argv, "--allowedTools"), ["Read", "Grep", "Glob", "LS"]);
    assert.ok(listAfter(capture.argv, "--disallowedTools").includes("Bash"));
    assert.ok(listAfter(capture.argv, "--disallowedTools").includes("Read(**/.env)"));
    const guardSettings = JSON.parse(flagValue(capture.argv, "--settings") ?? "{}") as { hooks?: { PreToolUse?: { hooks: { command: string }[] }[] } };
    assert.match(guardSettings.hooks?.PreToolUse?.[0]?.hooks[0]?.command ?? "", /guard\.mjs/);
    assert.equal((capture.env as { HUB_GUARD_SHELL?: string | null }).HUB_GUARD_SHELL, "0");
    assert.equal(capture.env.HUB_PORT, "4398");
    assert.equal(capture.env.HUB_DELEGATED, "1");
    assert.match(flagValue(capture.argv, "--append-system-prompt") ?? "", /external collaborator \("Will"\)/);
    assert.ok(capture.argv.includes(box.repoA));
    const requests = store.listShareRequests({ shareId: share.id });
    assert.equal(requests[0]?.status, "completed");
    assert.equal(requests[0]?.answer, "handled: where is the config");
  });

  it("enforces the hourly limit and one question at a time", async () => {
    const limited = makeShare({ maxPerHour: 1 });
    assert.equal((await post(limited, "/ask", { question: "one" })).status, 200);
    assert.equal((await post(limited, "/ask", { question: "two" })).status, 429);
    const busy = makeShare();
    const first = post(busy, "/ask", { question: "sleep:900" });
    await waitFor(async () => (store.hasRunningAsk(busy.id) ? true : null), 5000);
    assert.equal((await post(busy, "/ask", { question: "second" })).status, 409);
    assert.equal((await first).status, 200);
  });

  it("rejects empty and oversized questions and oversized bodies", async () => {
    const share = makeShare();
    assert.equal((await post(share, "/ask", { question: "   " })).status, 400);
    assert.equal((await post(share, "/ask", { question: "x".repeat(9000) })).status, 413);
    const huge = await fetch(url(share, "/ask"), { method: "POST", headers: auth(share), body: JSON.stringify({ question: "q", pad: "y".repeat(300_000) }) });
    assert.equal(huge.status, 413);
    assert.equal(((await huge.json()) as { error: string }).error, "body too large");
  });

  it("accepts the key only in headers for API calls", async () => {
    const share = makeShare();
    const viaQuery = await fetch(`${url(share, "/ask")}?key=${share.key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "hi" }) });
    assert.equal(viaQuery.status, 401);
    const viaHeader = await fetch(url(share, "/about"), { headers: { "x-hub-key": share.key } });
    assert.equal(viaHeader.status, 200);
  });

  it("returns 202 for a long answer and lets the caller poll it", async () => {
    const share = makeShare();
    const first = await post(share, "/ask", { question: "sleep:5000" });
    assert.equal(first.status, 202);
    assert.equal(first.json.status, "running");
    const requestId = String(first.json.requestId);
    const finished = await waitFor(async () => {
      const res = await fetch(url(share, `/requests/${requestId}`), { headers: auth(share) });
      const view = (await res.json()) as { status: string; answer: string | null };
      return view.status === "completed" ? view : null;
    }, 15000);
    assert.equal(finished.answer, "handled: sleep:5000");
  });

  it("stops an answer in flight when the owner revokes the share", async () => {
    const share = makeShare();
    const pending = post(share, "/ask", { question: "sleep:4000" });
    await waitFor(async () => (store.hasRunningAsk(share.id) ? true : null), 5000);
    const { abortShareAsks } = await import("../src/share-service.js");
    store.updateShare(share.id, { revoked: true });
    assert.equal(abortShareAsks(share.id, "this share was revoked by its owner"), 1);
    const result = await pending;
    assert.equal(result.status, 200);
    assert.equal(result.json.status, "failed");
    assert.equal(result.json.error, "this share was revoked by its owner");
  });

  it("hides internal failures behind a generic message", async () => {
    const share = makeShare();
    const { updateSettings } = await import("../src/delegation-store.js");
    updateSettings({ workspacesRoot: box.repoB });
    const res = await post(share, "/ask", { question: "where" });
    updateSettings({ workspacesRoot: box.root });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, "share target unavailable; ask the owner");
  });

  it("records the real peer, not a forged X-Forwarded-For", async () => {
    const share = makeShare();
    const res = await fetch(url(share, "/ask"), {
      method: "POST",
      headers: { ...auth(share), "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
      body: JSON.stringify({ question: "who" }),
    });
    assert.equal(res.status, 200);
    const [request] = store.listShareRequests({ shareId: share.id, limit: 1 });
    assert.equal(request?.remote, "5.6.7.8");
  });
});

describe("forks, streaming, files and GET access", () => {
  it("persists a fork per asker and records who asked", async () => {
    const share = makeShare({ label: "Team" });
    const askHeaders = { ...auth(share), "x-asker": "Will" };
    const first = await fetch(url(share, "/ask"), { method: "POST", headers: askHeaders, body: JSON.stringify({ question: "one" }) });
    assert.equal(first.status, 200);
    const firstJson = (await first.json()) as { asker: string; requestId: string };
    assert.equal(firstJson.asker, "Will");
    const one = readCapture() as Capture & { pid: number; turns: number };
    const second = await fetch(url(share, "/ask"), { method: "POST", headers: askHeaders, body: JSON.stringify({ question: "two", asker: "Will" }) });
    assert.equal(second.status, 200);
    const two = readCapture() as Capture & { pid: number; turns: number };
    assert.equal(two.pid, one.pid);
    assert.equal(two.turns, 2);
    const requests = store.listShareRequests({ shareId: share.id });
    assert.equal(requests[0]?.asker, "Will");
    assert.ok(requests[0]?.forkSessionId);
    assert.equal(requests[0]?.forkSessionId, requests[1]?.forkSessionId);
    const fork = store.getShareFork(share.id, "Will");
    assert.equal(fork?.questions, 2);
    const other = await fetch(url(share, "/ask"), { method: "POST", headers: { ...auth(share), "x-asker": "Ana" }, body: JSON.stringify({ question: "three" }) });
    assert.equal(other.status, 200);
    const three = readCapture() as Capture & { pid: number; turns: number };
    assert.notEqual(three.pid, one.pid);
    assert.equal(store.listShareForks(share.id).length, 2);
  });

  it("streams the answer as server-sent events", async () => {
    const share = makeShare();
    const res = await fetch(url(share, "/ask"), { method: "POST", headers: { ...auth(share), accept: "text/event-stream" }, body: JSON.stringify({ question: "stream me" }) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await res.text();
    assert.match(body, /event: start/);
    assert.match(body, /event: delta/);
    assert.match(body, /event: done/);
    const frames = body.split("\n\n").map((frame) => frame.split("\n"));
    const deltas = frames.filter((frame) => frame[0] === "event: delta").map((frame) => (JSON.parse(frame[1]!.replace(/^data: /, "")) as { text: string }).text);
    assert.equal(deltas.join(""), "handled: stream me");
    const done = frames.find((frame) => frame[0] === "event: done");
    const final = JSON.parse(done![1]!.replace(/^data: /, "")) as { status: string; answer: string };
    assert.equal(final.status, "completed");
    assert.equal(final.answer, "handled: stream me");
  });

  it("answers GET-only clients in plain text and serves an OpenAPI schema", async () => {
    const share = makeShare();
    const res = await fetch(`${url(share, "/ask")}?key=${share.key}&asker=Murilo&q=${encodeURIComponent("plain question")}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
    assert.equal((await res.text()).trim(), "handled: plain question");
    assert.equal(store.listShareRequests({ shareId: share.id })[0]?.asker, "Murilo");
    const spec = await fetch(`${url(share, "/openapi.json")}?key=${share.key}`);
    assert.equal(spec.status, 200);
    const json = (await spec.json()) as { openapi: string; paths: Record<string, unknown>; servers: { url: string }[] };
    assert.equal(json.openapi, "3.1.0");
    assert.ok("/ask" in json.paths && "/upload" in json.paths);
    assert.equal(json.servers[0]?.url, url(share));
  });

  it("accepts uploads, lists and serves files, and refuses bad names", async () => {
    const share = makeShare();
    const raw = await fetch(`${url(share, "/upload")}?name=spec.md`, { method: "POST", headers: { ...auth(share), "content-type": "application/octet-stream" }, body: "# spec\nhello" });
    assert.equal(raw.status, 201);
    const json = await fetch(url(share, "/upload"), { method: "POST", headers: auth(share), body: JSON.stringify({ name: "shot.png", contentBase64: Buffer.from("png").toString("base64") }) });
    assert.equal(json.status, 201);
    const bad = await fetch(url(share, "/upload"), { method: "POST", headers: auth(share), body: JSON.stringify({ name: "../.env", contentBase64: "eA==" }) });
    assert.equal(bad.status, 400);
    const list = (await (await fetch(url(share, "/files"), { headers: auth(share) })).json()) as { name: string; direction: string; url: string }[];
    assert.deepEqual(list.map((item) => item.name).sort(), ["shot.png", "spec.md"]);
    assert.equal(list[0]?.direction, "in");
    const download = await fetch(url(share, "/files/spec.md"), { headers: auth(share) });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "# spec\nhello");
    assert.equal((await fetch(url(share, "/files/missing.md"), { headers: auth(share) })).status, 404);
    const mcp = await post(share, "/mcp", { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "file", arguments: { name: "spec.md" } } });
    assert.equal((mcp.json.result as { structuredContent: { content: string } }).structuredContent.content, "# spec\nhello");
  });
});

describe("implementing through a share", () => {
  it("delegates a plan-only task at low trust", async () => {
    const low = makeShare({ trust: "low" });
    const created = await post(low, "/implement", { prompt: "add a flag" });
    assert.equal(created.status, 201);
    await waitFor(async () => (store.hasRunningImplement(low.id) ? null : true), 15000);
    const capture = readCapture();
    assert.equal(flagValue(capture.argv, "--permission-mode"), "plan");
    assert.ok(capture.argv.includes("--restricted"));
    assert.deepEqual(listAfter(capture.argv, "--tools"), ["Read", "Grep", "Glob", "LS"]);
    assert.match(flagValue(capture.argv, "--append-system-prompt") ?? "", /Low trust: do not edit anything/);
    const listed = await fetch(url(low, "/tasks"), { headers: auth(low) });
    const tasks = (await listed.json()) as { taskId: string; status: string }[];
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.taskId, String(created.json.taskId));
    const askOnly = makeShare({ trust: "low", label: "other" });
    assert.equal(((await (await fetch(url(askOnly, "/tasks"), { headers: auth(askOnly) })).json()) as unknown[]).length, 0);
  });

  it("gives high trust a shell without destructive commands and total trust everything", async () => {
    const high = makeShare({ trust: "high" });
    assert.equal((await post(high, "/implement", { prompt: "run the tests" })).status, 201);
    await waitFor(async () => (store.hasRunningImplement(high.id) ? null : true), 15000);
    const highCapture = readCapture();
    assert.equal(flagValue(highCapture.argv, "--permission-mode"), "acceptEdits");
    assert.ok(highCapture.argv.includes("--restricted"));
    assert.ok(listAfter(highCapture.argv, "--tools").includes("Bash"));
    assert.ok(listAfter(highCapture.argv, "--tools").includes("Edit"));
    assert.deepEqual(listAfter(highCapture.argv, "--allowedTools"), ["Bash"]);
    assert.equal((highCapture.env as { HUB_GUARD_SHELL?: string | null }).HUB_GUARD_SHELL, "1");
    assert.match(flagValue(highCapture.argv, "--settings") ?? "", /guard\.mjs/);
    assert.ok(listAfter(highCapture.argv, "--disallowedTools").includes("Bash(git push:*)"));
    assert.ok(listAfter(highCapture.argv, "--disallowedTools").includes("Read(**/.env)"));
    assert.match(flagValue(highCapture.argv, "--append-system-prompt") ?? "", /You may run tests and builds/);
    const total = makeShare({ trust: "total" });
    assert.equal((await post(total, "/implement", { prompt: "anything" })).status, 201);
    await waitFor(async () => (store.hasRunningImplement(total.id) ? null : true), 15000);
    const totalCapture = readCapture();
    assert.equal(flagValue(totalCapture.argv, "--permission-mode"), "bypassPermissions");
    assert.ok(!totalCapture.argv.includes("--restricted"));
    assert.ok(!totalCapture.argv.includes("--strict-mcp-config"));
    assert.ok(!totalCapture.argv.includes("--disallowedTools"));
    assert.ok(!totalCapture.argv.includes("--settings"));
    assert.equal((await post(total, "/ask", { question: "free question" })).status, 200);
    const totalAsk = readCapture();
    assert.equal(flagValue(totalAsk.argv, "--permission-mode"), "bypassPermissions");
    assert.ok(!totalAsk.argv.includes("--tools"));
  });

  it("delegates a guarded editing task at medium trust", async () => {
    const share = makeShare({ trust: "medium", label: "Will (impl)" });
    const created = await post(share, "/implement", { prompt: "add a flag", title: "flag" });
    assert.equal(created.status, 201);
    const taskId = String(created.json.taskId);
    const finished = await waitFor(async () => {
      const res = await fetch(url(share, `/tasks/${taskId}`), { headers: auth(share) });
      const view = (await res.json()) as { status: string; result: string | null };
      return view.status === "completed" ? view : null;
    }, 10000);
    assert.equal(finished.result, "handled: add a flag");
    const capture = readCapture();
    assert.equal(flagValue(capture.argv, "--permission-mode"), "acceptEdits");
    assert.ok(capture.argv.includes("--restricted"));
    assert.ok(capture.argv.includes("--strict-mcp-config"));
    assert.ok(listAfter(capture.argv, "--disallowedTools").includes("Read(**/.env)"));
    assert.match(flagValue(capture.argv, "--append-system-prompt") ?? "", /requested by an external collaborator \("Will \(impl\)/);
    assert.match(flagValue(capture.argv, "--append-system-prompt") ?? "", /share-artifacts/);
    const busy = makeShare({ trust: "medium" });
    assert.equal((await post(busy, "/implement", { prompt: "sleep:1500" })).status, 201);
    assert.equal((await post(busy, "/implement", { prompt: "second" })).status, 409);
    await waitFor(async () => (store.hasRunningImplement(busy.id) ? null : true), 15000);
    const { getTask } = await import("../src/delegation-store.js");
    assert.equal(getTask(taskId)?.createdBy, `share:${share.id}:Will (impl) · Will (impl)`);
    const other = makeShare({ trust: "medium", label: "someone else" });
    assert.equal((await fetch(url(other, `/tasks/${taskId}`), { headers: auth(other) })).status, 404);
    const requests = store.listShareRequests({ shareId: share.id });
    assert.equal(requests[0]?.kind, "implement");
    assert.equal(requests[0]?.status, "completed");
  });
});

describe("MCP over HTTP", () => {
  const rpc = async (share: ShareRecord, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => post(share, "/mcp", body);

  it("initializes, lists scoped tools and answers tool calls", async () => {
    const share = makeShare();
    const init = await rpc(share, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    assert.equal(init.status, 200);
    const initResult = init.json.result as { protocolVersion: string; serverInfo: { name: string } };
    assert.equal(initResult.protocolVersion, "2025-03-26");
    assert.equal(initResult.serverInfo.name, "vbss-cchub-share");
    assert.equal((await rpc(share, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const list = await rpc(share, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = ((list.json.result as { tools: { name: string }[] }).tools).map((tool) => tool.name);
    assert.deepEqual(names, ["ask", "request_status", "implement", "task_status", "tasks", "files", "file", "upload", "about"]);
    const call = await rpc(share, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask", arguments: { question: "what runs here" } } });
    const result = call.json.result as { content: { text: string }[]; isError?: boolean; structuredContent: { answer: string } };
    assert.equal(result.structuredContent.answer, "handled: what runs here");
    assert.ok(result.content[0]?.text.includes("handled: what runs here"));
    const about = await rpc(share, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "about", arguments: {} } });
    assert.equal((about.json.result as { structuredContent: { trust: string } }).structuredContent.trust, "low");
    const unknown = await rpc(share, { jsonrpc: "2.0", id: 5, method: "resources/list" });
    assert.equal((unknown.json.error as { code: number }).code, -32601);
    assert.equal((await fetch(url(share, "/mcp"), { headers: auth(share) })).status, 405);
  });

  it("describes the trust level in the tool descriptions", async () => {
    const share = makeShare({ trust: "high" });
    const list = await rpc(share, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const implement = ((list.json.result as { tools: { name: string; description: string }[] }).tools).find((tool) => tool.name === "implement");
    assert.match(implement?.description ?? "", /edits and runs commands/);
  });
});

after(async () => {
  const { killAllRunners } = await import("../src/share-runner.js");
  killAllRunners("test over");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

void join;
