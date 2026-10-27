import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import { BOARD_STATUS_LABEL, type TimelineZoom } from "../board-model";
import type { BoardProject, BoardTask } from "../delegation";
import { IconChevron } from "../icons";
import { InlineText } from "../markdown";
import { barGeometry, buildTimeline, clipLabel, parseDay, spanLabel, timelineScale, type TimelineRow } from "../timeline-model";
import { BoardPriorityBadge, BoardRepeatMark } from "./BoardParts";

const TODAY_LEAD_PX = 160;
const WEEK_DAYS = 7;

interface Props {
  tasks: BoardTask[];
  projects: BoardProject[];
  projectOrder: readonly string[];
  breadcrumbs: ReadonlyMap<string, string>;
  zoom: TimelineZoom;
  today: string;
  levels?: number | null;
  collapsed: ReadonlySet<string>;
  undatedOpen: boolean;
  jumpToToday: number;
  onToggleGroup: (projectId: string) => void;
  onToggleUndated: () => void;
  onOpen: (task: BoardTask) => void;
}

function barClass(row: TimelineRow): string {
  const span = row.span;
  if (span === null) return "";
  const tone = row.overdue ? "overdue" : row.task.status;
  return `tl__bar tl__bar--${tone} ${span.kind === "open" ? "tl__bar--open" : ""}`;
}

const clipClass = (row: TimelineRow): string => {
  if (row.clip === "none") return "";
  return [row.clip !== "after" ? "tl__item--clip-before" : "", row.clip !== "before" ? "tl__item--clip-after" : ""].filter(Boolean).join(" ");
};

function TimelineTrackItem({ row, left, width }: { row: TimelineRow; left: number; width: number }) {
  const span = row.span;
  if (span === null) return null;
  const note = clipLabel(row);
  const label = `${row.task.title} (${note === "" ? spanLabel(span) : note})`;
  const clip = clipClass(row);
  if (span.kind === "milestone") {
    const tone = row.overdue ? "overdue" : row.task.status;
    return (
      <span className={`tl__item ${clip}`} style={{ left, width }} title={label}>
        <span className={`tl__mark tl__mark--${tone}`} />
      </span>
    );
  }
  return <span className={`tl__item ${barClass(row)} ${clip}`} style={{ left, width }} title={label} />;
}

function TimelineRowView({ row, props, geometry }: { row: TimelineRow; props: Props; geometry: { left: number; width: number } | null }) {
  const { task } = row;
  const open = () => props.onOpen(task);
  const note = clipLabel(row);
  const label = row.span === null ? task.title : `${task.title}, ${note === "" ? spanLabel(row.span) : note}`;
  return (
    <div
      className={`tl__row tl__row--task ${task.status === "done" ? "tl__row--done" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`Open details of ${label}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) open();
      }}
    >
      <div className="tl__label" style={{ paddingLeft: `calc(10px + ${row.depth} * 16px)` }}>
        <BoardPriorityBadge priority={task.priority} levels={props.levels} />
        <span className="tl__title" title={task.title}>
          <InlineText text={task.title} />
        </span>
        <BoardRepeatMark task={task} />
        <span className={`tag tag--board-${task.status}`}>{BOARD_STATUS_LABEL[task.status]}</span>
      </div>
      <div className="tl__track">{geometry && <TimelineTrackItem row={row} left={geometry.left} width={geometry.width} />}</div>
    </div>
  );
}

