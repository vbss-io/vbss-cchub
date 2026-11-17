import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { s2InitRepo, s2Sandbox, s2Until } from "./helpers/s2-env.js";
import type { ShareRecord } from "../src/share-types.js";

const box = s2Sandbox("cch-s2-share-server-", { HUB_DELEGATION: "1", HUB_PORT: "4396", HUB_SHARE_SYNC_WAIT_MS: "1500" });

const { db } = await import("../src/db.js");
const store = await import("../src/share-store.js");
const { updateSettings } = await import("../src/delegation-store.js");
const { createShareApp } = await import("../src/share-server.js");
const { artifactDirs } = await import("../src/share-service.js");
const { abortActiveRuns } = await import("../src/delegation-launch.js");
const { killAllRunners } = await import("../src/share-runner.js");

let server: Server;
let base = "";

before(async () => {
  s2InitRepo(box.repoA);
  updateSettings({ workspacesRoot: box.root });
  server = createShareApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  abortActiveRuns("test over");
  await new Promise((resolve) => setTimeout(resolve, 300));
  killAllRunners("test over");
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (db.open) db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const makeShare = (overrides: Partial<Parameters<typeof store.createShare>[0]> = {}): ShareRecord =>
  store.createShare({ label: "Will", workspace: "pilot", repo: null, sessionId: null, trust: "medium", note: null, model: null, maxPerHour: 60, expiresAt: null, ...overrides });

const url = (share: ShareRecord, path = ""): string => `${base}/share/${share.id}${path}`;
const headers = (share: ShareRecord, extra: Record<string, string> = {}): Record<string, string> => ({ authorization: `Bearer ${share.key}`, "content-type": "application/json", ...extra });

async function call(share: ShareRecord, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  const res = await fetch(url(share, path), { method, headers: headers(share, extra), body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

interface ToolOutcome {
  isError?: boolean;
  content: { text: string }[];
  structuredContent?: unknown;
}

async function tool(share: ShareRecord, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const res = await call(share, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return (res.json as { result: ToolOutcome }).result;
}

describe("share MCP endpoint", () => {
  it("negotiates, lists tools, answers ping and ignores notifications", async () => {
    const share = makeShare();
    const init = await call(share, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    assert.equal((init.json as { result: { protocolVersion: string } }).result.protocolVersion, "2025-03-26");
    const fallback = await call(share, "POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999" } });
    assert.equal((fallback.json as { result: { protocolVersion: string } }).result.protocolVersion, "2025-06-18");
    const noParams = await call(share, "POST", "/mcp", { jsonrpc: "2.0", id: 3, method: "initialize" });
    assert.equal(noParams.status, 200);
    const tools = await call(share, "POST", "/mcp", { jsonrpc: "2.0", id: 4, method: "tools/list" });
    assert.equal((tools.json as { result: { tools: unknown[] } }).result.tools.length, 9);
    assert.deepEqual((await call(share, "POST", "/mcp", { jsonrpc: "2.0", id: 5, method: "ping" })).json, { jsonrpc: "2.0", id: 5, result: {} });
    assert.equal((await call(share, "POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const unknown = await call(share, "POST", "/mcp", { jsonrpc: "2.0", id: 6, method: "sampling/create" });
    assert.equal((unknown.json as { error: { code: number } }).error.code, -32601);
    const noMethod = await call(share, "POST", "/mcp", { jsonrpc: "2.0", id: 7 });
    assert.match((noMethod.json as { error: { message: string } }).error.message, /method not found: \?/);
    const noName = await call(share, "POST", "/mcp", { jsonrpc: "2.0", id: 8, method: "tools/call", params: {} });
    assert.equal((noName.json as { error: { code: number } }).error.code, -32602);
    const empty = await call(share, "POST", "/mcp", "{}");
    assert.equal((empty.json as { error: { code: number } }).error.code, -32601);
    assert.equal((await call(share, "GET", "/mcp")).status, 405);
    assert.equal((await call(share, "DELETE", "/mcp")).status, 204);
  });

  it("handles batches, answering only the messages that expect a reply", async () => {
    const share = makeShare();
    const mixed = await call(share, "POST", "/mcp", [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/cancelled" }]);
    assert.equal(mixed.status, 200);
    assert.equal((mixed.json as unknown as unknown[]).length, 1);
    const onlyNotes = await call(share, "POST", "/mcp", [{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    assert.equal(onlyNotes.status, 202);
  });

  it("explains missing arguments to each tool and unknown tools", async () => {
    const share = makeShare();
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["ask", {}, /question required/],
      ["request_status", {}, /requestId required/],
      ["implement", {}, /prompt required/],
      ["task_status", {}, /taskId required/],
      ["file", {}, /name required/],
      ["upload", { name: "a.txt" }, /name and contentBase64 required/],
      ["upload", { contentBase64: "AAAA" }, /name and contentBase64 required/],
      ["nonsense", {}, /unknown tool "nonsense"/],
      ["request_status", { requestId: "ghost" }, /not found|request/i],
      ["task_status", { taskId: "ghost" }, /not found|task/i],
      ["file", { name: "ghost.txt" }, /file not found/],
    ];
    for (const [name, args, message] of cases) {
      const result = await tool(share, name, args);
      assert.equal(result.isError, true, name);
      assert.match(result.content[0]?.text ?? "", message, name);
    }
  });

  it("describes the share, lists tasks and files and serves text, binary and large files", async () => {
    const share = makeShare({ label: "Files share" });
    const about = await tool(share, "about");
    assert.equal(about.isError, undefined);
    const dirs = artifactDirs(share);
    mkdirSync(dirs.inbox, { recursive: true });
    writeFileSync(join(dirs.root, "notes.md"), "plain notes");
    writeFileSync(join(dirs.root, "image.png"), Buffer.from([1, 2, 3]));
    writeFileSync(join(dirs.inbox, "huge.txt"), "x".repeat(300_000));
    const files = (await tool(share, "files")).structuredContent as { name: string; url: string }[];
    assert.deepEqual(files.map((item) => item.name).sort(), ["huge.txt", "image.png", "notes.md"]);
    assert.ok(files.every((item) => item.url.includes(`/share/${share.id}/files/`)));
    const text = (await tool(share, "file", { name: "notes.md" })).structuredContent as { content: string };
    assert.equal(text.content, "plain notes");
    const binary = (await tool(share, "file", { name: "image.png" })).structuredContent as { note: string };
    assert.match(binary.note, /binary file/);
    const large = (await tool(share, "file", { name: "huge.txt" })).structuredContent as { note: string; preview: string };
    assert.match(large.note, /large file/);
    assert.equal(large.preview.length, 200_000);
    const tasks = (await tool(share, "tasks", { limit: "nope" })).structuredContent as unknown[];
    assert.ok(Array.isArray(tasks));
    assert.ok(Array.isArray((await tool(share, "tasks")).structuredContent));
    const uploaded = (await tool(share, "upload", { name: "sent.txt", contentBase64: Buffer.from("hello").toString("base64") })).structuredContent as { name: string; size: number };
    assert.deepEqual([uploaded.name, uploaded.size], ["sent.txt", 5]);
  });

  it("delegates an implementation and reports its task", async () => {
    const share = makeShare({ label: "Implementer", trust: "high" });
    const started = (await tool(share, "implement", { prompt: "implement something small", title: "Small thing", asker: "Ann" })).structuredContent as { taskId: string; status: string };
    assert.equal(started.status, "running");
    const status = await s2Until(async () => {
      const result = (await tool(share, "task_status", { taskId: started.taskId })).structuredContent as { status: string };
      return result.status !== "running" && result.status !== "pending" ? result : null;
    }, 20_000);
    assert.equal(status.status, "completed");
    const listed = (await tool(share, "tasks")).structuredContent as { taskId: string }[];
    assert.ok(listed.some((item) => item.taskId === started.taskId));
  });

  it("answers a question synchronously and reports a slow one as still running", async () => {
    const share = makeShare({ label: "Asker", trust: "low" });
    const quick = (await tool(share, "ask", { question: "hello there", asker: "Bea" })).structuredContent as { status: string; answer?: string };
    assert.equal(quick.status, "completed");
    assert.match(quick.answer ?? "", /hello there/);
    const slow = (await tool(share, "ask", { question: "sleep:4000", asker: "Cy" })).structuredContent as { status: string; requestId: string; hint?: string };
    assert.equal(slow.status, "running");
    assert.match(slow.hint ?? "", /request_status/);
    const later = await s2Until(async () => {
      const view = (await tool(share, "request_status", { requestId: slow.requestId })).structuredContent as { status: string };
      return view.status === "completed" ? view : null;
    }, 20_000);
    assert.equal(later.status, "completed");
  });
});

describe("share HTTP routes", () => {
  it("answers the plain-text ask endpoint for every outcome", async () => {
    const share = makeShare({ label: "Plain" });
    assert.equal((await call(share, "GET", "/ask")).status, 400);
    const quick = await call(share, "GET", `/ask?q=${encodeURIComponent("what now")}`);
    assert.equal(quick.status, 200);
    assert.match(quick.text, /what now/);
    const alias = await call(share, "GET", `/ask?question=${encodeURIComponent("via alias")}`);
    assert.match(alias.text, /via alias/);
    const slow = await call(share, "GET", `/ask?q=${encodeURIComponent("sleep:4000")}`);
    assert.equal(slow.status, 202);
    assert.match(slow.text, /Still answering\. Poll: /);
  });

  it("answers the JSON ask endpoint, with a prompt alias, a missing question and an event stream", async () => {
    const share = makeShare({ label: "Json" });
    assert.equal((await call(share, "POST", "/ask", {})).status, 400);
    const prompt = await call(share, "POST", "/ask", { prompt: "via prompt", asker: "Dee" });
    assert.equal(prompt.status, 200);
    assert.match(String((prompt.json as { answer: string }).answer), /via prompt/);
    const stream = await fetch(url(share, "/ask?stream=1"), { method: "POST", headers: headers(share), body: JSON.stringify({ question: "stream this" }) });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await stream.text();
    assert.match(text, /event: start/);
    assert.match(text, /event: done/);
    const accept = await fetch(url(share, "/ask"), { method: "POST", headers: headers(share, { accept: "text/event-stream" }), body: JSON.stringify({ question: "accept stream" }) });
    assert.match(await accept.text(), /event: done/);
  });

  it("streams an existing finished question and refuses to stream other requests", async () => {
    const share = makeShare({ label: "Stream" });
    const asked = await call(share, "POST", "/ask", { question: "to replay" });
    const requestId = String((asked.json as { id?: string; requestId?: string }).id ?? (asked.json as { requestId?: string }).requestId);
    const replay = await fetch(url(share, `/requests/${requestId}/stream`), { headers: headers(share) });
    assert.equal(replay.status, 200);
    assert.match(await replay.text(), /event: done/);
    assert.equal((await call(share, "GET", `/requests/${requestId}`)).status, 200);
    assert.equal((await call(share, "GET", "/requests/ghost")).status, 404);
    const implemented = await call(share, "POST", "/implement", { prompt: "small change", title: "T", asker: "Eve" });
    assert.equal(implemented.status, 201, implemented.text);
    const implementId = String((implemented.json as { requestId: string }).requestId);
    const refused = await call(share, "GET", `/requests/${implementId}/stream`);
    assert.equal(refused.status, 409);
    assert.equal((await call(share, "POST", "/implement", {})).status, 400);
    const taskId = String((implemented.json as { taskId: string }).taskId);
    assert.equal((await call(share, "GET", `/tasks/${taskId}`)).status, 200);
    assert.equal((await call(share, "GET", "/tasks?limit=abc")).status, 200);
    assert.equal((await call(share, "GET", "/tasks")).status, 200);
    await s2Until(async () => {
      const view = (await call(share, "GET", `/tasks/${taskId}`)).json as { status: string };
      return view.status !== "running" && view.status !== "pending" ? true : null;
    }, 20_000);
  });

  it("serves, uploads and lists files with the right types", async () => {
    const share = makeShare({ label: "Transfer" });
    const dirs = artifactDirs(share);
    mkdirSync(dirs.root, { recursive: true });
    const samples: [string, string][] = [["a.md", "text/markdown"], ["a.txt", "text/plain"], ["a.json", "application/json"], ["a.csv", "text/csv"], ["a.html", "text/html"], ["a.png", "image/png"], ["a.jpg", "image/jpeg"], ["a.jpeg", "image/jpeg"], ["a.gif", "image/gif"], ["a.pdf", "application/pdf"], ["a.zip", "application/zip"], ["a.bin", "application/octet-stream"]];
    for (const [name] of samples) writeFileSync(join(dirs.root, name), "content");
    for (const [name, type] of samples) {
      const res = await fetch(url(share, `/files/${name}`), { headers: headers(share) });
      assert.equal(res.status, 200, name);
      assert.ok((res.headers.get("content-type") ?? "").startsWith(type), `${name}: ${res.headers.get("content-type")}`);
    }
    const listing = await call(share, "GET", "/files");
    assert.equal((listing.json as unknown as unknown[]).length, samples.length);
    const raw = await fetch(url(share, "/upload?name=raw.bin"), { method: "POST", headers: { authorization: `Bearer ${share.key}`, "content-type": "application/octet-stream" }, body: Buffer.from([9, 8, 7]) });
    assert.equal(raw.status, 201);
    const named = await fetch(url(share, "/upload"), { method: "POST", headers: { authorization: `Bearer ${share.key}`, "content-type": "application/octet-stream", "x-file-name": "header.bin" }, body: Buffer.from([1]) });
    assert.equal(named.status, 201);
    const json = await call(share, "POST", "/upload", { name: "from-json.txt", contentBase64: Buffer.from("json").toString("base64") });
    assert.equal(json.status, 201);
    assert.equal((await call(share, "POST", "/upload", { name: "x" })).status, 400);
    assert.equal((await call(share, "GET", "/files/ghost.txt")).status, 404);
  });

  it("maps failures to safe answers", async () => {
    const share = makeShare({ label: "Errors" });
    const badJson = await call(share, "POST", "/ask", "{ not json");
    assert.equal(badJson.status, 400);
    assert.equal((badJson.json as { error: string }).error, "invalid request body");
    const tooBig = await call(share, "POST", "/ask", JSON.stringify({ question: "x".repeat(300_000) }));
    assert.equal(tooBig.status, 413);
    assert.equal((tooBig.json as { error: string }).error, "body too large");
    const missing = await fetch(`${base}/nowhere`);
    assert.equal(missing.status, 404);
    const gone = makeShare({ label: "Ghost workspace", workspace: "ghost-workspace" });
    const unavailable = await call(gone, "POST", "/ask", { question: "anyone?" });
    assert.equal(unavailable.status, 409);
    assert.match(String((unavailable.json as { error: string }).error), /share target unavailable/);
    const about = await call(share, "GET", "/about");
    assert.equal(about.status, 200);
    const openapi = await call(share, "GET", "/openapi.json");
    assert.equal(openapi.status, 200);
  });
});
