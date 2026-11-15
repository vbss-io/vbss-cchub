import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, open, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { snapshotVaultFile } from "./vault-snapshot.js";

const MAX_CHARS = 6_000;
const LOCK_RETRIES = 60;
const LOCK_DELAY_MS = 100;
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_RETRY_BACKOFF_MS = 1000;
const LOCK_RETRY_BACKOFF_MAX_MS = 60_000;
const WRITE_MAX_FAILURES = 5;
const HUB_HEADING_RE = /^## Hub[ \t]*$/m;
const BULLET_RE = /^- (.+)$/;

export interface TrailLink {
  dir: string;
  unified: boolean;
}

type TrailResolver = (root: string) => TrailLink | null;

let trailResolver: TrailResolver | null = null;

export function registerTrailResolver(resolver: TrailResolver | null): void {
  trailResolver = resolver;
}

function resolveTrail(root: string, link: TrailLink | null | undefined): TrailLink | null {
  return link === undefined ? (trailResolver?.(root) ?? null) : link;
}

export function localDate(now = new Date()): string {
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export const localTime = (now = new Date()): string =>
  `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

export function diaryPath(root: string, date: string): string | null {
  const flat = join(root, "diario", `${date}.md`);
  if (existsSync(flat)) return flat;
  const archived = join(root, "diario", date.slice(0, 7), `${date}.md`);
  return existsSync(archived) ? archived : null;
}

export function hubSourcePath(root: string, date: string): string {
  return join(root, "fontes", "hub", `${date}.md`);
}

const capText = (text: string): string => (text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…(truncated)` : text);

function readCapped(path: string): string {
  return capText(readFileSync(path, "utf8"));
}

export function trailFilePath(dir: string, date: string): string {
  return join(dir, `${date}.md`);
}

export function trailHeader(date: string): string {
  return `---\ntype: fonte\ncreated: ${date}\nupdated: ${date}\ntags: [fonte, session]\n---\n\n# Sessions — ${date}\n`;
}

export class LockTimeoutError extends Error {
  constructor(lockFile: string) {
    super(`could not acquire lock: ${lockFile}`);
  }
}

export async function withFileLock<T>(target: string, fn: () => T): Promise<T> {
  const lockFile = `${target}.lock`;
  await mkdir(dirname(target), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    let handle: FileHandle;
    try {
      handle = await open(lockFile, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - (await stat(lockFile)).mtimeMs > LOCK_STALE_MS) {
          await unlink(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      await delay(LOCK_DELAY_MS);
      continue;
    }
    try {
      await handle.write(String(process.pid));
    } finally {
      await handle.close();
    }
    try {
      return fn();
    } finally {
      await unlink(lockFile).catch(() => undefined);
    }
  }
  throw new LockTimeoutError(lockFile);
}

interface WriteJob {
  file: string;
  apply: () => void;
  resolve: () => void;
  reject: (err: unknown) => void;
  failures: number;
}

const writeQueue: WriteJob[] = [];
let pumping = false;
let writeIdleWaiters: (() => void)[] = [];
let lockFailureLogged = false;

async function pumpWrites(): Promise<void> {
  if (pumping) return;
  pumping = true;
  let backoff = 0;
  try {
    while (writeQueue.length > 0) {
      const job = writeQueue[0]!;
      try {
        await withFileLock(job.file, job.apply);
        writeQueue.shift();
        job.resolve();
        backoff = 0;
        lockFailureLogged = false;
      } catch (err) {
        if (err instanceof LockTimeoutError) {
          if (!lockFailureLogged) console.error(`second brain write waiting on a foreign lock, will retry: ${err.message}`);
          lockFailureLogged = true;
          backoff = Math.min(backoff > 0 ? backoff * 2 : LOCK_RETRY_BACKOFF_MS, LOCK_RETRY_BACKOFF_MAX_MS);
          await delay(backoff);
          continue;
        }
        job.failures++;
        if (job.failures >= WRITE_MAX_FAILURES) {
          writeQueue.shift();
          job.reject(err);
        } else {
          await delay(LOCK_DELAY_MS);
        }
      }
    }
  } finally {
    pumping = false;
    const waiters = writeIdleWaiters;
    writeIdleWaiters = [];
    for (const waiter of waiters) waiter();
  }
}

export function enqueueFileWrite(file: string, apply: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    writeQueue.push({ file, apply, resolve, reject, failures: 0 });
    void pumpWrites();
  });
}

