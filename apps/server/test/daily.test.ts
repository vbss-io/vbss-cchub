import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeSandbox, startServer, waitFor, type RunningServer, type Sandbox } from "./helpers.js";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-daily-store-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.HUB_WORKSPACES_ROOT;
delete process.env.HUB_EDITOR;
delete process.env.HUB_SECOND_BRAIN;

type Store = typeof import("../src/delegation-store.js");
type Daily = typeof import("../src/daily.js");
type Sse = typeof import("../src/sse.js");
let store: Store;
let daily: Daily;
let sse: Sse;

before(async () => {
  store = await import("../src/delegation-store.js");
  daily = await import("../src/daily.js");
  sse = await import("../src/sse.js");
});

function fixtureSettings(root: string, overrides: Partial<DelegationSettings> = {}): DelegationSettings {
  return {
    workspacesRoot: null,
    editorCommand: "code",
    secondBrainRoot: root,
    autonomy: "full",
    ownerName: "tester",
    runTimeoutMinutes: 60,
    features: { daily: true },
    daily: { dir: null, template: null, prompt: null, runner: "claude" },
    ...overrides,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("daily settings", () => {
  it("defaults features.daily off and merges nested daily patches", () => {
    const defaults = store.getSettings();
    assert.deepEqual(defaults.features, { daily: false });
    assert.deepEqual(defaults.daily, { dir: null, template: null, prompt: null, runner: "claude" });

    const afterFeature = store.updateSettings({ features: { daily: true } });
    assert.equal(afterFeature.features.daily, true);
    assert.deepEqual(afterFeature.daily, { dir: null, template: null, prompt: null, runner: "claude" });

    const afterPrompt = store.updateSettings({ daily: { prompt: "custom prompt" } });
    assert.equal(afterPrompt.daily.prompt, "custom prompt");
    assert.equal(afterPrompt.features.daily, true);
    assert.equal(afterPrompt.daily.dir, null);

    const afterRest = store.updateSettings({ daily: { runner: "codex", dir: "diario2" } });
    assert.equal(afterRest.daily.runner, "codex");
    assert.equal(afterRest.daily.dir, "diario2");
    assert.equal(afterRest.daily.prompt, "custom prompt");
  });
});

describe("dailyFile resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "cch-daily-file-"));

  before(() => {
    mkdirSync(join(root, "diario", "2026-08"), { recursive: true });
    writeFileSync(join(root, "diario", "2026-08", "2026-08-27.md"), "# archived");
    writeFileSync(join(root, "diario", "2026-09-15.md"), "# today");
  });

  after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("resolves an existing root-level diary", () => {
    assert.equal(daily.dailyFile(fixtureSettings(root), "2026-09-15"), join(root, "diario", "2026-09-15.md"));
  });

  it("resolves an archived diary through the recursive lookup", () => {
    assert.equal(daily.dailyFile(fixtureSettings(root), "2026-08-27"), join(root, "diario", "2026-08", "2026-08-27.md"));
  });

  it("falls back to the daily dir for a date with no diary yet", () => {
    assert.equal(daily.dailyFile(fixtureSettings(root), "2026-09-20"), join(root, "diario", "2026-09-20.md"));
  });

  it("honors a custom daily.dir, relative to root", () => {
    const settings = fixtureSettings(root, { daily: { dir: "custom-daily", template: null, prompt: null, runner: "claude" } });
    assert.equal(daily.dailyFile(settings, "2026-09-20"), join(root, "custom-daily", "2026-09-20.md"));
  });

  it("resolves an archived diary nested one level under a non-month-named subfolder", () => {
    mkdirSync(join(root, "diario", "misc"), { recursive: true });
    writeFileSync(join(root, "diario", "misc", "2026-07-04.md"), "# nested");
    assert.equal(daily.dailyFile(fixtureSettings(root), "2026-07-04"), join(root, "diario", "misc", "2026-07-04.md"));
  });

  it("resolves the template path with the built-in fallback", () => {
    assert.equal(daily.dailyTemplatePath(fixtureSettings(root)), null);
    mkdirSync(join(root, "_templates"), { recursive: true });
    writeFileSync(join(root, "_templates", "diario.md"), "# {{date}}");
    assert.equal(daily.dailyTemplatePath(fixtureSettings(root)), join(root, "_templates", "diario.md"));
  });
});

describe("custom daily.dir (journal) resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "cch-daily-journal-"));
  const settings = fixtureSettings(root, { daily: { dir: "journal", template: null, prompt: null, runner: "claude" } });

  before(() => {
    mkdirSync(join(root, "journal", "2026-08"), { recursive: true });
    writeFileSync(join(root, "journal", "2026-08", "2026-08-30.md"), "# archived in journal");
    writeFileSync(join(root, "journal", "2026-09-01.md"), "# journal today");
  });

  after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("reads an existing diary from inside journal/", () => {
    assert.equal(daily.dailyFile(settings, "2026-09-01"), join(root, "journal", "2026-09-01.md"));
    const read = daily.readDaily(settings, "2026-09-01");
    assert.equal(read.exists, true);
    assert.equal(read.content, "# journal today");
  });

  it("resolves an archived diary nested one level inside journal/", () => {
    assert.equal(daily.dailyFile(settings, "2026-08-30"), join(root, "journal", "2026-08", "2026-08-30.md"));
  });

  it("lists dates scanning journal/ and its immediate subfolders", () => {
    assert.deepEqual(daily.listDiaryDates(settings), ["2026-09-01", "2026-08-30"]);
  });

  it("finds yesterday inside journal/", () => {
    assert.equal(daily.findYesterday(settings, "2026-09-15"), "2026-09-01");
  });
});

