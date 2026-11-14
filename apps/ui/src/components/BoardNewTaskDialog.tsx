import { useCallback, useEffect, useState } from "react";
import { BOARD_STATUSES, BOARD_STATUS_LABEL, newTaskBody, projectBreadcrumb, projectOptions, supportsReason, validateNewTask } from "../board-model";
import type { BoardCreateInput, BoardProject, BoardStatus, BoardTask } from "../delegation";
import { BoardDateInput, BoardPrioritySelect } from "./BoardParts";
import "../board-drawer.css";

interface Props {
  projects: BoardProject[];
  defaultProjectId: string;
  parent: BoardTask | null;
  levels?: number | null;
  onCancel: () => void;
  onSubmit: (body: BoardCreateInput) => Promise<void>;
}

export function BoardNewTaskDialog({ projects, defaultProjectId, parent, levels, onCancel, onSubmit }: Props) {
  const [projectId, setProjectId] = useState(parent ? parent.projectId : defaultProjectId);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<BoardStatus>("todo");
  const [reason, setReason] = useState("");
  const [priority, setPriority] = useState<number | null>(null);
  const [due, setDue] = useState("");
  const [dueInvalid, setDueInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const options = projectOptions(projects);
  const chosen = options.find((option) => option.id === projectId) ?? null;
  const [projectInMain] = useState(() => parent === null && !projectOptions(projects).some((option) => option.id === defaultProjectId));
  const draft = { projectId, title, status, reason, priority, due };
  const problem = validateNewTask(draft);
  const blocked = problem ?? (dueInvalid ? "Fix the due date first" : null);
  const onDueInvalid = useCallback((invalid: boolean) => {
    setDueInvalid(invalid);
    if (invalid) setMoreOpen(true);
  }, []);
  const projectField = (
    <label className="field">
      <span>Project</span>
      <select className="in" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
        <option value="">Select a project</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
  const heading = parent ? "Add subtask" : "New task";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  const submit = async () => {
    if (blocked !== null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(newTaskBody(draft, parent));
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create the task");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal__overlay" onClick={() => !busy && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={heading} onClick={(event) => event.stopPropagation()}>
        <header className="modal__header">
          <h2>{heading}</h2>
        </header>
        <div className="modal__body">
          {parent && (
            <p className="hint board-dialog__task">
              Under "{parent.title}" in {projectBreadcrumb(projects, parent.projectId).join(" › ")}
            </p>
          )}
          {projectInMain && projectField}
          <label className="field">
            <span>Title</span>
            <input
              className="in"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
            />
          </label>
          {!parent && !projectInMain && chosen !== null && <p className="hint">In {chosen.label}</p>}
          <details className="more-options" open={moreOpen} onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
            <summary className="more-options__summary">More options</summary>
            <div className="more-options__body">
              {!parent && !projectInMain && projectField}
              <div className="frow frow--fields">
                <label className="field">
                  <span>Status</span>
                  <select className="in" value={status} onChange={(event) => setStatus(event.target.value as BoardStatus)}>
                    {BOARD_STATUSES.map((item) => (
                      <option key={item} value={item}>
                        {BOARD_STATUS_LABEL[item]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Priority</span>
                  <BoardPrioritySelect value={priority} levels={levels} label="Priority" onChange={setPriority} />
                </label>
              </div>
              <label className="field">
                <span>Due (optional)</span>
                <BoardDateInput ariaLabel="Due date" className="in" value={due === "" ? null : due} onCommit={(value) => setDue(value ?? "")} onInvalidChange={onDueInvalid} />
              </label>
              {supportsReason(status) && (
                <label className="field">
                  <span>Reason (optional)</span>
                  <input
                    className="in"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submit();
                    }}
                  />
                </label>
              )}
            </div>
          </details>
          {error && <span className="error small">{error}</span>}
        </div>
        <footer className="modal__footer">
          <span className="spacer" />
          <button className="act act--ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="act act--focus" disabled={blocked !== null || busy} title={blocked ?? undefined} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create"}
          </button>
        </footer>
      </div>
    </div>
  );
}
