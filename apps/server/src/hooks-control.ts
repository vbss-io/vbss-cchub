import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config } from "./config.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const hooksDir = config.resourceDir ? join(config.resourceDir, "hooks") : join(here, "..", "hooks");
const configureScript = join(hooksDir, "configure.mjs");
const notifyShScript = join(hooksDir, "notify.sh");

export type HookAction = "status" | "install" | "uninstall";

interface WslResult {
  distro: string;
  installed?: boolean;
  error?: string;
}

const clean = (value: string): string => value.replace(/\0/g, "");

function winToWsl(winPath: string): string {
  const match = winPath.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return winPath;
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, "/")}`;
}

function parseLastJson(stdout: string): Record<string, unknown> {
  const lines = clean(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return {};
}

async function configure(action: HookAction, extra: string[] = []): Promise<Record<string, unknown>> {
  const { stdout } = await run(config.nodeBin, [configureScript, action, ...extra]);
  return parseLastJson(stdout);
}

async function listWslDistros(): Promise<string[]> {
  try {
    const { stdout } = await run("wsl", ["-l", "-q"], { timeout: 8000 });
    return clean(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((distro) => distro !== "docker-desktop" && distro !== "docker-desktop-data");
  } catch {
    return [];
  }
}

async function wslUser(distro: string): Promise<string | null> {
  try {
    const { stdout } = await run("wsl", ["-d", distro, "whoami"], { timeout: 25000 });
    return clean(stdout).trim() || null;
  } catch {
    return null;
  }
}

async function configureWsl(action: HookAction, distro: string): Promise<WslResult> {
  const user = await wslUser(distro);
  if (!user) return { distro, error: "user not found" };
  const settings = `\\\\wsl$\\${distro}\\home\\${user}\\.claude\\settings.json`;
  const notify = winToWsl(notifyShScript);
  try {
    const result = await configure(action, [
      "--settings",
      settings,
      "--notify",
      notify,
      "--runner",
      "sh",
      "--source",
      `wsl-${distro}`,
    ]);
    return { distro, installed: result.installed === true };
  } catch (error) {
    return { distro, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function windowsHooks(action: HookAction): Promise<Record<string, unknown>> {
  return configure(action, config.resourceDir ? ["--runner", config.nodeBin] : []);
}

export async function wslHooks(action: HookAction): Promise<WslResult[]> {
  const distros = await listWslDistros();
  return Promise.all(distros.map((distro) => configureWsl(action, distro)));
}

export function mergeHooks(
  windows: Record<string, unknown>,
  wsl: WslResult[],
): Record<string, unknown> {
  return { ...windows, installed: windows.installed === true, wsl };
}

