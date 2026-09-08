import { useRef, useState, type MouseEvent } from "react";
import { shareFileUrl, type ShareFile, type ShareRecord, type TrustLevel } from "../delegation";
import { IconCopy } from "../icons";
import { sharePrompt } from "../share-prompt";
import { relativeTime } from "../time";

const STATE_LABEL: Record<ShareRecord["state"], string> = { active: "active", paused: "paused", expired: "expired", revoked: "revoked" };
const TRUST_LABEL: Record<TrustLevel, string> = { low: "Low · read only", medium: "Medium · edits, no shell", high: "High · edits + safe shell", total: "Total · no blocks" };

export const bestLink = (share: ShareRecord): { url: string; kind: "public" | "lan" | "local" } =>
  share.links.public ? { url: share.links.public, kind: "public" } : share.links.lan ? { url: share.links.lan, kind: "lan" } : { url: share.links.local, kind: "local" };

export const maskLink = (url: string): string => url.replace(/(\?key=)[^&]*/i, "$1••••••••");

export function untilText(timestamp: number): string {
  const diff = timestamp - Date.now();
  if (diff <= 0) return "expired";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(diff / 86_400_000)} days`;
}

interface Props {
  share: ShareRecord;
  selected: boolean;
  files: ShareFile[] | undefined;
  onSelect: (id: string) => void;
  onCopy: (url: string, what: string) => void;
  onRevoke: (share: ShareRecord) => void;
}

export function ShareCard({ share, selected, files, onSelect, onCopy, onRevoke }: Props) {
  const [revealed, setRevealed] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const codeRef = useRef<HTMLElement | null>(null);
  const link = bestLink(share);
  const stop = (event: MouseEvent) => event.stopPropagation();
  const toggleReveal = (event: MouseEvent) => {
    stop(event);
    setRevealed((value) => {
      const next = !value;
      if (next) requestAnimationFrame(() => codeRef.current?.focus());
      return next;
    });
  };
  const revokable = share.state === "active" || share.state === "paused";

  return (
    <article className={`card card--share card--share-${share.state} ${selected ? "card--sel" : ""} card--clickable`} onClick={() => onSelect(share.id)}>
      <div className="card__head">
        <span className="card__name" title={share.label}>
          {share.label}
        </span>
        <span className={`tag tag--share-${share.state}`}>{STATE_LABEL[share.state]}</span>
      </div>

      <div className="card__badges">
        <span className={`tag tag--trust-${share.trust}`}>{TRUST_LABEL[share.trust]}</span>
        <span className="chip chip--ws">
          {share.workspace}
          {share.repo ? ` / ${share.repo}` : ""}
        </span>
        {share.sessionId && <span className="chip">continues a session</span>}
        <span className="muted small">
          {share.uses} uses · {share.requestsLastHour}/{share.maxPerHour} this hour · expires {share.expiresAt ? untilText(share.expiresAt) : "never"}
        </span>
      </div>

      <div className="card__line">
        <code
          ref={codeRef}
          tabIndex={0}
          className="share-link share-link--row"
          title={revealed ? link.url : "hidden — Copy sends the full link, Reveal shows it"}
          onClick={stop}
          onBlur={() => setRevealed(false)}
        >
          {revealed ? link.url : maskLink(link.url)}
        </code>
      </div>

      {files && (
        <ul className="filelist" onClick={stop}>
          {files.length === 0 && (
            <li className="muted small">No files yet. Files the fork writes for the asker and files the asker sends land here (share-artifacts/{share.id}).</li>
          )}
          {files.map((file) => (
            <li key={`${file.direction}-${file.name}`}>
              <span className={`tag ${file.direction === "in" ? "tag--muted" : "tag--go"}`}>{file.direction === "in" ? "received" : "written"}</span>
              <a href={shareFileUrl(share.id, file)} target="_blank" rel="noreferrer">
                {file.name}
              </a>
              <span className="muted small">
                {Math.max(1, Math.round(file.size / 1024))} KB · {relativeTime(file.modifiedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="card__actions">
        <div className="card__open">
          <button className="act act--focus" disabled={!share.active} onClick={(event) => { stop(event); onCopy(link.url, `${link.kind} link`); }}>
            <IconCopy /> Copy
          </button>
          <button className="act" disabled={!share.active} onClick={(event) => { stop(event); onCopy(sharePrompt(share, link.url), "prompt"); }}>
            <IconCopy /> Copy prompt
          </button>
          <button className="act" onClick={toggleReveal}>
            {revealed ? "Hide" : "Reveal"}
          </button>
        </div>
        <div className="card__manage">
          {revokable && !confirmRevoke && (
            <button className="act act--danger" onClick={(event) => { stop(event); setConfirmRevoke(true); }}>
              Revoke
            </button>
          )}
          {revokable && confirmRevoke && (
            <>
              <button className="act act--ghost" onClick={(event) => { stop(event); setConfirmRevoke(false); }}>
                Cancel
              </button>
              <button className="act act--danger" onClick={(event) => { stop(event); setConfirmRevoke(false); onRevoke(share); }}>
                Confirm revoke
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
