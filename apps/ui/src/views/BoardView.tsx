import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DailyStreamEvent, TasksBoardStreamEvent } from "../api";
import {
  activeFilterNotes,
  activeStatuses,
  allExpanded,
  BOARD_STATUSES,
  BOARD_STATUS_LABEL,
  capDoneSection,
  DEFAULT_BOARD_PREFS,
  DONE_SECTION_PAGE,
  doneColumnView,
  effectiveProjectOrder,
  emptyResultsMessage,
  expandableIds,
  filterBoardTasks,
  findBoardTask,
  groupByStatus,
  groupTasksByProject,
  isLinkedToday,
  isOutOfSync,
  isSubtask,
  addToTodayNotice,
  supportsReason,
  taskMenuEntries,
  hasCustomFilters,
  hasDefaultStatuses,
  kanbanColumns,
  nextTableSort,
  parseBoardPrefs,
  priorityFilterLevels,
  priorityFilterSummary,
  priorityLabel,
  projectBreadcrumb,
  projectOptions,
  remapExpanded,
  replaceBoardTask,
  resetFilterPrefs,
  sortByPriority,
  statusFilterSummary,
  sortTableTasks,
  subtaskProgress,
  sweepTargets,
  todayAddState,
  todayAvailability,
  todayHint,
  todayIdSet,
  todayMissingHint,
  toggleHiddenPriority,
  validateNoteText,
  viewSummary,
  visibleKanbanColumns,
  findTaskAfterRefetch,
  formatDayMonth,
  moveTargetProjects,
  obsidianUrl,
  organizeFocus,
  parentCandidates,
  recurrenceNotice,
  remapTaskId,
  subtaskMismatches,
  finishedOccurrenceIds,
  FINISHED_OCCURRENCE_HINT,
  TIMELINE_ZOOMS,
  type BoardPrefs,
  type BoardViewMode,
  type TableSortKey,
  type TaskMenuAction,
  type TimelineZoom,
} from "../board-model";
import { BoardDelegateDialog, type BoardDelegateRequest } from "../components/BoardDelegateDialog";
import { BoardActionsMenu, type BoardMenuItem } from "../components/BoardActionsMenu";
import { BoardDrawer, type BoardOrganizeActions } from "../components/BoardDrawer";
import { BoardNewTaskDialog } from "../components/BoardNewTaskDialog";
import { BoardTimeline } from "../components/BoardTimeline";
import { BoardMoveProjectDialog, BoardParentPickerDialog } from "../components/BoardOrganizeDialogs";
import {
  BoardDoneStamp,
  BoardDueChip,
  BoardExpandButton,
  BoardNotes,
  BoardPriorityBadge,
  BoardRepeatMark,
  BoardSubtasks,
  BoardTodayStatus,
  type BoardNoteActions,
  type BoardTodayControls,
} from "../components/BoardParts";
import {
  addBoardNote,
  addBoardTaskToDaily,
  BoardConflictError,
  createBoardItem,
  delegateBoardTask,
  deleteBoardNote,
  editBoardNote,
  getTasksBoard,
  moveBoardItem,
  moveBoardTaskToProject,
  patchBoardItem,
  reparentBoardTask,
  sweepBoardDone,
  syncBoardTaskToDaily,
  openBoardProjectInEditor,
  type BoardChange,
  type BoardCheckbox,
  type BoardCreateInput,
  type BoardPayload,
  type BoardProject,
  type BoardStatus,
  type BoardTarget,
  type BoardTask,
  type DelegationSettings,
  type WorkspaceRecord,
} from "../delegation";
import { IconChevron, IconSearch } from "../icons";
import { MultiSelectDropdown, type MultiSelectOption } from "../components/MultiSelectDropdown";
import { InlineText } from "../markdown";
import { openExternal } from "../notify";
import { localDayKey, ZOOM_LABEL } from "../timeline-model";

const PREFS_KEY = "hub.board.prefs";
const REFRESH_DELAY_MS = 200;

const DELEGATE_CHANGED_NOTICE = "This task changed on disk - review and send again";
const DELEGATE_MISSING_NOTICE = "This task no longer exists on disk - close this dialog and pick another task";

function flattenBoardTasks(tasks: BoardTask[]): BoardTask[] {
  return tasks.flatMap((task) => [task, ...flattenBoardTasks(task.subtasks)]);
}

function rebindDelegateTask(tasks: BoardTask[], target: BoardTask, current: BoardTask | null): BoardTask | null {
  const sameProject = flattenBoardTasks(tasks).filter((task) => task.projectId === target.projectId);
  const byTitle = sameProject.filter((task) => task.title === target.title);
  const nearest = [...byTitle].sort((a, b) => Math.abs(a.line - target.line) - Math.abs(b.line - target.line))[0];
  if (nearest) return nearest;
  return current ?? null;
}

const ALREADY_IN_DAILY = "already in the daily";

const CARD_CONTROLS = "button, input, select, textarea, a, label, .board-details";

const targetOf = (task: BoardTask): BoardTarget => ({ projectId: task.projectId, line: task.line, raw: task.raw });

interface Props {
  workspaces: WorkspaceRecord[];
  settings: DelegationSettings | null;
  subscribeBoard: (listener: (event: TasksBoardStreamEvent) => void) => () => void;
  subscribeDaily: (listener: (event: DailyStreamEvent) => void) => () => void;
  onOpenSettings: () => void;
  onDelegated: (taskId: string, title: string) => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}

function readPrefs(): BoardPrefs {
  try {
    return parseBoardPrefs(window.localStorage.getItem(PREFS_KEY));
  } catch {
    return DEFAULT_BOARD_PREFS;
  }
}

function writePrefs(prefs: BoardPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    return;
  }
}

