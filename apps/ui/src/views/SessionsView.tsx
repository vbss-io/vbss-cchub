import { useEffect, useMemo, useState } from "react";
import { fetchHealth } from "../api";
import { claudeClient, isHubRun } from "../clients";
import { CodexCard } from "../components/CodexCard";
import { SessionCard } from "../components/SessionCard";
import type { WorkspaceRecord } from "../delegation";
import { IconSearch } from "../icons";
import { isEmpty, isStale } from "../stale";
import type { CodexSessionRecord, GroupRecord, SessionRecord, SessionStatus } from "../types";
import { workspaceOf } from "../wsmatch";

type SortKey = "status" | "recent" | "name";
type FilterKey = SessionStatus | "all" | "archived" | "stale" | "empty";
type ClientFilter = "all" | "terminal" | "vscode" | "claude-desktop" | "wsl" | "hub" | "share";

const UNGROUPED = "Ungrouped";

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
];

const projectOf = (session: SessionRecord): string => {
  if (!session.cwd) return session.sessionId.slice(0, 8);
  const parts = session.cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? session.cwd;
};

const byRecent = (a: SessionRecord, b: SessionRecord): number => b.updatedAt - a.updatedAt;
const nameOf = (session: SessionRecord): string => session.customTitle ?? session.title ?? projectOf(session);

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
  groups: GroupRecord[];
  workspaces: WorkspaceRecord[];
  codexSessions: CodexSessionRecord[];
  tick: number;
  onOpen: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
}

export function SessionsView({ sessions, groups, workspaces, codexSessions, tick, onOpen, onFocus, onArchive, onDelete, onRename }: Props) {
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

  const counts = useMemo(() => {
    const result = { waiting: 0, idle: 0, active: 0, ended: 0, stale: 0, archived: 0, empty: 0, hub: 0, share: 0 };
    const scopedToHub = clientFilter === "hub" || clientFilter === "share";
    for (const session of Object.values(sessions)) {
      const hub = isHubRun(session.client);
      if (hub) result.hub += 1;
      if (session.client === "share") result.share += 1;
      if (clientFilter === "hub" && !hub) continue;
      if (clientFilter === "share" && session.client !== "share") continue;
      if (session.archivedAt != null) result.archived += 1;
      if (hub && !scopedToHub) continue;
      if (!hub && isEmpty(session)) result.empty += 1;
      else if (session.status === "ended") result.ended += 1;
      else if (isStale(session)) result.stale += 1;
      else result[session.status] += 1;
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, clientFilter, tick]);

  const list = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = Object.values(sessions);
    const filtered = all.filter((session) => {
      const archived = session.archivedAt != null;
      const hub = isHubRun(session.client);
      const empty = !archived && !hub && isEmpty(session);
      const stale = !archived && !empty && session.status !== "ended" && isStale(session);
      if (clientFilter === "hub" && !hub) return false;
      else if (clientFilter === "share" && session.client !== "share") return false;
      else if (clientFilter !== "all" && claudeClient(session.client).label !== claudeClient(clientFilter).label) return false;
      if (needle.length > 0) {
        const haystack = `${nameOf(session)} ${session.cwd ?? ""} ${session.lastMessage ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (filter === "archived") return archived;
      if (archived) return false;
      if (hub && clientFilter === "all") return false;
      if (filter === "empty") return empty;
      if (empty) return false;
      if (filter === "stale") return stale;
      if (stale) return false;
      if (filter === "all") return session.status !== "ended";
      return session.status === filter;
    });
    return filtered.sort((a, b) => {
      if (sort === "recent") return byRecent(a, b);
      if (sort === "name") return nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase()) || byRecent(a, b);
      return sortRank[a.status] - sortRank[b.status] || byRecent(a, b);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, filter, clientFilter, sort, query, tick]);

  const grouped = useMemo(() => {
    const groupNameFor = (session: SessionRecord): string | null => {
      const cwd = (session.cwd ?? "").toLowerCase();
      for (const group of groups) {
        const pattern = group.match.trim().toLowerCase();
        if (pattern && cwd.includes(pattern)) return group.name;
      }
      return workspaceOf(workspaces, session.cwd);
    };
    const names: string[] = [];
    const byName = new Map<string, SessionRecord[]>();
    for (const group of groups) {
      if (!byName.has(group.name)) {
        byName.set(group.name, []);
        names.push(group.name);
      }
    }
    const ungrouped: SessionRecord[] = [];
    for (const session of list) {
      const name = groupNameFor(session);
      if (!name) {
        ungrouped.push(session);
        continue;
      }
      if (!byName.has(name)) {
        byName.set(name, []);
        names.push(name);
      }
      byName.get(name)?.push(session);
    }
    return { names, byName, ungrouped };
  }, [list, groups, workspaces]);

  const isRemoteSource = (source: string | null): boolean =>
    !!source && (!localSource || source.toLowerCase() !== localSource.toLowerCase());

  const liveCodex = codexSessions.filter((session) => session.status !== "ended");
  const total = counts.waiting + counts.idle + counts.active;

  const renderCard = (session: SessionRecord) => (
    <SessionCard
      key={session.sessionId}
      session={session}
      workspace={workspaceOf(workspaces, session.cwd)}
      showSource={isRemoteSource(session.source)}
      stale={isStale(session)}
      onOpen={onOpen}
      onArchive={onArchive}
      onDelete={onDelete}
      onFocus={onFocus}
      onRename={onRename}
    />
  );

  const renderGroup = (name: string, items: SessionRecord[]) => {
    const collapsed = collapsedGroups.includes(name);
    const needAttention = items.filter((session) => session.status === "waiting" || session.status === "idle").length;
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
                {item.key === "hub" && counts.hub > 0 ? ` (${counts.hub})` : ""}
                {item.key === "share" && counts.share > 0 ? ` (${counts.share})` : ""}
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

      {grouped.names.map((name) => {
        const items = grouped.byName.get(name) ?? [];
        return items.length === 0 ? null : renderGroup(name, items);
      })}
      {grouped.ungrouped.length > 0 && renderGroup(UNGROUPED, grouped.ungrouped)}

      {list.length === 0 && filter === "all" && clientFilter === "all" && query.trim().length === 0 && (
        <p className="empty">No live Claude Code sessions. Start one in a terminal, VS Code or Claude Desktop and it appears here.</p>
      )}
      {list.length === 0 && (filter !== "all" || clientFilter !== "all" || query.trim().length > 0) && <p className="empty">Nothing matches this filter.</p>}

      {filter === "all" && liveCodex.length > 0 && (
        <section className="group group--codex">
          <h2>
            <span className="group__title group__title--static">
              <span className="group__name">Codex threads</span>
              <span className="group__count">{liveCodex.length}</span>
              <span className="group__note">read from ~/.codex/sessions · app, CLI and exec runs · not started by the hub</span>
            </span>
          </h2>
          <div className="grid">
            {liveCodex.map((session) => (
              <CodexCard key={session.id} session={session} workspace={workspaceOf(workspaces, session.cwd)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
