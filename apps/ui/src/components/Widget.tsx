import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { fetchGroups, fetchSessions, focusSession, subscribe } from "../api";
import { BrandMark } from "./BrandMark";
import { isMock, MOCK_GROUPS, MOCK_SESSIONS } from "../mock";
import { isStale } from "../stale";
import type { GroupRecord, SessionRecord, SessionStatus } from "../types";

type SortKey = "status" | "recent" | "name";

interface WidgetConfig {
  sort: SortKey;
  grouped: boolean;
  attentionOnly: boolean;
}

const rank: Record<SessionStatus, number> = { waiting: 0, idle: 1, active: 2, ended: 3 };

const statusText: Record<SessionStatus, string> = {
  waiting: "input",
  idle: "idle",
  active: "active",
  ended: "done",
};

const nameOf = (session: SessionRecord): string =>
  session.customTitle ?? session.title ?? session.sessionId.slice(0, 8);

const groupNameOf = (session: SessionRecord, groups: GroupRecord[]): string | null => {
  const cwd = (session.cwd ?? "").toLowerCase();
  for (const group of groups) {
    const pattern = group.match.trim().toLowerCase();
    if (pattern && cwd.includes(pattern)) return group.name;
  }
  return null;
};

function loadConfig(): WidgetConfig {
  const fallback: WidgetConfig = { sort: "status", grouped: false, attentionOnly: false };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem("widget.config") ?? "{}") };
  } catch {
    return fallback;
  }
}

const stop = (event: MouseEvent) => event.stopPropagation();

async function startDrag(event: MouseEvent): Promise<void> {
  if (event.button !== 0 || !("__TAURI_INTERNALS__" in window)) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

async function hideWidget(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().hide();
}

const HEADER_H = 40;

async function currentHeight(): Promise<number | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const size = await win.innerSize();
  const scale = await win.scaleFactor();
  return Math.round(size.height / scale);
}

async function resizeHeight(height: number): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { LogicalSize } = await import("@tauri-apps/api/dpi");
  const win = getCurrentWindow();
  const size = await win.innerSize();
  const scale = await win.scaleFactor();
  await win.setSize(new LogicalSize(Math.round(size.width / scale), height));
}

