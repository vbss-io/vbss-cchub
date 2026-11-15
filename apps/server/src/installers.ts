import { execFile, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { getSetting, setSetting } from "./delegation-store.js";

const run = promisify(execFile);
const BLOCK_START = "# >>> vbss-cchub wk >>>";
const BLOCK_END = "# <<< vbss-cchub wk <<<";
const MCP_NAME = "cchub";

export const SHELL_KINDS = ["bash", "powershell"] as const;
export type ShellKind = (typeof SHELL_KINDS)[number];

export const MCP_CLIENTS = ["claude-code", "claude-desktop", "codex"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

export type ConnectAction = "install" | "uninstall";

export interface ShellStatus {
  path: string;
  exists: boolean;
  installed: boolean;
  external: boolean;
}

export interface McpStatus {
  path: string;
  exists: boolean;
  installed: boolean;
  inFile: boolean;
  registeredAt: number | null;
  error: string | null;
  updateAvailable: boolean;
  cli: string | null;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ConnectStatus {
  mcpEntry: string;
  mcpEntryExists: boolean;
  server: McpServerEntry;
  shell: Record<ShellKind, ShellStatus>;
  mcp: Record<McpClient, McpStatus>;
}

export function mcpServerEntry(): McpServerEntry {
  return { command: config.nodeBin, args: [config.mcpEntry], env: { HUB_PORT: String(config.port) } };
}

let cachedProfile: string | null = null;

async function powershellProfile(): Promise<string> {
  if (cachedProfile) return cachedProfile;
  const fallback = join(config.homeDir, "Documents", "WindowsPowerShell", "profile.ps1");
  if (process.platform !== "win32" || process.env.HUB_HOME) {
    cachedProfile = process.platform === "win32" ? fallback : join(config.homeDir, ".config", "powershell", "profile.ps1");
    return cachedProfile;
  }
  try {
    const { stdout } = await run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", "$PROFILE.CurrentUserAllHosts"],
      { timeout: 8_000, windowsHide: true },
    );
    cachedProfile = stdout.trim().length > 0 ? stdout.trim() : fallback;
  } catch {
    cachedProfile = fallback;
  }
  return cachedProfile;
}

async function shellRcPath(kind: ShellKind): Promise<string> {
  return kind === "bash" ? join(config.homeDir, ".bashrc") : powershellProfile();
}

function shellBlock(kind: ShellKind, workspacesRoot: string | null): string {
  const script = join(config.shellDir, kind === "bash" ? "wk.sh" : "wk.ps1").replace(/\\/g, "/");
  const lines = [BLOCK_START];
  if (kind === "bash") {
    if (workspacesRoot) lines.push(`export WORKSPACES_ROOT="${workspacesRoot.replace(/\\/g, "/")}"`);
    lines.push(`[ -f "${script}" ] && . "${script}"`);
  } else {
    if (workspacesRoot) lines.push(`$env:WORKSPACES_ROOT = "${workspacesRoot}"`);
    lines.push(`if (Test-Path "${script}") { . "${script}" }`);
  }
  lines.push(BLOCK_END);
  return lines.join("\n");
}

function stripBlock(text: string): string {
  const start = text.indexOf(BLOCK_START);
  if (start < 0) return text;
  const end = text.indexOf(BLOCK_END, start);
  if (end < 0) return text;
  const after = end + BLOCK_END.length;
  const head = text.slice(0, start).replace(/\n+$/, "\n");
  const tail = text.slice(after).replace(/^\n+/, "");
  return `${head}${tail}`;
}

function hasExternalWk(text: string, kind: ShellKind): boolean {
  const stripped = stripBlock(text);
  return kind === "bash"
    ? /^\s*(alias\s+wk=|wk\s*\(\)|workspace\s*\(\))/m.test(stripped)
    : /^\s*(function\s+wk\b|Set-Alias\s+(-Name\s+)?wk\b)/im.test(stripped);
}

const readText = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

export async function shellStatus(kind: ShellKind): Promise<ShellStatus> {
  const path = await shellRcPath(kind);
  const text = readText(path);
  return {
    path,
    exists: existsSync(path),
    installed: text.includes(BLOCK_START),
    external: hasExternalWk(text, kind),
  };
}

export async function configureShell(
  kind: ShellKind,
  action: ConnectAction,
  workspacesRoot: string | null,
): Promise<ShellStatus> {
  const path = await shellRcPath(kind);
  const current = stripBlock(readText(path));
  const next =
    action === "install"
      ? `${current.trimEnd()}${current.trim().length > 0 ? "\n\n" : ""}${shellBlock(kind, workspacesRoot)}\n`
      : current;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return shellStatus(kind);
}

type JsonObject = Record<string, unknown>;

function readJsonObject(path: string): JsonObject | null {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
  } catch {
    return null;
  }
}

function mcpConfigPath(client: McpClient): string {
  if (client === "claude-code") return config.claudeConfigPath;
  if (client === "claude-desktop") return config.claudeDesktopConfigPath;
  return config.codexConfigPath;
}

const CODEX_BLOCK = /\n?\[mcp_servers\.cchub\][\s\S]*?(?=\n\[(?!mcp_servers\.cchub)|\s*$)/;

function codexBlock(entry: McpServerEntry): string {
  const literal = (value: string): string => `'${value}'`;
  const env = Object.entries(entry.env)
    .map(([key, value]) => `${key} = "${value}"`)
    .join("\n");
  return `\n[mcp_servers.${MCP_NAME}]\ncommand = ${literal(entry.command)}\nargs = [${entry.args.map(literal).join(", ")}]\n\n[mcp_servers.${MCP_NAME}.env]\n${env}\n`;
}

const registrationKey = (client: McpClient): string => `mcpRegistered:${client}`;

function registeredAt(client: McpClient): number | null {
  const value = Number(getSetting(registrationKey(client)) ?? "");
  return Number.isFinite(value) && value > 0 ? value : null;
}

const isJsonObject = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isJsonObject(value) && Object.values(value).every((item) => typeof item === "string");

function entryOf(value: unknown): McpServerEntry | null {
  if (!isJsonObject(value) || typeof value.command !== "string") return null;
  const args = Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === "string") : [];
  return { command: value.command, args, env: isStringRecord(value.env) ? { ...value.env } : {} };
}

const sortedEnv = (env: Record<string, string>): string => JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));

