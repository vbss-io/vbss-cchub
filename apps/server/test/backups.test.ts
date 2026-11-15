import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync, closeSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { freePort, makeSandbox, serverDir, startServer, waitFor, type RunningServer } from "./helpers.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-backups-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;

function removePath(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
}

type Backups = typeof import("../src/backups.js");
let backups: Backups;

const dbPath = join(dataDir, "hub.db");
const backupsDir = join(dataDir, "backups");
const base = new Date(2026, 10, 12, 8, 0, 0);
const at = (minutes: number): Date => new Date(base.getTime() + minutes * 60_000);

before(async () => {
  backups = await import("../src/backups.js");
});

after(() => {
  removePath(dataDir);
});

function seedDb(path: string, rows: string[], wal = true): void {
  const db = new Database(path);
  if (wal) db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO notes (body) VALUES (?)");
  for (const row of rows) insert.run(row);
  db.close();
}

function bodies(path: string): string[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT body FROM notes ORDER BY id").all() as { body: string }[]).map((row) => row.body);
  } finally {
    db.close();
  }
}

function resetData(): void {
  backups.resetBackupError();
  removePath(backupsDir);
  for (const name of ["hub.db", "hub.db-wal", "hub.db-shm"]) removePath(join(dataDir, name));
}

beforeEach(resetData);

describe("backupDatabase", () => {
  it("writes hub-<stamp>-<reason>.db in the backups folder with the current rows", async () => {
    seedDb(dbPath, ["Acme invoice", "Globex contract"]);
    const entry = await backups.backupDatabase("manual", at(0));
    assert.equal(entry.file, "hub-20261112-080000-manual.db");
    assert.equal(entry.reason, "manual");
    assert.equal(entry.createdAt, at(0).getTime());
    assert.ok(entry.size > 0);
    assert.deepEqual(bodies(join(backupsDir, entry.file)), ["Acme invoice", "Globex contract"]);
    assert.deepEqual(readdirSync(backupsDir).filter((name) => name.endsWith(".db")), [entry.file]);
  });

  it("captures rows that still live in the WAL of an open connection", async () => {
    seedDb(dbPath, ["checkpointed"]);
    const live = new Database(dbPath);
    live.pragma("journal_mode = WAL");
    live.pragma("wal_autocheckpoint = 0");
    live.prepare("INSERT INTO notes (body) VALUES (?)").run("only in wal");
    try {
      const entry = await backups.backupDatabase("manual", at(0));
      assert.deepEqual(bodies(join(backupsDir, entry.file)), ["checkpointed", "only in wal"]);
    } finally {
      live.close();
    }
  });

  it("never collides when two backups land in the same second", async () => {
    seedDb(dbPath, ["x"]);
    const first = await backups.backupDatabase("manual", at(0));
    const second = await backups.backupDatabase("manual", at(0));
    assert.notEqual(first.file, second.file);
    assert.equal(backups.listBackups().length, 2);
  });

  it("lists newest first and ignores unrelated files", async () => {
    seedDb(dbPath, ["x"]);
    await backups.backupDatabase("daily", at(0));
    await backups.backupDatabase("manual", at(30));
    await backups.backupDatabase("upgrade", at(10));
    writeFileSync(join(backupsDir, "last-version"), "1.0.0\n");
    writeFileSync(join(backupsDir, "notes.txt"), "x");
    const list = backups.listBackups();
    assert.deepEqual(
      list.map((entry) => entry.reason),
      ["manual", "upgrade", "daily"],
    );
    assert.ok(list.every((entry, index) => index === 0 || (list[index - 1] as { createdAt: number }).createdAt >= entry.createdAt));
  });

  it("rotates each reason on its own: 5 upgrade, 7 daily, 10 manual, 5 pre-restore", async () => {
    seedDb(dbPath, ["x"]);
    const limits = { upgrade: 5, daily: 7, manual: 10, "pre-restore": 5 } as const;
    for (const reason of backups.BACKUP_REASONS) {
      for (let index = 0; index < limits[reason] + 3; index += 1) await backups.backupDatabase(reason, at(index));
    }
    const list = backups.listBackups();
    for (const reason of backups.BACKUP_REASONS) {
      const own = list.filter((entry) => entry.reason === reason);
      assert.equal(own.length, limits[reason], reason);
      assert.equal(own[0]?.createdAt, at(limits[reason] + 2).getTime(), `${reason} keeps the newest`);
      assert.equal(own.at(-1)?.createdAt, at(3).getTime(), `${reason} drops the oldest`);
    }
    assert.deepEqual(backups.BACKUP_RETENTION, limits);
  });

  it("records the failure, leaves no partial file and rethrows", async () => {
    await assert.rejects(backups.backupDatabase("manual", at(0)));
    assert.equal(backups.lastBackupError()?.at, at(0).getTime());
    assert.ok((backups.lastBackupError()?.message ?? "").length > 0);
    assert.deepEqual(readdirSync(backupsDir), []);
  });

  it("detects whether the daily backup of the local day exists", async () => {
    seedDb(dbPath, ["x"]);
    assert.equal(backups.dailyBackupDue(at(0)), true);
    await backups.backupDatabase("manual", at(0));
    assert.equal(backups.dailyBackupDue(at(0)), true);
    await backups.backupDatabase("daily", at(1));
    assert.equal(backups.dailyBackupDue(at(5)), false);
    assert.equal(backups.dailyBackupDue(new Date(2026, 10, 13, 0, 5, 0)), true);
  });

  it("runs the daily backup once per day through the maintenance pass", async () => {
    seedDb(dbPath, ["x"]);
    await backups.runDailyMaintenance(at(0));
    await backups.runDailyMaintenance(at(120));
    assert.equal(backups.listBackups().filter((entry) => entry.reason === "daily").length, 1);
    await backups.runDailyMaintenance(new Date(2026, 10, 13, 0, 5, 0));
    assert.equal(backups.listBackups().filter((entry) => entry.reason === "daily").length, 2);
  });
});

