import { useEffect, useRef, useState } from "react";
import { fetchSessionLive, focusSession, markSessionSeen, type ClaimRecord } from "../api";
import { claudeClient, sessionClient } from "../clients";
import { IconClose, IconExpand, IconFocus } from "../icons";
import { fetchSessionAsks, type SessionAsks } from "../api";
import { relativeTime } from "../time";
import type { SessionLive, SessionRecord, TranscriptEntry } from "../types";
import { folderPeers } from "../peers";
import { taskStatusTone } from "../runs-model";
import { prettyModel } from "./SessionCard";
import { Markdown } from "../markdown";
import { listTasksByOrigin, type TaskRecord } from "../delegation";
import { TASK_STATUS_LABEL } from "./TaskCard";
import { useDrawerWidth, DRAWER_WIDTH } from "../use-layout-size";
import { ResizableDrawerEdge } from "./ResizableDrawerEdge";
import { CardMenu, useCardMenu, type CardMenuItem } from "./CardMenu";
import { RunChip } from "./RunChips";
import { Toggletip } from "./Toggletip";
import { sessionMenuKeys, sessionPrimaryAction, sessionRelations, sessionTabs, visibleTab, type SessionMenuKey, type SessionTab } from "../drawer-model";
import { shortFolder } from "../wsmatch";
import { LIST_WINDOW } from "../show-more";
import { ClampScope, ClampText, ShowMoreList } from "./ShowMore";

interface Props {
  session: SessionRecord;
  sessions?: Record<string, SessionRecord>;
  workspace: string | null;
  claims?: ClaimRecord[];
  delegatedEnabled: boolean;
  onReleaseClaim?: (id: string) => void;
  onClose: () => void;
  onShare?: (sessionId: string) => void;
  onArchive?: (sessionId: string) => void;
  onOpenTask?: (taskId: string) => void;
}

const ROLE_LABEL: Record<TranscriptEntry["role"], string> = {
  user: "you",
  assistant: "claude",
  tool: "tool",
  result: "result",
};

function entryKey(entry: TranscriptEntry, seen: Map<string, number>): string {
  const text = entry.text ?? "";
  const base = `${entry.at ?? "?"}:${entry.role}:${text.length}:${text.slice(0, 32)}`;
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}#${count}`;
}

const SUBAGENT_TURNS = 3;

const isConversation = (entry: TranscriptEntry): boolean => entry.role === "user" || entry.role === "assistant";

interface TimelineProps {
  entries: TranscriptEntry[];
  empty: string;
  detail: boolean;
  onShowDetail: () => void;
  assistantLabel?: string;
  resetKey?: string;
  initial?: number;
}

export function Timeline({ entries, empty, detail, onShowDetail, assistantLabel = ROLE_LABEL.assistant, resetKey = "timeline", initial = LIST_WINDOW.initial }: TimelineProps) {
  if (entries.length === 0) return <p className="hint">{empty}</p>;
  const shown = detail ? entries : entries.filter(isConversation);
  const hidden = entries.length - shown.length;
  const seen = new Map<string, number>();
  const keyed = shown.map((entry) => ({ entry, key: entryKey(entry, seen) }));
  return (
    <>
      <ShowMoreList
        items={keyed}
        resetKey={`${resetKey}:${detail ? "detail" : "conversation"}`}
        from="end"
        options={{ ...LIST_WINDOW, initial }}
        noun="turns"
        wrap={(rows) => <ol className="timeline">{rows}</ol>}
        render={({ entry, key }) => (
          <li key={key} className={`timeline__item timeline__item--${entry.role}`}>
            <span className="timeline__role">{entry.tool ?? (entry.role === "assistant" ? assistantLabel : ROLE_LABEL[entry.role])}</span>
            <ClampText className="timeline__text" markdown={entry.role === "assistant"} scopeKey={`${resetKey}:${key}`}>
              {entry.role === "assistant" ? <Markdown text={entry.text || "(empty)"} /> : entry.text || "(empty)"}
            </ClampText>
            {entry.at && <time className="timeline__time">{relativeTime(entry.at)}</time>}
          </li>
        )}
      />
      {!detail && hidden > 0 && (
        <button type="button" className="timeline__hidden" onClick={onShowDetail}>
          {hidden} tool step{hidden === 1 ? "" : "s"} hidden · Detailed
        </button>
      )}
    </>
  );
}

