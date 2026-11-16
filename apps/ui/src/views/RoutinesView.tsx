import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RoutineForm } from "../components/RoutineForm";
import { RoutineRunRow } from "../components/RoutineRunRow";
import { ClampScope, ShowMoreList } from "../components/ShowMore";
import { costLabel, costTitle } from "../cost-model";
import type { WorkspaceRecord } from "../delegation";
import { errorText } from "../hub-request";
import {
  catchUpOptions,
  describeSchedule,
  formFromRoutine,
  gateNote,
  markAll,
  markItem,
  nextFireLabel,
  RUN_STATUS_LABEL,
  runTone,
  runWhen,
  targetLabel,
  unreadOf,
  type RoutineForm as RoutineFormState,
} from "../routine-model";
import {
  createRoutine,
  deleteRoutine,
  fetchRoutineDetail,
  markInboxAllRead,
  markInboxRead,
  markInboxUnread,
  runRoutineNow,
  saveRoutineSettings,
  setRoutineEnabled,
  updateRoutine,
  type RoutineSubscribe,
} from "../routines-api";
import type { RoutineInput, RoutineRecord, RoutineRunRecord } from "../types";
import { useRoutines } from "../use-routines";
import "../routines.css";

interface Props {
  workspaces: WorkspaceRecord[];
  subscribe: RoutineSubscribe;
  enabled: boolean;
  onOpenTask: (taskId: string) => void;
  onError: (text: string) => void;
}

type FormMode = { kind: "new" } | { kind: "edit"; routine: RoutineRecord } | null;

type InboxFilter = "unread" | "all";

const NOW_TICK_MS = 60_000;

function History({ routineId, version, now, onOpen }: { routineId: string; version: unknown; now: number; onOpen: (run: RoutineRunRecord) => void }) {
  const [runs, setRuns] = useState<RoutineRunRecord[] | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchRoutineDetail(routineId)
      .then((detail) => {
        if (alive) setRuns(detail.runs);
      })
      .catch(() => {
        if (alive) setRuns([]);
      });
    return () => {
      alive = false;
    };
  }, [routineId, version]);
  if (runs === null) return <p className="hint">Loading the history...</p>;
  if (runs.length === 0) return <p className="hint">No runs yet.</p>;
  return (
    <ShowMoreList
      items={runs}
      resetKey={`rt-history:${routineId}`}
      noun="runs"
      wrap={(rows) => <ul className="rt__runs">{rows}</ul>}
      render={(run) => <RoutineRunRow key={run.id} run={run} now={now} showName={false} onOpen={onOpen} />}
    />
  );
}

