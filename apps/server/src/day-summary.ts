import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { listCodexSessions } from "./codex-store.js";
import { readDaily, writeDaily, type DailyWriteResult } from "./daily.js";
import { listSessions } from "./db.js";
import { BadRequestError, NotFoundError } from "./delegation-launch.js";
import { listReports } from "./delegation-store.js";
import type { DelegationSettings, WorkspaceRecord } from "./delegation-types.js";
import { localDate, localTime, trailFilePath } from "./second-brain.js";
import { collectBoard, normalizeText, tasksRoot } from "./tasks-board.js";
import { isHubRun, trailDir } from "./trail.js";
import { discoverWorkspaces, isDirectory, workspaceFor } from "./workspaces.js";

const execFileAsync = promisify(execFile);

export const DAY_SUMMARY_START = "<!-- cchub:day-summary START -->";
export const DAY_SUMMARY_END = "<!-- cchub:day-summary END -->";
const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_COMMITS = 30;
const KEY_POINTS_MAX = 5;
const REPORTS_MAX = 20;
const LINE_CAP = 200;
const OTHER_WORKSPACE = "other";
const BLOCK_RE = /<!-- session:(\S+) START -->([\s\S]*?)<!-- session:\1 END -->/g;
const BLOCK_HEADING_RE = /^## `[^`]*` · (\d{2}:\d{2}) →/m;
const BLOCK_CWD_RE = /^`([^`\r\n]+)`[ \t]*\r?$/m;
const BULLET_RE = /^- (.+?)\r?$/gm;
const DONE_LINE_RE = /^\s*[-*+]\s+\[[xX]\]\s+(.*)$/;
const PRIORITY_TAG_RE = /\s+#[A-Za-z0-9_-]+$/;

export interface DaySummarySession {
  sessionId: string;
  client: "claude" | "codex";
  workspace: string | null;
  time: string | null;
  title: string;
  keyPoints: string[];
}

export interface DaySummaryTask {
  project: string | null;
  title: string;
  source: "project" | "daily";
}

export interface DaySummaryReport {
  time: string;
  workspace: string | null;
  kind: string;
  text: string;
}

export interface DaySummaryCommit {
  workspace: string;
  repo: string;
  hash: string;
  subject: string;
}

export interface DaySummary {
  date: string;
  heading: string;
  sessions: DaySummarySession[];
  tasks: DaySummaryTask[];
  reports: DaySummaryReport[];
  commits: DaySummaryCommit[];
  empty: boolean;
  block: string;
  markdown: string;
}

const clipLine = (text: string, max = LINE_CAP): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export const safeItem = (text: string): string => clipLine(text).replace(/^\[([ xX-])\]/, "\\[$1]");

function dayBounds(date: string): { start: Date; end: Date } {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return { start: new Date(year, month - 1, day), end: new Date(year, month - 1, day + 1) };
}

export function isoWithOffset(when: Date): string {
  const pad = (value: number): string => String(Math.abs(value)).padStart(2, "0");
  const offset = -when.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `${localDate(when)}T${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

interface TrailBlock {
  sessionId: string;
  time: string | null;
  cwd: string | null;
  bullets: string[];
}

export function parseTrailBlocks(content: string): TrailBlock[] {
  return [...content.matchAll(BLOCK_RE)].map((match) => {
    const body = match[2] ?? "";
    return {
      sessionId: match[1] ?? "",
      time: BLOCK_HEADING_RE.exec(body)?.[1] ?? null,
      cwd: BLOCK_CWD_RE.exec(body)?.[1] ?? null,
      bullets: [...body.matchAll(BULLET_RE)].map((bullet) => bullet[1] ?? "").filter((bullet) => bullet.trim() !== ""),
    };
  });
}

function trailBlocksFor(settings: DelegationSettings, date: string): TrailBlock[] {
  const dir = trailDir(settings);
  if (!dir) return [];
  const file = trailFilePath(dir, date);
  if (!existsSync(file)) return [];
  try {
    return parseTrailBlocks(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function daySessions(settings: DelegationSettings, workspaces: WorkspaceRecord[], date: string): DaySummarySession[] {
  const nameOf = (cwd: string | null): string | null => workspaceFor(workspaces, cwd)?.name ?? null;
  const onDay = (time: number): boolean => localDate(new Date(time)) === date;
  const known = new Map(listSessions().map((session) => [session.sessionId, session]));
  const byId = new Map<string, DaySummarySession>();
  for (const block of trailBlocksFor(settings, date)) {
    const session = known.get(block.sessionId);
    const cwd = block.cwd ?? session?.cwd ?? null;
    byId.set(block.sessionId, {
      sessionId: block.sessionId,
      client: "claude",
      workspace: nameOf(cwd),
      time: block.time,
      title: clipLine(session?.customTitle ?? session?.title ?? `session ${block.sessionId.slice(0, 8)}`, 100),
      keyPoints: block.bullets.slice(-KEY_POINTS_MAX).map(safeItem),
    });
  }
  for (const session of known.values()) {
    if (byId.has(session.sessionId) || isHubRun(session) || session.helperOf !== null) continue;
    if (!onDay(session.startedAt) && !onDay(session.updatedAt)) continue;
    byId.set(session.sessionId, {
      sessionId: session.sessionId,
      client: "claude",
      workspace: nameOf(session.cwd),
      time: localTime(new Date(onDay(session.startedAt) ? session.startedAt : session.updatedAt)),
      title: clipLine(session.customTitle ?? session.title ?? "untitled", 100),
      keyPoints: [],
    });
  }
  for (const thread of listCodexSessions()) {
    if (byId.has(thread.id) || thread.origin === "hub" || thread.hidden) continue;
    if (!onDay(thread.startedAt) && !onDay(thread.updatedAt)) continue;
    byId.set(thread.id, {
      sessionId: thread.id,
      client: "codex",
      workspace: nameOf(thread.cwd),
      time: localTime(new Date(onDay(thread.startedAt) ? thread.startedAt : thread.updatedAt)),
      title: clipLine(thread.customTitle ?? thread.title, 100),
      keyPoints: [],
    });
  }
  return [...byId.values()].sort(
    (a, b) =>
      (a.workspace ?? "￿").localeCompare(b.workspace ?? "￿") ||
      (a.time ?? "99:99").localeCompare(b.time ?? "99:99") ||
      a.sessionId.localeCompare(b.sessionId),
  );
}

function stampsFor(settings: DelegationSettings, date: string): string[] {
  return [...new Set([`✅ ${date}`, settings.tasks.doneStamp.split("{{date}}").join(date).trim()])].filter((stamp) => stamp !== "");
}

function doneTitles(content: string, stamps: string[]): string[] {
  const titles: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = DONE_LINE_RE.exec(line);
    if (!match) continue;
    let rest = match[1] ?? "";
    if (!stamps.some((stamp) => rest.includes(stamp))) continue;
    for (const stamp of stamps) rest = rest.split(stamp).join(" ");
    const title = rest.replace(/\s+/g, " ").trim().replace(PRIORITY_TAG_RE, "").trim();
    if (title !== "") titles.push(title);
  }
  return titles;
}

export function withoutSummaryBlock(content: string): string {
  const start = content.indexOf(DAY_SUMMARY_START);
  const end = content.indexOf(DAY_SUMMARY_END);
  if (start < 0 || end < start) return content;
  return content.slice(0, start) + content.slice(end + DAY_SUMMARY_END.length);
}

function doneTasks(settings: DelegationSettings, date: string): DaySummaryTask[] {
  const stamps = stampsFor(settings, date);
  const tasks: DaySummaryTask[] = [];
  const seen = new Set<string>();
  const root = tasksRoot(settings);
  if (root && isDirectory(root)) {
    const { loaded } = collectBoard(root, settings.tasks);
    for (const project of loaded.projects) {
      for (const title of doneTitles(loaded.contents.get(project.id) ?? "", stamps)) {
        const key = normalizeText(title);
        if (seen.has(key)) continue;
        seen.add(key);
        tasks.push({ project: project.title, title: safeItem(title), source: "project" });
      }
    }
  }
  if (settings.secondBrainRoot) {
    const daily = readDaily(settings, date);
    if (daily.exists) {
      for (const title of doneTitles(withoutSummaryBlock(daily.content), stamps)) {
        const key = normalizeText(title);
        if ([...seen].some((known) => key.includes(known))) continue;
        seen.add(key);
        tasks.push({ project: null, title: safeItem(title), source: "daily" });
      }
    }
  }
  return tasks;
}

function dayReports(date: string): DaySummaryReport[] {
  return listReports({ limit: 500 })
    .filter((report) => localDate(new Date(report.createdAt)) === date)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, REPORTS_MAX)
    .map((report) => ({
      time: localTime(new Date(report.createdAt)),
      workspace: report.workspace,
      kind: report.kind,
      text: safeItem(report.text.split(/\r?\n/).find((line) => line.trim() !== "") ?? report.text),
    }));
}

async function repoCommits(repo: string, since: string, until: string): Promise<{ hash: string; subject: string }[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, "log", "--branches", `--since=${since}`, `--until=${until}`, "--format=%h%x09%s", "-n", String(GIT_MAX_COMMITS)], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1_048_576,
    });
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.includes("\t"))
      .map((line) => {
        const tab = line.indexOf("\t");
        return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
      })
      .reverse();
  } catch {
    return [];
  }
}

