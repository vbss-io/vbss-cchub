import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  aggregateUsage,
  collectUsage,
  percentile,
  resetUsageCache,
  usageScanStats,
  type UsageAggregate,
  type UsageRecord,
} from "../src/usage.js";
import { makeSandbox, startServer, type RunningServer } from "./helpers.js";

interface ClaudeUsage {
  input: number;
  cacheRead?: number;
  cacheWrite?: number;
  output: number;
  thinking?: number;
}

interface ClaudeLineOptions {
  id: string;
  model?: string;
  at: number;
  sessionId: string;
  usage: ClaudeUsage;
  sidechain?: boolean;
  cwd?: string;
}

function claudeLine(options: ClaudeLineOptions): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: options.sidechain ?? false,
    timestamp: new Date(options.at).toISOString(),
    cwd: options.cwd ?? "C:\\work\\demo",
    sessionId: options.sessionId,
    message: {
      id: options.id,
      model: options.model ?? "claude-opus-5",
      usage: {
        input_tokens: options.usage.input,
        cache_creation_input_tokens: options.usage.cacheWrite ?? 0,
        cache_read_input_tokens: options.usage.cacheRead ?? 0,
        output_tokens: options.usage.output,
        output_tokens_details: options.usage.thinking === undefined ? undefined : { thinking_tokens: options.usage.thinking },
      },
    },
  });
}

interface CodexTurnOptions {
  at: number;
  total: number;
  last: { input: number; cached: number; output: number; reasoning: number };
}

function codexLines(sessionId: string, cwd: string, model: string, startAt: number, turns: CodexTurnOptions[]): string {
  const lines: string[] = [
    JSON.stringify({ timestamp: new Date(startAt).toISOString(), type: "session_meta", payload: { id: sessionId, cwd, originator: "Codex Desktop", timestamp: new Date(startAt).toISOString() } }),
    JSON.stringify({ timestamp: new Date(startAt + 1).toISOString(), type: "turn_context", payload: { model, cwd } }),
  ];
  for (const turn of turns) {
    lines.push(
      JSON.stringify({
        timestamp: new Date(turn.at).toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { total_tokens: turn.total },
            last_token_usage: {
              input_tokens: turn.last.input,
              cached_input_tokens: turn.last.cached,
              cache_write_input_tokens: 0,
              output_tokens: turn.last.output,
              reasoning_output_tokens: turn.last.reasoning,
              total_tokens: turn.last.input + turn.last.output,
            },
          },
        },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function record(at: number, overrides: Partial<UsageRecord> & { fresh: number; cacheRead: number; cacheWrite: number; output: number }): UsageRecord {
  return {
    provider: "claude",
    at,
    model: "claude-opus-5",
    sessionId: "s1",
    project: "pa",
    cwd: null,
    thinking: 0,
    sidechain: false,
    ...overrides,
    read: overrides.fresh + overrides.cacheRead + overrides.cacheWrite,
  };
}

const tmp = mkdtempSync(join(tmpdir(), "cch-usage-"));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }));

let counter = 0;
function freshDirs(): { claudeDir: string; codexDir: string } {
  counter += 1;
  const claudeDir = join(tmp, `claude-${counter}`);
  const codexDir = join(tmp, `codex-${counter}`);
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  return { claudeDir, codexDir };
}

