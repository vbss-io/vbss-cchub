import type { CodexHooksStatus, CodexSessionRecord, OpenSessionResult, SessionRecord } from "./types";

export const APPROVAL_WINDOW_MIN = 0;
export const APPROVAL_WINDOW_MAX = 1800;

export function parseWindow(value: string): number | null {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const seconds = Number(text);
  return seconds >= APPROVAL_WINDOW_MIN && seconds <= APPROVAL_WINDOW_MAX ? seconds : null;
}

export function windowHint(seconds: number): string {
  if (seconds === 0) return "Off: the hook does not wait and the prompt stays where it was. Nothing is approved for you.";
  if (seconds < 60) return `Waits up to ${seconds} seconds for your answer here.`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `Waits up to ${minutes} minute${minutes === 1 ? "" : "s"}${rest > 0 ? ` ${rest} s` : ""} for your answer here.`;
}

export type HooksTone = "go" | "pend" | "hold" | "muted";

export interface CodexHooksView {
  tag: string;
  tone: HooksTone;
  detail: string | null;
  canInstall: boolean;
  installLabel: string;
  canRemove: boolean;
}

export function codexHooksView(status: CodexHooksStatus | null): CodexHooksView {
  if (!status) return { tag: "checking", tone: "muted", detail: null, canInstall: false, installLabel: "Install hooks", canRemove: false };
  if (status.error) return { tag: "unreadable", tone: "hold", detail: status.error, canInstall: false, installLabel: "Install hooks", canRemove: false };
  if (status.installed) return { tag: "installed", tone: "go", detail: `${status.events.length} events`, canInstall: false, installLabel: "Install hooks", canRemove: true };
  if (status.updateAvailable) {
    return { tag: "update available", tone: "pend", detail: status.missing.length > 0 ? `outdated ${status.missing.join(", ")}` : null, canInstall: true, installLabel: "Update hooks", canRemove: true };
  }
  return { tag: "not installed", tone: "muted", detail: null, canInstall: true, installLabel: "Install hooks", canRemove: false };
}

export function backupNote(status: CodexHooksStatus | null): string | null {
  if (!status?.hasBackup) return null;
  return `A copy of your hooks file from before the install is at ${status.backupPath}. Remove puts it back exactly.`;
}

export type OpenOutcome = { kind: "opened"; text: string } | { kind: "failed"; text: string };

const OPEN_REASON: Readonly<Record<string, string>> = {
  "link scheme not allowed": "The hub refused to open that link.",
  "no url opener": "This machine has no way to open links from the hub.",
  "the link could not be opened": "The app did not take the link. Check that it is installed and open it once.",
  "the Codex app is not running": "The Codex app is not running. Open it, then try again.",
};

export function openOutcome(result: OpenSessionResult): OpenOutcome {
  if (result.ok) {
    return { kind: "opened", text: result.method === "deep-link" ? "Opened in the app." : "Brought the window to the front." };
  }
  const reason = result.reason ?? "";
  return { kind: "failed", text: OPEN_REASON[reason] ?? (reason.length > 0 ? `Could not open the session: ${reason}.` : "Could not open the session.") };
}

export type CodexReplyCode = "not-hub-thread" | "not-current-thread" | "open-elsewhere" | "busy";

export const CODEX_REPLY_CODES: readonly CodexReplyCode[] = ["not-hub-thread", "not-current-thread", "open-elsewhere", "busy"];

export const isReplyCode = (value: unknown): value is CodexReplyCode => typeof value === "string" && (CODEX_REPLY_CODES as readonly string[]).includes(value);

export interface ReplyBlock {
  text: string;
  offerOpen: boolean;
}

const REPLY_BLOCK: Readonly<Record<CodexReplyCode, ReplyBlock>> = {
  "not-hub-thread": { text: "The hub did not start this thread, so replying here could put two writers on it.", offerOpen: true },
  "not-current-thread": { text: "This is no longer the task's current Codex thread.", offerOpen: true },
  "open-elsewhere": { text: "This thread is open in the Codex app or CLI. Reply there so only one side writes to it.", offerOpen: true },
  busy: { text: "The run is still working. Reply once it stops.", offerOpen: false },
};

export function replyBlock(code: CodexReplyCode | null, fallback: string): ReplyBlock {
  return code ? REPLY_BLOCK[code] : { text: fallback || "The reply was not sent.", offerOpen: false };
}

export const canReplyToCodex = (thread: Pick<CodexSessionRecord, "origin" | "hubTaskId" | "archivedAt">): boolean =>
  thread.origin === "hub" && thread.hubTaskId !== null && thread.archivedAt === null;

export const canOpenSession = (session: Pick<SessionRecord, "status" | "archivedAt"> & { stale?: boolean }): boolean =>
  session.archivedAt === null && session.status !== "ended" && session.stale !== true;

export const canOpenCodex = (thread: Pick<CodexSessionRecord, "status" | "archivedAt">): boolean => thread.archivedAt === null && thread.status !== "ended";
