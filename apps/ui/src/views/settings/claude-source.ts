import type { ClaudeLimitsSource } from "../../delegation";

export interface StatuslineButton {
  label: string;
  action: "install" | "uninstall";
}

export interface ClaudeSourceRow {
  tag: string;
  tone: "go" | "warn" | "muted";
  primary: StatuslineButton | null;
  secondary: StatuslineButton | null;
  detail: string | null;
}

export const STATUSLINE_HELP =
  "Claude Code passes your plan limits (rate_limits.five_hour and seven_day) to the status line on every update. The hub's statusline wrapper sends them to the hub and then runs the statusline you already had with the same input, printing its output unchanged. Removing it puts your previous statusline back exactly. Nothing is changed until you click.";

export const FALLBACK_HELP =
  "When the status line has not reported for a while, the hub can still ask Anthropic's private usage endpoint with your local Claude Code login. Turn this off to use only the status line.";

const remove: StatuslineButton = { label: "Remove statusline", action: "uninstall" };

export function claudeSourceRow(source: ClaudeLimitsSource | null): ClaudeSourceRow {
  if (!source) return { tag: "checking", tone: "muted", primary: null, secondary: null, detail: null };
  const status = source.statusline;
  if (status.error) return { tag: "cannot read settings", tone: "warn", primary: null, secondary: null, detail: status.error };
  const detail = status.previousCommand ? `chains ${status.previousCommand}` : null;
  if (status.state === "installed") return { tag: "installed", tone: "go", primary: remove, secondary: null, detail };
  if (status.state === "outdated") return { tag: "update available", tone: "warn", primary: { label: "Update statusline", action: "install" }, secondary: remove, detail };
  return { tag: "not installed", tone: "muted", primary: { label: "Install statusline", action: "install" }, secondary: null, detail: null };
}