describe("upgrade backup", () => {
  it("backs up once per version change and stays quiet when the version is unchanged", () => {
    seedDb(dbPath, ["before upgrade"]);
    const first = backups.upgradeBackupIfNeeded("1.4.0", at(0));
    assert.ok(first);
    assert.equal(first.reason, "upgrade");
    assert.deepEqual(bodies(join(backupsDir, first.file)), ["before upgrade"]);
    backups.recordAppVersion("1.4.0");
    assert.equal(readFileSync(join(backupsDir, "last-version"), "utf8").trim(), "1.4.0");
    assert.equal(backups.upgradeBackupIfNeeded("1.4.0", at(1)), null);
    assert.equal(backups.listBackups().filter((entry) => entry.reason === "upgrade").length, 1);
    const next = backups.upgradeBackupIfNeeded("1.5.0", at(2));
    assert.ok(next);
    backups.recordAppVersion("1.5.0");
    assert.equal(backups.listBackups().filter((entry) => entry.reason === "upgrade").length, 2);
  });

  it("does nothing on a fresh install without a database", () => {
    assert.equal(backups.upgradeBackupIfNeeded("1.4.0", at(0)), null);
    assert.equal(existsSync(backupsDir), false);
  });

  it("logs and records an unreadable database instead of throwing", () => {
    writeFileSync(dbPath, "this is not a database");
    assert.equal(backups.upgradeBackupIfNeeded("1.4.0", at(0)), null);
    assert.equal(backups.lastBackupError()?.at, at(0).getTime());
    assert.deepEqual(backups.listBackups(), []);
  });

  it("does not record the version after a failed upgrade backup, so the next boot retries it", () => {
    writeFileSync(dbPath, "this is not a database");
    assert.equal(backups.upgradeBackupIfNeeded("1.4.0", at(0)), null);
    backups.recordAppVersion("1.4.0");
    assert.equal(existsSync(join(backupsDir, "last-version")), false);
    removePath(dbPath);
    seedDb(dbPath, ["after the fix"]);
    const retry = backups.upgradeBackupIfNeeded("1.4.0", at(1));
    assert.ok(retry);
    assert.deepEqual(bodies(join(backupsDir, retry.file)), ["after the fix"]);
    backups.recordAppVersion("1.4.0");
    assert.equal(readFileSync(join(backupsDir, "last-version"), "utf8").trim(), "1.4.0");
  });

  it("still records a version other than the one whose upgrade backup failed", () => {
    writeFileSync(dbPath, "this is not a database");
    backups.upgradeBackupIfNeeded("1.5.0", at(0));
    backups.recordAppVersion("1.4.0");
    assert.equal(readFileSync(join(backupsDir, "last-version"), "utf8").trim(), "1.4.0");
  });

  it("keeps a failed upgrade backup visible after a later successful daily backup and clears it once the upgrade backup succeeds", async () => {
    writeFileSync(dbPath, "this is not a database");
    assert.equal(backups.upgradeBackupIfNeeded("1.4.0", at(0)), null);
    removePath(dbPath);
    seedDb(dbPath, ["x"]);
    await backups.backupDatabase("daily", at(1));
    const afterDaily = backups.backupsSummary().lastError;
    assert.equal(afterDaily?.at, at(0).getTime());
    assert.match(afterDaily?.message ?? "", /^upgrade backup failed: /);
    assert.ok(backups.upgradeBackupIfNeeded("1.4.0", at(2)));
    assert.equal(backups.backupsSummary().lastError, null);
  });

  it("reports the most recent unresolved error across reasons", async () => {
    writeFileSync(dbPath, "this is not a database");
    backups.upgradeBackupIfNeeded("1.4.0", at(0));
    await assert.rejects(backups.backupDatabase("manual", at(1)));
    assert.equal(backups.lastBackupError()?.at, at(1).getTime());
    assert.match(backups.lastBackupError()?.message ?? "", /^manual backup failed: /);
    removePath(dbPath);
    seedDb(dbPath, ["x"]);
    await backups.backupDatabase("manual", at(2));
    assert.equal(backups.lastBackupError()?.at, at(0).getTime());
    assert.match(backups.lastBackupError()?.message ?? "", /^upgrade backup failed: /);
  });

  it("summarizes backups, last error and folders for the UI", () => {
    seedDb(dbPath, ["x"]);
    backups.upgradeBackupIfNeeded("1.4.0", at(0));
    const summary = backups.backupsSummary();
    assert.equal(summary.backups.length, 1);
    assert.equal(summary.lastError, null);
    assert.equal(summary.backupsDir, backupsDir);
    assert.equal(summary.snapshotsDir, join(dataDir, "vault-snapshots"));
    assert.equal(summary.snapshotDays, 0);
  });
});

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(serverDir, "src", "cli.ts"), ...args], {
      cwd: serverDir,
      env: { ...process.env, HUB_DATA_DIR: dataDir, HUB_SECOND_BRAIN: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function closedHubUrl(): Promise<string> {
  return `http://127.0.0.1:${await freePort()}`;
}

function corruptMiddle(path: string): void {
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, 4096 * 2);
  } finally {
    closeSync(fd);
  }
}

