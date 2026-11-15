import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { after, before, describe, it } from "node:test";
import { fixtures } from "./helpers.js";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-golden-data-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.HUB_WORKSPACES_ROOT;
delete process.env.HUB_EDITOR;
delete process.env.HUB_SECOND_BRAIN;

type Board = typeof import("../src/tasks-board.js");
type Daily = typeof import("../src/daily.js");
type Today = typeof import("../src/today.js");
type BoardTask = import("../src/tasks-board.js").BoardTask;
let board: Board;
let daily: Daily;
let today: Today;

before(async () => {
  board = await import("../src/tasks-board.js");
  daily = await import("../src/daily.js");
  today = await import("../src/today.js");
});

const GOLDEN = join(fixtures, "vault-golden");
const BOM = String.fromCharCode(0xfeff);
const FIXTURE_FILES = [
  "_templates/daily.md",
  "daily/2026-11-10.md",
  "daily/2026-11-11.md",
  "daily/2026-11-12.md",
  "insert-after.md",
  "insert-fence-unclosed.md",
  "insert-fence.md",
  "projects/_about.md",
  "projects/acme/acme.md",
  "projects/alex-personal.md",
  "projects/globex/globex.md",
  "projects/initech.md",
  "signifier-order.md",
];
const PROJECT_FILES = ["acme/acme", "alex-personal", "globex/globex", "initech"];
const DAILY_DATES = ["2026-11-10", "2026-11-11", "2026-11-12"];
const sandboxes: string[] = [];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name !== ".gitattributes") out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  visit(dir);
  return out.sort();
}

