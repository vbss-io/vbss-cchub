import { useEffect, useRef, useState } from "react";
import { CardMenu, useCardMenu, type CardMenuItem } from "../components/CardMenu";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Toggletip } from "../components/Toggletip";
import { WorkspaceContext } from "../components/WorkspaceContext";
import { memorySettingsOf } from "../memory-model";
import { createWorkspace, deleteWorkspace, openWorkspace, updateWorkspace, type DelegationSettings, type WorkspaceRecord } from "../delegation";
import {
  contextLabel,
  decodeWorkspaceParam,
  filterWorkspaces,
  repoCountLabel,
  splitRepoLines,
  workspaceMenuEntries,
  type WorkspaceMenuKey,
} from "../workspaces-model";
import "../workspaces.css";

interface Props {
  workspaces: WorkspaceRecord[];
  settings: DelegationSettings | null;
  enabled: boolean;
  focusName?: string | null;
  onChanged: () => Promise<void>;
  onOpenSettings: () => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}

interface RowProps {
  workspace: WorkspaceRecord;
  focused: boolean;
  editing: boolean;
  contextOpen: boolean;
  contextOn: boolean;
  busy: boolean;
  editRepos: string;
  setRef: (node: HTMLLIElement | null) => void;
  onOpen: () => void;
  onToggleEdit: () => void;
  onToggleContext: () => void;
  onContextChanged: (enabled: boolean) => void;
  onDelete: () => void;
  onEditRepos: (value: string) => void;
  onSaveRepos: () => void;
}

