import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

export function mcpStatus(client: McpClient): McpStatus {
  const path = mcpConfigPath(client);
  const exists = existsSync(path);
  const registered = registeredAt(client);
  if (client === "codex") {
    const inFile = /^\[mcp_servers\.cchub\]/m.test(readText(path));
    return { path, exists, installed: inFile, inFile, registeredAt: registered, error: null };
  }
  const json = readJsonObject(path);
  if (json === null) {
    return { path, exists, installed: false, inFile: false, registeredAt: registered, error: "config file is not valid JSON" };
  }
  const servers = json.mcpServers;
  const inFile =
    !!servers && typeof servers === "object" && !Array.isArray(servers) && MCP_NAME in (servers as JsonObject);
  const installed = inFile || (client === "claude-desktop" && registered !== null);
  return { path, exists, installed, inFile, registeredAt: registered, error: null };
}

export function configureMcp(client: McpClient, action: ConnectAction): McpStatus {
  const path = mcpConfigPath(client);
  const entry = mcpServerEntry();
  mkdirSync(dirname(path), { recursive: true });
  setSetting(registrationKey(client), action === "install" ? String(Date.now()) : null);
  if (client === "codex") {
    const current = readText(path).replace(CODEX_BLOCK, "");
    const next = action === "install" ? `${current.trimEnd()}\n${codexBlock(entry)}` : current;
    writeFileSync(path, next);
    return mcpStatus(client);
  }
  const json = readJsonObject(path);
  if (json === null) throw new Error(`${path} is not valid JSON; fix it by hand first`);
  const servers =
    json.mcpServers && typeof json.mcpServers === "object" && !Array.isArray(json.mcpServers)
      ? { ...(json.mcpServers as JsonObject) }
      : {};
  if (action === "install") {
    servers[MCP_NAME] = client === "claude-code" ? { type: "stdio", ...entry } : entry;
  } else {
    delete servers[MCP_NAME];
  }
  json.mcpServers = servers;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
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
