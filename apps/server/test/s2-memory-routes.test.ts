import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { S2_DAILY_TEMPLATE, s2ConfigureVault, s2InitRepo, s2Sandbox, s2StartHub, s2Today, s2WriteFile, s2Wait, type S2Hub } from "./helpers/s2-env.js";

const box = s2Sandbox("cch-s2-memory-", { HUB_DELEGATION: "1" });
process.env.HUB_CLAUDE_PROJECTS_DIR = join(box.tmp, "claude-projects");

const { db } = await import("../src/db.js");
const history = await import("../src/history-index.js");
const today = await import("../src/today.js");
const board = await import("../src/tasks-board.js");
const daily = await import("../src/daily.js");
const { abortActiveRuns } = await import("../src/delegation-launch.js");

let hub: S2Hub;

const TODAY = s2Today();

before(async () => {
  s2InitRepo(box.repoA);
  mkdirSync(join(process.env.HUB_CLAUDE_PROJECTS_DIR as string, "proj"), { recursive: true });
  const message = (type: string, text: string, at: string) => JSON.stringify({ type, sessionId: "hist-1", cwd: box.repoA, timestamp: at, message: { role: type, content: text } });
  writeFileSync(join(process.env.HUB_CLAUDE_PROJECTS_DIR as string, "proj", "hist-1.jsonl"), [message("user", "how do I rotate the staging certificates", "2026-11-10T10:00:00.000Z"), message("assistant", "run the rotation script and restart the gateway", "2026-11-10T10:00:05.000Z")].join("\n"));
  s2WriteFile(box.brain, "_templates/daily.md", S2_DAILY_TEMPLATE);
  s2WriteFile(box.brain, "projects/lab.md", "# Lab\n\n## Open loops\n\n- [ ] Alpha\n\n## Done loops\n\n");
  hub = await s2StartHub(box);
  await s2ConfigureVault(hub, box);
});

