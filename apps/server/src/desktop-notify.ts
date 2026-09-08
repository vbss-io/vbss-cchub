import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config } from "./config.js";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = config.resourceDir ? join(config.resourceDir, "scripts") : join(here, "..", "scripts");

export const DESKTOP_APP_ID = "io.vbss.cchub";
const TITLE_MAX = 120;
const BODY_MAX = 400;
const STATUS_CACHE_MS = 30_000;

export type PowerShellRunner = (args: string[]) => Promise<string>;

export interface DesktopNotifyStatus {
  supported: boolean;
  appId: string;
  toastsEnabled: boolean | null;
  appEnabled: boolean | null;
  registered: boolean | null;
  error: string | null;
}

export interface DesktopNotifyResult {
  ok: boolean;
  via: "windows-toast" | null;
  reason: string | null;
}

const defaultRunner: PowerShellRunner = async (args) => {
  const { stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
    windowsHide: true,
    timeout: 15_000,
  });
  return stdout;
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function createDesktopNotifier(runner: PowerShellRunner = defaultRunner, platform: NodeJS.Platform = process.platform) {
  let cached: { at: number; status: DesktopNotifyStatus } | null = null;
  const unsupported = (): DesktopNotifyStatus => ({ supported: false, appId: DESKTOP_APP_ID, toastsEnabled: null, appEnabled: null, registered: null, error: null });

  const status = async (force = false): Promise<DesktopNotifyStatus> => {
    if (platform !== "win32") return unsupported();
    if (!force && cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.status;
    let next: DesktopNotifyStatus;
    try {
      const out = await runner(["-File", join(scriptsDir, "toast-status.ps1"), "-AppId", DESKTOP_APP_ID]);
      const parsed = JSON.parse(out.trim()) as { toastsEnabled: boolean | null; appEnabled: boolean | null; registered: boolean | null };
      next = { supported: true, appId: DESKTOP_APP_ID, toastsEnabled: parsed.toastsEnabled ?? null, appEnabled: parsed.appEnabled ?? null, registered: parsed.registered ?? null, error: null };
    } catch (err) {
      next = { ...unsupported(), supported: true, error: err instanceof Error ? err.message : "status check failed" };
    }
    cached = { at: Date.now(), status: next };
    return next;
  };

  const show = async (title: string, body: string): Promise<DesktopNotifyResult> => {
    if (platform !== "win32") return { ok: false, via: null, reason: "desktop toasts are only implemented on Windows" };
    try {
      await runner(["-File", join(scriptsDir, "toast.ps1"), "-AppId", DESKTOP_APP_ID, "-Title", clip(title, TITLE_MAX), "-Body", clip(body, BODY_MAX)]);
      return { ok: true, via: "windows-toast", reason: null };
    } catch (err) {
      return { ok: false, via: null, reason: err instanceof Error ? err.message : "toast failed" };
    }
  };

  return { status, show };
}

export const desktopNotifier = createDesktopNotifier();
