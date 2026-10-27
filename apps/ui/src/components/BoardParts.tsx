import { useEffect, useRef, useState } from "react";
import {
  BOARD_STATUSES,
  BOARD_STATUS_LABEL,
  DATE_MAX_YEAR,
  DATE_MIN_YEAR,
  dueChip,
  FINISHED_OCCURRENCE_HINT,
  priorityLabel,
  priorityLevelList,
  priorityTone,
  reasonChange,
  REPEAT_CUSTOM,
  REPEAT_PRESETS,
  repeatChoice,
  repeatFromChoice,
  resolveDateDraft,
  supportsReason,
  taskDates,
  todayStatusBadge,
  type MoveAvailability,
  type MoveDirection,
} from "../board-model";
import type { BoardCheckbox, BoardChange, BoardNoteItem, BoardStatus, BoardTask } from "../delegation";
import { IconCalendarPlus, IconChevron, IconClose, IconEdit, IconRepeat } from "../icons";
import { InlineText } from "../markdown";

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

interface TodayStatusProps {
  inToday: boolean;
  checkbox: BoardCheckbox | null;
  outOfSync: boolean;
  subtaskNames?: readonly string[];
}

export function BoardTodayStatus({ inToday, checkbox, outOfSync, subtaskNames = [] }: TodayStatusProps) {
  const badge = todayStatusBadge(inToday, checkbox, outOfSync, subtaskNames);
  if (!badge) return null;
  return (
    <span className={`chip ${badge.tone === "sync" ? "board-sync" : "board-today"}`} title={badge.title}>
      {badge.label}
    </span>
  );
}

export function BoardOutOfSyncBadge({ outOfSync }: { outOfSync: boolean }) {
  if (!outOfSync) return null;
  return (
    <span className="chip board-sync" title="The daily checkbox differs from this status">
      Out of sync with today
    </span>
  );
}

export interface BoardTodayControls {
  isLinked: (id: string) => boolean;
  isOutOfSync: (id: string) => boolean;
  dailyState: (id: string) => BoardCheckbox | null;
  addState: { visible: boolean; allowed: boolean; hint: string };
  onAdd: (task: BoardTask) => void;
}

export function BoardDoneStamp({ task }: { task: BoardTask }) {
  if (task.section !== "done") return null;
  return (
    <span className="chip board-donestamp" title="In the done section">
      {task.doneAt ? `Done ${task.doneAt}` : "Done section"}
    </span>
  );
}

interface StatusSelectProps {
  value: BoardStatus;
  label: string;
  disabled?: boolean;
  hint?: string;
  onChange: (status: BoardStatus) => void;
}

export function BoardStatusChip({ status }: { status: BoardStatus }) {
  return (
    <span className={`tag tag--board-${status}`} title={FINISHED_OCCURRENCE_HINT}>
      {BOARD_STATUS_LABEL[status]}
    </span>
  );
}

