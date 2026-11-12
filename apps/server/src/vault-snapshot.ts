import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OUTSIDE_DIR = "_outside";
export const SNAPSHOT_RETENTION_DAYS = 14;

let snapshotsRoot: string | null = null;

export function enableVaultSnapshots(dir: string | null): void {
  snapshotsRoot = dir;
}

export function vaultSnapshotsDir(): string | null {
  return snapshotsRoot;
}

export function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function snapshotName(root: string | null, file: string): string {
  if (root) {
    const rel = relative(root, file);
    if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  return join(OUTSIDE_DIR, file.replace(/[:\\/]+/g, "_").replace(/^_+/, ""));
}

export function snapshotVaultFile(root: string | null, file: string, now = new Date()): string | null {
  if (!snapshotsRoot) return null;
  try {
    if (!existsSync(file)) return null;
    const target = join(snapshotsRoot, localDay(now), snapshotName(root, file));
    if (existsSync(target)) return null;
    mkdirSync(dirname(target), { recursive: true });
    try {
      copyFileSync(file, target, constants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw err;
    }
    return target;
  } catch (err) {
    console.error(`vault snapshot failed for ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function snapshotDayFolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && DAY_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function snapshotDayCount(dir = snapshotsRoot): number {
  return dir ? snapshotDayFolders(dir).length : 0;
}

export function pruneVaultSnapshots(now = new Date(), days = SNAPSHOT_RETENTION_DAYS, dir = snapshotsRoot): string[] {
  if (!dir) return [];
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  const limit = localDay(cutoff);
  const removed: string[] = [];
  for (const name of snapshotDayFolders(dir)) {
    if (name >= limit) continue;
    try {
      const target = join(dir, name);
      if (!statSync(target).isDirectory()) continue;
      rmSync(target, { recursive: true, force: true });
      removed.push(name);
    } catch (err) {
      console.error(`vault snapshot prune failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return removed;
}

