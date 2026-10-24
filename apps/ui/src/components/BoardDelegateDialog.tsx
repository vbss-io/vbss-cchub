import { useEffect, useMemo, useState } from "react";
import { delegatePromptFor } from "../board-model";
import type { BoardProject, BoardTask, Runner, WorkspaceRecord } from "../delegation";

export interface BoardDelegateRequest {
  workspace: string;
  repo: string;
  runner: Runner;
  prompt: string;
}

interface Props {
  task: BoardTask;
  project: BoardProject;
  template: string;
  workspaces: WorkspaceRecord[];
  notice: string | null;
  taskMissing: boolean;
  onCancel: () => void;
  onSubmit: (request: BoardDelegateRequest) => Promise<void>;
}

function initialWorkspace(project: BoardProject, workspaces: WorkspaceRecord[]): string {
  const wanted = project.workspace;
  const match = wanted ? workspaces.find((workspace) => workspace.name === wanted || workspace.name.toLowerCase() === wanted.toLowerCase()) : undefined;
  if (match) return match.name;
  return workspaces.length === 1 ? (workspaces[0] as WorkspaceRecord).name : "";
}

export function BoardDelegateDialog({ task, project, template, workspaces, notice, taskMissing, onCancel, onSubmit }: Props) {
  const [workspace, setWorkspace] = useState(() => initialWorkspace(project, workspaces));
  const [repo, setRepo] = useState("");
  const [runner, setRunner] = useState<Runner>("claude");
  const rendered = useMemo(() => delegatePromptFor(template, project, task), [template, project, task]);
  const [prompt, setPrompt] = useState(rendered);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  const selected = workspaces.find((item) => item.name === workspace) ?? null;
  const unknownWorkspace = project.workspace !== null && !workspaces.some((item) => item.name.toLowerCase() === project.workspace?.toLowerCase());
  const ready = workspace !== "" && prompt.trim() !== "" && !busy && !taskMissing;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ workspace, repo, runner, prompt });
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not delegate");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal__overlay" onClick={() => !busy && onCancel()}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" aria-label="Delegate task" onClick={(event) => event.stopPropagation()}>
        <header className="modal__header">
          <h2>Delegate task</h2>
        </header>
        <div className="modal__body">
          <p className="hint board-dialog__task">{task.title}</p>
          <div className="frow frow--fields frow--top">
            <label className="field">
              <span>Workspace</span>
              <select
                className="in"
                value={workspace}
                onChange={(event) => {
                  setWorkspace(event.target.value);
                  setRepo("");
                }}
              >
                <option value="">Select a workspace</option>
                {workspaces.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
              {project.workspace && !unknownWorkspace && (
                <small>From the project notes{project.workspaceSource === "inherited" ? " (inherited from a parent project)" : ""}.</small>
              )}
              {unknownWorkspace && <small>The project names workspace "{project.workspace}", which is not registered in the hub.</small>}
            </label>
            <label className="field">
              <span>Repository (optional)</span>
              <select className="in" value={repo} onChange={(event) => setRepo(event.target.value)} disabled={!selected}>
                <option value="">whole workspace</option>
                {(selected?.repos ?? []).map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Runner</span>
              <select className="in" value={runner} onChange={(event) => setRunner(event.target.value as Runner)}>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Prompt</span>
            <textarea className="in area board-dialog__prompt" rows={12} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          {notice && (
            <p className="hint board-dialog__notice" role="status">
              {notice}
            </p>
          )}
          {error && <span className="error small">{error}</span>}
        </div>
        <footer className="modal__footer">
          <button className="act act--ghost" disabled={prompt === rendered || busy} onClick={() => setPrompt(rendered)}>
            Reset prompt
          </button>
          <span className="spacer" />
          <button className="act act--ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="act act--focus" disabled={!ready} onClick={() => void submit()}>
            {busy ? "Delegating…" : "Delegate"}
          </button>
        </footer>
      </div>
    </div>
  );
}
