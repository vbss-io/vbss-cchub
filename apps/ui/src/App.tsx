import { useEffect, useMemo, useRef, useState } from "react";
import {
  archiveSession,
  createGroup,
  deleteGroup,
  deleteSession,
  fetchGroups,
  fetchSessions,
  focusSession,
  getHooks,
  renameSession,
  reorderGroups,
  setHooks,
  subscribe,
  updateGroup,
  type HooksStatus,
} from "./api";
import { BrandMark, Wordmark } from "./components/BrandMark";
import { GroupManager } from "./components/GroupManager";
import { SessionCard } from "./components/SessionCard";
import { isMock, MOCK_GROUPS, MOCK_SESSIONS } from "./mock";
import { COFFEE_URL, notify, openExternal, playSound, unlockAudio } from "./notify";
import { isStale } from "./stale";
import type { GroupRecord, SessionRecord, SessionStatus } from "./types";

type SortKey = "status" | "recent" | "name";
type FilterKey = SessionStatus | "all" | "archived" | "stale";

interface NotifSettings {
  attention: boolean;
  finished: boolean;
  desktop: boolean;
  sound: boolean;
}

const DEFAULT_NOTIF: NotifSettings = { attention: true, finished: true, desktop: true, sound: true };

function loadNotif(): NotifSettings {
  try {
    return { ...DEFAULT_NOTIF, ...JSON.parse(localStorage.getItem("hub.notifications") ?? "{}") };
  } catch {
    return DEFAULT_NOTIF;
  }
}

const sortRank: Record<SessionStatus, number> = {
  waiting: 0,
  idle: 1,
  active: 2,
  ended: 3,
};

const STATUS_ORDER: SessionStatus[] = ["waiting", "idle", "active", "ended"];

const STATUS_LABELS: Record<SessionStatus, string> = {
  waiting: "Waiting",
  idle: "Idle",
  active: "Active",
  ended: "Ended",
};

const projectOf = (session: SessionRecord): string => {
  if (!session.cwd) return session.sessionId.slice(0, 8);
  const parts = session.cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? session.cwd;
};

const byRecent = (a: SessionRecord, b: SessionRecord): number => b.updatedAt - a.updatedAt;