export function BoardStatusSelect({ value, label, disabled = false, hint, onChange }: StatusSelectProps) {
  return (
    <select
      className={`select board-status board-status--${value}`}
      aria-label={label}
      title={hint}
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
  readOnly?: boolean;
  onEditingChange: (editing: boolean) => void;
  onRename: (title: string) => void;
}

export function BoardTitle({ task, editing, disabled = false, readOnly = false, onEditingChange, onRename }: TitleProps) {
  if (readOnly) {
    return (
      <span className="board-title">
        <span className="board-title__text" title={FINISHED_OCCURRENCE_HINT}>
          <InlineText text={task.title} />
        </span>
      </span>
    );
  }
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
        <InlineText text={task.title} />
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
  readOnly?: boolean;
  onChange: (reason: string | null) => void;
}

export function BoardReason({ task, disabled = false, readOnly = false, onChange }: ReasonProps) {
  const [editing, setEditing] = useState(false);
  if (!supportsReason(task.status)) return null;
  if (readOnly) {
    if (task.reason === null) return null;
    return (
      <span className="board-reason">
        <span className="board-reason__text" title={FINISHED_OCCURRENCE_HINT}>
          {task.reason}
        </span>
      </span>
    );
  }
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
  hint?: string;
  onChange: (priority: number | null) => void;
}

export function BoardPrioritySelect({ value, levels, label, disabled = false, compact = false, hint, onChange }: PrioritySelectProps) {
  return (
    <select
      className={`select board-prio-select ${compact ? "board-prio-select--compact" : ""} ${value === null ? "" : `board-prio-select--${priorityTone(value, levels)}`}`}
      title={hint ?? label}
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

export function BoardPriorityField({ task, levels, disabled, readOnly = false, onChange }: { task: BoardTask; levels?: number | null; disabled: boolean; readOnly?: boolean; onChange: (priority: number | null) => void }) {
  if (readOnly) return null;
  return (
    <label className="board-field">
      <span className="muted small">Priority</span>
      <BoardPrioritySelect value={task.priority} levels={levels} label={`Priority of ${task.title}`} disabled={disabled} onChange={onChange} />
    </label>
  );
}

export function BoardDueChip({ task, today }: { task: BoardTask; today: string }) {
  const chip = dueChip(task, today);
  if (!chip) return null;
  return (
    <span className={`chip board-due board-due--${chip.tone}`} title={chip.title}>
      {chip.label}
    </span>
  );
}

export function BoardRepeatMark({ task }: { task: BoardTask }) {
  const repeat = taskDates(task).repeat;
  if (repeat === null) return null;
  return (
    <span className="board-repeat" title={`Repeats: ${repeat}`} role="img" aria-label={`Repeats: ${repeat}`}>
      <IconRepeat />
    </span>
  );
}

type DateKey = "start" | "scheduled" | "due";

const DATE_FIELDS: readonly { key: DateKey; label: string }[] = [
  { key: "start", label: "Start" },
  { key: "due", label: "Due" },
  { key: "scheduled", label: "Scheduled" },
];

interface DateFieldsProps {
  task: BoardTask;
  disabled: boolean;
  onChange: (change: BoardChange) => void;
}

function useDeferredCommit<T>(busy: boolean, onCommit: (value: T) => void): (value: T) => void {
  const latest = useRef(onCommit);
  latest.current = onCommit;
  const queued = useRef<{ value: T } | null>(null);
  useEffect(() => {
    if (busy || queued.current === null) return;
    const { value } = queued.current;
    queued.current = null;
    latest.current(value);
  }, [busy]);
  return (value: T) => {
    if (busy) queued.current = { value };
    else latest.current(value);
  };
}

interface DateInputProps {
  ariaLabel: string;
  value: string | null;
  busy?: boolean;
  className?: string;
  onCommit: (value: string | null) => void;
  onInvalidChange?: (invalid: boolean) => void;
}

export function BoardDateInput({ ariaLabel, value, busy = false, className = "in board-date__input", onCommit, onInvalidChange }: DateInputProps) {
  const [draft, setDraft] = useState(value ?? "");
  const [badInput, setBadInput] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sent = useRef<string | null | undefined>(undefined);
  const deferCommit = useDeferredCommit<string | null>(busy, onCommit);
  const outcome = resolveDateDraft(draft, value, badInput);
  const invalid = outcome.kind === "invalid";
  const hint = outcome.kind === "invalid" && (draft !== "" || attempted) ? outcome.message : null;

  useEffect(() => {
    setDraft(value ?? "");
    setBadInput(false);
    setAttempted(false);
    sent.current = undefined;
  }, [value]);

  useEffect(() => {
    onInvalidChange?.(invalid);
  }, [invalid, onInvalidChange]);

  const commit = () => {
    if (outcome.kind === "invalid") {
      setAttempted(true);
      return;
    }
    if (outcome.kind !== "commit" || sent.current === outcome.value) return;
    sent.current = outcome.value;
    deferCommit(outcome.value);
  };

  const revert = () => {
    if (inputRef.current) inputRef.current.value = value ?? "";
    setDraft(value ?? "");
    setBadInput(false);
    setAttempted(false);
    sent.current = undefined;
  };

  return (
    <>
      <input
        ref={inputRef}
        type="date"
        className={className}
        aria-label={ariaLabel}
        aria-invalid={hint !== null}
        min={`${DATE_MIN_YEAR}-01-01`}
        max={`${DATE_MAX_YEAR}-12-31`}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setBadInput(event.target.validity.badInput);
          setAttempted(false);
          sent.current = undefined;
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape" && (draft !== (value ?? "") || badInput)) {
            event.stopPropagation();
            revert();
          }
        }}
      />
      {hint !== null && (
        <span className="error small board-date__hint" role="alert">
          {hint}
        </span>
      )}
    </>
  );
}

