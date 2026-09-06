import type { ReactElement } from "react";
import { IconCode, IconCodex, IconDesktop, IconHub, IconTerminal } from "./icons";
import type { CodexClient } from "./types";

export interface ClientLabel {
  label: string;
  family: "claude" | "codex" | "hub";
  icon: ReactElement;
}

const CLAUDE_CLIENTS: Record<string, ClientLabel> = {
  terminal: { label: "Claude Code · terminal", family: "claude", icon: <IconTerminal /> },
  vscode: { label: "Claude Code · VS Code", family: "claude", icon: <IconCode /> },
  "claude-desktop": { label: "Claude Desktop", family: "claude", icon: <IconDesktop /> },
  wsl: { label: "Claude Code · WSL", family: "claude", icon: <IconTerminal /> },
  headless: { label: "Claude Code · headless", family: "hub", icon: <IconHub /> },
  hub: { label: "Hub run", family: "hub", icon: <IconHub /> },
  share: { label: "Share", family: "hub", icon: <IconHub /> },
};

const CODEX_CLIENTS: Record<CodexClient, ClientLabel> = {
  "codex-app": { label: "Codex app", family: "codex", icon: <IconCodex /> },
  "codex-cli": { label: "Codex CLI", family: "codex", icon: <IconCodex /> },
  "codex-exec": { label: "Codex exec", family: "codex", icon: <IconCodex /> },
  "codex-vscode": { label: "Codex · VS Code", family: "codex", icon: <IconCodex /> },
};

export const claudeClient = (client: string | null | undefined): ClientLabel =>
  CLAUDE_CLIENTS[client ?? ""] ?? { label: "Claude Code", family: "claude", icon: <IconTerminal /> };

export const codexClient = (client: CodexClient): ClientLabel => CODEX_CLIENTS[client];

export const sessionClient = (session: { client?: string | null; shareLabel?: string | null }): ClientLabel => {
  const info = claudeClient(session.client);
  return session.client === "share" && session.shareLabel ? { ...info, label: `Share · ${session.shareLabel}` } : info;
};

export const isHubRun = (client: string | null | undefined): boolean => client === "hub" || client === "headless" || client === "share";

export function ClientBadge({ info }: { info: ClientLabel }) {
  return (
    <span className={`client client--${info.family}`} title={info.label}>
      {info.icon}
      <span>{info.label}</span>
    </span>
  );
}