const shortName = (session: SessionRecord): string => session.customTitle ?? session.title ?? session.sessionId.slice(0, 8);

export function SessionDrawer({ session, sessions = {}, workspace, claims = [], delegatedEnabled, onReleaseClaim, onClose, onShare, onArchive, onOpenTask }: Props) {
  const [pickedTab, setTab] = useState<SessionTab>("activity");
  const [live, setLive] = useState<SessionLive | null>(null);
  const liveAgents = live?.agents ?? [];
  const tabs = sessionTabs({
    agentsTotal: Math.max(liveAgents.length, session.agentsTotal ?? 0),
    agentsRunning: live ? liveAgents.filter((agent) => agent.status === "running").length : (session.agentsRunning ?? 0),
    asks: session.remoteAsks ?? 0,
    forks: session.forks ?? 0,
    delegated: session.delegatedTasks ?? 0,
    delegatedOn: delegatedEnabled,
  });
  const tab = visibleTab(pickedTab, tabs, "activity");
  const menu = useCardMenu();
  const [delegated, setDelegated] = useState<TaskRecord[] | null>(null);
  useEffect(() => {
    if (tab !== "delegated") return;
    let mounted = true;
    const load = () => void listTasksByOrigin(session.sessionId).then((data) => mounted && setDelegated(data)).catch(() => undefined);
    load();
    const timer = setInterval(load, 5000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [tab, session.sessionId, session.delegatedTasks]);
  const [asks, setAsks] = useState<SessionAsks | null>(null);
  useEffect(() => {
    if (tab !== "asks") return;
    let mounted = true;
    const load = () => void fetchSessionAsks(session.sessionId).then((data) => mounted && setAsks(data)).catch(() => undefined);
    load();
    const timer = setInterval(load, 5000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [tab, session.sessionId]);
  const [error, setError] = useState<string | null>(null);

  const markedRef = useRef<{ id: string; unread: boolean } | null>(null);
  const unread = session.unread === true;
  useEffect(() => {
    const last = markedRef.current;
    markedRef.current = { id: session.sessionId, unread };
    if (last && last.id === session.sessionId && (last.unread === unread || !unread)) return;
    void markSessionSeen(session.sessionId);
  }, [session.sessionId, unread]);

  useEffect(() => {
    let mounted = true;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const load = (): Promise<void> =>
      fetchSessionLive(session.sessionId)
        .then((value) => {
          if (mounted) {
            setLive(value);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (!mounted) return;
          setError(err instanceof Error ? err.message : "failed to load");
          if (retries < 5) {
            retries += 1;
            retryTimer = setTimeout(() => void load(), 1_000);
          }
        });
    void load();
    const interval = session.status === "ended" ? 15_000 : 3_000;
    const id = setInterval(() => void load(), interval);
    return () => {
      mounted = false;
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(id);
    };
  }, [session.sessionId, session.status, session.updatedAt]);

  const [detail, setDetail] = useState<boolean>(() => {
    try {
      return localStorage.getItem("hub.timeline.detail") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("hub.timeline.detail", detail ? "1" : "0");
    } catch {
      void 0;
    }
  }, [detail]);

  const [full, setFull] = useState(false);
  const drawerWidth = useDrawerWidth("session", full, true);
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (full) setFull(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, full]);

  useEffect(() => {
    if (full) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panelRef.current?.contains(target) || target.closest(".card-menu")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [full, onClose]);

  const current = live?.session ?? session;
  const finished = current.unread === true && current.status === "idle";
  const name = current.customTitle ?? current.title ?? current.sessionId.slice(0, 8);
  const agents = liveAgents;
  const silentAgents = agents.filter((agent) => agent.status !== "running" && agent.transcript.length === 0);
  const shownAgents = agents.filter((agent) => !silentAgents.includes(agent));
  const silentGroups = [...silentAgents.reduce((map, agent) => map.set(agent.agentType ?? "agent", (map.get(agent.agentType ?? "agent") ?? 0) + 1), new Map<string, number>())];
  const primary = sessionPrimaryAction({ status: current.status, stale: current.stale === true });
  const clientInfo = sessionClient(current);
  const canShare = !!onShare && !!workspace && current.status !== "ended";
  const menuAction: Record<SessionMenuKey, CardMenuItem> = {
    share: { key: "share", label: "Share", onSelect: () => onShare?.(current.sessionId) },
    large: { key: "large", label: full ? "Back to the side panel" : "Open in a large view", onSelect: () => setFull((value) => !value) },
    archive: { key: "archive", label: "Archive", onSelect: () => onArchive?.(current.sessionId) },
  };
  const nameOf = (id: string | null | undefined): string | null => {
    const found = id ? sessions[id] : undefined;
    return found ? shortName(found) : null;
  };
  const relations = sessionRelations({
    forkOf: current.forkOf ?? null,
    forkParentName: nameOf(current.forkOf),
    helperOf: current.helperOf ?? null,
    helperParentName: nameOf(current.helperOf),
    helpers: current.helpers ?? 0,
    helpersTotal: current.helpersTotal ?? 0,
    peers: folderPeers(current.cwd, Object.values(sessions), [], { sessionId: current.sessionId }),
  });
  const menuItems = sessionMenuKeys({ canShare, archived: current.archivedAt != null || !onArchive }).map((key) => menuAction[key]);

  return (
    <>
    {full && <div className="drawer__backdrop" onClick={() => setFull(false)} />}
    <aside ref={panelRef} className={`drawer ${full ? "drawer--full" : ""}`} style={drawerWidth.style} role="dialog" aria-label={name}>
      <header className="drawer__header">
        <div className="drawer__title">
          <div className="drawer__name">
            <button className="act act--icon drawer__expand" onClick={() => setFull((value) => !value)} aria-label={full ? "Back to the side panel" : "Open in a large view"} title={full ? "Back to the side panel" : "Open in a large view"}>
              <IconExpand />
            </button>
            <h2 title={name}>{name}</h2>
          </div>
          <div className="card__badges">
            <span className={`tag tag--${finished ? "unread" : current.status}`}>{finished ? "finished" : current.stale ? "inactive" : current.status}</span>
            <RunChip info={clientInfo} label={workspace ?? shortFolder(current.cwd)} title={`${clientInfo.label} · ${shortFolder(current.cwd)}`} />
          </div>
        </div>
        <div className="drawer__actions">
          {primary === "focus" && (
            <button className="act act--focus" onClick={() => void focusSession(current.sessionId)}>
              <IconFocus /> Focus
            </button>
          )}
          <CardMenu menu={menu} items={menuItems} label={`Actions for ${name}`} />
          <button className="act act--icon" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
      </header>

      <div className="drawer__tabs" role="tablist">
        {tabs.map((item) => (
          <button key={item.key} role="tab" aria-selected={tab === item.key} className={`pill ${tab === item.key ? "pill--on" : ""}`} onClick={() => setTab(item.key)}>
            {item.label}
            {item.count !== undefined && <span className="pill__count">{item.count}</span>}
          </button>
        ))}
      </div>

      <div className="drawer__body">
        <ClampScope resetKey={session.sessionId}>
          {error && <p className="error">{error}</p>}
          {tab === "activity" && (
            <>
              <div className="timeline__bar">
                <Toggletip label="About this activity">
                  Last turns read from the session transcript. Refreshes every {current.status === "ended" ? "15" : "3"} seconds.
                </Toggletip>
                <div className="pillpair">
                  <button className={`pill ${detail ? "" : "pill--on"}`} onClick={() => setDetail(false)}>
                    Conversation
                  </button>
                  <button className={`pill ${detail ? "pill--on" : ""}`} onClick={() => setDetail(true)}>
                    Detailed
                  </button>
                </div>
              </div>
              <Timeline
                entries={live?.transcript ?? []}
                empty={live ? "No transcript yet for this session." : "Loading…"}
                detail={detail}
                onShowDetail={() => setDetail(true)}
                resetKey={`activity:${session.sessionId}`}
              />
            </>
          )}
          {tab === "agents" && (
            <>
              {agents.length === 0 && <p className="hint">{live ? "This session has not spawned subagents." : "Loading subagents…"}</p>}
              <ShowMoreList
                items={shownAgents}
                resetKey={`agents:${session.sessionId}`}
                noun="subagents"
                render={(agent) => (
                  <section key={agent.agentId} className={`agent agent--${agent.status}`}>
                    <header className="agent__head">
                      <span className="agent__type">{agent.agentType ?? "agent"}</span>
                      <span className={`tag tag--${agent.status === "running" ? "active" : "ended"}`}>{agent.status}</span>
                      <time>{relativeTime(agent.updatedAt)}</time>
                    </header>
                    {agent.lastMessage && (
                      <ClampText className="agent__last" lines={3} scopeKey={`agent-last:${agent.agentId}`}>
                        {agent.lastMessage}
                      </ClampText>
                    )}
                    <Timeline
                      entries={agent.transcript}
                      empty="No transcript for this subagent yet."
                      detail={detail}
                      onShowDetail={() => setDetail(true)}
                      resetKey={`agent:${agent.agentId}`}
                      initial={SUBAGENT_TURNS}
                    />
                  </section>
                )}
              />
              {silentGroups.map(([type, count]) => (
                <section key={`silent-${type}`} className="agent agent--ended">
                  <header className="agent__head">
                    <span className="agent__type">{type}</span>
                    <span className="tag tag--ended">ended</span>
                    <span className="muted small">{count === 1 ? "1 run" : `${count} runs`} · no transcript on disk</span>
                  </header>
                </section>
              ))}
            </>
          )}
          {tab === "asks" && (
            <>
              <div className="timeline__bar">
                <Toggletip label="About asks">Questions other people asked this session through a share, each in its own fork (the original stays untouched).</Toggletip>
              </div>
              {asks === null && <p className="hint">Loading asks…</p>}
              {asks && asks.forks.length > 0 && (
                <ShowMoreList
                  items={asks.forks}
                  resetKey={`forks:${session.sessionId}`}
                  noun="forks"
                  wrap={(rows) => <ul className="plainlist">{rows}</ul>}
                  render={(fork) => (
                    <li key={`${fork.shareId}-${fork.asker}`} title={`fork ${fork.sessionId}`}>
                      <strong>{fork.asker}</strong> · {fork.questions} question{fork.questions === 1 ? "" : "s"} · last {relativeTime(fork.lastUsedAt)}
                    </li>
                  )}
                />
              )}
              {asks && asks.asks.length === 0 && <p className="hint">Nobody asked this session yet.</p>}
              <ShowMoreList
                items={asks?.asks ?? []}
                resetKey={`asks:${session.sessionId}`}
                noun="asks"
                wrap={(rows) => <ul className="activity">{rows}</ul>}
                render={(item) => (
                  <li key={item.id} className="activity__item">
                    <div className="activity__head">
                      <span className={`tag tag--req-${item.status}`}>{item.status}</span>
                      <strong>{item.asker ?? "someone"}</strong>
                      <span className="muted small">{relativeTime(item.createdAt)}</span>
                    </div>
                    <ClampText className="activity__prompt" scopeKey={`ask:${item.id}`}>
                      {item.prompt}
                    </ClampText>
                    {item.answer && (
                      <details className="activity__answer">
                        <summary>answer</summary>
                        <ClampText className="activity__answer-pre" scopeKey={`answer:${item.id}`}>
                          {item.answer}
                        </ClampText>
                      </details>
                    )}
                  </li>
                )}
              />
            </>
          )}
          {tab === "delegated" && (
            <>
              {delegated === null && <p className="hint">Loading delegated tasks…</p>}
              {delegated !== null && delegated.length === 0 && <p className="hint">This session has not delegated work to the hub.</p>}
              <ShowMoreList
                items={delegated ?? []}
                resetKey={`delegated:${session.sessionId}`}
                noun="tasks"
                render={(task) => (
                  <section key={task.id} className={`agent agent--${task.status === "running" || task.status === "pending" ? "running" : "ended"} ${task.archivedAt != null ? "agent--archived" : ""}`}>
                    <header className="agent__head">
                      <span className="agent__type">{task.runner}</span>
                      <span className={`tag tag--${taskStatusTone(task)}`} data-status={task.status}>{TASK_STATUS_LABEL[task.status]}</span>
                      {task.archivedAt != null && <span className="tag tag--muted">archived</span>}
                      <time>{relativeTime(task.updatedAt)}</time>
                    </header>
                    <p className="agent__last">
                      <button className="link" onClick={() => onOpenTask?.(task.id)} disabled={!onOpenTask} title="Open in Delegated">
                        {task.title}
                      </button>
                    </p>
                    {task.lastError && (
                      <ClampText className="agent__last error" lines={3} scopeKey={`task-error:${task.id}`}>
                        {task.lastError}
                      </ClampText>
                    )}
                  </section>
                )}
              />
            </>
          )}
          {tab === "details" && (
            <dl className="details">
              <dt>Session id</dt>
              <dd>
                <code>{current.sessionId}</code>
              </dd>
              <dt>Client</dt>
              <dd>{claudeClient(current.client).label}</dd>
              <dt>Source</dt>
              <dd>{current.source ?? "—"}</dd>
              <dt>Working directory</dt>
              <dd className="path">{current.cwd ?? "—"}</dd>
              <dt>Model</dt>
              <dd>{current.model ?? "—"}</dd>
              <dt>Tokens</dt>
              <dd>
                in {current.tokensIn ?? "—"} · out {current.tokensOut ?? "—"} · context {current.contextTokens ?? "—"}
              </dd>
              <dt>Processes</dt>
              <dd>
                claude {current.claudePid ?? "—"} · window {current.hostPid ?? "—"}
              </dd>
              <dt>Delegated</dt>
              <dd>
                {current.delegatedTasks ?? 0} total · {current.delegatedRunning ?? 0} running
              </dd>
              <dt>Forks</dt>
              <dd>
                {current.forks ?? 0} total · {current.forksLive ?? 0} live · {current.remoteAsks ?? 0} asks
              </dd>
              <dt>Fork of</dt>
              <dd>{relations.fork}</dd>
              <dt>Helpers</dt>
              <dd>{relations.helpers}</dd>
              <dt>Peers</dt>
              <dd>{relations.peers}</dd>
              <dt>Subagents</dt>
              <dd>
                {current.agentsRunning ?? 0} running · {current.agentsTotal ?? 0} spawned
              </dd>
              <dt>Transcript</dt>
              <dd className="path">{current.transcriptPath ?? "—"}</dd>
              <dt>Started</dt>
              <dd>{new Date(current.startedAt).toLocaleString()}</dd>
              <dt>Updated</dt>
              <dd>{new Date(current.updatedAt).toLocaleString()}</dd>
              <dt>File claims</dt>
              <dd>
                {claims.length === 0 && "—"}
                {claims.length > 0 && (
                  <ul className="plainlist">
                    {claims.map((claim) => (
                      <li key={claim.id}>
                        {claim.paths.join(", ")} · until {new Date(claim.expiresAt).toLocaleString()}
                        {claim.note ? ` · ${claim.note}` : ""}{" "}
                        <button className="linklike" onClick={() => onReleaseClaim?.(claim.id)} disabled={!onReleaseClaim}>
                          Release
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
          )}
        </ClampScope>
      </div>
      {drawerWidth.resizable && (
        <ResizableDrawerEdge
          width={drawerWidth.width}
          minWidth={DRAWER_WIDTH.min}
          maxWidth={drawerWidth.maxWidth}
          defaultWidth={DRAWER_WIDTH.default}
          onWidthChange={drawerWidth.setWidth}
          ariaLabel="Resize session panel"
        />
      )}
    </aside>
    </>
  );
}
