import type { ClientLabel } from "../clients";

export function RunChip({ info, label, title }: { info: ClientLabel; label: string; title: string }) {
  return (
    <span className={`chip chip--ws chip--run chip--run-${info.family}`} title={title}>
      <span className="chip__icon" aria-label={info.label} role="img">
        {info.icon}
      </span>
      <span className="chip__text">{label}</span>
    </span>
  );
}

export function MoreChip({ extras }: { extras: readonly string[] }) {
  if (extras.length === 0) return null;
  return (
    <span className="chip chip--more" title={extras.join("\n")} aria-label={`${extras.length} more: ${extras.join(", ")}`} role="note">
      +{extras.length}
    </span>
  );
}
