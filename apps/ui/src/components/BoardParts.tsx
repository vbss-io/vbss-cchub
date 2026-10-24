import { useRef, useState } from "react";
import {
  BOARD_STATUSES,
  BOARD_STATUS_LABEL,
  priorityLabel,
  priorityLevelList,
  priorityTone,
  reasonChange,
  supportsReason,
  type MoveAvailability,
  type MoveDirection,
} from "../board-model";
import type { BoardCheckbox, BoardNoteItem, BoardStatus, BoardTask } from "../delegation";
import { IconChevron, IconClose, IconDetails, IconEdit } from "../icons";

interface ExpandButtonProps {
  title: string;
  expanded: boolean;
  onToggle: () => void;
}

export function BoardExpandButton({ title, expanded, onToggle }: ExpandButtonProps) {
  return (
    <button
      className={`act act--icon board-expand ${expanded ? "board-expand--on" : ""}`}
      aria-expanded={expanded}
      aria-label={expanded ? `Hide details of ${title}` : `Show details of ${title}`}
      onClick={onToggle}
    >
      <IconChevron />
    </button>
  );
}

export function BoardTodayBadge({ inToday, checkbox }: { inToday: boolean; checkbox: BoardCheckbox | null }) {
  if (!inToday) return null;
  return (
    <span className="chip board-today" title="Linked in today's daily">
      Today{checkbox ? ` · ${BOARD_STATUS_LABEL[checkbox]}` : ""}
    </span>
  );
}

export function BoardDoneStamp({ task }: { task: BoardTask }) {
  if (task.section !== "done") return null;
  return (
    <span className="chip board-donestamp" title="In the done section">
      {task.doneAt ? `Done ${task.doneAt}` : "Done section"}
    </span>
  );
}

export function BoardDetailsButton({ title, onOpen }: { title: string; onOpen: () => void }) {
  return (
    <button className="act act--icon board-act board-details-btn" aria-label={`Open details of ${title}`} title="Open details" onClick={onOpen}>
      <IconDetails />
    </button>
  );
}

interface StatusSelectProps {
  value: BoardStatus;
  label: string;
  disabled?: boolean;
  onChange: (status: BoardStatus) => void;
}

export function BoardStatusSelect({ value, label, disabled = false, onChange }: StatusSelectProps) {
  return (
    <select
      className={`select board-status board-status--${value}`}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as BoardStatus)}
    >
      {BOARD_STATUSES.map((status) => (
        <option key={status} value={status}>
          {BOARD_STATUS_LABEL[status]}
        </option>
      ))}
    </select>
  );
}

interface TitleInputProps {
  initial: string;
  label?: string;
  placeholder?: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}

function TitleInput({ initial, label = "Task title", placeholder, onCommit, onCancel }: TitleInputProps) {
  const [draft, setDraft] = useState(initial);
  const finished = useRef(false);
  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (commit) onCommit(draft);
    else onCancel();
  };
  return (
    <input
      className="in board-title__input"
      aria-label={label}
      placeholder={placeholder}
      autoFocus
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(true);
        else if (event.key === "Escape") finish(false);
      }}
    />
  );
}

interface TitleProps {
  task: BoardTask;
  editing: boolean;
  disabled?: boolean;
  onEditingChange: (editing: boolean) => void;
  onRename: (title: string) => void;
}

export function BoardTitle({ task, editing, disabled = false, onEditingChange, onRename }: TitleProps) {
  if (editing) {
    return (
      <TitleInput
        initial={task.title}
        onCancel={() => onEditingChange(false)}
        onCommit={(draft) => {
          onEditingChange(false);
          const next = draft.trim();
          if (next !== "" && next !== task.title) onRename(next);
        }}
      />
    );
  }
  return (
    <span className="board-title">
      <span className="board-title__text" title="Double-click to rename" onDoubleClick={() => !disabled && onEditingChange(true)}>
        {task.title}
      </span>
      <button className="act act--icon board-title__edit" aria-label={`Rename ${task.title}`} disabled={disabled} onClick={() => onEditingChange(true)}>
        <IconEdit />
      </button>
    </span>
  );
}

interface ReasonProps {
  task: BoardTask;
  disabled?: boolean;
  onChange: (reason: string | null) => void;
}

