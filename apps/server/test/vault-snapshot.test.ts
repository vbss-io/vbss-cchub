import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { DelegationSettings } from "../src/delegation-types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-snap-data-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.HUB_WORKSPACES_ROOT;
delete process.env.HUB_EDITOR;
delete process.env.HUB_SECOND_BRAIN;

type Snapshot = typeof import("../src/vault-snapshot.js");
type Store = typeof import("../src/delegation-store.js");
type Board = typeof import("../src/tasks-board.js");
type Daily = typeof import("../src/daily.js");
type Brain = typeof import("../src/second-brain.js");
let snapshot: Snapshot;
let store: Store;
let board: Board;
let daily: Daily;
let brain: Brain;

const vault = mkdtempSync(join(tmpdir(), "cch-snap-vault-"));
const snapshotsDir = join(dataDir, "vault-snapshots");
const noon = new Date(2026, 10, 12, 12, 0, 0);
const nextDay = new Date(2026, 10, 13, 9, 0, 0);

before(async () => {
  snapshot = await import("../src/vault-snapshot.js");
  store = await import("../src/delegation-store.js");
  board = await import("../src/tasks-board.js");
  daily = await import("../src/daily.js");
  brain = await import("../src/second-brain.js");
});

beforeEach(() => {
  rmSync(snapshotsDir, { recursive: true, force: true });
  snapshot.enableVaultSnapshots(snapshotsDir);
});

after(() => {
  snapshot.enableVaultSnapshots(null);
  rmSync(vault, { recursive: true, force: true });
});

