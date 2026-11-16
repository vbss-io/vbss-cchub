import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const action = args[0] && !args[0].startsWith("--") ? args[0] : "status";
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const notifyPath = flag("--notify") ?? join(here, "notify.mjs");
const settingsPath = flag("--settings") ?? join(homedir(), ".claude", "settings.json");
const source = flag("--source");
const runner = flag("--runner") ?? "node";
const DEFAULT_PERMISSION_TIMEOUT = 330;
const permissionTimeoutArg = Number(flag("--permission-timeout"));
const permissionTimeout = Number.isInteger(permissionTimeoutArg) && permissionTimeoutArg > 0 ? permissionTimeoutArg : DEFAULT_PERMISSION_TIMEOUT;

const EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "StopFailure", "SessionEnd", "SubagentStart", "SubagentStop", "PermissionRequest", "PostToolUse", "PostToolUseFailure"];
const TIMEOUTS = { SessionEnd: 5, PermissionRequest: permissionTimeout };
const ASYNC_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"]);
const EXACT_TIMEOUT_EVENTS = new Set(["PermissionRequest"]);
const posix = (value) => value.replace(/\\/g, "/");
const quotedRunner = runner === "node" || runner === "sh" ? runner : `"${posix(runner)}"`;
const command = `${source ? `HUB_SOURCE=${source} ` : ""}${quotedRunner} "${posix(notifyPath)}"`;

const isHubHook = (h) => typeof h?.command === "string" && (h.command.includes("notify.mjs") || h.command.includes("notify.sh"));

const isOurs = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some(isHubHook);

const withoutHub = (entries) =>
  entries.flatMap((entry) => {
    if (!isOurs(entry)) return [entry];
    const rest = entry.hooks.filter((h) => !isHubHook(h));
    return rest.length > 0 ? [{ ...entry, hooks: rest }] : [];
  });

function readSettings() {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8") || "{}");
  } catch {
    return null;
  }
}

function writeSettings(settings) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak`);
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function hubHook(event) {
  const hook = { type: "command", command };
  if (TIMEOUTS[event]) hook.timeout = TIMEOUTS[event];
  if (ASYNC_EVENTS.has(event)) hook.async = true;
  return hook;
}

function isCurrentHook(event, hook) {
  if (!isHubHook(hook)) return false;
  if (ASYNC_EVENTS.has(event) && hook.async !== true) return false;
  if (EXACT_TIMEOUT_EVENTS.has(event)) return hook.timeout === TIMEOUTS[event];
  return !TIMEOUTS[event] || (typeof hook.timeout === "number" && hook.timeout > 0);
}

const isCurrent = (event, entry) => entry.hooks.some((h) => isCurrentHook(event, h));

function status(settings) {
  const hooks = settings?.hooks ?? {};
  const ours = (event) => (Array.isArray(hooks[event]) ? hooks[event].filter(isOurs) : []);
  const events = EVENTS.filter((event) => ours(event).length > 0);
  const missing = EVENTS.filter((event) => !ours(event).some((entry) => isCurrent(event, entry)));
  return { installed: missing.length === 0, outdated: events.length > 0 && missing.length > 0, missing, events, settingsPath, notifyPath, permissionTimeout };
}

function install(settings) {
  settings.hooks ??= {};
  for (const event of EVENTS) {
    const list = withoutHub(Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []);
    list.push({ hooks: [hubHook(event)] });
    settings.hooks[event] = list;
  }
  return settings;
}

function uninstall(settings) {
  const hooks = settings?.hooks ?? {};
  for (const event of EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = withoutHub(hooks[event]);
    if (hooks[event].length === 0) delete hooks[event];
  }
  return settings;
}

const settings = readSettings();

if (settings === null) {
  console.log(JSON.stringify({ error: "settings.json invalido (nao foi tocado)" }));
  process.exit(1);
}

if (action === "install") {
  writeSettings(install(settings));
  console.log(JSON.stringify({ ok: true, ...status(settings) }));
} else if (action === "uninstall") {
  writeSettings(uninstall(settings));
  console.log(JSON.stringify({ ok: true, ...status(settings) }));
} else {
  console.log(JSON.stringify(status(settings)));
}