export function BoardReason({ task, disabled = false, onChange }: ReasonProps) {
  const [editing, setEditing] = useState(false);
  if (!supportsReason(task.status)) return null;
  if (editing) {
    return (
      <span className="board-reason board-reason--editing">
        <TitleInput
          initial={task.reason ?? ""}
          label="Reason"
          placeholder="Why is it on this status?"
          onCancel={() => setEditing(false)}
          onCommit={(draft) => {
            setEditing(false);
            const next = reasonChange(draft, task.reason);
            if (next !== undefined) onChange(next);
          }}
        />
      </span>
    );
  }
  if (task.reason === null) {
    return (
      <button className="board-reason board-reason--add" disabled={disabled} onClick={() => setEditing(true)}>
        Add reason
      </button>
    );
  }
  return (
    <span className="board-reason">
      <span className="board-reason__text" title="Double-click to edit the reason" onDoubleClick={() => !disabled && setEditing(true)}>
        {task.reason}
      </span>
      <button className="act act--icon board-title__edit" aria-label={`Edit the reason of ${task.title}`} disabled={disabled} onClick={() => setEditing(true)}>
        <IconEdit />
      </button>
    </span>
  );
}


interface PriorityBadgeProps {
  priority: number | null;
  levels?: number | null;
}

export function BoardPriorityBadge({ priority, levels }: PriorityBadgeProps) {
  if (priority === null) return null;
  return (
    <span className={`chip board-prio board-prio--${priorityTone(priority, levels)}`} title={`Priority ${priorityLabel(priority)}`}>
      {priorityLabel(priority)}
    </span>
  );
}

interface PrioritySelectProps {
  value: number | null;
  levels?: number | null;
  label: string;
  disabled?: boolean;
  compact?: boolean;
  onChange: (priority: number | null) => void;
}

export function BoardPrioritySelect({ value, levels, label, disabled = false, compact = false, onChange }: PrioritySelectProps) {
  return (
    <select
      className={`select board-prio-select ${compact ? "board-prio-select--compact" : ""} ${value === null ? "" : `board-prio-select--${priorityTone(value, levels)}`}`}
      title={label}
      aria-label={label}
      value={value === null ? "" : String(value)}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
    >
      <option value="">{compact ? "No priority" : "None"}</option>
      {priorityLevelList(levels, value).map((level) => (
        <option key={level} value={level}>
          {priorityLabel(level)}
        </option>
      ))}
    </select>
  );
}

export function BoardPriorityField({ task, levels, disabled, onChange }: { task: BoardTask; levels?: number | null; disabled: boolean; onChange: (priority: number | null) => void }) {
  return (
    <label className="board-field">
      <span className="muted small">Priority</span>
      <BoardPrioritySelect value={task.priority} levels={levels} label={`Priority of ${task.title}`} disabled={disabled} onChange={onChange} />
    </label>
  );
}

export interface BoardNoteActions {
  onAdd: (task: BoardTask, text: string) => Promise<boolean>;
  onEdit: (task: BoardTask, note: BoardNoteItem, text: string) => void;
  onDelete: (task: BoardTask, note: BoardNoteItem) => void;
}

export interface BoardNoteMove {
  availability: MoveAvailability;
  onMove: (direction: MoveDirection) => void;
}

interface NoteItemProps {
  task: BoardTask;
  note: BoardNoteItem;
  disabled: boolean;
  actions: BoardNoteActions;
  move?: BoardNoteMove;
}

export function BoardNoteRow({ task, note, disabled, actions, move }: NoteItemProps) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li className="board-note board-note--editing">
        <TitleInput
          initial={note.text}
          label="Note"
          onCancel={() => setEditing(false)}
          onCommit={(draft) => {
            setEditing(false);
            const next = draft.trim();
            if (next !== "" && next !== note.text) actions.onEdit(task, note, next);
          }}
        />
      </li>
    );
  }
  return (
    <li className="board-note">
      <span className="board-note__text" title="Double-click to edit" onDoubleClick={() => !disabled && setEditing(true)}>
        {note.text}
      </span>
      {move && (
        <>
          <button
            className="act act--icon board-title__edit board-note__move"
            aria-label={`Move note up: ${note.text}`}
            title={move.availability.up ? "Move up" : "Already first"}
            disabled={disabled || !move.availability.up}
            onClick={() => move.onMove("up")}
          >
            <span aria-hidden="true">↑</span>
          </button>
          <button
            className="act act--icon board-title__edit board-note__move"
            aria-label={`Move note down: ${note.text}`}
            title={move.availability.down ? "Move down" : "Already last"}
            disabled={disabled || !move.availability.down}
            onClick={() => move.onMove("down")}
          >
            <span aria-hidden="true">↓</span>
          </button>
        </>
      )}
      <button className="act act--icon board-title__edit" aria-label={`Edit note ${note.text}`} disabled={disabled} onClick={() => setEditing(true)}>
        <IconEdit />
      </button>
      <button className="act act--icon board-title__edit" aria-label={`Delete note ${note.text}`} disabled={disabled} onClick={() => actions.onDelete(task, note)}>
        <IconClose size={12} />
      </button>
    </li>
  );
}

