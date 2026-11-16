import { useEffect, useRef, useState } from "react";
import { canOpenCodex, canReplyToCodex, replyBlock, type ReplyBlock } from "../act-model";
import { useApprovals } from "../approvals-context";
import { replyCodexThread } from "../delegation-actions";
import { fetchCodexLive } from "../api";
import { codexClient } from "../clients";
import { codexMenuKeys, codexPrimaryAction, type CodexMenuKey } from "../drawer-model";
import { IconClose, IconExpand, IconFocus } from "../icons";
import type { CodexSessionRecord, TranscriptEntry } from "../types";
import { shortFolder } from "../wsmatch";
import { Timeline } from "./SessionDrawer";
import { useDrawerWidth, DRAWER_WIDTH } from "../use-layout-size";
import { CardMenu, useCardMenu, type CardMenuItem } from "./CardMenu";
import { ResizableDrawerEdge } from "./ResizableDrawerEdge";
import { RunChip } from "./RunChips";
import { Toggletip } from "./Toggletip";
import { ClampScope } from "./ShowMore";
import { ApprovalList } from "./ApprovalRequest";

interface Props {
  thread: CodexSessionRecord;
  workspace: string | null;
  delegatedEnabled: boolean;
  codexAppRunning: boolean;
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  onFocusApp: () => void;
  onOpenSession?: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
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

type ReplyState = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "blocked"; block: ReplyBlock };