function WorkspaceRow({ workspace, focused, editing, contextOpen, contextOn, busy, editRepos, setRef, onOpen, onToggleEdit, onToggleContext, onContextChanged, onDelete, onEditRepos, onSaveRepos }: RowProps) {
  const menu = useCardMenu();
  const handlers: Record<WorkspaceMenuKey, () => void> = { edit: onToggleEdit, context: onToggleContext, delete: onDelete };
  const items: CardMenuItem[] = workspaceMenuEntries(editing, contextOpen).map((entry) => ({
    key: entry.key,
    label: entry.label,
    danger: entry.danger,
    onSelect: handlers[entry.key],
  }));

  return (
    <li ref={setRef} className={`wsrow ${focused ? "wsrow--focus" : ""}`} aria-current={focused ? "true" : undefined}>
      <div className="wsrow__main">
        <span className="wsrow__name" title={workspace.name}>
          {workspace.name}
          {workspace.error && <span className="tag tag--hold">unreadable</span>}
          {contextOn && <span className="muted small">session context on</span>}
        </span>
        <span className="wsrow__repos muted small">{repoCountLabel(workspace.repos.length)}</span>
        <span className="wsrow__context muted small" title={contextLabel(workspace)}>
          {contextLabel(workspace)}
        </span>
        <span className="wsrow__actions">
          <button className="act act--focus" disabled={busy} onClick={onOpen}>
            Open
          </button>
          <CardMenu menu={menu} items={items} label={`Actions for ${workspace.name}`} />
        </span>
      </div>
      {contextOpen && <WorkspaceContext name={workspace.name} enabled={contextOn} onChanged={onContextChanged} />}
      {editing && (
        <div className="wsrow__detail">
          <p className="muted small path">{workspace.file}</p>
          <ul className="repolist">
            {workspace.repos.map((repo) => (
              <li key={repo.path}>
                <span className="repolist__name">{repo.name}</span>
                <span className="path muted">{repo.path}</span>
              </li>
            ))}
          </ul>
          <label className="field">
            <span>Edit repos (one absolute path per line)</span>
            <textarea className="in area" value={editRepos} onChange={(event) => onEditRepos(event.target.value)} />
          </label>
          <div className="actions">
            <button className="act act--focus" disabled={busy} onClick={onSaveRepos}>
              Save repos
            </button>
            <button className="act act--ghost" onClick={onToggleEdit}>
              Close
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function WorkspacesView({ workspaces, settings, enabled, focusName, onChanged, onOpenSettings, onNotice, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState<string | null>(null);
  const [handoffNames, setHandoffNames] = useState<string[]>(memorySettingsOf(settings).handoffWorkspaces);
  const [editRepos, setEditRepos] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRepos, setNewRepos] = useState("");
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<WorkspaceRecord | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const focused = decodeWorkspaceParam(focusName);

  const scrolledRef = useRef<string | null>(null);

  useEffect(() => {
    setHandoffNames(memorySettingsOf(settings).handoffWorkspaces);
  }, [settings]);

  useEffect(() => {
    if (!focused) {
      scrolledRef.current = null;
      return;
    }
    if (scrolledRef.current === focused) return;
    const node = rowRefs.current.get(focused);
    if (!node) return;
    scrolledRef.current = focused;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused, workspaces]);

  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const notice = await action();
      await onChanged();
      if (notice) onNotice(notice);
    } catch (err) {
      onError(err instanceof Error ? err.message : "action failed");
    } finally {
      setBusy(false);
    }
  };

  const toggleEdit = (workspace: WorkspaceRecord) => {
    if (editing === workspace.name) {
      setEditing(null);
      return;
    }
    setEditing(workspace.name);
    setEditRepos(workspace.repos.map((repo) => repo.path).join("\n"));
  };

  const root = settings?.workspacesRoot ?? null;
  const visible = filterWorkspaces(workspaces, query);

  return (
    <div className="view view--workspaces">
      <div className="wstoolbar">
        <input className="in wstoolbar__search" placeholder="search workspace name" aria-label="Search workspaces" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="wstoolbar__right">
          <Toggletip label="About workspaces" align="end">
            <span>
              Every <code>&lt;name&gt;.code-workspace</code> in your workspaces root is a workspace: the folder <code>&lt;name&gt;/</code> next to it is its context (CLAUDE.md, skills), the other
              folders are its repos.
            </span>
            <span>
              Delegated runs start in the context with every repo attached; the <code>wk</code> alias reads the same folder.
            </span>
          </Toggletip>
          <button className="act act--focus" disabled={!root || busy} onClick={() => setCreating((value) => !value)}>
            {creating ? "Close" : "New workspace"}
          </button>
        </div>
      </div>

      {!enabled && <p className="callout">The hub surface is off on this server. Workspaces need it: see Settings › Hooks and connections.</p>}
      {enabled && !root && (
        <p className="callout">
          No workspaces root yet. Point it at the folder holding your <code>.code-workspace</code> files in{" "}
          <button className="link" onClick={onOpenSettings}>
            Settings › Paths
          </button>
          .
        </p>
      )}
      {root && (
        <p className="muted small wsroot" title={root}>
          Root: <span className="path">{root}</span>
        </p>
      )}

      {creating && root && (
        <section className="panel">
          <h3>New workspace</h3>
          <div className="form">
            <label className="field">
              <span>Name</span>
              <input className="in" placeholder="letters, digits, dots, dashes" value={newName} onChange={(event) => setNewName(event.target.value)} />
            </label>
            <label className="field">
              <span>Repos (one absolute path per line)</span>
              <textarea className="in area" value={newRepos} onChange={(event) => setNewRepos(event.target.value)} placeholder={"C:\\code\\api\nC:\\code\\web"} />
            </label>
            <div className="actions">
              <button
                className="act act--focus"
                disabled={busy || newName.trim().length === 0}
                onClick={() =>
                  void run(async () => {
                    await createWorkspace(newName.trim(), splitRepoLines(newRepos));
                    setNewName("");
                    setNewRepos("");
                    setCreating(false);
                    return `Workspace ${newName.trim()} created with its context folder.`;
                  })
                }
              >
                Create
              </button>
            </div>
          </div>
        </section>
      )}

      {visible.length > 0 && (
        <ul className="wslist">
          {visible.map((workspace) => (
            <WorkspaceRow
              key={workspace.name}
              workspace={workspace}
              focused={focused === workspace.name}
              editing={editing === workspace.name}
              contextOpen={contextOpen === workspace.name}
              contextOn={handoffNames.includes(workspace.name)}
              busy={busy}
              editRepos={editRepos}
              setRef={(node) => {
                if (node) rowRefs.current.set(workspace.name, node);
                else rowRefs.current.delete(workspace.name);
              }}
              onOpen={() =>
                void run(async () => {
                  const outcome = await openWorkspace(workspace.name);
                  if (!outcome.ok) throw new Error(outcome.error ?? "could not open");
                  return `Opening ${workspace.name} with ${outcome.command}.`;
                })
              }
              onToggleEdit={() => toggleEdit(workspace)}
              onToggleContext={() => setContextOpen((current) => (current === workspace.name ? null : workspace.name))}
              onContextChanged={(enabled) => setHandoffNames((current) => (enabled ? [...new Set([...current, workspace.name])] : current.filter((item) => item !== workspace.name)))}
              onDelete={() => setPendingDelete(workspace)}
              onEditRepos={setEditRepos}
              onSaveRepos={() =>
                void run(async () => {
                  await updateWorkspace(workspace.name, splitRepoLines(editRepos));
                  setEditing(null);
                  return `Workspace ${workspace.name} updated.`;
                })
              }
            />
          ))}
        </ul>
      )}
      {enabled && root && workspaces.length === 0 && <p className="empty">No workspaces in this root yet: press New workspace.</p>}
      {workspaces.length > 0 && visible.length === 0 && <p className="empty">No workspace matches this search.</p>}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete workspace ${pendingDelete.name}?`}
          body={`Removes ${pendingDelete.file}. Repos are never touched.`}
          confirmLabel="Delete"
          danger
          checkbox={pendingDelete.contextPath ? { label: `Also delete the context folder ${pendingDelete.contextPath}` } : undefined}
          onCancel={() => setPendingDelete(null)}
          onConfirm={(alsoContext) => {
            const target = pendingDelete;
            setPendingDelete(null);
            void run(async () => {
              const outcome = await deleteWorkspace(target.name, alsoContext);
              return `Workspace ${target.name} deleted${outcome.contextDeleted ? " with its context folder" : ""}.`;
            });
          }}
        />
      )}
    </div>
  );
}
