import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { config } from "./config.js";

export const CODEX_HOOK_SCRIPT = "codex-notify.mjs";
export const CODEX_HOOK_INSTALL_EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "Interrupt", "SessionEnd"] as const;
export type CodexInstallEvent = (typeof CODEX_HOOK_INSTALL_EVENTS)[number];

export const CODEX_TRUST_NOTE = "Codex runs new or changed hooks only after you review and trust them: run /hooks in the Codex CLI or open Settings > Hooks in the Codex app.";

const PERMISSION_MARGIN_SEC = 10;
const PERMISSION_OFF_TIMEOUT_SEC = 10;
const SHORT_TIMEOUT_SEC = 3;
const DEFAULT_TIMEOUT_SEC = 10;

export interface CodexHookHandler {
  type: "command";
  command: string;
  commandWindows: string;
  timeout: number;
  async?: boolean;
}

export interface CodexHooksStatus {
  path: string;
  exists: boolean;
  installed: boolean;
  updateAvailable: boolean;
  events: string[];
  missing: string[];
  backupPath: string;
  hasBackup: boolean;
  error: string | null;
  trustNote: string;
}

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);

export const codexHooksPath = (): string => join(config.codexHome, "hooks.json");
const backupPathOf = (path: string): string => `${path}.bak`;

const hooksDir = (): string => (config.resourceDir ? join(config.resourceDir, "hooks") : join(config.serverDir, "hooks"));

export function codexHookCommand(): { command: string; commandWindows: string } {
  const script = join(hooksDir(), CODEX_HOOK_SCRIPT);
  const node = config.resourceDir ? config.nodeBin : "node";
  const posix = (value: string): string => value.replace(/\\/g, "/");
  const quote = (value: string): string => `"${value}"`;
  return {
    command: `${node === "node" ? node : quote(posix(node))} ${quote(posix(script))}`,
    commandWindows: `${node === "node" ? node : quote(node.replace(/\//g, "\\"))} ${quote(script.replace(/\//g, "\\"))}`,
  };
}

export function permissionTimeoutSec(windowSec: number): number {
  return windowSec > 0 ? windowSec + PERMISSION_MARGIN_SEC : PERMISSION_OFF_TIMEOUT_SEC;
}

export function hubHandler(event: CodexInstallEvent, windowSec: number): CodexHookHandler {
  const { command, commandWindows } = codexHookCommand();
  const base: CodexHookHandler = { type: "command", command, commandWindows, timeout: DEFAULT_TIMEOUT_SEC };
  if (event === "PermissionRequest") return { ...base, timeout: permissionTimeoutSec(windowSec) };
  if (event === "SessionEnd" || event === "Interrupt") return { ...base, timeout: SHORT_TIMEOUT_SEC };
  if (event === "PostToolUse") return { ...base, async: true };
  return base;
}

const isHubHandler = (value: unknown): boolean => {
  const handler = asObject(value);
  return typeof handler?.command === "string" && handler.command.includes(CODEX_HOOK_SCRIPT);
};

const groupHasHub = (group: unknown): boolean => {
  const hooks = asObject(group)?.hooks;
  return Array.isArray(hooks) && hooks.some(isHubHandler);
};

function withoutHub(groups: unknown[]): unknown[] {
  return groups.flatMap((group) => {
    if (!groupHasHub(group)) return [group];
    const object = asObject(group) ?? {};
    const rest = (object.hooks as unknown[]).filter((handler) => !isHubHandler(handler));
    return rest.length > 0 ? [{ ...object, hooks: rest }] : [];
  });
}

type ReadResult = { ok: true; exists: boolean; raw: string | null; doc: Json } | { ok: false; error: string };

function readHooksFile(path: string): ReadResult {
  if (!existsSync(path)) return { ok: true, exists: false, raw: null, doc: {} };
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = asObject(JSON.parse(raw.trim() === "" ? "{}" : raw));
    if (!parsed) return { ok: false, error: `${path} is not a JSON object (left untouched)` };
    return { ok: true, exists: true, raw, doc: parsed };
  } catch {
    return { ok: false, error: `${path} is not valid JSON (left untouched)` };
  }
}

