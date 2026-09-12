import { useEffect, useMemo, useState } from "react";
import { fetchHealth, type ClaimRecord } from "../api";
import { claudeClient, isHubRun } from "../clients";
import { CodexCard } from "../components/CodexCard";
import { SessionCard } from "../components/SessionCard";
import type { WorkspaceRecord } from "../delegation";
import { IconSearch } from "../icons";
import { isEmpty, isStale } from "../stale";
import { folderPeers } from "../peers";
import type { CodexSessionRecord, GroupRecord, SessionRecord, SessionStatus } from "../types";
import { workspaceOf } from "../wsmatch";

type SortKey = "status" | "recent" | "name";
type FilterKey = SessionStatus | "all" | "archived" | "stale" | "empty" | "favorites";
type ClientFilter = "all" | "terminal" | "vscode" | "claude-desktop" | "wsl" | "hub" | "share" | "codex";

const UNGROUPED = "Ungrouped";
const HOME_PREFIX = /^(?:[a-z]:[\\/]users[\\/][^\\/]+|\/home\/[^/]+|\/users\/[^/]+)/i;

const sortRank: Record<SessionStatus, number> = { waiting: 0, idle: 1, active: 2, ended: 3 };
const STATUS_ORDER: SessionStatus[] = ["waiting", "idle", "active", "ended"];
const STATUS_LABELS: Record<SessionStatus, string> = { waiting: "Waiting", idle: "Idle", active: "Active", ended: "Ended" };
const CLIENT_FILTERS: { key: ClientFilter; label: string }[] = [
  { key: "all", label: "All clients" },
  { key: "terminal", label: "Claude Code · terminal" },
  { key: "vscode", label: "Claude Code · VS Code" },
  { key: "claude-desktop", label: "Claude Desktop" },
  { key: "wsl", label: "WSL" },
  { key: "hub", label: "Hub runs (headless)" },
  { key: "share", label: "Share forks" },
  { key: "codex", label: "Codex threads" },
];

const projectOf = (session: SessionRecord): string => {
  if (!session.cwd) return session.sessionId.slice(0, 8);
  const parts = session.cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? session.cwd;
};

const nameOf = (session: SessionRecord): string => session.customTitle ?? session.title ?? projectOf(session);

type Bucket = "archived" | "empty" | "ended" | "stale" | "waiting" | "idle" | "active" | "hidden";
const LIVE_BUCKETS: Bucket[] = ["waiting", "idle", "active"];

const matchesClient = (session: SessionRecord, clientFilter: ClientFilter): boolean => {
  if (clientFilter === "all") return true;
  if (clientFilter === "hub") return isHubRun(session.client);
  if (clientFilter === "share") return session.client === "share";
  return claudeClient(session.client).label === claudeClient(clientFilter).label;
};

function bucketOf(session: SessionRecord, clientFilter: ClientFilter): Bucket {
  if (session.archivedAt != null) return "archived";
  if (session.helperOf && clientFilter !== "hub") return "hidden";
  const hub = isHubRun(session.client);
  if (hub && clientFilter === "all") return "hidden";
  if (!hub && isEmpty(session)) return "empty";
  if (session.status === "ended") return "ended";
  if (isStale(session)) return "stale";
  return session.status;
}

function codexBucketOf(thread: CodexSessionRecord): Bucket {
  if (thread.hidden) return "hidden";
  if (thread.archivedAt != null) return "archived";
  if (thread.status === "ended") return "ended";
  return thread.status;
}

const codexNameOf = (thread: CodexSessionRecord): string => thread.customTitle ?? thread.title;

type Item =
  | { kind: "claude"; id: string; session: SessionRecord; status: SessionStatus; updatedAt: number; name: string; cwd: string | null }
  | { kind: "codex"; id: string; thread: CodexSessionRecord; status: SessionStatus; updatedAt: number; name: string; cwd: string | null };

function loadCollapsedGroups(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("hub.collapsedGroups") ?? "[]");
    return Array.isArray(stored) ? stored.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

