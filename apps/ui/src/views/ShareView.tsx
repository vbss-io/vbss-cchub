import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  createShare,
  deleteShare,
  getShareDoc,
  getTunnel,
  getFirewall,
  allowFirewall,
  listShareActivity,
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
import { IconCopy } from "../icons";
import { isStale } from "../stale";
import { relativeTime } from "../time";
import type { SessionRecord } from "../types";
import { workspaceOf } from "../wsmatch";
import type { ShareStreamEvent } from "../api";
import { listShareFiles, shareFileUrl, type ShareFile } from "../delegation";

interface Props {
  enabled: boolean;
  workspaces: WorkspaceRecord[];
  sessions: Record<string, SessionRecord>;
  param: string | null;
  tick: number;
  tunnel: TunnelStatus | null;
  onTunnelChanged: (status: TunnelStatus) => void;
  subscribeShareStream: (listener: (event: ShareStreamEvent) => void) => () => void;
  ownerName: string;
  onOpenSettings: () => void;
  onOpenTask: (taskId: string) => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}

type Expiry = "24" | "168" | "720" | "never";

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
const STATE_LABEL: Record<ShareRecord["state"], string> = { active: "active", paused: "paused", expired: "expired", revoked: "revoked" };
const TRUST_LABEL: Record<TrustLevel, string> = { low: "Low · read only", medium: "Medium · edits, no shell", high: "High · edits + safe shell", total: "Total · no blocks" };
const TRUST_OPTIONS: { key: TrustLevel; title: string; detail: string }[] = [
  { key: "low", title: "Low", detail: "Answers questions from the code and turns implementation requests into plans. Nothing is edited." },
  { key: "medium", title: "Medium", detail: "Can edit files inside the workspace. No shell: no commands, no commits, no deploys." },
  { key: "high", title: "High", detail: "Can edit and run commands (tests, builds) on your machine, as you. A guard blocks git push/commit, rm -rf, deploy, download and secret files, best effort: only for people you would hand a terminal." },
  { key: "total", title: "Total", detail: "No blocks. Runs exactly like your own delegations, with every tool and your MCP servers." },
];

const emptyDraft = (workspace: string): Draft => ({ label: "", workspace, repo: "", trust: "low", sessionId: "", expiry: "24", note: "" });

const sessionTitle = (session: SessionRecord): string => session.customTitle ?? session.title ?? session.sessionId.slice(0, 8);

