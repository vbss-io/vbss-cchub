import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_CHARS = 6_000;

export function localDate(now = new Date()): string {
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const localTime = (now = new Date()): string =>
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

function readCapped(path: string): string {
  const text = readFileSync(path, "utf8");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…(truncated)` : text;
}

export function appendHubSource(root: string, text: string, now = new Date()): string {
  const date = localDate(now);
  const path = hubSourcePath(root, date);
  mkdirSync(join(root, "fontes", "hub"), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(
      path,
      `---\ntype: fonte\ncreated: ${date}\nupdated: ${date}\ntags: [fonte, hub]\n---\n\n# Hub — ${date}\n\n`,
    );
  }
  appendFileSync(path, `- ${localTime(now)} · ${text.replace(/\s*\n\s*/g, " ").trim()}\n`);
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

export function brainToday(root: string, now = new Date()): BrainToday {
  const date = localDate(now);
  const diary = diaryPath(root, date);
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