interface Props {
  sessions: Record<string, SessionRecord>;
  claims: ClaimRecord[];
  groups: GroupRecord[];
  workspaces: WorkspaceRecord[];
  codexSessions: CodexSessionRecord[];
  codexAppRunning: boolean;
  tick: number;
  onOpen: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onFavorite: (sessionId: string, favorite: boolean) => void;
  onOpenCodex: (id: string) => void;
  onRenameCodex: (id: string, title: string) => void;
  onArchiveCodex: (id: string) => void;
  onUnarchiveCodex: (id: string) => void;
  onDeleteCodex: (id: string) => void;
}

export function SessionsView({
  sessions,
  claims,
  groups,
  workspaces,
  codexSessions,
  codexAppRunning,
  tick,
  onOpen,
  onFocus,
  onArchive,
  onDelete,
  onRename,
  onFavorite,
  onOpenCodex,
  onRenameCodex,
  onArchiveCodex,
  onUnarchiveCodex,
  onDeleteCodex,
}: Props) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [clientFilter, setClientFilter] = useState<ClientFilter>("all");
  const [sort, setSort] = useState<SortKey>("status");
  const [query, setQuery] = useState("");
  const [localSource, setLocalSource] = useState<string | null>(null);
  useEffect(() => {
    void fetchHealth().then((health) => setLocalSource(health.hostname)).catch(() => setLocalSource(null));
  }, []);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(loadCollapsedGroups);

  const toggleGroup = (name: string) => {
    setCollapsedGroups((current) => {
      const next = current.includes(name) ? current.filter((item) => item !== name) : [...current, name];
      localStorage.setItem("hub.collapsedGroups", JSON.stringify(next));
      return next;
    });
  };

  const { counts, favorites, list, hubLive, shareLive, codexLive } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const tally: Record<Exclude<Bucket, "hidden">, number> = {
      waiting: 0,
      idle: 0,
      active: 0,
      ended: 0,
      stale: 0,
      archived: 0,
      empty: 0,
    };
    const matched: Item[] = [];
    let hub = 0;
    let share = 0;
    let codex = 0;
    let favorited = 0;
    const matchesQuery = (name: string, cwd: string | null, message: string | null): boolean => {
      if (needle.length === 0) return true;
      return `${name} ${cwd ?? ""} ${message ?? ""}`.toLowerCase().includes(needle);
    };
    for (const session of Object.values(sessions)) {
      if (isHubRun(session.client) && LIVE_BUCKETS.includes(bucketOf(session, "hub"))) hub += 1;
      if (session.client === "share" && LIVE_BUCKETS.includes(bucketOf(session, "share"))) share += 1;
      if (session.favoriteAt != null && matchesQuery(nameOf(session), session.cwd, session.lastMessage)) {
        favorited += 1;
        if (filter === "favorites") {
          matched.push({ kind: "claude", id: session.sessionId, session, status: session.status, updatedAt: session.updatedAt, name: nameOf(session), cwd: session.cwd });
        }
      }
      if (!matchesClient(session, clientFilter) || !matchesQuery(nameOf(session), session.cwd, session.lastMessage)) continue;
      const bucket = bucketOf(session, clientFilter);
      if (bucket === "hidden") continue;
      tally[bucket] += 1;
      if (filter === "favorites") continue;
      if (filter === "all" ? LIVE_BUCKETS.includes(bucket) : bucket === filter) {
        matched.push({ kind: "claude", id: session.sessionId, session, status: session.status, updatedAt: session.updatedAt, name: nameOf(session), cwd: session.cwd });
      }
    }
    for (const thread of codexSessions) {
      const bucket = codexBucketOf(thread);
      if (bucket === "hidden") continue;
      if (LIVE_BUCKETS.includes(bucket)) codex += 1;
      const visibleClient = clientFilter === "all" || clientFilter === "codex";
      if (!visibleClient || !matchesQuery(codexNameOf(thread), thread.cwd, thread.lastMessage)) continue;
      tally[bucket] += 1;
      if (filter === "all" ? LIVE_BUCKETS.includes(bucket) : bucket === filter) {
        matched.push({ kind: "codex", id: thread.id, thread, status: thread.status, updatedAt: thread.updatedAt, name: codexNameOf(thread), cwd: thread.cwd });
      }
    }
    const sorted = matched.sort((a, b) => {
      if (sort === "recent") return b.updatedAt - a.updatedAt;
      if (sort === "name") return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || b.updatedAt - a.updatedAt;
      return sortRank[a.status] - sortRank[b.status] || b.updatedAt - a.updatedAt;
    });
    return { counts: tally, favorites: favorited, list: sorted, hubLive: hub, shareLive: share, codexLive: codex };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, codexSessions, filter, clientFilter, sort, query, tick]);

  const sessionValues = useMemo(() => Object.values(sessions), [sessions]);
  const claimsBySession = useMemo(() => {
    const map = new Map<string, number>();
    for (const claim of claims) {
      if (!claim.sessionId) continue;
      map.set(claim.sessionId, (map.get(claim.sessionId) ?? 0) + 1);
    }
    return map;
  }, [claims]);
  const grouped = useMemo(() => {
    const groupNameFor = (cwd: string | null): string | null => {
      const lower = (cwd ?? "").toLowerCase().replace(HOME_PREFIX, "");
      for (const group of groups) {
        const pattern = group.match.trim().toLowerCase();
        if (pattern && lower.includes(pattern)) return group.name;
      }
      return workspaceOf(workspaces, cwd);
    };
    const names: string[] = [];
    const byName = new Map<string, Item[]>();
    for (const group of groups) {
      if (!byName.has(group.name)) {
        byName.set(group.name, []);
        names.push(group.name);
      }
    }
    const ungrouped: Item[] = [];
    for (const item of list) {
      const name = groupNameFor(item.cwd);
      if (!name) {
        ungrouped.push(item);
        continue;
      }
      if (!byName.has(name)) {
        byName.set(name, []);
        names.push(name);
      }
      byName.get(name)?.push(item);
    }
    return { names, byName, ungrouped };
  }, [list, groups, workspaces]);

  const isRemoteSource = (source: string | null): boolean =>
    !!source && (!localSource || source.toLowerCase() !== localSource.toLowerCase());

  const total = counts.waiting + counts.idle + counts.active;

  const renderCard = (item: Item) => {
    if (item.kind === "codex") {
      const thread = item.thread;
      return (
        <CodexCard
          key={`codex-${thread.id}`}
          session={thread}
          workspace={workspaceOf(workspaces, thread.cwd)}
          codexAppRunning={codexAppRunning}
          onOpen={onOpenCodex}
          onRename={onRenameCodex}
          onArchive={onArchiveCodex}
          onUnarchive={onUnarchiveCodex}
          onDelete={onDeleteCodex}
        />
      );
    }
    const session = item.session;
    const parent = session.forkOf ? sessions[session.forkOf] : undefined;
    const forkParentName = session.forkOf ? (parent ? nameOf(parent) : session.forkOf.slice(0, 8)) : null;
    return (
      <SessionCard
        key={session.sessionId}
        session={session}
        workspace={workspaceOf(workspaces, session.cwd)}
        showSource={isRemoteSource(session.source)}
        stale={isStale(session)}
        peers={folderPeers(session.cwd, sessionValues, [], { sessionId: session.sessionId })}
        forkParentName={forkParentName}
        claimsCount={claimsBySession.get(session.sessionId) ?? 0}
        onOpen={onOpen}
        onArchive={onArchive}
        onDelete={onDelete}
        onFocus={onFocus}
        onRename={onRename}
        onFavorite={onFavorite}
      />
    );
  };

  const renderGroup = (name: string, items: Item[]) => {
    const collapsed = collapsedGroups.includes(name);
    const needAttention = items.filter((item) => item.status === "waiting" || item.status === "idle").length;
    return (
      <section key={name} className={`group ${collapsed ? "group--collapsed" : ""}`}>
        <h2>
          <button className="group__title" onClick={() => toggleGroup(name)} aria-expanded={!collapsed}>
            <span className="group__caret">{collapsed ? "▸" : "▾"}</span>
            <span className="group__name">{name}</span>
            <span className="group__count">{items.length}</span>
            {collapsed && needAttention > 0 && <span className="group__attn">{needAttention} need attention</span>}
          </button>
        </h2>
        {!collapsed && <div className="grid">{items.map(renderCard)}</div>}
      </section>
    );
  };

  return (
    <div className="view">
      <div className="toolbar">
        <div className="filters">
          <button className={`pill ${filter === "all" ? "pill--on" : ""}`} onClick={() => setFilter("all")}>
            All <span className="pill__count">{total}</span>
          </button>
          {STATUS_ORDER.map((status) => (
            <button key={status} className={`pill pill--${status} ${filter === status ? "pill--on" : ""}`} onClick={() => setFilter(status)}>
              {STATUS_LABELS[status]} <span className="pill__count">{counts[status]}</span>
            </button>
          ))}
          {counts.stale > 0 && (
            <button className={`pill pill--stale ${filter === "stale" ? "pill--on" : ""}`} onClick={() => setFilter("stale")} title="No activity for hours and no end signal">
              Inactive <span className="pill__count">{counts.stale}</span>
            </button>
          )}
          {counts.empty > 0 && (
            <button className={`pill pill--empty ${filter === "empty" ? "pill--on" : ""}`} onClick={() => setFilter("empty")} title="Sessions that never produced a turn">
              Empty <span className="pill__count">{counts.empty}</span>
            </button>
          )}
          <button className={`pill pill--archived ${filter === "archived" ? "pill--on" : ""}`} onClick={() => setFilter("archived")}>
            Archived <span className="pill__count">{counts.archived}</span>
          </button>
          <button className={`pill pill--favorites ${filter === "favorites" ? "pill--on" : ""}`} onClick={() => setFilter("favorites")} title="Sessions you starred, regardless of status or archive state">
            Favorites <span className="pill__count">{favorites}</span>
          </button>
        </div>
        <div className="toolbar__right">
          <label className="search">
            <IconSearch />
            <input className="in" placeholder="search title, folder, message" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <select className="select" value={clientFilter} onChange={(event) => setClientFilter(event.target.value as ClientFilter)}>
            {CLIENT_FILTERS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
                {item.key === "hub" && hubLive > 0 ? ` (${hubLive})` : ""}
                {item.key === "share" && shareLive > 0 ? ` (${shareLive})` : ""}
                {item.key === "codex" && codexLive > 0 ? ` (${codexLive})` : ""}
              </option>
            ))}
          </select>
          <label className="sort">
            Sort
            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
              <option value="status">Status</option>
              <option value="recent">Recent</option>
              <option value="name">Name</option>
            </select>
          </label>
        </div>
      </div>

      {clientFilter === "share" && (
        <p className="callout">Share forks are the Claude sessions answering people through your share links; the badge names the share and who is asking.</p>
      )}
      {clientFilter === "hub" && (
        <p className="callout">
          Hub runs are headless Claude Code sessions launched by delegated tasks. They never notify, live in the Delegated view and are hidden from the all-clients list.
        </p>
      )}
      {clientFilter === "codex" && (
        <p className="callout">
          Codex threads read from ~/.codex/sessions — app, CLI and exec runs. They join their workspace group and are read-only from here.
        </p>
      )}

      {grouped.names.map((name) => {
        const items = grouped.byName.get(name) ?? [];
        return items.length === 0 ? null : renderGroup(name, items);
      })}
      {grouped.ungrouped.length > 0 && renderGroup(UNGROUPED, grouped.ungrouped)}

      {list.length === 0 && filter === "all" && clientFilter === "all" && query.trim().length === 0 && (
        <p className="empty">No live Claude Code sessions. Start one in a terminal, VS Code or Claude Desktop and it appears here.</p>
      )}
      {list.length === 0 && filter === "all" && clientFilter !== "all" && query.trim().length === 0 && counts.ended > 0 && (
        <p className="empty">
          No live {CLIENT_FILTERS.find((item) => item.key === clientFilter)?.label ?? "sessions"}. {counts.ended} ended —{" "}
          <button className="linklike" onClick={() => setFilter("ended")}>
            open the Ended pill
          </button>
          .
        </p>
      )}
      {list.length === 0 &&
        !(filter === "all" && clientFilter === "all" && query.trim().length === 0) &&
        !(filter === "all" && clientFilter !== "all" && query.trim().length === 0 && counts.ended > 0) && (
          <p className="empty">Nothing matches this filter.</p>
        )}
    </div>
  );
}