export function sameMcpEntry(a: McpServerEntry, b: McpServerEntry): boolean {
  return a.command === b.command && a.args.length === b.args.length && a.args.every((arg, index) => arg === b.args[index]) && sortedEnv(a.env) === sortedEnv(b.env);
}

class TomlCursor {
  at = 0;
  constructor(readonly text: string) {}
  get char(): string {
    return this.text[this.at] ?? "";
  }
  get done(): boolean {
    return this.at >= this.text.length;
  }
}

function skipFiller(cursor: TomlCursor): void {
  while (!cursor.done) {
    if (cursor.char === "#") {
      const end = cursor.text.indexOf("\n", cursor.at);
      cursor.at = end < 0 ? cursor.text.length : end;
    } else if (/[\s,]/.test(cursor.char)) cursor.at += 1;
    else return;
  }
}

const TOML_ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

function parseBasicString(cursor: TomlCursor): string {
  let out = "";
  cursor.at += 1;
  while (!cursor.done) {
    const char = cursor.char;
    if (char === '"') {
      cursor.at += 1;
      return out;
    }
    if (char !== "\\") {
      out += char;
      cursor.at += 1;
      continue;
    }
    const code = cursor.text[cursor.at + 1] ?? "";
    if (code === "u" || code === "U") {
      const size = code === "u" ? 4 : 8;
      out += String.fromCodePoint(Number.parseInt(cursor.text.slice(cursor.at + 2, cursor.at + 2 + size), 16));
      cursor.at += 2 + size;
      continue;
    }
    out += TOML_ESCAPES[code] ?? code;
    cursor.at += 2;
  }
  throw new Error("unterminated TOML string");
}

function parseLiteralString(cursor: TomlCursor): string {
  const close = cursor.text.indexOf("'", cursor.at + 1);
  if (close < 0) throw new Error("unterminated TOML string");
  const out = cursor.text.slice(cursor.at + 1, close);
  cursor.at = close + 1;
  return out;
}

