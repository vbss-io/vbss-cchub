import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { localDay, pruneVaultSnapshots, snapshotDayCount, vaultSnapshotsDir } from "./vault-snapshot.js";

export const BACKUP_REASONS = ["upgrade", "daily", "manual", "pre-restore"] as const;
export type BackupReason = (typeof BACKUP_REASONS)[number];

export interface BackupEntry {
  file: string;
  reason: BackupReason;
  createdAt: number;
  size: number;
}

export interface BackupError {
  at: number;
  message: string;
}

export interface BackupsSummary {
  backups: BackupEntry[];
  lastError: BackupError | null;
  backupsDir: string;
  snapshotsDir: string;
  snapshotDays: number;
}

export const BACKUP_RETENTION: Record<BackupReason, number> = {
  upgrade: 5,
  daily: 7,
  manual: 10,
  "pre-restore": 5,
};

const NAME_RE = /^hub-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(upgrade|daily|manual|pre-restore)\.db$/;
const VERSION_FILE = "last-version";
const PARTIAL_SUFFIX = ".partial";

const errorsByReason = new Map<BackupReason, BackupError>();
let failedUpgradeVersion: string | null = null;

export function backupsDir(): string {
  return join(config.dataDir, "backups");
}

export function lastBackupError(): BackupError | null {
  let latest: BackupError | null = null;
  for (const error of errorsByReason.values()) {
    if (latest === null || error.at >= latest.at) latest = error;
  }
  return latest;
}

export function resetBackupError(): void {
  errorsByReason.clear();
  failedUpgradeVersion = null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recordError(reason: BackupReason, err: unknown, now: Date): void {
  const error = { at: now.getTime(), message: `${reason} backup failed: ${messageOf(err)}` };
  errorsByReason.set(reason, error);
  console.error(`database ${error.message}`);
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

function stampOf(when: Date): string {
  const date = `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}`;
  return `${date}-${two(when.getHours())}${two(when.getMinutes())}${two(when.getSeconds())}`;
}

function fileNameFor(reason: BackupReason, now: Date, dir: string): string {
  for (let offset = 0; ; offset += 1) {
    const name = `hub-${stampOf(new Date(now.getTime() + offset * 1000))}-${reason}.db`;
    if (!existsSync(join(dir, name))) return name;
  }
}

function parseEntry(dir: string, name: string): BackupEntry | null {
  const match = NAME_RE.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, reason] = match;
  try {
    const size = statSync(join(dir, name)).size;
    const createdAt = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)).getTime();
    return { file: name, reason: reason as BackupReason, createdAt, size };
  } catch {
    return null;
  }
}

export function listBackups(dir = backupsDir()): BackupEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => parseEntry(dir, name))
    .filter((entry): entry is BackupEntry => entry !== null)
    .sort((a, b) => b.createdAt - a.createdAt || (a.file < b.file ? 1 : -1));
}

export function rotateBackups(reason: BackupReason, dir = backupsDir()): string[] {
  const removed: string[] = [];
  const stale = listBackups(dir)
    .filter((entry) => entry.reason === reason)
    .slice(BACKUP_RETENTION[reason]);
  for (const entry of stale) {
    try {
      rmSync(join(dir, entry.file), { force: true });
      removed.push(entry.file);
    } catch (err) {
      console.error(`backup rotation failed for ${entry.file}: ${messageOf(err)}`);
    }
  }
  return removed;
}

interface Reserved {
  dir: string;
  name: string;
  finalPath: string;
  tmpPath: string;
}

function reserve(reason: BackupReason, now: Date): Reserved {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  const name = fileNameFor(reason, now, dir);
  const finalPath = join(dir, name);
  const tmpPath = `${finalPath}${PARTIAL_SUFFIX}`;
  rmSync(tmpPath, { force: true });
  return { dir, name, finalPath, tmpPath };
}

function complete(reserved: Reserved, reason: BackupReason): BackupEntry {
  renameSync(reserved.tmpPath, reserved.finalPath);
  rotateBackups(reason, reserved.dir);
  const entry = parseEntry(reserved.dir, reserved.name);
  if (!entry) throw new Error("backup file missing after write");
  errorsByReason.delete(reason);
  return entry;
}

function discard(reserved: Reserved | null): void {
  if (reserved) rmSync(reserved.tmpPath, { force: true });
}

