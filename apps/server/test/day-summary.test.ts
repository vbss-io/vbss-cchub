import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "cch-g3-summary-"));
const home = join(tmp, "home");
const brain = join(tmp, "brain");
const workspacesRoot = join(tmp, "workspaces");
const repoA = join(tmp, "repo-a");
const notRepo = join(tmp, "not-a-repo");
const snapshots = join(tmp, "snapshots");
const gitConfig = join(tmp, "gitconfig");
for (const dir of [home, join(brain, "daily"), join(brain, "trail"), join(brain, "projects"), join(workspacesRoot, "pilot"), repoA, notRepo]) mkdirSync(dir, { recursive: true });
writeFileSync(gitConfig, "");
writeFileSync(
  join(workspacesRoot, "pilot.code-workspace"),
  JSON.stringify({ folders: [{ name: "(workspace)", path: "pilot" }, { name: "repo-a", path: "../repo-a" }, { name: "plain", path: "../not-a-repo" }] }),
);

process.env.HUB_DATA_DIR = join(tmp, "data");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_CONFIG_DIR = join(tmp, "claude");
process.env.CODEX_HOME = join(tmp, "codex");
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const key of ["HUB_HOME", "HUB_RESOURCE_DIR", "HUB_WORKSPACES_ROOT", "HUB_SECOND_BRAIN"]) delete process.env[key];

type Summary = typeof import("../src/day-summary.js");
type Store = typeof import("../src/delegation-store.js");
type Db = typeof import("../src/db.js");
type Snap = typeof import("../src/vault-snapshot.js");
type Sse = typeof import("../src/sse.js");
let summary: Summary;
let store: Store;
let dbModule: Db;
let snap: Snap;
let sse: Sse;

const pad = (value: number): string => String(value).padStart(2, "0");
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const dailyPath = join(brain, "daily", `${today}.md`);
const SESSION_A = "aaaa1111-0000-4000-8000-000000000001";
const SESSION_B = "bbbb2222-0000-4000-8000-000000000002";
const CHECKBOX_RE = /^\s*[-*+]\s+\[[ xX-]\]/m;

const git = (...args: string[]): string =>
  execFileSync("git", ["-C", repoA, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Tester", GIT_AUTHOR_EMAIL: "tester@example.invalid", GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "tester@example.invalid" },
  });

const DAILY_BASE = [
  "---",
  `date: ${today}`,
  "---",
  "",
  "## Focus",
  "",
  `- [ ] open thing ⏳ ${today}`,
  `- [x] closed in the daily ✅ ${today}`,
  "",
  "## Notes",
  "",
  "free text the user wrote",
  "",
].join("\n");

before(async () => {
  store = await import("../src/delegation-store.js");
  dbModule = await import("../src/db.js");
  summary = await import("../src/day-summary.js");
  snap = await import("../src/vault-snapshot.js");
  sse = await import("../src/sse.js");
  snap.enableVaultSnapshots(snapshots);
  store.updateSettings({ workspacesRoot, secondBrainRoot: brain, features: { daily: true, tasks: true } });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repoA, "a.txt"), "a");
  git("add", "a.txt");
  git("commit", "-q", "-m", "feat: add the alpha file");
  writeFileSync(
    join(brain, "trail", `${today}.md`),
    [
      "# Sessions",
      "",
      `<!-- session:${SESSION_A} START -->`,
      "",
      "## `aaaa1111` · 09:05 → 09:40 · 10 turns",
      "",
      `\`${repoA}\``,
      "",
      "- fixed the flaky parser test",
      "- [ ] looks like a checkbox",
      "",
      `<!-- session:${SESSION_A} END -->`,
      "",
      `<!-- session:${SESSION_B} START -->`,
      "",
      "## `bbbb2222` · 08:00 → 08:10 · 2 turns",
      "",
      "`C:/somewhere/else`",
      "",
      "- explored the backup script",
      "",
      `<!-- session:${SESSION_B} END -->`,
      "",
    ].join("\n"),
  );
  dbModule.applyHook({
    kind: "session_start",
    sessionId: SESSION_A,
    cwd: repoA,
    source: null,
    hostPid: null,
    shellPid: null,
    title: "Parser cleanup",
    message: null,
    notificationType: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    contextTokens: null,
    agentId: null,
    agentType: null,
    client: "terminal",
    claudePid: null,
    transcriptPath: null,
    agentMessage: null,
    shareLabel: null,
  });
  writeFileSync(
    join(brain, "projects", "pilot.md"),
    ["---", "workspace: pilot", "title: Pilot", "---", "", "## Open loops", "", "- [ ] still open", "", "## Done loops", "", `- [x] ship the parser ✅ ${today} #p1`, "- [x] ancient work ✅ 2020-01-01", ""].join("\n"),
  );
  store.createReport({ taskId: null, sessionId: null, workspace: "pilot", kind: "result", text: "Parser shipped to prd\nsecond line", source: "test" });
  writeFileSync(dailyPath, DAILY_BASE);
});