function bigDb(path: string): void {
  const db = new Database(path);
  db.pragma("journal_mode = DELETE");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE INDEX notes_body ON notes(body)");
  const insert = db.prepare("INSERT INTO notes (body) VALUES (?)");
  db.transaction(() => {
    for (let index = 0; index < 2000; index += 1) insert.run(`Acme note ${index} ${"x".repeat(40)}`);
  })();
  db.close();
}

describe("restore-db", () => {
  let fakeHub: Server;
  let fakeHubUrl = "";

  before(async () => {
    fakeHub = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(req.url === "/api/health" ? '{"ok":true,"hostname":"test"}' : "{}");
    });
    await new Promise<void>((resolve) => fakeHub.listen(0, "127.0.0.1", resolve));
    const address = fakeHub.address();
    fakeHubUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  after(() => {
    fakeHub.close();
  });

  it("refuses while the hub answers and leaves the database alone", async () => {
    seedDb(dbPath, ["current"]);
    const source = join(dataDir, "source.db");
    removePath(source);
    seedDb(source, ["from backup"], false);
    const result = await runCli(["restore-db", source], { HUB_URL: fakeHubUrl });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /hub is running/);
    assert.deepEqual(bodies(dbPath), ["current"]);
    assert.equal(existsSync(backupsDir), false);
  });

  it("rejects a file that is not a database", async () => {
    seedDb(dbPath, ["current"]);
    const bogus = join(dataDir, "bogus.db");
    writeFileSync(bogus, "plain text, not sqlite");
    const result = await runCli(["restore-db", bogus], { HUB_URL: await closedHubUrl() });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /integrity_check failed|not a readable SQLite database/);
    assert.deepEqual(bodies(dbPath), ["current"]);
    assert.equal(existsSync(backupsDir), false);
  });

  it("rejects a corrupted database through integrity_check", async () => {
    seedDb(dbPath, ["current"]);
    const damaged = join(dataDir, "damaged.db");
    removePath(damaged);
    bigDb(damaged);
    assert.equal(backups.integrityCheck(damaged), "ok");
    corruptMiddle(damaged);
    assert.notEqual(backups.integrityCheck(damaged), "ok");
    const result = await runCli(["restore-db", damaged], { HUB_URL: await closedHubUrl() });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /integrity_check failed/);
    assert.deepEqual(bodies(dbPath), ["current"]);
    assert.equal(existsSync(backupsDir), false);
  });

  it("fails clearly when the file does not exist", async () => {
    const result = await runCli(["restore-db", join(dataDir, "missing.db")], { HUB_URL: await closedHubUrl() });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not found/);
  });

  it("asks for the file when none is given", async () => {
    const result = await runCli(["restore-db"], { HUB_URL: await closedHubUrl() });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /usage: restore-db/);
  });

  it("makes a pre-restore backup, replaces hub.db and removes the stale sidecars", async () => {
    seedDb(dbPath, ["current Acme", "current Globex"]);
    const source = join(dataDir, "good.db");
    removePath(source);
    seedDb(source, ["restored Initech"], false);
    writeFileSync(`${dbPath}-wal`, "");
    writeFileSync(`${dbPath}-shm`, "");
    const result = await runCli(["restore-db", source], { HUB_URL: await closedHubUrl() });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(bodies(dbPath), ["restored Initech"]);
    const [pre] = backups.listBackups();
    assert.equal(pre?.reason, "pre-restore");
    assert.deepEqual(bodies(join(backupsDir, pre?.file ?? "")), ["current Acme", "current Globex"]);
    assert.equal(existsSync(`${dbPath}-wal`), false);
    assert.equal(existsSync(`${dbPath}-shm`), false);
    assert.match(result.stdout, /restored .*good\.db/);
    assert.match(result.stdout, /previous database saved as hub-\d{8}-\d{6}-pre-restore\.db/);
    assert.deepEqual(readdirSync(dataDir).filter((name) => name.endsWith(".partial")), []);
  });

  it("restores when there is no current database and makes no pre-restore backup", async () => {
    const source = join(dataDir, "good2.db");
    removePath(source);
    seedDb(source, ["restored Alex"], false);
    const result = await runCli(["restore-db", source], { HUB_URL: await closedHubUrl() });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(bodies(dbPath), ["restored Alex"]);
    assert.deepEqual(backups.listBackups(), []);
    assert.match(result.stdout, /no previous database to save/);
  });
});