function openSource(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

export async function backupDatabase(reason: BackupReason, now = new Date()): Promise<BackupEntry> {
  let reserved: Reserved | null = null;
  try {
    reserved = reserve(reason, now);
    const source = openSource(config.dbPath);
    try {
      await source.backup(reserved.tmpPath);
    } finally {
      source.close();
    }
    return complete(reserved, reason);
  } catch (err) {
    discard(reserved);
    recordError(reason, err, now);
    throw err;
  }
}

function backupDatabaseSync(reason: BackupReason, now: Date): BackupEntry {
  let reserved: Reserved | null = null;
  try {
    reserved = reserve(reason, now);
    const source = openSource(config.dbPath);
    try {
      source.prepare("VACUUM INTO ?").run(reserved.tmpPath);
    } finally {
      source.close();
    }
    return complete(reserved, reason);
  } catch (err) {
    discard(reserved);
    recordError(reason, err, now);
    throw err;
  }
}

function versionPath(): string {
  return join(backupsDir(), VERSION_FILE);
}

function readRecordedVersion(): string | null {
  try {
    return readFileSync(versionPath(), "utf8").trim();
  } catch {
    return null;
  }
}

export function upgradeBackupIfNeeded(version: string, now = new Date()): BackupEntry | null {
  if (!existsSync(config.dbPath)) return null;
  if (readRecordedVersion() === version) return null;
  try {
    const entry = backupDatabaseSync("upgrade", now);
    failedUpgradeVersion = null;
    return entry;
  } catch {
    failedUpgradeVersion = version;
    return null;
  }
}

export function recordAppVersion(version: string): void {
  if (failedUpgradeVersion === version) return;
  try {
    if (readRecordedVersion() === version) return;
    mkdirSync(backupsDir(), { recursive: true });
    writeFileSync(versionPath(), `${version}\n`);
  } catch (err) {
    console.error(`could not record app version: ${messageOf(err)}`);
  }
}

export function dailyBackupDue(now = new Date(), dir = backupsDir()): boolean {
  const today = localDay(now);
  return !listBackups(dir).some((entry) => entry.reason === "daily" && localDay(new Date(entry.createdAt)) === today);
}

export async function runDailyMaintenance(now = new Date()): Promise<void> {
  if (dailyBackupDue(now)) await backupDatabase("daily", now).catch(() => undefined);
  pruneVaultSnapshots(now);
}

export function backupsSummary(): BackupsSummary {
  const snapshotsDir = vaultSnapshotsDir() ?? join(config.dataDir, "vault-snapshots");
  return {
    backups: listBackups(),
    lastError: lastBackupError(),
    backupsDir: backupsDir(),
    snapshotsDir,
    snapshotDays: snapshotDayCount(snapshotsDir),
  };
}

export interface RestoreResult {
  source: string;
  target: string;
  preRestore: BackupEntry | null;
  removedSidecars: string[];
}

export function integrityCheck(file: string): string {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db.pragma("integrity_check") as { integrity_check: string }[];
    return rows.map((row) => row.integrity_check).join("; ");
  } catch (err) {
    return messageOf(err);
  } finally {
    db.close();
  }
}

function preRestoreBackup(now: Date): BackupEntry {
  try {
    return backupDatabaseSync("pre-restore", now);
  } catch {
    const reserved = reserve("pre-restore", now);
    try {
      copyFileSync(config.dbPath, reserved.tmpPath);
      return complete(reserved, "pre-restore");
    } catch (err) {
      discard(reserved);
      throw new Error(`could not back up the current database, restore aborted: ${messageOf(err)}`);
    }
  }
}

export function restoreDatabase(sourceFile: string, now = new Date()): RestoreResult {
  if (!existsSync(sourceFile)) throw new Error(`backup file not found: ${sourceFile}`);
  let verdict: string;
  try {
    verdict = integrityCheck(sourceFile);
  } catch (err) {
    throw new Error(`${sourceFile} is not a readable SQLite database: ${messageOf(err)}`);
  }
  if (verdict !== "ok") throw new Error(`integrity_check failed for ${sourceFile}: ${verdict}`);
  mkdirSync(config.dataDir, { recursive: true });
  const preRestore = existsSync(config.dbPath) ? preRestoreBackup(now) : null;
  const staged = `${config.dbPath}.restore-${process.pid}${PARTIAL_SUFFIX}`;
  try {
    copyFileSync(sourceFile, staged);
    const copyVerdict = integrityCheck(staged);
    if (copyVerdict !== "ok") throw new Error(`copy failed integrity_check: ${copyVerdict}`);
  } catch (err) {
    rmSync(staged, { force: true });
    throw err;
  }
  const removedSidecars: string[] = [];
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${config.dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      rmSync(sidecar, { force: true });
      removedSidecars.push(sidecar);
    }
  }
  renameSync(staged, config.dbPath);
  return { source: sourceFile, target: config.dbPath, preRestore, removedSidecars };
}
