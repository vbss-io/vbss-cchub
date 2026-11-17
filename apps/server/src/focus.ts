import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config } from "./config.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const focusScript = config.resourceDir
  ? join(config.resourceDir, "scripts", "focus.ps1")
  : join(here, "..", "scripts", "focus.ps1");

export interface FocusResult {
  ok: boolean;
  reason?: string;
}

export type FocusRunner = (file: string, args: string[], options: { windowsHide: boolean; timeout: number }) => Promise<unknown>;

export async function focusWindow(
  hostPid: number | null,
  cwd: string | null,
  runner: FocusRunner = run,
  platform: NodeJS.Platform = process.platform,
): Promise<FocusResult> {
  if (platform !== "win32") return { ok: false, reason: "not windows" };
  if ((!hostPid || hostPid <= 0) && !cwd) {
    return { ok: false, reason: "no window hint (pid/cwd)" };
  }
  try {
    await runner("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      focusScript,
      "-HostPid",
      String(hostPid ?? 0),
      "-Cwd",
      cwd ?? "",
    ], { windowsHide: true, timeout: 15_000 });
    return { ok: true };
  } catch (error) {
    const code = (error as { code?: number }).code;
    return { ok: false, reason: code === 2 ? "window not found (session closed?)" : "focus failed" };
  }
}