after(() => {
  dbModule.db.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const blockOf = (content: string): string => {
  const start = content.indexOf(summary.DAY_SUMMARY_START);
  const end = content.indexOf(summary.DAY_SUMMARY_END);
  return content.slice(start, end + summary.DAY_SUMMARY_END.length);
};

describe("day summary", () => {
  it("composes a deterministic block from trail, done tasks, reports and commits without checkboxes", async () => {
    const settings = store.getSettings();
    const first = await summary.composeDaySummary(settings, today);
    const second = await summary.composeDaySummary(settings, today);
    assert.equal(first.markdown, second.markdown);
    assert.equal(first.heading, "Day summary");
    assert.ok(first.markdown.startsWith("## Day summary\n\n<!-- cchub:day-summary START -->"));
    const block = first.block;
    assert.match(block, /^- pilot · 09:05 · Parser cleanup \(claude\)$/m);
    assert.match(block, /^ {2}- fixed the flaky parser test$/m);
    assert.match(block, /^ {2}- \\\[ \] looks like a checkbox$/m);
    assert.match(block, /^- other · 08:00 · session bbbb2222 \(claude\)$/m);
    assert.ok(block.indexOf("- pilot ·") < block.indexOf("- other ·"));
    assert.match(block, /^- Pilot: ship the parser$/m);
    assert.match(block, /^- closed in the daily$/m);
    assert.doesNotMatch(block, /ancient work|still open|open thing/);
    assert.match(block, /^- \d{2}:\d{2} · pilot · result: Parser shipped to prd$/m);
    assert.match(block, /^- pilot · repo-a `[0-9a-f]{7,}` feat: add the alpha file$/m);
    assert.doesNotMatch(block, CHECKBOX_RE);
    assert.doesNotMatch(block, /✅/);
    assert.equal(first.commits.length, 1);
    assert.equal(first.empty, false);
  });

  it("appends the heading and the block at the end of a note that has no heading, with a snapshot first", async () => {
    const events: string[] = [];
    const stop = sse.onBroadcast((event) => events.push(event));
    const result = await summary.writeDaySummary(store.getSettings(), today);
    stop();
    assert.equal(result.changed, true);
    const content = readFileSync(dailyPath, "utf8");
    assert.ok(content.startsWith(DAILY_BASE));
    assert.equal(content, `${DAILY_BASE}\n## Day summary\n\n${result.summary.block}\n`);
    assert.ok(events.includes("daily"));
    const day = readdirSync(snapshots)[0];
    assert.ok(day);
    assert.equal(readFileSync(join(snapshots, day, "daily", `${today}.md`), "utf8"), DAILY_BASE);
    assert.equal(readdirSync(join(brain, "daily")).filter((name) => name.endsWith(".tmp")).length, 0);
  });

  it("rewrites only its own block and never another part of the note", async () => {
    const before = readFileSync(dailyPath, "utf8");
    const edited = before.replace("free text the user wrote", "free text the user wrote\nand a new line from Obsidian");
    const withTail = `${edited}\n## Later\n\nuser text after the summary\n`;
    writeFileSync(dailyPath, withTail);
    store.createReport({ taskId: null, sessionId: null, workspace: "pilot", kind: "note", text: "second report", source: "test" });
    const result = await summary.writeDaySummary(store.getSettings(), today);
    assert.equal(result.changed, true);
    const after = readFileSync(dailyPath, "utf8");
    const oldBlock = blockOf(withTail);
    const newBlock = blockOf(after);
    assert.notEqual(oldBlock, newBlock);
    assert.match(newBlock, /note: second report/);
    assert.equal(after, withTail.replace(oldBlock, newBlock));
    assert.equal(after.split("## Day summary").length, 2);
    const again = await summary.writeDaySummary(store.getSettings(), today);
    assert.equal(again.changed, false);
  });

  it("places the block under an existing heading without markers and keeps CRLF notes in CRLF", () => {
    const crlf = ["# Day", "", "## Day summary", "", "my own words", "", "## End", ""].join("\r\n");
    const block = `${summary.DAY_SUMMARY_START}\n**Sessions**\n\n- one\n${summary.DAY_SUMMARY_END}`;
    const placed = summary.applySummaryBlock(crlf, "Day summary", block);
    assert.equal(placed, ["# Day", "", "## Day summary", "", ...block.split("\n"), "", "my own words", "", "## End", ""].join("\r\n"));
    assert.doesNotMatch(placed.replace(/\r\n/g, ""), /\n/);
    const replaced = summary.applySummaryBlock(placed, "Day summary", block.replace("- one", "- two"));
    assert.equal(replaced, placed.replace("- one", "- two"));
    assert.equal(summary.applySummaryBlock("", "Resumo", block), `## Resumo\n\n${block}\n`);
    assert.equal(summary.applySummaryBlock("text without newline", "Resumo", block), `text without newline\n\n## Resumo\n\n${block}\n`);
  });

  it("refuses to write without a daily note or with the daily feature off", async () => {
    const tomorrowDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const tomorrow = `${tomorrowDate.getFullYear()}-${pad(tomorrowDate.getMonth() + 1)}-${pad(tomorrowDate.getDate())}`;
    await assert.rejects(summary.writeDaySummary(store.getSettings(), tomorrow), /does not exist yet/);
    assert.equal(existsSync(join(brain, "daily", `${tomorrow}.md`)), false);
    store.updateSettings({ features: { daily: false } });
    await assert.rejects(summary.writeDaySummary(store.getSettings(), today), /daily feature is disabled/);
    store.updateSettings({ features: { daily: true } });
  });

  it("says when nothing happened on a day", async () => {
    const empty = await summary.composeDaySummary(store.getSettings(), "2001-02-03");
    assert.equal(empty.empty, true);
    assert.equal(empty.block, `${summary.DAY_SUMMARY_START}\n_Nothing recorded for this day yet._\n${summary.DAY_SUMMARY_END}`);
  });

  it("formats the git bounds with the local offset", () => {
    const iso = summary.isoWithOffset(new Date(2026, 10, 15));
    assert.match(iso, /^2026-11-15T00:00:00[+-]\d{2}:\d{2}$/);
  });
});
