import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import "../today.css";
import { BOARD_STATUS_LABEL, countedProjectOptions, dueTone, formatDayMonth, priorityFilterLevels, priorityLabel, subtaskProgress, toggleHiddenPriority, type FilterChip, type FilterChipId } from "../board-model";
import type { BoardProject, BoardTask } from "../delegation";
import { InlineText } from "../markdown";
import { doingTarget } from "../outliner-model";
import {
  BACKLOG_FILTERS_KEY,
  BACKLOG_STATUSES,
  BACKLOG_STATUS_LABEL,
  backlogGroups,
  backlogKeyIntent,
  backlogPriorityCounts,
  backlogTasks,
  countBacklog,
  DEFAULT_BACKLOG_FILTERS,
  encodeDragTarget,
  hasCustomBacklogFilters,
  parseBacklogFilters,
  serializeBacklogFilters,
  TODAY_DRAG_MIME,
  targetOfTask,
  toggleBacklogStatus,
  windowBacklogGroups,
  type BacklogFilters,
} from "../today-model";
import { BoardFilterChips, BoardFilters, type BoardFilterGroup } from "./BoardFilters";
import { ShowMoreButtons, useShowMore } from "./ShowMore";

interface BacklogPanelProps {
  tasks: BoardTask[];
  projects: BoardProject[];
  projectOrder: readonly string[];
  excluded: ReadonlySet<string>;
  inToday?: ReadonlySet<string>;
  levels?: number;
  date: string;
  today: string;
  busyIds: ReadonlySet<string>;
  onSchedule: (task: BoardTask, date: string) => void;
  onDone: (task: BoardTask) => void;
  onDoing: (task: BoardTask) => void;
  onOpen: (task: BoardTask) => void;
  onDragActive: (active: boolean) => void;
  nextDate: string;
}

const priorityTone = (priority: number): number => Math.min(priority, 3);

const NO_TASKS = new Set<string>();

const readFilters = (): BacklogFilters => {
  try {
    return parseBacklogFilters(window.localStorage.getItem(BACKLOG_FILTERS_KEY) ?? "");
  } catch {
    return DEFAULT_BACKLOG_FILTERS;
  }
};

const storeFilters = (filters: BacklogFilters): void => {
  try {
    window.localStorage.setItem(BACKLOG_FILTERS_KEY, serializeBacklogFilters(filters));
  } catch {
    return;
  }
};

const priorityName = (level: number | null): string => (level === null ? "No priority" : priorityLabel(level));