async function dayCommits(workspaces: WorkspaceRecord[], date: string): Promise<DaySummaryCommit[]> {
  const { start, end } = dayBounds(date);
  const since = isoWithOffset(start);
  const until = isoWithOffset(end);
  const seen = new Set<string>();
  const targets: { workspace: string; repo: string; path: string }[] = [];
  for (const workspace of [...workspaces].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const repo of workspace.repos) {
      const key = process.platform === "win32" ? repo.path.toLowerCase() : repo.path;
      if (seen.has(key) || !isDirectory(repo.path)) continue;
      seen.add(key);
      targets.push({ workspace: workspace.name, repo: repo.name, path: repo.path });
    }
  }
  const results = await Promise.all(targets.map((target) => repoCommits(target.path, since, until)));
  return targets.flatMap((target, index) =>
    (results[index] ?? []).map((commit) => ({ workspace: target.workspace, repo: target.repo, hash: commit.hash, subject: safeItem(commit.subject) })),
  );
}

export function renderSummaryBlock(summary: Pick<DaySummary, "sessions" | "tasks" | "reports" | "commits">): string {
  const lines: string[] = [DAY_SUMMARY_START];
  const section = (label: string, items: string[]): void => {
    if (items.length === 0) return;
    if (lines.length > 1) lines.push("");
    lines.push(`**${label}**`, "", ...items);
  };
  section(
    "Sessions",
    summary.sessions.flatMap((session) => [
      `- ${[session.workspace ?? OTHER_WORKSPACE, session.time, `${session.title} (${session.client})`].filter((part): part is string => part !== null).join(" · ")}`,
      ...session.keyPoints.map((point) => `  - ${point}`),
    ]),
  );
  section(
    "Done today",
    summary.tasks.map((task) => `- ${task.project ? `${task.project}: ` : ""}${task.title}`),
  );
  section(
    "Delegation reports",
    summary.reports.map((report) => `- ${report.time} · ${report.workspace ?? OTHER_WORKSPACE} · ${report.kind}: ${report.text}`),
  );
  section(
    "Commits",
    summary.commits.map((commit) => `- ${commit.workspace} · ${commit.repo} \`${commit.hash}\` ${commit.subject}`),
  );
  if (lines.length === 1) lines.push("_Nothing recorded for this day yet._");
  lines.push(DAY_SUMMARY_END);
  return lines.join("\n");
}

