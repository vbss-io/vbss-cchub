import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { s2Sandbox, s2StartHub, s2Until, type S2Hub } from "./helpers/s2-env.js";

const box = s2Sandbox("cch-s2-usage-", { HUB_DELEGATION: "1" });
const claudeDir = join(box.tmp, "claude-projects");
const codexDir = join(box.codexHome, "sessions");
process.env.HUB_CLAUDE_PROJECTS_DIR = claudeDir;

const { db, applyHook } = await import("../src/db.js");
const usage = await import("../src/usage.js");
const routes = await import("../src/usage-routes.js");
const { onBroadcast } = await import("../src/sse.js");

let hub: S2Hub;
const events: string[] = [];
onBroadcast((event) => events.push(event));

const NOW = Date.now();
const iso = (offsetMs: number): string => new Date(NOW - offsetMs).toISOString();

function claudeLine(id: string, sessionId: string, offsetMs: number, usageBody: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "assistant", isSidechain: false, timestamp: iso(offsetMs), cwd: box.repoA, sessionId, message: { id, model: "claude-opus-5", usage: usageBody }, ...extra });
}

before(async () => {
  mkdirSync(join(claudeDir, "proj"), { recursive: true });
  writeFileSync(
    join(claudeDir, "proj", "usage-1.jsonl"),
    [
      claudeLine("m1", "usage-claude", 60_000, { input_tokens: 100, cache_read_input_tokens: 400, cache_creation_input_tokens: 50, output_tokens: 30, output_tokens_details: { thinking_tokens: 5 } }),
      claudeLine("m2", "usage-claude", 30_000, { input_tokens: 10, output_tokens: 3 }, { isSidechain: true }),
      "{not json",
      JSON.stringify({ type: "assistant", message: { id: "no-usage" } }),
      JSON.stringify({ type: "user", message: { content: "hello" } }),
      claudeLine("m3", "usage-claude", 10_000, { input_tokens: "NaN", output_tokens: null }),
    ].join("\n"),
  );
  const day = new Date(NOW);
  const rollouts = join(codexDir, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
  mkdirSync(rollouts, { recursive: true });
  const tokenCount = (offsetMs: number, last: Record<string, number>, total: number) => JSON.stringify({ timestamp: iso(offsetMs), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: last } } });
  writeFileSync(
    join(rollouts, "rollout-usage.jsonl"),
    [
      JSON.stringify({ timestamp: iso(90_000), type: "session_meta", payload: { id: "thread-usage", cwd: box.repoB, originator: "Codex Desktop" } }),
      JSON.stringify({ timestamp: iso(89_000), type: "turn_context", payload: { model: "gpt-5-codex", cwd: box.repoB } }),
      tokenCount(80_000, { input_tokens: 200, cached_input_tokens: 150, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 10 }, 240),
      tokenCount(70_000, { input_tokens: 200, cached_input_tokens: 150, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 10 }, 240),
      tokenCount(60_000, { input_tokens: 0, output_tokens: 0 }, 240),
      JSON.stringify({ timestamp: iso(50_000), type: "event_msg", payload: { type: "token_count", info: null } }),
      JSON.stringify({ timestamp: iso(40_000), type: "response_item" }),
      "garbage line",
    ].join("\n"),
  );
  usage.setUsageCachePath(null);
  hub = await s2StartHub(box);
  const res = await hub.http("PUT", "/delegation/settings", { features: { usage: true } });
  assert.equal(res.status, 200, res.text);
  applyHook({ kind: "session_start", sessionId: "usage-claude", cwd: box.repoA, source: null, hostPid: null, shellPid: null, title: "Usage session", message: null, notificationType: null, model: null, tokensIn: null, tokensOut: null, contextTokens: null, agentId: null, agentType: null, client: null, claudePid: null, transcriptPath: null, agentMessage: null, shareLabel: null });
});

