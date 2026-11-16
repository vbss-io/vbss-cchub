import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchHealth, type ClaimRecord } from "../api";
import { needsYou } from "../attention";
import { claudeClient, isHubRun } from "../clients";
import { CodexCard } from "../components/CodexCard";
import { RunsFilters, type RunsFilterOption } from "../components/RunsFilters";
import { SessionCard } from "../components/SessionCard";
import { TaskCard, taskOrigin, type RetryMode } from "../components/TaskCard";
import { Toggletip } from "../components/Toggletip";
import { cancelTask, type TaskRecord, type WorkspaceRecord } from "../delegation";
import { archiveTask, listArchivedTasks, retryTask, taskArchivedAt } from "../delegation-actions";
import { IconSearch } from "../icons";
import { folderPeers } from "../peers";
import {
  emptyFold,
  filterForOrigin,
  foldTaskRuns,
  needsByGroup,
  normalizeOrigin,
  ORIGIN_LABEL,
  originCounts,
  originIncludes,
  originOptions,
  partitionNeedsYou,
  taskBucket,
  taskNeedsYou,
  taskRunStatus,
  taskSummary,
  withLiveCounts,
  type Origin,
  type OriginEntry,
} from "../runs-model";
import { countsOf, isExtraFilter, LIVE_BUCKETS, matchesFilter, type Bucket, type FilterKey } from "../sessions-filter";
import type { SessionsMode } from "../sessions-mode";
import { isEmpty, isStale } from "../stale";
import type { CodexSessionRecord, GroupRecord, SessionRecord, SessionStatus } from "../types";
import { retryPermission, useArchiveSupport } from "../use-task-detail";
import { workspaceOf } from "../wsmatch";
import "../runs.css";

type SortKey = "status" | "recent" | "name";
type ClientFilter = "all" | "terminal" | "vscode" | "claude-desktop" | "wsl" | "hub" | "share" | "codex";

const UNGROUPED = "Ungrouped";
const NEEDS_YOU_BAND = "Needs you";
const HOME_PREFIX = /^(?:[a-z]:[\\/]users[\\/][^\\/]+|\/home\/[^/]+|\/users\/[^/]+)/i;

const sortRank: Record<SessionStatus, number> = { waiting: 0, idle: 1, active: 2, ended: 3 };
const CLIENT_FILTERS: readonly RunsFilterOption<ClientFilter>[] = [
  { key: "all", label: "All clients" },
  { key: "terminal", label: "Claude Code · terminal" },
  { key: "vscode", label: "Claude Code · VS Code" },
  { key: "claude-desktop", label: "Claude Desktop" },
  { key: "wsl", label: "WSL" },
  { key: "hub", label: "Hub runs (headless)" },
  { key: "share", label: "Share forks" },
  { key: "codex", label: "Codex threads" },
];
const SORTS: readonly RunsFilterOption<SortKey>[] = [
  { key: "status", label: "Status" },
  { key: "recent", label: "Recent" },
  { key: "name", label: "Name" },
];

const clientsFor = (origin: Origin): RunsFilterOption<ClientFilter>[] => {
  if (origin === "all") return [...CLIENT_FILTERS];
  if (origin === "claude") return CLIENT_FILTERS.filter((item) => item.key !== "codex");
  return [];
};

const projectOf = (session: SessionRecord): string => {
  if (!session.cwd) return session.sessionId.slice(0, 8);
  const parts = session.cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? session.cwd;
};

const nameOf = (session: SessionRecord): string => session.customTitle ?? session.title ?? projectOf(session);

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

interface ItemBase {
  id: string;
  status: SessionStatus;
  updatedAt: number;
  name: string;
  cwd: string | null;
  needs: boolean;
  workspace: string | null;
}

type Item =
  | (ItemBase & { kind: "claude"; session: SessionRecord })
  | (ItemBase & { kind: "codex"; thread: CodexSessionRecord })
  | (ItemBase & { kind: "task"; task: TaskRecord });

export interface MapControls {
  query: string;
  onQuery: (query: string) => void;
  origin: Origin;
}

function loadCollapsedGroups(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("hub.collapsedGroups") ?? "[]");
    return Array.isArray(stored) ? stored.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function saveCollapsedGroups(names: string[]): void {
  try {
    localStorage.setItem("hub.collapsedGroups", JSON.stringify(names));
  } catch {
    void 0;
  }
}