export function whenBrainWritesIdle(): Promise<void> {
  if (!pumping && writeQueue.length === 0) return Promise.resolve();
  return new Promise((resolve) => writeIdleWaiters.push(resolve));
}

const blockMarkers = (sessionId: string): { start: string; end: string } => ({
  start: `<!-- session:${sessionId} START -->`,
  end: `<!-- session:${sessionId} END -->`,
});

function bulletsIn(text: string): string[] {
  const bullets: string[] = [];
  for (const line of text.split("\n")) {
    const match = BULLET_RE.exec(line);
    if (match?.[1]) bullets.push(match[1]);
  }
  return bullets;
}

export function readBlockBullets(content: string, sessionId: string): string[] {
  const { start, end } = blockMarkers(sessionId);
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return [];
  return bulletsIn(content.slice(startIdx + start.length, endIdx));
}

export function readAllBlockBullets(content: string): string[] {
  const blockRe = /<!-- session:(\S+) START -->([\s\S]*?)<!-- session:\1 END -->/g;
  return [...content.matchAll(blockRe)].flatMap((block) => bulletsIn(block[2] ?? ""));
}

export function countSessionBlocks(content: string): number {
  return (content.match(/<!-- session:\S+ START -->/g) ?? []).length;
}

export function hubSection(content: string): string | null {
  const match = HUB_HEADING_RE.exec(content);
  if (!match) return null;
  return content.slice(match.index + match[0].length).trim();
}

const touchUpdated = (content: string, date: string): string => content.replace(/^updated:.*$/m, `updated: ${date}`);

export interface BrainWriteOps {
  writeFileSync: (path: string, data: string, encoding: "utf8") => void;
  renameSync: (from: string, to: string) => void;
  copyFileSync: (from: string, to: string) => void;
  unlinkSync: (path: string) => void;
}

const nodeBrainOps: BrainWriteOps = { writeFileSync, renameSync, copyFileSync, unlinkSync };
const LOCK_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRIES = 3;

function isLockError(err: unknown): boolean {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  return code !== undefined && LOCK_ERROR_CODES.has(code);
}

function removeQuietly(path: string, ops: BrainWriteOps): void {
  try {
    ops.unlinkSync(path);
  } catch {
    return;
  }
}

function moveIntoPlace(tmpPath: string, target: string, ops: BrainWriteOps): void {
  for (let attempt = 0; attempt <= RENAME_RETRIES; attempt += 1) {
    try {
      ops.renameSync(tmpPath, target);
      return;
    } catch (err) {
      if (!isLockError(err)) throw err;
    }
  }
  ops.copyFileSync(tmpPath, target);
  removeQuietly(tmpPath, ops);
}

export function writeBrainFileAtomic(target: string, content: string, ops: BrainWriteOps = nodeBrainOps): void {
  const tmpPath = `${target}.${randomUUID()}.tmp`;
  try {
    ops.writeFileSync(tmpPath, content, "utf8");
    moveIntoPlace(tmpPath, target, ops);
  } catch (err) {
    removeQuietly(tmpPath, ops);
    throw err;
  }
}

const eolOf = (content: string): string => (content.includes("\r\n") ? "\r\n" : "\n");

const withEol = (text: string, eol: string): string => text.replace(/\r?\n/g, eol);

