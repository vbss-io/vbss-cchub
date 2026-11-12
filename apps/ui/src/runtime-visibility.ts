import type { RuntimeSnapshot } from "./types";

export type RuntimeChipKey = "claudeCode" | "claudeDesktop" | "codexApp" | "codexCli" | "delegated";

export interface RuntimeChipSpec {
  key: RuntimeChipKey;
  label: string;
  on: boolean;
  detail: string;
}

export interface RuntimeVisibilityInput {
  runtimes: RuntimeSnapshot | null;
  claudeSessions: number;
  codexSessions: number;
  hubRunning: number;
  hubAttention: number;
}

export const NO_AGENTS_LABEL = "No agents running";

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "es"}`;

export function visibleRuntimeChips(input: RuntimeVisibilityInput): RuntimeChipSpec[] {
  const { runtimes, claudeSessions, codexSessions, hubRunning, hubAttention } = input;
  const chips: RuntimeChipSpec[] = [];
  if (!runtimes) {
    chips.push({ key: "claudeCode", label: "Claude Code", on: claudeSessions > 0, detail: "scanning…" });
  } else if (runtimes.claudeCode.running || runtimes.claudeCode.count > 0 || claudeSessions > 0) {
    chips.push({ key: "claudeCode", label: "Claude Code", on: true, detail: `${claudeSessions} live · ${plural(runtimes.claudeCode.count, "process")}` });
  }
  if (runtimes?.claudeDesktop.running) chips.push({ key: "claudeDesktop", label: "Claude Desktop", on: true, detail: "open" });
  if (runtimes?.codexApp.running) chips.push({ key: "codexApp", label: "Codex app", on: true, detail: `open · ${codexSessions} threads` });
  const codexCli = runtimes?.codexCli.count ?? 0;
  if (codexCli > 0) chips.push({ key: "codexCli", label: "Codex CLI", on: true, detail: `${codexCli} running` });
  if (hubRunning + hubAttention > 0) {
    chips.push({ key: "delegated", label: "Delegated", on: true, detail: `${hubRunning} running${hubAttention > 0 ? ` · ${hubAttention} need you` : ""}` });
  }
  return chips;
}

export const showNoAgents = (input: RuntimeVisibilityInput): boolean => input.runtimes !== null && visibleRuntimeChips(input).length === 0;