function digestOf(dir: string): Record<string, string> {
  return Object.fromEntries(listFiles(dir).map((rel) => [rel, createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex")]));
}

const goldenDigest = digestOf(GOLDEN);

function freshVault(): string {
  const root = mkdtempSync(join(tmpdir(), "cch-golden-vault-"));
  sandboxes.push(root);
  cpSync(GOLDEN, root, { recursive: true });
  return root;
}

function settingsFor(root: string): DelegationSettings {
  return {
    workspacesRoot: null,
    editorCommand: "code",
    secondBrainRoot: root,
    autonomy: "full",
    ownerName: "alex",
    runTimeoutMinutes: 60,
    features: { daily: true, trail: false, usage: false, limits: false, tasks: true, flow: false, delegated: false, workspaces: false, reports: false, share: false, widget: false },
    tasks: {
      root: "projects",
      section: "Open loops",
      prefixes: { blocked: ["BLOCK", "BLOCKED"], hold: ["HOLD"], archived: ["ARCHIVED"] },
      separator: " - ",
      exclude: ["_*"],
      workspaceKey: "workspace",
      parentKey: "parent",
      delegatePrompt: null,
      markDoingOnDelegate: true,
      reasonSeparator: " - ",
      doneSection: "Done loops",
      doneStamp: " ✅ {{date}}",
      priorityTag: "p",
      priorityLevels: 4,
    },
    daily: {
      dir: "daily",
      template: "_templates/daily.md",
      prompt: null,
      runner: "claude",
      headings: { focus: "Focus", meetings: "Meetings", sessions: "Sessions" },
      closedKey: "closed",
      wikilinks: true,
      projectOrder: [],
    },
    trail: { dir: null, detail: "light", model: "haiku", prompt: null, hubEvents: true },
    widget: { edge: "right", rings: { claude: false, codex: false }, panel: "sessions", autostart: true },
    limits: { claude: false, codex: false, codexLive: false, refreshMinutes: 5 },
    usage: { days: 7 },
  };
}

function flatten(tasks: BoardTask[]): BoardTask[] {
  return tasks.flatMap((task) => [task, ...flatten(task.subtasks)]);
}

function pathOf(root: string, projectId: string): string {
  return join(root, "projects", `${projectId}.md`);
}

function taskNamed(root: string, projectId: string, title: string): BoardTask {
  const found = flatten(board.readBoard(settingsFor(root)).tasks).find((task) => task.projectId === projectId && task.title === title);
  assert.ok(found, `${projectId}: ${title}`);
  return found;
}

function withEol(text: string): string[] {
  return text.split(/(?<=\n)/);
}

function changedLines(before: string, after: string): number[] {
  const left = withEol(before);
  const right = withEol(after);
  assert.equal(right.length, left.length, "line count must not change");
  return left.flatMap((line, index) => (line === right[index] ? [] : [index]));
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function sectionFrom(content: string, heading: string): string {
  const index = content.indexOf(`## ${heading}`);
  assert.notEqual(index, -1, heading);
  return content.slice(index);
}

after(async () => {
  (await import("../src/db.js")).db.close();
  for (const dir of [dataDir, ...sandboxes]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("golden vault fixture", () => {
  it("contains exactly the expected files", () => {
    assert.deepEqual(listFiles(GOLDEN), FIXTURE_FILES);
  });

  it("keeps the byte-level traits the round-trip depends on", () => {
    const bytes = (rel: string): Buffer => readFileSync(join(GOLDEN, rel));
    for (const rel of ["projects/initech.md", "daily/2026-11-11.md"]) {
      assert.deepEqual([...bytes(rel).subarray(0, 3)], [0xef, 0xbb, 0xbf], rel);
      assert.equal(bytes(rel).toString("utf8").includes("\r"), false, rel);
    }
    for (const rel of ["projects/alex-personal.md", "daily/2026-11-10.md"]) {
      const text = bytes(rel).toString("utf8");
      assert.ok(text.includes("\r\n"), rel);
      assert.equal(text.replace(/\r\n/g, "").includes("\n"), false, rel);
    }
    for (const rel of ["projects/acme/acme.md", "projects/globex/globex.md", "daily/2026-11-12.md", "_templates/daily.md"]) {
      assert.equal(bytes(rel).toString("utf8").includes("\r"), false, rel);
    }
  });

  after(() => {
    assert.deepEqual(digestOf(GOLDEN), goldenDigest, "the committed fixture must never be written to");
  });
});

describe("golden vault: tasks parse", () => {
  const root = freshVault();
  let payload: ReturnType<Board["readBoard"]>;
  let tasks: BoardTask[] = [];

  before(() => {
    payload = board.readBoard(settingsFor(root));
    tasks = flatten(payload.tasks);
  });

  const byTitle = (projectId: string, title: string): BoardTask => {
    const found = tasks.find((task) => task.projectId === projectId && task.title === title);
    assert.ok(found, `${projectId}: ${title}`);
    return found;
  };

  it("discovers the projects, the folder hierarchy, the parent key and the workspace inheritance", () => {
    assert.deepEqual(payload.errors, []);
    assert.equal(payload.root, join(root, "projects"));
    assert.deepEqual(
      payload.projects.map((project) => [project.id, project.title, project.parent, project.depth, project.workspace, project.workspaceSource]),
      [
        ["acme/acme", "Acme Platform", null, 0, "acme-wk", "own"],
        ["globex/globex", "Globex Rollout", "acme/acme", 1, "acme-wk", "inherited"],
        ["alex-personal", "Alex Personal", null, 0, "personal", "own"],
        ["initech", "Initech Sandbox", null, 0, null, null],
      ],
    );
  });

  it("anchors every parsed task to the exact bytes of its line, including the BOM and CRLF files", () => {
    for (const projectId of PROJECT_FILES) {
      const lines = readFileSync(pathOf(root, projectId), "utf8").replace(BOM, "").split(/\r\n|\n/);
      const own = tasks.filter((task) => task.projectId === projectId);
      assert.ok(own.length > 0, projectId);
      for (const task of own) assert.equal(lines[task.line], task.raw, `${projectId}:${task.line}`);
    }
  });

  it("reads checkboxes, nesting, notes and the group of the open loops", () => {
    const migrate = byTitle("acme/acme", "Migrate billing service");
    assert.equal(migrate.status, "doing");
    assert.equal(migrate.priority, 0);
    assert.equal(migrate.start, "2026-11-02");
    assert.equal(migrate.due, "2026-11-20");
    assert.deepEqual(migrate.subtasks.map((task) => [task.title, task.status]), [
      ["Export legacy invoices", "done"],
      ["Map the new tax codes", "doing"],
      ["Cut over the webhook", "todo"],
    ]);
    const tax = migrate.subtasks[1];
    assert.deepEqual(tax?.notes, ["note under a subtask"]);
    assert.deepEqual(tax?.subtasks.map((task) => task.title), ["Validate rounding rules"]);
    const renew = byTitle("acme/acme", "Renew vendor contract");
    assert.equal(renew.priority, 1);
    assert.equal(renew.due, "2026-11-30");
    assert.equal(renew.notes.length, 2);
    assert.equal(renew.group, null);
    assert.equal(byTitle("acme/acme", "Plain task without priority").priority, null);
    assert.equal(byTitle("acme/acme", "Publish the status page").group, "Blocked and parked");
  });

  it("reads BLOCK, BLOCKED, BLOCK:, HOLD and ARCHIVED with their reasons and priorities", () => {
    const expected: [string, string, string | null, string | null, number | null, string][] = [
      ["Publish the status page", "blocked", "BLOCK", "waiting for the DNS change", 1, " "],
      ["Rotate signing keys", "blocked", "BLOCKED", "security window not scheduled", null, " "],
      ["Fix the SSO redirect", "blocked", "BLOCK", "vendor patch pending", null, " "],
      ["Payment retries", "hold", "HOLD", "waiting on the Initech sandbox account", 2, " "],
      ["Hire a designer", "hold", "HOLD", "budget freeze until Q1", 3, "-"],
      ["Old onboarding flow", "archived", "ARCHIVED", "replaced by the new wizard", null, " "],
      ["Legacy export job", "archived", "ARCHIVED", "dropped", null, "x"],
    ];
    for (const [title, status, prefix, reason, priority, mark] of expected) {
      const task = byTitle("acme/acme", title);
      assert.equal(task.status, status, title);
      assert.equal(task.prefix, prefix, title);
      assert.equal(task.reason, reason, title);
      assert.equal(task.priority, priority, title);
      assert.equal(task.raw.match(/^- \[(.)\]/)?.[1], mark, title);
    }
    const backlog = byTitle("acme/acme", "BACKLOG - Banner copy review");
    assert.equal(backlog.status, "todo");
    assert.equal(backlog.prefix, null);
  });

  it("reads the Obsidian Tasks dates and the recurrence", () => {
    const weekly = tasks.find((task) => task.projectId === "acme/acme" && task.title === "Weekly report" && task.section === "open");
    assert.deepEqual([weekly?.repeat, weekly?.start, weekly?.due, weekly?.priority], ["every week", "2026-11-09", "2026-11-13", 2]);
    const weekday = byTitle("acme/acme", "Review dashboards");
    assert.deepEqual([weekday.repeat, weekday.start, weekday.scheduled, weekday.due], ["every weekday", null, null, "2026-11-13"]);
    const follow = byTitle("acme/acme", "Follow up on the audit");
    assert.deepEqual([follow.scheduled, follow.due, follow.repeat], ["2026-11-14", "2026-11-16", null]);
    const monthly = byTitle("globex/globex", "Monthly invoice reconciliation");
    assert.deepEqual([monthly.repeat, monthly.due], ["every month", "2026-11-30"]);
  });

  it("reads the Done loops with their stamps and leaves Decisões and Links out of the board", () => {
    const done = tasks.filter((task) => task.projectId === "acme/acme" && task.section === "done");
    assert.deepEqual(
      done.filter((task) => task.depth === 0).map((task) => [task.title, task.doneAt]),
      [
        ["Security: audit and dependency bumps", "2026-11-09"],
        ["Docs: refresh the onboarding guide", "2026-11-03"],
        ["Weekly report", "2026-11-06"],
        ["Infra: move the cache to the new region", "2026-10-27"],
      ],
    );
    assert.equal(done.find((task) => task.title === "Docs: refresh the onboarding guide")?.priority, 2);
    assert.equal(tasks.some((task) => task.title.includes("not a task") || task.title.includes("neither is this")), false);
    assert.equal(tasks.filter((task) => task.projectId === "acme/acme").length, 26);
  });

  it("reads the BOM project and the CRLF project like any other", () => {
    assert.equal(byTitle("initech", "Confirm sandbox credentials").priority, 2);
    assert.equal(byTitle("initech", "Sign the data agreement").status, "hold");
    assert.equal(byTitle("alex-personal", "Plan the quarter").due, "2026-12-01");
    assert.equal(byTitle("alex-personal", "Book the course").reason, "registration opens in December");
    assert.deepEqual(byTitle("alex-personal", "Plan the quarter").notes, ["draft the goals first"]);
  });
});

describe("golden vault: tasks round-trip", () => {
  it("rewrites every task with its own status and gives back the same bytes", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const before = new Map(PROJECT_FILES.map((projectId) => [projectId, readFileSync(pathOf(root, projectId))]));
    let attempted = 0;
    let locked = 0;
    for (const task of flatten(board.readBoard(settings).tasks)) {
      if (task.section === "done" && task.repeat !== null) {
        assert.throws(() => board.writeBoardTask(settings, { projectId: task.projectId, line: task.line, raw: task.raw, status: task.status }), /finished occurrence of a recurring task/);
        locked += 1;
        continue;
      }
      const result = board.writeBoardTask(settings, { projectId: task.projectId, line: task.line, raw: task.raw, status: task.status });
      assert.equal(result.task.raw, task.raw, `${task.id} ${task.raw}`);
      assert.equal(result.moved, false, task.id);
      assert.equal(readFileSync(pathOf(root, task.projectId)).equals(before.get(task.projectId) as Buffer), true, `${task.id} ${task.raw}`);
      attempted += 1;
    }
    assert.equal(locked, 1);
    assert.equal(attempted, 44);
    for (const projectId of PROJECT_FILES) {
      assert.equal(readFileSync(pathOf(root, projectId)).equals(before.get(projectId) as Buffer), true, projectId);
    }
    assert.deepEqual(digestOf(root), goldenDigest);
  });

  it("changes a status and puts it back for every open task without a status prefix, ending on the original bytes", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    for (const task of flatten(board.readBoard(settings).tasks).filter((entry) => entry.section === "open" && entry.prefix === null)) {
      const flipped = task.status === "doing" ? "todo" : "doing";
      const there = board.writeBoardTask(settings, { projectId: task.projectId, line: task.line, raw: task.raw, status: flipped });
      assert.notEqual(there.task.raw, task.raw, task.raw);
      const back = board.writeBoardTask(settings, { projectId: task.projectId, line: there.task.line, raw: there.task.raw, status: task.status });
      assert.equal(back.task.raw, task.raw, task.raw);
    }
    assert.deepEqual(digestOf(root), goldenDigest);
  });
});

describe("golden vault: a status write changes only the expected line", () => {
  const cases: [string, string, BoardTask["status"], string][] = [
    ["acme/acme", "Plain task without priority", "doing", "- [-] Plain task without priority"],
    ["acme/acme", "Renew vendor contract", "blocked", "- [ ] BLOCK - Renew vendor contract #p1 📅 2026-11-30"],
    ["acme/acme", "Migrate billing service", "todo", "- [ ] Migrate billing service #p0 🛫 2026-11-02 📅 2026-11-20"],
    ["acme/acme", "Publish the status page", "todo", "- [ ] Publish the status page - waiting for the DNS change #p1"],
    ["acme/acme", "Payment retries", "doing", "- [-] Payment retries - waiting on the Initech sandbox account #p2"],
    ["acme/acme", "Old onboarding flow", "hold", "- [ ] HOLD - Old onboarding flow - replaced by the new wizard"],
    ["acme/acme", "Map the new tax codes", "done", "  - [x] Map the new tax codes"],
    ["acme/acme", "Export legacy invoices", "todo", "  - [ ] Export legacy invoices"],
    ["acme/acme", "Review dashboards", "doing", "- [-] Review dashboards 🔁 every weekday 📅 2026-11-13"],
    ["globex/globex", "Load test", "todo", "  - [ ] Load test - waiting on the Initech sandbox account"],
    ["initech", "Confirm sandbox credentials", "doing", "- [-] Confirm sandbox credentials #p2"],
    ["alex-personal", "Reading list", "todo", "- [ ] Reading list #p3"],
    ["alex-personal", "Book the course", "archived", "- [ ] ARCHIVED - Book the course - registration opens in December"],
  ];

  for (const [projectId, title, status, expected] of cases) {
    it(`${projectId}: ${title} -> ${status}`, () => {
      const root = freshVault();
      const settings = settingsFor(root);
      const original = readFileSync(pathOf(root, projectId), "utf8");
      const task = taskNamed(root, projectId, title);
      const result = board.writeBoardTask(settings, { projectId, line: task.line, raw: task.raw, status });
      assert.equal(result.moved, false);
      const written = readFileSync(pathOf(root, projectId), "utf8");
      assert.deepEqual(changedLines(original, written), [task.line]);
      const eol = original.includes("\r\n") ? "\r\n" : "\n";
      assert.equal(withEol(written)[task.line], `${expected}${eol}`);
      assert.equal(result.task.raw, expected);
      const others = listFiles(root).filter((rel) => rel !== `projects/${projectId}.md`);
      for (const rel of others) assert.equal(digestOf(root)[rel], goldenDigest[rel], rel);
    });
  }
});

describe("golden vault: creating a task right after an anchor", () => {
  const FIXTURE = "insert-after.md";
  const PROJECT = "insert-after";
  const insertVault = (): string => {
    const root = freshVault();
    cpSync(join(GOLDEN, FIXTURE), pathOf(root, PROJECT));
    return root;
  };
  const spliceAt = (content: string, index: number, line: string): string => {
    const lines = withEol(content);
    lines.splice(index, 0, `${line}\n`);
    return lines.join("");
  };
  const linesOf = (root: string): string[] => readFileSync(pathOf(root, PROJECT), "utf8").split("\n");

  it("puts the sibling right below a top-level task even when a group heading follows the section tasks", () => {
    const root = insertVault();
    const original = readFileSync(pathOf(root, PROJECT), "utf8");
    const anchor = taskNamed(root, PROJECT, "Review the budget");
    const result = board.createBoardTask(settingsFor(root), { projectId: PROJECT, title: "Enter sibling probe", scheduled: "2026-11-14", after: { line: anchor.line, raw: anchor.raw } });
    assert.equal(result.task.line, anchor.line + 1);
    assert.equal(result.task.raw, "- [ ] Enter sibling probe ⏳ 2026-11-14");
    assert.equal(result.task.group, null);
    assert.equal(readFileSync(pathOf(root, PROJECT), "utf8"), spliceAt(original, anchor.line + 1, "- [ ] Enter sibling probe ⏳ 2026-11-14"));
    for (const rel of listFiles(root).filter((entry) => entry !== `projects/${PROJECT}.md`)) assert.equal(digestOf(root)[rel], goldenDigest[rel], rel);
  });

  it("goes below the whole block of a task with subtasks and notes", () => {
    const root = insertVault();
    const original = readFileSync(pathOf(root, PROJECT), "utf8");
    const anchor = taskNamed(root, PROJECT, "Plan the launch");
    const result = board.createBoardTask(settingsFor(root), { projectId: PROJECT, title: "After the block", after: { line: anchor.line, raw: anchor.raw } });
    assert.equal(result.task.line, anchor.line + 5);
    assert.equal(result.task.depth, 0);
    assert.equal(readFileSync(pathOf(root, PROJECT), "utf8"), spliceAt(original, anchor.line + 5, "- [ ] After the block"));
    assert.equal(linesOf(root)[anchor.line + 4], "  - [ ] Book the venue");
    assert.equal(linesOf(root)[anchor.line + 6], "- [-] Review the budget ⏳ 2026-11-14");
  });

  it("goes after the last top-level task of the section when a group heading follows it", () => {
    const root = insertVault();
    const original = readFileSync(pathOf(root, PROJECT), "utf8");
    const anchor = taskNamed(root, PROJECT, "Call the vendor");
    const result = board.createBoardTask(settingsFor(root), { projectId: PROJECT, title: "Tail probe", after: { line: anchor.line, raw: anchor.raw } });
    assert.equal(result.task.line, anchor.line + 1);
    assert.equal(result.task.group, null);
    assert.equal(readFileSync(pathOf(root, PROJECT), "utf8"), spliceAt(original, anchor.line + 1, "- [ ] Tail probe"));
  });

  it("creates a sibling subtask below a subtask and below its notes when the parent is given", () => {
    const root = insertVault();
    const original = readFileSync(pathOf(root, PROJECT), "utf8");
    const parent = taskNamed(root, PROJECT, "Plan the launch");
    const anchor = taskNamed(root, PROJECT, "Draft the announcement");
    const result = board.createBoardTask(settingsFor(root), {
      projectId: PROJECT,
      title: "Proofread",
      parentLine: parent.line,
      parentRaw: parent.raw,
      after: { line: anchor.line, raw: anchor.raw },
    });
    assert.equal(result.task.line, anchor.line + 2);
    assert.equal(result.task.raw, "  - [ ] Proofread");
    assert.equal(result.task.depth, 1);
    assert.equal(readFileSync(pathOf(root, PROJECT), "utf8"), spliceAt(original, anchor.line + 2, "  - [ ] Proofread"));
    const listed = taskNamed(root, PROJECT, "Plan the launch");
    assert.deepEqual(listed.subtasks.map((subtask) => subtask.title), ["Draft the announcement", "Proofread", "Book the venue"]);
  });

  it("creates a sibling at the indentation of a subtask anchor without a parent", () => {
    const root = insertVault();
    const original = readFileSync(pathOf(root, PROJECT), "utf8");
    const anchor = taskNamed(root, PROJECT, "Book the venue");
    const result = board.createBoardTask(settingsFor(root), { projectId: PROJECT, title: "Print the badges", after: { line: anchor.line, raw: anchor.raw } });
    assert.equal(result.task.raw, "  - [ ] Print the badges");
    assert.equal(readFileSync(pathOf(root, PROJECT), "utf8"), spliceAt(original, anchor.line + 1, "  - [ ] Print the badges"));
  });

  it("keeps the CRLF endings and the BOM of the files while inserting", () => {
    for (const projectId of ["alex-personal", "initech"]) {
      const root = freshVault();
      const original = readFileSync(pathOf(root, projectId), "utf8");
      const eol = original.includes("\r\n") ? "\r\n" : "\n";
      const anchor = flatten(board.readBoard(settingsFor(root)).tasks).find((task) => task.projectId === projectId && task.depth === 0 && task.subtasks.length + task.noteItems.length > 0) as BoardTask;
      const result = board.createBoardTask(settingsFor(root), { projectId, title: "Inserted", after: { line: anchor.line, raw: anchor.raw } });
      const written = readFileSync(pathOf(root, projectId), "utf8");
      const expected = withEol(original);
      expected.splice(result.task.line, 0, `- [ ] Inserted${eol}`);
      assert.equal(written, expected.join(""), projectId);
      assert.equal(written.startsWith(BOM), original.startsWith(BOM), projectId);
      assert.equal(result.task.line, anchor.line + 1 + anchor.noteItems.length + flatten(anchor.subtasks).length, projectId);
    }
  });

  it("refuses a stale anchor without writing a byte", () => {
    const root = insertVault();
    const before = readFileSync(pathOf(root, PROJECT));
    const anchor = taskNamed(root, PROJECT, "Review the budget");
    assert.throws(
      () => board.createBoardTask(settingsFor(root), { projectId: PROJECT, title: "Nope", after: { line: anchor.line, raw: `${anchor.raw} edited` } }),
      (err: unknown) => err instanceof board.TaskConflictError,
    );
    assert.equal(readFileSync(pathOf(root, PROJECT)).equals(before), true);
  });

  it("refuses an anchor that is not a direct subtask of the given parent, a done anchor and a done status", () => {
    const root = insertVault();
    const before = readFileSync(pathOf(root, PROJECT));
    const parent = taskNamed(root, PROJECT, "Plan the launch");
    const other = taskNamed(root, PROJECT, "Review the budget");
    const settings = settingsFor(root);
    assert.throws(
      () => board.createBoardTask(settings, { projectId: PROJECT, title: "X", parentLine: parent.line, parentRaw: parent.raw, after: { line: other.line, raw: other.raw } }),
      /not a subtask of the parent/,
    );
    const finished = taskNamed(root, PROJECT, "Close the previous round");
    assert.throws(() => board.createBoardTask(settings, { projectId: PROJECT, title: "X", after: { line: finished.line, raw: finished.raw } }), /open section/);
    assert.throws(() => board.createBoardTask(settings, { projectId: PROJECT, title: "X", status: "done", after: { line: other.line, raw: other.raw } }), /cannot start done/);
    assert.equal(readFileSync(pathOf(root, PROJECT)).equals(before), true);
  });

  it("leaves a create without an anchor exactly as before, at the end of the open section", () => {
    const root = insertVault();
    const original = readFileSync(pathOf(root, PROJECT), "utf8");
    const result = board.createBoardTask(settingsFor(root), { projectId: PROJECT, title: "Plain create" });
    assert.equal(result.task.group, "Later");
    assert.equal(readFileSync(pathOf(root, PROJECT), "utf8"), spliceAt(original, taskNamed(root, PROJECT, "Renew the licence").line + 1, "- [ ] Plain create"));
  });
});

describe("golden vault: signifier order on done lines", () => {
  const ORDER_FIXTURE = "signifier-order.md";
  const ORDER_PROJECT = "signifier-order";
  const lineOf = (rel: string, needle: string): string => {
    const found = readFileSync(join(GOLDEN, rel), "utf8").split("\n").find((line) => line.includes(needle));
    assert.ok(found, needle);
    return found;
  };
  const orderVault = (): string => {
    const root = freshVault();
    cpSync(join(GOLDEN, ORDER_FIXTURE), pathOf(root, ORDER_PROJECT));
    return root;
  };
  type Shape = [string, BoardTask["section"], string | null, string | null, string | null, string | null, string | null, number | null];
  const shapeOf = (task: BoardTask): Shape => [task.title, task.section, task.doneAt, task.start, task.scheduled, task.due, task.repeat, task.priority];

  it("keeps every signifier and the done stamp out of the title whatever their order", () => {
    const root = orderVault();
    const payload = board.readBoard(settingsFor(root));
    assert.deepEqual(payload.errors, []);
    const tasks = flatten(payload.tasks).filter((task) => task.projectId === ORDER_PROJECT);
    assert.deepEqual(tasks.map(shapeOf), [
      ["Infra: Drop the legacy cache", "open", "2026-11-12", null, "2026-11-12", null, null, null],
      ["Infra: Rotate the staging keys", "open", "2026-11-12", null, "2026-11-13", null, null, null],
      ["Billing: Close the quarter", "open", "2026-11-11", null, null, "2026-11-14", null, null],
      ["Weekly digest", "open", "2026-11-09", null, "2026-11-09", null, "every week", null],
      ["Ship ✅ the checklist ⏳ later", "open", "2026-11-10", null, "2026-11-10", null, null, null],
      ["Audit the vendors", "open", "2026-11-04", "2026-11-01", "2026-11-02", "2026-11-03", null, 1],
      ["Plan the offsite", "open", null, null, "2026-11-20", null, null, null],
      ["Docs: Archive the old guide", "done", "2026-11-06", null, "2026-11-05", null, null, null],
      ["Infra: Retire the old runner", "done", "2026-11-07", null, "2026-11-07", null, null, null],
    ]);
  });

  it("anchors each parsed task to the exact bytes of its line", () => {
    const root = orderVault();
    const content = readFileSync(pathOf(root, ORDER_PROJECT), "utf8");
    const lines = content.split("\n");
    for (const task of flatten(board.readBoard(settingsFor(root)).tasks).filter((entry) => entry.projectId === ORDER_PROJECT)) {
      assert.equal(task.raw, lines[task.line], task.title);
    }
    assert.equal(lineOf(ORDER_FIXTURE, "Drop the legacy cache"), "- [x] Infra: Drop the legacy cache ⏳ 2026-11-12 ✅ 2026-11-12");
  });

  it("renders the document back to the same bytes", () => {
    const content = readFileSync(join(GOLDEN, ORDER_FIXTURE), "utf8");
    assert.equal(board.renderDoc(board.openDoc(content)), content);
  });


  it("writes a done task in the done section its own status without touching a byte when the line is already in write order", () => {
    const root = orderVault();
    const before = readFileSync(pathOf(root, ORDER_PROJECT));
    const task = taskNamed(root, ORDER_PROJECT, "Docs: Archive the old guide");
    const result = board.writeBoardTask(settingsFor(root), { projectId: ORDER_PROJECT, line: task.line, raw: task.raw, status: "done" });
    assert.equal(result.task.raw, task.raw);
    assert.equal(readFileSync(pathOf(root, ORDER_PROJECT)).equals(before), true);
  });

  it("puts a done stamp that came before the scheduled date back in write order only on the line it rewrites", () => {
    const root = orderVault();
    const original = readFileSync(pathOf(root, ORDER_PROJECT), "utf8");
    const task = taskNamed(root, ORDER_PROJECT, "Infra: Retire the old runner");
    const result = board.writeBoardTask(settingsFor(root), { projectId: ORDER_PROJECT, line: task.line, raw: task.raw, status: "done" });
    const expected = "- [x] Infra: Retire the old runner ⏳ 2026-11-07 ✅ 2026-11-07";
    assert.equal(result.task.raw, expected);
    assert.equal(result.task.title, "Infra: Retire the old runner");
    assert.equal(result.task.doneAt, "2026-11-07");
    assert.equal(result.task.scheduled, "2026-11-07");
    assert.deepEqual(changedLines(original, readFileSync(pathOf(root, ORDER_PROJECT), "utf8")), [task.line]);
  });

  const started: [string, string][] = [
    ["Infra: Drop the legacy cache", "- [-] Infra: Drop the legacy cache ⏳ 2026-11-12 ✅ 2026-11-12"],
    ["Weekly digest", "- [-] Weekly digest 🔁 every week ⏳ 2026-11-09 ✅ 2026-11-09"],
    ["Ship ✅ the checklist ⏳ later", "- [-] Ship ✅ the checklist ⏳ later ⏳ 2026-11-10 ✅ 2026-11-10"],
    ["Audit the vendors", "- [-] Audit the vendors #p1 🛫 2026-11-01 ⏳ 2026-11-02 📅 2026-11-03 ✅ 2026-11-04"],
    ["Infra: Rotate the staging keys", "- [-] Infra: Rotate the staging keys ⏳ 2026-11-13 ✅ 2026-11-12"],
    ["Billing: Close the quarter", "- [-] Billing: Close the quarter 📅 2026-11-14 ✅ 2026-11-11"],
  ];

  for (const [title, expected] of started) {
    it(`a status write on "${title}" changes only that line and keeps every date and the stamp`, () => {
      const root = orderVault();
      const original = readFileSync(pathOf(root, ORDER_PROJECT), "utf8");
      const task = taskNamed(root, ORDER_PROJECT, title);
      const result = board.writeBoardTask(settingsFor(root), { projectId: ORDER_PROJECT, line: task.line, raw: task.raw, status: "doing" });
      const written = readFileSync(pathOf(root, ORDER_PROJECT), "utf8");
      assert.deepEqual(changedLines(original, written), [task.line]);
      assert.equal(withEol(written)[task.line], `${expected}\n`);
      assert.equal(result.task.raw, expected);
      assert.equal(result.task.scheduled, task.scheduled);
      assert.equal(result.task.due, task.due);
      assert.equal(result.task.start, task.start);
      assert.equal(result.task.repeat, task.repeat);
      assert.equal(result.task.priority, task.priority);
    });
  }

  it("moves a finished open line to the done section keeping its own stamp instead of stamping twice", () => {
    const root = orderVault();
    const task = taskNamed(root, ORDER_PROJECT, "Infra: Drop the legacy cache");
    const result = board.writeBoardTask(settingsFor(root), { projectId: ORDER_PROJECT, line: task.line, raw: task.raw, status: "done" });
    assert.equal(result.moved, true);
    const written = readFileSync(pathOf(root, ORDER_PROJECT), "utf8");
    assert.equal(sectionFrom(written, "Done loops").includes(`${task.raw}\n`), true);
    assert.equal(written.split(task.raw).length - 1, 1);
    assert.equal(written.match(/Drop the legacy cache/g)?.length, 1);
    assert.equal(result.task.title, "Infra: Drop the legacy cache");
    assert.equal(result.task.doneAt, "2026-11-12");
  });
});

describe("golden vault: finishing a task moves only its block", () => {
  it("moves a finished top-level block to the top of Done loops with a stamp and leaves every other section alone", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const original = readFileSync(pathOf(root, "acme/acme"), "utf8");
    const task = taskNamed(root, "acme/acme", "Plain task without priority");
    const result = board.writeBoardTask(settings, { projectId: "acme/acme", line: task.line, raw: task.raw, status: "done" });
    assert.equal(result.moved, true);
    const written = readFileSync(pathOf(root, "acme/acme"), "utf8");
    assert.equal(written.slice(0, original.indexOf("- [ ] Plain task without priority")), original.slice(0, original.indexOf("- [ ] Plain task without priority")));
    assert.equal(sectionFrom(written, "Decisões"), sectionFrom(original, "Decisões"));
    assert.equal(
      written.replace(`- [x] Plain task without priority ✅ ${localToday()}\n`, "").replace("- [ ] Plain task without priority\n", ""),
      original.replace("- [ ] Plain task without priority\n", ""),
    );
    assert.ok(sectionFrom(written, "Done loops").startsWith(`## Done loops\n\n- [x] Plain task without priority ✅ ${localToday()}\n- [x] Security: audit`));
  });

  it("moves a block with its subtasks and notes and keeps the BOM and CRLF files intact", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const initechBefore = readFileSync(pathOf(root, "initech"), "utf8");
    const guide = taskNamed(root, "initech", "Write the integration guide");
    const first = guide.subtasks[1];
    assert.ok(first);
    board.writeBoardTask(settings, { projectId: "initech", line: first.line, raw: first.raw, status: "done" });
    board.writeBoardTask(settings, { projectId: "initech", line: guide.line, raw: guide.raw, status: "done" });
    const written = readFileSync(pathOf(root, "initech"), "utf8");
    assert.equal(written.startsWith(BOM), true);
    assert.equal(written.includes("\r"), false);
    assert.equal(sectionFrom(written, "Decisões"), sectionFrom(initechBefore, "Decisões"));
    assert.ok(
      sectionFrom(written, "Done loops").startsWith(
        `## Done loops\n\n- [x] Write the integration guide 📅 2026-11-20 ✅ ${localToday()}\n  - [x] Outline\n  - [x] First draft\n- [x] Create the sandbox tenant`,
      ),
    );
    const personal = taskNamed(root, "alex-personal", "Renew the passport");
    assert.equal(personal.section, "done");
    const crlfBefore = readFileSync(pathOf(root, "alex-personal"), "utf8");
    const reading = taskNamed(root, "alex-personal", "Reading list");
    board.writeBoardTask(settings, { projectId: "alex-personal", line: reading.line, raw: reading.raw, status: "done" });
    const crlf = readFileSync(pathOf(root, "alex-personal"), "utf8");
    assert.equal(crlf.replace(/\r\n/g, "").includes("\n"), false);
    assert.equal(crlf.split("\r\n").length, crlfBefore.split("\r\n").length);
    assert.equal(sectionFrom(crlf, "Decisões"), sectionFrom(crlfBefore, "Decisões"));
  });

  it("completes a recurring task by advancing its dates and stamping a copy in Done loops", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const original = readFileSync(pathOf(root, "acme/acme"), "utf8");
    const weekly = flatten(board.readBoard(settings).tasks).find((task) => task.projectId === "acme/acme" && task.title === "Weekly report" && task.section === "open");
    assert.ok(weekly);
    const result = board.writeBoardTask(settings, { projectId: "acme/acme", line: weekly.line, raw: weekly.raw, status: "done" });
    assert.equal(result.recurred, true);
    const written = readFileSync(pathOf(root, "acme/acme"), "utf8");
    assert.ok(written.includes("- [ ] Weekly report #p2 🔁 every week 🛫 2026-11-16 📅 2026-11-20\n"));
    assert.ok(sectionFrom(written, "Done loops").startsWith(`## Done loops\n\n- [x] Weekly report #p2 🔁 every week 🛫 2026-11-09 📅 2026-11-13 ✅ ${localToday()}\n`));
    assert.equal(sectionFrom(written, "Decisões"), sectionFrom(original, "Decisões"));
  });
});

describe("golden vault: daily round-trip", () => {
  it("reads every daily and writes it back byte for byte", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    for (const date of DAILY_DATES) {
      const rel = `daily/${date}.md`;
      const before = readFileSync(join(root, rel));
      const read = daily.readDaily(settings, date);
      assert.equal(read.exists, true, date);
      assert.equal(read.path, join(root, "daily", `${date}.md`));
      assert.equal(Buffer.from(read.content, "utf8").equals(before), true, date);
      const written = daily.writeDaily(settings, date, read.content, read.updatedAt ?? undefined);
      assert.equal(written.path, read.path);
      assert.equal(readFileSync(join(root, rel)).equals(before), true, date);
    }
    assert.deepEqual(digestOf(root), goldenDigest);
  });

  it("keeps the CRLF endings of a Windows daily through a read and a write", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const content = daily.readDaily(settings, "2026-11-10").content;
    assert.equal(content.includes("\r\n"), true);
    daily.writeDaily(settings, "2026-11-10", content);
    const after = readFileSync(join(root, "daily", "2026-11-10.md"), "utf8");
    assert.equal(after, content);
    assert.equal(after.replace(/\r\n/g, "").includes("\n"), false);
  });

  it("keeps the BOM of a daily through a read and a write", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const before = readFileSync(join(root, "daily", "2026-11-11.md"));
    const content = daily.readDaily(settings, "2026-11-11").content;
    assert.equal(content.startsWith(BOM), true);
    daily.writeDaily(settings, "2026-11-11", content);
    const after = readFileSync(join(root, "daily", "2026-11-11.md"));
    assert.deepEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(after.equals(before), true);
  });

  it("reads the template and renders the date without touching the rest", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const template = readFileSync(join(root, "_templates", "daily.md"), "utf8");
    assert.equal(daily.dailyTemplatePath(settings), join(root, "_templates", "daily.md"));
    assert.equal(daily.dailyTemplateText(settings), template);
    assert.equal(daily.renderTemplate(template, "2026-11-13"), template.split("{{date}}").join("2026-11-13"));
    assert.equal(daily.renderTemplate(template, "2026-11-13").includes("{{"), false);
  });

  it("finds the Focus, Meetings and Sessions headings and the focus items of the real shape", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const lines = daily.readDaily(settings, "2026-11-12").content.split("\n");
    for (const heading of ["Focus", "Meetings", "Sessions"]) assert.ok(daily.findHeadingIndex(lines, heading) > 0, heading);
    const focus = daily.parseTaskLines(lines.join("\n")).filter((task) => task.depth === 0).map((task) => [task.state, task.text]);
    assert.deepEqual(focus, [
      ["todo", "[[acme|Acme Platform]] - Migrate billing service #p0"],
      ["doing", "[[globex|Globex Rollout]] - Rollout checklist for region two"],
      ["todo", "[[acme|Acme Platform]] - Renew vendor contract #p1"],
      ["done", "[[initech|Initech Sandbox]] - Confirm sandbox credentials"],
      ["todo", "[[alex-personal|Alex Personal]] - Plan the quarter"],
      ["todo", "Plain note without a project"],
    ]);
  });

  it("links the focus items to the projects of the board by wikilink", () => {
    const root = freshVault();
    const result = board.dailyTaskLinks(settingsFor(root), "2026-11-12");
    assert.equal(result.exists, true);
    assert.deepEqual(
      result.items.map((item) => [item.projectId, item.taskId !== null]),
      [
        ["acme/acme", true],
        ["globex/globex", true],
        ["acme/acme", true],
        ["initech", true],
        ["alex-personal", true],
        [null, false],
      ],
    );
  });

  it("changes only the checked line when a focus item is ticked, in LF, CRLF and BOM dailies", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    for (const [date, title] of [["2026-11-12", "Renew vendor contract"], ["2026-11-10", "Banner copy review"], ["2026-11-11", "Publish the status page"]] as const) {
      const before = daily.readDaily(settings, date).content;
      const task = daily.parseTaskLines(before).find((entry) => entry.text.includes(title));
      assert.ok(task, title);
      const next = daily.setTaskChecked(before, task.line, true);
      daily.writeDaily(settings, date, next);
      const after = readFileSync(join(root, "daily", `${date}.md`), "utf8");
      assert.deepEqual(changedLines(before, after), [task.line]);
      assert.ok(withEol(after)[task.line]?.startsWith("- [x] "), title);
      daily.writeDaily(settings, date, daily.setTaskChecked(after, task.line, false));
      assert.equal(readFileSync(join(root, "daily", `${date}.md`), "utf8"), before);
    }
  });
});

