import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { parentCandidateLabel, parentCandidates, type BoardProjectOption, type ParentCandidate } from "../board-model";
import type { BoardTask } from "../delegation";
import { BoardPriorityBadge } from "./BoardParts";

function useEscape(onCancel: () => void, busy: boolean): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);
}

interface ParentPickerProps {
  task: BoardTask;
  candidates: ParentCandidate[];
  levels?: number | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (parent: BoardTask) => void;
}

export function BoardParentPickerDialog({ task, candidates, levels, busy, onCancel, onSubmit }: ParentPickerProps) {
  const [selected, setSelected] = useState<string | null>(null);
  useEscape(onCancel, busy);
  const chosen = candidates.find((candidate) => candidate.task.id === selected)?.task ?? null;
  return (
    <div className="modal__overlay" onClick={() => !busy && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Make subtask of" onClick={(event) => event.stopPropagation()}>
        <header className="modal__header">
          <h2>Make subtask of</h2>
        </header>
        <div className="modal__body">
          <p className="hint board-dialog__task">{task.title}</p>
          {candidates.length === 0 && <p className="muted small">No other task in this project can become its parent.</p>}
          {candidates.length > 0 && (
            <div className="board-pick" role="radiogroup" aria-label="New parent task">
              {candidates.map((candidate) => (
                <label
                  key={candidate.task.id}
                  className={`board-pick__item ${selected === candidate.task.id ? "board-pick__item--on" : ""}`}
                  style={{ "--level": candidate.level } as CSSProperties}
                >
                  <input type="radio" name="board-parent" checked={selected === candidate.task.id} disabled={busy} onChange={() => setSelected(candidate.task.id)} />
                  <BoardPriorityBadge priority={candidate.task.priority} levels={levels} />
                  <span className="board-pick__title">
                    {candidate.task.title}
                    {candidate.task.section === "done" ? " (done section)" : ""}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
        <footer className="modal__footer">
          <button className="act act--ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="act act--focus" disabled={busy || chosen === null} onClick={() => chosen && onSubmit(chosen)}>
            {busy ? "Moving…" : "Make subtask"}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface MoveProjectProps {
  task: BoardTask;
  projects: BoardProjectOption[];
  tasks: BoardTask[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (targetProjectId: string, parent: BoardTask | null) => void;
}

export function BoardMoveProjectDialog({ task, projects, tasks, busy, onCancel, onSubmit }: MoveProjectProps) {
  const [targetId, setTargetId] = useState("");
  const [parentId, setParentId] = useState("");
  useEscape(onCancel, busy);
  const candidates = useMemo(() => (targetId === "" ? [] : parentCandidates(tasks, targetId)), [tasks, targetId]);
  const parent = candidates.find((candidate) => candidate.task.id === parentId)?.task ?? null;
  return (
    <div className="modal__overlay" onClick={() => !busy && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Move to project" onClick={(event) => event.stopPropagation()}>
        <header className="modal__header">
          <h2>Move to project</h2>
        </header>
        <div className="modal__body">
          <p className="hint board-dialog__task">{task.title}</p>
          <label className="field">
            <span>Project</span>
            <select
              className="in"
              aria-label="Target project"
              value={targetId}
              disabled={busy}
              onChange={(event) => {
                setTargetId(event.target.value);
                setParentId("");
              }}
            >
              <option value="">Select a project</option>
              {projects.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Place under</span>
            <select className="in" aria-label="Parent task in the target project" value={parentId} disabled={busy || targetId === ""} onChange={(event) => setParentId(event.target.value)}>
              <option value="">Top level</option>
              {candidates.map((candidate) => (
                <option key={candidate.task.id} value={candidate.task.id}>
                  {parentCandidateLabel(candidate)}
                </option>
              ))}
            </select>
            <small>The task keeps its notes and subtasks.</small>
          </label>
        </div>
        <footer className="modal__footer">
          <button className="act act--ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="act act--focus" disabled={busy || targetId === ""} onClick={() => onSubmit(targetId, parent)}>
            {busy ? "Moving…" : "Move"}
          </button>
        </footer>
      </div>
    </div>
  );
}
