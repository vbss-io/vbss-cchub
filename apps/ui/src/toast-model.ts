import type { Isolation, Runner } from "./delegation";
import type { NotifEventKind } from "./notifications";
import type { TaskTone } from "./runs-model";
import { shortFolder } from "./wsmatch";

export type ToastSource = "session" | "task" | "share";

export interface ToastLook {
  tone: TaskTone;
  label: string;
  source: ToastSource;
  attention: boolean;
}

export const TOAST_LOOK: Readonly<Record<NotifEventKind, ToastLook>> = {
  sessionNeedsYou: { tone: "pend", label: "Needs you", source: "session", attention: true },
  sessionIdle: { tone: "unread", label: "Finished", source: "session", attention: false },
  sessionFinished: { tone: "muted", label: "Ended", source: "session", attention: false },
  taskCompleted: { tone: "unread", label: "Finished", source: "task", attention: false },
  taskFailed: { tone: "hold", label: "Failed", source: "task", attention: true },
  taskNeedsYou: { tone: "pend", label: "Needs you", source: "task", attention: true },
  shareAsk: { tone: "go", label: "Answering", source: "share", attention: false },
  shareImplement: { tone: "go", label: "Implementing", source: "share", attention: false },
};

const TITLE_PREFIX: Readonly<Record<NotifEventKind, string>> = {
  sessionNeedsYou: "Session needs you · ",
  sessionIdle: "Turn finished · ",
  sessionFinished: "",
  taskCompleted: "Delegated task finished · ",
  taskFailed: "Task failed · ",
  taskNeedsYou: "Task needs you · ",
  shareAsk: "Ask on share ",
  shareImplement: "Implement on share ",
};

const SOURCE_NAME: Readonly<Record<ToastSource, string>> = { session: "Session", task: "Delegated", share: "Share" };

const RUNNER_NAME: Readonly<Record<Runner, string>> = { claude: "Claude", codex: "Codex" };

export const TOAST_AUTO_MS = 6_000;
export const TOAST_ATTENTION_MS = 10_000;
export const TOAST_MAX_VISIBLE = 4;

export const toastLifetime = (kind: NotifEventKind): number => (TOAST_LOOK[kind].attention ? TOAST_ATTENTION_MS : TOAST_AUTO_MS);

export interface ToastTarget {
  hash: string;
  focus: boolean;
}

export function toastTarget(kind: NotifEventKind, id: string): ToastTarget {
  const source = TOAST_LOOK[kind].source;
  if (source === "share") return { hash: `#/share/${id}`, focus: false };
  if (source === "session") return { hash: "#/sessions", focus: true };
  return { hash: `#/tasks/${id}`, focus: false };
}

export function toastTime(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, Math.floor((now - at) / 1000)) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function toastStack<T>(cards: readonly T[], max: number = TOAST_MAX_VISIBLE): { hidden: number; visible: T[] } {
  const hidden = Math.max(0, cards.length - max);
  return { hidden, visible: cards.slice(hidden) };
}

export interface ToastContext {
  client: string;
  clientTitle: string;
  where: string | null;
  whereTitle: string | null;
  extras: readonly string[];
}

export interface ToastInput {
  kind: NotifEventKind;
  id: string;
  title: string;
  body: string;
  at: number;
}

export interface ToastMetaPart {
  key: string;
  text: string;
  title: string;
}

export interface ToastView {
  tone: TaskTone;
  label: string;
  source: ToastSource;
  title: string;
  reason: string | null;
  parts: ToastMetaPart[];
  extras: string[];
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function subjectOf(kind: NotifEventKind, title: string, body: string): string {
  const full = oneLine(title);
  if (kind === "sessionFinished") return oneLine(body) || full;
  const prefix = TITLE_PREFIX[kind];
  if (!title.startsWith(prefix)) return full;
  return oneLine(title.slice(prefix.length)) || full;
}

export function toastView(card: ToastInput, context: ToastContext | null, now: number): ToastView {
  const look = TOAST_LOOK[card.kind];
  const reason = card.kind === "sessionFinished" ? "" : oneLine(card.body);
  const time = toastTime(card.at, now);
  const client = context?.client ?? SOURCE_NAME[look.source];
  const parts: ToastMetaPart[] = [
    { key: "client", text: client, title: context?.clientTitle ?? client },
    ...(context?.where ? [{ key: "where", text: context.where, title: context.whereTitle ?? context.where }] : []),
    { key: "time", text: time, title: time },
  ];
  return {
    tone: look.tone,
    label: look.label,
    source: look.source,
    title: subjectOf(card.kind, card.title, card.body),
    reason: reason || null,
    parts,
    extras: [...(context?.extras ?? [])],
  };
}

export interface ToastSessionShape {
  cwd: string | null;
  agentsRunning?: number | null;
}

export function sessionToastContext(session: ToastSessionShape, client: string, clientTitle: string): ToastContext {
  const running = session.agentsRunning ?? 0;
  return {
    client,
    clientTitle,
    where: session.cwd ? shortFolder(session.cwd) : null,
    whereTitle: session.cwd,
    extras: running > 0 ? [`${running} subagent${running === 1 ? "" : "s"} running`] : [],
  };
}

export interface ToastTaskShape {
  workspace: string;
  cwd: string;
  runner: Runner;
  isolation: Isolation;
  branch: string | null;
}

export function taskToastContext(task: ToastTaskShape): ToastContext {
  return {
    client: SOURCE_NAME.task,
    clientTitle: `Delegated to ${RUNNER_NAME[task.runner]}`,
    where: task.workspace || (task.cwd ? shortFolder(task.cwd) : null),
    whereTitle: task.cwd || null,
    extras: task.isolation === "worktree" && task.branch ? [`worktree · ${task.branch}`] : [],
  };
}
