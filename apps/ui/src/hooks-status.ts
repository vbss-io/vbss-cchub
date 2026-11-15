import type { HooksStatus } from "./types";

export const HOOK_EVENTS_HINT =
  "session start, prompts, notifications (such as permission prompts), stops and failed stops, subagent start and stop, session end";

export interface HooksView {
  tag: string;
  tone: "go" | "warn" | "muted";
  action: string;
  detail: string | null;
}

export const hooksView = (hooks: HooksStatus | null): HooksView => {
  if (!hooks) return { tag: "checking", tone: "muted", action: "Install hooks", detail: null };
  if (hooks.installed) return { tag: "installed", tone: "go", action: "Remove hooks", detail: `${hooks.events.length} events` };
  if (hooks.outdated) {
    const missing = hooks.missing ?? [];
    return { tag: "update available", tone: "warn", action: "Update hooks", detail: missing.length > 0 ? `missing ${missing.join(", ")}` : null };
  }
  return { tag: "not installed", tone: "muted", action: "Install hooks", detail: null };
};