function hubEvents(doc: Json): string[] {
  const hooks = asObject(doc.hooks) ?? {};
  return CODEX_HOOK_INSTALL_EVENTS.filter((event) => Array.isArray(hooks[event]) && (hooks[event] as unknown[]).some(groupHasHub));
}

function currentEvents(doc: Json, windowSec: number): string[] {
  const hooks = asObject(doc.hooks) ?? {};
  return CODEX_HOOK_INSTALL_EVENTS.filter((event) => {
    const groups = hooks[event];
    if (!Array.isArray(groups)) return false;
    const expected = hubHandler(event, windowSec);
    return groups.some((group) => {
      const handlers = asObject(group)?.hooks;
      return Array.isArray(handlers) && handlers.some((handler) => isHubHandler(handler) && isDeepStrictEqual(handler, expected));
    });
  });
}

export function codexHooksStatus(windowSec: number, path: string = codexHooksPath()): CodexHooksStatus {
  const base = { path, backupPath: backupPathOf(path), hasBackup: existsSync(backupPathOf(path)), trustNote: CODEX_TRUST_NOTE };
  const read = readHooksFile(path);
  if (!read.ok) return { ...base, exists: true, installed: false, updateAvailable: false, events: [], missing: [...CODEX_HOOK_INSTALL_EVENTS], error: read.error };
  const events = hubEvents(read.doc);
  const current = currentEvents(read.doc, windowSec);
  const missing = CODEX_HOOK_INSTALL_EVENTS.filter((event) => !current.includes(event));
  return { ...base, exists: read.exists, installed: missing.length === 0, updateAvailable: events.length > 0 && missing.length > 0, events, missing, error: null };
}

function serialize(doc: Json): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function installCodexHooks(windowSec: number, path: string = codexHooksPath()): CodexHooksStatus {
  const read = readHooksFile(path);
  if (!read.ok) throw new Error(read.error);
  const backup = backupPathOf(path);
  if (read.exists && hubEvents(read.doc).length === 0) copyFileSync(path, backup);
  if (!read.exists && existsSync(backup)) rmSync(backup);
  const doc: Json = { ...read.doc };
  const hooks: Json = { ...(asObject(doc.hooks) ?? {}) };
  for (const event of CODEX_HOOK_INSTALL_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? withoutHub(hooks[event] as unknown[]) : [];
    hooks[event] = [...groups, { hooks: [hubHandler(event, windowSec)] }];
  }
  doc.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialize(doc));
  return codexHooksStatus(windowSec, path);
}

export function uninstallCodexHooks(windowSec: number, path: string = codexHooksPath()): CodexHooksStatus {
  const read = readHooksFile(path);
  if (!read.ok) throw new Error(read.error);
  if (!read.exists) return codexHooksStatus(windowSec, path);
  const doc: Json = { ...read.doc };
  const hooks: Json = { ...(asObject(doc.hooks) ?? {}) };
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const rest = withoutHub(hooks[event] as unknown[]);
    if (rest.length > 0) hooks[event] = rest;
    else delete hooks[event];
  }
  doc.hooks = hooks;
  const backup = backupPathOf(path);
  const original = existsSync(backup) ? readHooksFile(backup) : null;
  if (original?.ok && original.raw !== null && isDeepStrictEqual(normalized(original.doc), normalized(doc))) {
    writeFileSync(path, original.raw);
    rmSync(backup);
  } else if (!original && Object.keys(hooks).length === 0 && Object.keys(doc).length === 1) {
    rmSync(path);
  } else {
    writeFileSync(path, serialize(doc));
  }
  return codexHooksStatus(windowSec, path);
}

function normalized(doc: Json): Json {
  const hooks = asObject(doc.hooks);
  if (!hooks || Object.keys(hooks).length > 0) return doc;
  const rest: Json = { ...doc };
  delete rest.hooks;
  return rest;
}
