import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { createWorkspace, deleteWorkspace, openWorkspace, updateWorkspace, type DelegationSettings, type WorkspaceRecord } from "../delegation";

interface Props {
  workspaces: WorkspaceRecord[];
  settings: DelegationSettings | null;
  enabled: boolean;
  onChanged: () => Promise<void>;
  onOpenSettings: () => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}

const splitLines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export function WorkspacesView({ workspaces, settings, enabled, onChanged, onOpenSettings, onNotice, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editRepos, setEditRepos] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRepos, setNewRepos] = useState("");
  const [pendingDelete, setPendingDelete] = useState<WorkspaceRecord | null>(null);

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

  const root = settings?.workspacesRoot ?? null;

  return (
    <div className="view">
      <div className="toolbar">
        <p className="hint hint--lead">
          Every <code>&lt;name&gt;.code-workspace</code> in your workspaces root is a workspace: the folder <code>&lt;name&gt;/</code> next to it is
          its context (CLAUDE.md, skills), the other folders are its repos. Delegated runs start in the context with every repo attached; the{" "}
          <code>wk</code> alias reads the same folder.
        </p>
        <div className="toolbar__right">
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
      {root && <p className="muted small">Root: <span className="path">{root}</span></p>}

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
                    await createWorkspace(newName.trim(), splitLines(newRepos));
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

      {workspaces.length > 0 && (
        <div className="table">
          <div className="table__head">
            <span>Workspace</span>
            <span>Repos</span>
            <span>Context</span>
            <span className="table__actions">Actions</span>
          </div>
          {workspaces.map((workspace) => (
            <div key={workspace.name} className="table__rowgroup">
              <div className="table__row">
                <span className="table__name">
                  {workspace.name}
                  {workspace.error && <span className="tag tag--hold">unreadable</span>}
                </span>
                <span>{workspace.repos.length}</span>
                <span className="muted">{workspace.contextPath ? "context folder" : "no context folder"}</span>
                <span className="table__actions">
                  <button
                    className="act"
                    disabled={busy}
                    onClick={() => {
                      if (editing === workspace.name) {
                        setEditing(null);
                        return;
                      }
                      setEditing(workspace.name);
                      setEditRepos(workspace.repos.map((repo) => repo.path).join("\n"));
                    }}
                  >
                    {editing === workspace.name ? "Close" : "Repos"}
                  </button>
                  <button
                    className="act act--focus"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const outcome = await openWorkspace(workspace.name);
                        if (!outcome.ok) throw new Error(outcome.error ?? "could not open");
                        return `Opening ${workspace.name} with ${outcome.command}.`;
                      })
                    }
                  >
                    Open
                  </button>
                  <button className="act act--danger" disabled={busy} onClick={() => setPendingDelete(workspace)}>
                    Delete
                  </button>
                </span>
              </div>
              {editing === workspace.name && (
                <div className="table__detail">
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
                    <textarea className="in area" value={editRepos} onChange={(event) => setEditRepos(event.target.value)} />
                  </label>
                  <div className="actions">
                    <button
                      className="act act--focus"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await updateWorkspace(workspace.name, splitLines(editRepos));
                          setEditing(null);
                          return `Workspace ${workspace.name} updated.`;
                        })
                      }
                    >
                      Save repos
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {enabled && root && workspaces.length === 0 && <p className="empty">No workspaces in this root yet. Create one above.</p>}

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