export function App() {
  const [sessions, setSessions] = useState<Record<string, SessionRecord>>({});
  const [hooks, setHooksState] = useState<HooksStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<SortKey>("status");
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [managing, setManaging] = useState(false);
  const [tick, setTick] = useState(0);
  const [notifSettings, setNotifSettings] = useState<NotifSettings>(loadNotif);
  const [showNotif, setShowNotif] = useState(false);
  const [toolbarOpen, setToolbarOpen] = useState(() => localStorage.getItem("hub.toolbar") !== "0");

  const toggleToolbar = () => {
    setToolbarOpen((open) => {
      localStorage.setItem("hub.toolbar", open ? "0" : "1");
      return !open;
    });
  };
  const notifRef = useRef(notifSettings);

  useEffect(() => {
    notifRef.current = notifSettings;
    localStorage.setItem("hub.notifications", JSON.stringify(notifSettings));
  }, [notifSettings]);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (isMock) {
      setHooksState({ installed: true, events: [], wsl: [{ distro: "Ubuntu-24.04", installed: true }] });
      return;
    }
    void getHooks()
      .then(setHooksState)
      .catch(() => setHooksState({ installed: false, events: [] }));
  }, []);

  const toggleHooks = async () => {
    if (!hooks || busy) return;
    setBusy(true);
    try {
      setHooksState(await setHooks(!hooks.installed));
    } finally {
      setBusy(false);
    }
  };

  const archive = (sessionId: string) => {
    void archiveSession(sessionId);
  };

  const remove = (sessionId: string) => {
    void deleteSession(sessionId);
  };

  const focus = (sessionId: string) => {
    void focusSession(sessionId);
  };

  const rename = (sessionId: string, title: string) => {
    void renameSession(sessionId, title);
  };

  const archiveStale = () => {
    for (const session of Object.values(sessions)) {
      if (isStale(session)) void archiveSession(session.sessionId);
    }
  };

  const addGroup = (name: string, match: string) => void createGroup(name, match);
  const editGroup = (id: string, fields: { name?: string; match?: string }) =>
    void updateGroup(id, fields);
  const removeGroup = (id: string) => void deleteGroup(id);
  const moveGroup = (id: string, direction: -1 | 1) => {
    const index = groups.findIndex((group) => group.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= groups.length) return;
    const ids = groups.map((group) => group.id);
    const moved = ids[index];
    const swap = ids[target];
    if (moved === undefined || swap === undefined) return;
    ids[index] = swap;
    ids[target] = moved;
    void reorderGroups(ids);
  };

  useEffect(() => {
    if (isMock) {
      setSessions(Object.fromEntries(MOCK_SESSIONS.map((s) => [s.sessionId, s])));
      setGroups(MOCK_GROUPS);
      return;
    }
    let mounted = true;
    void fetchSessions().then((list) => {
      if (!mounted) return;
      setSessions(Object.fromEntries(list.map((session) => [session.sessionId, session])));
    });
    void fetchGroups().then((list) => {
      if (mounted) setGroups(list);
    });
    const unsubscribe = subscribe(
      (session) => {
        setSessions((prev) => {
          const before = prev[session.sessionId];
          if (session.archivedAt == null && (!before || before.status !== session.status)) {
            const cfg = notifRef.current;
            const label = session.customTitle ?? session.title ?? projectOf(session);
            if ((session.status === "waiting" || session.status === "idle") && cfg.attention) {
              if (cfg.desktop) {
                void notify(
                  "VBSS CCHUB",
                  `${label} • ${session.status === "waiting" ? "needs a decision" : "paused"}`,
                );
              }
              if (cfg.sound) {
                void playSound(session.status === "idle" ? "idle" : "attention");
                navigator.vibrate?.(session.status === "waiting" ? [90, 60, 90] : 160);
              }
            } else if (session.status === "ended" && before && cfg.finished) {
              if (cfg.desktop) void notify("VBSS CCHUB", `${label} • finished`);
              if (cfg.sound) void playSound("finished");
            }
          }
          return { ...prev, [session.sessionId]: session };
        });
      },
      (sessionId) => {
        setSessions((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
      },
      (nextGroups) => {
        if (mounted) setGroups(nextGroups);
      },
      (nextHooks) => {
        if (mounted) setHooksState(nextHooks);
      },
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const counts = useMemo(() => {
    const result = { waiting: 0, idle: 0, active: 0, ended: 0, stale: 0, archived: 0 };
    for (const session of Object.values(sessions)) {
      if (session.archivedAt != null) result.archived += 1;
      else if (session.status === "ended") result.ended += 1;
      else if (isStale(session)) result.stale += 1;
      else result[session.status] += 1;
    }
    return result;
  }, [sessions, tick]);

  const total = counts.waiting + counts.idle + counts.active;
  const attention = counts.waiting + counts.idle;

  useEffect(() => {
    document.title = attention > 0 ? `(${attention}) VBSS CCHUB` : "VBSS CCHUB";
    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (attention > 0) nav.setAppBadge?.(attention)?.catch(() => {});
    else nav.clearAppBadge?.()?.catch(() => {});
  }, [attention]);

  const list = useMemo(() => {
    const all = Object.values(sessions);
    const filtered = all.filter((session) => {
      const archived = session.archivedAt != null;
      const stale = !archived && session.status !== "ended" && isStale(session);
      if (filter === "archived") return archived;
      if (archived) return false;
      if (filter === "stale") return stale;
      if (stale) return false;
      if (filter === "all") return session.status !== "ended";
      return session.status === filter;
    });
    return filtered.sort((a, b) => {
      if (sort === "recent") return byRecent(a, b);
      if (sort === "name") {
        const nameA = (a.customTitle ?? a.title ?? projectOf(a)).toLowerCase();
        const nameB = (b.customTitle ?? b.title ?? projectOf(b)).toLowerCase();
        return nameA.localeCompare(nameB) || byRecent(a, b);
      }
      return sortRank[a.status] - sortRank[b.status] || byRecent(a, b);
    });
  }, [sessions, filter, sort, tick]);

  const grouped = useMemo(() => {
    const groupNameFor = (session: SessionRecord): string | null => {
      const cwd = (session.cwd ?? "").toLowerCase();
      for (const group of groups) {
        const pattern = group.match.trim().toLowerCase();
        if (pattern && cwd.includes(pattern)) return group.name;
      }
      return null;
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
      const bucket = name ? byName.get(name) : undefined;
      if (bucket) bucket.push(session);
      else ungrouped.push(session);
    }
    return { names, byName, ungrouped };
  }, [list, groups]);

  const showSource = useMemo(() => {
    const sources = new Set<string>();
    for (const session of Object.values(sessions)) if (session.source) sources.add(session.source);
    return sources.size > 1;
  }, [sessions]);

  const renderCard = (session: SessionRecord) => (
    <SessionCard
      key={session.sessionId}
      session={session}
      showSource={showSource}
      stale={isStale(session)}
      onArchive={archive}
      onDelete={remove}
      onFocus={focus}
      onRename={rename}
    />
  );

  return (
    <main className="app">
      <header className="topbar">
        <h1 className="brand">
          <BrandMark size={34} />
          <span className="brand__wm">
            <Wordmark />
            <span className="brand__slogan">Run many. Forget none.</span>
          </span>
        </h1>
        <div className="topbar__actions">
          <span className="badge">{attention} need attention</span>
          <button
            className={`hookbtn ${hooks?.installed ? "hookbtn--on" : ""}`}
            onClick={() => void toggleHooks()}
            disabled={busy || !hooks}
          >
            {busy
              ? "Working…"
              : !hooks
                ? "Checking hooks…"
                : hooks.installed
                  ? `Hooks active${
                      (hooks.wsl?.filter((w) => w.installed).length ?? 0) > 0
                        ? ` (+${hooks.wsl?.filter((w) => w.installed).length} WSL)`
                        : ""
                    } — remove`
                  : "Set up hooks"}
          </button>
          <button
            className="coffee"
            onClick={() => void openExternal(COFFEE_URL)}
            title="Buy me a coffee"
            aria-label="Buy me a coffee"
          >
            ☕
          </button>
          <button
            className="hdr-toggle"
            onClick={toggleToolbar}
            title={toolbarOpen ? "Hide filters" : "Show filters"}
            aria-label={toolbarOpen ? "Hide filters" : "Show filters"}
          >
            {toolbarOpen ? "▴" : "▾"}
          </button>
        </div>
      </header>

      {toolbarOpen && (
      <nav className="toolbar">
        <div className="filters">
          <button
            className={`pill ${filter === "all" ? "pill--on" : ""}`}
            onClick={() => setFilter("all")}
          >
            All <span className="pill__count">{total}</span>
          </button>
          {STATUS_ORDER.map((status) => (
            <button
              key={status}
              className={`pill pill--${status} ${filter === status ? "pill--on" : ""}`}
              onClick={() => setFilter(status)}
            >
              {STATUS_LABELS[status]} <span className="pill__count">{counts[status]}</span>
            </button>
          ))}
          {counts.stale > 0 && (
            <button
              className={`pill pill--stale ${filter === "stale" ? "pill--on" : ""}`}
              onClick={() => setFilter("stale")}
            >
              Inactive <span className="pill__count">{counts.stale}</span>
            </button>
          )}
          <button
            className={`pill pill--archived ${filter === "archived" ? "pill--on" : ""}`}
            onClick={() => setFilter("archived")}
          >
            Archived <span className="pill__count">{counts.archived}</span>
          </button>
        </div>
        <div className="toolbar__right">
          {filter === "stale" && counts.stale > 0 && (
            <button className="pill pill--danger" onClick={archiveStale}>
              Archive inactive ({counts.stale})
            </button>
          )}
          <button
            className={`pill ${showNotif ? "pill--on" : ""}`}
            onClick={() => setShowNotif((value) => !value)}
          >
            Notifications
          </button>
          <button
            className={`pill ${managing ? "pill--on" : ""}`}
            onClick={() => setManaging((value) => !value)}
          >
            Groups {groups.length > 0 && <span className="pill__count">{groups.length}</span>}
          </button>
          <label className="sort">
            Sort
            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
              <option value="status">Status</option>
              <option value="recent">Recent</option>
              <option value="name">Name</option>
            </select>
          </label>
        </div>
      </nav>
      )}

      {toolbarOpen && showNotif && (
        <div className="notifcfg">
          <label className="notifcfg__item">
            <input
              type="checkbox"
              checked={notifSettings.attention}
              onChange={(e) => setNotifSettings((s) => ({ ...s, attention: e.target.checked }))}
            />
            On attention (waiting/idle)
          </label>
          <label className="notifcfg__item">
            <input
              type="checkbox"
              checked={notifSettings.finished}
              onChange={(e) => setNotifSettings((s) => ({ ...s, finished: e.target.checked }))}
            />
            On finish (ended)
          </label>
          <span className="notifcfg__sep" />
          <label className="notifcfg__item">
            <input
              type="checkbox"
              checked={notifSettings.desktop}
              onChange={(e) => setNotifSettings((s) => ({ ...s, desktop: e.target.checked }))}
            />
            Desktop notification
          </label>
          <label className="notifcfg__item">
            <input
              type="checkbox"
              checked={notifSettings.sound}
              onChange={(e) => setNotifSettings((s) => ({ ...s, sound: e.target.checked }))}
            />
            Sound
          </label>
          <button className="act" onClick={() => void playSound("attention")}>
            Test decision
          </button>
          <button className="act" onClick={() => void playSound("idle")}>
            Test idle
          </button>
          <button className="act" onClick={() => void playSound("finished")}>
            Test finish
          </button>
        </div>
      )}

      {toolbarOpen && managing && (
        <GroupManager
          groups={groups}
          onCreate={addGroup}
          onUpdate={editGroup}
          onDelete={removeGroup}
          onMove={moveGroup}
        />
      )}

      {groups.length === 0 ? (
        <section className="grid">{list.map(renderCard)}</section>
      ) : (
        <>
          {grouped.names.map((name) => {
            const items = grouped.byName.get(name) ?? [];
            if (items.length === 0) return null;
            return (
              <section key={name} className="group">
                <h2 className="group__title">
                  {name} <span className="group__count">{items.length}</span>
                </h2>
                <div className="grid">{items.map(renderCard)}</div>
              </section>
            );
          })}
          {grouped.ungrouped.length > 0 && (
            <section className="group">
              <h2 className="group__title">
                Ungrouped <span className="group__count">{grouped.ungrouped.length}</span>
              </h2>
              <div className="grid">{grouped.ungrouped.map(renderCard)}</div>
            </section>
          )}
        </>
      )}

      {list.length === 0 && filter === "all" && (
        <p className="empty">No active sessions. Set up the Claude Code hooks.</p>
      )}
      {list.length === 0 && filter !== "all" && <p className="empty">Nothing in this filter.</p>}
    </main>
  );
}
