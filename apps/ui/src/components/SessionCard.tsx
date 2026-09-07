import { useState, type MouseEvent } from "react";
import { ClientBadge, claudeClient, sessionClient } from "../clients";
import { IconFocus } from "../icons";
import { relativeTime } from "../time";
import type { SessionRecord, SessionStatus } from "../types";
import { shortFolder } from "../wsmatch";

const statusLabel: Record<SessionStatus, string> = {
  active: "Active",
  waiting: "Waiting for input",
  idle: "Idle",
  ended: "Ended",
};

function formatTokens(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function prettyModel(model: string | null): string | null {
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
  if (name.includes("opus") || name.includes("fable")) return LARGE_CONTEXT_LIMIT;
  if (name.includes("sonnet") || name.includes("haiku")) return DEFAULT_CONTEXT_LIMIT;
  return null;
}

export function contextLimitFor(tokens: number, model: string | null): number {
  let limit = modelContextLimit(model) ?? DEFAULT_CONTEXT_LIMIT;
  if (tokens > limit) limit = LARGE_CONTEXT_LIMIT;
  return limit;
}

interface Props {
  session: SessionRecord;
  workspace: string | null;
  showSource: boolean;
  stale?: boolean;
  forkParentName?: string | null;
  peers?: number;
  onOpen: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
}

export function SessionCard({
  session,
  workspace,
  showSource,
  stale = false,
  forkParentName = null,
  peers = 0,
  onOpen,
  onArchive,
  onDelete,
  onFocus,
  onRename,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const archived = session.archivedAt != null;
  const canFocus = !archived && session.status !== "ended" && !stale;
  const name = session.customTitle ?? session.title ?? session.sessionId.slice(0, 8);
  const model = prettyModel(session.model);
  const context = typeof session.contextTokens === "number" ? session.contextTokens : null;
  const limit = context !== null ? contextLimitFor(context, session.model) : 0;
  const pct = limit > 0 ? Math.min(100, ((context ?? 0) / limit) * 100) : 0;
  const level = pct < 60 ? "ok" : pct < 85 ? "warn" : "high";
  const agentsRunning = session.agentsRunning ?? 0;
  const agentsTotal = session.agentsTotal ?? 0;

  const stop = (event: MouseEvent) => event.stopPropagation();
  const submitRename = (value: string) => {
    setRenaming(false);
    onRename(session.sessionId, value.trim());
  };

  return (
    <article
      className={`card card--${session.status} ${archived ? "card--archived" : ""} ${stale ? "card--stale" : ""} card--clickable`}
      onClick={() => onOpen(session.sessionId)}
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
        <span className="card__status">{stale ? "Inactive" : statusLabel[session.status]}</span>
      </div>

      <div className="card__badges">
        <ClientBadge info={sessionClient(session)} />
        {workspace && <span className="chip chip--ws">{workspace}</span>}
        {showSource && session.source && <span className="src">{session.source}</span>}
        {agentsRunning > 0 && (
          <span className="chip chip--agents chip--agents-on" title={`${agentsRunning} subagent${agentsRunning === 1 ? "" : "s"} running now · ${agentsTotal} spawned this session`}>
            {agentsRunning} running
          </span>
        )}
        {peers > 0 && !archived && session.status !== "ended" && !stale && (
          <span className="chip chip--peers" title="Other live agents share this folder right now; edits can collide. Delegate with isolation: worktree, or use the Agent tool worktree isolation.">
            {peers} more here
          </span>
        )}
        {session.forkOf && (
          <span className="chip chip--fork" title={`forks ${session.forkOf}`}>
            fork · {forkParentName ?? session.forkOf.slice(0, 8)}
          </span>
        )}
        {(session.forksLive ?? 0) > 0 && (
          <span className="chip chip--forks" title={`People asking this session through a share · ${session.remoteAsks ?? 0} ask${(session.remoteAsks ?? 0) === 1 ? "" : "s"} total`}>
            {session.forksLive} live fork{session.forksLive === 1 ? "" : "s"}
          </span>
        )}
        {(session.delegatedRunning ?? 0) > 0 && (
          <span className="chip chip--delegated" title="Tasks this session delegated that are running now">
            {session.delegatedRunning} delegated running
          </span>
        )}
        {(session.helpersTotal ?? 0) > 0 && (
          <span
            className="chip chip--helpers"
            title="Claude Desktop runs a short helper session per chat step; folded into this card"
          >
            {session.helpers ?? 0} helper{(session.helpers ?? 0) === 1 ? "" : "s"}
          </span>
        )}
        {session.helperOf && (
          <span className="chip chip--helper" title={`helper of ${session.helperOf}`}>
            helper of {session.helperOf.slice(0, 8)}
          </span>
        )}
      </div>

      <div className="card__line">
        <span className="card__model">{model ?? "—"}</span>
        <span
          className="card__ctx"
          data-level={level}
          title={
            context !== null
              ? `context ${context.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} tokens · ↓${formatTokens(session.tokensIn)} ↑${formatTokens(session.tokensOut)}`
              : "context unavailable"
          }
        >
          ctx {context !== null ? `${Math.round(pct)}%` : "—"}
        </span>
        <span className="card__folder" title={session.cwd ?? ""}>
          {shortFolder(session.cwd)}
        </span>
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
              <IconFocus /> Focus
            </button>
          )}
        </div>
        <div className="card__manage">
          <button
            className="act"
            onClick={(event) => {
              stop(event);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          {!archived && (
            <button
              className="act"
              onClick={(event) => {
                stop(event);
                onArchive(session.sessionId);
              }}
            >
              Archive
            </button>
          )}
          {archived && !confirming && (
            <button
              className="act"
              onClick={(event) => {
                stop(event);
                setConfirming(true);
              }}
            >
              Delete
            </button>
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