interface Props {
  sessions: Record<string, SessionRecord>;
  claims: ClaimRecord[];
  groups: GroupRecord[];
  workspaces: WorkspaceRecord[];
  codexSessions: CodexSessionRecord[];
  codexAppRunning: boolean;
  tasks: TaskRecord[];
  delegatedEnabled: boolean;
  hubEnabled: boolean;
  hubTick: number;
  origin: Origin;
  needsYouTop: boolean;
  selectedTaskId: string | null;
  mode: SessionsMode;
  modeSwitch?: ReactNode;
  renderMap?: (controls: MapControls) => ReactNode;
  tick: number;
  onOrigin: (origin: Origin) => void;
  onOpen: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenCodexSession?: (id: string) => void;
  onArchive: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => void;
  onFavorite: (sessionId: string, favorite: boolean) => void;
  onOpenCodex: (id: string) => void;
  onRenameCodex: (id: string, title: string) => void;
  onArchiveCodex: (id: string) => void;
  onUnarchiveCodex: (id: string) => void;
  onDeleteCodex: (id: string) => void;
  onOpenTask: (taskId: string) => void;
  onTasksChanged: () => Promise<void>;
  onOpenSettings: () => void;
  onError: (text: string) => void;
}

export function SessionsView({
  sessions,
  claims,
  groups,
  workspaces,
  codexSessions,
  codexAppRunning,
  tasks,
  delegatedEnabled,
  hubEnabled,
  hubTick,
  origin: requestedOrigin,
  needsYouTop,
  selectedTaskId,
  mode,
  modeSwitch,
  renderMap,
  tick,
  onOrigin,
  onOpen,
  onFocus,
  onOpenSession,
  onOpenCodexSession,
  onArchive,
  onDelete,
  onRename,
  onFavorite,
  onOpenCodex,
  onRenameCodex,
  onArchiveCodex,
  onUnarchiveCodex,
  onDeleteCodex,
  onOpenTask,
  onTasksChanged,
  onOpenSettings,
  onError,
}: Props) {
  const origin = normalizeOrigin(requestedOrigin, delegatedEnabled);
  const [pickedFilter, setFilter] = useState<FilterKey>("all");
  const filter = filterForOrigin(pickedFilter, origin);
  useEffect(() => {
    if (pickedFilter !== filter) setFilter(filter);
  }, [pickedFilter, filter]);
  const [clientFilter, setClientFilter] = useState<ClientFilter>("all");
  const [sort, setSort] = useState<SortKey>("status");
  const [query, setQuery] = useState("");
  const [localSource, setLocalSource] = useState<string | null>(null);
  const [archivedTasks, setArchivedTasks] = useState<TaskRecord[]>([]);
  const [taskBusy, setTaskBusy] = useState(false);
  const archiveSupported = useArchiveSupport();
  useEffect(() => {
    void fetchHealth().then((health) => setLocalSource(health.hostname)).catch(() => setLocalSource(null));
  }, []);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(loadCollapsedGroups);

  const clientOptions = clientsFor(origin);
  const effectiveClient: ClientFilter = clientOptions.some((item) => item.key === clientFilter) ? clientFilter : "all";
  const showTasks = delegatedEnabled && effectiveClient === "all" && originIncludes(origin, "delegated");

  useEffect(() => {
    if (!showTasks || filter !== "archived") return;
    let alive = true;
    void listArchivedTasks()
      .then((list) => {
        if (alive) setArchivedTasks(list);
      })
      .catch(() => {
        if (alive) setArchivedTasks([]);
      });
    return () => {
      alive = false;
    };
  }, [showTasks, filter, hubTick]);

  const toggleGroup = (name: string) => {
    setCollapsedGroups((current) => {
      const next = current.includes(name) ? current.filter((item) => item !== name) : [...current, name];
      saveCollapsedGroups(next);
      return next;
    });
  };

  const liveTasks = useMemo(() => tasks.filter((task) => taskArchivedAt(task) == null), [tasks]);
  const fold = useMemo(() => (delegatedEnabled ? foldTaskRuns([...liveTasks, ...archivedTasks], codexSessions) : emptyFold()), [delegatedEnabled, liveTasks, archivedTasks, codexSessions]);

  const originTotals = useMemo(() => {
    const entries: OriginEntry[] = [];
    for (const session of Object.values(sessions)) entries.push({ origin: "claude", live: LIVE_BUCKETS.includes(bucketOf(session, "all")) });
    for (const thread of codexSessions) {
      entries.push({ origin: "codex", live: LIVE_BUCKETS.includes(codexBucketOf(thread)), folded: delegatedEnabled && fold.foldedThreads.has(thread.id) });
    }
    const now = Date.now();
    if (delegatedEnabled) for (const task of liveTasks) entries.push({ origin: "delegated", live: LIVE_BUCKETS.includes(taskBucket(task, now)) });
    return originCounts(entries);
  }, [sessions, codexSessions, liveTasks, delegatedEnabled, fold, tick]);

  const clientLive = useMemo(() => {
    const live: Partial<Record<ClientFilter, number>> = {};
    for (const option of CLIENT_FILTERS) {
      if (option.key === "all") continue;
      const key = option.key;
      live[key] =
        key === "codex"
          ? codexSessions.filter((thread) => LIVE_BUCKETS.includes(codexBucketOf(thread))).length
          : Object.values(sessions).filter((session) => matchesClient(session, key) && LIVE_BUCKETS.includes(bucketOf(session, key))).length;
    }
    return live;
  }, [sessions, codexSessions, tick]);

  const { counts, needs, favorites, list } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const tally: Record<Exclude<Bucket, "hidden">, number> = { waiting: 0, idle: 0, active: 0, ended: 0, stale: 0, archived: 0, empty: 0 };
    const matched: Item[] = [];
    let needing = 0;
    let favorited = 0;
    const matchesQuery = (text: string): boolean => needle.length === 0 || text.toLowerCase().includes(needle);
    const take = (bucket: Exclude<Bucket, "hidden">, attention: boolean, item: Item) => {
      tally[bucket] += 1;
      if (matchesFilter("needs-you", bucket, attention)) needing += 1;
      if (matchesFilter(filter, bucket, attention)) matched.push(item);
    };
    if (originIncludes(origin, "claude")) {
      for (const session of Object.values(sessions)) {
        const name = nameOf(session);
        const base = { id: session.sessionId, status: session.status, updatedAt: session.updatedAt, name, cwd: session.cwd, workspace: workspaceOf(workspaces, session.cwd) };
        const searchable = `${name} ${session.cwd ?? ""} ${session.lastMessage ?? ""}`;
        if (session.favoriteAt != null && matchesQuery(searchable)) {
          favorited += 1;
          if (filter === "favorites") matched.push({ ...base, kind: "claude", session, needs: false });
        }
        if (!matchesClient(session, effectiveClient) || !matchesQuery(searchable)) continue;
        const bucket = bucketOf(session, effectiveClient);
        if (bucket === "hidden") continue;
        const attention = needsYou(session);
        take(bucket, attention, { ...base, kind: "claude", session, needs: attention && LIVE_BUCKETS.includes(bucket) });
      }
    }
    if (originIncludes(origin, "codex") && (effectiveClient === "all" || effectiveClient === "codex")) {
      for (const thread of codexSessions) {
        if (showTasks && fold.foldedThreads.has(thread.id)) continue;
        const bucket = codexBucketOf(thread);
        if (bucket === "hidden") continue;
        const name = codexNameOf(thread);
        if (!matchesQuery(`${name} ${thread.cwd ?? ""} ${thread.lastMessage ?? ""}`)) continue;
        const attention = thread.status === "waiting";
        take(bucket, attention, { id: thread.id, kind: "codex", thread, status: thread.status, updatedAt: thread.updatedAt, name, cwd: thread.cwd, needs: attention && LIVE_BUCKETS.includes(bucket), workspace: workspaceOf(workspaces, thread.cwd) });
      }
    }
    if (showTasks) {
      const now = Date.now();
      const source = filter === "archived" ? archivedTasks : liveTasks;
      for (const task of source) {
        if (!matchesQuery(`${task.title} ${task.workspace} ${task.repo ?? ""}`)) continue;
        const bucket = taskBucket(task, now);
        if (bucket === "hidden") continue;
        const attention = taskNeedsYou(task.status) && taskArchivedAt(task) == null;
        take(bucket, attention, {
          id: task.id,
          kind: "task",
          task,
          status: taskRunStatus(task, now),
          updatedAt: task.updatedAt,
          name: task.title,
          cwd: task.cwd,
          needs: attention,
          workspace: workspaceOf(workspaces, task.cwd) ?? task.workspace,
        });
      }
    }
    const sorted = matched.sort((a, b) => {
      if (sort === "recent") return b.updatedAt - a.updatedAt;
      if (sort === "name") return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || b.updatedAt - a.updatedAt;
      return sortRank[a.status] - sortRank[b.status] || b.updatedAt - a.updatedAt;
    });
    return { counts: tally, needs: needing, favorites: favorited, list: sorted };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, codexSessions, liveTasks, archivedTasks, workspaces, filter, origin, effectiveClient, showTasks, fold, sort, query, tick]);

  const sessionValues = useMemo(() => Object.values(sessions), [sessions]);
  const claimsBySession = useMemo(() => {
    const map = new Map<string, number>();
    for (const claim of claims) {
      if (!claim.sessionId) continue;
      map.set(claim.sessionId, (map.get(claim.sessionId) ?? 0) + 1);
    }
    return map;
  }, [claims]);

  const groupNameFor = useMemo(() => {
    return (item: Item): string => {
      const lower = (item.cwd ?? "").toLowerCase().replace(HOME_PREFIX, "");
      for (const group of groups) {
        const pattern = group.match.trim().toLowerCase();
        if (pattern && lower.includes(pattern)) return group.name;
      }
      return item.workspace ?? UNGROUPED;
    };
  }, [groups]);

  const { band, rest } = useMemo(() => partitionNeedsYou(list, needsYouTop && filter === "all"), [list, needsYouTop, filter]);
  const bandByGroup = useMemo(() => needsByGroup(band, groupNameFor), [band, groupNameFor]);

  const grouped = useMemo(() => {
    const names: string[] = [];
    const byName = new Map<string, Item[]>();
    const ensure = (name: string) => {
      if (!byName.has(name)) {
        byName.set(name, []);
        if (name !== UNGROUPED) names.push(name);
      }
    };
    for (const group of groups) ensure(group.name);
    for (const item of rest) {
      const name = groupNameFor(item);
      ensure(name);
      byName.get(name)?.push(item);
    }
    for (const name of bandByGroup.keys()) ensure(name);
    return { names, byName };
  }, [rest, groups, groupNameFor, bandByGroup]);

  const isRemoteSource = (source: string | null): boolean => !!source && (!localSource || source.toLowerCase() !== localSource.toLowerCase());

  const taskAct = async (action: () => Promise<void>) => {
    setTaskBusy(true);
    try {
      await action();
      await onTasksChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "action failed");
    } finally {
      setTaskBusy(false);
    }
  };
  const doCancel = (id: string) => void taskAct(async () => void (await cancelTask(id)));
  const doArchiveTask = (id: string) => void taskAct(async () => await archiveTask(id));
  const doRetry = (task: TaskRecord, mode: RetryMode) => void taskAct(async () => await retryTask(task.id, retryPermission(mode)));

  const total = counts.waiting + counts.idle + counts.active;
  const summary = useMemo(() => taskSummary(tasks, Date.now()), [tasks]);

  const renderCard = (item: Item) => {
    if (item.kind === "codex") {
      return (
        <CodexCard
          key={`codex-${item.thread.id}`}
          session={item.thread}
          workspace={item.workspace}
          codexAppRunning={codexAppRunning}
          onOpen={onOpenCodex}
          onOpenSession={onOpenCodexSession}
          onRename={onRenameCodex}
          onArchive={onArchiveCodex}
          onUnarchive={onUnarchiveCodex}
          onDelete={onDeleteCodex}
        />
      );
    }
    if (item.kind === "task") {
      const task = item.task;
      const runSessionId = fold.sessionOf.get(task.id);
      return (
        <TaskCard
          key={`task-${task.id}`}
          task={task}
          origin={taskOrigin(task, sessions)}
          runSession={runSessionId ? (sessions[runSessionId] ?? null) : null}
          selected={selectedTaskId === task.id}
          archiveSupported={archiveSupported}
          busy={taskBusy}
          peers={folderPeers(task.cwd, sessionValues, liveTasks, { taskId: task.id })}
          onSelect={onOpenTask}
          onOpenSession={onOpen}
          onCancel={doCancel}
          onArchive={doArchiveTask}
          onRetry={doRetry}
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
        workspace={item.workspace}
        showSource={isRemoteSource(session.source)}
        stale={isStale(session)}
        peers={folderPeers(session.cwd, sessionValues, [], { sessionId: session.sessionId })}
        forkParentName={forkParentName}
        claimsCount={claimsBySession.get(session.sessionId) ?? 0}
        onOpen={onOpen}
        onArchive={onArchive}
        onDelete={onDelete}
        onFocus={onFocus}
        onOpenSession={onOpenSession}
        onRename={onRename}
        onFavorite={onFavorite}
      />
    );
  };

  const renderGroup = (name: string, items: Item[]) => {
    const collapsed = collapsedGroups.includes(name);
    const moved = bandByGroup.get(name) ?? 0;
    const inside = items.filter((item) => item.needs).length;
    const needCount = moved + (collapsed ? inside : 0);
    if (items.length === 0 && moved === 0) return null;
    return (
      <section key={name} className={`group ${collapsed ? "group--collapsed" : ""}`}>
        <h2>
          <button className="group__title" onClick={() => toggleGroup(name)} aria-expanded={!collapsed}>
            <span className="group__caret">{collapsed ? "▸" : "▾"}</span>
            <span className="group__name">{name}</span>
            <span className="group__count">{items.length}</span>
            {needCount > 0 && <span className="group__attn">{needCount} need you</span>}
          </button>
        </h2>
        {!collapsed && items.length > 0 && <div className="grid">{items.map(renderCard)}</div>}
      </section>
    );
  };

  const help = (
    <>
      <strong>Origin</strong> picks what runs here: Claude Code sessions, Codex threads{delegatedEnabled ? " or work delegated to the hub" : ""}.{" "}
      {delegatedEnabled && "A delegated task folds the hub session that runs it. "}
      {delegatedEnabled ? "Hub runs are headless sessions launched by delegated tasks" : "Hub runs are headless sessions the hub launches"}; they never notify and stay out of All. Share forks answer people through your share links. Codex threads are read from
      ~/.codex/sessions and are read-only here. Client and sort live under Filters.{modeSwitch ? " List and Flow show the same runs as cards or as a live graph." : ""}
    </>
  );

  const noFilters = filter === "all" && effectiveClient === "all" && query.trim().length === 0;
  const emptyLabel = origin === "codex" ? "Codex threads" : origin === "delegated" ? "delegated tasks" : origin === "claude" ? "Claude sessions" : "sessions";

  const mapMode = mode === "map" && renderMap !== undefined;

  return (
    <div className={`view view--runs ${mapMode ? "view--runs-map" : ""}`}>
      <div className="runs-head">
        <div className="runs-origin" role="group" aria-label="Origin">
          {originOptions(delegatedEnabled).map((key) => (
            <button
              key={key}
              type="button"
              className={`runs-origin__btn ${origin === key ? "runs-origin__btn--on" : ""}`}
              aria-pressed={origin === key}
              onClick={() => {
                setClientFilter("all");
                onOrigin(key);
              }}
            >
              {ORIGIN_LABEL[key]} <span className="pill__count">{originTotals[key]}</span>
            </button>
          ))}
        </div>
        <div className="runs-head__right">
          {!mapMode && (
            <Toggletip label="About this view" align="end">
              {help}
            </Toggletip>
          )}
          {modeSwitch && <div className="runs-head__mode">{modeSwitch}</div>}
        </div>
      </div>

      {mapMode && renderMap({ query, onQuery: setQuery, origin })}

      {!mapMode && (
      <>
      <div className="toolbar runs-toolbar">
        <div className="filters">
          <button className={`pill ${filter === "all" ? "pill--on" : ""}`} onClick={() => setFilter("all")}>
            All <span className="pill__count">{total}</span>
          </button>
          <button
            className={`pill pill--needs ${filter === "needs-you" ? "pill--on" : ""}`}
            onClick={() => setFilter("needs-you")}
            title="Waiting on a decision, finished turns you have not looked at, and delegated tasks that need you"
          >
            Needs you <span className="pill__count">{needs}</span>
          </button>
          <button className={`pill pill--active ${filter === "active" ? "pill--on" : ""}`} onClick={() => setFilter("active")}>
            Active <span className="pill__count">{counts.active}</span>
          </button>
          <button className={`pill pill--idle ${filter === "idle" ? "pill--on" : ""}`} onClick={() => setFilter("idle")}>
            Idle <span className="pill__count">{counts.idle}</span>
          </button>
          {originIncludes(origin, "claude") && (
            <button className={`pill pill--favorites ${filter === "favorites" ? "pill--on" : ""}`} onClick={() => setFilter("favorites")} title="Sessions you starred, regardless of status or archive state">
              Favorites <span className="pill__count">{favorites}</span>
            </button>
          )}
          <select
            className={`select select--also ${isExtraFilter(filter) ? "select--also-on" : ""}`}
            aria-label="Show also"
            value={isExtraFilter(filter) ? filter : ""}
            onChange={(event) => setFilter(event.target.value === "" ? "all" : (event.target.value as FilterKey))}
          >
            <option value="">Show also</option>
            {countsOf(counts).map((item) => (
              <option key={item.key} value={item.key} title={item.hint}>
                {item.label}
                {item.key === "archived" && showTasks ? "" : ` (${item.count})`}
              </option>
            ))}
          </select>
        </div>
        <div className="toolbar__right">
          <label className="search">
            <IconSearch />
            <input className="in" placeholder="search title, folder, message" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <RunsFilters
            clients={withLiveCounts(clientOptions, clientLive)}
            client={effectiveClient}
            onClient={setClientFilter}
            sorts={SORTS}
            sort={sort}
            onSort={setSort}
            active={(effectiveClient === "all" ? 0 : 1) + (sort === "status" ? 0 : 1)}
          />
        </div>
      </div>

      {origin === "delegated" && (
        <p className="runs-summary">
          {summary.running} running · {summary.needYou} need you · {summary.doneToday} done today · {summary.failed} failed
        </p>
      )}

      {band.length > 0 && (
        <section className="group group--needs" aria-label={NEEDS_YOU_BAND}>
          <h2>
            <span className="group__title group__title--static">
              <span className="group__name">{NEEDS_YOU_BAND}</span>
              <span className="group__count">{band.length}</span>
            </span>
          </h2>
          <div className="grid">{band.map(renderCard)}</div>
        </section>
      )}

      {grouped.names.map((name) => renderGroup(name, grouped.byName.get(name) ?? []))}
      {renderGroup(UNGROUPED, grouped.byName.get(UNGROUPED) ?? [])}

      {list.length === 0 && origin === "delegated" && !hubEnabled && (
        <p className="empty">
          The hub surface is off on this server.{" "}
          <button className="linklike" onClick={onOpenSettings}>
            Open connections
          </button>
          .
        </p>
      )}
      {list.length === 0 && origin === "delegated" && hubEnabled && tasks.length === 0 && noFilters && (
        <p className="empty">
          Nothing delegated yet. Any connected agent can hand work to the hub with <code>hub_delegate</code>.{" "}
          <button className="linklike" onClick={onOpenSettings}>
            Connect the clients
          </button>
          .
        </p>
      )}
      {list.length === 0 && origin !== "delegated" && noFilters && counts.ended === 0 && (
        <p className="empty">No live {emptyLabel}. Start one in a terminal, VS Code or Claude Desktop and it appears here.</p>
      )}
      {list.length === 0 && filter === "all" && query.trim().length === 0 && counts.ended > 0 && !(origin === "delegated" && tasks.length === 0) && (
        <p className="empty">
          No live {effectiveClient === "all" ? emptyLabel : (CLIENT_FILTERS.find((item) => item.key === effectiveClient)?.label ?? emptyLabel)}. {counts.ended} ended -{" "}
          <button className="linklike" onClick={() => setFilter("ended")}>
            open the Ended list
          </button>
          .
        </p>
      )}
      {list.length === 0 && !(filter === "all" && query.trim().length === 0) && <p className="empty">Nothing matches this filter.</p>}
      </>
      )}
    </div>
  );
}
