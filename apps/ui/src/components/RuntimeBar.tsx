import type { RuntimeSnapshot } from "../types";

interface Props {
  runtimes: RuntimeSnapshot | null;
  claudeSessions: number;
  codexSessions: number;
  hubRunning: number;
  hubAttention: number;
  onOpenHub: () => void;
}

interface ChipProps {
  label: string;
  on: boolean;
  detail: string;
  onClick?: () => void;
}

function RuntimeChip({ label, on, detail, onClick }: ChipProps) {
  const className = `runtime ${on ? "runtime--on" : ""} ${onClick ? "runtime--button" : ""}`;
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

export function RuntimeBar({ runtimes, claudeSessions, codexSessions, hubRunning, hubAttention, onOpenHub }: Props) {
  const claudeCode = runtimes?.claudeCode;
  const claudeDetail = claudeCode
    ? `${claudeSessions} live · ${claudeCode.count} process${claudeCode.count === 1 ? "" : "es"}`
    : "scanning…";
  const hubDetail =
    hubRunning + hubAttention === 0 ? "idle" : `${hubRunning} running${hubAttention > 0 ? ` · ${hubAttention} need you` : ""}`;
  return (
    <div className="runtimes" aria-label="Runtimes on this machine">
      <RuntimeChip label="Claude Code" on={(claudeCode?.running ?? false) || claudeSessions > 0} detail={claudeDetail} />
      <RuntimeChip label="Claude Desktop" on={runtimes?.claudeDesktop.running ?? false} detail={runtimes?.claudeDesktop.running ? "open" : "closed"} />
      <RuntimeChip label="Codex app" on={runtimes?.codexApp.running ?? false} detail={runtimes?.codexApp.running ? `open · ${codexSessions} threads` : "closed"} />
      <RuntimeChip label="Codex CLI" on={(runtimes?.codexCli.count ?? 0) > 0} detail={`${runtimes?.codexCli.count ?? 0} running`} />
      <RuntimeChip label="Delegated" on={hubRunning + hubAttention > 0} detail={hubDetail} onClick={onOpenHub} />
      {runtimes?.error && <span className="runtime__error">{runtimes.error}</span>}
    </div>
  );
}