function copyDaily(root: string, from: string, to: string): void {
  writeFileSync(join(root, "daily", `${to}.md`), readFileSync(join(GOLDEN, "daily", `${from}.md`)));
}

function keepsInOrder(before: string, after: string): boolean {
  const next = after.split(/\r\n|\n/);
  let at = 0;
  for (const line of before.split(/\r\n|\n/)) {
    while (at < next.length && next[at] !== line) at += 1;
    if (at >= next.length) return false;
    at += 1;
  }
  return true;
}

function lineBytes(buffer: Buffer): string[] {
  return buffer.toString("utf8").replace(BOM, "").split(/\r\n|\n/);
}

describe("golden vault: today scheduling", () => {
  const FUTURE = "2099-01-01";
  const SCHEDULED = "\u23F3";
  const DUE = "\u{1F4C5}";

  it("sets and clears the scheduled token changing only that token of that line, in LF, CRLF and BOM projects", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const cases: [string, string, string, string][] = [
      ["acme/acme", "Plain task without priority", `- [ ] Plain task without priority ${SCHEDULED} ${FUTURE}`, "- [ ] Plain task without priority"],
      ["acme/acme", "Renew vendor contract", `- [ ] Renew vendor contract #p1 ${SCHEDULED} ${FUTURE} ${DUE} 2026-11-30`, `- [ ] Renew vendor contract #p1 ${DUE} 2026-11-30`],
      ["acme/acme", "Cut over the webhook", `  - [ ] Cut over the webhook ${SCHEDULED} ${FUTURE}`, "  - [ ] Cut over the webhook"],
      ["alex-personal", "Plan the quarter", `- [ ] Plan the quarter #p2 ${SCHEDULED} ${FUTURE} ${DUE} 2026-12-01`, `- [ ] Plan the quarter #p2 ${DUE} 2026-12-01`],
      ["initech", "Confirm sandbox credentials", `- [ ] Confirm sandbox credentials #p2 ${SCHEDULED} ${FUTURE}`, "- [ ] Confirm sandbox credentials #p2"],
    ];
    for (const [projectId, title, scheduledLine, clearedLine] of cases) {
      const file = pathOf(root, projectId);
      const before = readFileSync(file);
      const task = taskNamed(root, projectId, title);
      const scheduled = today.todayApi.schedule(settings, { projectId, line: task.line, raw: task.raw, date: FUTURE });
      assert.equal(scheduled.task.raw, scheduledLine);
      const after = readFileSync(file);
      assert.deepEqual(changedLines(before.toString("utf8"), after.toString("utf8")), [task.line], `${projectId} ${title}`);
      assert.equal(lineBytes(after)[task.line], scheduledLine);
      assert.equal(after.subarray(0, 3).equals(before.subarray(0, 3)), true);
      assert.equal(before.includes("\r\n"), after.includes("\r\n"));
      const cleared = today.todayApi.schedule(settings, { projectId, line: task.line, raw: scheduled.task.raw, date: null });
      assert.equal(cleared.task.raw, clearedLine);
      assert.deepEqual(changedLines(before.toString("utf8"), readFileSync(file).toString("utf8")), lineBytes(before)[task.line] === clearedLine ? [] : [task.line]);
    }
    assert.deepEqual(digestOf(root), goldenDigest);
  });

  it("replaces an existing scheduled date in place and never touches the notes, the dates or the stamps around it", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const file = pathOf(root, "acme/acme");
    const before = readFileSync(file, "utf8");
    const task = taskNamed(root, "acme/acme", "Follow up on the audit");
    const moved = today.todayApi.schedule(settings, { projectId: "acme/acme", line: task.line, raw: task.raw, date: FUTURE });
    assert.equal(moved.task.raw, `- [ ] Follow up on the audit ${SCHEDULED} ${FUTURE} ${DUE} 2026-11-16`);
    assert.deepEqual(changedLines(before, readFileSync(file, "utf8")), [task.line]);
    assert.deepEqual(
      today.todayApi.focusOf(settings, FUTURE).map((entry) => entry.task.title),
      ["Follow up on the audit"],
    );
  });
});

