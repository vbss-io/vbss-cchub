import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { listSessions } from "./db.js";
import { BadRequestError, createInternalTask, startRun } from "./delegation-launch.js";
import { activeDailyTask, getSettings } from "./delegation-store.js";
import type { DelegationSettings, TaskRecord } from "./delegation-types.js";
import { localDate } from "./second-brain.js";
import { broadcast } from "./sse.js";
import type { SessionStatus } from "./types.js";
import { isDirectory } from "./workspaces.js";

const DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const DAILY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WATCH_DEBOUNCE_MS = 300;

export function isValidDailyDate(text: string): boolean {
  if (!DAILY_DATE_RE.test(text)) return false;
  const [yearStr, monthStr, dayStr] = text.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (year < 2000 || year > 2100) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export const BUILT_IN_TEMPLATE = `---
type: daily
created: {{date}}
updated: {{date}}
tags: [daily]
---

# {{date}}

## Focus
- [ ]

## Meetings
-

## Captures
-

## Sessions
-
`;

export const DEFAULT_DAILY_PROMPT =
  "You are working inside the second brain at {{root}}. Today is {{date}}. Create or refresh the daily diary {{file}}: " +
  "when {{template}} is a file, start from it; when the diary already exists, keep everything the user wrote. Fill in: " +
  "a briefing of what happened on {{yesterday}} in at most 3 lines (read the previous diary and any notes of that day you can find in the vault); today's focus as task items in the form `- [ ] Project - item`, " +
  "taken from this input: {{focus}}, plus open items touched in the last two days; meetings when you can find them; " +
  "an empty captures section; and a sessions section listing today's sessions so far: {{sessions}}. Write the file, " +
  "do not ask questions, do not create or edit any other file, then stop.";

export function renderTemplate(text: string, date: string): string {
  return text.split("{{date}}").join(date);
}

export interface DailyPromptVars {
  date: string;
  file: string;
  root: string;
  template: string;
  focus: string;
  sessions: string;
  yesterday: string;
}

export function renderDailyPrompt(template: string, vars: DailyPromptVars): string {
  return template
    .split("{{date}}")
    .join(vars.date)
    .split("{{file}}")
    .join(vars.file)
    .split("{{root}}")
    .join(vars.root)
    .split("{{template}}")
    .join(vars.template)
    .split("{{focus}}")
    .join(vars.focus)
    .split("{{sessions}}")
    .join(vars.sessions)
    .split("{{yesterday}}")
    .join(vars.yesterday);
}

function resolveAgainstRoot(root: string, value: string): string {
  return isAbsolute(value) ? value : join(root, value);
}

export function dailyRoot(settings: DelegationSettings): string | null {
  return settings.secondBrainRoot;
}

export function dailyDir(settings: DelegationSettings): string | null {
  const root = dailyRoot(settings);
  if (!root) return null;
  return settings.daily.dir ? resolveAgainstRoot(root, settings.daily.dir) : join(root, "daily");
}

export function dailyTemplatePath(settings: DelegationSettings): string | null {
  const root = dailyRoot(settings);
  if (!root) return null;
  if (settings.daily.template) return resolveAgainstRoot(root, settings.daily.template);
  const builtin = join(root, "_templates", "daily.md");
  return existsSync(builtin) ? builtin : null;
}

function findExistingDailyFile(dir: string, date: string): string | null {
  const flat = join(dir, `${date}.md`);
  if (existsSync(flat)) return flat;
  const archived = join(dir, date.slice(0, 7), `${date}.md`);
  if (existsSync(archived)) return archived;
  if (!isDirectory(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(dir, entry.name, `${date}.md`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function dailyFile(settings: DelegationSettings, date: string): string | null {
  const root = dailyRoot(settings);
  if (!root) return null;
  const dir = dailyDir(settings) ?? join(root, "daily");
  return findExistingDailyFile(dir, date) ?? join(dir, `${date}.md`);
}

export function listDiaryDates(settings: DelegationSettings): string[] {
  const dir = dailyDir(settings);
  if (!dir || !isDirectory(dir)) return [];
  const dates = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && DATE_FILE_RE.test(entry.name)) {
      const date = entry.name.slice(0, 10);
      if (isValidDailyDate(date)) dates.add(date);
    } else if (entry.isDirectory()) {
      const subDir = join(dir, entry.name);
      for (const sub of readdirSync(subDir, { withFileTypes: true })) {
        if (sub.isFile() && DATE_FILE_RE.test(sub.name)) {
          const date = sub.name.slice(0, 10);
          if (isValidDailyDate(date)) dates.add(date);
        }
      }
    }
  }
  return [...dates].sort().reverse();
}

export function findYesterday(settings: DelegationSettings, date: string): string | null {
  const before = listDiaryDates(settings).filter((candidate) => candidate < date);
  return before[0] ?? null;
}

export interface DailySessionSummary {
  sessionId: string;
  title: string | null;
  client: string | null;
  cwd: string | null;
  status: SessionStatus;
  startedAt: number;
  updatedAt: number;
}

export function dailySessionsForDate(date: string): DailySessionSummary[] {
  return listSessions()
    .filter((session) => localDate(new Date(session.startedAt)) === date || localDate(new Date(session.updatedAt)) === date)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session) => ({
      sessionId: session.sessionId,
      title: session.customTitle ?? session.title,
      client: session.client,
      cwd: session.cwd,
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
    }));
}

function dailySessionsMarkdown(date: string): string {
  const sessions = dailySessionsForDate(date);
  if (sessions.length === 0) return "none yet";
  return sessions.map((session) => `- ${session.title ?? "untitled"} · ${session.client ?? "unknown"} · ${session.cwd ?? "unknown"}`).join("\n");
}

export interface DailyReadResult {
  date: string;
  path: string;
  exists: boolean;
  content: string;
  updatedAt: number | null;
}

export function readDaily(settings: DelegationSettings, date: string): DailyReadResult {
  const root = dailyRoot(settings);
  if (!root) throw new BadRequestError("second brain root not set");
  const path = dailyFile(settings, date) as string;
  if (!existsSync(path)) return { date, path, exists: false, content: "", updatedAt: null };
  const stat = statSync(path);
  return { date, path, exists: true, content: readFileSync(path, "utf8"), updatedAt: stat.mtimeMs };
}

const lastHubHash = new Map<string, string>();

export function hashDailyContent(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

const hashOf = hashDailyContent;

export class DailyConflictError extends Error {
  constructor(
    public readonly content: string,
    public readonly updatedAt: number,
  ) {
    super("changed on disk");
  }
}

export interface DailyWriteResult {
  date: string;
  path: string;
  updatedAt: number;
}

export function writeDaily(
  settings: DelegationSettings,
  date: string,
  content: string,
  baseUpdatedAt?: number,
  writeId?: string | null,
): DailyWriteResult {
  const root = dailyRoot(settings);
  if (!root) throw new BadRequestError("second brain root not set");
  const path = dailyFile(settings, date) as string;
  if (typeof baseUpdatedAt === "number" && existsSync(path)) {
    const currentStat = statSync(path);
    if (Math.abs(currentStat.mtimeMs - baseUpdatedAt) > 1) {
      const currentContent = readFileSync(path, "utf8");
      if (lastHubHash.get(path) !== hashOf(currentContent)) {
        throw new DailyConflictError(currentContent, currentStat.mtimeMs);
      }
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, path);
  const stat = statSync(path);
  lastHubHash.set(path, hashOf(content));
  broadcast("daily", { date, updatedAt: stat.mtimeMs, source: "hub", writeId: writeId ?? null });
  return { date, path, updatedAt: stat.mtimeMs };
}

export class DailyBusyError extends Error {
  constructor(public readonly taskId: string) {
    super("a daily generation is already running for this date");
  }
}

export function generateDaily(date: string, focus: string | null): { taskId: string } {
  const settings = getSettings();
  if (!settings.features.daily) throw new BadRequestError("the daily feature is disabled");
  const root = dailyRoot(settings);
  if (!root) throw new BadRequestError("second brain root not set");
  const busy = activeDailyTask(date);
  if (busy) throw new DailyBusyError(busy.id);
  const file = dailyFile(settings, date) as string;
  const templatePath = dailyTemplatePath(settings);
  const yesterday = findYesterday(settings, date);
  const promptTemplate = settings.daily.prompt ?? DEFAULT_DAILY_PROMPT;
  const prompt = renderDailyPrompt(promptTemplate, {
    date,
    file,
    root,
    template: templatePath ?? "none",
    focus: focus && focus.trim() ? focus.trim() : "not provided",
    sessions: dailySessionsMarkdown(date),
    yesterday: yesterday ?? "unknown",
  });
  const task: TaskRecord = createInternalTask({
    title: `Daily ${date}`,
    prompt,
    workspace: "second-brain",
    cwd: root,
    addDirs: [root],
    runner: settings.daily.runner,
    createdBy: "daily",
    dailyDate: date,
  });
  startRun(task, "launch", prompt, null, null);
  return { taskId: task.id };
}

let currentWatcher: FSWatcher | null = null;
let currentWatchedDir: string | null = null;
const debounceTimers = new Map<string, NodeJS.Timeout>();

export function stopDailyWatch(): void {
  if (currentWatcher) {
    currentWatcher.close();
    currentWatcher = null;
    currentWatchedDir = null;
  }
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
}

function handleDailyFsEvent(dir: string, date: string): void {
  const path = findExistingDailyFile(dir, date);
  if (!path) return;
  let content: string;
  let stat;
  try {
    content = readFileSync(path, "utf8");
    stat = statSync(path);
  } catch {
    return;
  }
  if (lastHubHash.get(path) === hashOf(content)) return;
  broadcast("daily", { date, updatedAt: stat.mtimeMs, source: "disk", writeId: null });
}

export function watchDaily(settings: DelegationSettings): void {
  const dir = dailyDir(settings);
  if (!dir || !isDirectory(dir)) {
    stopDailyWatch();
    return;
  }
  if (currentWatchedDir === dir && currentWatcher) return;
  stopDailyWatch();
  try {
    const watcher = watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith(".md")) return;
      const date = basename(filename, ".md");
      if (!isValidDailyDate(date)) return;
      const existingTimer = debounceTimers.get(date);
      if (existingTimer) clearTimeout(existingTimer);
      debounceTimers.set(
        date,
        setTimeout(() => {
          debounceTimers.delete(date);
          handleDailyFsEvent(dir, date);
        }, WATCH_DEBOUNCE_MS),
      );
    });
    watcher.on("error", () => stopDailyWatch());
    currentWatcher = watcher;
    currentWatchedDir = dir;
  } catch {
    currentWatcher = null;
    currentWatchedDir = null;
  }
}
