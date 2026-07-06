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

export async function focusWindow(
  hostPid: number | null,
  cwd: string | null,
): Promise<FocusResult> {
  if (process.platform !== "win32") return { ok: false, reason: "not windows" };
  if ((!hostPid || hostPid <= 0) && !cwd) {
    return { ok: false, reason: "no window hint (pid/cwd)" };
  }
  try {
    await run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      focusScript,
      "-HostPid",
      String(hostPid ?? 0),
      "-Cwd",
      cwd ?? "",
    ]);
    return { ok: true };
  } catch (error) {
    const code = (error as { code?: number }).code;
    return { ok: false, reason: code === 2 ? "window not found (session closed?)" : "focus failed" };
  }
}
