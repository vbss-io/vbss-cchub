import { useState, type MouseEvent } from "react";
import { canOpenSession } from "../act-model";
import { useApprovals } from "../approvals-context";
import { sessionClient } from "../clients";
import { IconFocus, IconStar } from "../icons";
import { relativeTime } from "../time";
import type { SessionRecord, SessionStatus } from "../types";
import { shortFolder } from "../wsmatch";
import { ApprovalList } from "./ApprovalRequest";
import { CardMenu, useCardMenu, type CardMenuItem } from "./CardMenu";
import { sessionStatusTone } from "../runs-model";
import { CtxMeter, RunFoot, RunMeta, RunStatus, type MetaPart } from "./RunChips";

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
  claimsCount?: number;
  onOpen: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onFavorite: (sessionId: string, favorite: boolean) => void;
}

export function SessionCard({
  session,
  workspace,
  showSource,
  stale = false,
  forkParentName = null,
  peers = 0,
  claimsCount = 0,
  onOpen,
  onArchive,
  onDelete,
  onFocus,
  onOpenSession,
  onRename,
  onFavorite,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const menu = useCardMenu();
  const approvals = useApprovals().forSession("claude", session.sessionId);

  const archived = session.archivedAt != null;
  const favorite = session.favoriteAt != null;
  const unread = session.unread === true && session.status === "idle";
  const canFocus = !archived && session.status !== "ended" && !stale;
  const name = session.customTitle ?? session.title ?? session.sessionId.slice(0, 8);
  const model = prettyModel(session.model);
  const context = typeof session.contextTokens === "number" ? session.contextTokens : null;
  const limit = context !== null ? contextLimitFor(context, session.model) : 0;
  const pct = limit > 0 ? Math.min(100, ((context ?? 0) / limit) * 100) : 0;
  const agentsRunning = session.agentsRunning ?? 0;
  const agentsTotal = session.agentsTotal ?? 0;
  const clientInfo = sessionClient(session);
  const live = !archived && session.status !== "ended" && !stale;
  const tone = sessionStatusTone({ status: session.status, unread, stale, archived });
  const statusText = unread ? "Finished" : stale ? "Inactive" : statusLabel[session.status];
  const folder = shortFolder(session.cwd);
  const metaParts: MetaPart[] = [
    { key: "where", text: workspace ?? folder, title: session.cwd ?? folder },
    ...(workspace && workspace !== folder ? [{ key: "folder", text: folder, title: session.cwd ?? folder }] : []),
  ];
  const ctxTitle =
    context !== null
      ? `${model ?? "model unknown"} · context ${context.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")} tokens · ↓${formatTokens(session.tokensIn)} ↑${formatTokens(session.tokensOut)}`
      : `${model ?? "model unknown"} · context unavailable`;
  const extras = [
    ...(showSource && session.source ? [`from ${session.source}`] : []),
    ...(agentsRunning > 0 ? [`${agentsRunning} subagent${agentsRunning === 1 ? "" : "s"} running · ${agentsTotal} spawned`] : []),
    ...(peers > 0 && live ? [`${peers} more here: other live agents share this folder`] : []),
    ...(claimsCount > 0 ? [`claims ${claimsCount} file${claimsCount === 1 ? "" : "s"}`] : []),
    ...(session.forkOf ? [`fork of ${forkParentName ?? session.forkOf.slice(0, 8)}`] : []),
    ...((session.forksLive ?? 0) > 0 ? [`${session.forksLive} live fork${session.forksLive === 1 ? "" : "s"} · ${session.remoteAsks ?? 0} asks`] : []),
    ...((session.delegatedRunning ?? 0) > 0 ? [`${session.delegatedRunning} delegated running`] : []),
    ...((session.helpersTotal ?? 0) > 0 ? [`${session.helpers ?? 0} helper${(session.helpers ?? 0) === 1 ? "" : "s"} folded in`] : []),
    ...(session.helperOf ? [`helper of ${session.helperOf.slice(0, 8)}`] : []),
  ];

  const stop = (event: MouseEvent) => event.stopPropagation();
  const menuItems: CardMenuItem[] = [
    ...(onOpenSession && canOpenSession({ status: session.status, archivedAt: session.archivedAt, stale }) ? [{ key: "open", label: "Open session", onSelect: () => onOpenSession(session.sessionId) }] : []),
    { key: "rename", label: "Rename", onSelect: () => setRenaming(true) },
    ...(archived ? [] : [{ key: "archive", label: "Archive", onSelect: () => onArchive(session.sessionId) }]),
    { key: "favorite", label: favorite ? "Unfavorite" : "Favorite", onSelect: () => onFavorite(session.sessionId, !favorite) },
  ];
  const actions = (
    <>
      {canFocus && (
        <button
          className="act rc__act"
          onClick={(event) => {
            stop(event);
            onFocus(session.sessionId);
          }}
        >
          <IconFocus /> Focus
        </button>
      )}
      {archived && !confirming && (
        <button
          className="act rc__act"
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
            className="act act--ghost rc__act"
            onClick={(event) => {
              stop(event);
              setConfirming(false);
            }}
          >
            Cancel
          </button>
          <button
            className="act act--danger rc__act"
            onClick={(event) => {
              stop(event);
              onDelete(session.sessionId);
            }}
          >
            Confirm delete
          </button>
        </>
      )}
    </>
  );
  const submitRename = (value: string) => {
    setRenaming(false);
    onRename(session.sessionId, value.trim());
  };

  return (
    <article
      className={`card card--run card--tone-${tone} card--${session.status} ${unread ? "card--unread" : ""} ${archived ? "card--archived" : ""} ${stale ? "card--stale" : ""} ${favorite ? "card--favorite" : ""} card--clickable`}
      onClick={() => onOpen(session.sessionId)}
      onContextMenu={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        menu.openAt(event.clientX, event.clientY);
      }}
    >
      <div className="card__head">
        {favorite && (
          <span className="card__star card__star--on" title="Favorite" role="img" aria-label="Favorite">
            <IconStar filled />
          </span>
        )}
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
        <RunStatus tone={tone} label={statusText} />
        <CardMenu menu={menu} items={menuItems} label={`Actions for ${name}`} />
      </div>

      <RunMeta client={clientInfo} clientTitle={`${clientInfo.label} · ${folder}`} parts={metaParts} extras={extras} />

      <ApprovalList requests={approvals} />

      <RunFoot actions={canFocus || archived ? actions : undefined}>
        {model && (
          <span className="rc__model" title={ctxTitle}>
            {model}
          </span>
        )}
        {context !== null && <CtxMeter pct={pct} title={ctxTitle} />}
        <time className="rc__time">{relativeTime(session.updatedAt)}</time>
      </RunFoot>
    </article>
  );
}
