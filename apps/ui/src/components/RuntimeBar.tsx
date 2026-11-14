import { NO_AGENTS_LABEL, showNoAgents, visibleRuntimeChips } from "../runtime-visibility";
import type { RuntimeSnapshot } from "../types";

interface Props {
  runtimes: RuntimeSnapshot | null;
  claudeSessions: number;
  codexSessions: number;
  hubRunning: number;
  hubAttention: number;
  delegatedOn?: boolean;
  onOpenHub?: () => void;
}

export interface ChipProps {
  label: string;
  on: boolean;
  detail: string;
  onClick?: () => void;
  tone?: string;
}

export function RuntimeChip({ label, on, detail, onClick, tone }: ChipProps) {
  const className = `runtime ${on ? "runtime--on" : ""} ${onClick ? "runtime--button" : ""} ${tone ?? ""}`.trim();
  const content = (
    <>
      <span className="runtime__dot" />
      <span className="runtime__label">{label}</span>
      <span className="runtime__detail">{detail}</span>
    </>
  );
  return onClick ? (
    <button className={className} onClick={onClick} title={`${label}: ${detail}`}>
      {content}
    </button>
  ) : (
    <span className={className} title={`${label}: ${detail}`}>
      {content}
    </span>
  );
}

export function RuntimeBar({ runtimes, claudeSessions, codexSessions, hubRunning, hubAttention, delegatedOn, onOpenHub }: Props) {
  const input = { runtimes, claudeSessions, codexSessions, hubRunning, hubAttention, delegatedOn };
  const chips = visibleRuntimeChips(input);
  return (
    <div className="runtimes" aria-label="Runtimes on this machine">
      {chips.map((chip) => (
        <RuntimeChip key={chip.key} label={chip.label} on={chip.on} detail={chip.detail} onClick={chip.key === "delegated" ? onOpenHub : undefined} />
      ))}
      {showNoAgents(input) && <span className="runtimes__idle">{NO_AGENTS_LABEL}</span>}
      {runtimes?.error && <span className="runtime__error">{runtimes.error}</span>}
    </div>
  );
}