describe("usage parsing", () => {
  beforeEach(() => resetUsageCache());

  it("counts a Claude message once across streaming chunks and keeps the last numbers", async () => {
    const dirs = freshDirs();
    const now = Date.now();
    const lines = [
      claudeLine({ id: "m1", at: now - 5000, sessionId: "sess-a", usage: { input: 10, cacheRead: 1000, cacheWrite: 100, output: 1 } }),
      claudeLine({ id: "m1", at: now - 4900, sessionId: "sess-a", usage: { input: 10, cacheRead: 1000, cacheWrite: 100, output: 5 } }),
      claudeLine({ id: "m1", at: now - 4800, sessionId: "sess-a", usage: { input: 10, cacheRead: 1000, cacheWrite: 100, output: 9, thinking: 4 } }),
      claudeLine({ id: "m2", at: now - 3000, sessionId: "sess-a", usage: { input: 20, cacheRead: 2000, output: 8 } }),
      claudeLine({ id: "syn", model: "<synthetic>", at: now - 2000, sessionId: "sess-a", usage: { input: 0, output: 0 } }),
      JSON.stringify({ type: "user", timestamp: new Date(now).toISOString(), message: { content: "hello" } }),
    ];
    write(join(dirs.claudeDir, "proj-x", "sess-a.jsonl"), `${lines.join("\n")}\n`);
    const scan = await collectUsage({ days: 1, now, ...dirs });
    assert.equal(scan.records.length, 2);
    const first = scan.records.find((item) => item.model === "claude-opus-5" && item.output === 9);
    assert.ok(first);
    assert.equal(first.read, 1110);
    assert.equal(first.fresh, 10);
    assert.equal(first.cacheRead, 1000);
    assert.equal(first.cacheWrite, 100);
    assert.equal(first.thinking, 4);
    assert.equal(first.project, "proj-x");
    assert.equal(first.sessionId, "sess-a");
    assert.equal(first.cwd, "C:\\work\\demo");
    assert.equal(first.provider, "claude");
    assert.equal(first.sidechain, false);
  });

  it("flags subagent transcripts as sidechain and reads them from the subagents folder", async () => {
    const dirs = freshDirs();
    const now = Date.now();
    write(
      join(dirs.claudeDir, "proj-x", "sess-a", "subagents", "nested", "agent-1.jsonl"),
      `${claudeLine({ id: "s1", at: now - 1000, sessionId: "sess-a", sidechain: true, usage: { input: 5, cacheRead: 500, output: 2 } })}\n`,
    );
    write(join(dirs.claudeDir, "proj-x", "sess-a.jsonl"), `${claudeLine({ id: "p1", at: now - 900, sessionId: "sess-a", usage: { input: 5, output: 2 } })}\n`);
    const scan = await collectUsage({ days: 1, now, ...dirs });
    assert.equal(scan.records.length, 2);
    assert.equal(scan.records.filter((item) => item.sidechain).length, 1);
    assert.equal(scan.records.find((item) => item.sidechain)?.read, 505);
  });

  it("turns each Codex token_count into one turn delta and drops repeated totals", async () => {
    const dirs = freshDirs();
    const now = Date.now();
    const text = codexLines("codex-1", "C:\\Users\\vbss\\Projetos\\demo-app", "gpt-fixture", now - 60_000, [
      { at: now - 50_000, total: 1100, last: { input: 1000, cached: 600, output: 100, reasoning: 30 } },
      { at: now - 49_000, total: 1100, last: { input: 1000, cached: 600, output: 100, reasoning: 30 } },
      { at: now - 40_000, total: 2400, last: { input: 1200, cached: 1000, output: 100, reasoning: 0 } },
    ]);
    write(join(dirs.codexDir, "2026", "09", "30", "rollout-codex-1.jsonl"), `${text}${JSON.stringify({ timestamp: new Date(now).toISOString(), type: "event_msg", payload: { type: "token_count", info: null } })}\n`);
    const scan = await collectUsage({ days: 1, now, ...dirs });
    assert.equal(scan.records.length, 2);
    const [one, two] = scan.records;
    assert.ok(one && two);
    assert.equal(one.provider, "codex");
    assert.equal(one.model, "gpt-fixture");
    assert.equal(one.sessionId, "codex-1");
    assert.equal(one.project, "demo-app");
    assert.equal(one.cwd, "C:\\Users\\vbss\\Projetos\\demo-app");
    assert.equal(one.read, 1000);
    assert.equal(one.cacheRead, 600);
    assert.equal(one.fresh, 400);
    assert.equal(one.output, 100);
    assert.equal(one.thinking, 30);
    assert.equal(two.read, 1200);
    assert.equal(two.fresh, 200);
    assert.equal(one.read + two.read, 2200);
  });

  it("skips files older than the window without reading them", async () => {
    const dirs = freshDirs();
    const now = Date.now();
    const old = join(dirs.claudeDir, "proj-x", "old.jsonl");
    write(old, `${claudeLine({ id: "o1", at: now - 40 * 86_400_000, sessionId: "old", usage: { input: 5, output: 2 } })}\n`);
    const past = new Date(now - 40 * 86_400_000);
    utimesSync(old, past, past);
    write(join(dirs.claudeDir, "proj-x", "new.jsonl"), `${claudeLine({ id: "n1", at: now - 1000, sessionId: "new", usage: { input: 5, output: 2 } })}\n`);
    const before = usageScanStats().parses;
    const scan = await collectUsage({ days: 7, now, ...dirs });
    assert.equal(usageScanStats().parses - before, 1);
    assert.equal(scan.files, 1);
    assert.deepEqual(scan.records.map((item) => item.sessionId), ["new"]);
  });

  it("filters records by timestamp inside a file that is newer than the window", async () => {
    const dirs = freshDirs();
    const now = Date.now();
    write(
      join(dirs.claudeDir, "proj-x", "mixed.jsonl"),
      `${[
        claudeLine({ id: "a", at: now - 20 * 86_400_000, sessionId: "mixed", usage: { input: 5, output: 2 } }),
        claudeLine({ id: "b", at: now - 1000, sessionId: "mixed", usage: { input: 6, output: 2 } }),
      ].join("\n")}\n`,
    );
    const scan = await collectUsage({ days: 7, now, ...dirs });
    assert.equal(scan.records.length, 1);
    assert.equal(scan.records[0]?.fresh, 6);
  });

  it("answers from the cache while files are unchanged, resumes appended files and rescans after a reset", async () => {
    const dirs = freshDirs();
    const now = Date.now();
    const file = join(dirs.claudeDir, "proj-x", "live.jsonl");
    write(file, `${claudeLine({ id: "a", at: now - 3000, sessionId: "live", usage: { input: 5, output: 2 } })}\n`);
    const first = await collectUsage({ days: 1, now, ...dirs });
    assert.equal(first.parsed, 1);
    const parses = usageScanStats().parses;

    const started = performance.now();
    const second = await collectUsage({ days: 1, now, ...dirs });
    assert.ok(performance.now() - started < 50);
    assert.equal(second.parsed, 0);
    assert.equal(usageScanStats().parses, parses);
    assert.equal(second.records.length, 1);

    appendFileSync(file, `${claudeLine({ id: "a", at: now - 2900, sessionId: "live", usage: { input: 5, output: 7 } })}\n${claudeLine({ id: "b", at: now - 2000, sessionId: "live", usage: { input: 9, output: 1 } })}\n`);
    const grown = await collectUsage({ days: 1, now, ...dirs });
    assert.equal(grown.parsed, 1);
    assert.equal(usageScanStats().parses, parses + 1);
    assert.equal(grown.records.length, 2);
    assert.equal(grown.records.find((item) => item.fresh === 5)?.output, 7);

    resetUsageCache();
    assert.equal(usageScanStats().cachedFiles, 0);
    const rescanned = await collectUsage({ days: 1, now, ...dirs });
    assert.equal(rescanned.parsed, 1);
    assert.equal(rescanned.records.length, 2);
  });

  it("does not consume a half-written last line", async () => {
    const dirs = freshDirs();
    const now = Date.now();
    const file = join(dirs.claudeDir, "proj-x", "partial.jsonl");
    const complete = claudeLine({ id: "a", at: now - 3000, sessionId: "p", usage: { input: 5, output: 2 } });
    const next = claudeLine({ id: "b", at: now - 2000, sessionId: "p", usage: { input: 9, output: 1 } });
    write(file, `${complete}\n${next.slice(0, 40)}`);
    const first = await collectUsage({ days: 1, now, ...dirs });
    assert.equal(first.records.length, 1);
    appendFileSync(file, `${next.slice(40)}\n`);
    const second = await collectUsage({ days: 1, now, ...dirs });
    assert.equal(second.records.length, 2);
  });

  it("serializes concurrent scans of the same window into one promise", async () => {
    const dirs = freshDirs();
    const now = Date.now();
    write(join(dirs.claudeDir, "proj-x", "a.jsonl"), `${claudeLine({ id: "a", at: now - 1000, sessionId: "a", usage: { input: 5, output: 2 } })}\n`);
    const one = collectUsage({ days: 3, now, ...dirs });
    const two = collectUsage({ days: 3, now, ...dirs });
    assert.equal(one, two);
    const other = collectUsage({ days: 4, now, ...dirs });
    assert.notEqual(other, one);
    const [a, b, c] = await Promise.all([one, two, other]);
    assert.equal(a.records.length, 1);
    assert.equal(b.records.length, 1);
    assert.equal(c.records.length, 1);
    assert.equal(usageScanStats().parses >= 1, true);
  });

  it("returns an empty scan when the source folders do not exist", async () => {
    const scan = await collectUsage({ days: 7, now: Date.now(), claudeDir: join(tmp, "missing-a"), codexDir: join(tmp, "missing-b") });
    assert.deepEqual(scan.records, []);
    assert.equal(scan.files, 0);
  });
});

