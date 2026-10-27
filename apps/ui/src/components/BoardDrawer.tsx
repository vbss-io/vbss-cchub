import { useEffect, useRef, useState } from "react";
import { FINISHED_OCCURRENCE_HINT, isSubtask, noteMoveAvailability, orderedChildren, taskMenuEntries, taskMoveAvailability, type MoveDirection } from "../board-model";
import type { BoardChange, BoardCheckbox, BoardNoteItem, BoardProject, BoardStatus, BoardTask } from "../delegation";
import { IconClose, IconExpand, IconRun } from "../icons";
import { BoardActionsMenu, type BoardMenuItem } from "./BoardActionsMenu";
import {
  BoardDateFields,
  BoardDatesReadOnly,
  BoardDoneStamp,
  BoardNoteAdd,
  BoardNoteRow,
  BoardOutOfSyncBadge,
  BoardPrioritySelect,
  BoardPriorityBadge,
  BoardReason,
  BoardStatusChip,
  BoardStatusSelect,
  BoardTitle,
  BoardTodayBadge,
  type BoardNoteActions,
  type BoardTodayControls,
} from "./BoardParts";

export interface BoardOrganizeActions {
  onMove: (task: BoardTask, direction: MoveDirection) => void;
  onMoveNote: (owner: BoardTask, note: BoardNoteItem, direction: MoveDirection) => void;
  onPromote: (task: BoardTask) => void;
  onMakeSubtask: (task: BoardTask) => void;
  onMoveToProject: (task: BoardTask) => void;
}

export interface BoardTodayAdd {
  visible: boolean;
  allowed: boolean;
  hint: string;
}

interface TreeContext {
  tasks: BoardTask[];
  pending: ReadonlySet<string>;
  organizing: boolean;
  levels?: number | null;
  noteActions: BoardNoteActions;
  organize: BoardOrganizeActions;
  onStatus: (task: BoardTask, status: BoardStatus) => void;
  onRename: (task: BoardTask, title: string) => void;
  onReason: (task: BoardTask, reason: string | null) => void;
  onPriority: (task: BoardTask, priority: number | null) => void;
  today: BoardTodayControls;
  finished: ReadonlySet<string>;
  onSyncDaily: (task: BoardTask) => void;
  onUseDaily: (task: BoardTask) => void;
}

function todayMenuItems(task: BoardTask, context: TreeContext, disabled: boolean): BoardMenuItem[] {
  const entries = taskMenuEntries(task, {
    levels: context.levels,
    addState: context.today.addState,
    inToday: context.today.isLinked(task.id),
    outOfSync: context.today.isOutOfSync(task.id),
    dailyState: context.today.dailyState(task.id),
    subtask: true,
  });
  const items: BoardMenuItem[] = [];
  for (const entry of entries) {
    const base = { id: entry.id, label: entry.label, title: entry.title, disabled: disabled || entry.disabled };
    if (entry.action.type === "today") items.push({ ...base, onSelect: () => context.today.onAdd(task) });
    else if (entry.action.type === "sync-daily") items.push({ ...base, onSelect: () => context.onSyncDaily(task) });
    else if (entry.action.type === "use-daily") items.push({ ...base, onSelect: () => context.onUseDaily(task) });
  }
  return items;
}

export function organizeMenuItems(tasks: BoardTask[], task: BoardTask, organize: BoardOrganizeActions, disabled: boolean): BoardMenuItem[] {
  const availability = taskMoveAvailability(tasks, task);
  const items: BoardMenuItem[] = [
    {
      id: "up",
      label: "Move up",
      title: availability.up ? undefined : "Already first",
      disabled: disabled || !availability.up,
      onSelect: () => organize.onMove(task, "up"),
    },
    {
      id: "down",
      label: "Move down",
      title: availability.down ? undefined : "Already last",
      disabled: disabled || !availability.down,
      onSelect: () => organize.onMove(task, "down"),
    },
  ];
  if (isSubtask(tasks, task)) items.push({ id: "promote", label: "Promote to task", disabled, onSelect: () => organize.onPromote(task) });
  items.push(
    { id: "subtask", label: "Make subtask of...", disabled, onSelect: () => organize.onMakeSubtask(task) },
    { id: "project", label: "Move to project...", disabled, onSelect: () => organize.onMoveToProject(task) },
  );
  return items;
}

function DrawerItems({ owner, context }: { owner: BoardTask; context: TreeContext }) {
  const busy = context.pending.has(owner.id) || context.organizing;
  const locked = context.finished.has(owner.id);
  return (
    <ul className="board-tree">
      {orderedChildren(owner).map((item) =>
        item.kind === "note" ? (
          <BoardNoteRow
            key={`note:${item.note.line}:${item.note.raw}`}
            task={owner}
            note={item.note}
            disabled={busy}
            readOnly={locked}
            actions={context.noteActions}
            move={{
              availability: noteMoveAvailability(owner, item.note),
              onMove: (direction) => context.organize.onMoveNote(owner, item.note, direction),
            }}
          />
        ) : (
          <DrawerNode key={item.task.id} task={item.task} context={context} />
        ),
      )}
      {!locked && <BoardNoteAdd task={owner} disabled={busy} onAdd={context.noteActions.onAdd} />}
    </ul>
  );
}