function CodexReply({ threadId, onOpenSession }: { threadId: string; onOpenSession?: (id: string) => void }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<ReplyState>({ kind: "idle" });

  useEffect(() => {
    setText("");
    setState({ kind: "idle" });
  }, [threadId]);

  const send = async () => {
    const body = text.trim();
    if (body.length === 0 || state.kind === "sending") return;
    setState({ kind: "sending" });
    try {
      const result = await replyCodexThread(threadId, body);
      if (result.ok) {
        setText("");
        setState({ kind: "sent" });
      } else {
        setState({ kind: "blocked", block: replyBlock(result.code, result.message) });
      }
    } catch (err) {
      setState({ kind: "blocked", block: replyBlock(null, err instanceof Error ? err.message : "") });
    }
  };

  return (
    <div className="reply">
      <label className="reply__label" htmlFor={`reply-${threadId}`}>
        Reply to this run
      </label>
      <textarea
        id={`reply-${threadId}`}
        className="in reply__box"
        value={text}
        disabled={state.kind === "sending"}
        placeholder="Send a follow-up to the Codex run the hub started"
        onChange={(event) => {
          setText(event.target.value);
          if (state.kind !== "sending") setState({ kind: "idle" });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="reply__row">
        {state.kind === "sent" && <span className="reply__note">Sent. The run continues in the hub.</span>}
        {state.kind === "blocked" && <span className="reply__note reply__note--blocked">{state.block.text}</span>}
        {state.kind === "blocked" && state.block.offerOpen && onOpenSession && (
          <button type="button" className="act" onClick={() => onOpenSession(threadId)}>
            Open session
          </button>
        )}
        <button type="button" className="act act--focus" disabled={text.trim().length === 0 || state.kind === "sending"} onClick={() => void send()}>
          {state.kind === "sending" ? "Sending..." : "Send reply"}
        </button>
      </div>
    </div>
  );
}

export function CodexDrawer({ thread, workspace, delegatedEnabled, codexAppRunning, onClose, onOpenTask, onFocusApp, onOpenSession, onArchive, onUnarchive }: Props) {
  const [tab, setTab] = useState<Tab>("activity");
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menu = useCardMenu();

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
    const live = thread.status !== "ended";
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
  const drawerWidth = useDrawerWidth("codex", full, true);
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

  const name = thread.customTitle ?? thread.title;
  const clientInfo = codexClient(thread.client);
  const primary = codexPrimaryAction({ status: thread.status, appRunning: codexAppRunning });
  const hubTaskId = thread.hubTaskId;
  const approvals = useApprovals().forSession("codex", thread.id);
  const canOpen = !!onOpenSession && canOpenCodex({ status: thread.status, archivedAt: thread.archivedAt });
  const menuAction: Record<CodexMenuKey, CardMenuItem> = {
    open: { key: "open", label: "Open session", onSelect: () => onOpenSession?.(thread.id) },
    task: { key: "task", label: "Open in Delegated", onSelect: () => hubTaskId && onOpenTask(hubTaskId) },
    large: { key: "large", label: full ? "Back to the side panel" : "Open in a large view", onSelect: () => setFull((value) => !value) },
    archive: { key: "archive", label: "Archive", onSelect: () => onArchive(thread.id) },
    unarchive: { key: "unarchive", label: "Unarchive", onSelect: () => onUnarchive(thread.id) },
  };
  const menuItems = codexMenuKeys({ hubTask: hubTaskId !== null, delegatedOn: delegatedEnabled, archived: thread.archivedAt != null, canOpen }).map((key) => menuAction[key]);
  const live = thread.status !== "ended";
  const canReply = canReplyToCodex(thread);

  return (
    <>
      {full && <div className="drawer__backdrop" onClick={() => setFull(false)} />}
      <aside ref={panelRef} className={`drawer ${full ? "drawer--full" : ""}`} style={drawerWidth.style} role="dialog" aria-label={name}>
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
              <span className={`tag tag--${thread.status}`}>{thread.status}</span>
              <RunChip info={clientInfo} label={workspace ?? shortFolder(thread.cwd)} title={`${clientInfo.label} · ${shortFolder(thread.cwd)}`} />
              {thread.archivedAt != null && <span className="tag tag--muted">archived</span>}
            </div>
          </div>
          <div className="drawer__actions">
            {primary === "focus-app" && (
              <button className="act act--focus" onClick={onFocusApp} title="Bring the Codex app to the front (it has no per-thread target)">
                <IconFocus /> Focus app
              </button>
            )}
            <CardMenu menu={menu} items={menuItems} label={`Actions for ${name}`} />
            <button className="act act--icon" onClick={onClose} aria-label="Close">
              <IconClose />
            </button>
          </div>
        </header>

        {approvals.length > 0 && (
          <div className="drawer__approvals">
            <ApprovalList requests={approvals} />
          </div>
        )}

        <div className="drawer__tabs" role="tablist">
          <button role="tab" aria-selected={tab === "activity"} className={`pill ${tab === "activity" ? "pill--on" : ""}`} onClick={() => setTab("activity")}>
            Activity
          </button>
          <button role="tab" aria-selected={tab === "details"} className={`pill ${tab === "details" ? "pill--on" : ""}`} onClick={() => setTab("details")}>
            Details
          </button>
        </div>

        <div className="drawer__body">
          <ClampScope resetKey={thread.id}>
            {error && <p className="error">{error}</p>}
            {tab === "activity" && (
              <>
                <div className="timeline__bar">
                  <Toggletip label="About this activity">Read from the Codex rollout. {live ? "Refreshes every 5 seconds." : "This thread has ended."}</Toggletip>
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
                  resetKey={`codex:${thread.id}`}
                />
                {canReply && <CodexReply threadId={thread.id} onOpenSession={onOpenSession} />}
              </>
            )}
            {tab === "details" && (
              <dl className="details">
                <dt>Thread id</dt>
                <dd>
                  <code>{thread.id}</code>
                </dd>
                <dt>Client</dt>
                <dd>{clientInfo.label}</dd>
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
                {hubTaskId && (
                  <>
                    <dt>Hub task</dt>
                    <dd>
                      {delegatedEnabled ? (
                        <button className="linklike" onClick={() => onOpenTask(hubTaskId)} title="Open in Delegated">
                          <code>{hubTaskId}</code>
                        </button>
                      ) : (
                        <code>{hubTaskId}</code>
                      )}
                    </dd>
                  </>
                )}
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
            ariaLabel="Resize Codex panel"
          />
        )}
      </aside>
    </>
  );
}