export async function composeDaySummary(settings: DelegationSettings, date: string): Promise<DaySummary> {
  const workspaces = discoverWorkspaces(settings.workspacesRoot);
  const sessions = daySessions(settings, workspaces, date);
  const tasks = doneTasks(settings, date);
  const reports = dayReports(date);
  const commits = await dayCommits(workspaces, date);
  const heading = settings.memory.summaryHeading;
  const block = renderSummaryBlock({ sessions, tasks, reports, commits });
  return {
    date,
    heading,
    sessions,
    tasks,
    reports,
    commits,
    empty: sessions.length + tasks.length + reports.length + commits.length === 0,
    block,
    markdown: `## ${heading}\n\n${block}`,
  };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function applySummaryBlock(content: string, heading: string, block: string): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const piece = block.replace(/\r?\n/g, eol);
  const start = content.indexOf(DAY_SUMMARY_START);
  const end = start < 0 ? -1 : content.indexOf(DAY_SUMMARY_END, start);
  if (start >= 0 && end >= 0) return content.slice(0, start) + piece + content.slice(end + DAY_SUMMARY_END.length);
  const headingRe = new RegExp(`^##[ \\t]+${escapeRegExp(heading)}[ \\t]*\\r?$`, "mi");
  const found = headingRe.exec(content);
  if (found) {
    const lineEnd = found.index + found[0].replace(/\r$/, "").length;
    const rest = content.slice(lineEnd).replace(/^\r?\n/, "");
    const tail = rest === "" ? eol : /^\r?\n/.test(rest) ? `${eol}${rest}` : `${eol}${eol}${rest}`;
    return `${content.slice(0, lineEnd)}${eol}${eol}${piece}${tail}`;
  }
  const base = content === "" || content.endsWith("\n") ? content : `${content}${eol}`;
  return `${base}${base === "" ? "" : eol}## ${heading}${eol}${eol}${piece}${eol}`;
}

export interface DaySummaryWriteResult extends DailyWriteResult {
  changed: boolean;
  summary: DaySummary;
}

export async function writeDaySummary(settings: DelegationSettings, date: string, baseUpdatedAt?: number, writeId?: string | null): Promise<DaySummaryWriteResult> {
  if (!settings.secondBrainRoot) throw new BadRequestError("second brain root not set");
  if (!settings.features.daily) throw new BadRequestError("the daily feature is disabled");
  const summary = await composeDaySummary(settings, date);
  const daily = readDaily(settings, date);
  if (!daily.exists) throw new NotFoundError("the daily note for this date does not exist yet");
  const next = applySummaryBlock(daily.content, summary.heading, summary.block);
  if (next === daily.content) return { date, path: daily.path, updatedAt: daily.updatedAt ?? 0, changed: false, summary };
  const written = writeDaily(settings, date, next, baseUpdatedAt ?? daily.updatedAt ?? undefined, writeId ?? null, "server");
  return { ...written, changed: true, summary };
}
