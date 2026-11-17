import { useState, type ReactNode } from "react";
import type { FocusOutlinerProps } from "../components/FocusOutliner";
import type { BoardTask } from "../delegation";
import { flattenNodes, type OutlineNode } from "../outliner-model";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function useFailure(): [string | null, (label: string, action: () => unknown) => Promise<void>] {
  const [failure, setFailure] = useState<string | null>(null);
  const call = async (label: string, action: () => unknown): Promise<void> => {
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(`${label} failed: ${messageOf(error)}`);
    }
  };
  return [failure, call];
}

function Failure({ text }: { text: string | null }): ReactNode {
  return text === null ? null : <p role="alert">{text}</p>;
}

export function FocusOutlinerStub(props: FocusOutlinerProps): ReactNode {
  const [failure, call] = useFailure();
  const nodes = flattenNodes(props.groups.flatMap((group) => group.items));
  const button = (label: string, action: () => unknown) => (
    <button key={label} type="button" onClick={() => void call(label, action)}>
      {label}
    </button>
  );
  return (
    <div data-testid="outliner" data-busy={String(props.busy ?? false)} data-today={props.today}>
      {nodes.map((node: OutlineNode) => (
        <div key={node.id} data-node={node.id}>
          <span>{node.title}</span>
          {button(`rename:${node.id}`, () => props.onRename(node, "Renamed", { priority: 2, due: "2026-12-01" }))}
          {button(`rename-same:${node.id}`, () => props.onRename(node, node.title, {}))}
          {button(`create:${node.id}`, () => props.onCreateAfter(node, "Created", { priority: 1, due: "2026-12-02" }))}
          {button(`create-plain:${node.id}`, () => props.onCreateAfter(node, "Plain", {}))}
          {button(`indent:${node.id}`, () => props.onIndent(node))}
          {button(`outdent:${node.id}`, () => props.onOutdent(node))}
          {button(`up:${node.id}`, () => props.onMove(node, "up"))}
          {button(`down:${node.id}`, () => props.onMove(node, "down"))}
          {button(`done:${node.id}`, () => props.onToggleDone(node))}
          {button(`doing:${node.id}`, () => props.onToggleDoing?.(node))}
          {button(`note:${node.id}`, () => props.onAddNote(node, "a note"))}
          {button(`open:${node.id}`, () => props.onOpen(node))}
          {button(`tomorrow:${node.id}`, () => props.onTomorrow(node))}
          {button(`unschedule:${node.id}`, () => props.onUnschedule(node))}
          {props.onPlanSubtasks !== undefined && button(`plan:${node.id}`, () => props.onPlanSubtasks?.(node))}
          <span data-plan={node.id}>{JSON.stringify(props.subtaskPlan?.(node) ?? null)}</span>
        </div>
      ))}
      {props.onAddToProject !== undefined && button("add-project", () => props.onAddToProject?.("alpha", "Typed"))}
      {button("collapse-change", () => props.onCollapseChange?.({ projects: ["alpha"], tasks: [] }))}
      <span data-testid="collapse">{JSON.stringify(props.collapse ?? null)}</span>
      <Failure text={failure} />
    </div>
  );
}

interface BacklogStubProps {
  tasks: BoardTask[];
  excluded: ReadonlySet<string>;
  inToday?: ReadonlySet<string>;
  date: string;
  nextDate: string;
  busyIds: ReadonlySet<string>;
  onSchedule: (task: BoardTask, date: string) => void;
  onDone: (task: BoardTask) => void;
  onDoing: (task: BoardTask) => void;
  onOpen: (task: BoardTask) => void;
  onDragActive: (active: boolean) => void;
}