describe("backup routes", () => {
  let hub: RunningServer;
  let routeData = "";

  before(async () => {
    const box = makeSandbox("cch-backup-routes-");
    routeData = box.dataDir;
    hub = await startServer(box, { HUB_DELEGATION: "1" });
  });

  after(async () => {
    const exited = new Promise<void>((resolve) => hub.child.once("exit", () => resolve()));
    hub.child.kill();
    await exited;
  });

  const call = async (method: string, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${hub.base}/delegation/backups`, { method, headers });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("records the app version once the server booted", async () => {
    const list = await call("GET");
    assert.equal(list.status, 200);
    assert.equal(existsSync(join(routeData, "backups", "last-version")), true);
  });

  it("GET returns the documented shape", async () => {
    const { status, json } = await call("GET");
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(json).sort(), ["backups", "backupsDir", "lastError", "snapshotDays", "snapshotsDir"]);
    assert.ok(Array.isArray(json.backups));
    assert.equal(json.lastError, null);
    assert.equal(json.backupsDir, join(routeData, "backups"));
    assert.equal(json.snapshotsDir, join(routeData, "vault-snapshots"));
    assert.equal(typeof json.snapshotDays, "number");
  });

  it("POST creates a manual backup and answers 201 with the item", async () => {
    const created = await call("POST");
    assert.equal(created.status, 201);
    const backup = created.json.backup as Record<string, unknown>;
    assert.deepEqual(Object.keys(backup).sort(), ["createdAt", "file", "reason", "size"]);
    assert.equal(backup.reason, "manual");
    assert.match(String(backup.file), /^hub-\d{8}-\d{6}-manual\.db$/);
    assert.equal(typeof backup.createdAt, "number");
    assert.ok(Number(backup.size) > 0);
    assert.ok(existsSync(join(routeData, "backups", String(backup.file))));
    const list = await call("GET");
    const first = (list.json.backups as Record<string, unknown>[])[0];
    assert.deepEqual(first, backup);
  });

  it("applies the same origin guard as the other delegation routes", async () => {
    const blocked = await call("POST", { Origin: "http://evil.example" });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error, "origin not allowed");
    const trusted = await call("GET", { Origin: "http://tauri.localhost" });
    assert.equal(trusted.status, 200);
  });

  it("is hidden while delegation is off", async () => {
    const box = makeSandbox("cch-backup-off-");
    const off = await startServer(box, {});
    try {
      const res = await fetch(`${off.base}/delegation/backups`);
      assert.equal(res.status, 404);
    } finally {
      const exited = new Promise<void>((resolve) => off.child.once("exit", () => resolve()));
      off.child.kill();
      await exited;
    }
  });
});

describe("boot upgrade backup", () => {
  async function boot(box: ReturnType<typeof makeSandbox>): Promise<void> {
    const hub = await startServer(box, { HUB_DELEGATION: "1" });
    const exited = new Promise<void>((resolve) => hub.child.once("exit", () => resolve()));
    await waitFor(async () => ((await fetch(`${hub.base}/api/health`)).ok ? true : null), 5000);
    hub.child.kill();
    await exited;
  }

  it("backs up the database as it was before the migrations, only when the version changes", async () => {
    const box = makeSandbox("cch-boot-");
    mkdirSync(box.dataDir, { recursive: true });
    const legacy = new Database(join(box.dataDir, "hub.db"));
    legacy.exec("CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY)");
    legacy.close();
    const dir = join(box.dataDir, "backups");

    await boot(box);
    const afterFirst = readdirSync(dir).filter((name) => name.endsWith("-upgrade.db"));
    assert.equal(afterFirst.length, 1);
    const snapshot = new Database(join(dir, afterFirst[0] as string), { readonly: true });
    const tables = (snapshot.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    snapshot.close();
    assert.deepEqual(tables, ["legacy_marker"]);
    assert.match(readFileSync(join(dir, "last-version"), "utf8"), /^\d+\.\d+\.\d+/);

    await boot(box);
    assert.equal(readdirSync(dir).filter((name) => name.endsWith("-upgrade.db")).length, 1);

    writeFileSync(join(dir, "last-version"), "0.0.1\n");
    await boot(box);
    assert.equal(readdirSync(dir).filter((name) => name.endsWith("-upgrade.db")).length, 2);
    assert.equal(readFileSync(join(dir, "last-version"), "utf8").trim(), JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8")).version);
  });
});
