import { useCallback, useEffect, useRef, useState } from "react";
import { BOARD_STATUS_LABEL } from "../board-model";
import { getTodaySubtasks, planTodaySubtask, type TodaySubtaskOption } from "../delegation";
import { InlineText } from "../markdown";
import { createSubtaskQueue, type SubtaskQueue } from "../subtask-queue";

export interface SubtaskPickerTarget {
  projectId: string;
  line: number;
  title: string;
}

interface Props {
  date: string;
  target: SubtaskPickerTarget;
  onClose: () => void;
  onChanged: () => void;
}

const SETTLE_MS = 120;

const messageOf = (err: unknown): string => (err instanceof Error && err.message !== "" ? err.message : "Something went wrong");

export function TodaySubtaskPicker({ date, target, onClose, onChanged }: Props) {
  const [items, setItems] = useState<TodaySubtaskOption[] | null>(null);
  const [wanted, setWanted] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef<TodaySubtaskOption[]>([]);
  const mounted = useRef(true);
  const queue = useRef<SubtaskQueue | null>(null);

  const replaceItems = useCallback((next: TodaySubtaskOption[]) => {
    itemsRef.current = next;
    if (mounted.current) setItems(next);
  }, []);

  const load = useCallback(async () => {
    try {
      const result = await getTodaySubtasks(date, target.projectId, target.line);
      replaceItems(result.subtasks);
    } catch (err) {
      if (!mounted.current) return;
      setError(messageOf(err));
      setItems((current) => current ?? []);
    }
  }, [date, target.projectId, target.line, replaceItems]);

  const latest = useRef({ date, load, onChanged, replaceItems });
  latest.current = { date, load, onChanged, replaceItems };

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (queue.current === null) {
    queue.current = createSubtaskQueue(
      {
        send: async (id, planned) => {
          const item = itemsRef.current.find((candidate) => candidate.id === id);
          if (item === undefined) return;
          const result = await planTodaySubtask(latest.current.date, { projectId: item.projectId, line: item.line, raw: item.raw, planned });
          latest.current.replaceItems(result.subtasks);
        },
        onFailed: (id, err) => {
          if (!mounted.current) return;
          setError(messageOf(err));
          setWanted((current) => {
            const { [id]: _dropped, ...rest } = current;
            return rest;
          });
        },
        onDrained: () => {
          latest.current.onChanged();
          if (mounted.current) setWanted({});
          void latest.current.load();
        },
      },
      SETTLE_MS,
    );
  }

  const toggle = (item: TodaySubtaskOption) => {
    if (item.duplicate) return;
    const next = !(wanted[item.id] ?? item.inToday);
    setError(null);
    setWanted((current) => ({ ...current, [item.id]: next }));
    queue.current?.request(item.id, next, item.inToday);
  };

  return (
    <div className="modal__overlay" onClick={onClose}>
      <div className="modal modal--small subtask-picker" role="dialog" aria-modal="true" aria-label={`Plan subtasks of ${target.title}`} onClick={(event) => event.stopPropagation()}>
        <header className="modal__header">
          <h2>Plan subtasks</h2>
        </header>
        <div className="modal__body">
          <p className="hint subtask-picker__parent">
            <InlineText text={target.title} />
          </p>
          {items === null ? (
            <p className="hint">Loading...</p>
          ) : items.length === 0 ? (
            <p className="hint">No open subtasks.</p>
          ) : (
            <ul className="subtask-picker__list">
              {items.map((item) => (
                <li key={item.id} className="subtask-picker__item">
                  <label className={`subtask-picker__row ${item.duplicate ? "subtask-picker__row--off" : ""}`}>
                    <input type="checkbox" checked={wanted[item.id] ?? item.inToday} disabled={item.duplicate} onChange={() => toggle(item)} />
                    <span className="subtask-picker__title">
                      <InlineText text={item.title} />
                    </span>
                    {item.status !== "todo" && <span className={`tag tag--board-${item.status}`}>{BOARD_STATUS_LABEL[item.status]}</span>}
                  </label>
                  {item.duplicate && <span className="subtask-picker__note">Another subtask has the same title. Rename one in its project to plan it here.</span>}
                </li>
              ))}
            </ul>
          )}
          {error !== null && (
            <p className="error small" role="alert">
              {error}
            </p>
          )}
          <p className="subtask-picker__note">Checked subtasks get this day as their scheduled date and a line under the task in the daily note.</p>
        </div>
        <footer className="modal__footer">
          <button type="button" className="act act--focus" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