function put(rel: string, content: string): string {
  const full = join(vault, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function settingsFor(): DelegationSettings {
  const base = store.getSettings();
  return {
    ...base,
    secondBrainRoot: vault,
    features: { ...base.features, tasks: true, daily: true },
    tasks: { ...base.tasks, root: join(vault, "projects") },
  };
}

describe("snapshotVaultFile", () => {
  it("copies the file as it was into a dated folder keeping its path relative to the vault", () => {
    const file = put("projects/acme.md", "# Acme\n\n- [ ] Renew contract\n");
    const target = snapshot.snapshotVaultFile(vault, file, noon);
    assert.equal(target, join(snapshotsDir, "2026-11-12", "projects", "acme.md"));
    assert.equal(readFileSync(target as string, "utf8"), "# Acme\n\n- [ ] Renew contract\n");
  });

  it("keeps the bytes exactly, BOM and CRLF included", () => {
    const content = `${String.fromCharCode(0xfeff)}# Globex\r\n\r\n- [ ] Ship\r\n`;
    const file = put("projects/globex.md", content);
    const target = snapshot.snapshotVaultFile(vault, file, noon) as string;
    assert.deepEqual(readFileSync(target), readFileSync(file));
  });

  it("does not recreate the snapshot on the second write of the same day", () => {
    const file = put("projects/initech.md", "first\n");
    const target = snapshot.snapshotVaultFile(vault, file, noon) as string;
    writeFileSync(file, "second\n");
    assert.equal(snapshot.snapshotVaultFile(vault, file, new Date(2026, 10, 12, 18, 30)), null);
    assert.equal(readFileSync(target, "utf8"), "first\n");
  });

  it("creates a new snapshot on the next local day", () => {
    const file = put("projects/initech.md", "monday\n");
    snapshot.snapshotVaultFile(vault, file, noon);
    writeFileSync(file, "tuesday\n");
    const target = snapshot.snapshotVaultFile(vault, file, nextDay) as string;
    assert.equal(target, join(snapshotsDir, "2026-11-13", "projects", "initech.md"));
    assert.equal(readFileSync(target, "utf8"), "tuesday\n");
  });

  it("skips a file that does not exist yet", () => {
    assert.equal(snapshot.snapshotVaultFile(vault, join(vault, "daily", "2026-11-12.md"), noon), null);
    assert.equal(existsSync(snapshotsDir), false);
  });

  it("uses a sanitized absolute path name for files outside the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "cch-snap-outside-"));
    try {
      const file = join(outside, "notes.md");
      writeFileSync(file, "outside\n");
      const target = snapshot.snapshotVaultFile(vault, file, noon) as string;
      assert.ok(target.startsWith(join(snapshotsDir, "2026-11-12", "_outside")));
      assert.doesNotMatch(target.slice(join(snapshotsDir, "2026-11-12", "_outside").length + 1), /[\\/:]/);
      assert.equal(readFileSync(target, "utf8"), "outside\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does nothing while snapshots are disabled", () => {
    snapshot.enableVaultSnapshots(null);
    const file = put("projects/acme.md", "x\n");
    assert.equal(snapshot.snapshotVaultFile(vault, file, noon), null);
    assert.equal(existsSync(snapshotsDir), false);
  });

  it("never throws when the snapshot cannot be written", () => {
    mkdirSync(dirname(snapshotsDir), { recursive: true });
    writeFileSync(snapshotsDir, "not a folder");
    const file = put("projects/acme.md", "x\n");
    assert.equal(snapshot.snapshotVaultFile(vault, file, noon), null);
    rmSync(snapshotsDir, { force: true });
  });
});

describe("snapshot retention", () => {
  it("removes day folders older than 14 days and keeps the rest", () => {
    for (const day of ["2026-10-20", "2026-10-28", "2026-10-29", "2026-11-11", "2026-11-12"]) {
      mkdirSync(join(snapshotsDir, day), { recursive: true });
    }
    mkdirSync(join(snapshotsDir, "not-a-day"), { recursive: true });
    const removed = snapshot.pruneVaultSnapshots(noon);
    assert.deepEqual(removed, ["2026-10-20", "2026-10-28"]);
    assert.equal(snapshot.snapshotDayCount(), 3);
    assert.ok(existsSync(join(snapshotsDir, "not-a-day")));
  });

  it("counts the day folders", () => {
    assert.equal(snapshot.snapshotDayCount(), 0);
    mkdirSync(join(snapshotsDir, "2026-11-10"), { recursive: true });
    mkdirSync(join(snapshotsDir, "2026-11-11"), { recursive: true });
    assert.equal(snapshot.snapshotDayCount(), 2);
  });
});

describe("snapshot before vault writes", () => {
  it("snapshots a daily before the first write of the day only", () => {
    const today = brain.localDate();
    const file = put(`daily/${today}.md`, "---\ntype: daily\n---\n\n## Focus\n\n- [ ] original\n");
    const original = readFileSync(file, "utf8");
    daily.writeDaily(settingsFor(), today, `${original}- [ ] second\n`);
    daily.writeDaily(settingsFor(), today, `${original}- [ ] third\n`);
    const kept = join(snapshotsDir, today, "daily", `${today}.md`);
    assert.equal(readFileSync(kept, "utf8"), original);
    assert.match(readFileSync(file, "utf8"), /third/);
  });

  it("snapshots a project file before the board rewrites it", () => {
    const file = put("projects/acme.md", "## Open loops\n\n- [ ] Renew contract\n- [ ] Send invoice\n");
    const original = readFileSync(file, "utf8");
    const task = board.readBoard(settingsFor()).tasks.find((entry) => entry.projectId === "acme" && entry.title === "Send invoice");
    assert.ok(task);
    board.writeBoardTask(settingsFor(), { projectId: "acme", line: task.line, raw: task.raw, status: "blocked" });
    const kept = join(snapshotsDir, brain.localDate(), "projects", "acme.md");
    assert.equal(readFileSync(kept, "utf8"), original);
    assert.equal(readFileSync(file, "utf8"), original.replace("- [ ] Send invoice", "- [ ] BLOCK - Send invoice"));
    const written = readFileSync(file, "utf8");
    const again = board.readBoard(settingsFor()).tasks.find((entry) => entry.projectId === "acme" && entry.title === "Renew contract");
    assert.ok(again);
    board.writeBoardTask(settingsFor(), { projectId: "acme", line: again.line, raw: again.raw, status: "done" });
    assert.notEqual(readFileSync(file, "utf8"), written);
    assert.equal(readFileSync(kept, "utf8"), original);
  });

  it("snapshots the hub source before the second append of the day", () => {
    const now = new Date(2026, 10, 12, 10, 0, 0);
    const path = brain.appendHubSource(vault, "task delegated - acme", now);
    const afterFirst = readFileSync(path, "utf8");
    brain.appendHubSource(vault, "report - acme", now);
    brain.appendHubSource(vault, "report again - acme", now);
    const kept = join(snapshotsDir, "2026-11-12", "fontes", "hub", "2026-11-12.md");
    assert.equal(readFileSync(kept, "utf8"), afterFirst);
    assert.match(readFileSync(path, "utf8"), /report again - acme/);
  });

  it("snapshots a session trail file before the block is upserted", () => {
    const day = brain.localDate();
    const sessions = put(`fontes/sessions/${day}.md`, "---\nupdated: 2026-01-01\n---\n\n# Sessions\n");
    const original = readFileSync(sessions, "utf8");
    brain.upsertSessionBlock(sessions, "s-1", day, "<!-- session:s-1 START -->\nline\n<!-- session:s-1 END -->", vault);
    assert.equal(readFileSync(join(snapshotsDir, day, "fontes", "sessions", `${day}.md`), "utf8"), original);
    assert.match(readFileSync(sessions, "utf8"), /session:s-1 START/);
  });

  it("does not block the writes when the snapshot fails", () => {
    writeFileSync(snapshotsDir, "not a folder");
    try {
      const today = brain.localDate();
      put(`daily/${today}.md`, "before\n");
      daily.writeDaily(settingsFor(), today, "after\n");
      assert.equal(readFileSync(join(vault, "daily", `${today}.md`), "utf8"), "after\n");
      const hub = brain.appendHubSource(vault, "first", new Date());
      brain.appendHubSource(vault, "still written", new Date());
      assert.match(readFileSync(hub, "utf8"), /still written/);
    } finally {
      rmSync(snapshotsDir, { force: true });
    }
  });

  it("only copies: the source file and its mtime stay untouched", () => {
    const file = put("projects/globex.md", "stable\n");
    const old = new Date(2026, 0, 1);
    utimesSync(file, old, old);
    const mtime = statSync(file).mtimeMs;
    snapshot.snapshotVaultFile(vault, file, noon);
    assert.equal(readFileSync(file, "utf8"), "stable\n");
    assert.equal(statSync(file).mtimeMs, mtime);
  });
});
