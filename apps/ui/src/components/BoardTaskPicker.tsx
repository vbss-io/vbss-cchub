import { useEffect, useMemo, useState } from "react";
import { BOARD_STATUS_LABEL, focusItemFromTask, pickableTasks, projectBreadcrumb, projectOptions, sortByPriority } from "../board-model";
import { doingFocusItem, formatNewItemLine, hasFocusItem, type DailyFocusDraftItem } from "../daily-plan";
import { getTasksBoard, type BoardPayload } from "../delegation";
import { BoardPriorityBadge } from "./BoardParts";

interface Props {
  newItemsText: string;
  carriedItems: DailyFocusDraftItem[];
  wikilinks: boolean;
  onPick: (item: DailyFocusDraftItem) => void;
  onPickDoing: (item: DailyFocusDraftItem) => void;
}

export function BoardTaskPicker({ newItemsText, carriedItems, wikilinks, onPick, onPickDoing }: Props) {
  const [open, setOpen] = useState(false);
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    getTasksBoard()
      .then((payload) => {
        if (alive) setBoard(payload);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : "could not load tasks");
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const projects = board?.projects ?? [];
  const options = useMemo(() => projectOptions(projects), [projects]);
  const written = useMemo(() => new Set(newItemsText.split(/\r?\n/).map((line) => line.trim())), [newItemsText]);
  const tasks = useMemo(() => sortByPriority(pickableTasks(board?.tasks ?? [], projects, projectId)), [board, projects, projectId]);

  return (
    <div className="board-picker">
      <div className="frow">
        <button className="act" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "Hide Tasks" : "Add from Tasks"}
        </button>
      </div>
      {open && (
        <div className="board-picker__panel">
          {error && <span className="error small">{error}</span>}
          {!error && !board && <p className="muted small">Loading…</p>}
          {board && !board.configured && <p className="muted small">The Tasks folder is not set up yet. Check Settings › Features › Tasks.</p>}
          {board && board.configured && (
            <>
              <select
                className="select"
                aria-label="Filter by project"
                value={projectId ?? ""}
                onChange={(event) => setProjectId(event.target.value === "" ? null : event.target.value)}
              >
                <option value="">All projects</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              {tasks.length === 0 && <p className="muted small">No To-Do or Doing tasks here.</p>}
              <div className="board-picker__list">
                {tasks.map((task) => {
                  const project = projects.find((candidate) => candidate.id === task.projectId);
                  const picked = project ? focusItemFromTask(project, task) : null;
                  const isDoing = task.status === "doing";
                  const item = picked && isDoing ? doingFocusItem(picked, wikilinks) : picked;
                  const isAdded = item !== null && (isDoing ? hasFocusItem(carriedItems, item) : written.has(formatNewItemLine(item)));
                  return (
                    <div className="board-picker__row" key={task.id}>
                      <span className="board-picker__text">
                        <span className="board-picker__title">
                          <BoardPriorityBadge priority={task.priority} /> {task.title}
                        </span>
                        <span className="muted small">{projectBreadcrumb(projects, task.projectId).join(" › ")}</span>
                      </span>
                      <span className={`tag tag--board-${task.status}`}>{BOARD_STATUS_LABEL[task.status]}</span>
                      <button
                        className="act act--focus"
                        disabled={!item || isAdded}
                        onClick={() => {
                          if (!item) return;
                          if (isDoing) onPickDoing(item);
                          else onPick(item);
                        }}
                      >
                        {isAdded ? "Added" : "Add"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
