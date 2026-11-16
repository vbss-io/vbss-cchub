import { useState, type MouseEvent } from "react";
import { useApprovals } from "../approvals-context";
import { approvalView, countdown, countdownFraction } from "../approvals-model";
import type { PermissionRequestRecord } from "../types";
import { shortFolder } from "../wsmatch";
import { ClampText } from "./ShowMore";
import "../approvals.css";

interface Props {
  request: PermissionRequestRecord;
  compact?: boolean;
  showTitle?: boolean;
  reasonField?: boolean;
  lines?: number;
}

export function ApprovalRequest({ request, compact = false, showTitle = false, reasonField = true, lines = compact ? 3 : 6 }: Props) {
  const { now, decide } = useApprovals();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = approvalView(request);
  const left = countdown(request.expiresAt, now);
  const fraction = countdownFraction(request, now);
  const stop = (event: MouseEvent) => event.stopPropagation();

  const cancelDeny = () => {
    setDenying(false);
    setReason("");
  };

  const startDeny = () => {
    if (reasonField) setDenying(true);
    else void send("deny");
  };

  const send = async (behavior: "allow" | "deny") => {
    setBusy(true);
    setError(null);
    try {
      await decide(request.id, behavior, reason);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The decision was not sent.");
      setBusy(false);
    }
  };

  return (
    <div className={`approval ${compact ? "approval--compact" : ""}`} onClick={stop} onMouseDown={stop} role="group" aria-label={`Permission request for ${view.tool}`}>
      <div className="approval__head">
        {showTitle && (
          <span className="approval__title" title={view.title}>
            {view.title}
          </span>
        )}
        <span className="approval__tool" title={`${view.agentLabel} asks to run ${view.tool}${view.subagent ? " in a subagent" : ""}`}>
          {view.tool}
          {view.subagent ? " · subagent" : ""}
        </span>
        <span className={`approval__left ${left.urgent ? "approval__left--urgent" : ""}`} title="After this the prompt stays in the terminal or app as usual">
          {left.text}
        </span>
      </div>
      <div className="approval__bar" aria-hidden="true">
        <span className="approval__fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
      {view.input.length > 0 && (
        <ClampText className="approval__input" lines={lines}>
          {view.input}
        </ClampText>
      )}
      {view.cwd && (
        <span className="approval__cwd" title={view.cwd}>
          {shortFolder(view.cwd)}
        </span>
      )}
      {denying && (
        <input
          className="in approval__reason"
          autoFocus
          value={reason}
          maxLength={2000}
          placeholder="Reason for the agent (optional)"
          aria-label="Reason for denying"
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) void send("deny");
            if (event.key === "Escape") {
              event.stopPropagation();
              cancelDeny();
            }
          }}
        />
      )}
      {error && <span className="approval__error">{error}</span>}
      <div className="approval__acts">
        {denying ? (
          <>
            <button type="button" className="act act--ghost" disabled={busy} onClick={cancelDeny}>
              Cancel
            </button>
            <button type="button" className="act" disabled={busy} onClick={() => void send("deny")}>
              {busy ? "Sending..." : "Send deny"}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="act" disabled={busy} onClick={startDeny}>
              Deny
            </button>
            <button type="button" className="act act--focus" disabled={busy} onClick={() => void send("allow")}>
              {busy ? "Sending..." : "Allow"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

interface ListProps {
  requests: readonly PermissionRequestRecord[];
  compact?: boolean;
  showTitle?: boolean;
  reasonField?: boolean;
}

export function ApprovalList({ requests, compact = false, showTitle = false, reasonField = true }: ListProps) {
  if (requests.length === 0) return null;
  return (
    <div className="approvals">
      {requests.map((request) => (
        <ApprovalRequest key={request.id} request={request} compact={compact} showTitle={showTitle} reasonField={reasonField} />
      ))}
    </div>
  );
}
