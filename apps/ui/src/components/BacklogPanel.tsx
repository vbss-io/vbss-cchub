import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import "../today.css";
import { BOARD_STATUS_LABEL, dueTone, formatDayMonth, projectOptions, subtaskProgress } from "../board-model";
import type { BoardProject, BoardTask } from "../delegation";
import {
  BACKLOG_STATUSES,
  BACKLOG_STATUS_LABEL,
  backlogGroups,
  backlogKeyIntent,
  countBacklog,
  DEFAULT_BACKLOG_FILTERS,
  encodeDragTarget,
  TODAY_DRAG_MIME,
  targetOfTask,
  toggleBacklogStatus,
  type BacklogFilters,
} from "../today-model";

interface BacklogPanelProps {
  tasks: BoardTask[];
  projects: BoardProject[];
  projectOrder: readonly string[];
  excluded: ReadonlySet<string>;
  date: string;
  today: string;
  busyIds: ReadonlySet<string>;
  onSchedule: (task: BoardTask, date: string) => void;
  onDone: (task: BoardTask) => void;
  onOpen: (task: BoardTask) => void;
  onDragActive: (active: boolean) => void;
  nextDate: string;
}

const priorityTone = (priority: number): number => Math.min(priority, 3);

export function BacklogPanel({ tasks, projects, projectOrder, excluded, date, today, busyIds, onSchedule, onDone, onOpen, onDragActive, nextDate }: BacklogPanelProps) {
  const [filters, setFilters] = useState<BacklogFilters>(DEFAULT_BACKLOG_FILTERS);
  const [activeId, setActiveId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const lastIndex = useRef(0);
  const restoreFocus = useRef(false);

  const groups = useMemo(() => backlogGroups(tasks, projects, projectOrder, excluded, filters), [tasks, projects, projectOrder, excluded, filters]);
  const flat = useMemo(() => groups.flatMap((group) => group.tasks), [groups]);
  const total = countBacklog(groups);
  const options = useMemo(() => projectOptions(projects), [projects]);
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
    restoreFocus.current = true;
    if (intent === "today") onSchedule(task, date);
    else if (intent === "tomorrow") onSchedule(task, nextDate);
    else onDone(task);
  };

  const onDragStart = (event: ReactDragEvent<HTMLElement>, task: BoardTask) => {
    const payload = encodeDragTarget(targetOfTask(task));
    event.dataTransfer.setData(TODAY_DRAG_MIME, payload);
    event.dataTransfer.setData("text/plain", task.title);
    event.dataTransfer.effectAllowed = "move";
    onDragActive(true);
  };

  const renderChips = (task: BoardTask) => {
    const tone = dueTone(task.due ?? null, task.status, today);
    const progress = subtaskProgress(task);
    return (
      <span className="backlog__chips">
        {task.status !== "todo" && <span className={`tag tag--board-${task.status}`}>{BOARD_STATUS_LABEL[task.status]}</span>}
        {task.priority !== null && (
          <span className={`chip board-prio board-prio--${priorityTone(task.priority)}`} title={`Priority P${task.priority}`}>
            P{task.priority}
          </span>
        )}
        {task.scheduled != null && (
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

  return (
    <section className="backlog" aria-label="Backlog">
      <header className="backlog__head">
        <h3>
          Backlog <span className="backlog__count">{total}</span>
        </h3>
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
          <option value="">All projects</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
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
      {groups.length === 0 && <p className="backlog__empty">{tasks.length === 0 ? "No open tasks." : "Nothing matches these filters."}</p>}
      <div className="backlog__list" role="list" aria-label="Open tasks">
        {groups.map((group) => (
          <div key={group.project.id} className="backlog__group" role="group" aria-label={group.project.title}>
            <div className="backlog__project" aria-hidden="true">
              <span>{titles.get(group.project.id) ?? group.project.title}</span>
              <span className="backlog__count">{group.tasks.length}</span>
            </div>
            {group.tasks.map((task) => {
              const active = task.id === current;
              const busy = busyIds.has(task.id);
              return (
                <div
                  key={task.id}
                  ref={(element) => {
                    if (element === null) rowRefs.current.delete(task.id);
                    else rowRefs.current.set(task.id, element);
                  }}
                  role="listitem"
                  tabIndex={active ? 0 : -1}
                  draggable={!busy}
                  aria-busy={busy}
                  className={`backlog__row ${active ? "backlog__row--active" : ""} ${busy ? "backlog__row--busy" : ""}`}
                  onKeyDown={(event) => onRowKeyDown(event, task)}
                  onFocus={(event) => {
                    if (event.target === event.currentTarget) setActiveId(task.id);
                  }}
                  onDragStart={(event) => onDragStart(event, task)}
                  onDragEnd={() => onDragActive(false)}
                >
                  <button type="button" className="backlog__title" tabIndex={-1} onClick={() => onOpen(task)}>
                    {task.title}
                  </button>
                  {renderChips(task)}
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
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {total > 0 && <p className="backlog__keys">T today - M tomorrow - D done - Enter open - drag to Focus</p>}
    </section>
  );
}