export function BoardNoteAdd({ task, disabled, onAdd }: { task: BoardTask; disabled: boolean; onAdd: BoardNoteActions["onAdd"] }) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const submit = async () => {
    if (disabled || draft.trim() === "") return;
    if (await onAdd(task, draft)) {
      setDraft("");
      window.setTimeout(() => input.current?.focus(), 0);
    }
  };
  return (
    <li className="board-note board-note--add">
      <input
        ref={input}
        className="in board-note__input"
        placeholder="Add note"
        aria-label={`Add note to ${task.title}`}
        value={draft}
        readOnly={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
          else if (event.key === "Escape") setDraft("");
        }}
      />
    </li>
  );
}

export function BoardNotes({ task, disabled, actions }: { task: BoardTask; disabled: boolean; actions: BoardNoteActions }) {
  return (
    <ul className="board-notes">
      {task.noteItems.map((note) => (
        <BoardNoteRow key={`${note.line}:${note.raw}`} task={task} note={note} disabled={disabled} actions={actions} />
      ))}
      <BoardNoteAdd task={task} disabled={disabled} onAdd={actions.onAdd} />
    </ul>
  );
}

interface SubtasksProps {
  tasks: BoardTask[];
  pending: ReadonlySet<string>;
  expandedIds: ReadonlySet<string>;
  levels?: number | null;
  onToggleId: (id: string) => void;
  onStatus: (task: BoardTask, status: BoardStatus) => void;
  onRename: (task: BoardTask, title: string) => void;
  onReason: (task: BoardTask, reason: string | null) => void;
  onPriority: (task: BoardTask, priority: number | null) => void;
  noteActions: BoardNoteActions;
}

function SubtaskRow({ task, ...shared }: Omit<SubtasksProps, "tasks"> & { task: BoardTask }) {
  const { pending, expandedIds, levels, onToggleId, onStatus, onRename, onReason, onPriority, noteActions } = shared;
  const [editing, setEditing] = useState(false);
  const busy = pending.has(task.id);
  const open = expandedIds.has(task.id);
  return (
    <li className="board-sub__item">
      <div className="board-sub__row">
        <BoardExpandButton title={task.title} expanded={open} onToggle={() => onToggleId(task.id)} />
        <span className={`board-sub__title ${task.status === "done" ? "board-sub__title--done" : ""}`}>
          <BoardTitle task={task} editing={editing} disabled={busy} onEditingChange={setEditing} onRename={(title) => onRename(task, title)} />
        </span>
        <BoardPriorityBadge priority={task.priority} levels={levels} />
        <BoardStatusSelect value={task.status} label={`Status of ${task.title}`} disabled={busy} onChange={(status) => onStatus(task, status)} />
      </div>
      <BoardReason task={task} disabled={busy} onChange={(reason) => onReason(task, reason)} />
      {open && <BoardPriorityField task={task} levels={levels} disabled={busy} onChange={(priority) => onPriority(task, priority)} />}
      {open && <BoardNotes task={task} disabled={busy} actions={noteActions} />}
      {open && task.subtasks.length > 0 && <BoardSubtasks tasks={task.subtasks} {...shared} />}
    </li>
  );
}

export function BoardSubtasks({ tasks, ...shared }: SubtasksProps) {
  return (
    <ul className="board-sub">
      {tasks.map((task) => (
        <SubtaskRow key={task.id} task={task} {...shared} />
      ))}
    </ul>
  );
}