export function BacklogPanelStub(props: BacklogStubProps): ReactNode {
  const first = props.tasks[0];
  return (
    <section aria-label="Backlog stub">
      <span data-testid="backlog-info">{`${props.tasks.length}|${[...props.excluded].join(",")}|${[...(props.inToday ?? [])].join(",")}|${props.date}|${[...props.busyIds].join(",")}`}</span>
      {first !== undefined && (
        <>
          <button type="button" onClick={() => props.onSchedule(first, props.date)}>
            backlog-schedule
          </button>
          <button type="button" onClick={() => props.onSchedule(first, props.nextDate)}>
            backlog-tomorrow
          </button>
          <button type="button" onClick={() => props.onDone(first)}>
            backlog-done
          </button>
          <button type="button" onClick={() => props.onDoing(first)}>
            backlog-doing
          </button>
          <button type="button" onClick={() => props.onOpen(first)}>
            backlog-open
          </button>
        </>
      )}
      <button type="button" onClick={() => props.onDragActive(true)}>
        backlog-drag-on
      </button>
      <button type="button" onClick={() => props.onDragActive(false)}>
        backlog-drag-off
      </button>
    </section>
  );
}

interface StartStubProps {
  noteExists: boolean;
  data: { carriedOver: { task: BoardTask }[] };
  onBring: (task: BoardTask) => void;
  onTomorrow: (task: BoardTask) => void;
  onDrop: (task: BoardTask) => void;
  onBringAll: () => void;
  onOpenTask: (task: BoardTask) => void;
  onCreated: () => Promise<void>;
  onRefine: () => void;
  onClassic: () => void;
  onClose: () => void;
  onError: (text: string) => void;
}

export function StartDayPanelStub(props: StartStubProps): ReactNode {
  const task = props.data.carriedOver[0]?.task;
  return (
    <section aria-label="Start stub" data-note-exists={String(props.noteExists)}>
      {task !== undefined && (
        <>
          <button type="button" onClick={() => props.onBring(task)}>
            start-bring
          </button>
          <button type="button" onClick={() => props.onTomorrow(task)}>
            start-tomorrow
          </button>
          <button type="button" onClick={() => props.onDrop(task)}>
            start-drop
          </button>
          <button type="button" onClick={() => props.onOpenTask(task)}>
            start-open
          </button>
        </>
      )}
      <button type="button" onClick={props.onBringAll}>
        start-bring-all
      </button>
      <button type="button" onClick={() => void props.onCreated()}>
        start-created
      </button>
      <button type="button" onClick={props.onRefine}>
        start-refine
      </button>
      <button type="button" onClick={props.onClassic}>
        start-classic
      </button>
      <button type="button" onClick={props.onClose}>
        start-close
      </button>
      <button type="button" onClick={() => props.onError("start error")}>
        start-error
      </button>
    </section>
  );
}

export function DaySummaryDialogStub(props: { date: string; onClose: () => void; onNotice: (text: string) => void }): ReactNode {
  return (
    <div role="dialog" aria-label="Summary stub">
      <span>{`summary-for:${props.date}`}</span>
      <button type="button" onClick={() => props.onNotice("summary noted")}>
        summary-notice
      </button>
      <button type="button" onClick={props.onClose}>
        summary-close
      </button>
    </div>
  );
}

export function SubtaskPickerStub(props: { date: string; target: { projectId: string; line: number; title: string }; onClose: () => void; onChanged: () => void }): ReactNode {
  return (
    <div role="dialog" aria-label="Picker stub">
      <span>{`picker:${props.date}:${props.target.projectId}:${props.target.line}:${props.target.title}`}</span>
      <button type="button" onClick={props.onChanged}>
        picker-changed
      </button>
      <button type="button" onClick={props.onClose}>
        picker-close
      </button>
    </div>
  );
}

