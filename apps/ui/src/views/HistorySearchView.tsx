import { useState } from "react";
import { Highlighted } from "../components/Highlighted";
import type { WorkspaceRecord } from "../delegation";
import { IconCodex, IconSearch, IconTerminal } from "../icons";
import { copyText } from "../memory-clipboard";
import {
  DEFAULT_HISTORY_FILTERS,
  HISTORY_PAGE,
  HISTORY_PERIODS,
  hitDetail,
  hitHeadline,
  historyEmptyText,
  indexStateLine,
  type HistoryFilters,
  type HistoryPeriod,
  type HistorySort,
  type HitOpenResult,
} from "../memory-model";
import type { HistoryHit, HistoryIndexStatus } from "../types";
import { useHistorySearch, useHistoryStatus } from "../use-history";
import { workspaceOf } from "../wsmatch";
import "../history.css";

interface Props {
  workspaces: WorkspaceRecord[];
  subscribeHistory: (listener: (status: HistoryIndexStatus) => void) => () => void;
  onOpenHit: (hit: HistoryHit) => Promise<HitOpenResult>;
  onOpenSettings: () => void;
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="act"
      onClick={() => {
        void copyText(id).then((ok) => {
          setCopied(ok);
          if (ok) setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function HistorySearchView({ workspaces, subscribeHistory, onOpenHit, onOpenSettings }: Props) {
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_HISTORY_FILTERS);
  const [failed, setFailed] = useState<Record<number, string>>({});
  const status = useHistoryStatus(subscribeHistory);
  const { state, more } = useHistorySearch(filters, { limit: HISTORY_PAGE });
  const patch = (next: Partial<HistoryFilters>) => {
    setFailed({});
    setFilters((current) => ({ ...current, ...next }));
  };
  const empty = historyEmptyText({ state, query: filters.q, status });
  const off = state.enabled === false || (state.enabled === null && status !== null && !status.enabled);
  const scopes = workspaces.filter((workspace) => workspace.contextPath);

  const open = async (hit: HistoryHit) => {
    const result = await onOpenHit(hit);
    setFailed((current) => {
      const next = { ...current };
      if (result.ok) delete next[hit.messageId];
      else next[hit.messageId] = result.reason;
      return next;
    });
  };

  return (
    <div className="hs">
      <div className="hs__bar">
        <label className="search">
          <IconSearch />
          <input className="in" autoFocus placeholder="search what was said in your sessions" aria-label="Search history" value={filters.q} onChange={(event) => patch({ q: event.target.value })} />
        </label>
        <select className="select" aria-label="Client" value={filters.client} onChange={(event) => patch({ client: event.target.value === "claude" || event.target.value === "codex" ? event.target.value : "" })}>
          <option value="">All clients</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
        <select className="select" aria-label="Workspace" value={filters.workspace} onChange={(event) => patch({ workspace: event.target.value })}>
          <option value="">All workspaces</option>
          {scopes.map((workspace) => (
            <option key={workspace.name} value={workspace.contextPath ?? ""}>
              {workspace.name}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Period" value={filters.period} onChange={(event) => patch({ period: event.target.value as HistoryPeriod })}>
          {HISTORY_PERIODS.map((period) => (
            <option key={period.key} value={period.key}>
              {period.label}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Sort" value={filters.sort} onChange={(event) => patch({ sort: event.target.value as HistorySort })}>
          <option value="relevance">Best match</option>
          <option value="recent">Most recent</option>
        </select>
        <label className="hs__group">
          <input type="checkbox" checked={filters.group} onChange={(event) => patch({ group: event.target.checked })} />
          Group by session
        </label>
      </div>
      <p className="hs__note" role="status">
        {indexStateLine(status)}
      </p>

      {state.hits.length > 0 && (
        <ul className="hs__list">
          {state.hits.map((hit) => {
            const reason = failed[hit.messageId];
            return (
              <li key={hit.messageId} className="hs__item">
                <button type="button" className="hs__hit" onClick={() => void open(hit)}>
                  <span className="hs__head">
                    {hit.client === "codex" ? <IconCodex /> : <IconTerminal />}
                    <span>{hitHeadline(hit, workspaceOf(workspaces, hit.cwd))}</span>
                  </span>
                  <span className="hs__snippet">
                    <Highlighted text={hit.snippet} ranges={hit.highlights} />
                  </span>
                  <span className="hs__detail">{hitDetail(hit)}</span>
                </button>
                {reason !== undefined && (
                  <p className="hs__failed" role="alert">
                    <span>{reason}</span>
                    {hit.sessionId ? (
                      <>
                        <span>
                          Session id <code>{hit.sessionId}</code>
                        </span>
                        <CopyId id={hit.sessionId} />
                      </>
                    ) : (
                      <span>No session id was recorded for this match.</span>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {state.hasMore && (
        <button type="button" className="act hs__more" disabled={state.loadingMore} onClick={more}>
          {state.loadingMore ? "Loading..." : "Show more"}
        </button>
      )}
      {empty !== null && (
        <p className="empty">
          {empty}
          {off && (
            <>
              {" "}
              <button type="button" className="linklike" onClick={onOpenSettings}>
                Open Memory settings
              </button>
              .
            </>
          )}
        </p>
      )}
    </div>
  );
}
