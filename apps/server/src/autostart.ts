import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const run = promisify(execFile);

export interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  exe: string | null;
  error: string | null;
}

const RUN_KEY = process.env.HUB_AUTOSTART_KEY ?? "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "VBSS CCHUB";

const psLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const powershell = (command: string): Promise<{ stdout: string }> =>
  run("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout: 15_000, windowsHide: true });

export function appExecutable(): string | null {
  const fromEnv = process.env.HUB_APP_EXE?.replace(/^\\\\\?\\/, "");
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (config.resourceDir) {
    const beside = join(dirname(config.resourceDir), "vbss-cchub.exe");
    if (existsSync(beside)) return beside;
  }
  return null;
}

export async function autostartStatus(): Promise<AutostartStatus> {
  const exe = appExecutable();
  if (platform() !== "win32") return { supported: false, enabled: false, exe, error: null };
  try {
    const { stdout } = await powershell(`(Get-ItemProperty -Path ${psLiteral(RUN_KEY)} -Name ${psLiteral(VALUE_NAME)} -ErrorAction SilentlyContinue).${psLiteral(VALUE_NAME)}`);
    const value = stdout.trim().replace(/^"|"$/g, "").toLowerCase();
    const enabled = value.length > 0 && (exe === null || value === exe.toLowerCase());
    return { supported: exe !== null, enabled, exe, error: null };
  } catch (err) {
    return { supported: exe !== null, enabled: false, exe, error: err instanceof Error ? err.message : "registry read failed" };
  }
}

export async function setAutostart(enabled: boolean): Promise<AutostartStatus> {
  const exe = appExecutable();
  if (platform() !== "win32") return { supported: false, enabled: false, exe, error: "start with the OS is only wired for Windows" };
  if (enabled && !exe) return { supported: false, enabled: false, exe, error: "the app executable was not found; use the installed app" };
  try {
    if (enabled) {
      await powershell(
        `if (-not (Test-Path ${psLiteral(RUN_KEY)})) { New-Item -Path ${psLiteral(RUN_KEY)} | Out-Null }; Set-ItemProperty -Path ${psLiteral(RUN_KEY)} -Name ${psLiteral(VALUE_NAME)} -Value ${psLiteral(`"${exe}"`)}`,
      );
    } else {
      await powershell(`Remove-ItemProperty -Path ${psLiteral(RUN_KEY)} -Name ${psLiteral(VALUE_NAME)} -ErrorAction SilentlyContinue`);
    }
  } catch (err) {
    return { supported: true, enabled: false, exe, error: err instanceof Error ? err.message : "registry write failed" };
  }
  return autostartStatus();
}