interface DrawerStubProps {
  task: BoardTask;
  pending: ReadonlySet<string>;
  organizing: boolean;
  suspended: boolean;
  inToday: boolean;
  breadcrumb: string;
  levels?: number;
  addState: { visible: boolean; allowed: boolean; hint: string };
  today: { isLinked: (id: string) => boolean; isOutOfSync: (id: string) => boolean; dailyState: (id: string) => unknown; onAdd: (task: BoardTask) => void };
  noteActions: {
    onAdd: (owner: BoardTask, text: string) => Promise<boolean>;
    onEdit: (owner: BoardTask, note: { line: number; raw: string; text: string }, text: string) => void;
    onDelete: (owner: BoardTask, note: { line: number; raw: string; text: string }) => void;
  };
  organize: {
    onMove: (task: BoardTask, direction: "up" | "down") => void;
    onMoveNote: (owner: BoardTask, note: { line: number; raw: string; text: string }, direction: "up" | "down") => void;
    onPromote: (task: BoardTask) => void;
    onMakeSubtask: (task: BoardTask) => void;
    onMoveToProject: (task: BoardTask) => void;
  };
  onStatus: (task: BoardTask, status: BoardTask["status"]) => void;
  onRename: (task: BoardTask, title: string) => void;
  onReason: (task: BoardTask, reason: string | null) => void;
  onPriority: (task: BoardTask, priority: number | null) => void;
  onDates: (task: BoardTask, change: { due?: string | null }) => void;
  onDelegate: (task: BoardTask) => void;
  onAddSubtask: (task: BoardTask) => void;
  onAddToday: (task: BoardTask) => void;
  onOpenObsidian: (project: { id: string; path: string }) => void;
  onOpenEditor: (project: { id: string; path: string }) => void;
  onClose: () => void;
  project: { id: string; path: string } | null;
}

export function BoardDrawerStub(props: DrawerStubProps): ReactNode {
  const { task } = props;
  const note = { line: 40, raw: "  - old note", text: "old note" };
  const [outcome, setOutcome] = useState("");
  const button = (label: string, action: () => unknown) => (
    <button type="button" onClick={() => void action()}>
      {label}
    </button>
  );
  return (
    <aside aria-label="Drawer stub">
      <span data-testid="drawer-task">{task.id}</span>
      <span data-testid="drawer-flags">{`${props.inToday}|${props.today.isLinked(task.id)}|${props.today.isOutOfSync(task.id)}|${String(props.today.dailyState(task.id))}|${props.suspended}|${props.organizing}|${props.pending.has(task.id)}|${props.addState.hint}|${props.breadcrumb}|${props.levels ?? ""}`}</span>
      <span data-testid="drawer-outcome">{outcome}</span>
      {button("drawer-status-done", () => props.onStatus(task, "done"))}
      {button("drawer-status-same", () => props.onStatus(task, task.status))}
      {button("drawer-rename", () => props.onRename(task, "Renamed task"))}
      {button("drawer-rename-same", () => props.onRename(task, task.title))}
      {button("drawer-reason", () => props.onReason(task, "because"))}
      {button("drawer-priority", () => props.onPriority(task, 2))}
      {button("drawer-priority-same", () => props.onPriority(task, task.priority))}
      {button("drawer-dates", () => props.onDates(task, { due: "2026-12-01" }))}
      {button("drawer-delegate", () => props.onDelegate(task))}
      {button("drawer-add-subtask", () => props.onAddSubtask(task))}
      {button("drawer-add-today", () => props.onAddToday(task))}
      {button("drawer-today-add", () => props.today.onAdd(task))}
      {button("drawer-obsidian", () => props.project !== null && props.onOpenObsidian(props.project))}
      {button("drawer-editor", () => props.project !== null && props.onOpenEditor(props.project))}
      {button("drawer-note-add", async () => setOutcome(String(await props.noteActions.onAdd(task, "  a fresh note  "))))}
      {button("drawer-note-add-bad", async () => setOutcome(String(await props.noteActions.onAdd(task, "   "))))}
      {button("drawer-note-edit", () => props.noteActions.onEdit(task, note, " edited "))}
      {button("drawer-note-edit-bad", () => props.noteActions.onEdit(task, note, ""))}
      {button("drawer-note-delete", () => props.noteActions.onDelete(task, note))}
      {button("drawer-move-up", () => props.organize.onMove(task, "up"))}
      {button("drawer-move-note", () => props.organize.onMoveNote(task, note, "down"))}
      {button("drawer-promote", () => props.organize.onPromote(task))}
      {button("drawer-make-subtask", () => props.organize.onMakeSubtask(task))}
      {button("drawer-move-project", () => props.organize.onMoveToProject(task))}
      {button("drawer-close", () => props.onClose())}
    </aside>
  );
}

