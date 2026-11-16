import assert from "node:assert/strict";
import express from "express";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fixtures } from "./helpers.js";

const tmp = mkdtempSync(join(tmpdir(), "cch-g3-history-"));
const home = join(tmp, "home");
const claudeDir = join(tmp, "claude-config");
const codexHome = join(tmp, "codex-home");
const workspacesRoot = join(tmp, "workspaces");
const repoA = join(tmp, "repo-a");
const elsewhere = join(tmp, "elsewhere");
for (const dir of [home, claudeDir, codexHome, workspacesRoot, join(workspacesRoot, "pilot"), repoA, elsewhere]) mkdirSync(dir, { recursive: true });
writeFileSync(join(workspacesRoot, "pilot.code-workspace"), JSON.stringify({ folders: [{ name: "(workspace)", path: "pilot" }, { name: "repo-a", path: "../repo-a" }] }));

process.env.HUB_DATA_DIR = join(tmp, "data");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.CODEX_HOME = codexHome;
for (const key of ["HUB_HOME", "HUB_CLAUDE_PROJECTS_DIR", "HUB_RESOURCE_DIR", "HUB_WORKSPACES_ROOT", "HUB_SECOND_BRAIN"]) delete process.env[key];

type History = typeof import("../src/history-index.js");
type Store = typeof import("../src/delegation-store.js");
type Config = typeof import("../src/config.js");
let history: History;
let store: Store;
let cfg: Config;

const projectDir = join(claudeDir, "projects", "C--repo-a");
const sessionA = "11111111-aaaa-4aaa-8aaa-000000000001";
const sessionB = "22222222-bbbb-4bbb-8bbb-000000000002";
const fileA = join(projectDir, `${sessionA}.jsonl`);
const fileB = join(projectDir, `${sessionB}.jsonl`);
const codexDay = join(codexHome, "sessions", "2026", "11", "14");
const codexFile = join(codexDay, "rollout-2026-11-14T10-00-00-cdx.jsonl");

const at = (iso: string): string => new Date(iso).toISOString();
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const user = (text: unknown, ts: string, extra: Record<string, unknown> = {}): string =>
  line({ type: "user", cwd: repoA, sessionId: sessionA, timestamp: at(ts), message: { role: "user", content: text }, ...extra });
const assistant = (content: unknown[], ts: string): string => line({ type: "assistant", cwd: repoA, sessionId: sessionA, timestamp: at(ts), message: { role: "assistant", content } });

before(async () => {
  cfg = await import("../src/config.js");
  store = await import("../src/delegation-store.js");
  history = await import("../src/history-index.js");
  store.updateSettings({ workspacesRoot });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(codexDay, { recursive: true });
});