interface ItemProps {
  task: BoardTask;
  breadcrumb: string;
  pending: ReadonlySet<string>;
  expanded: boolean;
  expandedIds: ReadonlySet<string>;
  onToggle: () => void;
  onToggleId: (id: string) => void;
  onStatus: (task: BoardTask, status: BoardStatus) => void;
  onRename: (task: BoardTask, title: string) => void;
  onReason: (task: BoardTask, reason: string | null) => void;
  onPriority: (task: BoardTask, priority: number | null) => void;
  noteActions: BoardNoteActions;
  levels?: number | null;
  onDelegate: (task: BoardTask) => void;
  onAddSubtask: (task: BoardTask) => void;
  todayCheckbox: BoardCheckbox | null;
  todayKey: string;
  inToday: boolean;
  outOfSync: boolean;
  subtaskSync: string[];
  addState: { visible: boolean; allowed: boolean; hint: string };
  today: BoardTodayControls;
  onAddToday: (task: BoardTask) => void;
  onSyncDaily: (task: BoardTask) => void;
  onUseDaily: (task: BoardTask) => void;
  onOpenDetails: (task: BoardTask) => void;
  finished: boolean;
  finishedIds: ReadonlySet<string>;
}

type TaskMenuProps = Pick<
  ItemProps,
  "pending" | "levels" | "addState" | "inToday" | "outOfSync" | "subtaskSync" | "todayCheckbox" | "onStatus" | "onPriority" | "onAddToday" | "onSyncDaily" | "onUseDaily" | "onDelegate" | "onOpenDetails" | "finished"
>;

function TaskMenu({ task, ...props }: TaskMenuProps & { task: BoardTask }) {
  const busy = props.pending.has(task.id);
  const run = (action: TaskMenuAction) => {
    if (action.type === "status") props.onStatus(task, action.status);
    else if (action.type === "priority") props.onPriority(task, action.priority);
    else if (action.type === "today") props.onAddToday(task);
    else if (action.type === "sync-daily") props.onSyncDaily(task);
    else if (action.type === "use-daily") props.onUseDaily(task);
    else if (action.type === "delegate") props.onDelegate(task);
    else props.onOpenDetails(task);
  };
  const items: BoardMenuItem[] = taskMenuEntries(task, {
    levels: props.levels,
    addState: props.addState,
    inToday: props.inToday,
    outOfSync: props.inToday && (props.outOfSync || props.subtaskSync.length > 0),
    dailyState: props.outOfSync ? props.todayCheckbox : null,
    subtask: false,
    finished: props.finished,
  }).map((entry) => ({
    id: entry.id,
    label: entry.label,
    title: entry.title,
    separator: entry.separator,
    disabled: busy || entry.disabled,
    onSelect: () => run(entry.action),
  }));
  return <BoardActionsMenu label={`Actions for ${task.title}`} disabled={busy} items={items} />;
}

type DetailsProps = Pick<
  ItemProps,
  "task" | "pending" | "expandedIds" | "levels" | "onToggleId" | "onStatus" | "onRename" | "onReason" | "onPriority" | "noteActions" | "onAddSubtask" | "today" | "finishedIds"
>;

function TaskDetails({ task, pending, expandedIds, levels, onToggleId, onStatus, onRename, onReason, onPriority, noteActions, onAddSubtask, today, finishedIds }: DetailsProps) {
  const busy = pending.has(task.id);
  const locked = finishedIds.has(task.id);
  return (
    <div className="board-details">
      <BoardNotes task={task} disabled={busy} readOnly={locked} actions={noteActions} />
      {task.subtasks.length > 0 && (
        <BoardSubtasks
          tasks={task.subtasks}
          pending={pending}
          expandedIds={expandedIds}
          levels={levels}
          onToggleId={onToggleId}
          onStatus={onStatus}
          onRename={onRename}
          onReason={onReason}
          onPriority={onPriority}
          noteActions={noteActions}
          today={today}
          finished={finishedIds}
        />
      )}
      {!locked && (
        <div className="frow">
          <button className="act" disabled={busy} onClick={() => onAddSubtask(task)}>
            Add subtask
          </button>
        </div>
      )}
    </div>
  );
}

interface CardProps extends ItemProps {
  dragging: boolean;
  onDragStart: (task: BoardTask) => void;
  onDragEnd: () => void;
}

function BoardCard(props: CardProps) {
  const { task, breadcrumb, pending, expanded, dragging, onToggle, onDragStart, onDragEnd } = props;
  const [typing, setTyping] = useState(false);
  const dragged = useRef(false);
  const busy = pending.has(task.id);
  const progress = subtaskProgress(task);
  const hasChildren = task.subtasks.length > 0 || task.noteItems.length > 0;
  const showReason = supportsReason(task.status) && task.reason !== null;
  return (
    <article
      className={`board-card ${dragging ? "board-card--drag" : ""} ${busy ? "board-card--busy" : ""}`}
      draggable={!busy && !typing && !props.finished}
      title={props.finished ? FINISHED_OCCURRENCE_HINT : undefined}
      onFocusCapture={(event) => setTyping(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)}
      onBlurCapture={() => setTyping(false)}
      onDragStart={(event) => {
        dragged.current = true;
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart(task);
      }}
      onDragEnd={() => {
        window.setTimeout(() => {
          dragged.current = false;
        }, 0);
        onDragEnd();
      }}
      onClick={(event) => {
        if (dragged.current || typing) return;
        if (event.target instanceof Element && event.target.closest(CARD_CONTROLS)) return;
        if ((window.getSelection()?.toString() ?? "") !== "") return;
        props.onOpenDetails(task);
      }}
    >
      <div className="board-card__head">
        <BoardPriorityBadge priority={task.priority} levels={props.levels} />
        <span className="board-card__title" title={task.title}>
          <InlineText text={task.title} />
        </span>
        <span className="board-card__tools">
          {hasChildren && <BoardExpandButton title={task.title} expanded={expanded} onToggle={onToggle} />}
          <TaskMenu {...props} />
        </span>
      </div>
      {showReason && (
        <p className="board-card__reason" title={task.reason ?? undefined}>
          {task.reason}
        </p>
      )}
      <div className="board-meta">
        <span className="board-meta__project" title={breadcrumb}>
          {breadcrumb}
        </span>
        {progress.total > 0 && (
          <span className="chip board-meta__progress" title="Subtasks done">
            {progress.done}/{progress.total}
          </span>
        )}
        <BoardDueChip task={task} today={props.todayKey} />
        <BoardRepeatMark task={task} />
        <BoardTodayStatus inToday={props.inToday} checkbox={props.todayCheckbox} outOfSync={props.outOfSync} subtaskNames={props.subtaskSync} />
        <BoardDoneStamp task={task} />
      </div>
      {expanded && (
        <TaskDetails
          task={task}
          pending={pending}
          expandedIds={props.expandedIds}
          levels={props.levels}
          onToggleId={props.onToggleId}
          onStatus={props.onStatus}
          onRename={props.onRename}
          onReason={props.onReason}
          onPriority={props.onPriority}
          noteActions={props.noteActions}
          onAddSubtask={props.onAddSubtask}
          today={props.today}
          finishedIds={props.finishedIds}
        />
      )}
    </article>
  );
}