function DrawerNode({ task, context }: { task: BoardTask; context: TreeContext }) {
  const [editing, setEditing] = useState(false);
  const busy = context.pending.has(task.id) || context.organizing;
  const locked = context.finished.has(task.id);
  return (
    <li className="board-tree__task">
      <div className="board-sub__row">
        <span className={`board-sub__title ${task.status === "done" ? "board-sub__title--done" : ""}`}>
          <BoardTitle task={task} editing={editing} disabled={busy} readOnly={locked} onEditingChange={setEditing} onRename={(title) => context.onRename(task, title)} />
        </span>
        {locked ? (
          <>
            <BoardStatusChip status={task.status} />
            <BoardPriorityBadge priority={task.priority} levels={context.levels} />
          </>
        ) : (
          <>
            <BoardStatusSelect value={task.status} label={`Status of ${task.title}`} disabled={busy} onChange={(status) => context.onStatus(task, status)} />
            <BoardPrioritySelect
              value={task.priority}
              levels={context.levels}
              label={`Priority of ${task.title}`}
              disabled={busy}
              compact
              onChange={(priority) => context.onPriority(task, priority)}
            />
            <BoardActionsMenu
              label={`Actions for ${task.title}`}
              disabled={busy}
              items={[...organizeMenuItems(context.tasks, task, context.organize, busy), ...todayMenuItems(task, context, busy)]}
            />
          </>
        )}
      </div>
      <BoardOutOfSyncBadge outOfSync={!locked && context.today.isLinked(task.id) && context.today.isOutOfSync(task.id)} />
      <BoardReason task={task} disabled={busy} readOnly={locked} onChange={(reason) => context.onReason(task, reason)} />
      <DrawerItems owner={task} context={context} />
    </li>
  );
}

interface Props {
  task: BoardTask;
  tasks: BoardTask[];
  project: BoardProject | null;
  breadcrumb: string;
  pending: ReadonlySet<string>;
  organizing: boolean;
  suspended: boolean;
  levels?: number | null;
  inToday: boolean;
  todayCheckbox: BoardCheckbox | null;
  addState: BoardTodayAdd;
  today: BoardTodayControls;
  finished: ReadonlySet<string>;
  onSyncDaily: (task: BoardTask) => void;
  onUseDaily: (task: BoardTask) => void;
  noteActions: BoardNoteActions;
  organize: BoardOrganizeActions;
  onStatus: (task: BoardTask, status: BoardStatus) => void;
  onRename: (task: BoardTask, title: string) => void;
  onReason: (task: BoardTask, reason: string | null) => void;
  onPriority: (task: BoardTask, priority: number | null) => void;
  onDates: (task: BoardTask, change: BoardChange) => void;
  onDelegate: (task: BoardTask) => void;
  onAddSubtask: (task: BoardTask) => void;
  onAddToday: (task: BoardTask) => void;
  onOpenObsidian: (project: BoardProject) => void;
  onOpenEditor: (project: BoardProject) => void;
  onClose: () => void;
}

