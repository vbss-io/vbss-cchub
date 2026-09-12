import { useEffect, useRef, useState } from "react";
import { fetchSessionLive, focusSession, type ClaimRecord } from "../api";
import { ClientBadge, claudeClient, sessionClient } from "../clients";
import { IconClose, IconExpand, IconFocus, IconShare } from "../icons";
import { fetchSessionAsks, type SessionAsks } from "../api";
import { relativeTime } from "../time";
import type { SessionLive, SessionRecord, TranscriptEntry } from "../types";
import { prettyModel } from "./SessionCard";
import { Markdown } from "../markdown";
import { listTasksByOrigin, type TaskRecord } from "../delegation";
import { TASK_STATUS_LABEL } from "./TaskCard";

interface Props {
  session: SessionRecord;
  workspace: string | null;
  claims?: ClaimRecord[];
  onReleaseClaim?: (id: string) => void;
  onClose: () => void;
  onShare?: (sessionId: string) => void;
  onOpenTask?: (taskId: string) => void;
}

type Tab = "activity" | "agents" | "asks" | "delegated" | "details";

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

const isConversation = (entry: TranscriptEntry): boolean => entry.role === "user" || entry.role === "assistant";

export function Timeline({ entries, empty, detail, onShowDetail, assistantLabel = ROLE_LABEL.assistant }: { entries: TranscriptEntry[]; empty: string; detail: boolean; onShowDetail: () => void; assistantLabel?: string }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  if (entries.length === 0) return <p className="hint">{empty}</p>;
  const toggle = (key: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const shown = detail ? entries : entries.filter(isConversation);
  const hidden = entries.length - shown.length;
  const seen = new Map<string, number>();
  return (
    <>
      <ol className="timeline">
        {shown.map((entry) => {
          const key = entryKey(entry, seen);
          const long = (entry.text ?? "").length > 240 || (entry.text ?? "").split("\n").length > 5;
          const isOpen = open.has(key);
          return (
            <li
              key={key}
              className={`timeline__item timeline__item--${entry.role} ${long ? "timeline__item--expandable" : ""} ${isOpen ? "timeline__item--open" : ""}`}
              onClick={() => long && toggle(key)}
              title={long ? (isOpen ? "Click to collapse" : "Click to read everything") : undefined}
            >
              <span className="timeline__role">{entry.tool ?? (entry.role === "assistant" ? assistantLabel : ROLE_LABEL[entry.role])}</span>
              <span className="timeline__text">
                {entry.role === "assistant" ? <Markdown text={entry.text || "(empty)"} /> : entry.text || "(empty)"}
              </span>
              {entry.at && <time className="timeline__time">{relativeTime(entry.at)}</time>}
            </li>
          );
        })}
      </ol>
      {!detail && hidden > 0 && (
        <button type="button" className="timeline__hidden" onClick={onShowDetail}>
          {hidden} tool step{hidden === 1 ? "" : "s"} hidden · Detailed
        </button>
      )}
    </>
  );
}

export function SessionDrawer({ session, workspace, claims = [], onReleaseClaim, onClose, onShare, onOpenTask }: Props) {
  const [tab, setTab] = useState<Tab>("activity");
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
  const [live, setLive] = useState<SessionLive | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const target = event.target as Node | null;
      if (target && panelRef.current && !panelRef.current.contains(target)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [full, onClose]);

  const current = live?.session ?? session;
  const name = current.customTitle ?? current.title ?? current.sessionId.slice(0, 8);
  const agents = live?.agents ?? [];
  const running = agents.filter((agent) => agent.status === "running").length;
  const silentAgents = agents.filter((agent) => agent.status !== "running" && agent.transcript.length === 0);
  const shownAgents = agents.filter((agent) => !silentAgents.includes(agent));
  const silentGroups = [...silentAgents.reduce((map, agent) => map.set(agent.agentType ?? "agent", (map.get(agent.agentType ?? "agent") ?? 0) + 1), new Map<string, number>())];

  return (
    <>
    {full && <div className="drawer__backdrop" onClick={() => setFull(false)} />}
    <aside ref={panelRef} className={`drawer ${full ? "drawer--full" : ""}`} role="dialog" aria-label={name}>
      <header className="drawer__header">
        <div className="drawer__title">
          <div className="drawer__name">
            <button className="act act--icon drawer__expand" onClick={() => setFull((value) => !value)} aria-label={full ? "Back to the side panel" : "Open in a large view"} title={full ? "Back to the side panel" : "Open in a large view"}>
              <IconExpand />
            </button>
            <h2 title={name}>{name}</h2>
          </div>
          <div className="card__badges">
            <ClientBadge info={sessionClient(current)} />
            <span className={`tag tag--${current.status}`}>{current.stale ? "inactive" : current.status}</span>
            {workspace && <span className="chip chip--ws">{workspace}</span>}
            {prettyModel(current.model) && <span className="chip">{prettyModel(current.model)}</span>}
          </div>
        </div>
        <div className="drawer__actions">
          {current.status !== "ended" && !current.stale && (
            <button className="act act--focus" onClick={() => void focusSession(current.sessionId)}>
              <IconFocus /> Focus
            </button>
          )}
          {onShare && workspace && current.status !== "ended" && (
            <button className="act" onClick={() => onShare(current.sessionId)} title="Create a link so someone else can ask this session">
              <IconShare size={14} /> Share
            </button>
          )}
          <button className="act act--icon" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
      </header>

      <div className="drawer__tabs">
        <button className={`pill ${tab === "activity" ? "pill--on" : ""}`} onClick={() => setTab("activity")}>
          Activity
        </button>
        <button className={`pill ${tab === "agents" ? "pill--on" : ""}`} onClick={() => setTab("agents")}>
          Subagents {agents.length > 0 && <span className="pill__count">{running > 0 ? `${running}/${agents.length}` : agents.length}</span>}
        </button>
        <button className={`pill ${tab === "asks" ? "pill--on" : ""}`} onClick={() => setTab("asks")}>
          Asks {(current.remoteAsks ?? 0) > 0 && <span className="pill__count">{current.remoteAsks}</span>}
        </button>
        <button className={`pill ${tab === "delegated" ? "pill--on" : ""}`} onClick={() => setTab("delegated")}>
          Delegated {(current.delegatedTasks ?? 0) > 0 && <span className="pill__count">{current.delegatedTasks}</span>}
        </button>
        <button className={`pill ${tab === "details" ? "pill--on" : ""}`} onClick={() => setTab("details")}>
          Details
        </button>
      </div>

      <div className="drawer__body">
        {error && <p className="error">{error}</p>}
        {tab === "activity" && (
          <>
            <div className="timeline__bar">
              <p className="hint">
                Last turns read from the session transcript. Refreshes every {current.status === "ended" ? "15" : "3"} seconds.
              </p>
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
            />
          </>
        )}
        {tab === "agents" && (
          <>
            {agents.length === 0 && <p className="hint">This session has not spawned subagents.</p>}
            {shownAgents.map((agent) => (
              <section key={agent.agentId} className={`agent agent--${agent.status}`}>
                <header className="agent__head">
                  <span className="agent__type">{agent.agentType ?? "agent"}</span>
                  <span className={`tag tag--${agent.status === "running" ? "active" : "ended"}`}>{agent.status}</span>
                  <time>{relativeTime(agent.updatedAt)}</time>
                </header>
                {agent.lastMessage && <p className="agent__last">{agent.lastMessage}</p>}
                <Timeline entries={agent.transcript} empty="No transcript for this subagent yet." detail={detail} onShowDetail={() => setDetail(true)} />
              </section>
            ))}
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
            <p className="hint">Questions other people asked this session through a share, each in its own fork (the original stays untouched).</p>
            {asks && asks.forks.length > 0 && (
              <ul className="plainlist">
                {asks.forks.map((fork) => (
                  <li key={`${fork.shareId}-${fork.asker}`}>
                    <strong>{fork.asker}</strong> · {fork.questions} question{fork.questions === 1 ? "" : "s"} · last {relativeTime(fork.lastUsedAt)} · fork <code>{fork.sessionId.slice(0, 8)}</code>
                  </li>
                ))}
              </ul>
            )}
            {asks && asks.asks.length === 0 && <p className="hint">Nobody asked this session yet.</p>}
            <ul className="activity">
              {(asks?.asks ?? []).map((item) => (
                <li key={item.id} className="activity__item">
                  <div className="activity__head">
                    <span className={`tag tag--req-${item.status}`}>{item.status}</span>
                    <strong>{item.asker ?? "someone"}</strong>
                    <span className="muted small">{relativeTime(item.createdAt)}</span>
                  </div>
                  <p className="activity__prompt">{item.prompt}</p>
                  {item.answer && (
                    <details className="activity__answer">
                      <summary>answer</summary>
                      <pre>{item.answer}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {tab === "delegated" && (
          <>
            {delegated === null && <p className="hint">Loading delegated tasks…</p>}
            {delegated !== null && delegated.length === 0 && <p className="hint">This session has not delegated work to the hub.</p>}
            {delegated?.map((task) => (
              <section key={task.id} className={`agent agent--${task.status === "running" || task.status === "pending" ? "running" : "ended"} ${task.archivedAt != null ? "agent--archived" : ""}`}>
                <header className="agent__head">
                  <span className="agent__type">{task.runner}</span>
                  <span className={`tag tag--${task.status}`}>{TASK_STATUS_LABEL[task.status]}</span>
                  {task.archivedAt != null && <span className="tag tag--muted">archived</span>}
                  <time>{relativeTime(task.updatedAt)}</time>
                </header>
                <p className="agent__last">
                  <button className="link" onClick={() => onOpenTask?.(task.id)} disabled={!onOpenTask} title="Open in Delegated">
                    {task.title}
                  </button>
                </p>
                {task.lastError && <p className="agent__last error">{task.lastError}</p>}
              </section>
            ))}
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
      </div>
    </aside>
    </>
  );
}
