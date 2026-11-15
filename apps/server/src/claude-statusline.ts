import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeConfigDirFrom, config } from "./config.js";

export const STATUSLINE_SCRIPT_NAME = "statusline-cchub.mjs";

export type StatuslineState = "installed" | "outdated" | "not-installed";

export interface StatuslineStatus {
  state: StatuslineState;
  installed: boolean;
  outdated: boolean;
  settingsPath: string;
  previousCommand: string | null;
  error: string | null;
}

export interface StatuslinePaths {
  settingsPath: string;
  recordPath: string;
  scriptPath: string;
  runner: string;
}

interface InstallRecord {
  settingsPath: string;
  originalText: string | null;
  installedText: string;
}

type Json = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const PREVIOUS_FLAG = "--previous";
const PREVIOUS_RE = /\s--previous\s+([A-Za-z0-9_-]+)/;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDirFrom(env) ?? join(config.homeDir, ".claude"), "settings.json");
}

export function defaultStatuslinePaths(): StatuslinePaths {
  const hooksDir = config.resourceDir ? join(config.resourceDir, "hooks") : join(here, "..", "hooks");
  return {
    settingsPath: claudeSettingsPath(),
    recordPath: join(config.dataDir, "claude-statusline-install.json"),
    scriptPath: join(hooksDir, STATUSLINE_SCRIPT_NAME),
    runner: config.resourceDir ? config.nodeBin : "node",
  };
}

const posix = (value: string): string => value.replace(/\\/g, "/");

const quotedRunner = (runner: string): string => (runner === "node" ? runner : `"${posix(runner)}"`);

export function wrapperCommand(paths: Pick<StatuslinePaths, "scriptPath" | "runner">, previous: Json | null): string {
  const base = `${quotedRunner(paths.runner)} "${posix(paths.scriptPath)}"`;
  if (previous === null) return base;
  return `${base} ${PREVIOUS_FLAG} ${Buffer.from(JSON.stringify(previous), "utf8").toString("base64url")}`;
}

function commandOf(statusLine: unknown): string | null {
  return isObject(statusLine) && typeof statusLine.command === "string" ? statusLine.command : null;
}

const isOurs = (statusLine: unknown): boolean => commandOf(statusLine)?.includes(STATUSLINE_SCRIPT_NAME) === true;

export function decodePrevious(command: string): Json | null {
  const match = PREVIOUS_RE.exec(command);
  if (!match?.[1]) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function parseSettings(text: string | null): Json | null {
  if (text === null || text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readRecord(path: string): InstallRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(parsed) || typeof parsed.settingsPath !== "string" || typeof parsed.installedText !== "string") return null;
    const originalText = typeof parsed.originalText === "string" ? parsed.originalText : null;
    return { settingsPath: parsed.settingsPath, originalText, installedText: parsed.installedText };
  } catch {
    return null;
  }
}

function writeRecord(path: string, record: InstallRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record));
}

function writeSettings(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, text);
}

const serialize = (settings: Json): string => `${JSON.stringify(settings, null, 2)}\n`;

function statusOf(paths: StatuslinePaths, settings: Json | null): StatuslineStatus {
  const base = { settingsPath: paths.settingsPath, previousCommand: null, error: null };
  if (settings === null) {
    return { ...base, state: "not-installed", installed: false, outdated: false, error: "settings.json is not valid JSON (left untouched)" };
  }
  const current = settings.statusLine;
  if (!isOurs(current)) return { ...base, state: "not-installed", installed: false, outdated: false };
  const command = commandOf(current) ?? "";
  const previous = decodePrevious(command);
  const upToDate = command === wrapperCommand(paths, previous);
  return {
    ...base,
    state: upToDate ? "installed" : "outdated",
    installed: upToDate,
    outdated: !upToDate,
    previousCommand: commandOf(previous),
  };
}

export function statuslineStatus(paths: StatuslinePaths = defaultStatuslinePaths()): StatuslineStatus {
  return statusOf(paths, parseSettings(readText(paths.settingsPath)));
}

export function installStatusline(paths: StatuslinePaths = defaultStatuslinePaths()): StatuslineStatus {
  const text = readText(paths.settingsPath);
  const settings = parseSettings(text);
  if (settings === null) return statusOf(paths, settings);
  const current = settings.statusLine;
  const ours = isOurs(current);
  const previous = ours ? decodePrevious(commandOf(current) ?? "") : isObject(current) ? current : null;
  const keep = isObject(current) ? current : {};
  settings.statusLine = { ...keep, type: "command", command: wrapperCommand(paths, previous) };
  const next = serialize(settings);
  const record = readRecord(paths.recordPath);
  const carried = ours && record !== null && record.settingsPath === paths.settingsPath && record.installedText === text;
  if (next !== text) writeSettings(paths.settingsPath, next);
  if (!ours) writeRecord(paths.recordPath, { settingsPath: paths.settingsPath, originalText: text, installedText: next });
  else if (carried && record !== null) writeRecord(paths.recordPath, { settingsPath: paths.settingsPath, originalText: record.originalText, installedText: next });
  else rmSync(paths.recordPath, { force: true });
  return statusOf(paths, settings);
}

export function uninstallStatusline(paths: StatuslinePaths = defaultStatuslinePaths()): StatuslineStatus {
  const text = readText(paths.settingsPath);
  const settings = parseSettings(text);
  if (settings === null) return statusOf(paths, settings);
  if (!isOurs(settings.statusLine)) return statusOf(paths, settings);
  const record = readRecord(paths.recordPath);
  rmSync(paths.recordPath, { force: true });
  if (record !== null && record.settingsPath === paths.settingsPath && record.installedText === text) {
    if (record.originalText === null) {
      if (existsSync(paths.settingsPath)) copyFileSync(paths.settingsPath, `${paths.settingsPath}.bak`);
      rmSync(paths.settingsPath, { force: true });
    } else {
      writeSettings(paths.settingsPath, record.originalText);
    }
    return statuslineStatus(paths);
  }
  const previous = decodePrevious(commandOf(settings.statusLine) ?? "");
  if (previous === null) delete settings.statusLine;
  else settings.statusLine = previous;
  writeSettings(paths.settingsPath, serialize(settings));
  return statusOf(paths, settings);
}
