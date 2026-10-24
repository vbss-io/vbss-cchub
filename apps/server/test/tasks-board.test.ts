import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { makeSandbox, startServer, waitFor, type RunningServer, type Sandbox } from "./helpers.js";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-tasks-store-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.HUB_WORKSPACES_ROOT;
delete process.env.HUB_EDITOR;
delete process.env.HUB_SECOND_BRAIN;

type Store = typeof import("../src/delegation-store.js");
type Board = typeof import("../src/tasks-board.js");
type Sse = typeof import("../src/sse.js");
let store: Store;
let board: Board;
let sse: Sse;

before(async () => {
  store = await import("../src/delegation-store.js");
  board = await import("../src/tasks-board.js");
  sse = await import("../src/sse.js");
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function settingsFor(root: string, tasks: Partial<DelegationSettings["tasks"]> = {}, enabled = true): DelegationSettings {
  const base = store.getSettings();
  return {
    ...base,
    secondBrainRoot: root,
    features: { ...base.features, tasks: enabled },
    tasks: { ...base.tasks, root, ...tasks },
  };
}

const defaults = (): DelegationSettings["tasks"] => store.getSettings().tasks;

const ACME_CORP = `---
title: Acme Corp
workspace: acme-wk
---

# Acme Corp company

## Open loops

- [ ] Renew contract
- [-] Hire designer
`;

const GLOBEX = `---
type: empresa
---

# Globex

## Open loops

- [ ] Rollout checklist
- [ ] BACKLOG - Banner copy review
- [ ] BLOCK - Test webhook
`;

const ACCOUNTS = `# Accounts

## Open loops

- [x] Onboard vendor
`;

const INITECH = `---
workspace: init-wk
---

# Initech

## Open loops

- [ ] Pilot validation
  - [ ] Simulate kickoff call
  - [x] Check checklist
`;

describe("settings", () => {
  it("defaults the tasks feature off with the documented config", () => {
    const settings = store.getSettings();
    assert.equal(settings.features.tasks, false);
    assert.deepEqual(settings.tasks, {
      root: null,
      section: "Open loops",
      prefixes: { blocked: ["BLOCK", "BLOCKED"], hold: ["HOLD"], archived: ["ARCHIVED"] },
      separator: " - ",
      exclude: ["_*"],
      workspaceKey: "workspace",
      parentKey: "parent",
      delegatePrompt: null,
      markDoingOnDelegate: true,
      reasonSeparator: " - ",
      doneSection: "",
      doneStamp: " ✅ {{date}}",
      priorityTag: "p",
      priorityLevels: 4,
    });
  });

  it("round-trips every field including JSON arrays and an empty section", () => {
    const updated = store.updateSettings({
      features: { tasks: true },
      tasks: {
        root: "vault/projects",
        section: "",
        prefixes: { blocked: ["STOP"], hold: ["PAUSE", "WAIT"], archived: [] },
        separator: ": ",
        exclude: ["_*", "private"],
        workspaceKey: "wk",
        parentKey: "up",
        delegatePrompt: "do {{task}}",
        markDoingOnDelegate: false,
        reasonSeparator: " | ",
        doneSection: "Done loops",
        doneStamp: " (done {{date}})",
        priorityTag: "prio",
        priorityLevels: 7,
      },
    });
    assert.equal(updated.features.tasks, true);
    assert.deepEqual(updated.tasks, {
      root: "vault/projects",
      section: "",
      prefixes: { blocked: ["STOP"], hold: ["PAUSE", "WAIT"], archived: [] },
      separator: ": ",
      exclude: ["_*", "private"],
      workspaceKey: "wk",
      parentKey: "up",
      delegatePrompt: "do {{task}}",
      markDoingOnDelegate: false,
      reasonSeparator: " | ",
      doneSection: "Done loops",
      doneStamp: " (done {{date}})",
      priorityTag: "prio",
      priorityLevels: 7,
    });
    assert.deepEqual(store.getSettings().tasks, updated.tasks);
    const partial = store.updateSettings({ tasks: { prefixes: { hold: ["HOLD"] } } });
    assert.deepEqual(partial.tasks.prefixes, { blocked: ["STOP"], hold: ["HOLD"], archived: [] });
    const reset = store.updateSettings({
      features: { tasks: false },
      tasks: {
        root: null,
        section: "Open loops",
        prefixes: { blocked: ["BLOCK", "BLOCKED"], hold: ["HOLD"], archived: ["ARCHIVED"] },
        separator: " - ",
        exclude: ["_*"],
        workspaceKey: "workspace",
        parentKey: "parent",
        delegatePrompt: null,
        markDoingOnDelegate: true,
        reasonSeparator: " - ",
        doneSection: "",
        doneStamp: " ✅ {{date}}",
        priorityTag: "p",
        priorityLevels: 4,
      },
    });
    assert.deepEqual(reset.tasks, defaults());
    assert.equal(reset.tasks.root, null);
    assert.equal(reset.tasks.delegatePrompt, null);
  });

  it("falls back to defaults when a stored array is corrupt", () => {
    store.setSetting("tasks.exclude", "not json");
    store.setSetting("tasks.prefixes.hold", JSON.stringify([1, 2]));
    const settings = store.getSettings();
    assert.deepEqual(settings.tasks.exclude, ["_*"]);
    assert.deepEqual(settings.tasks.prefixes.hold, ["HOLD"]);
    store.updateSettings({ tasks: { exclude: ["_*"], prefixes: { hold: ["HOLD"] } } });
  });
});

describe("project hierarchy", () => {
  const root = mkdtempSync(join(tmpdir(), "cch-tasks-projects-"));

  before(() => {
    writeTree(root, {
      "acme-corp/acme-corp.md": ACME_CORP,
      "acme-corp/_about.md": "# about\n\n## Open loops\n\n- [ ] hidden\n",
      "acme-corp/globex/globex.md": GLOBEX,
      "acme-corp/globex/accounts.md": ACCOUNTS,
      "acme-corp/globex/initech.md": INITECH,
      "acme-corp/globex/umbrella.md": `---\nparent: accounts\n---\n\n# Umbrella\n\n## Open loops\n\n- [ ] one\n`,
      "acme-corp/globex/hooli.md": `---\nparent: "[[ghost]]"\ntitle: Hooli Titled\n---\n\n## Open loops\n\n- [ ] two\n`,
      "acme-corp/globex/_private/secret.md": "## Open loops\n\n- [ ] secret\n",
      "acme-corp/.obsidian/notes.md": "## Open loops\n\n- [ ] dot\n",
      "acme-corp/globex/globex-labs/other.md": `---\nparent: "[[globex]]"\n---\n\n## Open loops\n\n- [ ] ims\n`,
      "acme-corp/globex/readme.txt": "not markdown",
      "loose.md": "---\nparent: acme-corp/globex/globex\n---\n\n## Open loops\n\n- [ ] loose\n",
      "cyc/a.md": "---\nparent: b\n---\n\n## Open loops\n\n- [ ] a\n",
      "cyc/b.md": "---\nparent: a\n---\n\n## Open loops\n\n- [ ] b\n",
      "dup/one/same.md": "## Open loops\n\n- [ ] s1\n",
      "dup/two/same.md": "## Open loops\n\n- [ ] s2\n",
      "dup/pointer.md": "---\nparent: same\n---\n\n## Open loops\n\n- [ ] p\n",
    });
  });

  after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const byId = (snapshot: ReturnType<Board["readBoard"]>, id: string) => snapshot.projects.find((project) => project.id === id);

  it("builds ids, names, titles, parents and depth from the tree", () => {
    const snapshot = board.readBoard(settingsFor(root));
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.configured, true);
    assert.equal(snapshot.root, root);
    assert.deepEqual(snapshot.errors, []);
    const ids = snapshot.projects.map((project) => project.id);
    assert.ok(!ids.includes("acme-corp/_about"));
    assert.ok(!ids.includes("acme-corp/globex/_private/secret"));
    assert.ok(!ids.includes("acme-corp/.obsidian/notes"));
    assert.ok(ids.includes("acme-corp/globex/initech"));

    const acme = byId(snapshot, "acme-corp/acme-corp");
    assert.ok(acme);
    assert.equal(acme.name, "acme-corp");
    assert.equal(acme.title, "Acme Corp");
    assert.equal(acme.parent, null);
    assert.equal(acme.depth, 0);
    assert.equal(acme.path, join(root, "acme-corp", "acme-corp.md"));

    const globex = byId(snapshot, "acme-corp/globex/globex");
    assert.equal(globex?.parent, "acme-corp/acme-corp");
    assert.equal(globex?.title, "Globex");
    assert.equal(globex?.depth, 1);

    const accounts = byId(snapshot, "acme-corp/globex/accounts");
    assert.equal(accounts?.parent, "acme-corp/globex/globex");
    assert.equal(accounts?.depth, 2);
    assert.equal(byId(snapshot, "acme-corp/globex/initech")?.parent, "acme-corp/globex/globex");
    assert.equal(byId(snapshot, "acme-corp/globex/globex-labs/other")?.parent, "acme-corp/globex/globex");
  });

  it("orders projects so a parent always precedes its children", () => {
    const snapshot = board.readBoard(settingsFor(root));
    const position = new Map(snapshot.projects.map((project, index) => [project.id, index]));
    for (const project of snapshot.projects) {
      if (project.parent) assert.ok((position.get(project.parent) ?? Infinity) < (position.get(project.id) ?? -1), project.id);
    }
  });

  it("lets frontmatter parent override by name, wikilink or relative id and ignores unresolved or ambiguous values", () => {
    const snapshot = board.readBoard(settingsFor(root));
    assert.equal(byId(snapshot, "acme-corp/globex/umbrella")?.parent, "acme-corp/globex/accounts");
    assert.equal(byId(snapshot, "acme-corp/globex/umbrella")?.depth, 3);
    assert.equal(byId(snapshot, "loose")?.parent, "acme-corp/globex/globex");
    assert.equal(byId(snapshot, "acme-corp/globex/hooli")?.parent, "acme-corp/globex/globex");
    assert.equal(byId(snapshot, "acme-corp/globex/hooli")?.title, "Hooli Titled");
    assert.equal(byId(snapshot, "dup/pointer")?.parent, null);
  });

  it("falls back to the folder rule on parent cycles", () => {
    const snapshot = board.readBoard(settingsFor(root));
    const a = byId(snapshot, "cyc/a");
    const b = byId(snapshot, "cyc/b");
    assert.ok(a && b);
    assert.ok(!(a.parent === "cyc/b" && b.parent === "cyc/a"));
    assert.ok(a.parent === null || b.parent === null);
  });

  it("inherits workspace from the nearest ancestor and reports its source", () => {
    const snapshot = board.readBoard(settingsFor(root));
    const acme = byId(snapshot, "acme-corp/acme-corp");
    assert.equal(acme?.workspace, "acme-wk");
    assert.equal(acme?.workspaceSource, "own");
    const globex = byId(snapshot, "acme-corp/globex/globex");
    assert.equal(globex?.workspace, "acme-wk");
    assert.equal(globex?.workspaceSource, "inherited");
    const di = byId(snapshot, "acme-corp/globex/initech");
    assert.equal(di?.workspace, "init-wk");
    assert.equal(di?.workspaceSource, "own");
    const accounts = byId(snapshot, "acme-corp/globex/accounts");
    assert.equal(accounts?.workspace, "acme-wk");
    assert.equal(accounts?.workspaceSource, "inherited");
    const loose = byId(snapshot, "loose");
    assert.equal(loose?.workspace, "acme-wk");
    assert.equal(byId(snapshot, "cyc/a")?.workspace ?? null, null);
    assert.equal(byId(snapshot, "cyc/b")?.workspaceSource, null);
  });

  it("honours custom parentKey, workspaceKey and exclude globs", () => {
    const custom = mkdtempSync(join(tmpdir(), "cch-tasks-keys-"));
    try {
      writeTree(custom, {
        "top.md": "---\nwk: alpha\n---\n\n## Open loops\n\n- [ ] t\n",
        "inner/child.md": "---\nup: top\n---\n\n## Open loops\n\n- [ ] c\n",
        "inner/skipme.md": "## Open loops\n\n- [ ] s\n",
        "_hidden.md": "## Open loops\n\n- [ ] h\n",
      });
      const snapshot = board.readBoard(settingsFor(custom, { workspaceKey: "wk", parentKey: "up", exclude: ["skip*"] }));
      const ids = snapshot.projects.map((project) => project.id).sort();
      assert.deepEqual(ids, ["_hidden", "inner/child", "top"]);
      assert.equal(byId(snapshot, "inner/child")?.parent, "top");
      assert.equal(byId(snapshot, "inner/child")?.workspace, "alpha");
      assert.equal(byId(snapshot, "inner/child")?.workspaceSource, "inherited");
    } finally {
      rmSync(custom, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("resolves the root: null uses projects, relative joins the second brain, disabled or missing is empty", () => {
    const brain = mkdtempSync(join(tmpdir(), "cch-tasks-root-"));
    try {
      writeTree(brain, { "projects/p.md": "## Open loops\n\n- [ ] x\n", "alt/q.md": "## Open loops\n\n- [ ] y\n" });
      const base = settingsFor(brain, { root: null });
      assert.equal(board.tasksRoot(base), join(brain, "projects"));
      assert.deepEqual(board.readBoard(base).projects.map((project) => project.id), ["p"]);
      assert.equal(board.tasksRoot(settingsFor(brain, { root: "alt" })), join(brain, "alt"));
      assert.equal(board.tasksRoot(settingsFor(brain, { root })), root);
      const off = board.readBoard(settingsFor(brain, { root: null }, false));
      assert.deepEqual(off, { enabled: false, root: null, configured: false, delegatePrompt: board.DEFAULT_TASK_DELEGATE_PROMPT, projects: [], tasks: [], errors: [], today: null });
      const missing = board.readBoard(settingsFor(brain, { root: "nope" }));
      assert.equal(missing.enabled, true);
      assert.equal(missing.configured, false);
      assert.deepEqual(missing.projects, []);
      const noBrain = { ...settingsFor(brain, { root: null }), secondBrainRoot: null };
      assert.equal(board.tasksRoot(noBrain), null);
      assert.equal(board.readBoard(noBrain).configured, false);
    } finally {
      rmSync(brain, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("returns top-level tasks of every project with subtasks and carries the effective delegate prompt", () => {
    const snapshot = board.readBoard(settingsFor(root, { delegatePrompt: "custom {{task}}" }));
    assert.equal(snapshot.delegatePrompt, "custom {{task}}");
    const di = snapshot.tasks.filter((task) => task.projectId === "acme-corp/globex/initech");
    assert.equal(di.length, 1);
    assert.equal(di[0]?.title, "Pilot validation");
    assert.equal(di[0]?.subtasks.length, 2);
    assert.equal(di[0]?.id, "acme-corp/globex/initech#8");
    assert.ok(!snapshot.tasks.some((task) => task.title === "hidden"));
    assert.equal(board.readBoard(settingsFor(root)).delegatePrompt, board.DEFAULT_TASK_DELEGATE_PROMPT);
  });
});

describe("section scoping", () => {
  it("only reads the configured section, keeps sub-heading groups and stops at the next same-level heading", () => {
    const md = [
      "# Title",
      "",
      "- [ ] before section",
      "",
      "## Open loops",
      "",
      "- [ ] first",
      "",
      "### Infra",
      "",
      "- [ ] grouped",
      "- [-] grouped doing",
      "",
      "#### Deeper",
      "",
      "- [x] deep group",
      "",
      "## Decisions",
      "",
      "- [ ] after section",
      "",
      "## open LOOPS",
      "",
      "- [ ] second section same name",
    ].join("\n");
    const tasks = board.parseBoardTasks(md, "p", defaults());
    assert.deepEqual(
      tasks.map((task) => [task.title, task.group, task.checkbox]),
      [
        ["first", null, "todo"],
        ["grouped", "Infra", "todo"],
        ["grouped doing", "Infra", "doing"],
        ["deep group", "Deeper", "done"],
        ["second section same name", null, "todo"],
      ],
    );
  });

  it("yields no tasks when the section heading is missing unless the section is empty", () => {
    const md = "# T\n\n## Other\n\n- [ ] x\n- [x] y\n";
    assert.deepEqual(board.parseBoardTasks(md, "p", defaults()), []);
    const whole = board.parseBoardTasks(md, "p", { ...defaults(), section: "" });
    assert.deepEqual(whole.map((task) => task.title), ["x", "y"]);
  });

  it("matches a custom section name and any heading level", () => {
    const md = "### Backlog\n\n- [ ] a\n\n#### Sub\n\n- [ ] b\n\n### Next\n\n- [ ] c\n";
    const tasks = board.parseBoardTasks(md, "p", { ...defaults(), section: "backlog" });
    assert.deepEqual(tasks.map((task) => [task.title, task.group]), [["a", null], ["b", "Sub"]]);
  });

  it("ignores fenced code, empty placeholders and tasks before the section", () => {
    const md = [
      "## Open loops",
      "",
      "- [ ]",
      "- [ ] real",
      "```md",
      "## Decisions",
      "- [ ] inside fence",
      "```",
      "~~~",
      "- [ ] inside tilde fence",
      "~~~",
      "- [ ] after fences",
      "* [x] star bullet",
    ].join("\n");
    const tasks = board.parseBoardTasks(md, "p", defaults());
    assert.deepEqual(tasks.map((task) => task.title), ["real", "after fences", "star bullet"]);
  });

  it("skips the frontmatter block when the whole document is the section", () => {
    const md = "---\ntags: [a]\n---\n\n- [ ] one\n";
    assert.deepEqual(board.parseBoardTasks(md, "p", { ...defaults(), section: "" }).map((task) => task.title), ["one"]);
  });
});

describe("prefix parsing", () => {
  const parse = (line: string) => board.parseBoardTasks(`## Open loops\n\n${line}\n`, "p", defaults())[0];

  it("parses BLOCK, HOLD with colon and ARCHIVED with an en dash", () => {
    const blocked = parse("- [ ] BLOCK - Test webhook");
    assert.equal(blocked?.status, "blocked");
    assert.equal(blocked?.prefix, "BLOCK");
    assert.equal(blocked?.title, "Test webhook");
    assert.equal(blocked?.checkbox, "todo");

    const hold = parse("- [ ] HOLD: WHO - waiting");
    assert.equal(hold?.status, "hold");
    assert.equal(hold?.prefix, "HOLD");
    assert.equal(hold?.title, "WHO");
    assert.equal(hold?.reason, "waiting");

    const archived = parse("- [x] ARCHIVED – old thing");
    assert.equal(archived?.status, "archived");
    assert.equal(archived?.checkbox, "done");
    assert.equal(archived?.title, "old thing");

    assert.equal(parse("- [-] BLOCKED - alias word")?.prefix, "BLOCKED");
    assert.equal(parse("- [-] BLOCKED - alias word")?.status, "blocked");
  });

  it("keeps unknown words and lookalikes in the title and the checkbox as status", () => {
    const backlog = parse("- [ ] BACKLOG - Banner copy");
    assert.equal(backlog?.status, "todo");
    assert.equal(backlog?.prefix, null);
    assert.equal(backlog?.title, "BACKLOG - Banner copy");
    for (const line of ["- [ ] block - lower case", "- [ ] BLOCKING - x", "- [ ] BLOCK x", "- [ ] BLOCK-x", "- [ ] HOLDER: x"]) {
      const task = parse(line);
      assert.equal(task?.prefix, null, line);
      assert.equal(task?.status, "todo", line);
    }
    assert.equal(parse("- [-] plain doing")?.status, "doing");
    assert.equal(parse("- [X] plain done")?.status, "done");
  });

  it("honours custom prefix words", () => {
    const custom = { ...defaults(), prefixes: { blocked: ["STOP"], hold: ["WAIT"], archived: ["DONE FOR GOOD"] } };
    const tasks = board.parseBoardTasks("## Open loops\n\n- [ ] STOP - a\n- [ ] WAIT: b\n- [ ] BLOCK - c\n- [ ] DONE FOR GOOD - d\n", "p", custom);
    assert.deepEqual(tasks.map((task) => task.status), ["blocked", "hold", "todo", "archived"]);
  });
});

describe("task shape, subtasks and notes", () => {
  it("nests subtasks by indentation and collects notes under their task", () => {
    const md = [
      "## Open loops",
      "",
      "- [ ] Parent",
      "  - [ ] Child one",
      "    - [-] Grandchild",
      "  - [x] Child two",
      "  - plain note A",
      "    - nested note B",
      "  continuation text",
      "- [ ] Sibling",
      "  - HOLD note-looking",
      "",
      "- unrelated bullet",
      "- [ ] Third",
    ].join("\n");
    const tasks = board.parseBoardTasks(md, "proj/x", defaults());
    assert.deepEqual(tasks.map((task) => task.title), ["Parent", "Sibling", "Third"]);
    const parent = tasks[0];
    assert.ok(parent);
    assert.equal(parent.id, "proj/x#2");
    assert.equal(parent.projectId, "proj/x");
    assert.equal(parent.line, 2);
    assert.equal(parent.raw, "- [ ] Parent");
    assert.equal(parent.depth, 0);
    assert.deepEqual(parent.subtasks.map((task) => task.title), ["Child one", "Child two"]);
    assert.equal(parent.subtasks[0]?.depth, 1);
    assert.equal(parent.subtasks[0]?.raw, "  - [ ] Child one");
    assert.deepEqual(parent.subtasks[0]?.subtasks.map((task) => [task.title, task.checkbox, task.depth, task.line]), [["Grandchild", "doing", 2, 4]]);
    assert.equal(parent.subtasks[1]?.status, "done");
    assert.deepEqual(parent.notes, ["plain note A", "nested note B", "continuation text"]);
    assert.deepEqual(parent.subtasks[0]?.notes, []);
    assert.deepEqual(tasks[1]?.notes, ["HOLD note-looking"]);
    assert.deepEqual(tasks[2]?.notes, []);
  });

  it("treats tab indentation as nesting and gives every task its group", () => {
    const md = "## Open loops\n\n### G\n\n- [ ] A\n\t- [ ] B\n";
    const tasks = board.parseBoardTasks(md, "p", defaults());
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.group, "G");
    assert.equal(tasks[0]?.subtasks[0]?.title, "B");
    assert.equal(tasks[0]?.subtasks[0]?.group, "G");
    assert.equal(tasks[0]?.subtasks[0]?.depth, 2);
  });

  it("does not parse CRLF carriage returns into titles", () => {
    const tasks = board.parseBoardTasks("## Open loops\r\n\r\n- [ ] crlf task\r\n", "p", defaults());
    assert.equal(tasks[0]?.title, "crlf task");
    assert.equal(tasks[0]?.raw, "- [ ] crlf task");
  });
});

describe("parser edge cases", () => {
  const BOM = "\uFEFF";
  const root = mkdtempSync(join(tmpdir(), "cch-tasks-edge-"));

  after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const titles = (md: string): string[] => board.parseBoardTasks(md, "p", defaults()).map((task) => task.title);

  it("closes a fence only with the same character, at least the same length and no info string", () => {
    assert.deepEqual(titles("## Open loops\n\n````md\n```\n- [ ] inside\n````\n\n- [ ] outside\n"), ["outside"]);
    assert.deepEqual(titles("## Open loops\n\n```\n```js\n- [ ] still inside\n```\n- [ ] outside\n"), ["outside"]);
    assert.deepEqual(titles("## Open loops\n\n~~~\n```\n- [ ] inside\n~~~\n- [ ] outside\n"), ["outside"]);
    assert.deepEqual(titles("## Open loops\n\n```\n- [ ] inside\n`````  \n- [ ] outside\n"), ["outside"]);
  });

  it("uses the same fence rule for the title fallback", () => {
    writeTree(root, { "fenced.md": "````md\n```\n# Fake\n````\n# Real\n\n## Open loops\n\n- [ ] a\n" });
    const project = board.readBoard(settingsFor(root)).projects.find((entry) => entry.id === "fenced");
    assert.equal(project?.title, "Real");
  });

  it("ignores a leading BOM when finding the section, the frontmatter and the title", () => {
    assert.deepEqual(titles(`${BOM}## Open loops\n\n- [ ] a\n`), ["a"]);
    assert.deepEqual(titles(`${BOM}---\ntitle: X\n---\n\n## Open loops\n\n- [ ] b\n`), ["b"]);
    writeTree(root, { "bom-title.md": `${BOM}# Bom Title\n\n## Open loops\n\n- [ ] c\n` });
    const project = board.readBoard(settingsFor(root)).projects.find((entry) => entry.id === "bom-title");
    assert.equal(project?.title, "Bom Title");
  });

  it("writes back keeping the BOM byte for byte", () => {
    writeTree(root, { "bom-write.md": `${BOM}## Open loops\n\n- [ ] keep\n`, "bom-whole.md": `${BOM}- [ ] first\n- [ ] second\n` });
    const section = board.readBoard(settingsFor(root)).tasks.find((task) => task.projectId === "bom-write");
    assert.ok(section);
    board.writeBoardTask(settingsFor(root), { projectId: "bom-write", line: section.line, raw: section.raw, status: "done" });
    assert.equal(readFileSync(join(root, "bom-write.md"), "utf8"), `${BOM}## Open loops\n\n- [x] keep\n`);
    const whole = settingsFor(root, { section: "" });
    const first = board.readBoard(whole).tasks.find((task) => task.projectId === "bom-whole" && task.line === 0);
    assert.ok(first);
    board.writeBoardTask(whole, { projectId: "bom-whole", line: first.line, raw: first.raw, status: "done" });
    assert.equal(readFileSync(join(root, "bom-whole.md"), "utf8"), `${BOM}- [x] first\n- [ ] second\n`);
  });

  it("does not attach the children of an empty placeholder to the task above it", () => {
    const flat = board.parseBoardTasks("## Open loops\n\n- [ ] A\n- [ ]\n  - [ ] child\n", "p", defaults());
    assert.deepEqual(flat.map((task) => task.title), ["A", "child"]);
    assert.deepEqual(flat[0]?.subtasks, []);
    const nested = board.parseBoardTasks("## Open loops\n\n- [ ] A\n  - [ ] B\n  - [ ]\n    - [ ] C\n  - [ ] D\n", "p", defaults());
    assert.deepEqual(nested.map((task) => task.title), ["A"]);
    assert.deepEqual(nested[0]?.subtasks.map((task) => task.title), ["B", "C", "D"]);
    assert.deepEqual(nested[0]?.subtasks[0]?.subtasks, []);
  });
});

describe("rewriteTaskLine", () => {
  const rule = (raw: string, status: Parameters<Board["rewriteTaskLine"]>[2]["status"]) => board.rewriteTaskLine(raw, defaults(), { status });

  it("todo, doing and done set the checkbox and strip any status prefix", () => {
    assert.equal(rule("- [-] x", "todo"), "- [ ] x");
    assert.equal(rule("- [ ] BLOCK - x", "todo"), "- [ ] x");
    assert.equal(rule("- [x] HOLD: WHO - waiting", "todo"), "- [ ] WHO - waiting");
    assert.equal(rule("- [ ] x", "doing"), "- [-] x");
    assert.equal(rule("- [x] ARCHIVED - x", "doing"), "- [-] x");
    assert.equal(rule("- [ ] x", "done"), "- [x] x");
    assert.equal(rule("  - [-] BLOCKED - nested", "done"), "  - [x] nested");
  });

  it("blocked and hold set the prefix, replace another status prefix and turn done into todo", () => {
    assert.equal(rule("- [ ] x", "blocked"), "- [ ] BLOCK - x");
    assert.equal(rule("- [x] x", "blocked"), "- [ ] BLOCK - x");
    assert.equal(rule("- [-] x", "hold"), "- [-] HOLD - x");
    assert.equal(rule("- [x] x", "hold"), "- [ ] HOLD - x");
    assert.equal(rule("- [ ] HOLD - x", "blocked"), "- [ ] BLOCK - x");
    assert.equal(rule("- [ ] ARCHIVED - x", "hold"), "- [ ] HOLD - x");
    assert.equal(rule("- [ ] HOLD: WHO - waiting", "hold"), "- [ ] HOLD: WHO - waiting");
    assert.equal(rule("- [ ] BLOCKED - x", "blocked"), "- [ ] BLOCKED - x");
  });

  it("archived sets the ARCHIVED prefix and keeps the checkbox", () => {
    assert.equal(rule("- [x] x", "archived"), "- [x] ARCHIVED - x");
    assert.equal(rule("- [-] x", "archived"), "- [-] ARCHIVED - x");
    assert.equal(rule("- [ ] BLOCK - x", "archived"), "- [ ] ARCHIVED - x");
  });

  it("writes prefixes with the configured separator and first word", () => {
    const custom = { ...defaults(), separator: ": ", prefixes: { blocked: ["STOP", "HALT"], hold: ["WAIT"], archived: ["GONE"] } };
    assert.equal(board.rewriteTaskLine("- [ ] x", custom, { status: "blocked" }), "- [ ] STOP: x");
    assert.equal(board.rewriteTaskLine("- [ ] x", custom, { status: "archived" }), "- [ ] GONE: x");
    assert.equal(board.rewriteTaskLine("- [ ] STOP: x", custom, { status: "todo" }), "- [ ] x");
  });

  it("rejects a prefix status that has no configured word", () => {
    const none = { ...defaults(), prefixes: { blocked: [], hold: ["HOLD"], archived: ["ARCHIVED"] } };
    assert.throws(() => board.rewriteTaskLine("- [ ] x", none, { status: "blocked" }), /blocked/);
  });

  it("renames only the title keeping indentation, bullet, checkbox and prefix", () => {
    const rename = (raw: string, title: string) => board.rewriteTaskLine(raw, defaults(), { title });
    assert.equal(rename("  - [-] old", "new"), "  - [-] new");
    assert.equal(rename("* [x] old", "new title"), "* [x] new title");
    assert.equal(rename("- [ ] HOLD: WHO - old", "new"), "- [ ] HOLD: new - old");
    assert.equal(rename("- [ ] HOLD: WHO", "new"), "- [ ] HOLD: new");
    assert.equal(rename("- [ ] BACKLOG - old", "BACKLOG - new"), "- [ ] BACKLOG - new");
    assert.equal(rename("- [ ] old", "  padded  "), "- [ ] padded");
  });

  it("combines a status change with a rename", () => {
    assert.equal(board.rewriteTaskLine("- [ ] old", defaults(), { status: "blocked", title: "new" }), "- [ ] BLOCK - new");
  });

  it("rejects an empty or multi-line title and a change with nothing in it", () => {
    for (const title of ["", "   ", "a\nb", "a\rb"]) {
      assert.throws(() => board.rewriteTaskLine("- [ ] x", defaults(), { title }), /title/);
    }
    assert.throws(() => board.rewriteTaskLine("- [ ] x", defaults(), {}), /status, title, reason or priority/);
    assert.throws(() => board.rewriteTaskLine("not a task", defaults(), { status: "done" }), /task line/);
  });
});

describe("writeBoardTask", () => {
  const root = mkdtempSync(join(tmpdir(), "cch-tasks-write-"));
  const doc = (eol: string): string =>
    ["---", "title: W", "---", "", "# W", "", "## Open loops", "", "- [ ] alpha", "  - [ ] sub", "- [ ] beta", ""].join(eol);

  before(() => writeTree(root, { "lf.md": doc("\n"), "crlf.md": doc("\r\n"), "other.md": "## Open loops\n\n- [ ] only\n" }));

  after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const taskAt = (projectId: string, title: string) => {
    const found = board.readBoard(settingsFor(root)).tasks.find((task) => task.projectId === projectId && task.title === title);
    assert.ok(found, `${projectId} ${title}`);
    return found;
  };

  it("writes the status, returns the fresh task and leaves other bytes untouched", () => {
    const before = readFileSync(join(root, "lf.md"), "utf8");
    const task = taskAt("lf", "beta");
    const result = board.writeBoardTask(settingsFor(root), { projectId: "lf", line: task.line, raw: task.raw, status: "blocked" });
    assert.equal(result.task.status, "blocked");
    assert.equal(result.task.title, "beta");
    assert.equal(result.task.raw, "- [ ] BLOCK - beta");
    assert.equal(result.task.line, task.line);
    assert.equal(typeof result.updatedAt, "number");
    assert.equal(readFileSync(join(root, "lf.md"), "utf8"), before.replace("- [ ] beta", "- [ ] BLOCK - beta"));
    const back = board.writeBoardTask(settingsFor(root), { projectId: "lf", line: result.task.line, raw: result.task.raw, status: "todo" });
    assert.equal(back.task.raw, "- [ ] beta");
    assert.equal(readFileSync(join(root, "lf.md"), "utf8"), before);
  });

  it("renames a subtask in place and keeps its parent link", () => {
    const parent = taskAt("lf", "alpha");
    const sub = parent.subtasks[0];
    assert.ok(sub);
    const result = board.writeBoardTask(settingsFor(root), { projectId: "lf", line: sub.line, raw: sub.raw, title: "renamed sub", status: "doing" });
    assert.equal(result.task.raw, "  - [-] renamed sub");
    assert.equal(taskAt("lf", "alpha").subtasks[0]?.title, "renamed sub");
  });

  it("preserves CRLF line endings and leaves no temp file behind", () => {
    const task = taskAt("crlf", "alpha");
    board.writeBoardTask(settingsFor(root), { projectId: "crlf", line: task.line, raw: task.raw, status: "done" });
    const content = readFileSync(join(root, "crlf.md"), "utf8");
    assert.ok(content.includes("- [x] alpha\r\n"));
    assert.equal(content.replace(/\r\n/g, "").includes("\n"), false);
    assert.equal(content.split("\r\n").length, doc("\r\n").split("\r\n").length);
    const stray = board.readBoard(settingsFor(root)).projects.map((project) => project.id);
    assert.deepEqual(stray.sort(), ["crlf", "lf", "other"]);
  });

  it("throws a conflict carrying the fresh task when the line changed on disk", () => {
    const task = taskAt("other", "only");
    writeFileSync(join(root, "other.md"), "## Open loops\n\n- [ ] only edited elsewhere\n");
    assert.throws(
      () => board.writeBoardTask(settingsFor(root), { projectId: "other", line: task.line, raw: task.raw, status: "done" }),
      (err: unknown) => {
        assert.ok(err instanceof board.TaskConflictError);
        assert.equal(err.current?.title, "only edited elsewhere");
        return true;
      },
    );
    assert.equal(readFileSync(join(root, "other.md"), "utf8"), "## Open loops\n\n- [ ] only edited elsewhere\n");
  });

  it("reports a conflict with a null task when the line no longer exists", () => {
    assert.throws(
      () => board.writeBoardTask(settingsFor(root), { projectId: "other", line: 40, raw: "- [ ] gone", status: "done" }),
      (err: unknown) => {
        assert.ok(err instanceof board.TaskConflictError);
        assert.equal(err.current, null);
        return true;
      },
    );
  });

  it("rejects unknown projects, non-task lines and invalid input", () => {
    assert.throws(() => board.writeBoardTask(settingsFor(root), { projectId: "ghost", line: 0, raw: "x", status: "done" }), /project/);
    assert.throws(() => board.writeBoardTask(settingsFor(root), { projectId: "other", line: 0, raw: "## Open loops", status: "done" }), /task line/);
    assert.throws(() => board.writeBoardTask(settingsFor(root), { projectId: "../escape", line: 0, raw: "x", status: "done" }), /project/);
    const task = taskAt("other", "only edited elsewhere");
    assert.throws(() => board.writeBoardTask(settingsFor(root), { projectId: "other", line: task.line, raw: task.raw, title: " " }), /title/);
    assert.throws(() => board.writeBoardTask(settingsFor(root, {}, false), { projectId: "other", line: task.line, raw: task.raw, status: "done" }), /disabled/);
  });
});

describe("writeBoardTask failures", () => {
  it("removes the tmp file and rethrows when the write cannot land", () => {
    const lockedRoot = mkdtempSync(join(tmpdir(), "cch-tasks-locked-"));
    const file = join(lockedRoot, "locked.md");
    writeFileSync(file, "## Open loops\n\n- [ ] stuck\n");
    const task = board.readBoard(settingsFor(lockedRoot)).tasks.find((candidate) => candidate.title === "stuck");
    assert.ok(task);
    const unlock = ((): (() => void) => {
      if (process.platform === "win32") {
        chmodSync(file, 0o444);
        return () => chmodSync(file, 0o666);
      }
      chmodSync(lockedRoot, 0o555);
      return () => chmodSync(lockedRoot, 0o755);
    })();
    try {
      assert.throws(() => board.writeBoardTask(settingsFor(lockedRoot), { projectId: "locked", line: task.line, raw: task.raw, status: "done" }));
      assert.deepEqual(
        readdirSync(lockedRoot).filter((name) => name.endsWith(".tmp")),
        [],
      );
      assert.equal(readFileSync(file, "utf8"), "## Open loops\n\n- [ ] stuck\n");
    } finally {
      unlock();
      rmSync(lockedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("delegate prompt", () => {
  it("renders every placeholder", () => {
    const rendered = board.renderTaskDelegatePrompt("{{project}}|{{projectPath}}|{{task}}|{{subtasks}}|{{notes}}|{{status}}|{{reason}}|{{task}}", {
      project: "Globex",
      projectPath: "/v/globex.md",
      task: "Do it",
      subtasks: "- [ ] a",
      notes: "none",
      status: "todo",
      reason: "waiting vendor",
      priority: "P1",
    });
    assert.equal(rendered, "Globex|/v/globex.md|Do it|- [ ] a|none|todo|waiting vendor|Do it");
  });

  it("ships a default template that uses the documented placeholders", () => {
    for (const placeholder of ["{{project}}", "{{projectPath}}", "{{task}}", "{{subtasks}}", "{{notes}}", "{{status}}"]) {
      assert.ok(board.DEFAULT_TASK_DELEGATE_PROMPT.includes(placeholder), placeholder);
    }
  });

  it("builds prompt vars with a markdown subtask list, or none", () => {
    const tasks = board.parseBoardTasks("## Open loops\n\n- [ ] Parent\n  - [ ] one\n    - [x] deep\n  - BLOCK - not a task, a note\n- [ ] Solo\n", "p", defaults());
    const project = { id: "p", name: "p", title: "Project P", parent: null, depth: 0, path: "/v/p.md", workspace: null, workspaceSource: null };
    const withSubs = board.taskPromptVars(project, tasks[0] as NonNullable<(typeof tasks)[number]>);
    assert.equal(withSubs.project, "Project P");
    assert.equal(withSubs.projectPath, "/v/p.md");
    assert.equal(withSubs.task, "Parent");
    assert.equal(withSubs.status, "todo");
    assert.equal(withSubs.reason, "none");
    assert.equal(withSubs.subtasks, "- [ ] one\n  - [x] deep");
    assert.equal(withSubs.notes, "- BLOCK - not a task, a note");
    const solo = board.taskPromptVars(project, tasks[1] as NonNullable<(typeof tasks)[number]>);
    assert.equal(solo.subtasks, "none");
    assert.equal(solo.notes, "none");
  });
});

describe("watcher", () => {
  const root = mkdtempSync(join(tmpdir(), "cch-tasks-watch-"));

  before(() => writeTree(root, { "area/area.md": "## Open loops\n\n- [ ] watched\n", "area/sub/deep.md": "## Open loops\n\n- [ ] deep\n", "_skip.md": "## Open loops\n\n- [ ] s\n" }));

  after(() => {
    board.stopTasksBoardWatch();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("broadcasts a disk event for external edits (recursively) and stays quiet for the hub's own write", async () => {
    const settings = settingsFor(root);
    const events: { source: string; projectId: string }[] = [];
    const unsubscribe = sse.onBroadcast((event, data) => {
      if (event === "tasks") events.push(data as { source: string; projectId: string });
    });
    board.watchTasksBoard(settings);

    writeFileSync(join(root, "area", "sub", "deep.md"), "## Open loops\n\n- [x] deep edited\n");
    const seen = await waitFor(async () => (events.length > 0 ? events[0] : null), 5000);
    assert.equal(seen?.source, "disk");
    assert.equal(seen?.projectId, "area/sub/deep");

    events.length = 0;
    const task = board.readBoard(settings).tasks.find((item) => item.projectId === "area/area");
    assert.ok(task);
    board.writeBoardTask(settings, { projectId: "area/area", line: task.line, raw: task.raw, status: "doing" });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { source: "hub", projectId: "area/area" });
    await sleep(700);
    assert.equal(events.length, 1, "echo of the hub write must not produce a disk broadcast");

    events.length = 0;
    writeFileSync(join(root, "area", "notes.txt"), "not markdown");
    writeFileSync(join(root, "_skip.md"), "## Open loops\n\n- [ ] skipped edit\n");
    await sleep(700);
    assert.equal(events.length, 0, "non-markdown and excluded files must not broadcast");

    writeFileSync(join(root, "area", "area.md"), "## Open loops\n\n- [ ] watched externally\n");
    await waitFor(async () => (events.length > 0 ? true : null), 5000);
    assert.equal(events[0]?.source, "disk");
    assert.equal(events[0]?.projectId, "area/area");

    unsubscribe();
  });

  it("stops watching when the feature is disabled", async () => {
    board.watchTasksBoard(settingsFor(root, {}, false));
    const events: unknown[] = [];
    const unsubscribe = sse.onBroadcast((event) => {
      if (event === "tasks") events.push(event);
    });
    writeFileSync(join(root, "area", "area.md"), "## Open loops\n\n- [ ] after disable\n");
    await sleep(700);
    assert.equal(events.length, 0);
    unsubscribe();
  });
});

describe("tasks board HTTP routes", () => {
  const box: Sandbox = makeSandbox("cch-tasks-http-");
  const vault = join(box.tmp, "vault");
  let hub: RunningServer;

  interface HttpResult {
    status: number;
    json: Record<string, unknown>;
  }

  async function http(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const res = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  interface WireTask {
    id: string;
    projectId: string;
    line: number;
    raw: string;
    title: string;
    status: string;
    subtasks: WireTask[];
  }

  before(async () => {
    writeTree(vault, {
      "org/org.md": "---\ntitle: Org\nworkspace: pilot\n---\n\n## Open loops\n\n- [ ] first task\n  - [ ] first sub\n- [ ] HOLD: WHO - waiting\n",
      "org/team.md": "## Open loops\n\n- [ ] team task\n",
    });
    hub = await startServer(box, { HUB_DELEGATION: "1" });
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const enable = async (): Promise<void> => {
    const res = await http("PUT", "/delegation/settings", {
      workspacesRoot: box.root,
      secondBrainRoot: box.brain,
      features: { tasks: true },
      tasks: { root: vault },
    });
    assert.equal(res.status, 200);
  };

  const fetchTasks = async (): Promise<WireTask[]> => ((await http("GET", "/delegation/tasks-board")).json.tasks as WireTask[]);

  it("reports the feature as unavailable until enabled, then lists projects and tasks", async () => {
    const off = await http("GET", "/delegation/tasks-board");
    assert.equal(off.status, 200);
    assert.equal(off.json.enabled, false);
    assert.equal(off.json.configured, false);
    assert.equal(off.json.root, null);
    assert.deepEqual(off.json.projects, []);
    assert.deepEqual(off.json.tasks, []);
    assert.deepEqual(off.json.errors, []);
    assert.equal((await http("PATCH", "/delegation/tasks-board/item", { projectId: "org/org", line: 6, raw: "x", status: "done" })).status, 400);

    await enable();
    const on = await http("GET", "/delegation/tasks-board");
    assert.equal(on.json.enabled, true);
    assert.equal(on.json.configured, true);
    assert.equal(on.json.root, vault);
    assert.equal(typeof on.json.delegatePrompt, "string");
    const projects = on.json.projects as { id: string; parent: string | null; workspace: string | null }[];
    assert.deepEqual(projects.map((project) => [project.id, project.parent, project.workspace]), [
      ["org/org", null, "pilot"],
      ["org/team", "org/org", "pilot"],
    ]);
    const tasks = on.json.tasks as WireTask[];
    assert.deepEqual(tasks.map((task) => task.title), ["first task", "WHO", "team task"]);
    assert.equal(tasks[0]?.subtasks[0]?.title, "first sub");
    assert.equal(tasks[1]?.status, "hold");
  });

  it("rejects an empty status prefix list", async () => {
    for (const key of ["blocked", "hold", "archived"]) {
      const res = await http("PUT", "/delegation/settings", { tasks: { prefixes: { [key]: [] } } });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, `tasks.prefixes.${key} needs at least one word`);
    }
  });

  it("validates the tasks settings patch", async () => {
    const put = (tasks: unknown) => http("PUT", "/delegation/settings", { tasks });
    assert.equal((await put({ root: 5 })).status, 400);
    assert.equal((await put({ section: 5 })).status, 400);
    assert.equal((await put({ prefixes: { blocked: "BLOCK" } })).status, 400);
    assert.equal((await put({ prefixes: { hold: [1] } })).status, 400);
    assert.equal((await put({ separator: "" })).status, 400);
    assert.equal((await put({ separator: "x" })).status, 400);
    assert.equal((await put({ exclude: "_*" })).status, 400);
    assert.equal((await put({ exclude: [3] })).status, 400);
    assert.equal((await put({ workspaceKey: "" })).status, 400);
    assert.equal((await put({ parentKey: 4 })).status, 400);
    assert.equal((await put({ delegatePrompt: 4 })).status, 400);
    assert.equal((await put({ markDoingOnDelegate: "yes" })).status, 400);
    assert.equal((await http("PUT", "/delegation/settings", { features: { tasks: "on" } })).status, 400);
    const ok = await put({
      section: "",
      prefixes: { hold: ["HOLD", "WAIT"] },
      separator: ": ",
      exclude: ["_*", "x"],
      delegatePrompt: "",
      markDoingOnDelegate: false,
    });
    assert.equal(ok.status, 200);
    const tasks = ok.json.tasks as Record<string, unknown>;
    assert.equal(tasks.section, "");
    assert.deepEqual(tasks.prefixes, { blocked: ["BLOCK", "BLOCKED"], hold: ["HOLD", "WAIT"], archived: ["ARCHIVED"] });
    assert.equal(tasks.separator, ": ");
    assert.deepEqual(tasks.exclude, ["_*", "x"]);
    assert.equal(tasks.delegatePrompt, null);
    assert.equal(tasks.markDoingOnDelegate, false);
    assert.equal(tasks.root, vault);
    const reset = await put({ section: "Open loops", prefixes: { hold: ["HOLD"] }, separator: " - ", exclude: ["_*"], markDoingOnDelegate: true });
    assert.equal(reset.status, 200);
  });

  it("patches a status through the real server, writes the file and rejects a stale raw with 409", async () => {
    const [first] = await fetchTasks();
    assert.ok(first);
    const patched = await http("PATCH", "/delegation/tasks-board/item", { projectId: first.projectId, line: first.line, raw: first.raw, status: "blocked" });
    assert.equal(patched.status, 200);
    const task = patched.json.task as WireTask;
    assert.equal(task.status, "blocked");
    assert.equal(task.raw, "- [ ] BLOCK - first task");
    assert.equal(typeof patched.json.updatedAt, "number");
    assert.ok(readFileSync(join(vault, "org", "org.md"), "utf8").includes("- [ ] BLOCK - first task\n  - [ ] first sub\n"));

    const stale = await http("PATCH", "/delegation/tasks-board/item", { projectId: first.projectId, line: first.line, raw: first.raw, status: "done" });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, "changed on disk");
    assert.equal((stale.json.current as WireTask).raw, "- [ ] BLOCK - first task");

    const gone = await http("PATCH", "/delegation/tasks-board/item", { projectId: first.projectId, line: 99, raw: "- [ ] nope", status: "done" });
    assert.equal(gone.status, 409);
    assert.equal(gone.json.current, null);

    const renamed = await http("PATCH", "/delegation/tasks-board/item", { projectId: first.projectId, line: task.line, raw: task.raw, title: "first renamed" });
    assert.equal(renamed.status, 200);
    assert.equal((renamed.json.task as WireTask).raw, "- [ ] BLOCK - first renamed");
  });

  it("validates PATCH bodies", async () => {
    const [first] = await fetchTasks();
    assert.ok(first);
    const patch = (body: Record<string, unknown>) => http("PATCH", "/delegation/tasks-board/item", { projectId: first.projectId, line: first.line, raw: first.raw, ...body });
    assert.equal((await patch({})).status, 400);
    assert.equal((await patch({ status: "weird" })).status, 400);
    assert.equal((await patch({ title: "" })).status, 400);
    assert.equal((await patch({ title: "a\nb" })).status, 400);
    assert.equal((await http("PATCH", "/delegation/tasks-board/item", { line: 1, raw: "x", status: "done" })).status, 400);
    assert.equal((await http("PATCH", "/delegation/tasks-board/item", { projectId: first.projectId, raw: "x", status: "done" })).status, 400);
    assert.equal((await http("PATCH", "/delegation/tasks-board/item", { projectId: "ghost", line: 1, raw: "x", status: "done" })).status, 404);
  });

  it("delegates a task to the hub, marks it doing and 409s on a stale raw", async () => {
    const tasks = await fetchTasks();
    const team = tasks.find((task) => task.title === "team task");
    assert.ok(team);

    const missing = await http("POST", "/delegation/tasks-board/delegate", { projectId: team.projectId, line: team.line, raw: team.raw, workspace: "pilot" });
    assert.equal(missing.status, 400);
    assert.equal(readFileSync(join(vault, "org", "team.md"), "utf8").includes("- [ ] team task"), true);
    const noWorkspace = await http("POST", "/delegation/tasks-board/delegate", { projectId: team.projectId, line: team.line, raw: team.raw, prompt: "go" });
    assert.equal(noWorkspace.status, 400);
    const ghost = await http("POST", "/delegation/tasks-board/delegate", { projectId: team.projectId, line: team.line, raw: team.raw, prompt: "go", workspace: "ghost" });
    assert.equal(ghost.status, 404);
    assert.equal(readFileSync(join(vault, "org", "team.md"), "utf8").includes("- [ ] team task"), true, "a failed delegation must not mark the task doing");

    const stale = await http("POST", "/delegation/tasks-board/delegate", { projectId: team.projectId, line: team.line, raw: "- [ ] outdated", prompt: "go", workspace: "pilot" });
    assert.equal(stale.status, 409);

    const created = await http("POST", "/delegation/tasks-board/delegate", {
      projectId: team.projectId,
      line: team.line,
      raw: team.raw,
      workspace: "pilot",
      prompt: "please do the team task",
    });
    assert.equal(created.status, 201);
    const taskId = created.json.taskId as string;
    assert.equal(typeof taskId, "string");
    assert.equal((created.json.task as WireTask).status, "doing");
    assert.equal((created.json.task as WireTask).raw, "- [-] team task");
    assert.equal(readFileSync(join(vault, "org", "team.md"), "utf8"), "## Open loops\n\n- [-] team task\n");

    const detail = await http("GET", `/delegation/tasks/${taskId}`);
    assert.equal(detail.status, 200);
    const record = detail.json.task as { title: string; workspace: string; createdBy: string; prompt: string };
    assert.equal(record.title, "team task");
    assert.equal(record.workspace, "pilot");
    assert.equal(record.createdBy, "tasks-board");
    assert.equal(record.prompt, "please do the team task");
  });

  it("still answers 201 with a warning when the doing mark cannot be written", async () => {
    await http("PUT", "/delegation/settings", { tasks: { markDoingOnDelegate: true } });
    const file = join(vault, "org", "warn.md");
    writeFileSync(file, "## Open loops\n\n- [ ] warn task\n");
    const target = (await fetchTasks()).find((task) => task.title === "warn task");
    assert.ok(target);
    const dir = dirname(file);
    const lockWrites = (): (() => void) => {
      if (process.platform === "win32") {
        chmodSync(file, 0o444);
        return () => chmodSync(file, 0o666);
      }
      chmodSync(dir, 0o555);
      return () => chmodSync(dir, 0o755);
    };
    const unlock = lockWrites();
    let created: HttpResult;
    try {
      created = await http("POST", "/delegation/tasks-board/delegate", { projectId: target.projectId, line: target.line, raw: target.raw, workspace: "pilot", prompt: "do it" });
    } finally {
      unlock();
    }
    assert.equal(created.status, 201);
    assert.equal(typeof created.json.taskId, "string");
    assert.equal(typeof created.json.warning, "string");
    assert.equal((created.json.task as WireTask).raw, "- [ ] warn task");
    assert.equal(readFileSync(file, "utf8"), "## Open loops\n\n- [ ] warn task\n");
    const detail = await http("GET", `/delegation/tasks/${created.json.taskId as string}`);
    assert.equal(detail.status, 200);
  });

  it("leaves the checkbox alone when markDoingOnDelegate is off or the task is not todo", async () => {
    await http("PUT", "/delegation/settings", { tasks: { markDoingOnDelegate: false } });
    const fresh = (await fetchTasks()).find((task) => task.title === "WHO");
    assert.ok(fresh);
    const before = readFileSync(join(vault, "org", "org.md"), "utf8");
    const created = await http("POST", "/delegation/tasks-board/delegate", { projectId: fresh.projectId, line: fresh.line, raw: fresh.raw, workspace: "pilot", prompt: "hold on" });
    assert.equal(created.status, 201);
    assert.equal((created.json.task as WireTask).status, "hold");
    assert.equal(readFileSync(join(vault, "org", "org.md"), "utf8"), before);

    await http("PUT", "/delegation/settings", { tasks: { markDoingOnDelegate: true } });
    const again = await http("POST", "/delegation/tasks-board/delegate", { projectId: fresh.projectId, line: fresh.line, raw: fresh.raw, workspace: "pilot", prompt: "still hold" });
    assert.equal(again.status, 201);
    assert.equal((again.json.task as WireTask).status, "hold");
    assert.equal(readFileSync(join(vault, "org", "org.md"), "utf8"), before);
  });

  it("broadcasts tasks events over SSE for hub writes and for external edits", async () => {
    const controller = new AbortController();
    const stream = await fetch(`${hub.base}/api/events`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.ok(stream.body);
    let received = "";
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          received += decoder.decode(chunk.value);
        }
      } catch {
        return;
      }
    })();
    const [first] = await fetchTasks();
    assert.ok(first);
    await http("PATCH", "/delegation/tasks-board/item", { projectId: first.projectId, line: first.line, raw: first.raw, status: "done" });
    await waitFor(async () => (received.includes("event: tasks") && received.includes('"source":"hub"') ? true : null), 5000);
    writeFileSync(join(vault, "org", "team.md"), "## Open loops\n\n- [ ] external\n");
    await waitFor(async () => (received.includes('"source":"disk"') ? true : null), 5000);
    controller.abort();
    assert.ok(existsSync(join(vault, "org", "team.md")));
  });
});

describe("reason separator", () => {
  const parse = (line: string, tasks: Partial<DelegationSettings["tasks"]> = {}) =>
    board.parseBoardTasks(`## Open loops\n\n${line}\n`, "p", { ...defaults(), ...tasks })[0];
  const rewrite = (raw: string, change: Parameters<Board["rewriteTaskLine"]>[2], tasks: Partial<DelegationSettings["tasks"]> = {}) =>
    board.rewriteTaskLine(raw, { ...defaults(), ...tasks }, change);

  it("splits blocked, hold and archived text at the last separator", () => {
    const blocked = parse("- [ ] BLOCK - Test webhook - waiting vendor");
    assert.equal(blocked?.title, "Test webhook");
    assert.equal(blocked?.reason, "waiting vendor");
    assert.equal(blocked?.status, "blocked");
    const hold = parse("- [ ] HOLD: WHO - waiting");
    assert.equal(hold?.title, "WHO");
    assert.equal(hold?.reason, "waiting");
    const archived = parse("- [x] ARCHIVED – Old thing - superseded");
    assert.equal(archived?.title, "Old thing");
    assert.equal(archived?.reason, "superseded");
    const many = parse("- [ ] BLOCK - a - b - c");
    assert.equal(many?.title, "a - b");
    assert.equal(many?.reason, "c");
  });

  it("honours a custom separator such as a pipe", () => {
    const cfg = { reasonSeparator: " | " };
    const hold = parse("- [ ] HOLD - Acme rollout | waiting legal", cfg);
    assert.equal(hold?.title, "Acme rollout");
    assert.equal(hold?.reason, "waiting legal");
    const dashed = parse("- [ ] HOLD - Acme - phase | legal", cfg);
    assert.equal(dashed?.title, "Acme - phase");
    assert.equal(dashed?.reason, "legal");
    const none = parse("- [ ] BLOCK - Acme - phase", cfg);
    assert.equal(none?.title, "Acme - phase");
    assert.equal(none?.reason, null);
    const tight = parse("- [ ] ARCHIVED - Acme|gone", { reasonSeparator: "|" });
    assert.equal(tight?.title, "Acme");
    assert.equal(tight?.reason, "gone");
  });

  it("keeps the whole text as the title when the separator is missing or a side is empty", () => {
    assert.equal(parse("- [ ] BLOCK - Test webhook")?.reason, null);
    const leading = parse("- [ ] HOLD - |legal", { reasonSeparator: "|" });
    assert.equal(leading?.title, "|legal");
    assert.equal(leading?.reason, null);
    const trailing = parse("- [ ] HOLD - Acme|", { reasonSeparator: "|" });
    assert.equal(trailing?.title, "Acme|");
    assert.equal(trailing?.reason, null);
  });

  it("never splits todo, doing and done tasks", () => {
    for (const line of ["- [ ] Plan - phase two", "- [-] Plan - phase two", "- [x] Plan - phase two"]) {
      const task = parse(line);
      assert.equal(task?.title, "Plan - phase two", line);
      assert.equal(task?.reason, null, line);
    }
  });

  it("sets, replaces and clears a reason keeping the title and the prefix as written", () => {
    assert.equal(rewrite("- [ ] BLOCK - Test webhook", { reason: "waiting vendor" }), "- [ ] BLOCK - Test webhook - waiting vendor");
    assert.equal(rewrite("- [ ] BLOCK - Test webhook - waiting vendor", { reason: "vendor replied" }), "- [ ] BLOCK - Test webhook - vendor replied");
    assert.equal(rewrite("- [ ] BLOCK - Test webhook - waiting vendor", { reason: null }), "- [ ] BLOCK - Test webhook");
    assert.equal(rewrite("- [ ] BLOCK - Test webhook - waiting vendor", { reason: "   " }), "- [ ] BLOCK - Test webhook");
    assert.equal(rewrite("- [ ] HOLD: WHO - waiting", { reason: "legal" }), "- [ ] HOLD: WHO - legal");
    assert.equal(rewrite("- [ ] HOLD - Acme", { reason: "legal" }, { reasonSeparator: " | " }), "- [ ] HOLD - Acme | legal");
  });

  it("keeps the reason on a title edit and the full text when the status leaves the reason group", () => {
    assert.equal(rewrite("- [ ] HOLD: WHO - waiting", { title: "WHO now" }), "- [ ] HOLD: WHO now - waiting");
    assert.equal(rewrite("- [ ] BLOCK - Test - waiting", { status: "todo" }), "- [ ] Test - waiting");
    assert.equal(rewrite("- [ ] BLOCK - Test - waiting", { status: "hold" }), "- [ ] HOLD - Test - waiting");
    assert.equal(rewrite("- [ ] Plan", { status: "hold", reason: "legal" }), "- [ ] HOLD - Plan - legal");
    assert.throws(() => rewrite("- [ ] BLOCK - Test", { status: "todo", reason: "x" }), /reason only applies/);
    assert.equal(rewrite("- [ ] BLOCK - Test - waiting", { status: "todo", reason: null }), "- [ ] Test");
  });

  it("rejects a reason where it does not apply or that cannot round-trip", () => {
    assert.throws(() => rewrite("- [ ] Plain", { reason: "x" }), /reason/);
    assert.throws(() => rewrite("- [ ] Plain", { reason: null }), /reason/);
    assert.throws(() => rewrite("- [ ] BLOCK - a", { reason: "x\ny" }), /reason/);
    assert.throws(() => rewrite("- [ ] BLOCK - a", { reason: "x - y" }), /separator/);
    assert.throws(() => rewrite("- [ ] BLOCK - a", { reason: 5 as unknown as string }), /reason/);
  });

  it("exposes the reason in prompt vars as none when absent", () => {
    const tasks = board.parseBoardTasks("## Open loops\n\n- [ ] HOLD - Acme - legal\n  - [ ] BLOCK - Sub - vendor\n- [ ] Solo\n", "p", defaults());
    const project = { id: "p", name: "p", title: "P", parent: null, depth: 0, path: "/v/p.md", workspace: null, workspaceSource: null };
    const held = board.taskPromptVars(project, tasks[0] as NonNullable<(typeof tasks)[number]>);
    assert.equal(held.reason, "legal");
    assert.equal(held.task, "Acme");
    assert.equal(held.subtasks, "- [ ] BLOCK - Sub - vendor");
    assert.equal(board.taskPromptVars(project, tasks[1] as NonNullable<(typeof tasks)[number]>).reason, "none");
    assert.equal(board.renderTaskDelegatePrompt("r={{reason}}", held), "r=legal");
  });
});

describe("done section parsing", () => {
  const doc = [
    "## Open loops",
    "",
    "- [ ] Open one",
    "",
    "## Done loops",
    "",
    "- [x] Shipped ✅ 2026-01-02",
    "  - [x] Shipped sub",
    "- [x] No stamp",
    "- [x] Reasoned - not a reason ✅ 2026-03-04",
    "",
    "## Notes",
    "",
    "- [ ] Outside",
    "",
  ].join("\n");

  it("parses tasks under the done heading with section, doneAt and a clean title", () => {
    const tasks = board.parseBoardTasks(doc, "p", { ...defaults(), doneSection: "Done loops" });
    assert.deepEqual(tasks.map((task) => [task.title, task.section, task.doneAt]), [
      ["Open one", "open", null],
      ["Shipped", "done", "2026-01-02"],
      ["No stamp", "done", null],
      ["Reasoned - not a reason", "done", "2026-03-04"],
    ]);
    assert.equal(tasks[1]?.raw, "- [x] Shipped ✅ 2026-01-02");
    assert.equal(tasks[1]?.subtasks[0]?.section, "done");
    assert.equal(tasks[1]?.subtasks[0]?.doneAt, null);
    assert.equal(tasks[1]?.status, "done");
  });

  it("ignores the done heading while the setting is empty and labels everything open", () => {
    const tasks = board.parseBoardTasks(doc, "p", defaults());
    assert.deepEqual(tasks.map((task) => [task.title, task.section]), [["Open one", "open"]]);
  });

  it("matches the stamp from a custom template and also reads the default shape", () => {
    const custom = { ...defaults(), doneSection: "Done loops", doneStamp: " (done {{date}})" };
    const tasks = board.parseBoardTasks("## Open loops\n\n## Done loops\n\n- [x] A (done 2026-05-06)\n- [x] B ✅ 2026-05-06\n", "p", custom);
    assert.equal(tasks[0]?.title, "A");
    assert.equal(tasks[0]?.doneAt, "2026-05-06");
    assert.equal(tasks[1]?.title, "B");
    assert.equal(tasks[1]?.doneAt, "2026-05-06");
  });
});

describe("tasks board round 2 routes", () => {
  const box: Sandbox = makeSandbox("cch-tasks-r2-");
  const vault = join(box.tmp, "vault");
  let hub: RunningServer;

  interface HttpResult {
    status: number;
    json: Record<string, unknown>;
  }

  interface WireTask {
    id: string;
    projectId: string;
    line: number;
    raw: string;
    depth: number;
    title: string;
    reason: string | null;
    status: string;
    section: string;
    doneAt: string | null;
    subtasks: WireTask[];
  }

  async function http(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const res = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  const today = (): string => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };
  const stamp = (date = today()): string => ` ✅ ${date}`;
  const flat = (tasks: WireTask[]): WireTask[] => tasks.flatMap((task) => [task, ...flat(task.subtasks)]);
  const DEFAULT_TASKS = { section: "Open loops", doneSection: "", doneStamp: " ✅ {{date}}", reasonSeparator: " - ", separator: " - ", markDoingOnDelegate: true };

  const configure = async (dir: string, tasks: Record<string, unknown> = {}): Promise<void> => {
    const res = await http("PUT", "/delegation/settings", {
      workspacesRoot: box.root,
      secondBrainRoot: box.brain,
      features: { tasks: true },
      tasks: { ...DEFAULT_TASKS, root: join(vault, dir), ...tasks },
    });
    assert.equal(res.status, 200);
  };
  const reset = (dir: string, files: Record<string, string>): void => {
    rmSync(join(vault, dir), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    writeTree(join(vault, dir), files);
  };
  const read = (rel: string): string => readFileSync(join(vault, rel), "utf8");
  const listTasks = async (): Promise<WireTask[]> => flat((await http("GET", "/delegation/tasks-board")).json.tasks as WireTask[]);
  const find = async (projectId: string, title: string): Promise<WireTask> => {
    const found = (await listTasks()).find((task) => task.projectId === projectId && task.title === title);
    assert.ok(found, `${projectId} ${title}`);
    return found;
  };
  const patch = (task: WireTask, change: Record<string, unknown>): Promise<HttpResult> =>
    http("PATCH", "/delegation/tasks-board/item", { projectId: task.projectId, line: task.line, raw: task.raw, ...change });
  const create = (body: Record<string, unknown>): Promise<HttpResult> => http("POST", "/delegation/tasks-board/item", body);

  before(async () => {
    mkdirSync(vault, { recursive: true });
    hub = await startServer(box, { HUB_DELEGATION: "1" });
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("validates and round-trips reasonSeparator, doneSection and doneStamp", async () => {
    await configure("settings");
    const put = (tasks: unknown) => http("PUT", "/delegation/settings", { tasks });
    for (const value of ["", "   ", 5, "a\nb", null]) assert.equal((await put({ reasonSeparator: value })).status, 400, String(value));
    for (const value of [5, "a\nb", null]) assert.equal((await put({ doneSection: value })).status, 400, String(value));
    for (const value of ["done", "", 5, "x {{date}}\ny", null]) assert.equal((await put({ doneStamp: value })).status, 400, String(value));
    assert.match(String((await put({ doneStamp: "no date" })).json.error), /\{\{date\}\}/);
    assert.equal((await put({ reasonSeparator: "" })).json.error, "tasks.reasonSeparator must be a single-line string with text in it");
    const ok = await put({ reasonSeparator: " | ", doneSection: "Done loops", doneStamp: " (done {{date}})" });
    assert.equal(ok.status, 200);
    const got = (await http("GET", "/delegation/settings")).json.tasks as Record<string, unknown>;
    assert.equal(got.reasonSeparator, " | ");
    assert.equal(got.doneSection, "Done loops");
    assert.equal(got.doneStamp, " (done {{date}})");
    const cleared = await put({ doneSection: "   " });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.json.tasks as Record<string, unknown>).doneSection, "");
    await configure("settings");
  });

  it("sets, replaces and clears a reason through PATCH, keeps it on a title edit and validates", async () => {
    reset("reason", { "reason.md": "## Open loops\n\n- [ ] BLOCK - Test webhook\n- [ ] HOLD - Legal review - waiting counsel\n- [ ] Plain task\n" });
    await configure("reason");
    const blocked = await find("reason", "Test webhook");
    assert.equal(blocked.reason, null);
    const set = await patch(blocked, { reason: "waiting vendor" });
    assert.equal(set.status, 200);
    const setTask = set.json.task as WireTask;
    assert.equal(setTask.raw, "- [ ] BLOCK - Test webhook - waiting vendor");
    assert.equal(setTask.title, "Test webhook");
    assert.equal(setTask.reason, "waiting vendor");
    assert.ok(read("reason/reason.md").includes("- [ ] BLOCK - Test webhook - waiting vendor\n"));
    const replaced = await patch(setTask, { reason: "vendor replied" });
    assert.equal((replaced.json.task as WireTask).reason, "vendor replied");
    const cleared = await patch(replaced.json.task as WireTask, { reason: null });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.json.task as WireTask).raw, "- [ ] BLOCK - Test webhook");
    assert.equal((cleared.json.task as WireTask).reason, null);

    const legal = await find("reason", "Legal review");
    assert.equal(legal.reason, "waiting counsel");
    const renamed = await patch(legal, { title: "Legal sign-off" });
    assert.equal((renamed.json.task as WireTask).raw, "- [ ] HOLD - Legal sign-off - waiting counsel");
    assert.equal((renamed.json.task as WireTask).reason, "waiting counsel");

    const plain = await find("reason", "Plain task");
    assert.equal((await patch(plain, { reason: "x" })).status, 400);
    assert.equal((await patch(plain, { reason: null })).status, 400);
    assert.equal((await patch(renamed.json.task as WireTask, { reason: 5 })).status, 400);
    assert.equal((await patch(renamed.json.task as WireTask, { reason: "a\nb" })).status, 400);
    assert.equal((await patch(renamed.json.task as WireTask, { reason: "a - b" })).status, 400);

    const toHold = await patch(plain, { status: "hold", reason: "later" });
    assert.equal(toHold.status, 200);
    assert.equal((toHold.json.task as WireTask).raw, "- [ ] HOLD - Plain task - later");
    const out = await patch(toHold.json.task as WireTask, { status: "todo" });
    assert.equal((out.json.task as WireTask).raw, "- [ ] Plain task - later");
    assert.equal((out.json.task as WireTask).title, "Plain task - later");
    assert.equal((out.json.task as WireTask).reason, null);
    assert.equal((await patch({ ...blocked, raw: "- [ ] BLOCK - Test webhook edited" }, { reason: "stale" })).status, 409);
  });

  it("splits with a pipe separator end to end", async () => {
    reset("pipe", { "pipe.md": "## Open loops\n\n- [ ] HOLD - Acme rollout | waiting legal\n- [ ] BLOCK - Plain - dash\n" });
    await configure("pipe", { reasonSeparator: " | " });
    const held = await find("pipe", "Acme rollout");
    assert.equal(held.reason, "waiting legal");
    assert.equal((await find("pipe", "Plain - dash")).reason, null);
    const changed = await patch(held, { reason: "counsel back" });
    assert.equal((changed.json.task as WireTask).raw, "- [ ] HOLD - Acme rollout | counsel back");
  });

  const OPEN_DOC = (eol = "\n"): string =>
    ["# Acme", "", "## Open loops", "", "- [ ] Alpha", "  - [ ] Alpha one", "  - [ ] Alpha two", "- [ ] Beta", "- [ ] Gamma", "  - [ ] Gamma one", "    - [ ] Gamma deep", "", "## Notes", "", "keep me", ""].join(eol);

  it("keeps round-1 behaviour while the done section is empty", async () => {
    reset("off", { "acme.md": OPEN_DOC() });
    await configure("off");
    const beta = await find("acme", "Beta");
    const res = await patch(beta, { status: "done" });
    assert.equal(res.status, 200);
    assert.equal(res.json.moved, false);
    assert.equal(read("off/acme.md"), OPEN_DOC().replace("- [ ] Beta", "- [x] Beta"));
    assert.equal((res.json.task as WireTask).section, "open");
    assert.equal((res.json.task as WireTask).doneAt, null);
  });

  it("moves a finished task into a created done section stamped with today", async () => {
    reset("move", { "acme.md": OPEN_DOC() });
    await configure("move", { doneSection: "Done loops" });
    const beta = await find("acme", "Beta");
    const res = await patch(beta, { status: "done" });
    assert.equal(res.status, 200);
    assert.equal(res.json.moved, true);
    const task = res.json.task as WireTask;
    assert.equal(task.section, "done");
    assert.equal(task.doneAt, today());
    assert.equal(task.title, "Beta");
    assert.equal(task.raw, `- [x] Beta${stamp()}`);
    const expected = OPEN_DOC().replace("- [ ] Beta\n", "").replace("\n## Notes", `\n## Done loops\n\n- [x] Beta${stamp()}\n\n## Notes`);
    assert.equal(read("move/acme.md"), expected);
    const listed = await listTasks();
    assert.equal(listed.find((entry) => entry.id === task.id)?.title, "Beta");
    assert.equal(listed.find((entry) => entry.title === "Beta")?.section, "done");
  });

  it("moves a parent with its whole block only when it is done and every descendant is done", async () => {
    reset("block", { "acme.md": OPEN_DOC() });
    await configure("block", { doneSection: "Done loops" });
    const alpha = await find("acme", "Alpha");
    const parentDone = await patch(alpha, { status: "done" });
    assert.equal(parentDone.json.moved, false);
    const one = await find("acme", "Alpha one");
    const oneDone = await patch(one, { status: "done" });
    assert.equal(oneDone.json.moved, false);
    const two = await find("acme", "Alpha two");
    const twoDone = await patch(two, { status: "done" });
    assert.equal(twoDone.json.moved, true);
    const moved = twoDone.json.task as WireTask;
    assert.equal(moved.section, "done");
    assert.equal(moved.title, "Alpha two");
    assert.equal(moved.raw, "  - [x] Alpha two");
    assert.equal(moved.depth, 1);
    const content = read("block/acme.md");
    assert.ok(content.includes(`## Done loops\n\n- [x] Alpha${stamp()}\n  - [x] Alpha one\n  - [x] Alpha two\n`));
    assert.ok(!content.slice(0, content.indexOf("## Done loops")).includes("Alpha"));
    const wire = (await listTasks()).find((task) => task.title === "Alpha");
    assert.equal(wire?.section, "done");
    assert.equal(wire?.subtasks.length, 2);
  });

  it("does not move a done parent while a nested sub-subtask is still open", async () => {
    reset("nested", { "acme.md": OPEN_DOC() });
    await configure("nested", { doneSection: "Done loops" });
    const gamma = await find("acme", "Gamma");
    assert.equal((await patch(gamma, { status: "done" })).json.moved, false);
    const gammaOne = await find("acme", "Gamma one");
    const second = await patch(gammaOne, { status: "done" });
    assert.equal(second.status, 200);
    assert.equal(second.json.moved, false);
    assert.ok(!read("nested/acme.md").includes("Done loops"));
    assert.ok(read("nested/acme.md").includes("- [x] Gamma\n  - [x] Gamma one\n    - [ ] Gamma deep\n"));
    const deep = await find("acme", "Gamma deep");
    const last = await patch(deep, { status: "done" });
    assert.equal(last.json.moved, true);
    assert.equal(
      read("nested/acme.md"),
      OPEN_DOC()
        .replace("- [ ] Gamma\n  - [ ] Gamma one\n    - [ ] Gamma deep\n", "")
        .replace("\n## Notes", `\n## Done loops\n\n- [x] Gamma${stamp()}\n  - [x] Gamma one\n    - [x] Gamma deep\n\n## Notes`),
    );
  });

  it("does not turn a parent done when its last subtask finishes", async () => {
    reset("parent", { "acme.md": "## Open loops\n\n- [ ] Delta\n  - [ ] Delta one\n" });
    await configure("parent", { doneSection: "Done loops" });
    const sub = await find("acme", "Delta one");
    const res = await patch(sub, { status: "done" });
    assert.equal(res.json.moved, false);
    assert.equal(read("parent/acme.md"), "## Open loops\n\n- [ ] Delta\n  - [x] Delta one\n");
  });

  it("does not move archived tasks and ignores title-only edits", async () => {
    reset("skip", { "acme.md": "## Open loops\n\n- [x] ARCHIVED - old\n- [x] Finished\n" });
    await configure("skip", { doneSection: "Done loops" });
    const finished = await find("acme", "Finished");
    const renamed = await patch(finished, { title: "Finished again" });
    assert.equal(renamed.json.moved, false);
    const archived = await find("acme", "old");
    assert.equal((await patch(archived, { status: "archived" })).json.moved, false);
    assert.ok(!read("skip/acme.md").includes("Done loops"));
  });

  it("inserts at the top of an existing done section after its heading and blank line", async () => {
    reset("top", { "acme.md": `## Open loops\n\n- [ ] One\n- [ ] Two\n\n## Done loops\n\n- [x] Old${stamp("2026-01-01")}\n` });
    await configure("top", { doneSection: "Done loops" });
    const two = await find("acme", "Two");
    const res = await patch(two, { status: "done" });
    assert.equal(res.json.moved, true);
    assert.equal(read("top/acme.md"), `## Open loops\n\n- [ ] One\n\n## Done loops\n\n- [x] Two${stamp()}\n- [x] Old${stamp("2026-01-01")}\n`);
    const old = await find("acme", "Old");
    assert.equal(old.doneAt, "2026-01-01");
    assert.equal(old.section, "done");
  });

  it("writes the stamp from a custom template and parses doneAt back", async () => {
    reset("stamp", { "acme.md": "## Open loops\n\n- [ ] Two\n" });
    await configure("stamp", { doneSection: "Finished", doneStamp: " (done {{date}})" });
    const res = await patch(await find("acme", "Two"), { status: "done" });
    const task = res.json.task as WireTask;
    assert.equal(task.raw, `- [x] Two (done ${today()})`);
    assert.equal(task.title, "Two");
    assert.equal(task.doneAt, today());
    assert.equal(read("stamp/acme.md"), `## Open loops\n\n## Finished\n\n- [x] Two (done ${today()})\n`);
  });

  it("moves a done-section task back to the end of the open section and strips the stamp", async () => {
    const doc = `## Open loops\n\n- [ ] One\n\n## Done loops\n\n- [x] Shipped${stamp("2026-01-01")}\n  - [x] part\n`;
    reset("back", { "acme.md": doc });
    await configure("back", { doneSection: "Done loops" });
    const res = await patch(await find("acme", "Shipped"), { status: "todo" });
    assert.equal(res.status, 200);
    assert.equal(res.json.moved, true);
    const task = res.json.task as WireTask;
    assert.equal(task.section, "open");
    assert.equal(task.doneAt, null);
    assert.equal(task.raw, "- [ ] Shipped");
    assert.equal(task.status, "todo");
    assert.equal(read("back/acme.md"), "## Open loops\n\n- [ ] One\n- [ ] Shipped\n  - [x] part\n\n## Done loops\n\n-\n");
    reset("back", { "acme.md": doc });
    const blocked = await patch(await find("acme", "Shipped"), { status: "blocked", reason: "audit" });
    assert.equal(blocked.json.moved, true);
    assert.equal((blocked.json.task as WireTask).raw, "- [ ] BLOCK - Shipped - audit");
    assert.equal((blocked.json.task as WireTask).reason, "audit");
  });

  it("moves the top-level block back when a subtask in the done section is reopened, and leaves renames in place", async () => {
    const doc = `## Open loops\n\n## Done loops\n\n- [x] Shipped${stamp("2026-01-01")}\n  - [x] part\n`;
    reset("backsub", { "acme.md": doc });
    await configure("backsub", { doneSection: "Done loops" });
    const renamed = await patch(await find("acme", "Shipped"), { title: "Shipped v2" });
    assert.equal(renamed.json.moved, false);
    assert.equal((renamed.json.task as WireTask).raw, `- [x] Shipped v2${stamp("2026-01-01")}`);
    assert.equal((renamed.json.task as WireTask).doneAt, "2026-01-01");
    const res = await patch(await find("acme", "part"), { status: "todo" });
    assert.equal(res.json.moved, true);
    assert.equal((res.json.task as WireTask).raw, "  - [ ] part");
    assert.equal((res.json.task as WireTask).section, "open");
    assert.equal(read("backsub/acme.md"), "## Open loops\n\n- [x] Shipped v2\n  - [ ] part\n\n## Done loops\n\n-\n");
  });

  it("sweeps eligible done tasks per project or everywhere and reports counts", async () => {
    const s1 = "## Open loops\n\n- [x] First\n- [x] Second\n  - [x] Second sub\n- [x] Third\n  - [ ] Third open\n- [x] ARCHIVED - Fourth\n- [ ] Fifth\n";
    reset("sweep", { "s1.md": s1, "s2.md": "## Open loops\n\n- [x] Solo\n- [ ] Pending\n", "s3.md": "## Open loops\n\n- [ ] Nothing\n" });
    await configure("sweep", { doneSection: "Done loops" });
    const scoped = await http("POST", "/delegation/tasks-board/sweep-done", { projectId: "s1" });
    assert.equal(scoped.status, 200);
    assert.deepEqual(scoped.json, { moved: 2, projects: ["s1"] });
    assert.equal(
      read("sweep/s1.md"),
      `## Open loops\n\n- [x] Third\n  - [ ] Third open\n- [x] ARCHIVED - Fourth\n- [ ] Fifth\n\n## Done loops\n\n- [x] First${stamp()}\n- [x] Second${stamp()}\n  - [x] Second sub\n`,
    );
    assert.equal(read("sweep/s2.md"), "## Open loops\n\n- [x] Solo\n- [ ] Pending\n");
    const all = await http("POST", "/delegation/tasks-board/sweep-done", {});
    assert.deepEqual(all.json, { moved: 1, projects: ["s2"] });
    assert.equal(read("sweep/s2.md"), `## Open loops\n\n- [ ] Pending\n\n## Done loops\n\n- [x] Solo${stamp()}\n`);
    assert.equal(read("sweep/s3.md"), "## Open loops\n\n- [ ] Nothing\n");
    const again = await http("POST", "/delegation/tasks-board/sweep-done", {});
    assert.deepEqual(again.json, { moved: 0, projects: [] });
    assert.equal((await http("POST", "/delegation/tasks-board/sweep-done", { projectId: "ghost" })).status, 404);
  });

  it("rejects a sweep while the done section is not configured or the feature is off", async () => {
    reset("sweepoff", { "s1.md": "## Open loops\n\n- [x] First\n" });
    await configure("sweepoff");
    const off = await http("POST", "/delegation/tasks-board/sweep-done", {});
    assert.equal(off.status, 400);
    assert.match(String(off.json.error), /done section/);
    await configure("sweepoff", { doneSection: "Done loops" });
    assert.equal((await http("PUT", "/delegation/settings", { features: { tasks: false } })).status, 200);
    assert.equal((await http("POST", "/delegation/tasks-board/sweep-done", {})).status, 400);
    await configure("sweepoff", { doneSection: "Done loops" });
    assert.equal((await http("POST", "/delegation/tasks-board/sweep-done", {})).status, 200);
  });

  it("preserves CRLF and the BOM through a move and rejects a stale raw with 409", async () => {
    reset("crlf", { "acme.md": `\uFEFF${OPEN_DOC("\r\n")}` });
    await configure("crlf", { doneSection: "Done loops" });
    const beta = await find("acme", "Beta");
    const stale = await patch({ ...beta, raw: "- [ ] Beta edited" }, { status: "done" });
    assert.equal(stale.status, 409);
    assert.equal((stale.json.current as WireTask | null)?.title, "Beta");
    assert.equal(read("crlf/acme.md"), `\uFEFF${OPEN_DOC("\r\n")}`);
    const res = await patch(beta, { status: "done" });
    assert.equal(res.json.moved, true);
    const content = read("crlf/acme.md");
    assert.ok(content.startsWith("\uFEFF# Acme\r\n"));
    assert.equal(content.replace(/\r\n/g, "").includes("\n"), false);
    assert.ok(content.includes(`\r\n## Done loops\r\n\r\n- [x] Beta${stamp()}\r\n\r\n## Notes\r\n`));
    assert.equal(readdirSync(join(vault, "crlf")).filter((name) => name.endsWith(".tmp")).length, 0);
    const sweepBack = await patch(await find("acme", "Beta"), { status: "todo" });
    assert.equal(sweepBack.json.moved, true);
    const back = read("crlf/acme.md");
    assert.equal(back.replace(/\r\n/g, "").includes("\n"), false);
    assert.ok(back.includes("- [ ] Beta\r\n"));
  });

  it("keeps a file without a trailing newline free of one after a move", async () => {
    reset("nonl", { "acme.md": "## Open loops\n\n- [ ] One\n- [x] Two" });
    await configure("nonl", { doneSection: "Done loops" });
    const res = await http("POST", "/delegation/tasks-board/sweep-done", {});
    assert.deepEqual(res.json, { moved: 1, projects: ["acme"] });
    assert.equal(read("nonl/acme.md"), `## Open loops\n\n- [ ] One\n\n## Done loops\n\n- [x] Two${stamp()}`);
  });

  it("keeps a done stamp the line already ends with instead of stamping twice", async () => {
    reset("restamp", { "acme.md": "## Open loops\n\n- [x] Shipped ✅ 2026-10-01\n- [ ] Rest\n- [ ] Later\n" });
    await configure("restamp", { doneSection: "Done loops" });
    const swept = await http("POST", "/delegation/tasks-board/sweep-done", { projectId: "acme" });
    assert.deepEqual(swept.json, { moved: 1, projects: ["acme"] });
    assert.equal(read("restamp/acme.md"), "## Open loops\n\n- [ ] Rest\n- [ ] Later\n\n## Done loops\n\n- [x] Shipped ✅ 2026-10-01\n");
    const done = (await listTasks()).find((task) => task.title === "Shipped");
    assert.equal(done?.section, "done");
    assert.equal(done?.doneAt, "2026-10-01");
    reset("restamp", { "acme.md": "## Open loops\n\n- [ ] Done by hand ✅ 2026-10-02\n" });
    const hand = await find("acme", "Done by hand ✅ 2026-10-02");
    const moved = await patch(hand, { status: "done" });
    assert.equal(moved.json.moved, true);
    assert.equal(read("restamp/acme.md"), "## Open loops\n\n## Done loops\n\n- [x] Done by hand ✅ 2026-10-02\n");
    assert.equal((moved.json.task as WireTask).doneAt, "2026-10-02");
    reset("restamp", { "acme.md": "## Open loops\n\n- [x] Price $5 (x) [done:2026-02-02]\n- [x] Plain\n" });
    await configure("restamp", { doneSection: "Done loops", doneStamp: " [done:{{date}}]" });
    assert.equal((await http("POST", "/delegation/tasks-board/sweep-done", {})).json.moved, 2);
    assert.equal(read("restamp/acme.md"), `## Open loops\n\n## Done loops\n\n- [x] Price $5 (x) [done:2026-02-02]\n- [x] Plain [done:${today()}]\n`);
  });

  it("treats a done heading nested in the open section as the done section", async () => {
    const doc = "## Open loops\n\n- [ ] Only\n- [x] Finished\n\n### Done loops\n\n- [x] Nested done ✅ 2026-01-01\n";
    reset("nested", { "acme.md": doc });
    await configure("nested", { doneSection: "Done loops" });
    const listed = await listTasks();
    const nested = listed.find((task) => task.title === "Nested done");
    assert.equal(nested?.section, "done");
    assert.equal(nested?.doneAt, "2026-01-01");
    assert.equal(listed.find((task) => task.title === "Only")?.section, "open");
    const swept = await http("POST", "/delegation/tasks-board/sweep-done", { projectId: "acme" });
    assert.deepEqual(swept.json, { moved: 1, projects: ["acme"] });
    assert.equal(read("nested/acme.md"), `## Open loops\n\n- [ ] Only\n\n### Done loops\n\n- [x] Finished${stamp()}\n- [x] Nested done ✅ 2026-01-01\n`);
    const untouched = "## Open loops\n\n- [ ] Only\n\n### Done loops\n\n- [x] Nested done\n";
    reset("nested", { "acme.md": untouched });
    assert.deepEqual((await http("POST", "/delegation/tasks-board/sweep-done", {})).json, { moved: 0, projects: [] });
    assert.equal(read("nested/acme.md"), untouched);
  });

  it("keeps the original spacing when taking a block out would leave a stray blank line", async () => {
    reset("spacing", { "acme.md": "## Open loops\n\n- [ ] First\n- [x] Parent\n  note line\n\n  - [x] Child\n\n- [ ] After\n\n## Notes\n" });
    await configure("spacing", { doneSection: "Done loops" });
    assert.equal((await http("POST", "/delegation/tasks-board/sweep-done", {})).json.moved, 1);
    assert.equal(
      read("spacing/acme.md"),
      `## Open loops\n\n- [ ] First\n- [ ] After\n\n## Done loops\n\n- [x] Parent${stamp()}\n  note line\n\n  - [x] Child\n\n## Notes\n`,
    );
    reset("spacing", { "acme.md": "## Open loops\n\n- [ ] First\n\n- [x] Parent\n\n- [ ] After\n" });
    assert.equal((await http("POST", "/delegation/tasks-board/sweep-done", {})).json.moved, 1);
    assert.equal(read("spacing/acme.md"), `## Open loops\n\n- [ ] First\n\n- [ ] After\n\n## Done loops\n\n- [x] Parent${stamp()}\n`);
    reset("spacing", { "acme.md": "## Open loops\n\n- [ ] First\n- [x] Parent\n- [ ] After\n" });
    assert.equal((await http("POST", "/delegation/tasks-board/sweep-done", {})).json.moved, 1);
    assert.equal(read("spacing/acme.md"), `## Open loops\n\n- [ ] First\n- [ ] After\n\n## Done loops\n\n- [x] Parent${stamp()}\n`);
  });

  it("replaces a lone placeholder line in the done section when a block moves in", async () => {
    const doc = "## Open loops\n\n- [ ] One\n- [x] Two\n\n## Done loops\n\n-\n\n## Decisoes\n\nnote\n";
    const moved = `## Open loops\n\n- [ ] One\n\n## Done loops\n\n- [x] Two${stamp()}\n\n## Decisoes\n\nnote\n`;
    reset("ph", { "acme.md": doc });
    await configure("ph", { doneSection: "Done loops" });
    const swept = await http("POST", "/delegation/tasks-board/sweep-done", { projectId: "acme" });
    assert.deepEqual(swept.json, { moved: 1, projects: ["acme"] });
    assert.equal(read("ph/acme.md"), moved);
    reset("ph", { "acme.md": doc.replace("- [x] Two", "- [ ] Two") });
    const patched = await patch(await find("acme", "Two"), { status: "done" });
    assert.equal(patched.json.moved, true);
    assert.equal(read("ph/acme.md"), moved);
    assert.equal((patched.json.task as WireTask).section, "done");
    reset("ph", { "acme.md": doc.replace("\n-\n", "\n- [ ]\n") });
    assert.equal((await http("POST", "/delegation/tasks-board/sweep-done", { projectId: "acme" })).json.moved, 1);
    assert.equal(read("ph/acme.md"), moved);
  });

  it("leaves a stray placeholder alone when the done section already has real items", async () => {
    const doc = `## Open loops\n\n- [x] Two\n\n## Done loops\n\n- [x] Old${stamp("2026-01-01")}\n-\n`;
    reset("ph", { "acme.md": doc });
    await configure("ph", { doneSection: "Done loops" });
    assert.equal((await http("POST", "/delegation/tasks-board/sweep-done", { projectId: "acme" })).json.moved, 1);
    assert.equal(read("ph/acme.md"), `## Open loops\n\n## Done loops\n\n- [x] Two${stamp()}\n- [x] Old${stamp("2026-01-01")}\n-\n`);
  });

  it("writes a placeholder back into a done section that a reopened block leaves empty", async () => {
    reset("ph", { "acme.md": `## Open loops\n\n- [ ] One\n\n## Done loops\n\n- [x] Shipped${stamp("2026-01-01")}\n\n## Decisoes\n\nnote\n` });
    await configure("ph", { doneSection: "Done loops" });
    const res = await patch(await find("acme", "Shipped"), { status: "todo" });
    assert.equal(res.json.moved, true);
    assert.equal((res.json.task as WireTask).raw, "- [ ] Shipped");
    assert.equal(read("ph/acme.md"), "## Open loops\n\n- [ ] One\n- [ ] Shipped\n\n## Done loops\n\n-\n\n## Decisoes\n\nnote\n");
    assert.equal((res.json.task as WireTask).line, 3);
    const again = await patch(await find("acme", "Shipped"), { status: "done" });
    assert.equal(again.json.moved, true);
    assert.equal(read("ph/acme.md"), `## Open loops\n\n- [ ] One\n\n## Done loops\n\n- [x] Shipped${stamp()}\n\n## Decisoes\n\nnote\n`);
  });

  it("replaces a lone placeholder in the open section when a task is created", async () => {
    reset("ph", { "c1.md": "## Open loops\n\n-\n\n## Notes\n" });
    await configure("ph");
    const res = await create({ projectId: "c1", title: "First" });
    assert.equal(res.status, 201);
    assert.equal(read("ph/c1.md"), "## Open loops\n\n- [ ] First\n\n## Notes\n");
    assert.equal((res.json.task as WireTask).line, 2);
    reset("ph", { "c1.md": "## Open loops\n\n- [ ] Real\n-\n" });
    assert.equal((await create({ projectId: "c1", title: "Second" })).status, 201);
    assert.equal(read("ph/c1.md"), "## Open loops\n\n- [ ] Real\n-\n- [ ] Second\n");
  });

  it("creates a done task straight into the done section with the stamp", async () => {
    reset("ph", { "c1.md": "## Open loops\n\n- [ ] Open one\n\n## Done loops\n\n-\n\n## Notes\n\nkeep\n" });
    await configure("ph", { doneSection: "Done loops" });
    const res = await create({ projectId: "c1", title: "Already finished", status: "done" });
    assert.equal(res.status, 201);
    const task = res.json.task as WireTask;
    assert.equal(task.section, "done");
    assert.equal(task.doneAt, today());
    assert.equal(task.title, "Already finished");
    assert.equal(task.raw, `- [x] Already finished${stamp()}`);
    assert.equal(read("ph/c1.md"), `## Open loops\n\n- [ ] Open one\n\n## Done loops\n\n- [x] Already finished${stamp()}\n\n## Notes\n\nkeep\n`);
    const second = await create({ projectId: "c1", title: "Also finished", status: "done" });
    assert.equal(
      read("ph/c1.md"),
      `## Open loops\n\n- [ ] Open one\n\n## Done loops\n\n- [x] Also finished${stamp()}\n- [x] Already finished${stamp()}\n\n## Notes\n\nkeep\n`,
    );
    assert.equal((second.json.task as WireTask).section, "done");
    reset("ph", { "c1.md": "## Open loops\n\n- [ ] Open one\n" });
    const created = await create({ projectId: "c1", title: "Fresh", status: "done" });
    assert.equal(read("ph/c1.md"), `## Open loops\n\n- [ ] Open one\n\n## Done loops\n\n- [x] Fresh${stamp()}\n`);
    assert.equal((created.json.task as WireTask).doneAt, today());
  });

  it("keeps a done task created with a parent or with the done section off in the open section", async () => {
    reset("ph", { "c1.md": "## Open loops\n\n- [ ] Parent\n\n## Done loops\n\n-\n" });
    await configure("ph", { doneSection: "Done loops" });
    const parent = await find("c1", "Parent");
    const child = await create({ projectId: "c1", title: "Kid", status: "done", parentLine: parent.line, parentRaw: parent.raw });
    assert.equal(child.status, 201);
    assert.equal((child.json.task as WireTask).raw, "  - [x] Kid");
    assert.equal((child.json.task as WireTask).section, "open");
    assert.equal(read("ph/c1.md"), "## Open loops\n\n- [ ] Parent\n  - [x] Kid\n\n## Done loops\n\n-\n");
    reset("ph", { "c1.md": "## Open loops\n\n- [ ] Parent\n" });
    await configure("ph");
    const off = await create({ projectId: "c1", title: "Plain", status: "done" });
    assert.equal((off.json.task as WireTask).raw, "- [x] Plain");
    assert.equal(read("ph/c1.md"), "## Open loops\n\n- [ ] Parent\n- [x] Plain\n");
  });

  it("rejects a reason on a PATCH whose target status does not carry one", async () => {
    const doc = "## Open loops\n\n- [ ] BLOCK - Waiting - vendor\n";
    reset("reasonmove", { "acme.md": doc });
    await configure("reasonmove");
    const waiting = await find("acme", "Waiting");
    for (const status of ["todo", "doing", "done"]) {
      const res = await patch(waiting, { status, reason: "x" });
      assert.equal(res.status, 400, status);
      assert.match(String(res.json.error), /reason only applies/);
    }
    assert.equal(read("reasonmove/acme.md"), doc);
    const cleared = await patch(waiting, { status: "todo", reason: null });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.json.task as WireTask).raw, "- [ ] Waiting");
    const hold = await patch(await find("acme", "Waiting"), { status: "hold", reason: "legal" });
    assert.equal(hold.status, 200);
    assert.equal((hold.json.task as WireTask).raw, "- [ ] HOLD - Waiting - legal");
  });

  describe("create", () => {
    const C1 = "# C1\n\n## Open loops\n\n- [ ] Existing\n  - [ ] Child a\n    - [ ] Grand\n- [ ] Second\n\n## Notes\n\ntext\n";
    const post = (body: Record<string, unknown>) => create({ projectId: "c1", ...body });

    it("appends a top-level task after the last line of the open section", async () => {
      reset("create", { "c1.md": C1 });
      await configure("create");
      const res = await post({ title: "Brand new" });
      assert.equal(res.status, 201);
      const task = res.json.task as WireTask;
      assert.equal(task.raw, "- [ ] Brand new");
      assert.equal(task.status, "todo");
      assert.equal(task.depth, 0);
      assert.equal(task.line, 8);
      assert.equal(read("create/c1.md"), C1.replace("- [ ] Second\n", "- [ ] Second\n- [ ] Brand new\n"));
      assert.equal((await find("c1", "Brand new")).id, task.id);
    });

    it("writes the checkbox, prefix and reason for each status", async () => {
      reset("create", { "c1.md": "## Open loops\n\n- [ ] Existing\n" });
      await configure("create");
      const lines: [string, Record<string, unknown>, string][] = [
        ["doing", { title: "A", status: "doing" }, "- [-] A"],
        ["done", { title: "B", status: "done" }, "- [x] B"],
        ["blocked", { title: "C", status: "blocked", reason: "vendor" }, "- [ ] BLOCK - C - vendor"],
        ["hold", { title: "D", status: "hold" }, "- [ ] HOLD - D"],
        ["archived", { title: "E", status: "archived", reason: "dropped" }, "- [ ] ARCHIVED - E - dropped"],
        ["todo", { title: "  F  ", status: "todo" }, "- [ ] F"],
      ];
      for (const [label, body, raw] of lines) {
        const res = await post(body);
        assert.equal(res.status, 201, label);
        assert.equal((res.json.task as WireTask).raw, raw, label);
      }
      assert.equal(read("create/c1.md"), "## Open loops\n\n- [ ] Existing\n- [-] A\n- [x] B\n- [ ] BLOCK - C - vendor\n- [ ] HOLD - D\n- [ ] ARCHIVED - E - dropped\n- [ ] F\n");
      const blocked = await find("c1", "C");
      assert.equal(blocked.reason, "vendor");
      assert.equal(blocked.status, "blocked");
    });

    it("appends as the last child of a parent using the indent the children already use", async () => {
      reset("create", { "c1.md": C1 });
      await configure("create");
      const existing = await find("c1", "Existing");
      const first = await post({ title: "New child", parentLine: existing.line, parentRaw: existing.raw });
      assert.equal(first.status, 201);
      const child = first.json.task as WireTask;
      assert.equal(child.raw, "  - [ ] New child");
      assert.equal(child.depth, 1);
      assert.equal(child.line, 7);
      assert.equal(read("create/c1.md"), C1.replace("    - [ ] Grand\n", "    - [ ] Grand\n  - [ ] New child\n"));
      const listed = await find("c1", "Existing");
      assert.deepEqual(listed.subtasks.map((sub) => sub.title), ["Child a", "New child"]);
      const childA = await find("c1", "Child a");
      const nested = await post({ title: "Grand two", status: "doing", parentLine: childA.line, parentRaw: childA.raw });
      assert.equal((nested.json.task as WireTask).raw, "    - [-] Grand two");
      const second = await find("c1", "Second");
      const kid = await post({ title: "Kid", parentLine: second.line, parentRaw: second.raw });
      assert.equal((kid.json.task as WireTask).raw, "  - [ ] Kid");
      assert.ok(read("create/c1.md").includes("- [ ] Second\n  - [ ] Kid\n\n## Notes"));
    });

    it("copies a four-space child indent", async () => {
      reset("create", { "c1.md": "## Open loops\n\n- [ ] Wide\n    - [ ] Kid one\n- [ ] Odd parent\n" });
      await configure("create");
      const wide = await find("c1", "Wide");
      const res = await post({ title: "Kid two", parentLine: wide.line, parentRaw: wide.raw });
      assert.equal((res.json.task as WireTask).raw, "    - [ ] Kid two");
      assert.equal((await find("c1", "Kid two")).depth, 2);
    });

    it("creates the open section at the end of the document or before the done section when it is missing", async () => {
      reset("create", { "c1.md": "# No section\n\nsome text\n" });
      await configure("create");
      assert.equal((await post({ title: "first" })).status, 201);
      assert.equal(read("create/c1.md"), "# No section\n\nsome text\n\n## Open loops\n\n- [ ] first\n");
      reset("create", { "c1.md": `# D\n\n## Done loops\n\n- [x] old${stamp("2026-01-01")}\n` });
      await configure("create", { doneSection: "Done loops" });
      assert.equal((await post({ title: "first" })).status, 201);
      assert.equal(read("create/c1.md"), `# D\n\n## Open loops\n\n- [ ] first\n\n## Done loops\n\n- [x] old${stamp("2026-01-01")}\n`);
      reset("create", { "c1.md": "## Open loops\n\n## Next\n" });
      await configure("create");
      assert.equal((await post({ title: "x" })).status, 201);
      assert.equal(read("create/c1.md"), "## Open loops\n\n- [ ] x\n\n## Next\n");
      reset("create", { "c1.md": "---\ntitle: X\n---\n\n- [ ] a\n\nfooter\n" });
      await configure("create", { section: "" });
      assert.equal((await post({ title: "b" })).status, 201);
      assert.equal(read("create/c1.md"), "---\ntitle: X\n---\n\n- [ ] a\n\nfooter\n- [ ] b\n");
    });

    it("preserves CRLF and the BOM", async () => {
      reset("create", { "c1.md": `\uFEFF${C1.replace(/\n/g, "\r\n")}` });
      await configure("create");
      const existing = await find("c1", "Existing");
      assert.equal((await post({ title: "Top" })).status, 201);
      const kid = await post({ title: "Kid", parentLine: existing.line, parentRaw: existing.raw });
      assert.equal(kid.status, 201);
      const content = read("create/c1.md");
      assert.ok(content.startsWith("\uFEFF# C1\r\n"));
      assert.equal(content.replace(/\r\n/g, "").includes("\n"), false);
      assert.ok(content.includes("- [ ] Second\r\n- [ ] Top\r\n\r\n## Notes\r\n"));
      assert.ok(content.includes("    - [ ] Grand\r\n  - [ ] Kid\r\n- [ ] Second\r\n"));
    });

    it("indents a new subtask like the first child task, not like a note", async () => {
      reset("create", { "c1.md": "## Open loops\n\n- [ ] P\n      deep note first\n  - [ ] existing child\n" });
      await configure("create");
      const parent = await find("c1", "P");
      const res = await post({ title: "Kid", parentLine: parent.line, parentRaw: parent.raw });
      assert.equal(res.status, 201);
      assert.equal((res.json.task as WireTask).raw, "  - [ ] Kid");
      assert.equal((res.json.task as WireTask).depth, 1);
      assert.equal(read("create/c1.md"), "## Open loops\n\n- [ ] P\n      deep note first\n  - [ ] existing child\n  - [ ] Kid\n");
    });

    it("falls back to the indent unit of the document when the parent has no child task", async () => {
      reset("create", { "c1.md": "## Open loops\n\n- [ ] Wide\n    - [ ] Kid one\n- [ ] Lone\n      a note\n- [ ] Bare\n" });
      await configure("create");
      const lone = await find("c1", "Lone");
      const first = await post({ title: "Kid two", parentLine: lone.line, parentRaw: lone.raw });
      assert.equal((first.json.task as WireTask).raw, "    - [ ] Kid two");
      const bare = await find("c1", "Bare");
      const second = await post({ title: "Kid three", parentLine: bare.line, parentRaw: bare.raw });
      assert.equal((second.json.task as WireTask).raw, "    - [ ] Kid three");
      reset("create", { "c1.md": "## Open loops\n\n- [ ] A\n\t- [ ] tab kid\n- [ ] B\n" });
      const b = await find("c1", "B");
      const tab = await post({ title: "Tab two", parentLine: b.line, parentRaw: b.raw });
      assert.equal((tab.json.task as WireTask).raw, "\t- [ ] Tab two");
      reset("create", { "c1.md": "## Open loops\n\n- [ ] Only\n" });
      const only = await find("c1", "Only");
      const plain = await post({ title: "Kid", parentLine: only.line, parentRaw: only.raw });
      assert.equal((plain.json.task as WireTask).raw, "  - [ ] Kid");
    });

    it("validates the body and answers 404 and 409 where they apply", async () => {
      reset("create", { "c1.md": C1 });
      await configure("create");
      const existing = await find("c1", "Existing");
      assert.equal((await post({ title: "" })).status, 400);
      assert.equal((await post({ title: "   " })).status, 400);
      assert.equal((await post({ title: "a\nb" })).status, 400);
      assert.equal((await post({ title: 5 })).status, 400);
      assert.equal((await post({})).status, 400);
      assert.equal((await post({ title: "x", status: "weird" })).status, 400);
      assert.equal((await post({ title: "x", reason: "why" })).status, 400);
      assert.equal((await post({ title: "x", status: "hold", reason: "a\nb" })).status, 400);
      assert.equal((await post({ title: "x", status: "hold", reason: "a - b" })).status, 400);
      assert.equal((await post({ title: "x", parentLine: existing.line })).status, 400);
      assert.equal((await post({ title: "x", parentLine: -1, parentRaw: "x" })).status, 400);
      assert.equal((await post({ title: "x", parentLine: 2, parentRaw: "## Open loops" })).status, 400);
      assert.equal((await create({ title: "x" })).status, 400);
      assert.equal((await create({ projectId: "ghost", title: "x" })).status, 404);
      const stale = await post({ title: "x", parentLine: existing.line, parentRaw: "- [ ] Existing edited" });
      assert.equal(stale.status, 409);
      assert.equal(stale.json.error, "changed on disk");
      assert.equal((stale.json.current as WireTask).title, "Existing");
      const gone = await post({ title: "x", parentLine: 99, parentRaw: "- [ ] nope" });
      assert.equal(gone.status, 409);
      assert.equal(gone.json.current, null);
      assert.equal(read("create/c1.md"), C1);
      assert.equal((await http("PUT", "/delegation/settings", { features: { tasks: false } })).status, 200);
      assert.equal((await post({ title: "x" })).status, 400);
      await configure("create");
    });
  });
});

describe("priority tag parsing", () => {
  const parse = (markdown: string, tasks: Partial<DelegationSettings["tasks"]> = {}) => board.parseBoardTasks(markdown, "p", { ...defaults(), ...tasks });
  const first = (markdown: string, tasks: Partial<DelegationSettings["tasks"]> = {}) => parse(`## Open loops\n\n${markdown}\n`, tasks)[0] as NonNullable<ReturnType<typeof parse>[number]>;

  it("reads a token at the end of the line and strips it from the title", () => {
    const task = first("- [ ] Fix login flow #p0");
    assert.equal(task.priority, 0);
    assert.equal(task.title, "Fix login flow");
    assert.equal(task.reason, null);
    assert.equal(task.raw, "- [ ] Fix login flow #p0");
  });

  it("defaults to null when there is no token", () => {
    assert.equal(first("- [ ] Fix login flow").priority, null);
    assert.equal(first("- [ ] Fix login flow").title, "Fix login flow");
  });

  it("reads a token after the reason without leaking it into the reason", () => {
    const task = first("- [ ] HOLD - Payment mirror - waiting stripe account #p1");
    assert.equal(task.status, "hold");
    assert.equal(task.title, "Payment mirror");
    assert.equal(task.reason, "waiting stripe account");
    assert.equal(task.priority, 1);
  });

  it("reads a token between the prefix and the title and in the middle of the text", () => {
    const lead = first("- [ ] HOLD - #p2 Payment mirror");
    assert.equal(lead.title, "Payment mirror");
    assert.equal(lead.priority, 2);
    const start = first("- [ ] #p3 Start here");
    assert.equal(start.title, "Start here");
    assert.equal(start.priority, 3);
    const middle = first("- [ ] Fix #p1 login flow");
    assert.equal(middle.title, "Fix login flow");
    assert.equal(middle.priority, 1);
  });

  it("reads the token before a done stamp and keeps the stamp date", () => {
    const tasks = parse("## Open loops\n\n- [ ] Pending\n\n## Done loops\n\n- [x] Shipped feature #p2 ✅ 2026-03-01\n", { doneSection: "Done loops" });
    const done = tasks.find((task) => task.section === "done") as NonNullable<(typeof tasks)[number]>;
    assert.equal(done.title, "Shipped feature");
    assert.equal(done.priority, 2);
    assert.equal(done.doneAt, "2026-03-01");
  });

  it("is case-insensitive", () => {
    const task = first("- [ ] Upper case #P1");
    assert.equal(task.priority, 1);
    assert.equal(task.title, "Upper case");
  });

  it("with several tokens the first wins and every token is stripped", () => {
    const task = first("- [ ] Many #p2 tokens #p0 here #P3");
    assert.equal(task.priority, 2);
    assert.equal(task.title, "Many tokens here");
  });

  it("does not match a token glued to a word, followed by more characters, or with another tag", () => {
    for (const text of ["abc#p1", "see #p10 later", "ends #p1.", "tag #px", "hash#p2 tail", "mail #pp1", "bare #p"]) {
      const task = first(`- [ ] ${text}`);
      assert.equal(task.priority, null, text);
      assert.equal(task.title, text, text);
    }
  });

  it("honours a custom tag and ignores the default one then", () => {
    const custom = first("- [ ] Ship it #prio2", { priorityTag: "prio" });
    assert.equal(custom.priority, 2);
    assert.equal(custom.title, "Ship it");
    const other = first("- [ ] Ship it #p2", { priorityTag: "prio" });
    assert.equal(other.priority, null);
    assert.equal(other.title, "Ship it #p2");
    const dashed = first("- [ ] Ship it #my-tag_1 #my-tag_7", { priorityTag: "my-tag_" });
    assert.equal(dashed.priority, 1);
    assert.equal(dashed.title, "Ship it");
    const escaped = first("- [ ] Ship it #a.b4", { priorityTag: "a.b" });
    assert.equal(escaped.priority, 4);
  });

  it("reads priorities of subtasks and leaves note text untouched", () => {
    const parent = first("- [ ] Parent #p1\n  - [ ] Child #p0\n  - note keeps #p2 verbatim");
    assert.equal(parent.priority, 1);
    assert.equal((parent.subtasks[0] as NonNullable<(typeof parent.subtasks)[number]>).priority, 0);
    assert.deepEqual(parent.notes, ["note keeps #p2 verbatim"]);
  });

  it("exposes the priority in the delegate prompt vars", () => {
    const project = { id: "p", name: "p", title: "Project P", parent: null, depth: 0, path: "/v/p.md", workspace: null, workspaceSource: null };
    const withPriority = board.taskPromptVars(project, first("- [ ] Urgent thing #p1"));
    assert.equal(withPriority.priority, "P1");
    assert.equal(board.renderTaskDelegatePrompt("pri={{priority}} task={{task}}", withPriority), "pri=P1 task=Urgent thing");
    const without = board.taskPromptVars(project, first("- [ ] Calm thing"));
    assert.equal(without.priority, "none");
    assert.equal(board.renderTaskDelegatePrompt("pri={{priority}}", without), "pri=none");
    const zero = board.taskPromptVars(project, first("- [ ] Zero thing #p0"));
    assert.equal(zero.priority, "P0");
  });
});

describe("priority tag rewriting", () => {
  const rewrite = (raw: string, change: Parameters<Board["rewriteTaskLine"]>[2], mode: Parameters<Board["rewriteTaskLine"]>[3] = "none", tasks: Partial<DelegationSettings["tasks"]> = {}) =>
    board.rewriteTaskLine(raw, { ...defaults(), ...tasks }, change, mode);

  it("sets, changes and clears the token at the end of the line", () => {
    assert.equal(rewrite("- [ ] Task", { priority: 1 }), "- [ ] Task #p1");
    assert.equal(rewrite("- [ ] Task #p1", { priority: 0 }), "- [ ] Task #p0");
    assert.equal(rewrite("- [ ] Task #p1", { priority: null }), "- [ ] Task");
    assert.equal(rewrite("- [ ] Task", { priority: null }), "- [ ] Task");
    assert.equal(rewrite("- [ ] Task", { priority: 9 }), "- [ ] Task #p9");
  });

  it("removes every existing token and moves the new one to the end", () => {
    assert.equal(rewrite("- [ ] Fix #p2 the thing #p0", { priority: 3 }), "- [ ] Fix the thing #p3");
    assert.equal(rewrite("- [ ] Fix #p2 the thing #p0", { priority: null }), "- [ ] Fix the thing");
    assert.equal(rewrite("- [ ] #p2 Lead token", { priority: 1 }), "- [ ] Lead token #p1");
  });

  it("keeps the prefix, the reason and the checkbox when only the priority changes", () => {
    assert.equal(rewrite("- [ ] HOLD - Legal review - waiting counsel #p2", { priority: 0 }), "- [ ] HOLD - Legal review - waiting counsel #p0");
    assert.equal(rewrite("- [ ] HOLD - Legal review - waiting counsel #p2", { priority: null }), "- [ ] HOLD - Legal review - waiting counsel");
    assert.equal(rewrite("- [-] Hire designer", { priority: 1 }), "- [-] Hire designer #p1");
    assert.equal(rewrite("  - [ ] BLOCK - Sub task", { priority: 2 }), "  - [ ] BLOCK - Sub task #p2");
  });

  it("puts the token before the done stamp and keeps the stamp", () => {
    assert.equal(rewrite("- [x] Done thing ✅ 2026-03-01", { priority: 3 }, "keep"), "- [x] Done thing #p3 ✅ 2026-03-01");
    assert.equal(rewrite("- [x] Done thing #p1 ✅ 2026-03-01", { priority: 0 }, "keep"), "- [x] Done thing #p0 ✅ 2026-03-01");
    assert.equal(rewrite("- [x] Done thing #p1 ✅ 2026-03-01", { priority: null }, "keep"), "- [x] Done thing ✅ 2026-03-01");
    assert.equal(rewrite("- [x] Done thing #p1 ✅ 2026-03-01", { title: "Renamed" }, "keep"), "- [x] Renamed #p1 ✅ 2026-03-01");
  });

  it("keeps the current token on title, reason and status edits", () => {
    assert.equal(rewrite("- [ ] Old title #p1", { title: "New title" }), "- [ ] New title #p1");
    assert.equal(rewrite("- [ ] Fix #p2 login", { title: "Renamed" }), "- [ ] Renamed #p2");
    assert.equal(rewrite("- [ ] HOLD - Legal - old reason #p1", { reason: "new reason" }), "- [ ] HOLD - Legal - new reason #p1");
    assert.equal(rewrite("- [ ] HOLD - Legal - old reason #p1", { reason: null }), "- [ ] HOLD - Legal #p1");
    assert.equal(rewrite("- [ ] Task #p1", { status: "blocked" }), "- [ ] BLOCK - Task #p1");
    assert.equal(rewrite("- [ ] BLOCK - Task #p1", { status: "todo" }), "- [ ] Task #p1");
    assert.equal(rewrite("- [ ] Task #p1", { status: "done" }), "- [x] Task #p1");
    assert.equal(rewrite("- [ ] Task #p1", { status: "doing" }), "- [-] Task #p1");
    assert.equal(rewrite("- [ ] Task #P1", { title: "Other" }), "- [ ] Other #P1");
  });

  it("applies the priority together with other changes", () => {
    assert.equal(rewrite("- [ ] Task #p1", { status: "hold", reason: "vendor", priority: 2 }), "- [ ] HOLD - Task - vendor #p2");
    assert.equal(rewrite("- [ ] Task #p1", { title: "Better", priority: null }), "- [ ] Better");
  });

  it("writes the configured tag and recognises the configured tag only", () => {
    assert.equal(rewrite("- [ ] Task", { priority: 1 }, "none", { priorityTag: "prio" }), "- [ ] Task #prio1");
    assert.equal(rewrite("- [ ] Task #prio1", { priority: 2 }, "none", { priorityTag: "prio" }), "- [ ] Task #prio2");
    assert.equal(rewrite("- [ ] Task #p1", { priority: 2 }, "none", { priorityTag: "prio" }), "- [ ] Task #p1 #prio2");
  });

  it("rejects an invalid priority and accepts a priority-only change", () => {
    for (const value of [10, -1, 1.5, "1", true, Number.NaN]) {
      assert.throws(() => rewrite("- [ ] Task", { priority: value as unknown as number }), /priority/, String(value));
    }
    assert.throws(() => rewrite("- [ ] Task", {}), /status, title, reason or priority/);
    assert.doesNotThrow(() => rewrite("- [ ] Task", { priority: null }));
  });
});

describe("priority tag hardening", () => {
  const rewrite = (raw: string, change: Parameters<Board["rewriteTaskLine"]>[2], mode: Parameters<Board["rewriteTaskLine"]>[3] = "none", tasks: Partial<DelegationSettings["tasks"]> = {}) =>
    board.rewriteTaskLine(raw, { ...defaults(), ...tasks }, change, mode);
  const parseFirst = (markdown: string) => board.parseBoardTasks(`## Open loops\n\n${markdown}\n`, "p", defaults())[0] as NonNullable<ReturnType<Board["parseBoardTasks"]>[number]>;
  const project = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(dataDir, "hardening-"));
    writeTree(root, files);
    return root;
  };

  it("puts the priority token before an existing done stamp in the open section", () => {
    assert.equal(rewrite("- [x] Obs #p1 ✅ 2026-10-20", { priority: 2 }), "- [x] Obs #p2 ✅ 2026-10-20");
    assert.equal(rewrite("- [x] Obs ✅ 2026-10-20", { priority: 2 }), "- [x] Obs #p2 ✅ 2026-10-20");
    assert.equal(rewrite("- [x] Obs #p1 ✅ 2026-10-20", { priority: null }), "- [x] Obs ✅ 2026-10-20");
    assert.equal(rewrite("- [x] Obs #p1 ✅ 2026-10-20", { title: "Renamed" }), "- [x] Renamed #p1 ✅ 2026-10-20");
    assert.equal(rewrite("- [x] Obs #p1 ✅ 2026-10-20", { status: "todo" }), "- [ ] Obs #p1 ✅ 2026-10-20");
    assert.equal(rewrite("- [x] Obs #p1 ✅ 2026-10-20", { priority: 2 }, "keep"), "- [x] Obs #p2 ✅ 2026-10-20");
    assert.equal(rewrite("- [x] Obs #p1 ✅ 2026-10-20", { priority: 2 }, "drop"), "- [x] Obs #p2");
  });

  it("recognises the configured stamp template and the default shape", () => {
    const custom = { doneStamp: " (done {{date}})" };
    assert.equal(rewrite("- [x] Obs #p1 (done 2026-10-20)", { priority: 2 }, "none", custom), "- [x] Obs #p2 (done 2026-10-20)");
    assert.equal(rewrite("- [x] Obs #p1 ✅ 2026-10-20", { priority: 2 }, "none", custom), "- [x] Obs #p2 ✅ 2026-10-20");
    assert.equal(rewrite("- [x] Obs ✅ 2026-10-20", { priority: 2 }, "none", { doneStamp: "" }), "- [x] Obs #p2 ✅ 2026-10-20");
  });

  it("does not double-stamp after a priority write followed by a sweep", () => {
    const root = project({ "proj.md": "## Open loops\n\n- [x] Obs #p1 ✅ 2026-10-20\n- [ ] Pending\n\n## Done\n\n- [x] Older ✅ 2026-10-01\n" });
    const settings = settingsFor(root, { section: "Open loops", doneSection: "Done", doneStamp: " ✅ {{date}}" });
    const written = board.writeBoardTask(settings, { projectId: "proj", line: 2, raw: "- [x] Obs #p1 ✅ 2026-10-20", priority: 2 });
    assert.equal(written.task.priority, 2);
    assert.equal(readFileSync(join(root, "proj.md"), "utf8").includes("- [x] Obs #p2 ✅ 2026-10-20\n"), true);
    assert.equal(board.sweepDoneTasks(settings, "proj").moved, 1);
    const content = readFileSync(join(root, "proj.md"), "utf8");
    assert.equal(content.includes("- [x] Obs #p2 ✅ 2026-10-20\n"), true);
    assert.equal(content.match(/✅/g)?.length, 2);
  });

  it("ignores a priority token inside an inline code span when parsing", () => {
    const code = parseFirst("- [ ] Run `grep #p1 file`");
    assert.equal(code.priority, null);
    assert.equal(code.title, "Run `grep #p1 file`");
    const double = parseFirst("- [ ] Run ``a ` #p1 b``");
    assert.equal(double.priority, null);
    assert.equal(double.title, "Run ``a ` #p1 b``");
    const mixed = parseFirst("- [ ] Run `a #p1` then #p3");
    assert.equal(mixed.priority, 3);
    assert.equal(mixed.title, "Run `a #p1` then");
    const real = parseFirst("- [ ] #p2 Run `grep #p1 file`");
    assert.equal(real.priority, 2);
    assert.equal(real.title, "Run `grep #p1 file`");
  });

  it("does not rewrite or strip code spans on later writes", () => {
    assert.equal(rewrite("- [ ] Run `grep #p1 file`", { status: "doing" }), "- [-] Run `grep #p1 file`");
    assert.equal(rewrite("- [ ] Run `grep #p1 file`", { priority: 2 }), "- [ ] Run `grep #p1 file` #p2");
    assert.equal(rewrite("- [ ] Run `grep #p1 file`", { priority: null }), "- [ ] Run `grep #p1 file`");
    assert.equal(rewrite("- [ ] Run `a #p1` then #p3", { priority: 0 }), "- [ ] Run `a #p1` then #p0");
  });

  it("removes tokens from a supplied title or reason without letting them change the priority", () => {
    assert.equal(rewrite("- [ ] Fix login #p1", { title: "Fix #p2 now" }), "- [ ] Fix now #p1");
    assert.equal(rewrite("- [ ] Fix login #p1", { title: "Fix #p2 now", priority: 3 }), "- [ ] Fix now #p3");
    assert.equal(rewrite("- [ ] Fix login", { title: "Fix #p2 now" }), "- [ ] Fix now");
    assert.equal(rewrite("- [ ] Fix login #p1", { title: "Keep `#p2` code #p0" }), "- [ ] Keep `#p2` code #p1");
    assert.equal(rewrite("- [ ] HOLD - T - r #p1", { reason: "aguarda #p0" }), "- [ ] HOLD - T - aguarda #p1");
    assert.equal(rewrite("- [ ] HOLD - T - r #p1", { reason: "aguarda #p0", priority: null }), "- [ ] HOLD - T - aguarda");
    assert.throws(() => rewrite("- [ ] Fix login", { title: " #p2 " }), /title/);
  });

  it("removes tokens from the title and reason of a created task and keeps the explicit priority", () => {
    const root = project({ "c.md": "## Open loops\n\n- [ ] Existing\n" });
    const settings = settingsFor(root);
    const explicit = board.createBoardTask(settings, { projectId: "c", title: "Fix #p2 now", priority: 1 });
    assert.equal(explicit.task.priority, 1);
    assert.equal(explicit.task.title, "Fix now");
    const implicit = board.createBoardTask(settings, { projectId: "c", title: "Plain #p2 thing" });
    assert.equal(implicit.task.priority, null);
    assert.equal(implicit.task.title, "Plain thing");
    const held = board.createBoardTask(settings, { projectId: "c", title: "Pay", status: "hold", reason: "wait #p0 vendor", priority: 3 });
    assert.equal(held.task.priority, 3);
    assert.equal(held.task.reason, "wait vendor");
    assert.equal(readFileSync(join(root, "c.md"), "utf8"), "## Open loops\n\n- [ ] Existing\n- [ ] Fix now #p1\n- [ ] Plain thing\n- [ ] HOLD - Pay - wait vendor #p3\n");
    assert.throws(() => board.createBoardTask(settings, { projectId: "c", title: "#p1" }), /title/);
  });
});

describe("tasks board round 3 priority routes", () => {
  const box: Sandbox = makeSandbox("cch-tasks-r3-");
  const vault = join(box.tmp, "vault");
  let hub: RunningServer;

  interface HttpResult {
    status: number;
    json: Record<string, unknown>;
  }

  interface WireTask {
    id: string;
    projectId: string;
    line: number;
    raw: string;
    title: string;
    reason: string | null;
    status: string;
    section: string;
    doneAt: string | null;
    priority: number | null;
    subtasks: WireTask[];
  }

  async function http(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const res = await fetch(`${hub.base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  const today = (): string => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  };
  const flat = (tasks: WireTask[]): WireTask[] => tasks.flatMap((task) => [task, ...flat(task.subtasks)]);
  const DEFAULT_TASKS = { section: "Open loops", doneSection: "", doneStamp: " ✅ {{date}}", reasonSeparator: " - ", separator: " - ", priorityTag: "p", priorityLevels: 4 };

  const configure = async (dir: string, tasks: Record<string, unknown> = {}): Promise<void> => {
    const res = await http("PUT", "/delegation/settings", {
      workspacesRoot: box.root,
      secondBrainRoot: box.brain,
      features: { tasks: true },
      tasks: { ...DEFAULT_TASKS, root: join(vault, dir), ...tasks },
    });
    assert.equal(res.status, 200);
  };
  const reset = (dir: string, files: Record<string, string>): void => {
    rmSync(join(vault, dir), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    writeTree(join(vault, dir), files);
  };
  const read = (rel: string): string => readFileSync(join(vault, rel), "utf8");
  const listTasks = async (): Promise<WireTask[]> => flat((await http("GET", "/delegation/tasks-board")).json.tasks as WireTask[]);
  const find = async (projectId: string, title: string): Promise<WireTask> => {
    const found = (await listTasks()).find((task) => task.projectId === projectId && task.title === title);
    assert.ok(found, `${projectId} ${title}`);
    return found;
  };
  const patch = (task: WireTask, change: Record<string, unknown>): Promise<HttpResult> =>
    http("PATCH", "/delegation/tasks-board/item", { projectId: task.projectId, line: task.line, raw: task.raw, ...change });
  const create = (body: Record<string, unknown>): Promise<HttpResult> => http("POST", "/delegation/tasks-board/item", body);
  const put = (tasks: unknown): Promise<HttpResult> => http("PUT", "/delegation/settings", { tasks });

  const P1 = [
    "## Open loops",
    "",
    "- [ ] Plain task",
    "- [ ] Ranked task #p1",
    "- [ ] HOLD - Legal review - waiting counsel #p2",
    "- [ ] Parent task",
    "  - [ ] Child task #p0",
    "  - child note",
    "",
  ].join("\n");

  before(async () => {
    mkdirSync(vault, { recursive: true });
    hub = await startServer(box, { HUB_DELEGATION: "1" });
  });

  after(() => {
    hub.child.kill();
    rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("ships priorityTag p and priorityLevels 4 as defaults", async () => {
    const got = (await http("GET", "/delegation/settings")).json.tasks as Record<string, unknown>;
    assert.equal(got.priorityTag, "p");
    assert.equal(got.priorityLevels, 4);
  });

  it("validates and round-trips priorityTag and priorityLevels", async () => {
    await configure("settings");
    for (const value of ["", "   ", "p q", "p#", "p.q", "é", "a\nb", 5, null, true]) {
      const res = await put({ priorityTag: value });
      assert.equal(res.status, 400, String(value));
      assert.equal(res.json.error, "tasks.priorityTag must be letters, digits, - or _ only", String(value));
    }
    for (const value of [0, 11, -1, 1.5, "4", null, true, 100]) {
      const res = await put({ priorityLevels: value });
      assert.equal(res.status, 400, String(value));
      assert.equal(res.json.error, "tasks.priorityLevels must be an integer from 1 to 10", String(value));
    }
    const ok = await put({ priorityTag: "prio-1_x", priorityLevels: 6 });
    assert.equal(ok.status, 200);
    assert.equal((ok.json.tasks as Record<string, unknown>).priorityTag, "prio-1_x");
    assert.equal((ok.json.tasks as Record<string, unknown>).priorityLevels, 6);
    const got = (await http("GET", "/delegation/settings")).json.tasks as Record<string, unknown>;
    assert.equal(got.priorityTag, "prio-1_x");
    assert.equal(got.priorityLevels, 6);
    for (const value of [1, 10]) assert.equal((await put({ priorityLevels: value })).status, 200, String(value));
    assert.equal(((await put({ priorityTag: "  P  " })).json.tasks as Record<string, unknown>).priorityTag, "P");
    assert.equal((await put({ priorityLevels: 4, priorityTag: "p" })).status, 200);
    const reset = (await http("GET", "/delegation/settings")).json.tasks as Record<string, unknown>;
    assert.equal(reset.priorityTag, "p");
    assert.equal(reset.priorityLevels, 4);
  });

  it("lists the parsed priority on every task and subtask", async () => {
    reset("list", { "l.md": P1 });
    await configure("list");
    assert.equal((await find("l", "Plain task")).priority, null);
    assert.equal((await find("l", "Ranked task")).priority, 1);
    assert.equal((await find("l", "Legal review")).priority, 2);
    assert.equal((await find("l", "Child task")).priority, 0);
    const held = await find("l", "Legal review");
    assert.equal(held.reason, "waiting counsel");
    assert.equal(held.status, "hold");
  });

  it("sets, changes and clears the priority through PATCH keeping reason and prefix", async () => {
    reset("patch", { "p.md": P1 });
    await configure("patch");
    const plain = await find("p", "Plain task");
    const set = await patch(plain, { priority: 2 });
    assert.equal(set.status, 200);
    assert.equal((set.json.task as WireTask).priority, 2);
    assert.equal((set.json.task as WireTask).title, "Plain task");
    assert.equal(read("patch/p.md"), P1.replace("- [ ] Plain task\n", "- [ ] Plain task #p2\n"));
    const changed = await patch(set.json.task as WireTask, { priority: 0 });
    assert.equal((changed.json.task as WireTask).priority, 0);
    assert.equal(read("patch/p.md"), P1.replace("- [ ] Plain task\n", "- [ ] Plain task #p0\n"));
    const cleared = await patch(changed.json.task as WireTask, { priority: null });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.json.task as WireTask).priority, null);
    assert.equal(read("patch/p.md"), P1);
    const held = await find("p", "Legal review");
    const heldSet = await patch(held, { priority: 3 });
    assert.equal(heldSet.status, 200);
    const heldTask = heldSet.json.task as WireTask;
    assert.equal(heldTask.status, "hold");
    assert.equal(heldTask.title, "Legal review");
    assert.equal(heldTask.reason, "waiting counsel");
    assert.equal(heldTask.priority, 3);
    assert.equal(read("patch/p.md"), P1.replace("waiting counsel #p2", "waiting counsel #p3"));
    const child = await find("p", "Child task");
    assert.equal((await patch(child, { priority: null })).status, 200);
    assert.equal(read("patch/p.md"), P1.replace("waiting counsel #p2", "waiting counsel #p3").replace("  - [ ] Child task #p0", "  - [ ] Child task"));
  });

  it("keeps the token when the title, reason or status change", async () => {
    reset("keep", { "k.md": P1 });
    await configure("keep");
    const ranked = await find("k", "Ranked task");
    const renamed = await patch(ranked, { title: "Ranked and renamed" });
    assert.equal(renamed.status, 200);
    assert.equal((renamed.json.task as WireTask).priority, 1);
    assert.equal((renamed.json.task as WireTask).title, "Ranked and renamed");
    assert.match(read("keep/k.md"), /^- \[ \] Ranked and renamed #p1$/m);
    const held = await find("k", "Legal review");
    const reasoned = await patch(held, { reason: "waiting signed contract" });
    assert.equal((reasoned.json.task as WireTask).priority, 2);
    assert.equal((reasoned.json.task as WireTask).reason, "waiting signed contract");
    assert.match(read("keep/k.md"), /^- \[ \] HOLD - Legal review - waiting signed contract #p2$/m);
    const statused = await patch(await find("k", "Ranked and renamed"), { status: "doing" });
    assert.equal((statused.json.task as WireTask).priority, 1);
    assert.match(read("keep/k.md"), /^- \[-\] Ranked and renamed #p1$/m);
    const blocked = await patch(await find("k", "Ranked and renamed"), { status: "blocked", reason: "no api" });
    assert.equal((blocked.json.task as WireTask).priority, 1);
    assert.match(read("keep/k.md"), /^- \[-\] BLOCK - Ranked and renamed - no api #p1$/m);
  });

  it("applies a priority change together with a status change", async () => {
    reset("combo", { "c.md": P1 });
    await configure("combo");
    const plain = await find("c", "Plain task");
    const res = await patch(plain, { status: "hold", reason: "vendor", priority: 1 });
    assert.equal(res.status, 200);
    assert.match(read("combo/c.md"), /^- \[ \] HOLD - Plain task - vendor #p1$/m);
  });

  it("writes the token before the stamp in the done section and keeps it when a task moves", async () => {
    const withDone = ["## Open loops", "", "- [ ] Open item #p1", "- [ ] Another item", "", "## Done loops", "", "- [x] Finished item ✅ 2026-03-01", ""].join("\n");
    reset("done", { "d.md": withDone });
    await configure("done", { doneSection: "Done loops" });
    const finished = await find("d", "Finished item");
    assert.equal(finished.section, "done");
    const set = await patch(finished, { priority: 2 });
    assert.equal(set.status, 200);
    assert.equal((set.json.task as WireTask).priority, 2);
    assert.equal((set.json.task as WireTask).doneAt, "2026-03-01");
    assert.match(read("done/d.md"), /^- \[x\] Finished item #p2 ✅ 2026-03-01$/m);
    const retitled = await patch(set.json.task as WireTask, { title: "Finished and renamed" });
    assert.equal((retitled.json.task as WireTask).priority, 2);
    assert.match(read("done/d.md"), /^- \[x\] Finished and renamed #p2 ✅ 2026-03-01$/m);
    const cleared = await patch(retitled.json.task as WireTask, { priority: null });
    assert.equal(cleared.status, 200);
    assert.match(read("done/d.md"), /^- \[x\] Finished and renamed ✅ 2026-03-01$/m);
    const open = await find("d", "Open item");
    const moved = await patch(open, { status: "done" });
    assert.equal((moved.json.task as WireTask).section, "done");
    assert.equal((moved.json.task as WireTask).priority, 1);
    assert.match(read("done/d.md"), new RegExp(`^- \\[x\\] Open item #p1 ✅ ${today()}$`, "m"));
    const reopened = await patch(moved.json.task as WireTask, { status: "todo" });
    assert.equal((reopened.json.task as WireTask).section, "open");
    assert.equal((reopened.json.task as WireTask).priority, 1);
    assert.match(read("done/d.md"), /^- \[ \] Open item #p1$/m);
  });

  it("validates the priority value on PATCH and still allows a priority-only body", async () => {
    reset("val", { "v.md": P1 });
    await configure("val");
    const plain = await find("v", "Plain task");
    for (const value of [10, -1, 1.5, "1", true, [], {}]) {
      assert.equal((await patch(plain, { priority: value })).status, 400, JSON.stringify(value));
    }
    assert.equal((await patch(plain, { priority: 10 })).json.error, "priority must be an integer from 0 to 9 or null");
    assert.equal(read("val/v.md"), P1);
    assert.equal((await patch(plain, { priority: 9 })).status, 200);
    assert.equal((await patch(await find("v", "Plain task"), {})).status, 400);
    const unchanged = await patch(await find("v", "Ranked task"), { priority: 1 });
    assert.equal(unchanged.status, 200);
    assert.equal((unchanged.json.task as WireTask).priority, 1);
    const stale = await http("PATCH", "/delegation/tasks-board/item", { projectId: "v", line: plain.line, raw: "- [ ] Plain task", priority: 1 });
    assert.equal(stale.status, 409);
  });

  it("uses the configured tag for reads and writes", async () => {
    reset("tag", { "t.md": "## Open loops\n\n- [ ] Custom ranked #prio2\n- [ ] Default token stays #p1\n- [ ] Fresh\n" });
    await configure("tag", { priorityTag: "prio" });
    const ranked = await find("t", "Custom ranked");
    assert.equal(ranked.priority, 2);
    const stays = await find("t", "Default token stays #p1");
    assert.equal(stays.priority, null);
    const fresh = await find("t", "Fresh");
    const set = await patch(fresh, { priority: 0 });
    assert.equal(set.status, 200);
    assert.match(read("tag/t.md"), /^- \[ \] Fresh #prio0$/m);
    assert.equal((await patch(await find("t", "Custom ranked"), { priority: 3 })).status, 200);
    assert.match(read("tag/t.md"), /^- \[ \] Custom ranked #prio3$/m);
    await configure("tag");
  });

  describe("create", () => {
    const C = "## Open loops\n\n- [ ] Existing\n";

    it("appends the token at the end of a new task, with reason and as a subtask", async () => {
      reset("create", { "c.md": C });
      await configure("create");
      const plain = await create({ projectId: "c", title: "Ranked new", priority: 2 });
      assert.equal(plain.status, 201);
      assert.equal((plain.json.task as WireTask).priority, 2);
      assert.equal((plain.json.task as WireTask).title, "Ranked new");
      assert.equal(read("create/c.md"), "## Open loops\n\n- [ ] Existing\n- [ ] Ranked new #p2\n");
      const held = await create({ projectId: "c", title: "Held new", status: "hold", reason: "vendor", priority: 0 });
      assert.equal(held.status, 201);
      assert.equal((held.json.task as WireTask).priority, 0);
      assert.equal((held.json.task as WireTask).reason, "vendor");
      assert.match(read("create/c.md"), /^- \[ \] HOLD - Held new - vendor #p0$/m);
      const existing = await find("c", "Existing");
      const child = await create({ projectId: "c", title: "Child new", priority: 3, parentLine: existing.line, parentRaw: existing.raw });
      assert.equal(child.status, 201);
      assert.equal((child.json.task as WireTask).priority, 3);
      assert.match(read("create/c.md"), /^ {2}- \[ \] Child new #p3$/m);
    });

    it("treats null and absent priority as none and rejects invalid values", async () => {
      reset("create2", { "c.md": C });
      await configure("create2");
      assert.equal(((await create({ projectId: "c", title: "No pri", priority: null })).json.task as WireTask).priority, null);
      assert.equal(((await create({ projectId: "c", title: "Absent pri" })).json.task as WireTask).priority, null);
      assert.equal(read("create2/c.md"), "## Open loops\n\n- [ ] Existing\n- [ ] No pri\n- [ ] Absent pri\n");
      for (const value of [10, -1, 1.5, "1", true]) {
        const res = await create({ projectId: "c", title: "Bad", priority: value });
        assert.equal(res.status, 400, String(value));
        assert.equal(res.json.error, "priority must be an integer from 0 to 9 or null");
      }
      assert.equal(read("create2/c.md"), "## Open loops\n\n- [ ] Existing\n- [ ] No pri\n- [ ] Absent pri\n");
    });

    it("puts the token before the stamp for a task created as done", async () => {
      reset("create3", { "c.md": "## Open loops\n\n- [ ] Existing\n\n## Done loops\n\n- [x] Old ✅ 2026-03-01\n" });
      await configure("create3", { doneSection: "Done loops" });
      const res = await create({ projectId: "c", title: "Born done", status: "done", priority: 1 });
      assert.equal(res.status, 201);
      assert.equal((res.json.task as WireTask).priority, 1);
      assert.equal((res.json.task as WireTask).doneAt, today());
      assert.match(read("create3/c.md"), new RegExp(`^- \\[x\\] Born done #p1 ✅ ${today()}$`, "m"));
    });

    it("uses the configured tag", async () => {
      reset("create4", { "c.md": C });
      await configure("create4", { priorityTag: "prio" });
      const res = await create({ projectId: "c", title: "Tagged", priority: 2 });
      assert.equal(res.status, 201);
      assert.equal((res.json.task as WireTask).priority, 2);
      assert.match(read("create4/c.md"), /^- \[ \] Tagged #prio2$/m);
      await configure("create4");
    });
  });
});

describe("round 3 verifier fixes: stamp followed by priority and title-less tasks", () => {
  const cfg = (tasks: Partial<DelegationSettings["tasks"]> = {}): DelegationSettings["tasks"] => ({ ...defaults(), doneSection: "Done", doneStamp: " ✅ {{date}}", priorityTag: "p", ...tasks });
  const rewrite = (raw: string, change: Parameters<Board["rewriteTaskLine"]>[2], mode: Parameters<Board["rewriteTaskLine"]>[3] = "none", tasks: Partial<DelegationSettings["tasks"]> = {}) =>
    board.rewriteTaskLine(raw, cfg(tasks), change, mode);
  const project = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(dataDir, "r3-verifier-"));
    writeTree(root, files);
    return root;
  };
  const noTitle = (err: unknown): boolean => err instanceof Error && err.constructor.name === "BadRequestError" && err.message === "task has no title";

  it("parses a done-section stamp followed only by priority tokens", () => {
    const tasks = board.parseBoardTasks("## Open loops\n\n- [ ] Open\n\n## Done\n\n- [x] Bar ✅ 2026-10-01 #p2\n- [x] Baz ✅ 2026-10-02\t#P1  #p3 \n- [x] Qux ✅ 2026-10-03 later #p2\n", "p", cfg());
    assert.deepEqual(tasks.map((task) => [task.title, task.doneAt, task.priority]), [
      ["Open", null, null],
      ["Bar", "2026-10-01", 2],
      ["Baz", "2026-10-02", 1],
      ["Qux ✅ 2026-10-03 later", "2026-10-03", 2],
    ]);
    const custom = board.parseBoardTasks("## Open loops\n\n## Done\n\n- [x] Custom (done 2026-10-04) #p0\n", "p", cfg({ doneStamp: " (done {{date}})" }));
    assert.deepEqual(custom.map((task) => [task.title, task.doneAt, task.priority]), [["Custom", "2026-10-04", 0]]);
  });

  it("normalises the token before the stamp on every rewrite", () => {
    assert.equal(rewrite("- [x] Foo ✅ 2026-10-01 #p2", { priority: 1 }, "keep"), "- [x] Foo #p1 ✅ 2026-10-01");
    assert.equal(rewrite("- [x] Foo ✅ 2026-10-01 #p2", { priority: null }, "keep"), "- [x] Foo ✅ 2026-10-01");
    assert.equal(rewrite("- [x] Foo ✅ 2026-10-01 #p2", { title: "Bar" }, "keep"), "- [x] Bar #p2 ✅ 2026-10-01");
    assert.equal(rewrite("- [x] Foo ✅ 2026-10-01 #p2", { status: "todo" }, "keep"), "- [ ] Foo #p2 ✅ 2026-10-01");
    assert.equal(rewrite("- [x] Foo ✅ 2026-10-01 #p2", { priority: 1 }, "drop"), "- [x] Foo #p1");
    assert.equal(rewrite("- [ ] HOLD - Foo - why ✅ 2026-10-01 #p2", { priority: 3 }), "- [ ] HOLD - Foo - why #p3 ✅ 2026-10-01");
    assert.equal(rewrite("- [x] Foo (done 2026-10-01) #p2", { priority: 1 }, "keep", { doneStamp: " (done {{date}})" }), "- [x] Foo #p1 (done 2026-10-01)");
  });

  it("does not add a second stamp when sweeping a task whose tag follows the stamp, and reopens it with the tag", () => {
    const root = project({ "proj.md": "## Open loops\n\n- [x] Foo ✅ 2026-10-01 #p2\n- [ ] Bar\n\n## Done\n\n- [x] Old ✅ 2026-09-01\n" });
    const settings = settingsFor(root, { section: "Open loops", doneSection: "Done", doneStamp: " ✅ {{date}}", priorityTag: "p" });
    assert.equal(board.sweepDoneTasks(settings, "proj").moved, 1);
    const swept = readFileSync(join(root, "proj.md"), "utf8");
    assert.equal(swept, "## Open loops\n\n- [ ] Bar\n\n## Done\n\n- [x] Foo #p2 ✅ 2026-10-01\n- [x] Old ✅ 2026-09-01\n");
    const foo = board.parseBoardTasks(swept, "proj", settings.tasks).find((task) => task.title === "Foo");
    assert.equal(foo?.doneAt, "2026-10-01");
    assert.equal(foo?.priority, 2);
    assert.equal(board.sweepDoneTasks(settings, "proj").moved, 0);
  });

  it("rewrites a hand-typed tag-after-stamp line in the done section and reopens it", () => {
    const root = project({ "proj.md": "## Open loops\n\n- [ ] Bar\n\n## Done\n\n- [x] Foo ✅ 2026-10-01 #p2\n- [x] Old ✅ 2026-09-01\n" });
    const settings = settingsFor(root, { section: "Open loops", doneSection: "Done", doneStamp: " ✅ {{date}}", priorityTag: "p" });
    const prioritized = board.writeBoardTask(settings, { projectId: "proj", line: 6, raw: "- [x] Foo ✅ 2026-10-01 #p2", priority: 0 });
    assert.equal(prioritized.task.priority, 0);
    assert.equal(prioritized.task.doneAt, "2026-10-01");
    assert.equal(readFileSync(join(root, "proj.md"), "utf8"), "## Open loops\n\n- [ ] Bar\n\n## Done\n\n- [x] Foo #p0 ✅ 2026-10-01\n- [x] Old ✅ 2026-09-01\n");
    const reopenRoot = project({ "proj.md": "## Open loops\n\n- [ ] Bar\n\n## Done\n\n- [x] Foo ✅ 2026-10-01 #p2\n- [x] Old ✅ 2026-09-01\n" });
    const reopenSettings = settingsFor(reopenRoot, { section: "Open loops", doneSection: "Done", doneStamp: " ✅ {{date}}", priorityTag: "p" });
    const reopened = board.writeBoardTask(reopenSettings, { projectId: "proj", line: 6, raw: "- [x] Foo ✅ 2026-10-01 #p2", status: "todo" });
    assert.equal(reopened.moved, true);
    assert.equal(reopened.task.priority, 2);
    assert.equal(readFileSync(join(reopenRoot, "proj.md"), "utf8"), "## Open loops\n\n- [ ] Bar\n- [ ] Foo #p2\n\n## Done\n\n- [x] Old ✅ 2026-09-01\n");
  });

  it("refuses priority and prefix writes on a task whose text is only priority tokens", () => {
    assert.throws(() => rewrite("- [ ] #p1", { priority: 2 }), noTitle);
    assert.throws(() => rewrite("- [ ] #p1 #P0", { priority: null }), noTitle);
    assert.throws(() => rewrite("- [ ] #p1", { status: "hold" }), noTitle);
    assert.equal(rewrite("- [ ] #p1", { status: "doing" }), "- [-] #p1");
    assert.equal(rewrite("- [ ] #p1", { title: "Real", priority: 2 }), "- [ ] Real #p2");
    const original = "## Open loops\n\n- [ ] #p1\n";
    const root = project({ "proj.md": original });
    const settings = settingsFor(root, { section: "Open loops", priorityTag: "p" });
    assert.throws(() => board.writeBoardTask(settings, { projectId: "proj", line: 2, raw: "- [ ] #p1", priority: 2 }), noTitle);
    assert.equal(readFileSync(join(root, "proj.md"), "utf8"), original);
  });

  it("refuses to create a task whose title is only priority tokens", () => {
    const original = "## Open loops\n\n- [ ] Existing\n";
    const root = project({ "proj.md": original });
    const settings = settingsFor(root, { section: "Open loops", priorityTag: "p" });
    assert.throws(() => board.createBoardTask(settings, { projectId: "proj", title: "#p0", priority: 1 }), noTitle);
    assert.throws(() => board.createBoardTask(settings, { projectId: "proj", title: " #p0  #P2 " }), noTitle);
    assert.equal(readFileSync(join(root, "proj.md"), "utf8"), original);
  });
});

describe("round 4 verifier fixes: stamp edge cases and title-less status tasks", () => {
  const cfg = (tasks: Partial<DelegationSettings["tasks"]> = {}): DelegationSettings["tasks"] => ({ ...defaults(), doneSection: "Done", doneStamp: " ✅ {{date}}", priorityTag: "p", ...tasks });
  const rewrite = (raw: string, change: Parameters<Board["rewriteTaskLine"]>[2], mode: Parameters<Board["rewriteTaskLine"]>[3] = "none", tasks: Partial<DelegationSettings["tasks"]> = {}) =>
    board.rewriteTaskLine(raw, cfg(tasks), change, mode);
  const project = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(dataDir, "r4-verifier-"));
    writeTree(root, files);
    return root;
  };
  const noTitle = (err: unknown): boolean => err instanceof Error && err.constructor.name === "BadRequestError" && err.message === "task has no title";
  const sweepOf = (open: string, tasks: Partial<DelegationSettings["tasks"]> = {}): { moved: number; content: string } => {
    const root = project({ "proj.md": `## Open loops\n\n${open}\n- [ ] Bar\n\n## Done\n\n- [x] Old ✅ 2026-09-01\n` });
    const settings = settingsFor(root, { section: "Open loops", doneSection: "Done", doneStamp: " ✅ {{date}}", priorityTag: "p", ...tasks });
    const moved = board.sweepDoneTasks(settings, "proj").moved;
    return { moved, content: readFileSync(join(root, "proj.md"), "utf8") };
  };
  const tail = "\n- [x] Old ✅ 2026-09-01\n";

  it("reads a stamp glued to its date and to a following priority token", () => {
    const tasks = board.parseBoardTasks("## Open loops\n\n## Done\n\n- [x] F ✅2026-10-01#p1\n- [x] G ✅ 2026-10-02#p2 #p3\n", "p", cfg());
    assert.deepEqual(tasks.map((task) => [task.title, task.doneAt, task.priority]), [
      ["F", "2026-10-01", 1],
      ["G", "2026-10-02", 2],
    ]);
  });

  it("normalises a glued stamp to the title, the token and a spaced stamp on every hub write", () => {
    assert.equal(rewrite("- [x] F ✅2026-10-01#p1", { priority: 2 }, "keep"), "- [x] F #p2 ✅ 2026-10-01");
    assert.equal(rewrite("- [x] F ✅2026-10-01#p1", { status: "todo" }, "keep"), "- [ ] F #p1 ✅ 2026-10-01");
    assert.equal(rewrite("- [x] F ✅2026-10-01", { title: "G" }, "keep"), "- [x] G ✅ 2026-10-01");
    assert.equal(rewrite("- [x] F ✅2026-10-01#p1", { priority: 2 }, "drop"), "- [x] F #p2");
  });

  it("sweeps a glued stamp into the done section as one normalised stamp with its priority", () => {
    const swept = sweepOf("- [x] F ✅2026-10-01#p1\n");
    assert.equal(swept.moved, 1);
    assert.equal(swept.content, `## Open loops\n\n- [ ] Bar\n\n## Done\n\n- [x] F #p1 ✅ 2026-10-01${tail}`);
    const parsed = board.parseBoardTasks(swept.content, "proj", cfg()).find((task) => task.title === "F");
    assert.equal(parsed?.priority, 1);
    assert.equal(parsed?.doneAt, "2026-10-01");
  });

  it("does not add a second stamp to a line that already carries a stamp followed by text", () => {
    const swept = sweepOf("- [x] E ✅ 2026-10-01 note #p1\n");
    assert.equal(swept.moved, 1);
    assert.equal(swept.content, `## Open loops\n\n- [ ] Bar\n\n## Done\n\n- [x] E ✅ 2026-10-01 note #p1${tail}`);
    const parsed = board.parseBoardTasks(swept.content, "proj", cfg()).find((task) => task.title.startsWith("E"));
    assert.equal(parsed?.doneAt, "2026-10-01");
    assert.equal(parsed?.priority, 1);
    assert.equal(sweepOf("- [x] H ✅ 2026-10-04 note\n").content.match(/✅/g)?.length, 2);
  });

  it("does not stamp an annotated line twice on a status auto-move either", () => {
    const original = "## Open loops\n\n- [-] E ✅ 2026-10-01 note #p1\n- [ ] Bar\n\n## Done\n\n- [x] Old ✅ 2026-09-01\n";
    const root = project({ "proj.md": original });
    const settings = settingsFor(root, { section: "Open loops", doneSection: "Done", doneStamp: " ✅ {{date}}", priorityTag: "p" });
    const written = board.writeBoardTask(settings, { projectId: "proj", line: 2, raw: "- [-] E ✅ 2026-10-01 note #p1", status: "done" });
    assert.equal(written.moved, true);
    assert.equal(written.task.doneAt, "2026-10-01");
    assert.equal(readFileSync(join(root, "proj.md"), "utf8"), `## Open loops\n\n- [ ] Bar\n\n## Done\n\n- [x] E ✅ 2026-10-01 note #p1${tail}`);
  });

  it("keeps an annotated stamp under a custom template and under the default shape alike", () => {
    const custom = { doneStamp: " (done {{date}})" };
    const swept = sweepOf("- [x] E (done 2026-10-02) note\n- [x] G ✅ 2026-10-03 note\n", custom);
    assert.equal(swept.moved, 2);
    assert.equal(swept.content.includes("- [x] E (done 2026-10-02) note\n"), true);
    assert.equal(swept.content.includes("- [x] G ✅ 2026-10-03 note\n"), true);
    assert.equal(swept.content.match(/\(done /g)?.length, 1);
    assert.equal(swept.content.match(/✅/g)?.length, 2);
    assert.equal(rewrite("- [x] E ✅ 2026-10-01 note #p1", { priority: 2 }, "keep"), "- [x] E ✅ 2026-10-01 note #p2");
  });

  it("reads doneAt from the default shape when the configured template differs", () => {
    const custom = cfg({ doneStamp: " (done {{date}})" });
    const tasks = board.parseBoardTasks("## Open loops\n\n## Done\n\n- [x] Foo ✅ 2026-10-01 #p2\n- [x] Bar (done 2026-10-02)\n", "p", custom);
    assert.deepEqual(tasks.map((task) => [task.title, task.doneAt, task.priority]), [
      ["Foo", "2026-10-01", 2],
      ["Bar", "2026-10-02", null],
    ]);
    const root = project({ "proj.md": "## Open loops\n\n- [ ] Bar\n\n## Done\n\n- [x] Foo ✅ 2026-10-01\n" });
    const settings = settingsFor(root, { section: "Open loops", doneSection: "Done", doneStamp: " (done {{date}})", priorityTag: "p" });
    const reopened = board.writeBoardTask(settings, { projectId: "proj", line: 6, raw: "- [x] Foo ✅ 2026-10-01", status: "todo" });
    assert.equal(reopened.moved, true);
    assert.equal(readFileSync(join(root, "proj.md"), "utf8"), "## Open loops\n\n- [ ] Bar\n- [ ] Foo\n\n## Done\n\n-\n");
  });

  it("parses a status prefix followed only by a separator and priority tokens as that status with an empty title", () => {
    const tasks = board.parseBoardTasks("## Open loops\n\n- [ ] HOLD - #p3\n- [ ] BLOCK -\n- [ ] HOLD - Real #p1\n- [ ] HOLD #p1\n", "p", cfg());
    assert.deepEqual(tasks.map((task) => [task.status, task.title, task.reason, task.priority]), [
      ["hold", "", null, 3],
      ["blocked", "", null, null],
      ["hold", "Real", null, 1],
      ["todo", "HOLD", null, 1],
    ]);
  });

  it("refuses writes that need a title on a title-less prefix task and never duplicates the prefix", () => {
    assert.throws(() => rewrite("- [ ] HOLD - #p3", { status: "hold" }), noTitle);
    assert.throws(() => rewrite("- [ ] HOLD - #p3", { status: "blocked" }), noTitle);
    assert.throws(() => rewrite("- [ ] HOLD - #p3", { priority: 1 }), noTitle);
    assert.throws(() => rewrite("- [ ] HOLD - #p3", { reason: "why" }), noTitle);
    assert.throws(() => rewrite("- [ ] HOLD -", { status: "hold" }), noTitle);
    assert.equal(rewrite("- [ ] HOLD - #p3", { status: "doing" }), "- [-] #p3");
    assert.equal(rewrite("- [ ] HOLD - #p3", { status: "todo" }), "- [ ] #p3");
    assert.equal(rewrite("- [ ] HOLD - #p3", { title: "Real" }), "- [ ] HOLD - Real #p3");
    assert.equal(rewrite("- [ ] HOLD - #p3", { title: "Real", status: "blocked" }), "- [ ] BLOCK - Real #p3");
    assert.equal(rewrite("- [ ] HOLD -", { title: "Real" }), "- [ ] HOLD - Real");
    const original = "## Open loops\n\n- [ ] HOLD - #p3\n";
    const root = project({ "proj.md": original });
    const settings = settingsFor(root, { section: "Open loops", priorityTag: "p" });
    assert.throws(() => board.writeBoardTask(settings, { projectId: "proj", line: 2, raw: "- [ ] HOLD - #p3", status: "hold" }), noTitle);
    assert.equal(readFileSync(join(root, "proj.md"), "utf8"), original);
  });
});