export function BoardDrawer(props: Props) {
  const { task, tasks, project, breadcrumb, pending, organizing, suspended, inToday, addState, onClose } = props;
  const [full, setFull] = useState(false);
  const [editing, setEditing] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const busy = pending.has(task.id) || organizing;
  const outOfSync = inToday && props.today.isOutOfSync(task.id);
  const dailyState = props.today.dailyState(task.id);

  useEffect(() => {
    panelRef.current?.focus();
    return () => {
      const previous = opener.current;
      if (previous && previous.isConnected && (document.activeElement === document.body || document.activeElement === null)) previous.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || suspended) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (full) setFull(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, full, suspended]);

  useEffect(() => {
    if (full || suspended) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || !panelRef.current || panelRef.current.contains(target)) return;
      if (target.closest(".modal__overlay, .toasts")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [full, suspended, onClose]);

  const context: TreeContext = {
    tasks,
    pending,
    organizing,
    levels: props.levels,
    noteActions: props.noteActions,
    organize: props.organize,
    onStatus: props.onStatus,
    onRename: props.onRename,
    onReason: props.onReason,
    onPriority: props.onPriority,
    today: props.today,
    finished: props.finished,
    onSyncDaily: props.onSyncDaily,
    onUseDaily: props.onUseDaily,
  };
  const locked = props.finished.has(task.id);

  return (
    <>
      {full && <div className="drawer__backdrop" onClick={() => setFull(false)} />}
      <aside ref={panelRef} tabIndex={-1} className={`drawer board-drawer ${full ? "drawer--full" : ""}`} role="dialog" aria-label={`Details of ${task.title}`}>
        <header className="drawer__header board-drawer__header">
          <div className="drawer__title">
            <div className="drawer__name">
              <button
                className="act act--icon drawer__expand"
                onClick={() => setFull((value) => !value)}
                aria-label={full ? "Back to the side panel" : "Open in a large view"}
                title={full ? "Back to the side panel" : "Open in a large view"}
              >
                <IconExpand />
              </button>
              <h2 title={task.title}>
                <BoardTitle task={task} editing={editing} disabled={busy} readOnly={locked} onEditingChange={setEditing} onRename={(title) => props.onRename(task, title)} />
              </h2>
            </div>
            <p className="board-drawer__where small">
              <span className="muted">{breadcrumb}</span>
              {project && (
                <span className="path board-drawer__path" title={project.path}>
                  {project.path}
                </span>
              )}
            </p>
            {locked && (
              <p className="board-drawer__locked muted small" title={FINISHED_OCCURRENCE_HINT}>
                {FINISHED_OCCURRENCE_HINT}
              </p>
            )}
            <div className="board-drawer__fields">
              {locked ? (
                <>
                  <BoardStatusChip status={task.status} />
                  <BoardPriorityBadge priority={task.priority} levels={props.levels} />
                </>
              ) : (
                <>
                  <BoardStatusSelect value={task.status} label={`Status of ${task.title}`} disabled={busy} onChange={(status) => props.onStatus(task, status)} />
                  <BoardPrioritySelect
                    value={task.priority}
                    levels={props.levels}
                    label={`Priority of ${task.title}`}
                    disabled={busy}
                    compact
                    onChange={(priority) => props.onPriority(task, priority)}
                  />
                </>
              )}
            </div>
            {locked ? (
              <BoardDatesReadOnly task={task} />
            ) : (
              <BoardDateFields key={`${task.id}:${task.repeat ?? ""}`} task={task} disabled={busy} onChange={(change) => props.onDates(task, change)} />
            )}
            <BoardReason task={task} disabled={busy} readOnly={locked} onChange={(reason) => props.onReason(task, reason)} />
            <div className="board-drawer__buttons">
              {!locked && (
                <button className="act" disabled={busy} onClick={() => props.onDelegate(task)}>
                  <IconRun /> Delegate
                </button>
              )}
              {!locked && !inToday && addState.visible && (
                <button className="act" disabled={busy || !addState.allowed} title={addState.hint} onClick={() => props.onAddToday(task)}>
                  {isSubtask(tasks, task) ? "Add this subtask to today" : "Add to today"}
                </button>
              )}
              {project && (
                <button className="act" title="Open the project note in Obsidian" onClick={() => props.onOpenObsidian(project)}>
                  Open in Obsidian
                </button>
              )}
              {project && (
                <button className="act" title="Open the project note in the configured editor" onClick={() => props.onOpenEditor(project)}>
                  Open in editor
                </button>
              )}
              {!locked && <BoardActionsMenu label={`Actions for ${task.title}`} disabled={busy} items={organizeMenuItems(tasks, task, props.organize, busy)} />}
            </div>
          </div>
          <div className="drawer__actions">
            <button className="act act--icon" onClick={onClose} aria-label="Close details">
              <IconClose />
            </button>
          </div>
        </header>

        <div className="drawer__body">
          <dl className="details board-drawer__facts">
            <dt>Group</dt>
            <dd>{task.group ? <span className="chip">{task.group}</span> : <span className="muted">-</span>}</dd>
            <dt>Today</dt>
            <dd>
              {inToday ? (
                <span className="board-drawer__today">
                  <BoardTodayBadge inToday checkbox={props.todayCheckbox} />
                  <BoardOutOfSyncBadge outOfSync={outOfSync} />
                  {outOfSync && (
                    <>
                      <button className="act" disabled={busy} title="Write this status into today's daily" onClick={() => props.onSyncDaily(task)}>
                        Sync to daily
                      </button>
                      {dailyState !== null && (
                        <button className="act" disabled={busy} title="Set this task from today's daily checkbox" onClick={() => props.onUseDaily(task)}>
                          Use daily
                        </button>
                      )}
                    </>
                  )}
                </span>
              ) : (
                <span className="muted">Not linked in today's daily</span>
              )}
            </dd>
            <dt>Section</dt>
            <dd>{task.section === "done" ? <BoardDoneStamp task={task} /> : <span>Open</span>}</dd>
          </dl>
          <section className="board-drawer__tree" aria-label="Notes and subtasks">
            <h3 className="board-drawer__heading">Notes and subtasks</h3>
            <DrawerItems owner={task} context={context} />
          </section>
          {!locked && (
            <div className="frow">
              <button className="act" disabled={busy} onClick={() => props.onAddSubtask(task)}>
                Add subtask
              </button>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
