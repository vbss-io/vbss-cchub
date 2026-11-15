import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { AGENT_TAIL_LIMIT, LAST_MESSAGE_PREVIEW, createTurnCounter, parseLiveQuery, summarizeAgent, type FileStamp } from "../src/live-summary.js";
import { fixtures, makeSandbox, startServer, type RunningServer } from "./helpers.js";

const box = makeSandbox("cch-live-");
let hub: RunningServer;

const AGENTS = 40;
const SESSION = "live-big";
const longMessage = "x".repeat(LAST_MESSAGE_PREVIEW * 3);

interface Fetched {
  status: number;
  text: string;
  json: unknown;
}

async function get(path: string): Promise<Fetched> {
  const res = await fetch(`${hub.base}${path}`);
  const text = await res.text();
  return { status: res.status, text, json: text.length > 0 ? JSON.parse(text) : null };
}

async function hook(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${hub.base}/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
}

interface AgentShape {
  agentId: string;
  status: string;
  lastMessage: string | null;
  transcript?: { text: string }[];
  turns?: number;
  lastMessageTruncated?: boolean;
}

interface LiveShape {
  session: { sessionId: string };
  transcript: { text: string }[];
  agents: AgentShape[];
  agentCounts?: { total: number; running: number };
}

before(async () => {
  hub = await startServer(box, {});
  const dir = join(box.tmp, "transcripts");
  const subDir = join(dir, SESSION, "subagents");
  mkdirSync(subDir, { recursive: true });
  copyFileSync(join(fixtures, "transcript-sample.jsonl"), join(dir, `${SESSION}.jsonl`));
  const sample = join(fixtures, "agent-sample.jsonl");
  for (let index = 0; index < AGENTS; index += 1) copyFileSync(sample, join(subDir, `agent-a${index}.jsonl`));
  writeFileSync(join(subDir, "agent-silent.jsonl"), "");
  await hook({ kind: "session_start", sessionId: SESSION, cwd: box.repoA, client: "terminal", transcriptPath: join(dir, `${SESSION}.jsonl`) });
  for (let index = 0; index < AGENTS; index += 1) {
    await hook({ kind: "subagent_start", sessionId: SESSION, agentId: `a${index}`, agentType: "Explore", agentMessage: longMessage });
    if (index % 4 !== 0) await hook({ kind: "subagent_stop", sessionId: SESSION, agentId: `a${index}`, agentType: "Explore", agentMessage: `done ${index}` });
  }
  await hook({ kind: "subagent_start", sessionId: SESSION, agentId: "silent", agentType: "Plan" });
  await hook({ kind: "subagent_stop", sessionId: SESSION, agentId: "silent", agentType: "Plan" });
});

describe("live query parsing", () => {
  it("defaults to the full payload and ignores unknown values", () => {
    assert.deepEqual(parseLiveQuery({}), { mode: "full" });
    assert.deepEqual(parseLiveQuery({ subagents: "all" }), { mode: "full" });
    assert.deepEqual(parseLiveQuery({ subagents: ["summary", "summary"] }), { mode: "full" });
    assert.deepEqual(parseLiveQuery({ limit: "40", foo: "bar" }), { mode: "full" });
    assert.deepEqual(parseLiveQuery({ subagent: "  " }), { mode: "full" });
  });

  it("selects the summary and the single subagent modes", () => {
    assert.deepEqual(parseLiveQuery({ subagents: "summary" }), { mode: "summary" });
    assert.deepEqual(parseLiveQuery({ subagent: "a1" }), { mode: "agent", agentId: "a1" });
    assert.deepEqual(parseLiveQuery({ subagent: "a1", subagents: "summary" }), { mode: "agent", agentId: "a1" });
  });

  it("summarizes an agent without its turns and truncates the last message", () => {
    const base = { agentId: "a", sessionId: "s", agentType: "Explore", status: "ended" as const, transcriptPath: null, startedAt: 1, updatedAt: 2 };
    const entry = { at: 1, role: "assistant" as const, text: "hi", tool: null };
    const long = summarizeAgent({ ...base, lastMessage: longMessage, transcript: [entry, entry] });
    assert.equal("transcript" in long, false);
    assert.equal(long.turns, 2);
    assert.equal(long.lastMessageTruncated, true);
    assert.equal(long.lastMessage?.length, LAST_MESSAGE_PREVIEW + 1);
    assert.ok(long.lastMessage?.endsWith("…"));
    const short = summarizeAgent({ ...base, lastMessage: "short", transcript: [] });
    assert.deepEqual(short, { ...base, lastMessage: "short", turns: 0, lastMessageTruncated: false });
    assert.equal(summarizeAgent({ ...base, lastMessage: null, transcript: [] }).lastMessage, null);
  });
});