describe("template and prompt rendering", () => {
  it("renders {{date}} in the built-in template", () => {
    const rendered = daily.renderTemplate(daily.BUILT_IN_TEMPLATE, "2026-09-15");
    assert.match(rendered, /created: 2026-09-15/);
    assert.match(rendered, /# 2026-09-15/);
    assert.doesNotMatch(rendered, /\{\{date\}\}/);
  });

  it("renders every placeholder of the default prompt", () => {
    const rendered = daily.renderDailyPrompt(daily.DEFAULT_DAILY_PROMPT, {
      date: "2026-09-15",
      file: "/vault/diario/2026-09-15.md",
      root: "/vault",
      template: "none",
      focus: "ship the daily tab",
      sessions: "- task a · claude-code · /repo",
      yesterday: "2026-09-14",
    });
    assert.doesNotMatch(rendered, /\{\{/);
    assert.match(rendered, /2026-09-15/);
    assert.match(rendered, /2026-09-14/);
    assert.match(rendered, /ship the daily tab/);
  });

  it("finds the most recent diary before a date through the recursive lookup", () => {
    const root = mkdtempSync(join(tmpdir(), "cch-daily-yday-"));
    mkdirSync(join(root, "diario", "2026-08"), { recursive: true });
    writeFileSync(join(root, "diario", "2026-08", "2026-08-30.md"), "#");
    writeFileSync(join(root, "diario", "2026-09-01.md"), "#");
    const settings = fixtureSettings(root);
    assert.equal(daily.findYesterday(settings, "2026-09-15"), "2026-09-01");
    assert.equal(daily.findYesterday(settings, "2026-08-31"), "2026-08-30");
    assert.equal(daily.findYesterday(settings, "2020-01-01"), null);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe("hash comparison helper", () => {
  it("is deterministic and content-sensitive", () => {
    assert.equal(daily.hashDailyContent("same"), daily.hashDailyContent("same"));
    assert.notEqual(daily.hashDailyContent("a"), daily.hashDailyContent("b"));
  });
});

describe("read/write round-trip", () => {
  const root = mkdtempSync(join(tmpdir(), "cch-daily-rw-"));

  after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it("reports missing files, then writes atomically and reads back with mtime", () => {
    const settings = fixtureSettings(root);
    const missing = daily.readDaily(settings, "2026-09-15");
    assert.equal(missing.exists, false);
    assert.equal(missing.content, "");
    assert.equal(missing.updatedAt, null);

    const written = daily.writeDaily(settings, "2026-09-15", "# hello\n");
    assert.equal(written.path, join(root, "diario", "2026-09-15.md"));
    assert.ok(existsSync(written.path));
    assert.equal(readFileSync(written.path, "utf8"), "# hello\n");

    const read = daily.readDaily(settings, "2026-09-15");
    assert.equal(read.exists, true);
    assert.equal(read.content, "# hello\n");
    assert.equal(read.updatedAt, written.updatedAt);
  });

  it("does not conflict when baseUpdatedAt matches the hub's own last write", () => {
    const settings = fixtureSettings(root);
    const first = daily.writeDaily(settings, "2026-09-17", "hub v1");
    const second = daily.writeDaily(settings, "2026-09-17", "hub v2", first.updatedAt);
    assert.equal(daily.readDaily(settings, "2026-09-17").content, "hub v2");
    assert.ok(second.updatedAt >= first.updatedAt);
  });

  it("throws a conflict when the disk changed since baseUpdatedAt", async () => {
    const settings = fixtureSettings(root);
    const initial = daily.writeDaily(settings, "2026-09-16", "hub v1");
    await sleep(20);
    writeFileSync(join(root, "diario", "2026-09-16.md"), "edited outside the hub");
    assert.throws(
      () => daily.writeDaily(settings, "2026-09-16", "hub v2", initial.updatedAt),
      (err: unknown) => {
        assert.ok(err instanceof daily.DailyConflictError);
        assert.equal((err as InstanceType<Daily["DailyConflictError"]>).content, "edited outside the hub");
        return true;
      },
    );
    assert.equal(readFileSync(join(root, "diario", "2026-09-16.md"), "utf8"), "edited outside the hub");
  });
});

describe("watcher", () => {
  const root = mkdtempSync(join(tmpdir(), "cch-daily-watch-"));

  before(() => mkdirSync(join(root, "diario"), { recursive: true }));

  after(() => {
    daily.stopDailyWatch();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("broadcasts a disk-sourced daily event for an external write and suppresses echoes of the hub's own write", async () => {
    const settings = fixtureSettings(root);
    const events: { date: string; updatedAt: number; source: string; writeId?: string | null }[] = [];
    const unsubscribe = sse.onBroadcast((event, data) => {
      if (event === "daily") events.push(data as { date: string; updatedAt: number; source: string; writeId?: string | null });
    });

    daily.watchDaily(settings);
    writeFileSync(join(root, "diario", "2026-09-01.md"), "external content");

    const seen = await waitFor(async () => (events.length > 0 ? events[0] : null), 5000);
    assert.equal(seen.date, "2026-09-01");
    assert.equal(seen.source, "disk");

    events.length = 0;
    daily.writeDaily(settings, "2026-09-02", "written by hub");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.source, "hub");
    assert.equal(events[0]?.writeId, null);
    await sleep(600);
    assert.equal(events.length, 1, "echo of the hub's own write must not produce a second disk-sourced broadcast");

    events.length = 0;
    daily.writeDaily(settings, "2026-09-03", "written by hub with id", undefined, "client-write-1");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.writeId, "client-write-1");
    await sleep(600);
    assert.equal(events.length, 1, "echo of a writeId'd hub write must not produce a second broadcast");

    events.length = 0;
    writeFileSync(join(root, "diario", "notes.md"), "not a daily date");
    await sleep(600);
    assert.equal(events.length, 0, "a non-daily-date filename must not produce a broadcast");

    events.length = 0;
    mkdirSync(join(root, "diario", "2026-08"), { recursive: true });
    writeFileSync(join(root, "diario", "2026-08", "2026-08-20.md"), "# archived day");
    await sleep(600);
    assert.equal(events.length, 1, "an external edit inside an archived month folder must broadcast");
    assert.equal(events[0]?.date, "2026-08-20");
    assert.equal(events[0]?.source, "disk");
    assert.equal(events[0]?.writeId, null);

    unsubscribe();
  });
});

describe("daily HTTP routes", () => {
  const box: Sandbox = makeSandbox("cch-daily-http-");
  let hub: RunningServer;

  interface HttpResult {
    status: number;
    json: unknown;
  }

  async function http(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const res = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
  }

  before(async () => {
    hub = await startServer(box, { HUB_DELEGATION: "1" });
  });

  after(async () => {
    hub.child.kill();
  });

  it("reports the feature as unavailable before a root is linked", async () => {
    const res = await http("GET", "/delegation/daily");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { enabled: false, root: null, dir: null, today: (res.json as { today: string }).today, dates: [], running: null, templatePath: null });
  });

  it("rejects a malformed date on every daily route", async () => {
    assert.equal((await http("GET", "/delegation/daily/not-a-date")).status, 400);
    assert.equal((await http("PUT", "/delegation/daily/not-a-date", { content: "x" })).status, 400);
    assert.equal((await http("POST", "/delegation/daily/nope/generate", {})).status, 400);
  });

  it("refuses to generate while the feature is disabled", async () => {
    const put = await http("PUT", "/delegation/settings", { secondBrainRoot: box.brain });
    assert.equal(put.status, 200);
    const res = await http("POST", "/delegation/daily/2026-09-15/generate", {});
    assert.equal(res.status, 400);
  });

  it("lists the linked root once enabled and round-trips a diary through PUT/GET", async () => {
    const put = await http("PUT", "/delegation/settings", { features: { daily: true } });
    assert.equal(put.status, 200);
    assert.equal((put.json as { features: { daily: boolean } }).features.daily, true);

    const overview = await http("GET", "/delegation/daily");
    assert.equal((overview.json as { enabled: boolean }).enabled, true);
    assert.equal((overview.json as { root: string | null }).root, box.brain);
    assert.deepEqual((overview.json as { dates: string[] }).dates, []);

    const write = await http("PUT", "/delegation/daily/2026-09-15", { content: "# hi\n" });
    assert.equal(write.status, 200);

    const read = await http("GET", "/delegation/daily/2026-09-15");
    assert.equal(read.status, 200);
    assert.equal((read.json as { content: string }).content, "# hi\n");
    assert.equal((read.json as { exists: boolean }).exists, true);
  });

  it("rejects calendar-invalid dates with a real root linked, and creates no file", async () => {
    for (const date of ["2026-13-40", "9999-99-99"]) {
      const get = await http("GET", `/delegation/daily/${date}`);
      assert.equal(get.status, 400);
      assert.deepEqual(get.json, { error: "date must be a valid YYYY-MM-DD" });

      const put = await http("PUT", `/delegation/daily/${date}`, { content: "should not persist" });
      assert.equal(put.status, 400);
      assert.deepEqual(put.json, { error: "date must be a valid YYYY-MM-DD" });

      assert.equal(existsSync(join(box.brain, "diario", `${date}.md`)), false);
      assert.equal(existsSync(join(box.brain, "diario", `${date.slice(0, 7)}`, `${date}.md`)), false);
    }
  });

  it("returns 400 for a malformed sessions date query", async () => {
    assert.equal((await http("GET", "/delegation/daily/sessions?date=nope")).status, 400);
    const ok = await http("GET", "/delegation/daily/sessions?date=2026-09-15");
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.json));
  });

  it("launches a headless run with the vault as cwd, and 409s a concurrent generate for the same date", async () => {
    const first = await http("POST", "/delegation/daily/2026-09-20/generate", { focus: "ship the daily tab" });
    assert.equal(first.status, 201);
    const taskId = (first.json as { taskId: string }).taskId;
    assert.ok(taskId);

    const second = await http("POST", "/delegation/daily/2026-09-20/generate", {});
    assert.equal(second.status, 409);
    assert.ok((second.json as { taskId: string }).taskId);

    const detail = await waitFor(async () => {
      const res = await http("GET", `/delegation/tasks/${taskId}`);
      const task = (res.json as { task: { status: string } }).task;
      return ["completed", "attention", "failed", "interrupted", "cancelled"].includes(task.status) ? res.json : null;
    }, 15000);
    assert.equal((detail as { task: { status: string; cwd: string } }).task.status, "completed");
    assert.equal((detail as { task: { status: string; cwd: string } }).task.cwd, box.brain);

    const capture = JSON.parse(readFileSync(box.claudeCapture, "utf8")) as { cwd: string; prompt: string };
    assert.equal(capture.cwd, box.brain);
    assert.match(capture.prompt, /ship the daily tab/);
    assert.doesNotMatch(capture.prompt, /\{\{/);

    const overview = await http("GET", "/delegation/daily");
    assert.equal((overview.json as { running: unknown }).running, null);
  });
});
