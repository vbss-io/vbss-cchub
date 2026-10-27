import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DailyStreamEvent, TasksBoardStreamEvent } from "../api";
import {
  BOARD_STATUS_LABEL,
  candidateLabels,
  dailyItemOutOfSync,
  dailyItemRecurredToday,
  findBoardTask,
  projectBreadcrumb,
  projectOptions,
  syncFailureNotice,
} from "../board-model";
import { addToTasksDefaults, dailyLinkState, syncStatusFor } from "../daily-plan";
import {
  createBoardItem,
  getDailyLinks,
  getTasksBoard,
  patchBoardItem,
  syncBoardFromDaily,
  syncBoardTaskToDaily,
  type BoardPayload,
  type BoardStatus,
  type DailyLinkChild,
  type DailyLinkItem,
  type DailyLinks,
} from "../delegation";
import { InlineText } from "../markdown";
import { BoardPriorityBadge } from "./BoardParts";

const REFRESH_DELAY_MS = 300;

interface Props {
  date: string;
  onNotice?: (kind: "ok" | "error", text: string) => void;
  subscribeDaily: (listener: (event: DailyStreamEvent) => void) => () => void;
  subscribeBoard: (listener: (event: TasksBoardStreamEvent) => void) => () => void;
}

interface RowProps {
  item: DailyLinkItem;
  board: BoardPayload;
  busy: boolean;
  onUseDaily: (item: DailyLinkItem) => void;
  onUseBoard: (item: DailyLinkItem) => void;
  onSyncChild: (item: DailyLinkItem, child: DailyLinkChild) => void;
  onAdd: (item: DailyLinkItem, projectId: string) => void;
}

const CHECKBOX_MARK: Record<DailyLinkChild["checkbox"], string> = { todo: "[ ]", doing: "[-]", done: "[x]" };

interface ChildRowProps {
  item: DailyLinkItem;
  child: DailyLinkChild;
  busy: boolean;
  frozen: boolean;
  onSync: (item: DailyLinkItem, child: DailyLinkChild) => void;
}

function ChildRow({ item, child, busy, frozen, onSync }: ChildRowProps) {
  const target = syncStatusFor(child.checkbox);
  return (
    <li className="dtc__child" title={child.raw}>
      <span className="dtc__child-mark muted small">{CHECKBOX_MARK[child.checkbox]}</span>
      <span className="dtc__child-text">
        <InlineText text={child.text} />
      </span>
      {child.taskId === null && <span className="chip">Not in Tasks</span>}
      {child.taskStatus && <span className={`tag tag--board-${child.taskStatus}`}>{BOARD_STATUS_LABEL[child.taskStatus]}</span>}
      {!frozen && child.mismatch && child.taskId !== null && (
        <button className="act" disabled={busy} title={`Set the subtask to ${BOARD_STATUS_LABEL[target]}`} onClick={() => onSync(item, child)}>
          Sync
        </button>
      )}
    </li>
  );
}

function TaskCheckRow({ item, board, busy, onUseDaily, onUseBoard, onSyncChild, onAdd }: RowProps) {
  const state = dailyLinkState(item);
  const defaults = addToTasksDefaults(item, board.projects);
  const [projectId, setProjectId] = useState(defaults.projectId);
  const options = useMemo(() => projectOptions(board.projects), [board.projects]);
  const linked = item.taskId ? findBoardTask(board.tasks, item.taskId) : null;
  const project = linked ? (projectBreadcrumb(board.projects, linked.projectId).slice(-1)[0] ?? linked.projectId) : (item.label ?? null);
  const outOfSync = dailyItemOutOfSync(item);
  const recurred = dailyItemRecurredToday(item);
  const children = item.children ?? [];

  return (
    <li className="dtc__row">
      <span className="dtc__text" title={item.raw}>
        <InlineText text={item.text} />
      </span>
      {state === "linked" && (
        <div className="dtc__meta">
          {project && <span className="muted small">{project}</span>}
          <BoardPriorityBadge priority={item.taskPriority} />
          {item.taskStatus && <span className={`tag tag--board-${item.taskStatus}`}>{BOARD_STATUS_LABEL[item.taskStatus]}</span>}
          {recurred && (
            <span className="muted small" title="This recurring task was finished today; the open one already moved to its next date">
              recurring - done today
            </span>
          )}
          {outOfSync && (
            <>
              <button className="act" disabled={busy || !linked} title="Set the task and its subtasks from the daily" onClick={() => onUseDaily(item)}>
                Use daily
              </button>
              <button className="act" disabled={busy || !linked} title="Write the board statuses into the daily" onClick={() => onUseBoard(item)}>
                Use board
              </button>
            </>
          )}
        </div>
      )}
      {children.length > 0 && (
        <ul className="plainlist dtc__children">
          {children.map((child) => (
            <ChildRow key={`${child.line}:${child.raw}`} item={item} child={child} busy={busy} frozen={recurred} onSync={onSyncChild} />
          ))}
        </ul>
      )}
      {state === "ambiguous" && (
        <div className="dtc__meta dtc__meta--col">
          <span className="chip">Multiple matches</span>
          <ul className="dtc__candidates">
            {candidateLabels(item.candidates, board.tasks, board.projects).map((label) => (
              <li key={label} className="muted small">
                {label}
              </li>
            ))}
          </ul>
        </div>
      )}
      {state === "missing" && (
        <div className="dtc__meta">
          <span className="chip">Not in Tasks</span>
          <select className="select" aria-label={`Project for ${item.text}`} value={projectId} disabled={busy} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">Select a project</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button className="act act--focus" disabled={busy || projectId === ""} onClick={() => onAdd(item, projectId)}>
            Add to Tasks
          </button>
        </div>
      )}
    </li>
  );
}