function parseTomlKey(cursor: TomlCursor): string {
  if (cursor.char === '"') return parseBasicString(cursor);
  if (cursor.char === "'") return parseLiteralString(cursor);
  const match = /^[A-Za-z0-9_-]+/.exec(cursor.text.slice(cursor.at));
  if (!match) throw new Error("invalid TOML key");
  cursor.at += match[0].length;
  return match[0];
}

function parseTomlPairs(cursor: TomlCursor, close: string | null): JsonObject {
  const table: JsonObject = {};
  for (;;) {
    skipFiller(cursor);
    if (cursor.done) {
      if (close !== null) throw new Error("unterminated TOML table");
      return table;
    }
    if (close !== null && cursor.char === close) {
      cursor.at += 1;
      return table;
    }
    const key = parseTomlKey(cursor);
    skipFiller(cursor);
    if (cursor.char !== "=") throw new Error("invalid TOML pair");
    cursor.at += 1;
    table[key] = parseTomlValue(cursor);
  }
}

function parseTomlValue(cursor: TomlCursor): unknown {
  skipFiller(cursor);
  const char = cursor.char;
  if (char === '"') return parseBasicString(cursor);
  if (char === "'") return parseLiteralString(cursor);
  if (char === "{") {
    cursor.at += 1;
    return parseTomlPairs(cursor, "}");
  }
  if (char === "[") {
    cursor.at += 1;
    const items: unknown[] = [];
    for (;;) {
      skipFiller(cursor);
      if (cursor.done) throw new Error("unterminated TOML array");
      if (cursor.char === "]") {
        cursor.at += 1;
        return items;
      }
      items.push(parseTomlValue(cursor));
    }
  }
  const match = /^[^\s,\]}#]+/.exec(cursor.text.slice(cursor.at));
  if (!match) throw new Error("invalid TOML value");
  cursor.at += match[0].length;
  return match[0];
}

const TOML_HEADER = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/;

function tomlTables(text: string): Map<string, string> {
  const tables = new Map<string, string>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const header = TOML_HEADER.exec(line);
    if (header) {
      current = (header[1] ?? "").replace(/\s+/g, "");
      if (!tables.has(current)) tables.set(current, "");
      continue;
    }
    if (current !== null) tables.set(current, `${tables.get(current) ?? ""}${line}\n`);
  }
  return tables;
}

export function codexRegisteredEntry(text: string): McpServerEntry | null {
  const tables = tomlTables(text);
  const body = tables.get(`mcp_servers.${MCP_NAME}`);
  if (body === undefined) return null;
  try {
    const main = parseTomlPairs(new TomlCursor(body), null);
    const envBody = tables.get(`mcp_servers.${MCP_NAME}.env`);
    const envTable = envBody === undefined ? {} : parseTomlPairs(new TomlCursor(envBody), null);
    const env = { ...(isStringRecord(main.env) ? main.env : {}), ...(isStringRecord(envTable) ? envTable : {}) };
    return entryOf({ ...main, env });
  } catch {
    return null;
  }
}

interface CliTool {
  bin: string;
  prefix: readonly string[];
}

const CLI_TIMEOUT_MS = 30_000;

function findExecutable(bin: string): string | null {
  if (isAbsolute(bin) || /[\\/]/.test(bin)) return existsSync(bin) ? bin : null;
  const names = process.platform === "win32" ? (/\.(exe|com)$/i.test(bin) ? [bin] : [`${bin}.exe`, `${bin}.com`]) : [bin];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function cliFor(client: McpClient): CliTool | null {
  if (client === "claude-desktop") return null;
  const bin = findExecutable(client === "claude-code" ? config.claudeBin : config.codexBin);
  if (!bin) return null;
  return { bin, prefix: client === "claude-code" ? config.claudeArgsPrefix : config.codexArgsPrefix };
}

function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: config.codexHome };
  if (process.env.HUB_HOME) {
    env.HOME = config.homeDir;
    env.USERPROFILE = config.homeDir;
    delete env.CLAUDE_CONFIG_DIR;
  }
  return env;
}