describe("agent turn counter", () => {
  const harness = (capacity: number) => {
    const stamps = new Map<string, FileStamp>();
    const reads: string[] = [];
    const counter = createTurnCounter({
      capacity,
      stamp: async (path) => stamps.get(path) ?? null,
      count: async (path) => {
        reads.push(path);
        return stamps.get(path)?.size ?? 0;
      },
    });
    return { stamps, reads, counter };
  };

  it("does not re-read a file whose mtime and size are unchanged", async () => {
    const { stamps, reads, counter } = harness(10);
    stamps.set("a", { mtimeMs: 1, size: 3 });
    assert.equal(await counter("a"), 3);
    assert.equal(await counter("a"), 3);
    assert.equal(await counter("a"), 3);
    assert.deepEqual(reads, ["a"]);
  });

  it("re-reads when the mtime or the size changes", async () => {
    const { stamps, reads, counter } = harness(10);
    stamps.set("a", { mtimeMs: 1, size: 3 });
    assert.equal(await counter("a"), 3);
    stamps.set("a", { mtimeMs: 2, size: 3 });
    assert.equal(await counter("a"), 3);
    stamps.set("a", { mtimeMs: 2, size: 5 });
    assert.equal(await counter("a"), 5);
    assert.deepEqual(reads, ["a", "a", "a"]);
  });

  it("returns zero without reading when there is no path and reads uncached when the file cannot be stamped", async () => {
    const { reads, counter } = harness(10);
    assert.equal(await counter(null), 0);
    assert.equal(await counter("missing"), 0);
    assert.equal(await counter("missing"), 0);
    assert.deepEqual(reads, ["missing", "missing"]);
  });

  it("evicts the least recently used entry beyond its capacity", async () => {
    const { stamps, reads, counter } = harness(2);
    for (const name of ["a", "b", "c"]) stamps.set(name, { mtimeMs: 1, size: 1 });
    await counter("a");
    await counter("b");
    await counter("a");
    await counter("c");
    assert.deepEqual(reads, ["a", "b", "c"]);
    await counter("a");
    assert.deepEqual(reads, ["a", "b", "c"]);
    await counter("b");
    assert.deepEqual(reads, ["a", "b", "c", "b"]);
  });

  it("caps the tail at the agent tail limit used by the live reader", () => {
    assert.equal(AGENT_TAIL_LIMIT, 12);
  });
});