describe("usage aggregation", () => {
  const now = new Date(2026, 8, 30, 12, 0, 0).getTime();
  const at = (day: number, hour: number, minute = 0): number => new Date(2026, 8, day, hour, minute, 0).getTime();

  const records: UsageRecord[] = [
    record(at(30, 9), { sessionId: "s1", project: "pa", fresh: 100, cacheRead: 99_900, cacheWrite: 0, output: 10, cwd: "C:\\pa" }),
    record(at(30, 10), { sessionId: "s1", project: "pa", fresh: 100, cacheRead: 199_900, cacheWrite: 0, output: 20, cwd: "C:\\pa" }),
    record(at(29, 10), { sessionId: "s2", project: "pb", model: "claude-sonnet-5", fresh: 50, cacheRead: 349_950, cacheWrite: 0, output: 30, sidechain: true }),
    record(at(30, 11), { provider: "codex", sessionId: "s3", project: "pb", model: "gpt-fixture", fresh: 1000, cacheRead: 699_000, cacheWrite: 0, output: 40 }),
    record(at(20, 9), { sessionId: "s1", project: "pa", fresh: 5_000_000, cacheRead: 0, cacheWrite: 0, output: 1 }),
    record(at(27, 23, 59), { sessionId: "s9", project: "pz", fresh: 7, cacheRead: 0, cacheWrite: 0, output: 1 }),
  ];

  const aggregate: UsageAggregate = aggregateUsage(records, {
    days: 3,
    now,
    titleOf: (provider, sessionId) => (sessionId === "s1" ? `Title ${provider} ${sessionId}` : null),
  });

  it("windows the records to the last N local days and totals them", () => {
    assert.equal(aggregate.days, 3);
    assert.equal(aggregate.from, at(28, 0));
    assert.equal(aggregate.to, now);
    assert.deepEqual(aggregate.totals, { read: 1_350_000, fresh: 1250, cacheRead: 1_348_750, cacheWrite: 0, output: 100, messages: 4 });
    assert.equal(aggregate.byProvider.claude.messages, 3);
    assert.equal(aggregate.byProvider.claude.read, 650_000);
    assert.equal(aggregate.byProvider.codex.read, 700_000);
    assert.equal(aggregate.costs, null);
  });

  it("buckets by local day with empty days filled in", () => {
    assert.deepEqual(aggregate.byDay.map((item) => item.day), ["2026-09-28", "2026-09-29", "2026-09-30"]);
    assert.equal(aggregate.byDay[0]?.claude.messages, 0);
    assert.equal(aggregate.byDay[1]?.claude.read, 350_000);
    assert.equal(aggregate.byDay[2]?.claude.read, 300_000);
    assert.equal(aggregate.byDay[2]?.claude.messages, 2);
    assert.equal(aggregate.byDay[2]?.codex.read, 700_000);
  });

  it("groups by model, project and session sorted by read", () => {
    assert.deepEqual(aggregate.byModel.map((item) => [item.provider, item.model, item.read]), [
      ["codex", "gpt-fixture", 700_000],
      ["claude", "claude-sonnet-5", 350_000],
      ["claude", "claude-opus-5", 300_000],
    ]);
    assert.deepEqual(aggregate.byProject.map((item) => [item.provider, item.project, item.read, item.sessions]), [
      ["codex", "pb", 700_000, 1],
      ["claude", "pb", 350_000, 1],
      ["claude", "pa", 300_000, 1],
    ]);
    assert.deepEqual(aggregate.bySession.map((item) => item.sessionId), ["s3", "s2", "s1"]);
    const s1 = aggregate.bySession[2];
    assert.ok(s1);
    assert.equal(s1.title, "Title claude s1");
    assert.equal(s1.cwd, "C:\\pa");
    assert.equal(s1.messages, 2);
    assert.equal(s1.avgContext, 150_000);
    assert.equal(s1.p50Context, 100_000);
    assert.equal(s1.p90Context, 200_000);
    assert.equal(s1.maxContext, 200_000);
    assert.equal(s1.firstAt, at(30, 9));
    assert.equal(s1.lastAt, at(30, 10));
    assert.equal(aggregate.bySession[0]?.title, null);
  });

  it("computes context percentiles, the over-threshold counts and the sidechain share", () => {
    assert.deepEqual(aggregate.context, { avgPerMessage: 337_500, p50: 200_000, p90: 700_000, max: 700_000, over300k: 2, over600k: 1 });
    assert.ok(Math.abs(aggregate.sidechainShare - 350_000 / 1_350_000) < 1e-9);
  });

  it("caps the project list at 12 and the session list at 15", () => {
    const many: UsageRecord[] = [];
    for (let index = 0; index < 20; index += 1) {
      many.push(record(at(30, 9), { sessionId: `sess-${index}`, project: `proj-${index}`, fresh: 100 + index, cacheRead: 0, cacheWrite: 0, output: 1 }));
    }
    const capped = aggregateUsage(many, { days: 1, now });
    assert.equal(capped.byProject.length, 12);
    assert.equal(capped.bySession.length, 15);
    assert.equal(capped.byProject[0]?.project, "proj-19");
  });

  it("handles an empty record list", () => {
    const empty = aggregateUsage([], { days: 2, now });
    assert.equal(empty.totals.messages, 0);
    assert.equal(empty.byDay.length, 2);
    assert.deepEqual(empty.context, { avgPerMessage: 0, p50: 0, p90: 0, max: 0, over300k: 0, over600k: 0 });
    assert.equal(empty.sidechainShare, 0);
  });

  it("uses nearest-rank percentiles", () => {
    assert.equal(percentile([], 0.5), 0);
    assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(percentile([1, 2, 3, 4, 5], 0.9), 5);
    assert.equal(percentile([7], 0.9), 7);
  });
});