after(() => {
  dbModule.db.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

type Db = typeof import("../src/db.js");
let dbModule: Db;

before(async () => {
  dbModule = await import("../src/db.js");
});

const rowsOf = (sessionId: string): { role: string; text: string; seq: number }[] =>
  dbModule.db
    .prepare(`SELECT m.role, m.text, m.seq FROM history_messages m JOIN history_files f ON f.id = m.file_id WHERE f.session_id = ? ORDER BY m.seq`)
    .all(sessionId) as { role: string; text: string; seq: number }[];

describe("history index", () => {
  it("reads the Claude config dir and the Codex home from the environment and uses FTS5", () => {
    assert.equal(cfg.config.claudeProjectsDir, join(claudeDir, "projects"));
    assert.equal(cfg.config.codexSessionsDir, join(codexHome, "sessions"));
    assert.equal(history.historyStatus().engine, "fts");
    assert.equal(history.historyStatus().enabled, true);
  });

  it("indexes a new file with only user prompts and assistant text, skipping tools, meta and injected lines", async () => {
    writeFileSync(
      fileA,
      [
        user("Como foi a decisão sobre o deploy do retrotrack?", "2026-11-14T10:00:00"),
        assistant([{ type: "text", text: "Decidimos subir o deploy na sexta." }, { type: "tool_use", name: "Bash", input: { command: "TOOLINPUTSECRET ls" } }], "2026-11-14T10:00:05"),
        user([{ type: "tool_result", content: "TOOLOUTPUTNOISE result" }], "2026-11-14T10:00:06"),
        user("<command-name>/clear</command-name>", "2026-11-14T10:00:07"),
        user("hidden meta prompt METAONLY", "2026-11-14T10:00:08", { isMeta: true }),
        user("<system-reminder>REMINDERNOISE</system-reminder>real follow up question", "2026-11-14T10:00:09"),
        line({ type: "ai-title", aiTitle: "Deploy decision" }),
      ].join(""),
    );
    const summary = await history.runHistoryIndex();
    assert.equal(summary.indexed >= 1, true);
    const rows = rowsOf(sessionA);
    assert.deepEqual(
      rows.map((row) => [row.role, row.text]),
      [
        ["user", "Como foi a decisão sobre o deploy do retrotrack?"],
        ["assistant", "Decidimos subir o deploy na sexta."],
        ["user", "real follow up question"],
      ],
    );
    for (const noise of ["TOOLINPUTSECRET", "TOOLOUTPUTNOISE", "METAONLY", "REMINDERNOISE", "clear"]) {
      assert.equal(history.searchHistory({ q: noise }).hits.length, 0, noise);
    }
    const hit = history.searchHistory({ q: "deploy" }).hits[0];
    assert.equal(hit?.title, "Deploy decision");
    assert.equal(hit?.sessionId, sessionA);
    assert.equal(hit?.workspace, "pilot");
    assert.equal(hit?.client, "claude");
  });

  it("skips an unchanged file and resumes from the byte offset when the file only grew", async () => {
    const second = await history.runHistoryIndex();
    assert.equal(second.rows, 0);
    assert.equal(second.skipped >= 1, true);
    const sizeBefore = statSync(fileA).size;
    appendFileSync(fileA, user("pergunta nova sobre kubernetes", "2026-11-14T11:00:00"));
    const grown = await history.runHistoryIndex();
    assert.equal(grown.rows, 1);
    assert.equal(grown.bytes, statSync(fileA).size - sizeBefore);
    const rows = rowsOf(sessionA);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3, 4]);
    assert.equal(rows[3]?.text, "pergunta nova sobre kubernetes");
  });

  it("tolerates malformed lines and waits for a partial last line to be completed", async () => {
    appendFileSync(fileA, "{not json at all\n");
    appendFileSync(fileA, line({ type: "user", message: 42 }));
    appendFileSync(fileA, JSON.stringify({ type: "user", cwd: repoA, timestamp: at("2026-11-14T12:00:00"), message: { role: "user", content: "partial line about grafana" } }));
    const partial = await history.runHistoryIndex();
    assert.equal(partial.rows, 0);
    assert.equal(history.searchHistory({ q: "grafana" }).hits.length, 0);
    appendFileSync(fileA, "\n");
    const completed = await history.runHistoryIndex();
    assert.equal(completed.rows, 1);
    assert.equal(history.searchHistory({ q: "grafana" }).hits.length, 1);
  });

  it("reindexes from scratch when the file was truncated or replaced", async () => {
    writeFileSync(fileA, user("conteudo truncado sobre redis", "2026-11-14T13:00:00"));
    const truncated = await history.runHistoryIndex();
    assert.equal(truncated.reset, 1);
    assert.deepEqual(rowsOf(sessionA).map((row) => row.text), ["conteudo truncado sobre redis"]);
    assert.equal(history.searchHistory({ q: "kubernetes" }).hits.length, 0);
    writeFileSync(fileA, `${user("outra coisa sobre mongo", "2026-11-14T13:30:00")}${user("e mais uma longa", "2026-11-14T13:31:00")}`);
    const later = new Date(Date.now() + 5000);
    utimesSync(fileA, later, later);
    const replaced = await history.runHistoryIndex();
    assert.equal(replaced.reset, 1);
    assert.deepEqual(rowsOf(sessionA).map((row) => row.text), ["outra coisa sobre mongo", "e mais uma longa"]);
    assert.equal(history.searchHistory({ q: "redis" }).hits.length, 0);
  });

  it("skips a giant tool line without losing the lines after it and caps long messages", async () => {
    const giant = line({ type: "user", cwd: repoA, message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(history.HISTORY_STEP_BYTES + 200_000) }] } });
    const long = "palavra ".repeat(1200);
    writeFileSync(fileB, `${user("antes do gigante", "2026-11-14T14:00:00")}${giant}${user("depois do gigante", "2026-11-14T14:00:02")}${user(long, "2026-11-14T14:00:03")}`);
    await history.runHistoryIndex();
    const rows = rowsOf(sessionB);
    assert.deepEqual(rows.slice(0, 2).map((row) => row.text), ["antes do gigante", "depois do gigante"]);
    assert.equal(rows[2]?.text.length, history.HISTORY_TEXT_CAP + 1);
  });

  it("redacts secrets before they reach the index", async () => {
    appendFileSync(fileB, user("use the key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 for staging", "2026-11-14T15:00:00"));
    await history.runHistoryIndex();
    const stored = rowsOf(sessionB).map((row) => row.text).join("\n");
    assert.equal(stored.includes("sk-ant-api03"), false);
    assert.equal(stored.includes("[REDACTED]"), true);
    assert.equal(history.searchHistory({ q: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" }).hits.length, 0);
    assert.equal(history.searchHistory({ q: "staging" }).hits[0]?.snippet.includes("[REDACTED]"), true);
  });

  it("indexes Codex rollouts with the same cut", async () => {
    const response = (payload: Record<string, unknown>, ts: string): string => line({ timestamp: at(ts), type: "response_item", payload });
    writeFileSync(
      codexFile,
      [
        line({ timestamp: at("2026-11-14T09:00:00"), type: "session_meta", payload: { id: "cdx-thread-1", cwd: elsewhere, originator: "codex_cli_rs" } }),
        response({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>INJECTEDCTX</environment_context>" }] }, "2026-11-14T09:00:01"),
        response({ type: "message", role: "user", content: [{ type: "input_text", text: "refatorar o parser de faturas" }] }, "2026-11-14T09:00:02"),
        response({ type: "function_call", name: "shell", arguments: "{\"command\":\"CODEXTOOLCALL\"}" }, "2026-11-14T09:00:03"),
        response({ type: "function_call_output", output: "CODEXTOOLOUT" }, "2026-11-14T09:00:04"),
        response({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Parser de faturas refatorado." }] }, "2026-11-14T09:00:05"),
        line({ timestamp: at("2026-11-14T09:00:06"), type: "event_msg", payload: { type: "user_message", message: "refatorar o parser de faturas" } }),
      ].join(""),
    );
    await history.runHistoryIndex();
    const rows = rowsOf("cdx-thread-1");
    assert.deepEqual(rows.map((row) => [row.role, row.text]), [
      ["user", "refatorar o parser de faturas"],
      ["assistant", "Parser de faturas refatorado."],
    ]);
    for (const noise of ["INJECTEDCTX", "CODEXTOOLCALL", "CODEXTOOLOUT"]) assert.equal(history.searchHistory({ q: noise }).hits.length, 0, noise);
    const hit = history.searchHistory({ q: "faturas", client: "codex" }).hits[0];
    assert.equal(hit?.title, "refatorar o parser de faturas");
    assert.equal(hit?.workspace, null);
  });

  it("filters by text, client, workspace and period, pages, groups by session and highlights the match", () => {
    assert.equal(history.searchHistory({ q: "gigante", client: "codex" }).hits.length, 0);
    assert.equal(history.searchHistory({ q: "gigante", client: "claude" }).hits.length, 2);
    assert.equal(history.searchHistory({ q: "faturas", workspace: "pilot" }).hits.length, 0);
    assert.equal(history.searchHistory({ q: "gigante", workspace: "pilot" }).hits.length, 2);
    assert.equal(history.searchHistory({ q: "gigante", workspace: "nope" }).hits.length, 0);
    const from = new Date("2026-11-14T14:00:01").getTime();
    const onlyAfter = history.searchHistory({ q: "gigante", from });
    assert.deepEqual(onlyAfter.hits.map((hit) => hit.snippet), ["depois do gigante"]);
    const onlyBefore = history.searchHistory({ q: "gigante", to: from });
    assert.deepEqual(onlyBefore.hits.map((hit) => hit.snippet), ["antes do gigante"]);
    const page1 = history.searchHistory({ q: "gigante", limit: 1, sort: "recent" });
    const page2 = history.searchHistory({ q: "gigante", limit: 1, offset: 1, sort: "recent" });
    assert.equal(page1.hasMore, true);
    assert.equal(page2.hasMore, false);
    assert.deepEqual([page1.hits[0]?.snippet, page2.hits[0]?.snippet], ["depois do gigante", "antes do gigante"]);
    const grouped = history.searchHistory({ q: "gigante", group: "session" });
    assert.equal(grouped.hits.length, 1);
    assert.equal(grouped.hits[0]?.matches, 2);
    const prefix = history.searchHistory({ q: "gigan" });
    assert.equal(prefix.hits.length, 2);
    const hit = history.searchHistory({ q: "depois" }).hits[0];
    assert.ok(hit);
    const [start, end] = hit.highlights[0] ?? [0, 0];
    assert.equal(hit.snippet.slice(start, end), "depois");
    assert.equal(typeof hit.at, "number");
  });

  it("folds accents in the query and the highlight", async () => {
    writeFileSync(join(projectDir, "33333333-cccc-4ccc-8ccc-000000000003.jsonl"), user("A decisão final foi manter o Atlas", "2026-11-14T16:00:00"));
    await history.runHistoryIndex();
    const hit = history.searchHistory({ q: "decisao final" }).hits.find((item) => item.snippet.includes("Atlas"));
    assert.ok(hit);
    assert.deepEqual(hit.highlights.map(([start, end]) => hit.snippet.slice(start, end)), ["decisão", "final"]);
  });

  it("falls back to LIKE search with the same filters", () => {
    const like = history.searchHistory({ q: "gigante", engine: "like", workspace: "pilot" });
    assert.equal(like.engine, "like");
    assert.equal(like.hits.length, 2);
    assert.equal(history.searchHistory({ q: "100%_", engine: "like" }).hits.length, 0);
  });

  it("drops files that vanished and reports the index size", async () => {
    rmSync(fileB);
    const summary = await history.runHistoryIndex();
    assert.equal(summary.removed, 1);
    assert.equal(history.searchHistory({ q: "gigante" }).hits.length, 0);
    const status = history.historyStatus();
    assert.equal(status.running, false);
    assert.equal(status.files, 3);
    assert.equal(status.rows > 0, true);
    assert.equal(status.textBytes > 0, true);
    assert.equal(status.indexBytes > 0, true);
    assert.equal(typeof status.lastBuildMs, "number");
  });

  it("returns nothing while the index is turned off and empties on clear", async () => {
    store.updateSettings({ memory: { historyIndex: false } });
    const off = history.searchHistory({ q: "faturas" });
    assert.equal(off.enabled, false);
    assert.equal(off.hits.length, 0);
    store.updateSettings({ memory: { historyIndex: true } });
    assert.equal(history.searchHistory({ q: "faturas" }).hits.length, 2);
    await history.clearHistoryIndex();
    assert.equal(history.historyStatus().rows, 0);
    assert.equal(history.searchHistory({ q: "faturas" }).hits.length, 0);
    const rebuilt = await history.rebuildHistoryIndex();
    assert.equal(rebuilt.rows > 0, true);
    assert.equal(history.searchHistory({ q: "faturas" }).hits.length, 2);
  });
});

describe("history workspace names", () => {
  const contextSession = "44444444-dddd-4ddd-8ddd-000000000004";
  const contextDir = join(workspacesRoot, "pilot");
  let server: Server;
  let base = "";

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/delegation/memory", (await import("../src/memory-routes.js")).memoryRouter());
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/delegation/memory`;
    writeFileSync(
      join(projectDir, `${contextSession}.jsonl`),
      line({ type: "user", cwd: contextDir, sessionId: contextSession, timestamp: at("2026-11-14T18:00:00"), message: { role: "user", content: "pergunta no contexto do workspace sobre zeppelin" } }),
    );
    await history.runHistoryIndex();
  });

  after(() => {
    server.close();
  });

  it("names the workspace of a session started in the workspace context folder", () => {
    const hit = history.searchHistory({ q: "zeppelin" }).hits[0];
    assert.equal(hit?.cwd, contextDir);
    assert.equal(hit?.workspace, "pilot");
    assert.equal(history.searchHistory({ q: "zeppelin", workspace: "pilot" }).hits.length, 1);
  });

  it("filters by the workspace value the UI sends, as written in the shared contract", async () => {
    const contract = JSON.parse(readFileSync(join(fixtures, "history-workspace-filter.json"), "utf8")) as { selected: string; param: string; value: string };
    const params = new URLSearchParams({ q: "zeppelin", [contract.param]: contract.value });
    const res = await fetch(`${base}/history/search?${params.toString()}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hits: { workspace: string | null; cwd: string | null }[] };
    assert.equal(body.hits.length, 1);
    assert.deepEqual(body.hits.map((hit) => hit.workspace), [contract.selected]);
    const repoQuery = new URLSearchParams({ q: "Atlas", [contract.param]: contract.value });
    const repoHits = (await (await fetch(`${base}/history/search?${repoQuery.toString()}`)).json()) as { hits: { workspace: string | null }[] };
    assert.equal(repoHits.hits.length > 0, true);
    assert.equal(repoHits.hits.every((hit) => hit.workspace === contract.selected), true);
  });

  it("reports the size of the index tables alone, measured by SQLite", () => {
    const status = history.historyStatus();
    assert.equal(status.indexBytesEstimated, false);
    assert.equal(status.indexBytes > 0, true);
    const whole = statSync(cfg.config.dbPath).size + (existsSync(`${cfg.config.dbPath}-wal`) ? statSync(`${cfg.config.dbPath}-wal`).size : 0);
    assert.equal(status.indexBytes < whole, true);
  });
});