after(async () => {
  usage.setUsageFileHook(null);
  usage.setUsageCachePath(null);
  await hub.close();
  if (db.open) db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const errorOf = (json: unknown): string => (json as { error: string }).error;

interface Aggregate {
  byProvider: { claude: { messages: number; read: number; output: number }; codex: { messages: number } };
  sessions?: unknown[];
  topSessions?: { sessionId: string; title: string | null }[];
}

describe("usage routes", () => {
  it("validates the window", async () => {
    for (const days of ["0", "31", "abc", "1.5", "-2"]) {
      const res = await hub.http("GET", `/delegation/usage?days=${days}`);
      assert.equal(res.status, 400, days);
      assert.match(errorOf(res.json), /days must be an integer between 1 and 30/);
    }
  });

  it("scans in the background first and serves the cached aggregate afterwards", async () => {
    usage.resetUsageCache();
    const first = await hub.http("GET", "/delegation/usage?days=3");
    assert.ok([200, 202].includes(first.status), first.text);
    if (first.status === 202) assert.equal((first.json as { scanning: boolean }).scanning, true);
    const done = await s2Until(async () => {
      const res = await hub.http("GET", "/delegation/usage?days=3");
      return res.status === 200 ? (res.json as Aggregate) : null;
    }, 20_000);
    assert.equal(done.byProvider.claude.messages >= 2, true);
    assert.equal(done.byProvider.codex.messages >= 1, true);
    assert.ok(events.includes("usage"), "usage event broadcast after the scan");
    const cached = await hub.http("GET", "/delegation/usage?days=3");
    assert.equal(cached.status, 200);
    assert.deepEqual(cached.json, done);
    const titled = JSON.stringify(done).includes("Usage session");
    assert.equal(titled, true);
  });

  it("computes on demand with fresh=1 and summarizes the week", async () => {
    const fresh = await hub.http("GET", "/delegation/usage?days=7&fresh=1");
    assert.equal(fresh.status, 200, fresh.text);
    const summary = await hub.http("GET", "/delegation/usage/summary?fresh=1");
    assert.equal(summary.status, 200, summary.text);
    const body = summary.json as { days: number; providers: { claude: { today: { messages: number } } | null; codex: { today: { messages: number } } | null } };
    assert.equal(body.days, 7);
    assert.ok(body.providers.claude && body.providers.claude.today.messages >= 1);
    assert.ok(body.providers.codex);
    const cachedSummary = await hub.http("GET", "/delegation/usage/summary");
    assert.ok([200, 202].includes(cachedSummary.status));
  });

  it("answers 202 while the first summary is still being scanned", async () => {
    usage.resetUsageCache();
    usage.setUsageFileHook(() => new Promise((resolve) => setTimeout(resolve, 150)));
    try {
      const scanning = await hub.http("GET", "/delegation/usage/summary");
      assert.equal(scanning.status, 202, scanning.text);
      assert.deepEqual(scanning.json, { days: 7, scanning: true, providers: null });
      const listing = await hub.http("GET", "/delegation/usage?days=7");
      assert.ok([200, 202].includes(listing.status));
      if (listing.status === 202) assert.ok("startedAt" in (listing.json as object));
    } finally {
      usage.setUsageFileHook(null);
    }
    await s2Until(async () => ((await hub.http("GET", "/delegation/usage/summary")).status === 200 ? true : null), 20_000);
  });

  it("drops a cached aggregate when the sources changed during its scan", async () => {
    usage.resetUsageCache();
    usage.setUsageFileHook(async () => {
      usage.resetUsageCache();
    });
    try {
      const fresh = await hub.http("GET", "/delegation/usage?days=5&fresh=1");
      assert.equal(fresh.status, 200, fresh.text);
    } finally {
      usage.setUsageFileHook(null);
    }
    const again = await hub.http("GET", "/delegation/usage?days=5&fresh=1");
    assert.equal(again.status, 200, again.text);
  });

  it("rescans everything on demand", async () => {
    const res = await hub.http("POST", "/delegation/usage/rescan");
    assert.equal(res.status, 200, res.text);
    assert.ok((res.json as { files: number }).files >= 2);
    assert.equal(typeof (res.json as { elapsedMs: number }).elapsedMs, "number");
  });

  it("summarises an aggregate that has only one provider", () => {
    const empty = { byDay: [], byProvider: { claude: { messages: 0, read: 0, output: 0 }, codex: { messages: 2, read: 5, output: 7 } } };
    const summary = routes.summarize(empty as never);
    assert.equal(summary.providers.claude, null);
    assert.deepEqual(summary.providers.codex, { today: { read: 0, output: 0, messages: 0 }, week: { read: 5, output: 7 } });
  });
});

describe("usage cache on disk", () => {
  const cachePath = join(box.tmp, "usage-cache.json");

  async function scanWithCache(): Promise<number> {
    usage.setUsageCachePath(cachePath);
    const scan = await usage.collectUsage({ days: 3, now: NOW + 1000, claudeDir, codexDir });
    return scan.records.length;
  }

  it("persists a scan and reloads it into a fresh process state", async () => {
    usage.resetUsageCache();
    const records = await scanWithCache();
    assert.ok(records >= 3);
    await usage.flushUsageCache();
    const saved = JSON.parse(readFileSync(cachePath, "utf8")) as { version: number; files: { provider: string }[] };
    assert.equal(saved.version, 1);
    assert.deepEqual([...new Set(saved.files.map((file) => file.provider))].sort(), ["claude", "codex"]);
    usage.resetUsageCache();
    assert.equal(await scanWithCache(), records);
  });

  it("ignores a cache with a damaged shape, string table, record, meta or provider", async () => {
    usage.resetUsageCache();
    const baseline = await scanWithCache();
    await usage.flushUsageCache();
    const good = JSON.parse(readFileSync(cachePath, "utf8")) as { strings: unknown[]; files: Record<string, unknown>[] };
    const claudeFile = good.files.find((file) => file.provider === "claude") as { records: unknown[][]; meta: Record<string, unknown> };
    const codexFile = good.files.find((file) => file.provider === "codex") as { meta: Record<string, unknown> };
    const variants: Record<string, (copy: typeof good) => unknown>[] = [];
    const mutate = (name: string, change: (copy: any) => unknown): void => {
      variants.push({ [name]: change });
    };
    mutate("not an object", () => []);
    mutate("wrong version", (copy) => ({ ...copy, version: 99 }));
    mutate("strings not an array", (copy) => ({ ...copy, strings: "x" }));
    mutate("a non-string in the table", (copy) => ({ ...copy, strings: [...copy.strings, 5] }));
    mutate("file without records", (copy) => ({ ...copy, files: [{ path: "x" }] }));
    mutate("unknown provider", (copy) => ({ ...copy, files: [{ ...copy.files[0], provider: "gemini" }] }));
    mutate("non-numeric size", (copy) => ({ ...copy, files: [{ ...copy.files[0], size: "big" }] }));
    mutate("short record", (copy) => ({ ...copy, files: [{ ...claudeFile, records: [[1, 2]] }] }));
    mutate("bad string index", (copy) => ({ ...copy, files: [{ ...claudeFile, records: [claudeFile.records[0]?.map((value, column) => (column === 1 ? 9999 : value))] }] }));
    mutate("claude meta of the wrong kind", (copy) => ({ ...copy, files: [{ ...claudeFile, meta: { kind: "codex" } }] }));
    mutate("claude meta without keys", (copy) => ({ ...copy, files: [{ ...claudeFile, meta: { ...claudeFile.meta, keys: "x" } }] }));
    mutate("codex meta of the wrong shape", (copy) => ({ ...copy, files: [{ ...codexFile, meta: { ...codexFile.meta, metaSeen: "yes" } }] }));
    mutate("missing meta", (copy) => ({ ...copy, files: [{ ...claudeFile, meta: null }] }));
    for (const variant of variants) {
      const [name, change] = Object.entries(variant)[0] as [string, (copy: unknown) => unknown];
      writeFileSync(cachePath, JSON.stringify(change(structuredClone(good))));
      usage.resetUsageCache();
      assert.equal(await scanWithCache(), baseline, name);
    }
    writeFileSync(cachePath, "{ not json");
    usage.resetUsageCache();
    assert.equal(await scanWithCache(), baseline);
    rmSync(cachePath, { force: true });
    usage.resetUsageCache();
    assert.equal(await scanWithCache(), baseline);
  });

  it("drops cached files older than the retention window", async () => {
    usage.resetUsageCache();
    await scanWithCache();
    await usage.flushUsageCache();
    const saved = JSON.parse(readFileSync(cachePath, "utf8")) as { files: { mtimeMs: number }[] };
    for (const file of saved.files) file.mtimeMs = 1;
    writeFileSync(cachePath, JSON.stringify(saved));
    usage.resetUsageCache();
    assert.ok((await scanWithCache()) >= 3);
  });
});