describe("usage routes", () => {
  const box = makeSandbox("cch-usage-routes-");
  const claudeDir = join(box.tmp, "claude-projects");
  const now = Date.now();
  let hub: RunningServer;

  const call = async (method: string, path: string): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${hub.base}${path}`, { method });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  before(async () => {
    write(
      join(claudeDir, "proj-x", "sess-a.jsonl"),
      `${[
        claudeLine({ id: "m1", at: now - 5000, sessionId: "sess-a", usage: { input: 10, cacheRead: 1000, cacheWrite: 100, output: 3 } }),
        claudeLine({ id: "m1", at: now - 4900, sessionId: "sess-a", usage: { input: 10, cacheRead: 1000, cacheWrite: 100, output: 5 } }),
        claudeLine({ id: "m2", at: now - 3000, sessionId: "sess-a", usage: { input: 20, cacheRead: 2000, output: 8 } }),
      ].join("\n")}\n`,
    );
    write(
      join(box.codexHome, "sessions", "2026", "09", "30", "rollout-usage.jsonl"),
      codexLines("codex-1", "C:\\work\\codex-app", "gpt-fixture", now - 60_000, [
        { at: now - 50_000, total: 1100, last: { input: 1000, cached: 600, output: 100, reasoning: 30 } },
        { at: now - 40_000, total: 2400, last: { input: 1200, cached: 1000, output: 100, reasoning: 0 } },
      ]),
    );
    hub = await startServer(box, { HUB_DELEGATION: "1", HUB_CLAUDE_PROJECTS_DIR: claudeDir });
  });

  after(async () => {
    hub.child.kill();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  });

  it("serves the aggregation with days validation", async () => {
    const res = await call("GET", "/delegation/usage?days=7");
    assert.equal(res.status, 200);
    const body = res.json as unknown as UsageAggregate;
    assert.equal(body.days, 7);
    assert.equal(body.byDay.length, 7);
    assert.equal(body.byProvider.claude.messages, 2);
    assert.equal(body.byProvider.claude.read, 3130);
    assert.equal(body.byProvider.claude.output, 13);
    assert.equal(body.byProvider.codex.messages, 2);
    assert.equal(body.byProvider.codex.read, 2200);
    assert.equal(body.costs, null);
    const codexModel = body.byModel.find((item) => item.provider === "codex");
    assert.equal(codexModel?.model, "gpt-fixture");
    assert.ok(body.byProject.some((item) => item.provider === "claude" && item.project === "proj-x"));
    assert.ok(body.bySession.some((item) => item.sessionId === "sess-a" && item.provider === "claude"));
    assert.equal((await call("GET", "/delegation/usage")).json.days, 7);
    for (const bad of ["0", "31", "abc", "1.5"]) {
      assert.equal((await call("GET", `/delegation/usage?days=${bad}`)).status, 400);
    }
  });

  it("summarizes today and the week per provider", async () => {
    const res = await call("GET", "/delegation/usage/summary");
    assert.equal(res.status, 200);
    const summary = res.json as unknown as { days: number; providers: { claude: { today: { read: number; output: number; messages: number }; week: { read: number; output: number } } | null; codex: { week: { read: number } } | null } };
    assert.equal(summary.days, 7);
    assert.equal(summary.providers.claude?.week.read, 3130);
    assert.equal(summary.providers.claude?.week.output, 13);
    assert.equal(summary.providers.codex?.week.read, 2200);
    assert.ok((summary.providers.claude?.today.messages ?? 0) <= 2);
  });

  it("caches for 60 s, bypasses with fresh=1 and rescan drops the cache and broadcasts", async () => {
    const controller = new AbortController();
    const streamPromise = fetch(`${hub.base}/api/events`, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 500));

    write(join(claudeDir, "proj-y", "sess-b.jsonl"), `${claudeLine({ id: "b1", at: now - 1000, sessionId: "sess-b", usage: { input: 7, output: 1 } })}
`);
    const stale = (await call("GET", "/delegation/usage?days=7")).json as unknown as UsageAggregate;
    assert.equal(stale.byProvider.claude.messages, 2);
    const fresh = (await call("GET", "/delegation/usage?days=7&fresh=1")).json as unknown as UsageAggregate;
    assert.equal(fresh.byProvider.claude.messages, 3);

    write(join(claudeDir, "proj-y", "sess-c.jsonl"), `${claudeLine({ id: "c1", at: now - 900, sessionId: "sess-c", usage: { input: 3, output: 1 } })}
`);
    const rescan = await call("POST", "/delegation/usage/rescan");
    assert.equal(rescan.status, 200);
    assert.ok(Number(rescan.json.files) >= 4);
    const after = (await call("GET", "/delegation/usage?days=7")).json as unknown as UsageAggregate;
    assert.equal(after.byProvider.claude.messages, 4);

    const stream = await streamPromise;
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("event: usage")) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }
    controller.abort();
    assert.match(received, /event: usage\s+data: \{"at":\d+\}/);
  });
});