const TABLE_COLUMNS = 9;

function BoardRow(props: ItemProps) {
  const { task, pending, expanded, onToggle } = props;
  const busy = pending.has(task.id);
  const progress = subtaskProgress(task);
  const reason = supportsReason(task.status) ? task.reason : null;
  const open = () => props.onOpenDetails(task);
  return (
    <>
      <tr
        className={`board-row ${busy ? "board-row--busy" : ""}`}
        tabIndex={0}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest(CARD_CONTROLS)) return;
          if ((window.getSelection()?.toString() ?? "") !== "") return;
          open();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && event.target === event.currentTarget) open();
        }}
      >
        <td className="board-table__pri">{task.priority === null ? <span className="muted">-</span> : <BoardPriorityBadge priority={task.priority} levels={props.levels} />}</td>
        <td className="board-table__status">
          <span className={`tag tag--board-${task.status}`}>{BOARD_STATUS_LABEL[task.status]}</span>
        </td>
        <td className="board-table__start">{task.start ? formatDayMonth(task.start) : <span className="muted">-</span>}</td>
        <td className="board-table__due">{task.due ? <BoardDueChip task={task} today={props.todayKey} /> : <span className="muted">-</span>}</td>
        <td className="board-table__task" title={task.title}>
          <InlineText text={task.title} />
          <BoardRepeatMark task={task} />
        </td>
        <td className="board-table__reason" title={reason ?? undefined}>
          {reason}
        </td>
        <td className="board-table__subs">
          {progress.total > 0 ? (
            <span className="board-table__subs-inner">
              <BoardExpandButton title={task.title} expanded={expanded} onToggle={onToggle} />
              {progress.done}/{progress.total}
            </span>
          ) : (
            <span className="muted">-</span>
          )}
        </td>
        <td className="board-table__today">
          <BoardTodayStatus inToday={props.inToday} checkbox={props.todayCheckbox} outOfSync={props.outOfSync} subtaskNames={props.subtaskSync} />
          <BoardDoneStamp task={task} />
        </td>
        <td className="board-table__actions">
          <TaskMenu {...props} />
        </td>
      </tr>
      {expanded && (
        <tr className="board-table__detail">
          <td colSpan={TABLE_COLUMNS}>
            <TaskDetails
              task={task}
              pending={pending}
              expandedIds={props.expandedIds}
              levels={props.levels}
              onToggleId={props.onToggleId}
              onStatus={props.onStatus}
              onRename={props.onRename}
              onReason={props.onReason}
              onPriority={props.onPriority}
              noteActions={props.noteActions}
              onAddSubtask={props.onAddSubtask}
              today={props.today}
              finishedIds={props.finishedIds}
            />
          </td>
        </tr>
      )}
    </>
  );
}

interface SortHeaderProps {
  label: string;
  sortKey: TableSortKey;
  sort: BoardPrefs["tableSort"];
  onSort: (key: TableSortKey) => void;
}

function SortHeader({ label, sortKey, sort, onSort }: SortHeaderProps) {
  const active = sort.key === sortKey;
  return (
    <th aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button className={`board-sort ${active ? "board-sort--on" : ""}`} onClick={() => onSort(sortKey)}>
        {label}
        <span className="board-sort__arrow" aria-hidden="true">
          {active ? (sort.dir === "asc" ? "↑" : "↓") : ""}
        </span>
      </button>
    </th>
  );
}

