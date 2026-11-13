import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDayMonth } from "../board-model";
import {
  closeYesterday,
  composeDaily,
  DailyExistsError,
  prepareDaily,
  type BoardTask,
  type DailyPrepare,
  type TodayData,
} from "../delegation";
import { renderInline } from "../markdown";
import {
  broughtLines,
  closeYesterdayBody,
  composeStartDay,
  noteOnlyLines,
  pendingLineKeys,
  planDraftKey,
  planYesterday,
  trailSummary,
  type LineChoice,
  type YesterdayItem,
} from "../today-model";

interface Props {
  date: string;
  isToday: boolean;
  noteExists: boolean;
  data: TodayData;
  tasks: readonly BoardTask[];
  busyIds: ReadonlySet<string>;
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

const messageOf = (error: unknown, fallback: string): string => (error instanceof Error && error.message !== "" ? error.message : fallback);

const clearPlanDraft = (date: string): void => {
  try {
    window.localStorage.removeItem(planDraftKey(date));
  } catch {
    return;
  }
};

export function StartDayPanel({ date, isToday, noteExists, data, tasks, busyIds, onBring, onTomorrow, onDrop, onBringAll, onOpenTask, onCreated, onRefine, onClassic, onClose, onError }: Props) {
  const [prepare, setPrepare] = useState<DailyPrepare | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, LineChoice>>({});
  const [useSummary, setUseSummary] = useState(true);
  const [meetingsText, setMeetingsText] = useState("");
  const [closeYesterdayToo, setCloseYesterdayToo] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    prepareDaily(date)
      .then((next) => {
        if (alive) setPrepare(next);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(messageOf(err, "could not load yesterday"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [date]);

  useEffect(() => {
    setChoices({});
    setPrepare(null);
    setCreateError(null);
    return load();
  }, [load]);

  const plan = useMemo(() => planYesterday(prepare?.yesterday ?? null, data.carriedOver, tasks, noteOnlyLines(data)), [prepare, data, tasks]);
  const summary = useMemo(() => trailSummary(prepare), [prepare]);
  const yesterday = prepare?.yesterday ?? null;
  const canClose = yesterday !== null && !yesterday.closed;
  const hasOpen = plan.open.length > 0;

  const choose = (key: string, choice: LineChoice | null) =>
    setChoices((current) => {
      const next = { ...current };
      if (choice === null) delete next[key];
      else next[key] = choice;
      return next;
    });

  const bringAll = () => {
    setChoices((current) => {
      const next = { ...current };
      for (const key of pendingLineKeys(plan.open, current)) next[key] = "bring";
      return next;
    });
    if (data.carriedOver.length > 0) onBringAll();
  };

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      if (canClose && closeYesterdayToo && yesterday !== null) await closeYesterday(date, closeYesterdayBody(yesterday));
      await composeDaily(date, composeStartDay({ summary, useSummary: summary !== "" && useSummary, meetingsText, lines: broughtLines(plan.open, choices) }));
      clearPlanDraft(date);
      await onCreated();
    } catch (err) {
      if (err instanceof DailyExistsError) {
        setCreateError("A note for this day already exists.");
        await onCreated();
      } else {
        const message = messageOf(err, "could not create the note");
        setCreateError(message);
        onError(message);
      }
    } finally {
      setCreating(false);
    }
  };

  const renderItem = (item: YesterdayItem) => {
    if (item.kind === "task") {
      const { entry } = item;
      const busy = busyIds.has(entry.task.id);
      const from = formatDayMonth(entry.task.scheduled ?? null);
      return (
        <li key={item.key} className={`today__row today__carried-row ${busy ? "today__row--busy" : ""}`}>
          <div className="today__carried-main">
            <span className="today__carried-project">{entry.project.title}</span>
            <span className="today__carried-line">
              {entry.task.status === "doing" && <span className="statusmark statusmark--doing" role="img" aria-label="In progress" title="In progress" />}
              <button type="button" className="linklike today__carried-title" onClick={() => onOpenTask(entry.task)}>
                {entry.task.title}
              </button>
            </span>
          </div>
          {from !== "" && (
            <span className="chip" title={`Scheduled for ${entry.task.scheduled}`}>
              {from}
            </span>
          )}
          <span className="today__actions">
            <button type="button" className="act" disabled={busy} title={`Schedule for ${date}`} onClick={() => onBring(entry.task)}>
              {isToday ? "Bring to today" : "Bring here"}
            </button>
            <button type="button" className="act" disabled={busy} onClick={() => onTomorrow(entry.task)}>
              Tomorrow
            </button>
            <button type="button" className="act" disabled={busy} title="Remove the schedule; the task stays in its project" onClick={() => onDrop(entry.task)}>
              Drop
            </button>
          </span>
        </li>
      );
    }
    const choice = choices[item.key];
    return (
      <li key={item.key} className="today__row today__carried-row">
        <div className="today__carried-main">
          <span className="today__carried-project">From the note</span>
          <span className="today__carried-line">
            {item.line.state === "doing" && <span className="statusmark statusmark--doing" role="img" aria-label="In progress" title="In progress" />}
            <span className={`today__text ${choice === "drop" ? "today__struck" : ""}`}>{renderInline(item.line.text, `start-${item.line.line}`)}</span>
          </span>
        </div>
        <span className="today__actions">
          {choice === undefined ? (
            <>
              <button type="button" className="act" onClick={() => choose(item.key, "bring")}>
                {isToday ? "Bring to today" : "Bring here"}
              </button>
              <button type="button" className="act" onClick={() => choose(item.key, "drop")}>
                Drop
              </button>
            </>
          ) : (
            <>
              <span className="chip">{choice === "bring" ? "Brought" : "Dropped"}</span>
              <button type="button" className="act" onClick={() => choose(item.key, null)}>
                Undo
              </button>
            </>
          )}
        </span>
      </li>
    );
  };

  return (
    <section className="today__section startday" aria-label="Start the day">
      <header className="today__section-head">
        <h3>Start the day</h3>
        {noteExists && (
          <button type="button" className="act" onClick={onClose}>
            Close
          </button>
        )}
      </header>

      {loadError !== null && (
        <div className="daily__banner" role="alert">
          <span>{loadError}</span>
          <button type="button" className="act" onClick={() => load()}>
            Retry
          </button>
        </div>
      )}

      <div className="startday__block" aria-label="From yesterday">
        <div className="today__section-head">
          <h4 className="startday__title">
            From yesterday <span className="today__count">{plan.open.length}</span>
          </h4>
          {hasOpen && (
            <button type="button" className="act" disabled={plan.open.every((item) => item.kind === "task" && busyIds.has(item.entry.task.id))} onClick={bringAll}>
              Bring all
            </button>
          )}
        </div>
        {loading && <p className="today__empty">Loading…</p>}
        {!loading && !hasOpen && <p className="today__empty">{yesterday === null && plan.done.length === 0 ? "Nothing from yesterday." : "Nothing left open from yesterday."}</p>}
        {hasOpen && <ul className="today__list">{plan.open.map(renderItem)}</ul>}
        {plan.done.length > 0 && (
          <details className="startday__done">
            <summary>Done yesterday ({plan.done.length})</summary>
            <ul className="today__plain">
              {plan.done.map((line) => (
                <li key={line.line} className="today__text startday__done-line">
                  {renderInline(line.text, `done-${line.line}`)}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {!noteExists && summary !== "" && (
        <div className="startday__block" aria-label="Yesterday's summary">
          <h4 className="startday__title">Yesterday's summary</h4>
          <p className="startday__summary">{summary}</p>
          <label className="today__check">
            <input type="checkbox" checked={useSummary} onChange={(event) => setUseSummary(event.target.checked)} />
            Use as the note's summary
          </label>
        </div>
      )}

      {!noteExists && (
        <div className="startday__block" aria-label="Meetings">
          <label className="field">
            <span className="startday__title">Meetings</span>
            <textarea
              className="in startday__meetings"
              rows={3}
              value={meetingsText}
              placeholder="One meeting per line"
              aria-label="Meetings, one per line"
              onChange={(event) => setMeetingsText(event.target.value)}
            />
          </label>
        </div>
      )}

      {!noteExists && canClose && yesterday !== null && (
        <label className="today__check">
          <input type="checkbox" checked={closeYesterdayToo} onChange={(event) => setCloseYesterdayToo(event.target.checked)} />
          Close yesterday's note ({yesterday.date})
        </label>
      )}

      {noteExists ? (
        <p className="hint">Today's note already exists. Meetings, captures and the summary live in the note.</p>
      ) : (
        <div className="startday__foot">
          <button type="button" className="act act--focus startday__primary" disabled={creating || loading} onClick={() => void create()}>
            {creating ? "Creating…" : isToday ? "Create today's note" : "Create note"}
          </button>
          {createError !== null && (
            <span className="error small" role="alert">
              {createError}
            </span>
          )}
          <span className="startday__links">
            <button type="button" className="linklike" onClick={onRefine}>
              Refine with assistant
            </button>
            <button type="button" className="linklike" onClick={onClassic}>
              Classic planner
            </button>
          </span>
        </div>
      )}
    </section>
  );
}