export function ParentPickerStub(props: { task: BoardTask; candidates: { task: BoardTask }[]; busy: boolean; onCancel: () => void; onSubmit: (parent: BoardTask) => void }): ReactNode {
  return (
    <div role="dialog" aria-label="Parent picker stub">
      <span>{`parent-candidates:${props.candidates.map((candidate) => candidate.task.id).join(",")}`}</span>
      <button type="button" onClick={() => props.onSubmit(props.candidates[0]?.task ?? props.task)}>
        parent-pick
      </button>
      <button type="button" onClick={props.onCancel}>
        parent-cancel
      </button>
    </div>
  );
}

export function MoveProjectStub(props: { task: BoardTask; projects: { id: string }[]; busy: boolean; onCancel: () => void; onSubmit: (projectId: string, parent: BoardTask | null) => void }): ReactNode {
  return (
    <div role="dialog" aria-label="Move picker stub">
      <span>{`move-projects:${props.projects.map((project) => project.id).join(",")}`}</span>
      <button type="button" onClick={() => props.onSubmit("beta", null)}>
        move-pick-root
      </button>
      <button type="button" onClick={() => props.onSubmit("beta", props.task)}>
        move-pick-parent
      </button>
      <button type="button" onClick={props.onCancel}>
        move-cancel
      </button>
    </div>
  );
}

interface NewTaskStubProps {
  defaultProjectId: string;
  parent: BoardTask;
  onCancel: () => void;
  onSubmit: (body: { projectId: string; title: string; parentLine?: number; parentRaw?: string }) => Promise<void>;
}

export function NewTaskDialogStub(props: NewTaskStubProps): ReactNode {
  const [failure, call] = useFailure();
  return (
    <div role="dialog" aria-label="New task stub">
      <span>{`new-task:${props.defaultProjectId}:${props.parent.id}`}</span>
      <button type="button" onClick={() => void call("create", () => props.onSubmit({ projectId: props.defaultProjectId, title: "New sub", parentLine: props.parent.line, parentRaw: props.parent.raw }))}>
        create-submit
      </button>
      <button type="button" onClick={props.onCancel}>
        create-cancel
      </button>
      <Failure text={failure} />
    </div>
  );
}

interface DelegateStubProps {
  task: BoardTask;
  notice: string | null;
  taskMissing: boolean;
  onCancel: () => void;
  onSubmit: (request: { workspace: string; prompt: string; runner: "claude" | "codex"; repo?: string }) => Promise<void>;
}

export function DelegateDialogStub(props: DelegateStubProps): ReactNode {
  const [failure, call] = useFailure();
  return (
    <div role="dialog" aria-label="Delegate stub">
      <span>{`delegate:${props.task.id}`}</span>
      <span data-testid="delegate-notice">{`${props.notice ?? ""}|${props.taskMissing}`}</span>
      <button type="button" onClick={() => void call("delegate", () => props.onSubmit({ workspace: "ws", prompt: "do it", runner: "claude", repo: "repo-a" }))}>
        delegate-submit
      </button>
      <button type="button" onClick={() => void call("delegate", () => props.onSubmit({ workspace: "ws", prompt: "do it", runner: "codex" }))}>
        delegate-submit-norepo
      </button>
      <button type="button" onClick={props.onCancel}>
        delegate-cancel
      </button>
      <Failure text={failure} />
    </div>
  );
}

export interface DailyViewStubState {
  entry: { exists: boolean; path: string | null };
  sessions: { sessionId: string; title: string | null; client: string | null; status: string }[];
}