export function BoardView({ workspaces, settings, subscribeBoard, subscribeDaily, onOpenSettings, onDelegated, onNotice, onError }: Props) {
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<BoardPrefs>(readPrefs);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropColumn, setDropColumn] = useState<BoardStatus | null>(null);
  const [delegating, setDelegating] = useState<BoardTask | null>(null);
  const [delegateNotice, setDelegateNotice] = useState<string | null>(null);
  const [delegateMissing, setDelegateMissing] = useState(false);
  const [creating, setCreating] = useState<{ parent: BoardTask | null } | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [doneShown, setDoneShown] = useState(DONE_SECTION_PAGE);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [picker, setPicker] = useState<{ kind: "parent" | "project"; taskId: string } | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const [undatedOpen, setUndatedOpen] = useState(false);
  const [todayJump, setTodayJump] = useState(0);
  const holdDrawer = useRef(false);
  const delegateProject = useRef<BoardProject | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const hasToday = useRef(false);
  const boardRef = useRef<BoardPayload | null>(null);

  const { view, filters } = prefs;

  const load = useCallback(async (): Promise<BoardPayload | null> => {
    try {
      const next = await getTasksBoard();
      const previous = boardRef.current;
      if (previous) setExpanded((current) => remapExpanded(previous.tasks, next.tasks, current));
      if (previous && !holdDrawer.current) setDrawerId((current) => (current === null ? null : remapTaskId(previous.tasks, next.tasks, current)));
      setBoard(next);
      setLoadError(null);
      return next;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "could not load tasks");
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void load();
    }, REFRESH_DELAY_MS);
  }, [load]);

  useEffect(() => {
    const unsubscribe = subscribeBoard(scheduleRefresh);
    return () => {
      unsubscribe();
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, [subscribeBoard, scheduleRefresh]);

  useEffect(() => {
    hasToday.current = board?.today != null;
    boardRef.current = board;
  }, [board]);

  useEffect(
    () =>
      subscribeDaily(() => {
        if (hasToday.current) scheduleRefresh();
      }),
    [subscribeDaily, scheduleRefresh],
  );

  useEffect(() => {
    writePrefs(prefs);
  }, [prefs]);


  const projects = board?.projects ?? [];
  const allTasks = board?.tasks ?? [];
  const drawerTask = drawerId === null ? null : findBoardTask(allTasks, drawerId);
  const pickerTask = picker === null ? null : findBoardTask(allTasks, picker.taskId);

  useEffect(() => {
    if (board && drawerId !== null && drawerTask === null) setDrawerId(null);
  }, [board, drawerId, drawerTask]);

  useEffect(() => {
    if (board && picker !== null && pickerTask === null) setPicker(null);
  }, [board, picker, pickerTask]);
  const options = useMemo(() => projectOptions(projects), [projects]);
  const breadcrumbs = useMemo(() => new Map(projects.map((project) => [project.id, projectBreadcrumb(projects, project.id).join(" › ")])), [projects]);
  const today = board?.today ?? null;
  const todayIds = useMemo(() => todayIdSet(today), [today]);
  const addState = todayAddState(today);
  const doneEnabled = (settings?.tasks.doneSection ?? "").trim() !== "";
  const finishedIds = useMemo(() => finishedOccurrenceIds(allTasks, doneEnabled), [allTasks, doneEnabled]);
  const visible = useMemo(() => filterBoardTasks(allTasks, projects, filters, todayIds), [allTasks, projects, filters, todayIds]);
  const columns = useMemo(() => groupByStatus(sortByPriority(visible)), [visible]);
  const doneView = useMemo(() => doneColumnView(columns.done, doneShown), [columns, doneShown]);
  const tableView = useMemo(() => capDoneSection(sortTableTasks(visible, prefs.tableSort, breadcrumbs), doneShown), [visible, prefs.tableSort, breadcrumbs, doneShown]);
  const projectOrder = settings?.daily.projectOrder;
  const tableGroups = useMemo(() => groupTasksByProject(tableView.tasks, projects, projectOrder ?? []), [tableView, projects, projectOrder]);
  const timelineView = useMemo(() => capDoneSection(visible, doneShown), [visible, doneShown]);
  const timelineOrder = useMemo(() => effectiveProjectOrder(projects, projectOrder ?? []), [projects, projectOrder]);
  const todayKey = localDayKey(new Date());
  const levels = settings?.tasks.priorityLevels;
  const priorityChips = useMemo(() => [...priorityFilterLevels(levels, allTasks), null], [levels, allTasks]);
  const priorityCounts = useMemo(() => {
    const counts = new Map<number | null, number>();
    for (const task of filterBoardTasks(allTasks, projects, { ...filters, hiddenPriorities: [] }, todayIds)) counts.set(task.priority, (counts.get(task.priority) ?? 0) + 1);
    return counts;
  }, [allTasks, projects, filters, todayIds]);
  const statusCounts = useMemo(
    () => groupByStatus(filterBoardTasks(allTasks, projects, { ...filters, statuses: [...BOARD_STATUSES] }, todayIds)),
    [allTasks, projects, filters, todayIds],
  );
  const dragging = dragId !== null;
  const kanbanStatuses = useMemo(() => {
    const counts: Record<BoardStatus, number> = {
      blocked: columns.blocked.length,
      hold: columns.hold.length,
      todo: columns.todo.length,
      doing: columns.doing.length,
      done: doneView.tasks.length,
      archived: columns.archived.length,
    };
    return visibleKanbanColumns(kanbanColumns(filters), counts, prefs.hideEmptyColumns, dragging);
  }, [filters, columns, doneView, prefs.hideEmptyColumns, dragging]);
  const everythingExpanded = useMemo(() => allExpanded(visible, expanded), [visible, expanded]);
  const shownStatuses = activeStatuses(filters);
  const selectedProject = projects.some((project) => project.id === filters.projectId) ? (filters.projectId as string) : "";
  const availability = todayAvailability(today);
  const customFilters = hasCustomFilters(prefs, availability);
  const filterNotes = activeFilterNotes(filters, { projectTitle: projects.find((project) => project.id === selectedProject)?.title ?? null, availability });
  const missingTodayHint = todayMissingHint(filters, availability);

  const setFilters = (patch: Partial<BoardPrefs["filters"]>) => setPrefs((current) => ({ ...current, filters: { ...current.filters, ...patch } }));
  const setView = (next: BoardViewMode) => setPrefs((current) => ({ ...current, view: next }));
  const setZoom = (timelineZoom: TimelineZoom) => setPrefs((current) => ({ ...current, timelineZoom }));

  const sortTable = (key: TableSortKey) => setPrefs((current) => ({ ...current, tableSort: nextTableSort(current.tableSort, key) }));

  const setHideEmptyColumns = (hideEmptyColumns: boolean) => setPrefs((current) => ({ ...current, hideEmptyColumns }));

  const resetFilters = () => setPrefs(resetFilterPrefs);

  const statusOptions: MultiSelectOption[] = BOARD_STATUSES.map((status) => {
    const checked = shownStatuses.includes(status);
    return {
      id: status,
      label: BOARD_STATUS_LABEL[status],
      checked,
      count: statusCounts[status].length,
      disabled: checked && shownStatuses.length === 1,
      title: checked && shownStatuses.length === 1 ? "Keep at least one status selected" : undefined,
    };
  });

  const priorityOptions: MultiSelectOption[] = priorityChips.map((level) => ({
    id: level === null ? "none" : String(level),
    label: level === null ? "No priority" : priorityLabel(level),
    checked: !filters.hiddenPriorities.includes(level),
    count: priorityCounts.get(level) ?? 0,
  }));

  const viewOptions: MultiSelectOption[] = [
    ...(availability === "off"
      ? []
      : [{ id: "today", label: "In today's daily", checked: filters.todayOnly, title: "Show only tasks linked in today's daily" }]),
    { id: "hideEmpty", label: "Hide empty columns", checked: prefs.hideEmptyColumns, title: "Hide kanban columns that have no cards" },
  ];

  const toggleViewOption = (id: string) => {
    if (id === "today") setFilters({ todayOnly: !filters.todayOnly });
    else setHideEmptyColumns(!prefs.hideEmptyColumns);
  };

  const toggleStatus = (status: BoardStatus) => {
    const current = activeStatuses(filters);
    const next = current.includes(status) ? current.filter((item) => item !== status) : [...current, status];
    if (next.length > 0) setFilters({ statuses: next });
  };

  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleExpandAll = () => setExpanded(everythingExpanded ? new Set() : new Set(expandableIds(visible)));

  const markPending = (id: string, on: boolean) =>
    setPending((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const handleConflict = async () => {
    onError("This task changed on disk, so the board was refreshed. Try again.");
    await load();
  };

  const followAfterLoad = async (anchor: BoardTask): Promise<void> => {
    holdDrawer.current = true;
    try {
      const fresh = await load();
      if (fresh) setDrawerId(findTaskAfterRefetch(fresh.tasks, anchor)?.id ?? null);
    } finally {
      holdDrawer.current = false;
    }
  };

  const write = async (task: BoardTask, change: BoardChange) => {
    markPending(task.id, true);
    try {
      const result = await patchBoardItem({ projectId: task.projectId, line: task.line, raw: task.raw }, change);
      setBoard((current) => (current ? { ...current, tasks: replaceBoardTask(current.tasks, result.task) } : current));
      if (result.recurred === true) {
        onNotice(recurrenceNotice(result.task));
        await load();
      } else if (result.moved && task.id === drawerId) await followAfterLoad(result.task);
      else if (result.moved) await load();
      else if (result.dailySynced === true || (change.status !== undefined && hasToday.current)) scheduleRefresh();
    } catch (err) {
      if (err instanceof BoardConflictError) await handleConflict();
      else onError(err instanceof Error ? err.message : "could not update the task");
    } finally {
      markPending(task.id, false);
    }
  };

  const changeStatus = (task: BoardTask, status: BoardStatus) => {
    if (task.status !== status) void write(task, { status });
  };

  const renameTask = (task: BoardTask, title: string) => {
    if (task.title !== title) void write(task, { title });
  };

  const changeReason = (task: BoardTask, reason: string | null) => {
    void write(task, { reason });
  };

  const changePriority = (task: BoardTask, priority: number | null) => {
    if (task.priority !== priority) void write(task, { priority });
  };

  const changeDates = (task: BoardTask, change: BoardChange) => {
    void write(task, change);
  };

  const runNote = async (task: BoardTask, action: () => Promise<{ task: BoardTask }>, refetch: boolean): Promise<boolean> => {
    markPending(task.id, true);
    try {
      const result = await action();
      setBoard((current) => (current ? { ...current, tasks: replaceBoardTask(current.tasks, result.task) } : current));
      if (refetch) await load();
      return true;
    } catch (err) {
      if (err instanceof BoardConflictError) await handleConflict();
      else onError(err instanceof Error ? err.message : "could not update the note");
      return false;
    } finally {
      markPending(task.id, false);
    }
  };

  const noteActions: BoardNoteActions = {
    onAdd: (task, text) => {
      const problem = validateNoteText(text);
      if (problem !== null) {
        onError(problem);
        return Promise.resolve(false);
      }
      return runNote(task, () => addBoardNote({ projectId: task.projectId, line: task.line, raw: task.raw }, text.trim()), true);
    },
    onEdit: (task, note, text) => {
      const problem = validateNoteText(text);
      if (problem !== null) onError(problem);
      else void runNote(task, () => editBoardNote({ projectId: task.projectId, line: note.line, raw: note.raw }, text.trim()), false);
    },
    onDelete: (task, note) => {
      void runNote(task, () => deleteBoardNote({ projectId: task.projectId, line: note.line, raw: note.raw }), true);
    },
  };

  const runOrganize = async (target: BoardTask, action: () => Promise<{ task: BoardTask }>, notice?: string): Promise<void> => {
    const root = drawerTask;
    if (!root) return;
    setOrganizing(true);
    holdDrawer.current = true;
    try {
      const result = await action();
      const fresh = await load();
      if (fresh) {
        const found = findTaskAfterRefetch(fresh.tasks, organizeFocus(root, target, result.task));
        setDrawerId(found ? found.id : null);
        if (!found) onError("The change was saved, but the task could not be found again");
      }
      if (notice) onNotice(notice);
    } catch (err) {
      holdDrawer.current = false;
      if (err instanceof BoardConflictError) await handleConflict();
      else onError(err instanceof Error ? err.message : "could not organize the task");
    } finally {
      holdDrawer.current = false;
      setOrganizing(false);
      setPicker(null);
    }
  };

  const organizeActions: BoardOrganizeActions = {
    onMove: (task, direction) => void runOrganize(task, () => moveBoardItem(targetOf(task), direction)),
    onMoveNote: (owner, note, direction) =>
      void runOrganize(owner, () => moveBoardItem({ projectId: owner.projectId, line: note.line, raw: note.raw }, direction)),
    onPromote: (task) => void runOrganize(task, () => reparentBoardTask(targetOf(task), null), `Promoted "${task.title}" to a task`),
    onMakeSubtask: (task) => setPicker({ kind: "parent", taskId: task.id }),
    onMoveToProject: (task) => setPicker({ kind: "project", taskId: task.id }),
  };

  const submitParent = (task: BoardTask, parent: BoardTask) =>
    void runOrganize(task, () => reparentBoardTask(targetOf(task), { line: parent.line, raw: parent.raw }), `Moved "${task.title}" under "${parent.title}"`);

  const submitMoveProject = (task: BoardTask, targetProjectId: string, parent: BoardTask | null) => {
    const label = breadcrumbs.get(targetProjectId) ?? targetProjectId;
    void runOrganize(
      task,
      () => moveBoardTaskToProject(targetOf(task), targetProjectId, parent ? { line: parent.line, raw: parent.raw } : null),
      `Moved "${task.title}" to ${label}`,
    );
  };

  const openInEditor = (project: BoardProject) => {
    openBoardProjectInEditor(project.id)
      .then((outcome) => {
        if (!outcome.ok) onError(`Could not open the editor: ${outcome.error ?? outcome.command}`);
      })
      .catch((err: unknown) => onError(`Could not open the editor: ${err instanceof Error ? err.message : String(err)}`));
  };

  const openInObsidian = (project: BoardProject) => {
    openExternal(obsidianUrl(project.path)).catch((err: unknown) => onError(`Could not open Obsidian: ${err instanceof Error ? err.message : String(err)}`));
  };

  const addToToday = async (task: BoardTask) => {
    markPending(task.id, true);
    try {
      await addBoardTaskToDaily({ projectId: task.projectId, line: task.line, raw: task.raw });
      const projectTitle = projects.find((project) => project.id === task.projectId)?.title ?? task.projectId;
      onNotice(addToTodayNotice(task, projectTitle, isSubtask(allTasks, task)));
      await load();
    } catch (err) {
      if (err instanceof BoardConflictError && err.message === ALREADY_IN_DAILY) {
        onError("That task is already in today's daily.");
        await load();
      } else if (err instanceof BoardConflictError) await handleConflict();
      else onError(err instanceof Error ? err.message : "could not add the task to the daily");
    } finally {
      markPending(task.id, false);
    }
  };

  const syncToDaily = async (task: BoardTask) => {
    markPending(task.id, true);
    try {
      await syncBoardTaskToDaily(targetOf(task));
      onNotice(`Synced "${task.title}" to today's daily`);
      await load();
    } catch (err) {
      if (err instanceof BoardConflictError) await handleConflict();
      else onError(err instanceof Error ? err.message : "could not sync the task to the daily");
    } finally {
      markPending(task.id, false);
    }
  };

  const useDaily = (task: BoardTask) => {
    const state = todayHint(today, task.id);
    if (state !== null) changeStatus(task, state);
  };

  const toggleGroup = (projectId: string) =>
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });

  const sweepDone = async () => {
    setSweeping(true);
    try {
      const targets = sweepTargets(projects, filters);
      let moved = 0;
      if (targets === null) moved = (await sweepBoardDone()).moved;
      else for (const id of targets) moved += (await sweepBoardDone(id)).moved;
      onNotice(moved === 0 ? "Nothing to move to the done section" : `Moved ${moved} task${moved === 1 ? "" : "s"} to the done section`);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "could not move the done tasks");
      await load();
    } finally {
      setSweeping(false);
    }
  };

  const submitCreate = async (body: BoardCreateInput) => {
    const parent = creating?.parent ?? null;
    try {
      await createBoardItem(body);
    } catch (err) {
      if (err instanceof BoardConflictError && parent) {
        const fresh = await load();
        const rebound = fresh ? rebindDelegateTask(fresh.tasks, parent, err.current) : err.current;
        setCreating(rebound ? { parent: rebound } : null);
        throw new Error(rebound ? "The parent task changed on disk and was reloaded. Add the subtask again." : "The parent task no longer exists on disk.");
      }
      throw err;
    }
    setCreating(null);
    if (parent) setExpanded((current) => new Set(current).add(parent.id));
    onNotice(`Created "${body.title}"`);
    await load();
  };

  const dropOn = (status: BoardStatus) => {
    const dropped = dragId ? findBoardTask(allTasks, dragId) : null;
    setDragId(null);
    setDropColumn(null);
    if (dropped) changeStatus(dropped, status);
  };

  const closeDelegate = () => {
    setDelegating(null);
    setDelegateNotice(null);
    setDelegateMissing(false);
    delegateProject.current = null;
  };

  const openDelegate = (task: BoardTask) => {
    setDelegateNotice(null);
    setDelegateMissing(false);
    delegateProject.current = null;
    setDelegating(task);
  };

  const submitDelegate = async (request: BoardDelegateRequest) => {
    if (!delegating) return;
    const target = delegating;
    setDelegateNotice(null);
    try {
      const result = await delegateBoardTask({
        projectId: target.projectId,
        line: target.line,
        raw: target.raw,
        workspace: request.workspace,
        prompt: request.prompt,
        runner: request.runner,
        ...(request.repo ? { repo: request.repo } : {}),
      });
      setBoard((current) => (current ? { ...current, tasks: replaceBoardTask(current.tasks, result.task) } : current));
      closeDelegate();
      onDelegated(result.taskId, result.task.title);
      if (result.warning) onError(`Delegated, but ${result.warning}`);
    } catch (err) {
      if (err instanceof BoardConflictError) {
        const fresh = await load();
        const rebound = fresh ? rebindDelegateTask(fresh.tasks, target, err.current) : err.current;
        if (rebound) setDelegating(rebound);
        setDelegateMissing(rebound === null);
        setDelegateNotice(rebound ? DELEGATE_CHANGED_NOTICE : DELEGATE_MISSING_NOTICE);
        return;
      }
      throw err;
    }
  };

  if (!board && !loadError) {
    return (
      <div className="view">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (loadError && !board) {
    return (
      <div className="view">
        <p className="error">{loadError}</p>
        <div className="frow">
          <button className="act" onClick={() => void load()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!board) return null;

  if (!board.configured) {
    return (
      <div className="view">
        <p className="hint">
          {board.root
            ? `The Tasks folder ${board.root} does not exist.`
            : "Set the Second brain path (or a Projects folder) so the hub knows where your project notes live."}
        </p>
        <div className="frow">
          <button className="act act--focus" onClick={onOpenSettings}>
            Open settings
          </button>
        </div>
      </div>
    );
  }

  const foundProject = delegating ? (projects.find((project) => project.id === delegating.projectId) ?? null) : null;
  if (foundProject) delegateProject.current = foundProject;
  const delegatingProject = delegating ? (foundProject ?? delegateProject.current) : null;
  const todayControls: BoardTodayControls = {
    isLinked: (id) => isLinkedToday(today, id),
    isOutOfSync: (id) => isOutOfSync(today, id),
    dailyState: (id) => todayHint(today, id),
    addState,
    onAdd: (item) => void addToToday(item),
  };
  const detailProps = (task: BoardTask): ItemProps => ({
    task,
    breadcrumb: breadcrumbs.get(task.projectId) ?? task.projectId,
    pending,
    expanded: expanded.has(task.id),
    expandedIds: expanded,
    onToggle: () => toggleExpanded(task.id),
    onToggleId: toggleExpanded,
    onStatus: changeStatus,
    onRename: renameTask,
    onReason: changeReason,
    onPriority: changePriority,
    noteActions,
    levels,
    onDelegate: openDelegate,
    onAddSubtask: (parent) => setCreating({ parent }),
    todayCheckbox: todayHint(today, task.id),
    todayKey,
    inToday: isLinkedToday(today, task.id),
    outOfSync: isOutOfSync(today, task.id),
    subtaskSync: subtaskMismatches(task, today).map((item) => item.title),
    addState,
    today: todayControls,
    onAddToday: (item) => void addToToday(item),
    onSyncDaily: (item) => void syncToDaily(item),
    onUseDaily: useDaily,
    onOpenDetails: (item) => setDrawerId(item.id),
    finished: finishedIds.has(task.id),
    finishedIds,
  });

  return (
    <div className="view view--board">
      <div className="toolbar">
        <div className="pillpair" role="group" aria-label="Board layout">
          <button className={`pill ${view === "kanban" ? "pill--on" : ""}`} aria-pressed={view === "kanban"} onClick={() => setView("kanban")}>
            Kanban
          </button>
          <button className={`pill ${view === "table" ? "pill--on" : ""}`} aria-pressed={view === "table"} onClick={() => setView("table")}>
            Table
          </button>
          <button className={`pill ${view === "timeline" ? "pill--on" : ""}`} aria-pressed={view === "timeline"} onClick={() => setView("timeline")}>
            Timeline
          </button>
        </div>
        {view === "timeline" && (
          <div className="pillpair" role="group" aria-label="Timeline zoom">
            {TIMELINE_ZOOMS.map((zoom) => (
              <button key={zoom} className={`pill ${prefs.timelineZoom === zoom ? "pill--on" : ""}`} aria-pressed={prefs.timelineZoom === zoom} onClick={() => setZoom(zoom)}>
                {ZOOM_LABEL[zoom]}
              </button>
            ))}
          </div>
        )}
        <div className="toolbar__right">
          {view === "timeline" ? (
            <button className="act" title="Scroll the timeline to today" onClick={() => setTodayJump((count) => count + 1)}>
              Today
            </button>
          ) : (
            <button className="act" aria-pressed={everythingExpanded} disabled={visible.length === 0} onClick={toggleExpandAll}>
              {everythingExpanded ? "Collapse all" : "Expand all"}
            </button>
          )}
          {doneEnabled && (
            <button className="act" disabled={sweeping} title="Move finished tasks to the done section" onClick={() => void sweepDone()}>
              {sweeping ? "Moving…" : "Move done"}
            </button>
          )}
          <button className="act" onClick={() => setCreating({ parent: null })}>
            New task
          </button>
          <button className="act" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      <div className="board-filters">
        <label className="board-filters__project">
          <span className="muted small">Project</span>
          <select
            className="select"
            aria-label="Project"
            value={selectedProject}
            onChange={(event) => setFilters({ projectId: event.target.value === "" ? null : event.target.value })}
          >
            <option value="">All projects</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.includeSubprojects}
            disabled={selectedProject === ""}
            onChange={(event) => setFilters({ includeSubprojects: event.target.checked })}
          />
          Include subprojects
        </label>
        <MultiSelectDropdown
          label="Status filter"
          summary={statusFilterSummary(filters)}
          options={statusOptions}
          highlighted={!hasDefaultStatuses(filters)}
          shortcuts={[
            { label: "All", onClick: () => setFilters({ statuses: [...BOARD_STATUSES] }) },
            { label: "All but Archived", onClick: () => setFilters({ statuses: [...DEFAULT_BOARD_PREFS.filters.statuses] }) },
          ]}
          onToggle={(id) => toggleStatus(id as BoardStatus)}
        />
        <MultiSelectDropdown
          label="Priority filter"
          summary={priorityFilterSummary(filters, priorityChips)}
          options={priorityOptions}
          highlighted={filters.hiddenPriorities.length > 0}
          shortcuts={[
            { label: "All", onClick: () => setFilters({ hiddenPriorities: [] }) },
            { label: "None", onClick: () => setFilters({ hiddenPriorities: [...priorityChips] }) },
          ]}
          onToggle={(id) => setFilters({ hiddenPriorities: toggleHiddenPriority(filters.hiddenPriorities, id === "none" ? null : Number(id)) })}
        />
        <MultiSelectDropdown
          label="View options"
          summary={viewSummary(prefs, availability)}
          options={viewOptions}
          highlighted={filters.todayOnly && availability !== "off"}
          onToggle={toggleViewOption}
        />
        {missingTodayHint && <span className="board-filters__hint small">{missingTodayHint}</span>}
        <label className="search board-filters__search">
          <IconSearch />
          <input
            className="in"
            aria-label="Search tasks"
            placeholder="search tasks, notes, projects"
            value={filters.search}
            onChange={(event) => setFilters({ search: event.target.value })}
          />
        </label>
        <span title={customFilters ? "Reset filters and view options to their defaults" : "Filters and view options are already at their defaults"}>
          <button className="act" disabled={!customFilters} onClick={resetFilters}>
            Reset filters
          </button>
        </span>
      </div>

      {board.errors.length > 0 && (
        <p className="error small">
          {board.errors.length} file{board.errors.length === 1 ? "" : "s"} could not be read: {board.errors.map((item) => item.path).join(", ")}
        </p>
      )}
      {loadError && <p className="error small">{loadError}</p>}
      {projects.length === 0 && <p className="empty">No markdown files found in {board.root}.</p>}
      {projects.length > 0 && visible.length === 0 && (
        <div className="board-empty" role="status">
          <p className="empty">{emptyResultsMessage(filterNotes)}</p>
          {filterNotes.length > 0 && (
            <button className="act" onClick={resetFilters}>
              Reset filters
            </button>
          )}
        </div>
      )}

      {projects.length > 0 && view === "kanban" && kanbanStatuses.length > 0 && (
        <div className="board-kanban">
          {kanbanStatuses.map((status) => (
            <section
              key={status}
              className={`board-col board-col--${status} ${dropColumn === status ? "board-col--over" : ""}`}
              aria-label={BOARD_STATUS_LABEL[status]}
              onDragOver={(event) => {
                if (!dragId) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (dropColumn !== status) setDropColumn(status);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropColumn((current) => (current === status ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropOn(status);
              }}
            >
              <header className="board-col__head">
                <h3>{BOARD_STATUS_LABEL[status]}</h3>
                <span className="pill__count">{columns[status].length}</span>
              </header>
              <div className="board-col__body">
                {(status === "done" ? doneView.tasks : columns[status]).map((task) => (
                  <BoardCard
                    key={task.id}
                    {...detailProps(task)}
                    dragging={dragId === task.id}
                    onDragStart={(item) => setDragId(item.id)}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropColumn(null);
                    }}
                  />
                ))}
                {columns[status].length === 0 && <p className="board-col__empty muted small">Drop a task here</p>}
                {status === "done" && doneView.hidden > 0 && (
                  <button className="act board-more" onClick={() => setDoneShown((current) => current + DONE_SECTION_PAGE)}>
                    Show more ({doneView.hidden})
                  </button>
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      {projects.length > 0 && view === "table" && visible.length > 0 && (
        <div className="board-table-wrap">
          <table className="board-table">
            <thead>
              <tr>
                <SortHeader label="Pri" sortKey="priority" sort={prefs.tableSort} onSort={sortTable} />
                <SortHeader label="Status" sortKey="status" sort={prefs.tableSort} onSort={sortTable} />
                <th>Start</th>
                <SortHeader label="Due" sortKey="due" sort={prefs.tableSort} onSort={sortTable} />
                <SortHeader label="Task" sortKey="title" sort={prefs.tableSort} onSort={sortTable} />
                <th>Reason</th>
                <th>Subtasks</th>
                <th>Today</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {tableGroups.map((group) => {
                const collapsed = collapsedGroups.has(group.project.id);
                const label = breadcrumbs.get(group.project.id) ?? group.project.title;
                return (
                  <Fragment key={group.project.id}>
                    <tr className="board-group">
                      <td colSpan={TABLE_COLUMNS}>
                        <button
                          className={`board-group__toggle ${collapsed ? "" : "board-group__toggle--open"}`}
                          aria-expanded={!collapsed}
                          title={label}
                          onClick={() => toggleGroup(group.project.id)}
                        >
                          <IconChevron />
                          <span className="board-group__name">{label}</span>
                          <span className="pill__count">{group.tasks.length}</span>
                        </button>
                      </td>
                    </tr>
                    {!collapsed && group.tasks.map((task) => <BoardRow key={task.id} {...detailProps(task)} />)}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {tableView.hidden > 0 && (
            <button className="act board-more" onClick={() => setDoneShown((current) => current + DONE_SECTION_PAGE)}>
              Show more done tasks ({tableView.hidden})
            </button>
          )}
        </div>
      )}

      {projects.length > 0 && view === "timeline" && visible.length > 0 && (
        <>
          <BoardTimeline
            tasks={timelineView.tasks}
            projects={projects}
            projectOrder={timelineOrder}
            breadcrumbs={breadcrumbs}
            zoom={prefs.timelineZoom}
            today={todayKey}
            levels={levels}
            collapsed={collapsedGroups}
            undatedOpen={undatedOpen}
            jumpToToday={todayJump}
            onToggleGroup={toggleGroup}
            onToggleUndated={() => setUndatedOpen((open) => !open)}
            onOpen={(item) => setDrawerId(item.id)}
          />
          {timelineView.hidden > 0 && (
            <button className="act board-more" onClick={() => setDoneShown((current) => current + DONE_SECTION_PAGE)}>
              Show more done tasks ({timelineView.hidden})
            </button>
          )}
        </>
      )}

      {drawerTask && (
        <BoardDrawer
          task={drawerTask}
          tasks={allTasks}
          project={projects.find((project) => project.id === drawerTask.projectId) ?? null}
          breadcrumb={breadcrumbs.get(drawerTask.projectId) ?? drawerTask.projectId}
          pending={pending}
          organizing={organizing}
          suspended={delegating !== null || creating !== null || pickerTask !== null}
          levels={levels}
          inToday={isLinkedToday(today, drawerTask.id)}
          todayCheckbox={todayHint(today, drawerTask.id)}
          addState={addState}
          today={todayControls}
          finished={finishedIds}
          onSyncDaily={(item) => void syncToDaily(item)}
          onUseDaily={useDaily}
          noteActions={noteActions}
          organize={organizeActions}
          onStatus={changeStatus}
          onRename={renameTask}
          onReason={changeReason}
          onPriority={changePriority}
          onDates={changeDates}
          onDelegate={openDelegate}
          onAddSubtask={(parent) => setCreating({ parent })}
          onAddToday={(item) => void addToToday(item)}
          onOpenObsidian={openInObsidian}
          onOpenEditor={openInEditor}
          onClose={() => setDrawerId(null)}
        />
      )}

      {picker?.kind === "parent" && pickerTask && (
        <BoardParentPickerDialog
          task={pickerTask}
          candidates={parentCandidates(allTasks, pickerTask.projectId, pickerTask)}
          levels={levels}
          busy={organizing}
          onCancel={() => setPicker(null)}
          onSubmit={(parent) => submitParent(pickerTask, parent)}
        />
      )}

      {picker?.kind === "project" && pickerTask && (
        <BoardMoveProjectDialog
          task={pickerTask}
          projects={moveTargetProjects(projects, pickerTask.projectId)}
          tasks={allTasks}
          busy={organizing}
          onCancel={() => setPicker(null)}
          onSubmit={(targetProjectId, parent) => submitMoveProject(pickerTask, targetProjectId, parent)}
        />
      )}

      {creating && (
        <BoardNewTaskDialog
          projects={projects}
          defaultProjectId={selectedProject}
          parent={creating.parent}
          levels={levels}
          onCancel={() => setCreating(null)}
          onSubmit={submitCreate}
        />
      )}

      {delegating && delegatingProject && (
        <BoardDelegateDialog
          task={delegating}
          project={delegatingProject}
          template={board.delegatePrompt}
          workspaces={workspaces}
          notice={delegateNotice}
          taskMissing={delegateMissing}
          onCancel={closeDelegate}
          onSubmit={submitDelegate}
        />
      )}
    </div>
  );
}
