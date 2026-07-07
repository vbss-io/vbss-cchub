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

const EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"];
const posix = (value) => value.replace(/\\/g, "/");
const quotedRunner = runner === "node" || runner === "sh" ? runner : `"${posix(runner)}"`;
const command = `${source ? `HUB_SOURCE=${source} ` : ""}${quotedRunner} "${posix(notifyPath)}"`;

const isOurs = (entry) =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some(
    (h) =>
      typeof h?.command === "string" &&
      (h.command.includes("notify.mjs") || h.command.includes("notify.sh")),
  );

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

function status(settings) {
  const hooks = settings?.hooks ?? {};
  const events = EVENTS.filter((event) => Array.isArray(hooks[event]) && hooks[event].some(isOurs));
  return { installed: events.length === EVENTS.length, events, settingsPath, notifyPath };
}

function install(settings) {
  settings.hooks ??= {};
  for (const event of EVENTS) {
    const list = (Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []).filter(
      (entry) => !isOurs(entry),
    );
    list.push({ hooks: [{ type: "command", command }] });
    settings.hooks[event] = list;
  }
  return settings;
}

function uninstall(settings) {
  const hooks = settings?.hooks ?? {};
  for (const event of EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].filter((entry) => !isOurs(entry));
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