export function upsertSessionBlock(file: string, sessionId: string, date: string, block: string, root: string | null = null): void {
  let content = existsSync(file) ? readFileSync(file, "utf8") : trailHeader(date);
  const eol = eolOf(content);
  const piece = withEol(block, eol);
  const { start, end } = blockMarkers(sessionId);
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    content = content.slice(0, startIdx) + piece + content.slice(endIdx + end.length);
  } else {
    const hub = HUB_HEADING_RE.exec(content);
    if (hub) {
      content = `${content.slice(0, hub.index).trimEnd()}${eol}${eol}${piece}${eol}${eol}${content.slice(hub.index)}`;
    } else {
      if (!content.endsWith("\n")) content += eol;
      content += `${eol}${piece}${eol}`;
    }
  }
  snapshotVaultFile(root, file);
  writeBrainFileAtomic(file, touchUpdated(content, date));
}

export function queueSessionBlock(file: string, sessionId: string, date: string, block: string, root: string | null = null): Promise<void> {
  return enqueueFileWrite(file, () => {
    mkdirSync(dirname(file), { recursive: true });
    upsertSessionBlock(file, sessionId, date, block, root);
  });
}

function appendHubLine(file: string, date: string, line: string, root: string): void {
  let content = existsSync(file) ? readFileSync(file, "utf8") : trailHeader(date);
  const eol = eolOf(content);
  if (!content.endsWith("\n")) content += eol;
  if (!HUB_HEADING_RE.test(content)) content += `${eol}## Hub${eol}${eol}`;
  snapshotVaultFile(root, file);
  writeBrainFileAtomic(file, touchUpdated(`${content}${line}${eol}`, date));
}

export function appendHubSource(root: string, text: string, now = new Date(), link?: TrailLink | null): string {
  const date = localDate(now);
  const clean = text.replace(/\s*\n\s*/g, " ").trim();
  const resolved = resolveTrail(root, link);
  if (resolved?.unified) {
    const file = trailFilePath(resolved.dir, date);
    const line = `- ${localTime(now)} · ${clean}`;
    enqueueFileWrite(file, () => {
      mkdirSync(dirname(file), { recursive: true });
      appendHubLine(file, date, line, root);
    }).catch((err: unknown) => console.error(`second brain hub line dropped: ${String(err)}`));
    return file;
  }
  const path = hubSourcePath(root, date);
  mkdirSync(join(root, "fontes", "hub"), { recursive: true });
  snapshotVaultFile(root, path, now);
  if (!existsSync(path)) {
    writeFileSync(
      path,
      `---\ntype: fonte\ncreated: ${date}\nupdated: ${date}\ntags: [fonte, hub]\n---\n\n# Hub — ${date}\n\n`,
    );
  }
  appendFileSync(path, `- ${localTime(now)} · ${clean}\n`);
  return path;
}

export interface BrainToday {
  root: string;
  date: string;
  diaryPath: string | null;
  diary: string | null;
  hubPath: string | null;
  hub: string | null;
  sessionsPath: string | null;
  sessions: string | null;
}

export function brainToday(root: string, now = new Date(), link?: TrailLink | null): BrainToday {
  const date = localDate(now);
  const diary = diaryPath(root, date);
  const resolved = resolveTrail(root, link);
  if (resolved) {
    const file = trailFilePath(resolved.dir, date);
    const content = existsSync(file) ? readFileSync(file, "utf8") : null;
    const section = resolved.unified && content !== null ? hubSection(content) : null;
    const legacyHub = hubSourcePath(root, date);
    const legacy = !resolved.unified && existsSync(legacyHub);
    return {
      root,
      date,
      diaryPath: diary,
      diary: diary ? readCapped(diary) : null,
      hubPath: legacy ? legacyHub : section !== null ? file : null,
      hub: legacy ? readCapped(legacyHub) : section !== null ? capText(section) : null,
      sessionsPath: content !== null ? file : null,
      sessions: content !== null ? capText(content) : null,
    };
  }
  const hub = hubSourcePath(root, date);
  const sessions = join(root, "fontes", "sessions", `${date}.md`);
  return {
    root,
    date,
    diaryPath: diary,
    diary: diary ? readCapped(diary) : null,
    hubPath: existsSync(hub) ? hub : null,
    hub: existsSync(hub) ? readCapped(hub) : null,
    sessionsPath: existsSync(sessions) ? sessions : null,
    sessions: existsSync(sessions) ? readCapped(sessions) : null,
  };
}
