import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { bestLink, maskLink, ShareCard, untilText } from "../components/ShareCard";
import {
  createShare,
  deleteShare,
  getShareDoc,
  getTunnel,
  getFirewall,
  allowFirewall,
  listShareRequests,
  listShares,
  startTunnel,
  stopTunnel,
  updateShare,
  type ShareRecord,
  type ShareRequestRecord,
  type TrustLevel,
  type FirewallStatus,
  type TunnelStatus,
  type WorkspaceRecord,
} from "../delegation";
import { IconClose, IconCopy } from "../icons";
import { Markdown } from "../markdown";
import { isStale } from "../stale";
import { relativeTime } from "../time";
import type { SessionRecord } from "../types";
import { workspaceOf } from "../wsmatch";
import type { ShareStreamEvent } from "../api";
import { listShareFiles, type ShareFile } from "../delegation";

interface Props {
  enabled: boolean;
  workspaces: WorkspaceRecord[];
  sessions: Record<string, SessionRecord>;
  param: string | null;
  tick: number;
  tunnel: TunnelStatus | null;
  onTunnelChanged: (status: TunnelStatus) => void;
  subscribeShareStream: (listener: (event: ShareStreamEvent) => void) => () => void;
  onOpenSettings: () => void;
  onOpenTask: (taskId: string) => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
  panelHost: HTMLElement | null;
}

type Expiry = "24" | "168" | "720" | "never";
type DetailTab = "activity" | "details" | "actions";
type ShareFilter = "active" | "paused" | "expired" | "all";

interface Draft {
  label: string;
  workspace: string;
  repo: string;
  trust: TrustLevel;
  sessionId: string;
  expiry: Expiry;
  note: string;
}

const EXPIRY_LABEL: Record<Expiry, string> = { "24": "24 hours", "168": "7 days", "720": "30 days", never: "never (until revoked)" };
const TRUST_LABEL: Record<TrustLevel, string> = { low: "Low · read only", medium: "Medium · edits, no shell", high: "High · edits + safe shell", total: "Total · no blocks" };
const TRUST_OPTIONS: { key: TrustLevel; title: string; detail: string; summary: string }[] = [
  {
    key: "low",
    title: "Low",
    detail: "Answers questions from the code and turns implementation requests into plans. Nothing is edited.",
    summary: "Answers and plans only — nothing on the machine is edited.",
  },
  {
    key: "medium",
    title: "Medium",
    detail: "Can edit files inside the workspace. No shell: no commands, no commits, no deploys.",
    summary: "Edits files inside the workspace — no shell, commits or deploys.",
  },
  {
    key: "high",
    title: "High",
    detail: "Can edit and run commands (tests, builds) on your machine, as you. A guard blocks git push/commit, rm -rf, deploy, download and secret files, best effort: only for people you would hand a terminal.",
    summary: "Edits and runs safe commands, with a guard on push/deploy/secrets.",
  },
  {
    key: "total",
    title: "Total",
    detail: "No blocks. Runs exactly like your own delegations, with every tool and your MCP servers.",
    summary: "No blocks — runs like your own delegations, every tool and MCP.",
  },
];
const TRUST_SUMMARY: Record<TrustLevel, string> = {
  low: TRUST_OPTIONS[0]!.summary,
  medium: TRUST_OPTIONS[1]!.summary,
  high: TRUST_OPTIONS[2]!.summary,
  total: TRUST_OPTIONS[3]!.summary,
};

const emptyDraft = (workspace: string): Draft => ({ label: "", workspace, repo: "", trust: "low", sessionId: "", expiry: "24", note: "" });

const sessionTitle = (session: SessionRecord): string => session.customTitle ?? session.title ?? session.sessionId.slice(0, 8);

const normalizePath = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const insideDir = (cwd: string, dir: string): boolean => {
  const base = normalizePath(dir);
  const target = normalizePath(cwd);
  return target === base || target.startsWith(`${base}/`);
};