export function BoardTimeline(props: Props) {
  const { tasks, projects, projectOrder, breadcrumbs, zoom, today, collapsed, undatedOpen, jumpToToday } = props;
  const scroller = useRef<HTMLDivElement | null>(null);
  const layout = useMemo(() => buildTimeline(tasks, projects, projectOrder, today, zoom), [tasks, projects, projectOrder, today, zoom]);
  const scale = useMemo(() => timelineScale(layout.range, zoom), [layout.range, zoom]);
  const { range } = layout;
  const trackWidth = range.dayCount * range.dayWidth;
  const step = (zoom === "week" ? 1 : WEEK_DAYS) * range.dayWidth;
  const todayDay = parseDay(today);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollLeft = Math.max(0, layout.todayX - TODAY_LEAD_PX);
  }, [zoom, jumpToToday]);

  const style = { "--tl-track": `${trackWidth}px`, "--tl-step": `${step}px` } as CSSProperties;
  const total = layout.groups.reduce((sum, group) => sum + group.rows.length, 0);

  return (
    <div className="tl-wrap">
      <div className="tl" ref={scroller}>
        <div className="tl__grid" style={style} role="group" aria-label="Task timeline">
          <div className="tl__row tl__row--head">
            <div className="tl__label tl__label--head">Task</div>
            <div className="tl__track tl__scale">
              {scale.top.map((tick) => (
                <span key={`t${tick.left}`} className="tl__tick tl__tick--top" style={{ left: tick.left, width: tick.width }} title={tick.title}>
                  {tick.label}
                </span>
              ))}
              {scale.bottom.map((tick) => (
                <span
                  key={`b${tick.left}`}
                  className={`tl__tick tl__tick--bottom ${tick.weekend ? "tl__tick--weekend" : ""}`}
                  style={{ left: tick.left, width: tick.width }}
                  title={tick.title}
                >
                  {tick.label}
                </span>
              ))}
            </div>
          </div>
          {layout.groups.map((group) => {
            const isCollapsed = collapsed.has(group.project.id);
            const name = breadcrumbs.get(group.project.id) ?? group.project.title;
            return (
              <div key={group.project.id} className="tl__group">
                <div className="tl__row tl__row--group">
                  <div className="tl__label tl__label--group">
                    <button
                      className={`board-group__toggle ${isCollapsed ? "" : "board-group__toggle--open"}`}
                      aria-expanded={!isCollapsed}
                      title={name}
                      onClick={() => props.onToggleGroup(group.project.id)}
                    >
                      <IconChevron />
                      <span className="board-group__name">{name}</span>
                      <span className="pill__count">{group.rows.length}</span>
                    </button>
                  </div>
                  <div className="tl__track tl__track--group" />
                </div>
                {!isCollapsed &&
                  group.rows.map((row) => (
                    <TimelineRowView
                      key={row.task.id}
                      row={row}
                      props={props}
                      geometry={row.visible === null ? null : barGeometry(row.visible, range)}
                    />
                  ))}
              </div>
            );
          })}
          {todayDay !== null && <div className="tl__today" style={{ left: `calc(var(--tl-label) + ${layout.todayX}px)` }} title={`Today, ${today}`} aria-hidden="true" />}
        </div>
      </div>
      {total === 0 && <p className="tl__empty muted small">No task has dates yet. Open a task and set its Start and Due dates.</p>}
      <div className="tl-undated">
        <button
          className={`board-group__toggle ${undatedOpen ? "board-group__toggle--open" : ""}`}
          aria-expanded={undatedOpen}
          onClick={props.onToggleUndated}
        >
          <IconChevron />
          <span className="board-group__name">No dates</span>
          <span className="pill__count">{layout.undated.length}</span>
        </button>
        {undatedOpen && layout.undated.length === 0 && <p className="tl__empty muted small">Every task shown here has dates.</p>}
        {undatedOpen && layout.undated.length > 0 && (
          <ul className="tl-undated__list plainlist">
            {layout.undated.map((task) => (
              <li key={task.id}>
                <div
                  className="tl-undated__item"
                  role="button"
                  tabIndex={0}
                  aria-label={`Open details of ${task.title}`}
                  onClick={() => props.onOpen(task)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      props.onOpen(task);
                    }
                  }}
                >
                  <span className="tl-undated__prio">
                    <BoardPriorityBadge priority={task.priority} levels={props.levels} />
                  </span>
                  <span className="tl-undated__title" title={task.title}>
                    <InlineText text={task.title} />
                  </span>
                  <span className="tl-undated__project muted small" title={breadcrumbs.get(task.projectId) ?? task.projectId}>
                    {breadcrumbs.get(task.projectId) ?? task.projectId}
                  </span>
                  <span className="tl-undated__status">
                    <span className={`tag tag--board-${task.status}`}>{BOARD_STATUS_LABEL[task.status]}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
