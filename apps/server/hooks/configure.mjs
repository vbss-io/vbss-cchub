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

const EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "StopFailure", "SessionEnd", "SubagentStart", "SubagentStop"];
const TIMEOUTS = { SessionEnd: 5 };
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

const hubHook = (event) => (TIMEOUTS[event] ? { type: "command", command, timeout: TIMEOUTS[event] } : { type: "command", command });

const isCurrent = (event, entry) => !TIMEOUTS[event] || entry.hooks.some((h) => isHubHook(h) && typeof h.timeout === "number" && h.timeout > 0);

function status(settings) {
  const hooks = settings?.hooks ?? {};
  const ours = (event) => (Array.isArray(hooks[event]) ? hooks[event].filter(isOurs) : []);
  const events = EVENTS.filter((event) => ours(event).length > 0);
  const missing = EVENTS.filter((event) => !ours(event).some((entry) => isCurrent(event, entry)));
  return { installed: missing.length === 0, outdated: events.length > 0 && missing.length > 0, missing, events, settingsPath, notifyPath };
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