const sessionInWorkspace = (session: SessionRecord, workspace: WorkspaceRecord | null): boolean => {
  if (!workspace || !session.cwd) return false;
  const dirs = [workspace.contextPath, ...workspace.repos.map((repo) => repo.path)].filter((dir): dir is string => !!dir);
  return dirs.some((dir) => insideDir(session.cwd as string, dir));
};

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function SharePanel({ ariaLabel, onClose, children }: { ariaLabel: string; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && panelRef.current && !panelRef.current.contains(target)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  return (
    <aside ref={panelRef} className="drawer" role="dialog" aria-label={ariaLabel}>
      {children}
    </aside>
  );
}

interface ActionsProps {
  share: ShareRecord;
  onPause: (share: ShareRecord) => void;
  onResume: (share: ShareRecord) => void;
  onNewKey: (share: ShareRecord) => void;
  onRevoke: (share: ShareRecord) => void;
  onDelete: (share: ShareRecord) => void;
}

function ShareActions({ share, onPause, onResume, onNewKey, onRevoke, onDelete }: ActionsProps) {
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setConfirmRevoke(false);
    setConfirmDelete(false);
  }, [share.id, share.state]);
  const revokable = share.state === "active" || share.state === "paused";
  const removable = share.state === "revoked" || share.state === "expired";

  return (
    <div className="shareactions">
      <p className="hint">Manage this link. Revoked or expired links can be deleted for good.</p>
      <div className="shareactions__row">
        {share.state === "active" && (
          <button className="act" onClick={() => onPause(share)}>
            Pause
          </button>
        )}
        {share.state === "paused" && (
          <button className="act" onClick={() => onResume(share)}>
            Resume
          </button>
        )}
        {revokable && (
          <button className="act" title="Generates a new key; the old link stops working" onClick={() => onNewKey(share)}>
            New key
          </button>
        )}
      </div>
      <div className="shareactions__row shareactions__row--danger">
        {revokable && !confirmRevoke && (
          <button className="act act--danger" onClick={() => setConfirmRevoke(true)}>
            Revoke
          </button>
        )}
        {revokable && confirmRevoke && (
          <>
            <span className="muted small">Stops the link right away. It cannot be undone.</span>
            <button className="act act--ghost" onClick={() => setConfirmRevoke(false)}>
              Cancel
            </button>
            <button className="act act--danger" onClick={() => { setConfirmRevoke(false); onRevoke(share); }}>
              Confirm revoke
            </button>
          </>
        )}
        {removable && !confirmDelete && (
          <button className="act act--danger" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
        {removable && confirmDelete && (
          <>
            <span className="muted small">Removes the record and its files for good.</span>
            <button className="act act--ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button className="act act--danger" onClick={() => { setConfirmDelete(false); onDelete(share); }}>
              Confirm delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function ShareView(props: Props) {
  const { enabled, workspaces, sessions, param, tick, tunnel, onTunnelChanged, subscribeShareStream, onOpenSettings, onOpenTask, onNotice, onError, panelHost } = props;
  const [shares, setShares] = useState<ShareRecord[]>([]);
  const [files, setFiles] = useState<Record<string, ShareFile[]>>({});
  const [liveText, setLiveText] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(workspaces[0]?.name ?? ""));
  const [creating, setCreating] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [firewall, setFirewall] = useState<FirewallStatus | null>(null);
  const [firewallBusy, setFirewallBusy] = useState(false);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [filter, setFilter] = useState<ShareFilter>("active");
  const [query, setQuery] = useState("");
  const [detailTab, setDetailTab] = useState<DetailTab>("activity");
  const [detailRequests, setDetailRequests] = useState<ShareRequestRecord[]>([]);
  const [handoff, setHandoff] = useState<{ id: string; text: string } | null>(null);

  const onErrorRef = useRef(onError);
  const onTunnelChangedRef = useRef(onTunnelChanged);
  const openFilesRef = useRef<string[]>([]);
  const initedFormRef = useRef<string | null>(null);
  useEffect(() => {
    onErrorRef.current = onError;
    onTunnelChangedRef.current = onTunnelChanged;
  });
  useEffect(() => {
    openFilesRef.current = Object.keys(files);
  }, [files]);

  const formOpen = param === "new" || (param?.startsWith("new:") ?? false);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const [list, status] = await Promise.all([listShares(), getTunnel()]);
      setShares(list);
      onTunnelChangedRef.current(status);
      for (const id of openFilesRef.current) {
        void listShareFiles(id)
          .then((items) => setFiles((current) => (current[id] ? { ...current, [id]: items } : current)))
          .catch(() => undefined);
      }
    } catch (err) {
      onErrorRef.current(err instanceof Error ? err.message : "could not load shares");
    }
  }, [enabled]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  useEffect(() => {
    if (!enabled) return;
    void getFirewall()
      .then(setFirewall)
      .catch(() => setFirewall({ supported: false, allowed: null, ruleName: "", port: 0, error: "firewall check failed" }));
  }, [enabled]);

  useEffect(
    () =>
      subscribeShareStream((event) => {
        if (event.kind === "text") setLiveText((current) => ({ ...current, [event.requestId]: `${current[event.requestId] ?? ""}${event.text}`.slice(-4000) }));
        if (event.kind === "status" && (event.text === "finished" || event.text.startsWith("error"))) {
          setLiveText((current) => {
            const next = { ...current };
            delete next[event.requestId];
            return next;
          });
          void load();
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subscribeShareStream],
  );

  useEffect(() => {
    if (!draft.workspace && workspaces[0]) setDraft((current) => ({ ...current, workspace: workspaces[0]!.name }));
  }, [workspaces, draft.workspace]);

  useEffect(() => {
    if (!formOpen || !param) {
      initedFormRef.current = null;
      return;
    }
    if (initedFormRef.current === param) return;
    if (param === "new") {
      initedFormRef.current = param;
      setDraft(emptyDraft(workspaces[0]?.name ?? ""));
      return;
    }
    const session = sessions[param.slice(4)];
    if (!session || workspaces.length === 0) return;
    initedFormRef.current = param;
    const owner = workspaceOf(workspaces, session.cwd);
    if (!owner) onError("that session runs outside every workspace; share a workspace instead");
    setDraft({
      label: session && owner ? sessionTitle(session) : "",
      workspace: owner ?? workspaces[0]?.name ?? "",
      repo: "",
      trust: "low",
      sessionId: session && owner ? session.sessionId : "",
      expiry: "24",
      note: "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formOpen, param, workspaces, sessions]);

  const selected = !formOpen && param ? (shares.find((item) => item.id === param) ?? null) : null;
  useEffect(() => {
    if (!selected) {
      setDetailRequests([]);
      return;
    }
    let mounted = true;
    void listShareRequests(selected.id)
      .then((items) => mounted && setDetailRequests(items))
      .catch(() => mounted && setDetailRequests([]));
    return () => {
      mounted = false;
    };
  }, [selected?.id, tick]);

  const openForm = () => {
    location.hash = "#/share/new";
  };
  const closePanel = () => {
    location.hash = "#/share";
  };
  const openShare = (id: string) => {
    location.hash = `#/share/${id}`;
  };

  const workspace = workspaces.find((item) => item.name === draft.workspace) ?? null;
  const liveSessions = Object.values(sessions).filter((session) => session.archivedAt == null && session.status !== "ended" && !isStale(session));
  const pinnedSession = draft.sessionId ? sessions[draft.sessionId] : undefined;
  const workspaceSessions = liveSessions.filter((session) => sessionInWorkspace(session, workspace));
  const sessionOptions =
    pinnedSession && !workspaceSessions.some((session) => session.sessionId === pinnedSession.sessionId) ? [pinnedSession, ...workspaceSessions] : workspaceSessions;

  const copy = async (text: string, what: string) => {
    if (await copyText(text)) onNotice(`${what} copied`);
    else setManualCopy(text);
  };

  const submit = async () => {
    if (!draft.workspace) {
      onError("pick a workspace");
      return;
    }
    setCreating(true);
    try {
      const share = await createShare({
        label: draft.label.trim() || `${draft.workspace} · ${new Date().toLocaleDateString()}`,
        workspace: draft.workspace,
        repo: draft.repo || null,
        trust: draft.trust,
        sessionId: draft.sessionId || null,
        note: draft.note.trim() || null,
        expiresInHours: draft.expiry === "never" ? null : Number(draft.expiry),
      });
      setDetailTab("details");
      onNotice("share link created");
      await load();
      openShare(share.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : "could not create the share");
    } finally {
      setCreating(false);
    }
  };

  const toggleTunnel = async () => {
    setTunnelBusy(true);
    try {
      const status = tunnel?.state === "running" || tunnel?.state === "starting" ? await stopTunnel() : await startTunnel();
      onTunnelChanged(status);
      if (status.state === "error") onError(status.error ?? "tunnel failed");
      else if (status.state === "running") onNotice(`tunnel on: ${status.publicUrl}`);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "tunnel failed");
    } finally {
      setTunnelBusy(false);
    }
  };

  const patch = async (share: ShareRecord, body: Parameters<typeof updateShare>[1], done: string) => {
    try {
      await updateShare(share.id, body);
      onNotice(done);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "update failed");
    }
  };

  const remove = async (share: ShareRecord) => {
    try {
      await deleteShare(share.id);
      if (param === share.id) closePanel();
      onNotice("share deleted");
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "delete failed");
    }
  };

  const toggleFiles = async (share: ShareRecord) => {
    if (files[share.id]) {
      setFiles((current) => {
        const next = { ...current };
        delete next[share.id];
        return next;
      });
      return;
    }
    try {
      setFiles((current) => ({ ...current, [share.id]: [] }));
      const list = await listShareFiles(share.id);
      setFiles((current) => ({ ...current, [share.id]: list }));
    } catch (err) {
      onError(err instanceof Error ? err.message : "could not list files");
    }
  };

  const showHandoff = async (share: ShareRecord) => {
    try {
      setDetailTab("details");
      openShare(share.id);
      setHandoff({ id: share.id, text: await getShareDoc(share.id) });
    } catch (err) {
      onError(err instanceof Error ? err.message : "handoff unavailable");
    }
  };

  const allowLan = async () => {
    setFirewallBusy(true);
    try {
      const status = await allowFirewall();
      setFirewall(status);
      if (status.allowed) onNotice("Windows Firewall now allows LAN access to the share port");
      else onError(status.error ?? "the firewall rule was not created");
    } catch (err) {
      onError(err instanceof Error ? err.message : "firewall change failed");
    } finally {
      setFirewallBusy(false);
    }
  };

  const tunnelOn = tunnel?.state === "running";
  const tunnelLabel =
    tunnel?.state === "installing" ? "installing ngrok…" : tunnel?.state === "starting" ? "starting…" : tunnelOn ? "Stop tunnel" : "Start tunnel";

  if (!enabled) {
    return (
      <div className="view view--share">
        <section className="panel">
          <p className="hint">Sharing needs the hub surface. Start the hub with delegation enabled.</p>
        </section>
      </div>
    );
  }

  const counts: Record<ShareFilter, number> = {
    active: shares.filter((share) => share.state === "active").length,
    paused: shares.filter((share) => share.state === "paused").length,
    expired: shares.filter((share) => share.state === "expired").length,
    all: shares.length,
  };
  const filters: { key: ShareFilter; label: string }[] = [
    { key: "active", label: "Active" },
    { key: "paused", label: "Paused" },
    { key: "expired", label: "Expired" },
    { key: "all", label: "All" },
  ];
  const needle = query.trim().toLowerCase();
  const filtered = shares.filter((share) => {
    if (needle && !`${share.label} ${share.workspace} ${share.repo ?? ""}`.toLowerCase().includes(needle)) return false;
    if (filter === "all") return true;
    return share.state === filter;
  });

  const selectedLink = selected ? bestLink(selected) : null;
  const selectedSession = selected?.sessionId ? sessions[selected.sessionId] : undefined;

  const detailPanel = selected && (
    <SharePanel ariaLabel={selected.label} onClose={closePanel}>
      <header className="drawer__header">
        <div className="drawer__title">
          <h2 title={selected.label}>{selected.label}</h2>
          <div className="card__badges">
            <span className={`tag tag--share-${selected.state}`}>{selected.state}</span>
            <span className={`tag tag--trust-${selected.trust}`}>{TRUST_LABEL[selected.trust]}</span>
            <span className="chip chip--ws">
              {selected.workspace}
              {selected.repo ? ` / ${selected.repo}` : ""}
            </span>
          </div>
        </div>
        <div className="drawer__actions">
          <button className="act act--icon" onClick={closePanel} aria-label="Close">
            <IconClose />
          </button>
        </div>
      </header>

      <div className="drawer__tabs">
        <button className={`pill ${detailTab === "activity" ? "pill--on" : ""}`} onClick={() => setDetailTab("activity")}>
          Activity {detailRequests.length > 0 && <span className="pill__count">{detailRequests.length}</span>}
        </button>
        <button className={`pill ${detailTab === "details" ? "pill--on" : ""}`} onClick={() => setDetailTab("details")}>
          Details
        </button>
        <button className={`pill ${detailTab === "actions" ? "pill--on" : ""}`} onClick={() => setDetailTab("actions")}>
          Actions
        </button>
      </div>

      <div className="drawer__body">
        {detailTab === "activity" && (
          <>
            {detailRequests.length === 0 && <p className="hint">Questions and requests that arrive through this share show up here, with the answers.</p>}
            <ul className="activity">
              {detailRequests.map((item) => (
                <li key={item.id} className="activity__item">
                  <div className="activity__head">
                    <span className={`tag tag--req-${item.status}`}>{item.status}</span>
                    <strong>{item.asker ?? item.label}</strong>
                    <span className="muted small">
                      {item.kind === "ask" ? "asked" : item.kind === "implement" ? "requested" : "sent"} {relativeTime(item.createdAt)}
                      {item.remote ? ` · from ${item.remote}` : ""}
                      {item.forkSessionId ? ` · fork ${item.forkSessionId.slice(0, 8)}` : ""}
                    </span>
                    {item.taskId && (
                      <button className="linklike" onClick={() => onOpenTask(item.taskId as string)}>
                        open task
                      </button>
                    )}
                  </div>
                  <p className="activity__prompt">{item.prompt}</p>
                  {item.status === "running" && liveText[item.id] && <pre className="activity__live">{liveText[item.id]}</pre>}
                  {item.answer && (
                    <details className="activity__answer">
                      <summary>answer</summary>
                      <div className="activity__answer-body">
                        <Markdown text={item.answer} />
                      </div>
                    </details>
                  )}
                  {item.error && <span className="taskrow__error">{item.error}</span>}
                </li>
              ))}
            </ul>
          </>
        )}

        {detailTab === "details" && selectedLink && (
          <dl className="details">
            <dt>Link</dt>
            <dd>
              <div className="frow">
                <code className="share-link">{maskLink(selectedLink.url)}</code>
                <button className="act" disabled={!selected.active} onClick={() => void copy(selectedLink.url, `${selectedLink.kind} link`)}>
                  <IconCopy /> Copy
                </button>
              </div>
            </dd>
            <dt>Trust</dt>
            <dd>{TRUST_LABEL[selected.trust]}</dd>
            <dt>Workspace</dt>
            <dd>
              {selected.workspace}
              {selected.repo ? ` / ${selected.repo}` : ""}
            </dd>
            <dt>Expiry</dt>
            <dd>{selected.expiresAt ? untilText(selected.expiresAt) : "never (until revoked)"}</dd>
            <dt>Answered from</dt>
            <dd>{selected.sessionId ? (selectedSession ? sessionTitle(selectedSession) : selected.sessionId.slice(0, 8)) : "fresh context of the workspace"}</dd>
            <dt>Note</dt>
            <dd>{selected.note ?? "—"}</dd>
            <dt>Files</dt>
            <dd>
              <button className="act" onClick={() => void toggleFiles(selected)}>
                {files[selected.id] ? "Hide files" : "Show files"}
                {files[selected.id] ? ` (${files[selected.id]!.length})` : ""}
              </button>
            </dd>
            <dt>Handoff</dt>
            <dd>
              <button className="act" disabled={!selected.active} onClick={() => void showHandoff(selected)}>
                Load handoff .md
              </button>
              {handoff && handoff.id === selected.id && (
                <div className="frow frow--stack">
                  <textarea className="in in--doc" readOnly value={handoff.text} onFocus={(event) => event.currentTarget.select()} />
                  <button className="act" onClick={() => void copy(handoff.text, "handoff")}>
                    <IconCopy /> Copy handoff
                  </button>
                </div>
              )}
            </dd>
          </dl>
        )}

        {detailTab === "actions" && (
          <ShareActions
            share={selected}
            onPause={(item) => void patch(item, { paused: true }, "share paused")}
            onResume={(item) => void patch(item, { paused: false }, "share resumed")}
            onNewKey={(item) => void patch(item, { rotate: true }, "new key generated; the old link no longer works")}
            onRevoke={(item) => void patch(item, { revoke: true }, "share revoked")}
            onDelete={(item) => void remove(item)}
          />
        )}
      </div>
    </SharePanel>
  );

  const formPanel = formOpen && (
    <SharePanel ariaLabel="New share" onClose={closePanel}>
      <header className="drawer__header">
        <div className="drawer__title">
          <h2>New share</h2>
        </div>
        <div className="drawer__actions">
          <button className="act act--icon" onClick={closePanel} aria-label="Close">
            <IconClose />
          </button>
        </div>
      </header>

      <div className="drawer__body">
        <label className="field">
          <span>Label</span>
          <input className="in" placeholder="Will · nexus doubts" value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
        </label>
        <div className="frow frow--fields frow--top">
          <label className="field">
            <span>Workspace</span>
            <select className="in" value={draft.workspace} onChange={(event) => setDraft({ ...draft, workspace: event.target.value, repo: "" })}>
              {workspaces.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Repository (optional)</span>
            <select className="in" value={draft.repo} onChange={(event) => setDraft({ ...draft, repo: event.target.value })}>
              <option value="">whole workspace</option>
              {(workspace?.repos ?? []).map((repo) => (
                <option key={repo.name} value={repo.name}>
                  {repo.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field">
          <span>Trust level</span>
          <div className="trustpills">
            {TRUST_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={`pill ${draft.trust === option.key ? "pill--on" : ""}`}
                title={option.detail}
                onClick={() => setDraft({ ...draft, trust: option.key })}
              >
                {option.title}
              </button>
            ))}
          </div>
          <small>{TRUST_SUMMARY[draft.trust]}</small>
        </div>
        <div className="frow frow--fields frow--top">
          <label className="field">
            <span>Answer from a session (optional)</span>
            <select className="in" value={draft.sessionId} onChange={(event) => setDraft({ ...draft, sessionId: event.target.value })}>
              <option value="">fresh context of the workspace</option>
              {sessionOptions.map((session) => (
                <option key={session.sessionId} value={session.sessionId}>
                  {sessionTitle(session)}
                </option>
              ))}
            </select>
            <small>Forks the session: the whole conversation history becomes readable by the asker. The original stays untouched.</small>
          </label>
          <label className="field">
            <span>Expires</span>
            <select className="in" value={draft.expiry} onChange={(event) => setDraft({ ...draft, expiry: event.target.value as Expiry })}>
              {(Object.keys(EXPIRY_LABEL) as Expiry[]).map((key) => (
                <option key={key} value={key}>
                  {EXPIRY_LABEL[key]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Note for their assistant (optional)</span>
          <textarea className="in" rows={2} placeholder="Context the asker should know, e.g. which feature this is about" value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
        </label>
      </div>

      <footer className="drawer__foot">
        <button className="act act--focus" disabled={creating || !draft.workspace} onClick={() => void submit()}>
          {creating ? "Creating…" : "Create link"}
        </button>
      </footer>
    </SharePanel>
  );

  const panel = formOpen ? formPanel : detailPanel;

  return (
    <div className="view view--share">
      <section className="panel">
        <div className="reach reach--compact">
          {tunnel?.endpointError && (
            <div className="reach__row">
              <span className="tag tag--share-revoked">share endpoint down</span>
              <span className="taskrow__error">
                port {tunnel.sharePort} could not be opened ({tunnel.endpointError}); close whatever uses it or change HUB_SHARE_PORT, then restart the hub
              </span>
            </div>
          )}
          <div className="reach__row">
            <span className={`tag ${tunnel?.lanUrl ? "tag--go" : "tag--muted"}`}>LAN</span>
            {tunnel?.lanUrl ? <code className="share-link">{tunnel.lanUrl}</code> : <span className="muted small">{tunnel ? "no LAN address" : "checking…"}</span>}
            {firewall === null && <span className="tag tag--muted">firewall…</span>}
            {firewall?.supported && firewall.allowed === false && (
              <button className="act" disabled={firewallBusy} onClick={() => void allowLan()} title="Adds an inbound rule for the share port; Windows asks for admin">
                {firewallBusy ? "waiting…" : "Allow LAN (admin)"}
              </button>
            )}
            {firewall?.supported && firewall.allowed === true && <span className="tag tag--go">firewall ok</span>}
            <span className="reach__sep" />
            <span className={`tag ${tunnelOn ? "tag--go" : "tag--muted"}`}>Internet</span>
            {tunnelOn && tunnel?.publicUrl ? <code className="share-link">{tunnel.publicUrl}</code> : <span className="muted small">tunnel off</span>}
            <button className={`act ${tunnelOn ? "" : "act--focus"}`} disabled={tunnelBusy} onClick={() => void toggleTunnel()}>
              {tunnelLabel}
            </button>
            {tunnel?.state === "error" && tunnel.error && <span className="taskrow__error">{tunnel.error}</span>}
          </div>
        </div>
        <p className="hint">
          Every share gets a LAN link; while the tunnel is on it also gets a public one. Links carry the key, so send them privately. ngrok
          authtoken and domain live in{" "}
          <button className="linklike" onClick={onOpenSettings}>
            Settings › Sharing
          </button>
          .
        </p>
      </section>

      <div className="sharetoolbar">
        <div className="filters filters--tight">
          {filters.map((item) => (
            <button key={item.key} className={`pill ${filter === item.key ? "pill--on" : ""}`} onClick={() => setFilter(item.key)}>
              {item.label}
              <span className="pill__count">{counts[item.key]}</span>
            </button>
          ))}
        </div>
        <input className="in sharetoolbar__search" placeholder="search label or workspace" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button className="act act--focus sharetoolbar__new" onClick={openForm}>
          New share
        </button>
      </div>

      {shares.length === 0 && <p className="hint">No share yet. Press New share, or open a session and press Share.</p>}
      <div className="grid sharegrid">
        {filtered.map((share) => (
          <ShareCard
            key={share.id}
            share={share}
            selected={param === share.id}
            files={files[share.id]}
            onSelect={openShare}
            onCopy={(url, what) => void copy(url, what)}
            onHandoff={(item) => void showHandoff(item)}
            onToggleFiles={(item) => void toggleFiles(item)}
            onPause={(item) => void patch(item, { paused: true }, "share paused")}
            onResume={(item) => void patch(item, { paused: false }, "share resumed")}
            onNewKey={(item) => void patch(item, { rotate: true }, "new key generated; the old link no longer works")}
            onRevoke={(item) => void patch(item, { revoke: true }, "share revoked")}
            onDelete={(item) => void remove(item)}
          />
        ))}
        {shares.length > 0 && filtered.length === 0 && <p className="empty">Nothing in this filter.</p>}
      </div>

      {panelHost && panel && createPortal(panel, panelHost)}

      {manualCopy && (
        <ConfirmDialog
          title="Copy manually"
          body={manualCopy}
          confirmLabel="Done"
          onCancel={() => setManualCopy(null)}
          onConfirm={() => setManualCopy(null)}
        />
      )}
    </div>
  );
}
