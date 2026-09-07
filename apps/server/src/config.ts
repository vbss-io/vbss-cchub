import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";

const homeDir = process.env.HUB_HOME ?? homedir();
const dataDir = process.env.HUB_DATA_DIR ?? join(homeDir, ".vbss-cchub");
const resourceDir = process.env.HUB_RESOURCE_DIR ?? null;
const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const emptyTtlHours = Number(process.env.HUB_EMPTY_TTL_HOURS ?? 12);

function parseJsonStringArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function newestCodexBinary(): string | null {
  if (process.platform !== "win32") return null;
  const base = join(process.env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local"), "OpenAI", "Codex", "bin");
  try {
    const candidates = readdirSync(base)
      .map((entry) => join(base, entry, "codex.exe"))
      .filter((candidate) => existsSync(candidate))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

function claudeDesktopConfigPath(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homeDir, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return join(homeDir, ".config", "Claude", "claude_desktop_config.json");
}

const codexHome = process.env.CODEX_HOME ?? join(homeDir, ".codex");

export const config = {
  host: process.env.HUB_HOST ?? "0.0.0.0",
  port: Number(process.env.HUB_PORT ?? 4317),
  homeDir,
  dataDir,
  dbPath: join(dataDir, "hub.db"),
  sharePort: Number(process.env.HUB_SHARE_PORT ?? 4318),
  shareHost: process.env.HUB_SHARE_HOST ?? "0.0.0.0",
  binDir: join(dataDir, "bin"),
  ngrokBin: process.env.HUB_NGROK_BIN ?? null,
  ngrokArgsPrefix: JSON.parse(process.env.HUB_NGROK_ARGS_PREFIX ?? "[]") as string[],
  emptyTtlMs: Number.isFinite(emptyTtlHours) && emptyTtlHours > 0 ? emptyTtlHours * 3_600_000 : 0,
  staticDir: process.env.HUB_STATIC_DIR ?? (resourceDir ? join(resourceDir, "ui") : null),
  resourceDir,
  serverDir,
  nodeBin: execPath,
  mcpEntry: resourceDir ? join(resourceDir, "mcp.cjs") : join(serverDir, "dist", "mcp.js"),
  shellDir: resourceDir ? join(resourceDir, "shell") : join(serverDir, "shell"),
  delegationEnabled: process.env.HUB_DELEGATION === "1",
  claudeBin: process.env.HUB_CLAUDE_BIN ?? "claude",
  claudeArgsPrefix: parseJsonStringArray(process.env.HUB_CLAUDE_ARGS_PREFIX),
  codexBin: process.env.HUB_CODEX_BIN ?? newestCodexBinary() ?? "codex",
  codexArgsPrefix: parseJsonStringArray(process.env.HUB_CODEX_ARGS_PREFIX),
  trustedOrigins: parseList(process.env.HUB_TRUSTED_ORIGINS),
  workspacesRoot: process.env.HUB_WORKSPACES_ROOT ?? null,
  editorCommand: process.env.HUB_EDITOR ?? "code",
  secondBrainRoot: process.env.HUB_SECOND_BRAIN ?? null,
  claudeConfigPath: join(homeDir, ".claude.json"),
  claudeDesktopConfigPath: claudeDesktopConfigPath(),
  codexHome,
  codexConfigPath: join(codexHome, "config.toml"),
  codexSessionsDir: join(codexHome, "sessions"),
} as const;