describe("golden vault: today mirror", () => {
  const SCHEDULED = "\u23F3";
  const DUE = "\u{1F4C5}";
  const START = "\u{1F6EB}";
  const DONE = "\u2705";

  it("migrates the real-shaped daily, schedules the linked tasks and only inserts the missing subtasks under their parents", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const date = localToday();
    copyDaily(root, "2026-11-12", date);
    const follow = taskNamed(root, "acme/acme", "Follow up on the audit");
    today.todayApi.schedule(settings, { projectId: "acme/acme", line: follow.line, raw: follow.raw, date: null });
    const dailyFile = join(root, "daily", `${date}.md`);
    const before = readFileSync(dailyFile, "utf8");
    const projectsBefore = new Map(PROJECT_FILES.map((projectId) => [projectId, readFileSync(pathOf(root, projectId))]));
    const result = today.todayApi.migrateFocus(settings, date);
    assert.deepEqual([result.scheduled, result.synced, result.skipped, result.failed, result.ambiguous], [5, 0, [], [], []]);
    const after = readFileSync(dailyFile, "utf8");
    assert.deepEqual(sectionFrom(after, "Focus").split("## Meetings")[0]?.split("\n"), [
      "## Focus",
      "",
      "- [ ] [[acme|Acme Platform]] - Migrate billing service #p0",
      "  - [x] Export legacy invoices",
      "  - [-] Map the new tax codes",
      "    - note about the rounding rules",
      "    - [ ] Validate rounding rules",
      "  - [ ] Cut over the webhook",
      "- [-] [[globex|Globex Rollout]] - Rollout checklist for region two",
      "  - [-] Provision the staging cluster",
      "  - [ ] Load test",
      "- [ ] [[acme|Acme Platform]] - Renew vendor contract #p1",
      "- [x] [[initech|Initech Sandbox]] - Confirm sandbox credentials",
      "- [ ] [[alex-personal|Alex Personal]] - Plan the quarter",
      "  - [ ] Review last quarter",
      "- [ ] Plain note without a project",
      "",
      "",
    ]);
    assert.equal(keepsInOrder(before, after), true);
    assert.equal(after.slice(0, after.indexOf("## Focus")), before.slice(0, before.indexOf("## Focus")));
    assert.equal(after.slice(after.indexOf("## Meetings")), before.slice(before.indexOf("## Meetings")));
    const acmeNow = lineBytes(readFileSync(pathOf(root, "acme/acme")));
    const acmeBefore = lineBytes(projectsBefore.get("acme/acme") as Buffer);
    const changed = acmeBefore.flatMap((line, index) => (line === acmeNow[index] ? [] : [index]));
    assert.deepEqual(
      changed.map((index) => acmeNow[index]),
      [`- [ ] Renew vendor contract #p1 ${SCHEDULED} ${date} ${DUE} 2026-11-30`, `- [-] Migrate billing service #p0 ${START} 2026-11-02 ${SCHEDULED} ${date} ${DUE} 2026-11-20`],
    );
    const initech = readFileSync(pathOf(root, "initech"));
    assert.deepEqual([...initech.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(initech.toString("utf8").includes("\r"), false);
    assert.ok(initech.toString("utf8").includes(`- [ ] Confirm sandbox credentials #p2 ${SCHEDULED} ${date}\n`));
    assert.equal(initech.toString("utf8").includes(`${DONE} ${date}`), false);
    const alex = readFileSync(pathOf(root, "alex-personal")).toString("utf8");
    assert.equal(alex.replace(/\r\n/g, "").includes("\n"), false);
    assert.ok(alex.includes(`- [ ] Plan the quarter #p2 ${SCHEDULED} ${date} ${DUE} 2026-12-01\r\n`));
    const again = today.todayApi.migrateFocus(settings, date);
    assert.deepEqual([again.scheduled, again.synced], [0, 0]);
    assert.equal(readFileSync(dailyFile, "utf8"), after);
    assert.equal(today.todayApi.regenerateFocusMirror(settings, date).changed, false);
    const payload = today.readToday(settings, date);
    assert.deepEqual(payload.unlinked, ["- [ ] Plain note without a project"]);
    assert.deepEqual(payload.inNote, ["- [ ] Plain note without a project"]);
    assert.deepEqual(payload.ambiguous, []);
    assert.deepEqual(payload.meetings, ["09:30 Acme billing sync with Alex", "14:00 Globex rollout review"]);
    assert.deepEqual(payload.captures.map((capture) => capture.text), ["idea: publish the rollout checklist as a template"]);
    assert.ok(payload.summary?.startsWith("**Briefing (from the 11/11 trail):**"));
    assert.equal(payload.focus.length, 5);
  });

  it("keeps the BOM of a daily and every line where it is, adding the missing subtasks after the note of their parent", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const date = "2099-01-02";
    copyDaily(root, "2026-11-11", date);
    const dailyFile = join(root, "daily", `${date}.md`);
    const before = readFileSync(dailyFile);
    const result = today.todayApi.migrateFocus(settings, date);
    assert.deepEqual([result.scheduled, result.synced, result.failed], [2, 0, []]);
    const after = readFileSync(dailyFile);
    assert.deepEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(after.toString("utf8").includes("\r"), false);
    assert.deepEqual(lineBytes(after).slice(lineBytes(after).indexOf("## Focus"), lineBytes(after).indexOf("## Meetings")), [
      "## Focus",
      "",
      "- [ ] [[acme|Acme Platform]] - Publish the status page",
      "- [x] [[globex|Globex Rollout]] - Staging cluster provisioned",
      "- [-] [[initech|Initech Sandbox]] - Write the integration guide",
      "  - note about the outline",
      "  - [x] Outline",
      "  - [ ] First draft",
      "",
    ]);
    assert.equal(keepsInOrder(before.toString("utf8"), after.toString("utf8")), true);
    const tail = (buffer: Buffer): string => buffer.toString("utf8").slice(buffer.toString("utf8").indexOf("## Meetings"));
    assert.equal(tail(after), tail(before));
    const acme = lineBytes(readFileSync(pathOf(root, "acme/acme")));
    assert.ok(acme.includes(`- [ ] BLOCK - Publish the status page - waiting for the DNS change #p1 ${SCHEDULED} ${date}`));
  });

  it("keeps the CRLF daily byte for byte when every focus line is linked, and leaves a task finished earlier where it is", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const date = "2099-01-03";
    copyDaily(root, "2026-11-10", date);
    const dailyFile = join(root, "daily", `${date}.md`);
    const before = readFileSync(dailyFile);
    const result = today.todayApi.migrateFocus(settings, date);
    assert.deepEqual([result.scheduled, result.synced, result.failed], [1, 0, []]);
    assert.equal(readFileSync(dailyFile).equals(before), true);
    assert.deepEqual(result.skipped.map((entry) => [entry.title, entry.reason]), [["Docs: refresh the onboarding guide", "finished-earlier"]]);
    const after = readFileSync(dailyFile, "utf8");
    assert.equal(after.replace(/\r\n/g, "").includes("\n"), false);
    const lines = after.split("\r\n");
    assert.deepEqual(lines.slice(lines.indexOf("## Focus"), lines.indexOf("## Meetings")), [
      "## Focus",
      "",
      "- [x] [[acme|Acme Platform]] - Docs: refresh the onboarding guide",
      "- [ ] [[globex|Globex Rollout]] - Banner copy review",
      "",
    ]);
    assert.equal(taskNamed(root, "globex/globex", "Banner copy review").status, "doing");
    assert.equal(taskNamed(root, "acme/acme", "Docs: refresh the onboarding guide").section, "done");
  });

  it("never rewrites the committed fixture and never touches a past daily", () => {
    const root = freshVault();
    const settings = settingsFor(root);
    const before = readFileSync(join(root, "daily", "2026-11-10.md"));
    assert.deepEqual(today.todayApi.regenerateFocusMirror(settings, "2026-11-10"), { changed: false, skipped: "past", applied: 0 });
    assert.throws(() => today.todayApi.migrateFocus(settings, "2026-11-10"), /past dailies/);
    assert.equal(readFileSync(join(root, "daily", "2026-11-10.md")).equals(before), true);
    assert.deepEqual(digestOf(GOLDEN), goldenDigest);
  });
});

