import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MAX_CHARS = 6_000;
const LOCK_RETRIES = 60;
const LOCK_DELAY_MS = 100;
const LOCK_STALE_MS = 5 * 60 * 1000;
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

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export function withFileLockSync<T>(target: string, fn: () => T): T {
  const lockFile = `${target}.lock`;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    let fd: number;
    try {
      fd = openSync(lockFile, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > LOCK_STALE_MS) unlinkSync(lockFile);
        else Atomics.wait(sleepCell, 0, 0, LOCK_DELAY_MS);
      } catch {
        continue;
      }
      continue;
    }
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    try {
      return fn();
    } finally {
      try {
        unlinkSync(lockFile);
      } catch {
        void 0;
      }
    }
  }
  throw new Error(`could not acquire lock: ${lockFile}`);
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

export function upsertSessionBlock(file: string, sessionId: string, date: string, block: string): void {
  let content = existsSync(file) ? readFileSync(file, "utf8") : trailHeader(date);
  const { start, end } = blockMarkers(sessionId);
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    content = content.slice(0, startIdx) + block + content.slice(endIdx + end.length);
  } else {
    const hub = HUB_HEADING_RE.exec(content);
    if (hub) {
      content = `${content.slice(0, hub.index).trimEnd()}\n\n${block}\n\n${content.slice(hub.index)}`;
    } else {
      if (!content.endsWith("\n")) content += "\n";
      content += `\n${block}\n`;
    }
  }
  writeFileSync(file, touchUpdated(content, date));
}

function appendHubLine(file: string, date: string, line: string): void {
  let content = existsSync(file) ? readFileSync(file, "utf8") : trailHeader(date);
  if (!content.endsWith("\n")) content += "\n";
  if (!HUB_HEADING_RE.test(content)) content += "\n## Hub\n\n";
  writeFileSync(file, touchUpdated(`${content}${line}\n`, date));
}

export function appendHubSource(root: string, text: string, now = new Date(), link?: TrailLink | null): string {
  const date = localDate(now);
  const clean = text.replace(/\s*\n\s*/g, " ").trim();
  const resolved = resolveTrail(root, link);
  if (resolved?.unified) {
    const file = trailFilePath(resolved.dir, date);
    mkdirSync(dirname(file), { recursive: true });
    withFileLockSync(file, () => appendHubLine(file, date, `- ${localTime(now)} · ${clean}`));
    return file;
  }
  const path = hubSourcePath(root, date);
  mkdirSync(join(root, "fontes", "hub"), { recursive: true });
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