after(async () => {
  abortActiveRuns("test over");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await history.stopHistoryIndex();
  today.removeTodayHooks();
  daily.stopDailyWatch();
  today.forgetTodayState();
  board.stopTasksBoardWatch();
  await hub.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  today.forgetTodayState();
  if (db.open) db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

const errorOf = (json: unknown): string => (json as { error: string }).error;

describe("history routes", () => {
  it("reports the status, runs and rebuilds the index and finds a message", async () => {
    const status = await hub.http("GET", "/delegation/memory/history/status");
    assert.equal(status.status, 200, status.text);
    const run = await hub.http("POST", "/delegation/memory/history/run");
    assert.equal(run.status, 202, run.text);
    await history.whenHistoryIdle();
    const rebuild = await hub.http("POST", "/delegation/memory/history/rebuild");
    assert.equal(rebuild.status, 202, rebuild.text);
    await history.whenHistoryIdle();
    const found = await hub.http("GET", "/delegation/memory/history/search?q=certificates&client=claude&sort=recent&group=session&limit=5&offset=0&workspace=pilot");
    assert.equal(found.status, 200, found.text);
    const hits = found.json as { hits?: unknown[]; results?: unknown[]; total?: number };
    assert.ok(JSON.stringify(hits).includes("certificates"), found.text);
    const dated = await hub.http("GET", "/delegation/memory/history/search?q=rotation&from=2026-11-01&to=2026-11-30");
    assert.equal(dated.status, 200, dated.text);
    const epoch = await hub.http("GET", `/delegation/memory/history/search?q=rotation&from=${Date.parse("2026-11-01")}&to=${Date.parse("2026-12-01")}`);
    assert.equal(epoch.status, 200, epoch.text);
    const empty = await hub.http("GET", "/delegation/memory/history/search");
    assert.equal(empty.status, 200, empty.text);
  });

  it("rejects an unknown client and a malformed time", async () => {
    const client = await hub.http("GET", "/delegation/memory/history/search?q=x&client=gemini");
    assert.equal(client.status, 400);
    assert.match(errorOf(client.json), /client must be one of: claude, codex/);
    const time = await hub.http("GET", "/delegation/memory/history/search?q=x&from=yesterday");
    assert.equal(time.status, 400);
    assert.match(errorOf(time.json), /from and to must be YYYY-MM-DD or epoch milliseconds/);
    const toBad = await hub.http("GET", "/delegation/memory/history/search?q=x&to=tomorrow");
    assert.equal(toBad.status, 400);
  });

  it("refuses to index while the index is off and clears it on demand", async () => {
    await hub.http("PUT", "/delegation/settings", { memory: { historyIndex: false } });
    const run = await hub.http("POST", "/delegation/memory/history/run");
    assert.equal(run.status, 409);
    assert.match(errorOf(run.json), /history index is turned off/);
    const rebuild = await hub.http("POST", "/delegation/memory/history/rebuild");
    assert.equal(rebuild.status, 409);
    const cleared = await hub.http("DELETE", "/delegation/memory/history");
    assert.equal(cleared.status, 200, cleared.text);
    await hub.http("PUT", "/delegation/settings", { memory: { historyIndex: true } });
  });
});

describe("handoff routes", () => {
  it("serves the loopback hook, tolerating an unknown folder", async () => {
    const hook = await hub.http("GET", `/delegation/memory/handoff/hook?cwd=${encodeURIComponent(box.repoA)}&sessionId=s1`);
    assert.equal(hook.status, 200, hook.text);
    assert.ok("text" in (hook.json as object));
    const none = await hub.http("GET", "/delegation/memory/handoff/hook");
    assert.equal(none.status, 200, none.text);
  });

  it("previews a workspace handoff and toggles the workspace", async () => {
    const noName = await hub.http("GET", "/delegation/memory/handoff/preview");
    assert.equal(noName.status, 400);
    assert.match(errorOf(noName.json), /workspace required/);
    const preview = await hub.http("GET", "/delegation/memory/handoff/preview?workspace=pilot");
    assert.equal(preview.status, 200, preview.text);
    assert.equal(typeof (preview.json as { text?: unknown }).text === "string" || (preview.json as { text?: unknown }).text === null, true);
    const ghost = await hub.http("GET", "/delegation/memory/handoff/preview?workspace=ghost");
    assert.equal(ghost.status, 200, ghost.text);
    const on = await hub.http("PUT", "/delegation/memory/handoff/workspaces/pilot", { enabled: true });
    assert.equal(on.status, 200, on.text);
    assert.deepEqual((on.json as { handoffWorkspaces: string[] }).handoffWorkspaces, ["pilot"]);
    const again = await hub.http("PUT", "/delegation/memory/handoff/workspaces/pilot", { enabled: true });
    assert.deepEqual((again.json as { handoffWorkspaces: string[] }).handoffWorkspaces, ["pilot"]);
    const off = await hub.http("PUT", "/delegation/memory/handoff/workspaces/pilot", { enabled: false });
    assert.deepEqual((off.json as { handoffWorkspaces: string[] }).handoffWorkspaces, []);
    const bad = await hub.http("PUT", "/delegation/memory/handoff/workspaces/pilot", { enabled: "yes" });
    assert.equal(bad.status, 400);
    assert.match(errorOf(bad.json), /enabled must be true or false/);
  });
});

describe("day summary routes", () => {
  it("previews the summary and validates the date", async () => {
    const preview = await hub.http("GET", `/delegation/memory/day-summary?date=${TODAY}`);
    assert.equal(preview.status, 200, preview.text);
    assert.ok(typeof (preview.json as { digest: string }).digest === "string");
    const defaultDate = await hub.http("GET", "/delegation/memory/day-summary");
    assert.equal(defaultDate.status, 200, defaultDate.text);
    const bad = await hub.http("GET", "/delegation/memory/day-summary?date=2026-13-45");
    assert.equal(bad.status, 400);
    assert.match(errorOf(bad.json), /date must be YYYY-MM-DD/);
  });

  it("writes the summary into the daily note with its digest and reports the failure modes", async () => {
    await hub.http("POST", `/delegation/today/${TODAY}/create`);
    await s2Wait(30);
    const noDigest = await hub.http("POST", "/delegation/memory/day-summary/write", { date: TODAY });
    assert.equal(noDigest.status, 400, noDigest.text);
    assert.equal((noDigest.json as { code: string }).code, "digest-required");
    const stale = await hub.http("POST", "/delegation/memory/day-summary/write", { date: TODAY, digest: "not-the-digest" });
    assert.equal(stale.status, 409, stale.text);
    assert.equal((stale.json as { code: string }).code, "summary-changed");
    const preview = (await hub.http("GET", `/delegation/memory/day-summary?date=${TODAY}`)).json as { digest: string };
    const written = await hub.http("POST", "/delegation/memory/day-summary/write", { date: TODAY, digest: preview.digest, writeId: "w-1" });
    assert.equal(written.status, 200, written.text);
    assert.equal((written.json as { changed: boolean }).changed, true);
    assert.match(readFileSync(join(box.brain, "daily", `${TODAY}.md`), "utf8"), /cchub:day-summary START/);
    const again = await hub.http("POST", "/delegation/memory/day-summary/write", { date: TODAY, digest: preview.digest, baseUpdatedAt: 1 });
    assert.equal(again.status, 200, again.text);
    assert.equal((again.json as { changed: boolean }).changed, false);
    const badDate = await hub.http("POST", "/delegation/memory/day-summary/write", { date: "nope", digest: "x" });
    assert.equal(badDate.status, 400);
    assert.match(errorOf(badDate.json), /date must be YYYY-MM-DD/);
    const defaultDate = await hub.http("POST", "/delegation/memory/day-summary/write", { digest: "x" });
    assert.equal(defaultDate.status, 409, defaultDate.text);
    assert.equal((defaultDate.json as { code: string }).code, "summary-changed");
  });

  it("reports a conflict when the daily note changed since it was read", async () => {
    const preview = (await hub.http("GET", `/delegation/memory/day-summary?date=${TODAY}`)).json as { digest: string };
    const read = (await hub.http("GET", `/delegation/daily/${TODAY}`)).json as { updatedAt: number; content: string };
    await s2Wait(30);
    const withoutBlock = read.content.replace(/<!-- cchub:day-summary START -->[\s\S]*<!-- cchub:day-summary END -->/, "");
    s2WriteFile(box.brain, `daily/${TODAY}.md`, `${withoutBlock}
- edited elsewhere
`);
    const res = await hub.http("POST", "/delegation/memory/day-summary/write", { date: TODAY, digest: preview.digest, baseUpdatedAt: read.updatedAt });
    assert.equal(res.status, 409, res.text);
    assert.equal((res.json as { code: string }).code, "daily-changed");
    assert.match((res.json as { content: string }).content, /edited elsewhere/);
  });

  it("refuses to write over damaged summary markers", async () => {
    const date = s2Today(-2);
    s2WriteFile(box.brain, `daily/${date}.md`, `---
type: daily
---

# ${date}

## Sessions

<!-- cchub:day-summary START -->
- broken block without an end
`);
    const res = await hub.http("POST", "/delegation/memory/day-summary/write", { date, digest: "x" });
    assert.equal(res.status, 422, res.text);
    assert.equal((res.json as { code: string }).code, "summary-markers-damaged");
  });

  it("reports a missing daily note", async () => {
    const res = await hub.http("POST", "/delegation/memory/day-summary/write", { date: s2Today(-9), digest: "x" });
    assert.equal(res.status, 404, res.text);
  });
});