export function DailyTasksCheck({ date, onNotice, subscribeDaily, subscribeBoard }: Props) {
  const [links, setLinks] = useState<DailyLinks | null>(null);
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const requestId = useRef(0);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    const id = (requestId.current += 1);
    try {
      const [nextLinks, nextBoard] = await Promise.all([getDailyLinks(date), getTasksBoard()]);
      if (id !== requestId.current) return;
      setLinks(nextLinks);
      setBoard(nextBoard);
      setError(null);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : "could not check the tasks");
    }
  }, [date]);

  const scheduleLoad = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void load();
    }, REFRESH_DELAY_MS);
  }, [load]);

  useEffect(() => {
    setLinks(null);
    void load();
  }, [load]);

  useEffect(() => {
    const offDaily = subscribeDaily((event) => {
      if (event.date === date) scheduleLoad();
    });
    const offBoard = subscribeBoard(scheduleLoad);
    return () => {
      offDaily();
      offBoard();
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [date, subscribeDaily, subscribeBoard, scheduleLoad]);

  const mark = (line: number, on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(line);
      else next.delete(line);
      return next;
    });

  const run = async (item: DailyLinkItem, action: () => Promise<unknown>) => {
    mark(item.line, true);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not update the task");
      await load();
    } finally {
      mark(item.line, false);
    }
  };

  const useDaily = (item: DailyLinkItem) => {
    void run(item, async () => {
      const result = await syncBoardFromDaily(item.line, date);
      const failed = result.failed ?? [];
      if (failed.length > 0) onNotice?.("error", syncFailureNotice(failed, result.updated));
    });
  };

  const useBoard = (item: DailyLinkItem) => {
    const task = board && item.taskId ? findBoardTask(board.tasks, item.taskId) : null;
    if (!task) {
      setError("That task is no longer on the board.");
      return;
    }
    void run(item, () => syncBoardTaskToDaily({ projectId: task.projectId, line: task.line, raw: task.raw }, date));
  };

  const syncChild = (item: DailyLinkItem, child: DailyLinkChild) => {
    const task = board && child.taskId ? findBoardTask(board.tasks, child.taskId) : null;
    if (!task) {
      setError("That subtask is no longer on the board.");
      return;
    }
    const status: BoardStatus = syncStatusFor(child.checkbox);
    void run(item, () => patchBoardItem({ projectId: task.projectId, line: task.line, raw: task.raw }, { status }));
  };

  const add = (item: DailyLinkItem, projectId: string) => {
    const defaults = addToTasksDefaults(item, board?.projects ?? []);
    void run(item, () => createBoardItem({ projectId, title: defaults.title, status: defaults.status }));
  };

  const missing = links ? links.items.filter((item) => dailyLinkState(item) === "missing").length : 0;
  const outOfSync = links ? links.items.filter(dailyItemOutOfSync).length : 0;

  return (
    <div className="panel daily__side dtc">
      <h3>Tasks check</h3>
      {error && <p className="error small">{error}</p>}
      {!links && !error && <p className="muted small">Loading…</p>}
      {links && !links.exists && <p className="muted small">No entry yet for {date}.</p>}
      {links && links.exists && links.items.length === 0 && <p className="muted small">No focus items to check.</p>}
      {links && links.exists && links.items.length > 0 && board && (
        <>
          <p className="muted small">
            {missing === 0 && outOfSync === 0 ? "Everything is in sync." : `${missing} not in Tasks, ${outOfSync} out of sync`}
          </p>
          <ul className="plainlist dtc__list">
            {links.items.map((item) => (
              <TaskCheckRow key={`${item.line}:${item.raw}`} item={item} board={board} busy={busy.has(item.line)} onUseDaily={useDaily} onUseBoard={useBoard} onSyncChild={syncChild} onAdd={add} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
