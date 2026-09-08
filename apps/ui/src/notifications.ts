import { notify, playSound, type SoundKind } from "./notify";

export type NotifEventKind =
  | "sessionNeedsYou"
  | "sessionFinished"
  | "taskCompleted"
  | "taskFailed"
  | "taskNeedsYou"
  | "shareAsk"
  | "shareImplement";

export type NotifStyle = "cchub" | "windows" | "both";

export const DEFAULT_NOTIF_STYLE: NotifStyle = "cchub";

export interface NotifEventConfig {
  enabled: boolean;
  desktop: boolean;
  sound: boolean;
  style: NotifStyle;
  events: Record<NotifEventKind, boolean>;
}

export interface NotifEventPayload {
  id: string;
  title?: string;
  name?: string;
  label?: string;
  detail?: string | null;
  asker?: string | null;
  sound?: SoundKind;
}

export interface FiredEvent {
  kind: NotifEventKind;
  id: string;
  title: string;
  body: string;
  at: number;
}

export interface NotifEventMeta {
  kind: NotifEventKind;
  label: string;
  description: string;
}

export const DEFAULT_NOTIF_EVENTS: Record<NotifEventKind, boolean> = {
  sessionNeedsYou: true,
  sessionFinished: false,
  taskCompleted: true,
  taskFailed: true,
  taskNeedsYou: true,
  shareAsk: true,
  shareImplement: true,
};

export const NOTIF_EVENT_META: NotifEventMeta[] = [
  { kind: "sessionNeedsYou", label: "Session needs you", description: "A session is waiting on a decision or went idle" },
  { kind: "sessionFinished", label: "Session finished", description: "A session ended" },
  { kind: "taskCompleted", label: "Delegated task finished", description: "A delegated task completed" },
  { kind: "taskFailed", label: "Delegated task failed", description: "A delegated task ended in error" },
  { kind: "taskNeedsYou", label: "Delegated task needs you", description: "A delegated task stopped and wants your input" },
  { kind: "shareAsk", label: "Ask on a share", description: "Someone asked a question through a share link" },
  { kind: "shareImplement", label: "Implement on a share", description: "Someone requested work through a share link" },
];

const DEDUPE_MS = 30_000;

const DEFAULT_SOUND: Record<NotifEventKind, SoundKind> = {
  sessionNeedsYou: "attention",
  sessionFinished: "finished",
  taskCompleted: "finished",
  taskFailed: "attention",
  taskNeedsYou: "attention",
  shareAsk: "attention",
  shareImplement: "attention",
};

function firstLine(text: string | null | undefined): string {
  if (!text) return "";
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  return line.length > 140 ? `${line.slice(0, 137)}…` : line;
}

export function buildNotification(kind: NotifEventKind, payload: NotifEventPayload): { title: string; body: string; sound: SoundKind } {
  const title = payload.title ?? "";
  const name = payload.name ?? "";
  const label = payload.label ?? "";
  const asker = payload.asker ?? "someone";
  const detail = firstLine(payload.detail);
  const sound = payload.sound ?? DEFAULT_SOUND[kind];
  switch (kind) {
    case "sessionNeedsYou":
      return { title: `Session needs you · ${name}`, body: detail, sound };
    case "sessionFinished":
      return { title: "Session finished", body: name, sound };
    case "taskCompleted":
      return { title: `Delegated task finished · ${title}`, body: detail, sound };
    case "taskFailed":
      return { title: `Task failed · ${title}`, body: detail, sound };
    case "taskNeedsYou":
      return { title: `Task needs you · ${title}`, body: detail, sound };
    case "shareAsk":
      return { title: `Ask on share ${label}`, body: detail ? `${asker}: ${detail}` : asker, sound };
    case "shareImplement":
      return { title: `Implement on share ${label}`, body: detail ? `${asker}: ${detail}` : asker, sound };
  }
}

export interface NotifierDeps {
  getConfig: () => NotifEventConfig | null;
  send: (title: string, body: string) => void | Promise<void>;
  sound: (kind: SoundKind) => void | Promise<void>;
  now: () => number;
  onFired?: (record: FiredEvent) => void;
}

export interface Notifier {
  notifyEvent: (kind: NotifEventKind, payload: NotifEventPayload) => void;
  reset: () => void;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const lastFired = new Map<string, number>();
  const notifyEvent = (kind: NotifEventKind, payload: NotifEventPayload): void => {
    const cfg = deps.getConfig();
    if (!cfg || !cfg.enabled || !cfg.events[kind]) return;
    const key = `${kind}:${payload.id}`;
    const at = deps.now();
    const prev = lastFired.get(key);
    if (prev !== undefined && at - prev < DEDUPE_MS) return;
    lastFired.set(key, at);
    const built = buildNotification(kind, payload);
    const windowsOn = cfg.style === "windows" || cfg.style === "both";
    if (cfg.desktop && windowsOn) void deps.send(built.title, built.body);
    if (cfg.sound) void deps.sound(built.sound);
    deps.onFired?.({ kind, id: payload.id, title: built.title, body: built.body, at });
  };
  return { notifyEvent, reset: () => lastFired.clear() };
}

let sharedConfig: NotifEventConfig | null = null;

export function setNotifConfig(config: NotifEventConfig): void {
  sharedConfig = config;
}

export function loadNotifEventConfig(): NotifEventConfig {
  try {
    const stored = JSON.parse(localStorage.getItem("hub.notifications") ?? "{}") as Partial<NotifEventConfig>;
    return {
      enabled: stored.enabled ?? true,
      desktop: stored.desktop ?? true,
      sound: stored.sound ?? true,
      style: stored.style ?? DEFAULT_NOTIF_STYLE,
      events: { ...DEFAULT_NOTIF_EVENTS, ...(stored.events ?? {}) },
    };
  } catch {
    return { enabled: true, desktop: true, sound: true, style: DEFAULT_NOTIF_STYLE, events: { ...DEFAULT_NOTIF_EVENTS } };
  }
}

const firedLog: FiredEvent[] = [];

export function firedEvents(): FiredEvent[] {
  return [...firedLog];
}

export function resetFired(): void {
  firedLog.length = 0;
}

const defaultNotifier = createNotifier({
  getConfig: () => sharedConfig,
  send: (title, body) => void notify(title, body),
  sound: playSound,
  now: () => Date.now(),
  onFired: (record) => {
    firedLog.push(record);
    if (firedLog.length > 50) firedLog.shift();
  },
});

export const notifyEvent = defaultNotifier.notifyEvent;
