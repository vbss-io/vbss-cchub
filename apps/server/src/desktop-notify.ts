import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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

export const NATIVE_SUBJECT_KINDS = ["sessionNeedsYou", "taskNeedsYou", "taskFailed"] as const;
export type NativeSubjectKind = (typeof NATIVE_SUBJECT_KINDS)[number];

export interface NativeSubject {
  kind: NativeSubjectKind;
  id: string;
}

export type NativeFact = { type: "session"; id: string; status: string | null } | { type: "task"; id: string; status: string | null; archived: boolean };

export interface NativeTaskShape {
  status: string;
  archivedAt: number | null;
}

const SUBJECT_ID_MAX = 200;
const TAG_MAX = 64;
const SAFE_TAG = /^[A-Za-z0-9._:-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseNativeSubject(value: unknown): NativeSubject | null {
  if (!isRecord(value)) return null;
  const kind = NATIVE_SUBJECT_KINDS.find((item) => item === value.kind) ?? null;
  const id = typeof value.id === "string" && value.id.length > 0 && value.id.length <= SUBJECT_ID_MAX ? value.id : null;
  return kind && id ? { kind, id } : null;
}

export function nativeTag(subject: NativeSubject): { tag: string; group: string } {
  const tag = subject.id.length <= TAG_MAX && SAFE_TAG.test(subject.id) ? subject.id : createHash("sha1").update(subject.id).digest("hex");
  return { tag, group: subject.kind };
}

export function nativeReasonGone(subject: NativeSubject, fact: NativeFact): boolean {
  if (subject.id !== fact.id) return false;
  if (fact.type === "session") return subject.kind === "sessionNeedsYou" && fact.status !== "waiting";
  if (subject.kind === "taskNeedsYou") return fact.archived || fact.status !== "attention";
  if (subject.kind === "taskFailed") return fact.archived || fact.status !== "failed";
  return false;
}

const subjectKey = (subject: NativeSubject): string => `${subject.kind}:${subject.id}`;

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

  const shown = new Map<string, NativeSubject>();
  const script = join(scriptsDir, "toast.ps1");

  const show = async (title: string, body: string, subject: NativeSubject | null = null): Promise<DesktopNotifyResult> => {
    if (platform !== "win32") return { ok: false, via: null, reason: "desktop toasts are only implemented on Windows" };
    const tagged = subject ? nativeTag(subject) : null;
    const tagArgs = tagged ? ["-Tag", tagged.tag, "-Group", tagged.group] : [];
    try {
      await runner(["-File", script, "-AppId", DESKTOP_APP_ID, "-Title", clip(title, TITLE_MAX), "-Body", clip(body, BODY_MAX), ...tagArgs]);
      if (subject) shown.set(subjectKey(subject), subject);
      return { ok: true, via: "windows-toast", reason: null };
    } catch (err) {
      return { ok: false, via: null, reason: err instanceof Error ? err.message : "toast failed" };
    }
  };

  const settle = async (fact: NativeFact): Promise<number> => {
    const gone = [...shown.values()].filter((subject) => nativeReasonGone(subject, fact));
    for (const subject of gone) {
      shown.delete(subjectKey(subject));
      const { tag, group } = nativeTag(subject);
      try {
        await runner(["-File", script, "-AppId", DESKTOP_APP_ID, "-Tag", tag, "-Group", group, "-Remove"]);
      } catch {
        continue;
      }
    }
    return gone.length;
  };

  const watches = (type: NativeFact["type"], id: string): boolean =>
    [...shown.values()].some((subject) => subject.id === id && (type === "session" ? subject.kind === "sessionNeedsYou" : subject.kind !== "sessionNeedsYou"));

  const observe = (event: string, data: unknown, lookupTask: (id: string) => NativeTaskShape | null): Promise<number> => {
    if (shown.size === 0 || !isRecord(data)) return Promise.resolve(0);
    const sessionId = typeof data.sessionId === "string" ? data.sessionId : null;
    if (event === "session" && sessionId && watches("session", sessionId)) return settle({ type: "session", id: sessionId, status: typeof data.status === "string" ? data.status : null });
    if (event === "removed" && sessionId && watches("session", sessionId)) return settle({ type: "session", id: sessionId, status: null });
    const taskId = typeof data.taskId === "string" ? data.taskId : null;
    if (event === "delegation" && taskId && watches("task", taskId)) {
      const task = lookupTask(taskId);
      return settle({ type: "task", id: taskId, status: task?.status ?? null, archived: task ? task.archivedAt != null : false });
    }
    return Promise.resolve(0);
  };

  return { status, show, settle, observe, tracked: (): NativeSubject[] => [...shown.values()] };
}

export const desktopNotifier = createDesktopNotifier();