describe("golden vault: creating next to a block with a code fence", () => {
  const FIXTURE = "insert-fence.md";
  const PROJECT = "insert-fence";
  const fenceVault = (fixture = FIXTURE, project = PROJECT): string => {
    const root = freshVault();
    cpSync(join(GOLDEN, fixture), pathOf(root, project));
    return root;
  };
  const spliceAt = (content: string, index: number, line: string): string => {
    const lines = withEol(content);
    lines.splice(index, 0, `${line}\n`);
    return lines.join("");
  };

  it("puts the sibling after the closing fence when the fence holds a column-0 line", () => {
    const root = fenceVault();
    const original = readFileSync(pathOf(root, PROJECT), "utf8");
    const anchor = taskNamed(root, PROJECT, "Fenced anchor");
    const result = board.createBoardTask(settingsFor(root), { projectId: PROJECT, title: "After the fence", after: { line: anchor.line, raw: anchor.raw } });
    assert.equal(result.task.line, anchor.line + 4);
    assert.equal(result.task.depth, 0);
    assert.equal(result.task.raw, "- [ ] After the fence");
    assert.equal(readFileSync(pathOf(root, PROJECT), "utf8"), spliceAt(original, anchor.line + 4, "- [ ] After the fence"));
    assert.equal(withEol(readFileSync(pathOf(root, PROJECT), "utf8"))[anchor.line + 3], "  ```\n");
    assert.equal(taskNamed(root, PROJECT, "Fenced anchor").noteItems.length, 0);
  });

  it("puts a new subtask after the closing fence of the last child when only the parent is given", () => {
    const root = fenceVault();
    const original = readFileSync(pathOf(root, PROJECT), "utf8");
    const parent = taskNamed(root, PROJECT, "Parent with fence");
    const result = board.createBoardTask(settingsFor(root), { projectId: PROJECT, title: "Appended child", parentLine: parent.line, parentRaw: parent.raw });
    assert.equal(result.task.line, parent.line + 6);
    assert.equal(result.task.depth, 1);
    assert.equal(readFileSync(pathOf(root, PROJECT), "utf8"), spliceAt(original, parent.line + 6, "  - [ ] Appended child"));
    assert.deepEqual(taskNamed(root, PROJECT, "Parent with fence").subtasks.map((subtask) => subtask.title), ["Fenced child", "Last child", "Appended child"]);
  });

  it("puts a sibling right after a fenced subtask when the parent and the anchor are given", () => {
    const root = fenceVault();
    const original = readFileSync(pathOf(root, PROJECT), "utf8");
    const parent = taskNamed(root, PROJECT, "Parent with fence");
    const anchor = taskNamed(root, PROJECT, "Fenced child");
    const result = board.createBoardTask(settingsFor(root), {
      projectId: PROJECT,
      title: "Between children",
      parentLine: parent.line,
      parentRaw: parent.raw,
      after: { line: anchor.line, raw: anchor.raw },
    });
    assert.equal(result.task.line, anchor.line + 4);
    assert.equal(readFileSync(pathOf(root, PROJECT), "utf8"), spliceAt(original, anchor.line + 4, "  - [ ] Between children"));
    assert.deepEqual(taskNamed(root, PROJECT, "Parent with fence").subtasks.map((subtask) => subtask.title), ["Fenced child", "Between children", "Last child"]);
  });

  it("refuses a fence that never closes and leaves the file byte-identical", () => {
    const root = fenceVault("insert-fence-unclosed.md", "insert-fence-unclosed");
    const target = pathOf(root, "insert-fence-unclosed");
    const before = readFileSync(target);
    const anchor = taskNamed(root, "insert-fence-unclosed", "Open fence anchor");
    assert.throws(() => board.createBoardTask(settingsFor(root), { projectId: "insert-fence-unclosed", title: "Never written", after: { line: anchor.line, raw: anchor.raw } }), /code fence/);
    assert.throws(() => board.createBoardTask(settingsFor(root), { projectId: "insert-fence-unclosed", title: "Never written", parentLine: anchor.line, parentRaw: anchor.raw }), /code fence/);
    assert.deepEqual(readFileSync(target), before);
  });
});