export function RoutinesView({ workspaces, subscribe, enabled, onOpenTask, onError }: Props) {
  const state = useRoutines(subscribe, enabled);
  const { list, inbox, settings, reload } = state;
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<InboxFilter>("unread");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState<RoutineRecord | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const act = useCallback(
    async (key: string, action: () => Promise<unknown>, fallback: string): Promise<boolean> => {
      setBusy(key);
      try {
        await action();
        await reload();
        return true;
      } catch (err) {
        onError(errorText(err, fallback));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [onError, reload],
  );

  const unread = unreadOf(inbox);
  const shown = filter === "unread" ? inbox.filter((item) => !item.read) : inbox;
  const routines = list?.routines ?? [];
  const gate = gateNote(list?.gate ?? null, list?.schedulerGate ?? null);

  const openRun = (run: RoutineRunRecord) => {
    if (run.taskId === null) return;
    if (!run.read && run.status !== "running") {
      state.setInbox(markItem(inbox, run.id, true, Date.now()));
      void markInboxRead(run.id).catch(() => undefined);
    }
    onOpenTask(run.taskId);
  };

  const toggleRead = (run: RoutineRunRecord) => {
    const read = !run.read;
    state.setInbox(markItem(inbox, run.id, read, Date.now()));
    void (read ? markInboxRead(run.id) : markInboxUnread(run.id)).catch((err: unknown) => {
      onError(errorText(err, "Could not update the inbox."));
      void reload();
    });
  };

  const readAll = () => {
    state.setInbox(markAll(inbox, Date.now()));
    void markInboxAllRead().catch((err: unknown) => {
      onError(errorText(err, "Could not update the inbox."));
      void reload();
    });
  };

  const submit = async (payload: RoutineInput) => {
    const mode = formMode;
    if (mode === null) return;
    const done = await act("form", () => (mode.kind === "edit" ? updateRoutine(mode.routine.id, payload) : createRoutine(payload)), "Could not save the routine.");
    if (done) setFormMode(null);
  };

  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const initialForm = (mode: FormMode): RoutineFormState | null => (mode !== null && mode.kind === "edit" ? formFromRoutine(mode.routine) : null);

  if (!enabled) return <p className="empty">Routines need the Delegated plugin. Turn it on in Settings, Plugins.</p>;

  return (
    <ClampScope resetKey="routines">
      <div className="rt">
        {gate !== null && (
          <p className="callout" role="status">
            {gate}
          </p>
        )}
        {state.error !== null && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}

        <section className="rt__section" aria-label="Inbox">
          <div className="rt__sectionhead">
            <h2>Inbox</h2>
            <div className="runs-origin" role="group" aria-label="Inbox filter">
              <button type="button" className={`runs-origin__btn ${filter === "unread" ? "runs-origin__btn--on" : ""}`} aria-pressed={filter === "unread"} onClick={() => setFilter("unread")}>
                Unread <span className="pill__count">{unread}</span>
              </button>
              <button type="button" className={`runs-origin__btn ${filter === "all" ? "runs-origin__btn--on" : ""}`} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
                All
              </button>
            </div>
            <span className="spacer" />
            <button type="button" className="act" disabled={unread === 0} onClick={readAll}>
              Mark all read
            </button>
          </div>
          {shown.length === 0 ? (
            <p className="hint">{filter === "unread" ? "Nothing unread. Results of your routines show up here." : "No routine has finished yet."}</p>
          ) : (
            <ShowMoreList
              items={shown}
              resetKey={`rt-inbox:${filter}`}
              noun="results"
              wrap={(rows) => <ul className="rt__runs">{rows}</ul>}
              render={(run) => <RoutineRunRow key={run.id} run={run} now={now} showName onOpen={openRun} onToggleRead={toggleRead} />}
            />
          )}
        </section>

        <section className="rt__section" aria-label="Routines">
          <div className="rt__sectionhead">
            <h2>Routines</h2>
            <span className="spacer" />
            <label className="rt__catchup">
              <span className="muted small">Missed runs</span>
              <select
                className="select"
                aria-label="Catch up a missed run"
                value={settings?.catchUpHours ?? 12}
                disabled={settings === null || busy === "settings"}
                onChange={(event) => {
                  const catchUpHours = Number(event.target.value);
                  void act("settings", async () => state.setSettings(await saveRoutineSettings({ catchUpHours })), "Could not save the setting.");
                }}
              >
                {catchUpOptions(settings?.catchUpHours ?? 12).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="act act--focus" disabled={formMode !== null} onClick={() => setFormMode({ kind: "new" })}>
              New routine
            </button>
          </div>
          <p className="hint">
            Runs missed while the hub was off are caught up once when they are newer than the limit above, otherwise they are listed as missed. A slot is never run twice.
          </p>

          {formMode !== null && (
            <RoutineForm
              key={formMode.kind === "edit" ? formMode.routine.id : "new"}
              initial={initialForm(formMode)}
              workspaces={workspaces}
              editing={formMode.kind === "edit"}
              busy={busy === "form"}
              onSubmit={(payload) => void submit(payload)}
              onCancel={() => setFormMode(null)}
            />
          )}

          {state.loaded && routines.length === 0 && formMode === null && (
            <p className="empty">No routines yet. A routine runs a prompt on a schedule and leaves its result in the inbox.</p>
          )}

          <ul className="rt__list">
            {routines.map((routine) => {
              const open = expanded.has(routine.id);
              const cost = costLabel(routine.cost);
              const last = routine.lastRun;
              return (
                <li key={routine.id} className={`rt__card ${routine.enabled ? "" : "rt__card--paused"}`}>
                  <div className="rt__cardhead">
                    <strong className="rt__name" title={routine.name}>
                      {routine.name}
                    </strong>
                    <span className="muted small">{nextFireLabel(routine, now)}</span>
                    <span className="spacer" />
                    <button type="button" className="act" disabled={busy !== null || routine.running} onClick={() => void act(`run:${routine.id}`, () => runRoutineNow(routine.id), "Could not start the routine.")}>
                      Run now
                    </button>
                    <button type="button" className="act" disabled={busy !== null} onClick={() => void act(`toggle:${routine.id}`, () => setRoutineEnabled(routine.id, !routine.enabled), "Could not change the routine.")}>
                      {routine.enabled ? "Pause" : "Resume"}
                    </button>
                    <button type="button" className="act" disabled={busy !== null || formMode !== null} onClick={() => setFormMode({ kind: "edit", routine })}>
                      Edit
                    </button>
                    <button type="button" className="act act--ghost" aria-expanded={open} onClick={() => toggleExpanded(routine.id)}>
                      History
                    </button>
                    <button type="button" className="act act--ghost" disabled={busy !== null || routine.running} onClick={() => setConfirmDelete(routine)}>
                      Delete
                    </button>
                  </div>
                  <p className="rt__meta">
                    {describeSchedule(routine.schedule)} · {routine.runner === "codex" ? "Codex" : "Claude"} · <span className="path">{targetLabel(routine)}</span>
                    {cost !== null && (
                      <>
                        {" "}
                        · <span title={costTitle(routine.cost)}>{cost} total</span>
                      </>
                    )}
                  </p>
                  {last !== null && (
                    <p className="rt__meta">
                      Last run <span className={`tag tag--${runTone(last.status)}`}>{RUN_STATUS_LABEL[last.status]}</span> {runWhen(last, now)}
                    </p>
                  )}
                  {open && <History routineId={routine.id} version={list} now={now} onOpen={openRun} />}
                </li>
              );
            })}
          </ul>
        </section>

        {confirmDelete !== null && (
          <ConfirmDialog
            title={`Delete "${confirmDelete.name}"?`}
            body="The routine and its history are removed, including its inbox results. Tasks it already ran stay in Sessions."
            confirmLabel="Delete"
            danger
            onCancel={() => setConfirmDelete(null)}
            onConfirm={() => {
              const target = confirmDelete;
              setConfirmDelete(null);
              void act(`delete:${target.id}`, () => deleteRoutine(target.id), "Could not delete the routine.");
            }}
          />
        )}
      </div>
    </ClampScope>
  );
}
