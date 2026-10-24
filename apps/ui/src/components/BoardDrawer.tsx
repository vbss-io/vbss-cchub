import { useEffect, useRef, useState } from "react";
import { isSubtask, noteMoveAvailability, orderedChildren, taskMoveAvailability, type MoveDirection } from "../board-model";
import type { BoardCheckbox, BoardNoteItem, BoardProject, BoardStatus, BoardTask } from "../delegation";
import { IconClose, IconExpand, IconRun } from "../icons";
import { BoardActionsMenu, type BoardMenuItem } from "./BoardActionsMenu";
import {
  BoardDoneStamp,
  BoardNoteAdd,
  BoardNoteRow,
  BoardPrioritySelect,
  BoardReason,
  BoardStatusSelect,
  BoardTitle,
  BoardTodayBadge,
  type BoardNoteActions,
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
  return (
    <ul className="board-tree">
      {orderedChildren(owner).map((item) =>
        item.kind === "note" ? (
          <BoardNoteRow
            key={`note:${item.note.line}:${item.note.raw}`}
            task={owner}
            note={item.note}
            disabled={busy}
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
      <BoardNoteAdd task={owner} disabled={busy} onAdd={context.noteActions.onAdd} />
    </ul>
  );
}

function DrawerNode({ task, context }: { task: BoardTask; context: TreeContext }) {
  const [editing, setEditing] = useState(false);
  const busy = context.pending.has(task.id) || context.organizing;
  return (
    <li className="board-tree__task">
      <div className="board-sub__row">
        <span className={`board-sub__title ${task.status === "done" ? "board-sub__title--done" : ""}`}>
          <BoardTitle task={task} editing={editing} disabled={busy} onEditingChange={setEditing} onRename={(title) => context.onRename(task, title)} />
        </span>
        <BoardStatusSelect value={task.status} label={`Status of ${task.title}`} disabled={busy} onChange={(status) => context.onStatus(task, status)} />
        <BoardPrioritySelect
          value={task.priority}
          levels={context.levels}
          label={`Priority of ${task.title}`}
          disabled={busy}
          compact
          onChange={(priority) => context.onPriority(task, priority)}
        />
        <BoardActionsMenu label={`Actions for ${task.title}`} disabled={busy} items={organizeMenuItems(context.tasks, task, context.organize, busy)} />
      </div>
      <BoardReason task={task} disabled={busy} onChange={(reason) => context.onReason(task, reason)} />
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
  noteActions: BoardNoteActions;
  organize: BoardOrganizeActions;
  onStatus: (task: BoardTask, status: BoardStatus) => void;
  onRename: (task: BoardTask, title: string) => void;
  onReason: (task: BoardTask, reason: string | null) => void;
  onPriority: (task: BoardTask, priority: number | null) => void;
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
  };

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
                <BoardTitle task={task} editing={editing} disabled={busy} onEditingChange={setEditing} onRename={(title) => props.onRename(task, title)} />
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
            <div className="board-drawer__fields">
              <BoardStatusSelect value={task.status} label={`Status of ${task.title}`} disabled={busy} onChange={(status) => props.onStatus(task, status)} />
              <BoardPrioritySelect
                value={task.priority}
                levels={props.levels}
                label={`Priority of ${task.title}`}
                disabled={busy}
                compact
                onChange={(priority) => props.onPriority(task, priority)}
              />
            </div>
            <BoardReason task={task} disabled={busy} onChange={(reason) => props.onReason(task, reason)} />
            <div className="board-drawer__buttons">
              <button className="act" disabled={busy} onClick={() => props.onDelegate(task)}>
                <IconRun /> Delegate
              </button>
              {!inToday && addState.visible && (
                <button className="act" disabled={busy || !addState.allowed} title={addState.hint} onClick={() => props.onAddToday(task)}>
                  Add to today
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
              <BoardActionsMenu label={`Actions for ${task.title}`} disabled={busy} items={organizeMenuItems(tasks, task, props.organize, busy)} />
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
            <dd>{inToday ? <BoardTodayBadge inToday checkbox={props.todayCheckbox} /> : <span className="muted">Not linked in today's daily</span>}</dd>
            <dt>Section</dt>
            <dd>{task.section === "done" ? <BoardDoneStamp task={task} /> : <span>Open</span>}</dd>
          </dl>
          <section className="board-drawer__tree" aria-label="Notes and subtasks">
            <h3 className="board-drawer__heading">Notes and subtasks</h3>
            <DrawerItems owner={task} context={context} />
          </section>
          <div className="frow">
            <button className="act" disabled={busy} onClick={() => props.onAddSubtask(task)}>
              Add subtask
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
