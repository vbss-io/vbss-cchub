import { Fragment, type ReactNode } from "react";
import type { ClientLabel } from "../clients";
import type { TaskTone } from "../runs-model";

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

const FAMILY_NAME: Record<ClientLabel["family"], string> = { claude: "Claude", codex: "Codex", hub: "Hub" };

export const shortClientName = (info: ClientLabel): string => (info.label.startsWith("Share") ? "Share" : FAMILY_NAME[info.family]);

export function RunStatus({ tone, label }: { tone: TaskTone; label: string }) {
  return <span className={`rc__status rc__status--${tone}`}>{label}</span>;
}

export interface MetaPart {
  key: string;
  text: string;
  title?: string;
}

export function RunMeta({ client, clientTitle, parts, extras }: { client: ClientLabel; clientTitle?: string; parts: readonly MetaPart[]; extras: readonly string[] }) {
  return (
    <div className="rc__meta">
      <span className="rc__client" title={clientTitle ?? client.label}>
        <span className="rc__icon" aria-hidden="true">
          {client.icon}
        </span>
        <span>{shortClientName(client)}</span>
      </span>
      {parts.map((part) => (
        <Fragment key={part.key}>
          <span className="rc__sep" aria-hidden="true">
            ·
          </span>
          <span className="rc__part" title={part.title ?? part.text}>
            {part.text}
          </span>
        </Fragment>
      ))}
      {extras.length > 0 && (
        <span className="rc__more" title={extras.join("\n")} aria-label={`${extras.length} more: ${extras.join(", ")}`} role="note">
          +{extras.length}
        </span>
      )}
    </div>
  );
}

export function RunWhy({ tone, headline, detail }: { tone: TaskTone; headline: string; detail: string | null }) {
  return (
    <div className={`rc__why rc__why--${tone}`} title={detail ? `${headline}\n${detail}` : headline}>
      <span className="rc__why-text">{headline}</span>
    </div>
  );
}

export type CtxLevel = "ok" | "warn" | "high";

export const ctxLevel = (pct: number): CtxLevel => (pct < 60 ? "ok" : pct < 85 ? "warn" : "high");

export function CtxMeter({ pct, title }: { pct: number; title: string }) {
  const level = ctxLevel(pct);
  return (
    <span className="rc__ctx" data-level={level} title={title}>
      <span className="rc__bar" aria-hidden="true">
        <span className="rc__fill" data-level={level} style={{ width: `${Math.max(4, Math.round(pct))}%` }} />
      </span>
      {Math.round(pct)}%
    </span>
  );
}

export function RunFoot({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="rc__foot">
      <div className="rc__facts">{children}</div>
      {actions ? <div className="rc__acts">{actions}</div> : null}
    </div>
  );
}