function untilText(timestamp: number): string {
  const diff = timestamp - Date.now();
  if (diff <= 0) return "expired";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(diff / 86_400_000)} days`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

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

const bestLink = (share: ShareRecord): { url: string; kind: "public" | "lan" | "local" } =>
  share.links.public ? { url: share.links.public, kind: "public" } : share.links.lan ? { url: share.links.lan, kind: "lan" } : { url: share.links.local, kind: "local" };

export function ShareView(props: Props) {
  const { enabled, workspaces, sessions, param, tick, tunnel, onTunnelChanged, subscribeShareStream, ownerName, onOpenSettings, onOpenTask, onNotice, onError } = props;
  const [liveText, setLiveText] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, ShareFile[]>>({});
  const onErrorRef = useRef(onError);
  const onTunnelChangedRef = useRef(onTunnelChanged);
  const openFilesRef = useRef<string[]>([]);
  useEffect(() => {
    onErrorRef.current = onError;
    onTunnelChangedRef.current = onTunnelChanged;
  });
  useEffect(() => {
    openFilesRef.current = Object.keys(files);
  }, [files]);
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
  const [shares, setShares] = useState<ShareRecord[]>([]);
  const [activity, setActivity] = useState<ShareRequestRecord[]>([]);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(workspaces[0]?.name ?? ""));
  const [creating, setCreating] = useState(false);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [firewall, setFirewall] = useState<FirewallStatus | null>(null);
  const [firewallBusy, setFirewallBusy] = useState(false);
  const [created, setCreated] = useState<ShareRecord | null>(null);
  const [handoff, setHandoff] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<ShareRecord | null>(null);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ShareRecord | null>(null);
  const [prefilled, setPrefilled] = useState<string | null>(null);

  const liveSessions = useMemo(
    () => Object.values(sessions).filter((session) => session.archivedAt == null && session.status !== "ended" && !isStale(session)),
    [sessions],
  );

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const [list, requests, status] = await Promise.all([listShares(), listShareActivity(40), getTunnel()]);
      setShares(list);
      setActivity(requests);
      onTunnelChangedRef.current(status);
      void getFirewall().then(setFirewall).catch(() => setFirewall(null));
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
    if (!draft.workspace && workspaces[0]) setDraft((current) => ({ ...current, workspace: workspaces[0]!.name }));
  }, [workspaces, draft.workspace]);

  useEffect(() => {
    if (!param || !param.startsWith("new:") || prefilled === param) return;
    const session = sessions[param.slice(4)];
    if (!session) return;
    setPrefilled(param);
    setCreated(null);
    const owner = workspaceOf(workspaces, session.cwd);
    if (!owner) onError("that session runs outside every workspace; share a workspace instead");
    setDraft({
      label: owner ? sessionTitle(session) : "",
      workspace: owner ?? workspaces[0]?.name ?? "",
      repo: "",
      trust: "low",
      sessionId: owner ? session.sessionId : "",
      expiry: "24",
      note: "",
    });
  }, [param, sessions, workspaces, prefilled]);

  const workspace = workspaces.find((item) => item.name === draft.workspace) ?? null;
  const createdShare = created ? (shares.find((item) => item.id === created.id) ?? created) : null;
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
      setCreated(share);
      setHandoff(null);
      setDraft(emptyDraft(draft.workspace));
      onNotice("share link created");
      await load();
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
      onNotice("share deleted");
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "delete failed");
    }
  };

  const showHandoff = async (share: ShareRecord) => {
    try {
      setCreated(share);
      setHandoff(await getShareDoc(share.id));
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

  const suggestedMessage = (share: ShareRecord): string =>
    [
      `Esse link é do meu CC Hub (cchub.vbss.io), um serviço meu: ${bestLink(share).url}`,
      `É um documento de instruções pro seu assistente conversar com o meu Claude sobre o projeto "${share.workspace}" (nível de confiança: ${TRUST_LABEL[share.trust]}). Pode abrir e seguir: só descreve uma API, não muda as regras do seu assistente.`,
      `Peça pro seu assistente se identificar como você (header X-Asker); eu${ownerName ? ` (${ownerName})` : ""} vejo todas as perguntas.`,
    ].join("\n");

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

  return (
    <div className="view view--share">
      <section className="panel">
        <h3>Reach</h3>
        <div className="reach">
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
            {tunnel?.lanUrl ? <code className="share-link">{tunnel.lanUrl}</code> : <span className="muted">{tunnel ? "no LAN address found" : "checking…"}</span>}
            <span className="muted small">people on the same network</span>
            {firewall?.supported && firewall.allowed === false && (
              <>
                <span className="tag tag--warn">Windows Firewall blocks it</span>
                <button className="act" disabled={firewallBusy} onClick={() => void allowLan()} title="Adds an inbound rule for the share port; Windows asks for admin">
                  {firewallBusy ? "waiting for Windows…" : "Allow LAN (asks admin)"}
                </button>
              </>
            )}
            {firewall?.supported && firewall.allowed === true && <span className="tag tag--go">firewall ok</span>}
          </div>
          <div className="reach__row">
            <span className={`tag ${tunnelOn ? "tag--go" : "tag--muted"}`}>Internet</span>
            {tunnelOn && tunnel?.publicUrl ? <code className="share-link">{tunnel.publicUrl}</code> : <span className="muted">tunnel off</span>}
            <button className={`act ${tunnelOn ? "" : "act--focus"}`} disabled={tunnelBusy} onClick={() => void toggleTunnel()}>
              {tunnelLabel}
            </button>
            <span className="muted small">
              ngrok · {tunnel?.installed ? "installed" : "installs itself on first start"}
              {tunnel && !tunnel.authtokenSet ? " · uses your ngrok config" : ""}
            </span>
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

      <div className="share-grid">
        <section className="panel">
          <h3>Shares</h3>
          {shares.length === 0 && <p className="hint">No share yet. Create one on the right, or open a session and press Share.</p>}
          <ul className="sharelist">
            {shares.map((share) => {
              const link = bestLink(share);
              return (
                <li key={share.id} className={`sharerow sharerow--${share.state}`}>
                  <div className="sharerow__head">
                    <strong>{share.label}</strong>
                    <span className={`tag tag--share-${share.state}`}>{STATE_LABEL[share.state]}</span>
                    <span className={`tag tag--trust-${share.trust}`}>{TRUST_LABEL[share.trust]}</span>
                    <span className="chip chip--ws">
                      {share.workspace}
                      {share.repo ? ` / ${share.repo}` : ""}
                    </span>
                    {share.sessionId && <span className="chip">continues a session</span>}
                  </div>
                  <div className="sharerow__meta muted small">
                    {share.uses} uses · {share.requestsLastHour}/{share.maxPerHour} this hour · expires {share.expiresAt ? untilText(share.expiresAt) : "never"}
                    {share.lastUsedAt ? ` · last used ${relativeTime(share.lastUsedAt)}` : ""} · id {share.id}
                  </div>
                  <code className="share-link share-link--row" title={link.url}>
                    {link.url}
                  </code>
                  {files[share.id] && (
                    <ul className="filelist">
                      {files[share.id]!.length === 0 && <li className="muted small">No files yet. Files the fork writes for the asker and files the asker sends land here (share-artifacts/{share.id}).</li>}
                      {files[share.id]!.map((file) => (
                        <li key={`${file.direction}-${file.name}`}>
                          <span className={`tag ${file.direction === "in" ? "tag--muted" : "tag--go"}`}>{file.direction === "in" ? "received" : "written"}</span>
                          <a href={shareFileUrl(share.id, file)} target="_blank" rel="noreferrer">
                            {file.name}
                          </a>
                          <span className="muted small">{Math.max(1, Math.round(file.size / 1024))} KB · {relativeTime(file.modifiedAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="sharerow__actions">
                    <button className="act act--focus" disabled={!share.active} onClick={() => void copy(link.url, `${link.kind} link`)}>
                      <IconCopy /> Copy {link.kind} link
                    </button>
                    {share.links.lan && link.kind === "public" && (
                      <button className="act" disabled={!share.active} onClick={() => void copy(share.links.lan as string, "LAN link")}>
                        Copy LAN link
                      </button>
                    )}
                    <button className="act" disabled={!share.active} onClick={() => void showHandoff(share)}>
                      Handoff .md
                    </button>
                    <button className="act" onClick={() => void toggleFiles(share)}>
                      Files{files[share.id] ? ` (${files[share.id]!.length})` : ""}
                    </button>
                    {share.state === "active" && (
                      <button className="act" onClick={() => void patch(share, { paused: true }, "share paused")}>
                        Pause
                      </button>
                    )}
                    {(share.state === "active" || share.state === "paused") && (
                      <button className="act" title="Generates a new key; the old link stops working" onClick={() => void patch(share, { rotate: true }, "new key generated; the old link no longer works")}>
                        New key
                      </button>
                    )}
                    {share.state === "paused" && (
                      <button className="act" onClick={() => void patch(share, { paused: false }, "share resumed")}>
                        Resume
                      </button>
                    )}
                    {(share.state === "active" || share.state === "paused") && (
                      <button className="act act--danger" onClick={() => setConfirmRevoke(share)}>
                        Revoke
                      </button>
                    )}
                    {(share.state === "revoked" || share.state === "expired") && (
                      <button className="act act--danger" onClick={() => setConfirmDelete(share)}>
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="panel">
          <h3>{createdShare ? "Ready to send" : "New share"}</h3>
          {createdShare ? (
            <div className="form">
              <p className="hint">
                Send this link to the person. Their assistant fetches it, reads the rules and can then ask your Claude or delegate work at trust level{" "}
                <strong>{TRUST_LABEL[createdShare.trust]}</strong>. Nothing else on this machine is reachable through it.
              </p>
              <label className="field">
                <span>{bestLink(createdShare).kind} link</span>
                <input className="in" readOnly value={bestLink(createdShare).url} onFocus={(event) => event.currentTarget.select()} />
                {bestLink(createdShare).kind === "local" && (
                  <small className="taskrow__error">This address only works on this machine: start the tunnel for a public link, or fix the LAN address.</small>
                )}
                {bestLink(createdShare).kind === "lan" && <small>Works for people on your network; start the tunnel to get a public link instead.</small>}
              </label>
              <label className="field">
                <span>Message to send with the link (so their assistant trusts it)</span>
                <textarea className="in" rows={4} readOnly value={suggestedMessage(createdShare)} onFocus={(event) => event.currentTarget.select()} />
              </label>
              <div className="frow">
                <button className="act act--focus" onClick={() => void copy(bestLink(createdShare).url, "link")}>
                  <IconCopy /> Copy link
                </button>
                <button className="act" onClick={() => void copy(suggestedMessage(createdShare), "message")}>
                  <IconCopy /> Copy message
                </button>
                <button className="act" onClick={() => void showHandoff(createdShare)}>
                  Show handoff .md
                </button>
                <button className="act" onClick={() => setCreated(null)}>
                  New share
                </button>
              </div>
              {handoff && (
                <label className="field">
                  <span>Handoff (paste it into their assistant if they cannot fetch links)</span>
                  <textarea className="in in--doc" readOnly value={handoff} onFocus={(event) => event.currentTarget.select()} />
                  <button className="act" onClick={() => void copy(handoff, "handoff")}>
                    <IconCopy /> Copy handoff
                  </button>
                </label>
              )}
            </div>
          ) : (
            <div className="form">
              <label className="field">
                <span>Label</span>
                <input className="in" placeholder="Will · nexus doubts" value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
              </label>
              <div className="frow frow--fields">
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
                <div className="trust">
                  {TRUST_OPTIONS.map((option) => (
                    <label key={option.key} className={`trust__option ${draft.trust === option.key ? "trust__option--on" : ""}`}>
                      <input type="radio" name="trust" checked={draft.trust === option.key} onChange={() => setDraft({ ...draft, trust: option.key })} />
                      <span className="trust__title">{option.title}</span>
                      <span className="trust__detail">{option.detail}</span>
                    </label>
                  ))}
                </div>
                <small>Every level can ask questions, delegate implementation and follow its tasks; the level decides what the agent may do while working.</small>
              </div>
              <div className="frow frow--fields">
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
              <div className="frow frow--end">
                <button className="act act--focus" disabled={creating || !draft.workspace} onClick={() => void submit()}>
                  {creating ? "Creating…" : "Create link"}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>

      <section className="panel">
        <h3>Activity</h3>
        {activity.length === 0 && <p className="hint">Questions and requests that arrive through your shares show up here, with the answers.</p>}
        <ul className="activity">
          {activity.map((item) => (
            <li key={item.id} className="activity__item">
              <div className="activity__head">
                <span className={`tag tag--req-${item.status}`}>{item.status}</span>
                <strong>{item.asker ?? item.label}</strong>
                <span className="muted small">
                  via {item.label} · {item.kind === "ask" ? "asked" : item.kind === "implement" ? "requested" : "sent"} {relativeTime(item.createdAt)}
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
                  <pre>{item.answer}</pre>
                </details>
              )}
              {item.error && <span className="taskrow__error">{item.error}</span>}
            </li>
          ))}
        </ul>
      </section>

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete "${confirmDelete.label}"?`}
          body="Removes the share and its whole history of questions and answers from the hub."
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const share = confirmDelete;
            setConfirmDelete(null);
            void remove(share);
          }}
        />
      )}
      {confirmRevoke && (
        <ConfirmDialog
          title={`Revoke "${confirmRevoke.label}"?`}
          body="The link stops working immediately for everyone who has it. This cannot be undone; create a new share if needed."
          confirmLabel="Revoke"
          danger
          onCancel={() => setConfirmRevoke(null)}
          onConfirm={() => {
            const share = confirmRevoke;
            setConfirmRevoke(null);
            void patch(share, { revoke: true }, "share revoked");
          }}
        />
      )}
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