describe("session live route", () => {
  it("keeps the default payload unchanged and ignores unknown params", async () => {
    const plain = await get(`/api/sessions/${SESSION}/live`);
    assert.equal(plain.status, 200);
    const live = plain.json as LiveShape;
    assert.deepEqual(Object.keys(live), ["session", "transcript", "agents"]);
    assert.equal(live.transcript.length, 5);
    assert.equal(live.agents.length, AGENTS + 1);
    const first = live.agents.find((agent) => agent.agentId === "a0");
    assert.deepEqual(Object.keys(first ?? {}).sort(), ["agentId", "agentType", "lastMessage", "sessionId", "startedAt", "status", "transcript", "transcriptPath", "updatedAt"]);
    assert.equal(first?.lastMessage, longMessage);
    assert.equal(first?.transcript?.[2]?.text, "8");
    for (const suffix of ["?limit=40", "?subagents=all", "?foo=bar", "?subagent="]) {
      const other = await get(`/api/sessions/${SESSION}/live${suffix}`);
      assert.equal(other.text, plain.text, suffix);
    }
  });

  it("serves subagent summaries without turns in a much smaller payload", async () => {
    const full = await get(`/api/sessions/${SESSION}/live`);
    const summary = await get(`/api/sessions/${SESSION}/live?subagents=summary`);
    assert.equal(summary.status, 200);
    const live = summary.json as LiveShape;
    const fullLive = full.json as LiveShape;
    assert.deepEqual(live.session, fullLive.session);
    assert.deepEqual(live.transcript, fullLive.transcript);
    assert.equal(live.agents.length, AGENTS + 1);
    assert.equal(live.agents.every((agent) => !("transcript" in agent)), true);
    assert.deepEqual(live.agentCounts, { total: AGENTS + 1, running: AGENTS / 4 });
    const running = live.agents.find((agent) => agent.agentId === "a0");
    assert.equal(running?.status, "running");
    assert.equal(running?.turns, 3);
    assert.equal(running?.lastMessageTruncated, true);
    assert.equal(running?.lastMessage?.length, LAST_MESSAGE_PREVIEW + 1);
    const silent = live.agents.find((agent) => agent.agentId === "silent");
    assert.equal(silent?.turns, 0);
    const perAgent = (summary.text.length - JSON.stringify({ session: live.session, transcript: live.transcript }).length) / live.agents.length;
    assert.ok(perAgent < LAST_MESSAGE_PREVIEW + 400, `per agent ${perAgent}`);
    assert.ok(summary.text.length * 1.5 < full.text.length, `summary ${summary.text.length} vs full ${full.text.length}`);
  });

  it("fetches one subagent with its turns on demand", async () => {
    const one = await get(`/api/sessions/${SESSION}/live?subagent=a0`);
    assert.equal(one.status, 200);
    const body = one.json as { agent: AgentShape };
    assert.deepEqual(Object.keys(body), ["agent"]);
    assert.equal(body.agent.agentId, "a0");
    assert.equal(body.agent.lastMessage, longMessage);
    assert.equal(body.agent.transcript?.length, 3);
    assert.equal(body.agent.transcript?.[2]?.text, "8");
    const missingAgent = await get(`/api/sessions/${SESSION}/live?subagent=ghost`);
    assert.equal(missingAgent.status, 404);
    assert.deepEqual(missingAgent.json, { error: "subagent not found" });
    const missingSession = await get("/api/sessions/nope/live?subagent=a0");
    assert.equal(missingSession.status, 404);
    assert.deepEqual(missingSession.json, { error: "session not found" });
    assert.equal((await get("/api/sessions/nope/live?subagents=summary")).status, 404);
  });
});

describe("session live summary cache", () => {
  const assistantLine = (text: string): string =>
    `${JSON.stringify({ isSidechain: true, agentId: "a1", type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, timestamp: "2026-09-05T10:00:09.000Z" })}
`;
  const agentFile = join(box.tmp, "transcripts", SESSION, "subagents", "agent-a1.jsonl");
  const turnsOf = async (agentId: string): Promise<number | undefined> => {
    const live = (await get(`/api/sessions/${SESSION}/live?subagents=summary`)).json as LiveShape;
    return live.agents.find((agent) => agent.agentId === agentId)?.turns;
  };

  it("serves identical summaries while the files are unchanged and refreshes a changed file", async () => {
    const first = await get(`/api/sessions/${SESSION}/live?subagents=summary`);
    const second = await get(`/api/sessions/${SESSION}/live?subagents=summary`);
    assert.equal(second.text, first.text);
    assert.equal(await turnsOf("a1"), 3);
    appendFileSync(agentFile, assistantLine("more"));
    assert.equal(await turnsOf("a1"), 4);
    assert.equal(await turnsOf("a2"), 3);
    const full = (await get(`/api/sessions/${SESSION}/live`)).json as LiveShape;
    assert.equal(full.agents.find((agent) => agent.agentId === "a1")?.transcript?.length, 4);
  });

  it("caps the reported turns at the tail limit", async () => {
    for (let index = 0; index < AGENT_TAIL_LIMIT + 3; index += 1) appendFileSync(agentFile, assistantLine(`extra ${index}`));
    assert.equal(await turnsOf("a1"), AGENT_TAIL_LIMIT);
  });
});

after(async () => {
  await new Promise<void>((resolve) => {
    if (hub.child.exitCode != null || hub.child.signalCode != null) {
      resolve();
      return;
    }
    hub.child.once("exit", () => resolve());
    hub.child.kill();
  });
  await new Promise((r) => setTimeout(r, 300));
  try {
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  } catch {
    void 0;
  }
});