function runCli(tool: CliTool, args: string[]): void {
  const result = spawnSync(tool.bin, [...tool.prefix, ...args], {
    env: cliEnv(),
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const command = args.slice(0, 2).join(" ");
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim() || `exit code ${result.status ?? "unknown"}`;
    throw new Error(`${command} failed: ${detail}`);
  }
}

function cliAddArgs(client: McpClient, entry: McpServerEntry): string[] {
  if (client === "claude-code") {
    return ["mcp", "add-json", "-s", "user", MCP_NAME, JSON.stringify({ type: "stdio", command: entry.command, args: entry.args, env: entry.env })];
  }
  const env = Object.entries(entry.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  return ["mcp", "add", MCP_NAME, ...env, "--", entry.command, ...entry.args];
}

const cliRemoveArgs = (client: McpClient): string[] => (client === "claude-code" ? ["mcp", "remove", MCP_NAME, "-s", "user"] : ["mcp", "remove", MCP_NAME]);

function registeredEntry(client: McpClient, path: string): McpServerEntry | null {
  if (client === "codex") return codexRegisteredEntry(readText(path));
  const servers = readJsonObject(path)?.mcpServers;
  return isJsonObject(servers) ? entryOf(servers[MCP_NAME]) : null;
}

export function mcpStatus(client: McpClient): McpStatus {
  const path = mcpConfigPath(client);
  const exists = existsSync(path);
  const registered = registeredAt(client);
  const cli = cliFor(client)?.bin ?? null;
  const outdated = (inFile: boolean): boolean => {
    if (!inFile) return false;
    const current = registeredEntry(client, path);
    return current === null || !sameMcpEntry(current, mcpServerEntry());
  };
  if (client === "codex") {
    const inFile = /^\[mcp_servers\.cchub\]/m.test(readText(path));
    return { path, exists, installed: inFile, inFile, registeredAt: registered, error: null, updateAvailable: outdated(inFile), cli };
  }
  const json = readJsonObject(path);
  if (json === null) {
    return { path, exists, installed: false, inFile: false, registeredAt: registered, error: "config file is not valid JSON", updateAvailable: false, cli };
  }
  const inFile = isJsonObject(json.mcpServers) && MCP_NAME in json.mcpServers;
  const installed = inFile || (client === "claude-desktop" && registered !== null);
  return { path, exists, installed, inFile, registeredAt: registered, error: null, updateAvailable: outdated(inFile), cli };
}

function backupConfig(path: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
}

function writeMcpFile(client: McpClient, action: ConnectAction, path: string, entry: McpServerEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  if (client === "codex") {
    const current = readText(path).replace(CODEX_BLOCK, "");
    const next = action === "install" ? `${current.trimEnd()}\n${codexBlock(entry)}` : current;
    backupConfig(path);
    writeFileSync(path, next);
    return;
  }
  const json = readJsonObject(path);
  if (json === null) throw new Error(`${path} is not valid JSON; fix it by hand first`);
  const servers = isJsonObject(json.mcpServers) ? { ...json.mcpServers } : {};
  if (action === "install") {
    servers[MCP_NAME] = client === "claude-code" ? { type: "stdio", ...entry } : entry;
  } else {
    delete servers[MCP_NAME];
  }
  json.mcpServers = servers;
  backupConfig(path);
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
}

function registerWithCli(client: McpClient, action: ConnectAction, tool: CliTool, entry: McpServerEntry): void {
  if (mcpStatus(client).inFile) runCli(tool, cliRemoveArgs(client));
  if (action === "install") runCli(tool, cliAddArgs(client, entry));
}

export function configureMcp(client: McpClient, action: ConnectAction): McpStatus {
  const path = mcpConfigPath(client);
  const entry = mcpServerEntry();
  const tool = cliFor(client);
  if (tool) registerWithCli(client, action, tool, entry);
  else writeMcpFile(client, action, path, entry);
  setSetting(registrationKey(client), action === "install" ? String(Date.now()) : null);
  return mcpStatus(client);
}

export async function connectStatus(): Promise<ConnectStatus> {
  return {
    mcpEntry: config.mcpEntry,
    mcpEntryExists: existsSync(config.mcpEntry),
    server: mcpServerEntry(),
    shell: {
      bash: await shellStatus("bash"),
      powershell: await shellStatus("powershell"),
    },
    mcp: {
      "claude-code": mcpStatus("claude-code"),
      "claude-desktop": mcpStatus("claude-desktop"),
      codex: mcpStatus("codex"),
    },
  };
}
