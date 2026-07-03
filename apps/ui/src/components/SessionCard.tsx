import { useState, type MouseEvent } from "react";
import type { SessionRecord, SessionStatus } from "../types";

const statusLabel: Record<SessionStatus, string> = {
  active: "Active",
  waiting: "Waiting for input",
  idle: "Idle",
  ended: "Ended",
};

function relativeTime(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTokens(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function prettyModel(model: string | null): string | null {
  if (!model) return null;
  const match = model.match(/(opus|sonnet|haiku|fable)-(\d+)-(\d+)/i);
  if (!match) return model;
  const family = match[1] ?? "";
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${match[2] ?? ""}.${match[3] ?? ""}`;
}

const DEFAULT_CONTEXT_LIMIT = 200_000;
const LARGE_CONTEXT_LIMIT = 1_000_000;

function modelContextLimit(model: string | null): number | null {
  if (!model) return null;
  const name = model.toLowerCase();
  if (name.includes("opus")) return LARGE_CONTEXT_LIMIT;
  if (name.includes("sonnet") || name.includes("haiku")) return DEFAULT_CONTEXT_LIMIT;
  return null;
}

function contextLimitFor(tokens: number, model: string | null): number {
  let limit = modelContextLimit(model) ?? DEFAULT_CONTEXT_LIMIT;
  if (tokens > limit) limit = LARGE_CONTEXT_LIMIT;
  return limit;
}

interface Props {
  session: SessionRecord;
  showSource: boolean;
  stale?: boolean;
  onArchive: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
}

export function SessionCard({
  session,
  showSource,
  stale = false,
  onArchive,
  onDelete,
  onFocus,
  onRename,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const archived = session.archivedAt != null;
  const canFocus = !archived && session.status !== "ended";
  const name = session.customTitle ?? session.title ?? session.sessionId.slice(0, 8);
  const model = prettyModel(session.model);
  const context = typeof session.contextTokens === "number" ? session.contextTokens : null;
  const hasMetrics =
    model !== null || context !== null || session.tokensIn != null || session.tokensOut != null;

  const limit = context !== null ? contextLimitFor(context, session.model) : 0;
  const pct = limit > 0 ? Math.min(100, ((context ?? 0) / limit) * 100) : 0;
  const level = pct < 60 ? "ok" : pct < 85 ? "warn" : "high";

  const stop = (event: MouseEvent) => event.stopPropagation();
  const submitRename = (value: string) => {
    setRenaming(false);
    onRename(session.sessionId, value.trim());
  };

  return (
    <article
      className={`card card--${session.status} ${archived ? "card--archived" : ""} ${
        stale ? "card--stale" : ""
      } ${canFocus ? "card--clickable" : ""}`}
      onClick={canFocus ? () => onFocus(session.sessionId) : undefined}
    >
      <div className="card__head">
        {renaming ? (
          <input
            className="in card__rename"
            autoFocus
            defaultValue={session.customTitle ?? session.title ?? ""}
            placeholder={session.sessionId.slice(0, 8)}
            onClick={stop}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitRename(event.currentTarget.value);
              if (event.key === "Escape") setRenaming(false);
            }}
            onBlur={(event) => submitRename(event.currentTarget.value)}
          />
        ) : (
          <span className="card__name" title={name}>
            {name}
          </span>
        )}
        {showSource && session.source && <span className="src">{session.source}</span>}
        <span className="card__status">{stale ? "Inactive" : statusLabel[session.status]}</span>
      </div>

      <p className="card__msg">{session.lastMessage ?? "—"}</p>

      <div className="card__metrics">
        <div className="card__meta">
          <span className="chip">{model ?? "—"}</span>
          <span title="tokens in / out">
            ↓{formatTokens(session.tokensIn)} ↑{formatTokens(session.tokensOut)}
          </span>
        </div>
        <div
          className="ctxbar"
          title={
            context !== null
              ? `context: ${context.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} tokens`
              : "context unavailable"
          }
        >
          <span className="ctxbar__label">ctx</span>
          <div className="ctxbar__track">
            <div className="ctxbar__fill" data-level={level} style={{ width: `${pct}%` }} />
          </div>
          <span className="ctxbar__pct">{context !== null ? `${Math.round(pct)}%` : "—"}</span>
        </div>
      </div>

      <div className="card__foot">
        <span title={session.cwd ?? ""}>{session.cwd ?? "—"}</span>
        <time>{relativeTime(session.updatedAt)}</time>
      </div>

      <div className="card__actions">
        <div className="card__open">
          {canFocus && (
            <button
              className="act act--focus"
              onClick={(event) => {
                stop(event);
                onFocus(session.sessionId);
              }}
            >
              Focus
            </button>
          )}
        </div>
        <div className="card__manage">
          {!archived && (
            <>
              <button
                className="act"
                onClick={(event) => {
                  stop(event);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
              <button
                className="act"
                onClick={(event) => {
                  stop(event);
                  onArchive(session.sessionId);
                }}
              >
                Archive
              </button>
            </>
          )}
          {archived && !confirming && (
            <>
              <button
                className="act"
                onClick={(event) => {
                  stop(event);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
              <button
                className="act"
                onClick={(event) => {
                  stop(event);
                  setConfirming(true);
                }}
              >
                Delete
              </button>
            </>
          )}
          {archived && confirming && (
            <>
              <button
                className="act act--ghost"
                onClick={(event) => {
                  stop(event);
                  setConfirming(false);
                }}
              >
                Cancel
              </button>
              <button
                className="act act--danger"
                onClick={(event) => {
                  stop(event);
                  onDelete(session.sessionId);
                }}
              >
                Confirm delete
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
