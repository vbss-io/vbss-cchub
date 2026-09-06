import { useEffect, useState } from "react";
import { fetchSessionLive, focusSession } from "../api";
import { ClientBadge, claudeClient, sessionClient } from "../clients";
import { IconClose, IconFocus, IconShare } from "../icons";
import { fetchSessionAsks, type SessionAsks } from "../api";
import { relativeTime } from "../time";
import type { SessionLive, SessionRecord, TranscriptEntry } from "../types";
import { prettyModel } from "./SessionCard";

interface Props {
  session: SessionRecord;
  workspace: string | null;
  onClose: () => void;
  onShare?: (sessionId: string) => void;
}

type Tab = "activity" | "agents" | "asks" | "details";

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

function Timeline({ entries, empty }: { entries: TranscriptEntry[]; empty: string }) {
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
  const seen = new Map<string, number>();
  return (
    <ol className="timeline">
      {entries.map((entry) => {
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
            <span className="timeline__role">{entry.tool ?? ROLE_LABEL[entry.role]}</span>
            <span className="timeline__text">{entry.text || "(empty)"}</span>
            {entry.at && <time className="timeline__time">{relativeTime(entry.at)}</time>}
          </li>
        );
      })}
    </ol>
  );
}

export function SessionDrawer({ session, workspace, onClose, onShare }: Props) {
  const [tab, setTab] = useState<Tab>("activity");
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
    const load = () =>
      fetchSessionLive(session.sessionId)
        .then((value) => {
          if (mounted) {
            setLive(value);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (mounted) setError(err instanceof Error ? err.message : "failed to load");
        });
    void load();
    const interval = session.status === "ended" ? 15_000 : 3_000;
    const id = setInterval(() => void load(), interval);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [session.sessionId, session.status, session.updatedAt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const current = live?.session ?? session;
  const name = current.customTitle ?? current.title ?? current.sessionId.slice(0, 8);
  const agents = live?.agents ?? [];
  const running = agents.filter((agent) => agent.status === "running").length;

  return (
    <aside className="drawer" role="dialog" aria-label={name}>
      <header className="drawer__header">
        <div className="drawer__title">
          <h2 title={name}>{name}</h2>
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
        <button className={`pill ${tab === "details" ? "pill--on" : ""}`} onClick={() => setTab("details")}>
          Details
        </button>
      </div>

      <div className="drawer__body">
        {error && <p className="error">{error}</p>}
        {tab === "activity" && (
          <>
            <p className="hint">
              Last turns read from the session transcript. Refreshes every {current.status === "ended" ? "15" : "3"} seconds.
            </p>
            <Timeline entries={live?.transcript ?? []} empty={live ? "No transcript yet for this session." : "Loading…"} />
          </>
        )}
        {tab === "agents" && (
          <>
            {agents.length === 0 && <p className="hint">This session has not spawned subagents.</p>}
            {agents.map((agent) => (
              <section key={agent.agentId} className={`agent agent--${agent.status}`}>
                <header className="agent__head">
                  <span className="agent__type">{agent.agentType ?? "agent"}</span>
                  <span className={`tag tag--${agent.status === "running" ? "active" : "ended"}`}>{agent.status}</span>
                  <time>{relativeTime(agent.updatedAt)}</time>
                </header>
                {agent.lastMessage && <p className="agent__last">{agent.lastMessage}</p>}
                <Timeline entries={agent.transcript} empty="No transcript for this subagent yet." />
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
            <dt>Transcript</dt>
            <dd className="path">{current.transcriptPath ?? "—"}</dd>
            <dt>Started</dt>
            <dd>{new Date(current.startedAt).toLocaleString()}</dd>
            <dt>Updated</dt>
            <dd>{new Date(current.updatedAt).toLocaleString()}</dd>
          </dl>
        )}
      </div>
    </aside>
  );
}
