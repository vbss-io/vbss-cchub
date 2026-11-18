import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-board-cache-data-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_SECOND_BRAIN;

type Store = typeof import("../src/delegation-store.js");
type Board = typeof import("../src/tasks-board.js");
let store: Store;
let board: Board;
const roots: string[] = [];

before(async () => {
  store = await import("../src/delegation-store.js");
  board = await import("../src/tasks-board.js");
});

after(async () => {
  (await import("../src/db.js")).db.close();
  for (const dir of [dataDir, ...roots]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function vault(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cch-board-cache-vault-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function tasksOf(root: string, extra: Partial<DelegationSettings["tasks"]> = {}): DelegationSettings["tasks"] {
  return { ...store.getSettings().tasks, root, ...extra };
}

const projectText = (title: string, task: string): string => `# ${title}\n\n## Open loops\n\n- [ ] ${task}\n  - [ ] ${task} child\n`;

describe("board memo", () => {
  it("keeps memos only for the files of the current project list and the current settings", () => {
    const root = vault({ "alpha.md": projectText("Alpha", "Alpha work"), "beta.md": projectText("Beta", "Beta work"), "gamma.md": projectText("Gamma", "Gamma work") });
    board.collectBoard(root, tasksOf(root));
    assert.deepEqual(board.memoSizes(), { files: 3, parses: 3 });
    unlinkSync(join(root, "gamma.md"));
    board.collectBoard(root, tasksOf(root));
    assert.deepEqual(board.memoSizes(), { files: 2, parses: 2 });
    board.collectBoard(root, tasksOf(root, { priorityTag: "prio" }));
    assert.deepEqual(board.memoSizes(), { files: 2, parses: 2 });
    const other = vault({ "delta.md": projectText("Delta", "Delta work") });
    board.collectBoard(other, tasksOf(other));
    assert.deepEqual(board.memoSizes(), { files: 1, parses: 1 });
  });

  it("caps the memos when a vault has more files than the limit", () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 2100; index += 1) files[`p${index}.md`] = projectText(`P${index}`, `Task ${index}`);
    const root = vault(files);
    const { loaded } = board.collectBoard(root, tasksOf(root));
    assert.equal(loaded.projects.length, 2100);
    const sizes = board.memoSizes();
    assert.ok(sizes.files <= 2048 && sizes.parses <= 2048, JSON.stringify(sizes));
  });

  it("hands every caller its own containers and frozen tasks, so no caller can change the cached board", () => {
    const root = vault({ "alpha.md": projectText("Alpha", "Alpha work") });
    const first = board.collectBoard(root, tasksOf(root));
    const second = board.collectBoard(root, tasksOf(root));
    assert.equal(first.tasks, second.tasks);
    assert.notEqual(first.loaded, second.loaded);
    assert.notEqual(first.loaded.contents, second.loaded.contents);
    first.loaded.contents.set("alpha", "tampered");
    assert.equal(board.collectBoard(root, tasksOf(root)).loaded.contents.get("alpha"), projectText("Alpha", "Alpha work"));
    const task = first.tasks[0];
    assert.ok(task);
    assert.equal(Object.isFrozen(first.tasks), true);
    assert.equal(Object.isFrozen(task), true);
    assert.equal(Object.isFrozen(task.subtasks), true);
    assert.equal(Object.isFrozen(first.loaded.projects[0]), true);
    assert.throws(() => {
      (task as { title: string }).title = "tampered";
    }, TypeError);
    assert.throws(() => first.tasks.push(task), TypeError);
    assert.equal(board.collectBoard(root, tasksOf(root)).tasks[0]?.title, "Alpha work");
  });
});