export function Widget() {
  const [sessions, setSessions] = useState<Record<string, SessionRecord>>({});
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [config, setConfig] = useState<WidgetConfig>(loadConfig);
  const [showConfig, setShowConfig] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("widget.collapsed") === "1");
  const expandedHeight = useRef(Number(localStorage.getItem("widget.height")) || 440);

  useEffect(() => {
    localStorage.setItem("widget.config", JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    if (collapsed) void resizeHeight(HEADER_H);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleCollapse = async () => {
    if (!collapsed) {
      const height = await currentHeight();
      if (height && height > HEADER_H) {
        expandedHeight.current = height;
        localStorage.setItem("widget.height", String(height));
      }
      await resizeHeight(HEADER_H);
      setShowConfig(false);
      setCollapsed(true);
      localStorage.setItem("widget.collapsed", "1");
    } else {
      await resizeHeight(expandedHeight.current);
      setCollapsed(false);
      localStorage.setItem("widget.collapsed", "0");
    }
  };

  useEffect(() => {
    if (isMock) {
      setSessions(Object.fromEntries(MOCK_SESSIONS.map((s) => [s.sessionId, s])));
      setGroups(MOCK_GROUPS);
      return;
    }
    let mounted = true;
    void fetchSessions().then((list) => {
      if (mounted) setSessions(Object.fromEntries(list.map((s) => [s.sessionId, s])));
    });
    void fetchGroups().then((list) => {
      if (mounted) setGroups(list);
    });
    const unsubscribe = subscribe(
      (session) => setSessions((prev) => ({ ...prev, [session.sessionId]: session })),
      (sessionId) =>
        setSessions((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        }),
      (nextGroups) => {
        if (mounted) setGroups(nextGroups);
      },
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const list = useMemo(() => {
    let arr = Object.values(sessions).filter(
      (s) => s.archivedAt == null && s.status !== "ended" && !isStale(s),
    );
    if (config.attentionOnly) {
      arr = arr.filter((s) => s.status === "waiting" || s.status === "idle");
    }
    return arr.sort((a, b) => {
      if (config.sort === "recent") return b.updatedAt - a.updatedAt;
      if (config.sort === "name") {
        return nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase()) || b.updatedAt - a.updatedAt;
      }
      return rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt;
    });
  }, [sessions, config.sort, config.attentionOnly]);

  const attention = useMemo(
    () =>
      Object.values(sessions).filter(
        (s) =>
          s.archivedAt == null &&
          !isStale(s) &&
          (s.status === "waiting" || s.status === "idle"),
      ).length,
    [sessions],
  );

  const sections = useMemo(() => {
    if (!config.grouped || groups.length === 0) return null;
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
      const name = groupNameOf(session, groups);
      const bucket = name ? byName.get(name) : undefined;
      if (bucket) bucket.push(session);
      else ungrouped.push(session);
    }
    return { names, byName, ungrouped };
  }, [list, groups, config.grouped]);

  const renderRow = (session: SessionRecord) => (
    <button
      key={session.sessionId}
      className={`wrow wrow--${session.status}`}
      title={session.cwd ?? ""}
      onClick={() => void focusSession(session.sessionId)}
    >
      <span className="wdot" />
      <span className="wname">{nameOf(session)}</span>
      <span className="wstatus">{statusText[session.status]}</span>
    </button>
  );

  return (
    <div className="widget">
      <div className="widget__head" data-tauri-drag-region onMouseDown={(e) => void startDrag(e)}>
        <BrandMark size={15} />
        <span className="widget__title" data-tauri-drag-region>
          VBSS CCHUB
        </span>
        {attention > 0 && (
          <span className="widget__attn" data-tauri-drag-region title="need attention">
            {attention}
          </span>
        )}
        <span className="widget__count" data-tauri-drag-region>
          {list.length}
        </span>
        <button
          className="widget__btn"
          onMouseDown={stop}
          onClick={() => void toggleCollapse()}
          title={collapsed ? "Expand" : "Collapse"}
          aria-label={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▴" : "▾"}
        </button>
        {!collapsed && (
          <button
            className={`widget__btn ${showConfig ? "widget__btn--on" : ""}`}
            onMouseDown={stop}
            onClick={() => setShowConfig((value) => !value)}
            title="Settings"
            aria-label="Settings"
          >
            ⚙
          </button>
        )}
        <button
          className="widget__btn"
          onMouseDown={stop}
          onClick={() => void hideWidget()}
          title="Hide"
          aria-label="Hide widget"
        >
          –
        </button>
      </div>

      {showConfig && (
        <div className="widget__config">
          <label className="widget__cfg">
            Sort
            <select
              value={config.sort}
              onChange={(e) => setConfig((c) => ({ ...c, sort: e.target.value as SortKey }))}
            >
              <option value="status">Status</option>
              <option value="recent">Recent</option>
              <option value="name">Name</option>
            </select>
          </label>
          <label className="widget__cfg">
            <input
              type="checkbox"
              checked={config.grouped}
              onChange={(e) => setConfig((c) => ({ ...c, grouped: e.target.checked }))}
            />
            Group
          </label>
          <label className="widget__cfg">
            <input
              type="checkbox"
              checked={config.attentionOnly}
              onChange={(e) => setConfig((c) => ({ ...c, attentionOnly: e.target.checked }))}
            />
            Attention only
          </label>
        </div>
      )}

      {!collapsed && (
        <div className="widget__list">
          {sections ? (
            <>
              {sections.names.map((name) => {
                const items = sections.byName.get(name) ?? [];
                if (items.length === 0) return null;
                return (
                  <div key={name}>
                    <div className="widget__group">{name}</div>
                    {items.map(renderRow)}
                  </div>
                );
              })}
              {sections.ungrouped.length > 0 && (
                <div>
                  <div className="widget__group">Ungrouped</div>
                  {sections.ungrouped.map(renderRow)}
                </div>
              )}
            </>
          ) : (
            list.map(renderRow)
          )}
          {list.length === 0 && <div className="widget__empty">No active sessions</div>}
        </div>
      )}
    </div>
  );
}
