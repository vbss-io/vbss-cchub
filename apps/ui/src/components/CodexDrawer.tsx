import { useEffect, useRef, useState } from "react";
import { fetchCodexLive } from "../api";
import { ClientBadge, codexClient } from "../clients";
import { IconClose, IconExpand } from "../icons";
import { relativeTime } from "../time";
import type { CodexSessionRecord, TranscriptEntry } from "../types";
import { Timeline } from "./SessionDrawer";

interface Props {
  thread: CodexSessionRecord;
  workspace: string | null;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
}

type Tab = "activity" | "details";

const THREAD_SOURCE: Record<string, string> = {
  voice_chat: "voice chat",
  agent_created_thread: "created by an agent",
  user: "started by you",
};

const sourceLabel = (thread: CodexSessionRecord): string => {
  if (thread.origin === "hub") return "via hub";
  return thread.threadSource ? (THREAD_SOURCE[thread.threadSource] ?? thread.threadSource.replace(/_/g, " ")) : "—";
};

export function CodexDrawer({ thread, workspace, onClose, onOpenTask }: Props) {
  const [tab, setTab] = useState<Tab>("activity");
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const load = (): Promise<void> =>
      fetchCodexLive(thread.id)
        .then((value) => {
          if (mounted) {
            setEntries(value.entries);
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
    const live = thread.status === "active" || thread.status === "idle";
    const id = live ? setInterval(() => void load(), 5_000) : null;
    return () => {
      mounted = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (id) clearInterval(id);
    };
  }, [thread.id, thread.status, thread.updatedAt]);

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

  const name = thread.customTitle ?? thread.title;

  return (
    <>
      {full && <div className="drawer__backdrop" onClick={() => setFull(false)} />}
      <aside ref={panelRef} className={`drawer ${full ? "drawer--full" : ""}`} role="dialog" aria-label={name}>
        <header className="drawer__header">
          <div className="drawer__title">
            <div className="drawer__name">
              <button
                className="act act--icon drawer__expand"
                onClick={() => setFull((value) => !value)}
                aria-label={full ? "Back to the side panel" : "Open in a large view"}
                title={full ? "Back to the side panel" : "Open in a large view"}
              >
                <IconExpand />
              </button>
              <h2 title={name}>{name}</h2>
            </div>
            <div className="card__badges">
              <ClientBadge info={codexClient(thread.client)} />
              <span className={`tag tag--${thread.status}`}>{thread.status}</span>
              {workspace && <span className="chip chip--ws">{workspace}</span>}
            </div>
          </div>
          <div className="drawer__actions">
            <button className="act act--icon" onClick={onClose} aria-label="Close">
              <IconClose />
            </button>
          </div>
        </header>

        <div className="drawer__tabs">
          <button className={`pill ${tab === "activity" ? "pill--on" : ""}`} onClick={() => setTab("activity")}>
            Activity
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
                  Read from the Codex rollout. {thread.status === "active" || thread.status === "idle" ? "Refreshes every 5 seconds." : "This thread has ended."}
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
                assistantLabel="codex"
                entries={entries ?? []}
                empty={entries ? "No transcript yet for this thread." : "Loading…"}
                detail={detail}
                onShowDetail={() => setDetail(true)}
              />
            </>
          )}
          {tab === "details" && (
            <dl className="details">
              <dt>Thread id</dt>
              <dd>
                <code>{thread.id}</code>
              </dd>
              <dt>Working directory</dt>
              <dd className="path">{thread.cwd ?? "—"}</dd>
              <dt>Rollout file</dt>
              <dd className="path">{thread.file}</dd>
              <dt>Originator</dt>
              <dd>{thread.originator ?? "—"}</dd>
              <dt>Source</dt>
              <dd>{sourceLabel(thread)}</dd>
              <dt>Turns</dt>
              <dd>{thread.turns}</dd>
              <dt>Started</dt>
              <dd>{new Date(thread.startedAt).toLocaleString()}</dd>
              <dt>Updated</dt>
              <dd>{new Date(thread.updatedAt).toLocaleString()}</dd>
              {thread.hubTaskId && (
                <>
                  <dt>Hub task</dt>
                  <dd>
                    <button className="act" onClick={() => onOpenTask(thread.hubTaskId!)}>
                      Open in Delegated
                    </button>
                  </dd>
                </>
              )}
            </dl>
          )}
        </div>
      </aside>
    </>
  );
}
