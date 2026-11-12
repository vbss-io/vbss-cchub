import type { LimitsSnapshot } from "../delegation";
import type { RuntimeSnapshot } from "../types";
import { RuntimeBar, RuntimeChip } from "./RuntimeBar";

interface LimitWindows {
  fiveHour: number;
  sevenDay: number;
}

export interface ProviderLimits {
  provider: "claude" | "codex";
  label: string;
  windows: LimitWindows;
}

interface Props {
  runtimes: RuntimeSnapshot | null;
  claudeSessions: number;
  codexSessions: number;
  hubRunning: number;
  hubAttention: number;
  onOpenHub: () => void;
  limits: LimitsSnapshot | null;
  limitsEnabled: boolean;
  onOpenUsage?: () => void;
}

const WARN_AT = 80;

const percentOf = (value: number): number => Math.round(Math.min(100, Math.max(0, value)));

export function providerLimits(limits: LimitsSnapshot | null): ProviderLimits[] {
  const result: ProviderLimits[] = [];
  const claude = limits?.claude;
  if (claude && claude.source !== "none") {
    result.push({ provider: "claude", label: "Claude", windows: { fiveHour: percentOf(claude.fiveHour.utilization), sevenDay: percentOf(claude.sevenDay.utilization) } });
  }
  const codex = limits?.codex;
  if (codex && codex.source !== "none") {
    result.push({ provider: "codex", label: "Codex", windows: { fiveHour: percentOf(codex.primary.usedPercent), sevenDay: percentOf(codex.secondary.usedPercent) } });
  }
  return result;
}

export function limitsDetail(windows: LimitWindows): string {
  return `5h ${windows.fiveHour}% · 7d ${windows.sevenDay}%`;
}

export function StatusBar({ runtimes, claudeSessions, codexSessions, hubRunning, hubAttention, onOpenHub, limits, limitsEnabled, onOpenUsage }: Props) {
  const providers = limitsEnabled ? providerLimits(limits) : [];
  return (
    <footer className="statusbar" aria-label="Status">
      <RuntimeBar
        runtimes={runtimes}
        claudeSessions={claudeSessions}
        codexSessions={codexSessions}
        hubRunning={hubRunning}
        hubAttention={hubAttention}
        onOpenHub={onOpenHub}
      />
      {providers.length > 0 && (
        <div className="statusbar__limits" aria-label="Plan limits">
          {providers.map((item) => (
            <RuntimeChip
              key={item.provider}
              label={item.label}
              on
              detail={limitsDetail(item.windows)}
              onClick={onOpenUsage}
              tone={Math.max(item.windows.fiveHour, item.windows.sevenDay) >= WARN_AT ? "runtime--warn runtime--limit" : "runtime--limit"}
            />
          ))}
        </div>
      )}
    </footer>
  );
}