export function BacklogPanel({ tasks, projects, projectOrder, excluded, inToday = NO_TASKS, levels, date, today, busyIds, onSchedule, onDone, onDoing, onOpen, onDragActive, nextDate }: BacklogPanelProps) {
  const [filters, setFiltersState] = useState<BacklogFilters>(readFilters);
  const [activeId, setActiveId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const lastIndex = useRef(0);
  const restoreFocus = useRef(false);

  const setFilters = (next: BacklogFilters) => {
    setFiltersState(next);
    storeFilters(next);
  };

  const hidden = filters.hiddenPriorities ?? [];
  const showInToday = filters.showInToday !== false;
  const groups = useMemo(() => backlogGroups(tasks, projects, projectOrder, excluded, filters, inToday), [tasks, projects, projectOrder, excluded, filters, inToday]);
  const total = countBacklog(groups);
  const resetKey = `${filters.search}\u0000${filters.projectId ?? ""}\u0000${filters.statuses.join(",")}\u0000${hidden.join(",")}\u0000${String(showInToday)}`;
  const paging = useShowMore(total, resetKey);
  const visible = useMemo(() => windowBacklogGroups(groups, paging.view.shown), [groups, paging.view.shown]);
  const flat = useMemo(() => visible.flatMap((group) => group.tasks), [visible]);
  const counted = useMemo(
    () => countedProjectOptions(projects, backlogTasks(tasks, projects, excluded, { ...filters, projectId: null }, inToday), false),
    [tasks, projects, excluded, filters, inToday],
  );
  const unfiltered = useMemo(() => backlogTasks(tasks, projects, excluded, { ...filters, hiddenPriorities: [] }, inToday), [tasks, projects, excluded, filters, inToday]);
  const priorityCounts = useMemo(() => backlogPriorityCounts(unfiltered), [unfiltered]);
  const priorityLevels = useMemo<(number | null)[]>(() => [...priorityFilterLevels(levels, unfiltered), null], [levels, unfiltered]);
  const titles = useMemo(() => new Map(projects.map((project) => [project.id, project.title])), [projects]);
  const current = flat.some((task) => task.id === activeId) ? activeId : (flat[Math.min(lastIndex.current, flat.length - 1)]?.id ?? null);
  const isToday = date === today;

  useEffect(() => {
    const index = flat.findIndex((task) => task.id === current);
    if (index !== -1) lastIndex.current = index;
  });

  useEffect(() => {
    if (!restoreFocus.current || current === null) return;
    const element = rowRefs.current.get(current);
    if (element === undefined) return;
    if (document.activeElement !== document.body && document.activeElement !== null && document.activeElement !== element) {
      restoreFocus.current = false;
      return;
    }
    restoreFocus.current = false;
    element.focus();
  });

  const focusRow = (id: string) => {
    setActiveId(id);
    rowRefs.current.get(id)?.focus();
  };

  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLElement>, task: BoardTask) => {
    if (event.target !== event.currentTarget) return;
    const intent = backlogKeyIntent(event);
    if (intent === null) return;
    event.preventDefault();
    const index = flat.findIndex((item) => item.id === task.id);
    if (intent === "next") {
      const target = flat[index + 1];
      if (target !== undefined) focusRow(target.id);
      return;
    }
    if (intent === "prev") {
      const target = flat[index - 1];
      if (target !== undefined) focusRow(target.id);
      return;
    }
    if (intent === "open") {
      onOpen(task);
      return;
    }
    if (intent === "today" && inToday.has(task.id)) return;
    restoreFocus.current = true;
    if (intent === "today") onSchedule(task, date);
    else if (intent === "tomorrow") onSchedule(task, nextDate);
    else if (intent === "doing") {
      if (doingTarget(task.status) === null) restoreFocus.current = false;
      else onDoing(task);
    } else onDone(task);
  };

  const onDragStart = (event: ReactDragEvent<HTMLElement>, task: BoardTask) => {
    const payload = encodeDragTarget(targetOfTask(task));
    event.dataTransfer.setData(TODAY_DRAG_MIME, payload);
    event.dataTransfer.setData("text/plain", task.title);
    event.dataTransfer.effectAllowed = "move";
    onDragActive(true);
  };

  const filterGroups: BoardFilterGroup[] = [
    {
      title: "Priority",
      options: priorityLevels.map((level) => ({
        id: level === null ? "none" : String(level),
        label: priorityName(level),
        checked: !hidden.includes(level),
        count: priorityCounts.get(level) ?? 0,
      })),
      shortcuts: [
        { label: "All", onClick: () => setFilters({ ...filters, hiddenPriorities: [] }) },
        { label: "None", onClick: () => setFilters({ ...filters, hiddenPriorities: [...priorityLevels] }) },
      ],
      onToggle: (id) => setFilters({ ...filters, hiddenPriorities: toggleHiddenPriority([...hidden], id === "none" ? null : Number(id)) }),
    },
    {
      title: "View",
      options: [{ id: "in-today", label: "Show tasks already in Today", checked: showInToday, count: [...inToday].filter((id) => unfiltered.some((task) => task.id === id)).length, title: "Show the tasks of this day's focus too, marked in Today" }],
      onToggle: () => setFilters({ ...filters, showInToday: !showInToday }),
    },
  ];

  const shownPriorities = priorityLevels.filter((level) => !hidden.includes(level)).map(priorityName);
  const chips: FilterChip[] = [
    ...(hidden.length > 0 ? [{ id: "priority" as const, label: shownPriorities.length === 0 ? "Priority: None" : `Priority: ${shownPriorities.length <= 2 ? shownPriorities.join(", ") : `${shownPriorities.length} of ${priorityLevels.length}`}` }] : []),
    ...(!showInToday ? [{ id: "today" as const, label: "Hiding tasks in Today" }] : []),
  ];

  const removeChip = (id: FilterChipId) => {
    if (id === "priority") setFilters({ ...filters, hiddenPriorities: [] });
    else if (id === "today") setFilters({ ...filters, showInToday: true });
  };

  const renderChips = (task: BoardTask) => {
    const tone = dueTone(task.due ?? null, task.status, today);
    const progress = subtaskProgress(task);
    return (
      <span className="backlog__chips">
        {task.priority !== null && (
          <span className={`chip board-prio board-prio--${priorityTone(task.priority)}`} title={`Priority P${task.priority}`}>
            P{task.priority}
          </span>
        )}
        {task.scheduled != null && !inToday.has(task.id) && (
          <span className="chip" title={`Scheduled for ${task.scheduled}`}>
            {formatDayMonth(task.scheduled)}
          </span>
        )}
        {task.due != null && tone !== null && (
          <span className={`chip board-due board-due--${tone}`} title={`Due ${task.due}`}>
            {formatDayMonth(task.due)}
          </span>
        )}
        {progress.total > 0 && (
          <span className="chip" title="Subtasks done">
            {progress.done}/{progress.total}
          </span>
        )}
      </span>
    );
  };

  const renderStatus = (task: BoardTask) => (
    <span className="backlog__status">{task.status !== "todo" && <span className={`tag tag--board-${task.status}`}>{BOARD_STATUS_LABEL[task.status]}</span>}</span>
  );

  return (
    <section className="backlog" aria-label="Backlog">
      <div className="backlog__top">
        <header className="backlog__head">
          <h3>
            Backlog <span className="backlog__count">{total}</span>
          </h3>
          <BoardFilters count={chips.length} groups={filterGroups} canReset={hasCustomBacklogFilters(filters)} onReset={() => setFilters({ ...DEFAULT_BACKLOG_FILTERS })} align="end" />
        </header>
        <div className="backlog__filters">
          <input
            className="in backlog__search"
            type="search"
            value={filters.search}
            placeholder="Search tasks"
            aria-label="Search the backlog"
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
          />
          <select
            className="in backlog__select"
            value={filters.projectId ?? ""}
            aria-label="Filter by project"
            onChange={(event) => setFilters({ ...filters, projectId: event.target.value === "" ? null : event.target.value })}
          >
            <option value="">All projects ({counted.total})</option>
            {counted.options.map((option) => (
              <option key={option.id} value={option.id} disabled={option.count === 0 && option.id !== filters.projectId}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="backlog__chips-row" role="group" aria-label="Status filter">
          {BACKLOG_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`pill ${filters.statuses.includes(status) ? "pill--on" : ""}`}
              aria-pressed={filters.statuses.includes(status)}
              onClick={() => setFilters({ ...filters, statuses: toggleBacklogStatus(filters.statuses, status) })}
            >
              {BACKLOG_STATUS_LABEL[status]}
            </button>
          ))}
        </div>
        <BoardFilterChips chips={chips} onRemove={removeChip} />
      </div>
      {groups.length === 0 && <p className="backlog__empty">{tasks.length === 0 ? "No open tasks." : "Nothing matches these filters."}</p>}
      <div className="backlog__list" role="list" aria-label="Open tasks">
        {visible.map((group) => (
          <div key={group.project.id} className="backlog__group" role="group" aria-label={group.project.title}>
            <div className="backlog__project" aria-hidden="true">
              <span>{titles.get(group.project.id) ?? group.project.title}</span>
              <span className="backlog__count">{groups.find((item) => item.project.id === group.project.id)?.tasks.length ?? group.tasks.length}</span>
            </div>
            {group.tasks.map((task) => {
              const active = task.id === current;
              const busy = busyIds.has(task.id);
              const planned = inToday.has(task.id);
              return (
                <div
                  key={task.id}
                  ref={(element) => {
                    if (element === null) rowRefs.current.delete(task.id);
                    else rowRefs.current.set(task.id, element);
                  }}
                  role="listitem"
                  tabIndex={active ? 0 : -1}
                  draggable={!busy && !planned}
                  aria-busy={busy}
                  className={`backlog__row ${active ? "backlog__row--active" : ""} ${busy ? "backlog__row--busy" : ""} ${planned ? "backlog__row--today" : ""}`}
                  onKeyDown={(event) => onRowKeyDown(event, task)}
                  onFocus={(event) => {
                    if (event.target === event.currentTarget) setActiveId(task.id);
                  }}
                  onDragStart={(event) => onDragStart(event, task)}
                  onDragEnd={() => onDragActive(false)}
                >
                  <span className="backlog__body">
                    <span className="backlog__main">
                      {task.status === "doing" && <span className="statusmark statusmark--doing" role="img" aria-label="In progress" title="In progress" />}
                      <span className="backlog__title" onClick={() => onOpen(task)}>
                        <InlineText text={task.title} />
                      </span>
                    </span>
                    <span className="backlog__meta">
                      {planned && (
                        <span className="backlog__in-today" title={isToday ? "Already in today's focus" : `Already in the focus of ${date}`}>
                          in Today
                        </span>
                      )}
                      {renderChips(task)}
                    </span>
                  </span>
                  {renderStatus(task)}
                  {!planned && (
                    <button
                      type="button"
                      className="act backlog__add"
                      tabIndex={-1}
                      disabled={busy}
                      aria-label={`Schedule ${task.title} for ${isToday ? "today" : date}`}
                      title={isToday ? "Schedule for today (T)" : `Schedule for ${date} (T)`}
                      onClick={() => onSchedule(task, date)}
                    >
                      + {isToday ? "Today" : "Day"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <ShowMoreButtons paging={paging} from="start" noun="tasks" />
      {total > 0 && <p className="backlog__keys">T today - M tomorrow - S start - D done - Enter open - drag to Focus</p>}
    </section>
  );
}