export function BoardDatesReadOnly({ task }: { task: BoardTask }) {
  const dates = taskDates(task);
  const rows: { label: string; value: string | null }[] = [...DATE_FIELDS.map(({ key, label }) => ({ label, value: dates[key] })), { label: "Repeat", value: dates.repeat }];
  return (
    <div className="board-dates" title={FINISHED_OCCURRENCE_HINT}>
      {rows.map(({ label, value }) => (
        <div className="board-field board-date" key={label}>
          <span className="board-date__label">
            <span className="muted small">{label}</span>
            {value === null ? <span className="muted">-</span> : <span>{value}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BoardDateFields({ task, disabled, onChange }: DateFieldsProps) {
  const dates = taskDates(task);
  const choice = repeatChoice(dates.repeat);
  const [custom, setCustom] = useState(choice.custom);
  const [customMode, setCustomMode] = useState(choice.select === REPEAT_CUSTOM);
  const select = customMode ? REPEAT_CUSTOM : choice.select;
  const sentRepeat = useRef<string | null | undefined>(undefined);
  const deferRepeat = useDeferredCommit<string | null>(disabled, (next) => onChange({ repeat: next }));
  const commitCustom = () => {
    const next = repeatFromChoice(REPEAT_CUSTOM, custom);
    if (next === undefined || next === dates.repeat || sentRepeat.current === next) return;
    sentRepeat.current = next;
    deferRepeat(next);
  };
  return (
    <div className="board-dates board-dates--edit">
      {DATE_FIELDS.map(({ key, label }) => (
        <div className="board-field board-date" key={key}>
          <label className="board-date__label">
            <span className="board-date__name muted small">{label}</span>
            <BoardDateInput
              ariaLabel={`${label} date of ${task.title}`}
              value={dates[key]}
              busy={disabled}
              onCommit={(value) => onChange({ [key]: value })}
            />
          </label>
          {dates[key] !== null && (
            <button className="act act--icon board-date__clear" aria-label={`Clear ${label.toLowerCase()} date`} title={`Clear ${label.toLowerCase()} date`} disabled={disabled} onClick={() => onChange({ [key]: null })}>
              <IconClose size={12} />
            </button>
          )}
        </div>
      ))}
      <div className="board-field board-date">
        <label className="board-date__label">
          <span className="board-date__name muted small">Repeat</span>
          <select
            className="select board-repeat__select"
            aria-label={`Repeat of ${task.title}`}
            value={select}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value;
              if (value === REPEAT_CUSTOM) {
                setCustomMode(true);
                return;
              }
              setCustomMode(false);
              setCustom("");
              const next = repeatFromChoice(value, "");
              if (next !== undefined && next !== dates.repeat) onChange({ repeat: next });
            }}
          >
            <option value="">None</option>
            {REPEAT_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
            <option value={REPEAT_CUSTOM}>Custom…</option>
          </select>
        </label>
        {select === REPEAT_CUSTOM && (
          <input
            className="in board-repeat__custom"
            aria-label={`Custom repeat rule of ${task.title}`}
            placeholder="every 3 days"
            value={custom}
            autoFocus={customMode && choice.select !== REPEAT_CUSTOM}
            onChange={(event) => {
              setCustom(event.target.value);
              sentRepeat.current = undefined;
            }}
            onBlur={commitCustom}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitCustom();
              } else if (event.key === "Escape" && custom !== choice.custom) {
                event.stopPropagation();
                setCustom(choice.custom);
                sentRepeat.current = undefined;
              }
            }}
          />
        )}
      </div>
    </div>
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
  readOnly?: boolean;
  actions: BoardNoteActions;
  move?: BoardNoteMove;
}

export function BoardNoteRow({ task, note, disabled, readOnly = false, actions, move }: NoteItemProps) {
  const [editing, setEditing] = useState(false);
  if (readOnly) {
    return (
      <li className="board-note">
        <span className="board-note__text" title={FINISHED_OCCURRENCE_HINT}>
          {note.text}
        </span>
      </li>
    );
  }
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

export function BoardNotes({ task, disabled, readOnly = false, actions }: { task: BoardTask; disabled: boolean; readOnly?: boolean; actions: BoardNoteActions }) {
  if (readOnly && task.noteItems.length === 0) return null;
  return (
    <ul className="board-notes">
      {task.noteItems.map((note) => (
        <BoardNoteRow key={`${note.line}:${note.raw}`} task={task} note={note} disabled={disabled} readOnly={readOnly} actions={actions} />
      ))}
      {!readOnly && <BoardNoteAdd task={task} disabled={disabled} onAdd={actions.onAdd} />}
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
  today?: BoardTodayControls;
  finished?: ReadonlySet<string>;
}

function SubtaskRow({ task, ...shared }: Omit<SubtasksProps, "tasks"> & { task: BoardTask }) {
  const { pending, expandedIds, levels, onToggleId, onStatus, onRename, onReason, onPriority, noteActions, today, finished } = shared;
  const [editing, setEditing] = useState(false);
  const busy = pending.has(task.id);
  const locked = finished?.has(task.id) ?? false;
  const open = expandedIds.has(task.id);
  return (
    <li className="board-sub__item">
      <div className="board-sub__row">
        <BoardExpandButton title={task.title} expanded={open} onToggle={() => onToggleId(task.id)} />
        <span className={`board-sub__title ${task.status === "done" ? "board-sub__title--done" : ""}`}>
          <BoardTitle task={task} editing={editing} disabled={busy} readOnly={locked} onEditingChange={setEditing} onRename={(title) => onRename(task, title)} />
        </span>
        <BoardPriorityBadge priority={task.priority} levels={levels} />
        {locked ? (
          <BoardStatusChip status={task.status} />
        ) : (
          <BoardStatusSelect value={task.status} label={`Status of ${task.title}`} disabled={busy} onChange={(status) => onStatus(task, status)} />
        )}
        {!locked && today && !today.isLinked(task.id) && today.addState.visible && (
          <button
            className="act act--icon board-act"
            disabled={busy || !today.addState.allowed}
            title="Add this subtask to today"
            aria-label={`Add subtask ${task.title} to today`}
            onClick={() => today.onAdd(task)}
          >
            <IconCalendarPlus />
          </button>
        )}
      </div>
      {today && <BoardOutOfSyncBadge outOfSync={today.isLinked(task.id) && today.isOutOfSync(task.id)} />}
      <BoardReason task={task} disabled={busy} readOnly={locked} onChange={(reason) => onReason(task, reason)} />
      {open && <BoardPriorityField task={task} levels={levels} disabled={busy} readOnly={locked} onChange={(priority) => onPriority(task, priority)} />}
      {open && <BoardNotes task={task} disabled={busy} readOnly={locked} actions={noteActions} />}
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
