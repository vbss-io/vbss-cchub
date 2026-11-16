import { useEffect, useMemo, useState } from "react";
import type { WorkspaceRecord } from "../delegation";
import {
  buildPayload,
  emptyRoutineForm,
  EVERY_HOURS_MAX,
  EVERY_HOURS_MIN,
  formatLocalTime,
  formProblem,
  NAME_MAX,
  SCHEDULE_KINDS,
  scheduleFromForm,
  toggleDay,
  WEEKDAY_SHORT,
  type RoutineForm as RoutineFormState,
  type ScheduleKind,
} from "../routine-model";
import { previewSchedule } from "../routines-api";
import type { RoutineInput, RoutineSchedule } from "../types";

interface Props {
  initial: RoutineFormState | null;
  workspaces: WorkspaceRecord[];
  editing: boolean;
  busy: boolean;
  onSubmit: (payload: RoutineInput) => void;
  onCancel: () => void;
}

const DAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

export function RoutineForm({ initial, workspaces, editing, busy, onSubmit, onCancel }: Props) {
  const [form, setForm] = useState<RoutineFormState>(() => initial ?? emptyRoutineForm(workspaces[0]?.name ?? ""));
  const [next, setNext] = useState<number[]>([]);
  const patch = (change: Partial<RoutineFormState>) => setForm((current) => ({ ...current, ...change }));
  const problem = formProblem(form);
  const schedule = useMemo(() => scheduleFromForm(form), [form.scheduleKind, form.time, form.days, form.everyHours]);
  const repos = workspaces.find((item) => item.name === form.workspace)?.repos ?? [];
  const scheduleKey = typeof schedule === "string" ? null : JSON.stringify(schedule);

  useEffect(() => {
    if (scheduleKey === null) {
      setNext([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void previewSchedule(JSON.parse(scheduleKey) as RoutineSchedule)
        .then((result) => {
          if (alive) setNext(result.next.slice(0, 3));
        })
        .catch(() => {
          if (alive) setNext([]);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [scheduleKey]);

  const submit = () => {
    const payload = buildPayload(form);
    if (typeof payload !== "string") onSubmit(payload);
  };

  const now = Date.now();

  return (
    <section className="panel rt__form" aria-label={editing ? "Edit routine" : "New routine"}>
      <h3>{editing ? "Edit routine" : "New routine"}</h3>
      <div className="form">
        <label className="field">
          <span>Name</span>
          <input className="in" value={form.name} maxLength={NAME_MAX} placeholder="Morning triage" onChange={(event) => patch({ name: event.target.value })} />
        </label>
        <label className="field">
          <span>What it should do</span>
          <textarea className="in area" value={form.prompt} placeholder="Read the board, list what is blocked and write a short summary." onChange={(event) => patch({ prompt: event.target.value })} />
          <small>The agent runs this prompt each time. Its summary lands in the inbox.</small>
        </label>
        <div className="rt__row">
          <label className="field rt__grow">
            <span>Runs in</span>
            <select className="select" value={form.target} onChange={(event) => patch({ target: event.target.value === "cwd" ? "cwd" : "workspace" })}>
              <option value="workspace">A workspace</option>
              <option value="cwd">A folder</option>
            </select>
          </label>
          {form.target === "workspace" ? (
            <>
              <label className="field rt__grow">
                <span>Workspace</span>
                <select className="select" value={form.workspace} onChange={(event) => patch({ workspace: event.target.value, repo: "" })}>
                  {form.workspace === "" && <option value="">Pick a workspace</option>}
                  {workspaces.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                  {form.workspace !== "" && !workspaces.some((item) => item.name === form.workspace) && <option value={form.workspace}>{form.workspace}</option>}
                </select>
              </label>
              <label className="field rt__grow">
                <span>Repo</span>
                <select className="select" value={form.repo} onChange={(event) => patch({ repo: event.target.value })}>
                  <option value="">Workspace default</option>
                  {repos.map((repo) => (
                    <option key={repo.name} value={repo.name}>
                      {repo.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <label className="field rt__grow rt__wide">
              <span>Folder</span>
              <input className="in" value={form.cwd} placeholder="Absolute path of a folder"onChange={(event) => patch({ cwd: event.target.value })} />
            </label>
          )}
        </div>
        <div className="rt__row">
          <label className="field rt__grow">
            <span>Agent</span>
            <select className="select" value={form.runner} onChange={(event) => patch({ runner: event.target.value === "codex" ? "codex" : "claude" })}>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label className="field rt__grow">
            <span>Schedule</span>
            <select className="select" value={form.scheduleKind} onChange={(event) => patch({ scheduleKind: event.target.value as ScheduleKind })}>
              {SCHEDULE_KINDS.map((kind) => (
                <option key={kind.key} value={kind.key}>
                  {kind.label}
                </option>
              ))}
            </select>
          </label>
          {form.scheduleKind !== "interval" && (
            <label className="field">
              <span>Time</span>
              <input className="in rt__time" type="time" value={form.time} onChange={(event) => patch({ time: event.target.value })} />
            </label>
          )}
          {form.scheduleKind === "interval" && (
            <label className="field">
              <span>Every (hours)</span>
              <input className="in rt__time" inputMode="numeric" value={form.everyHours} aria-describedby="rt-hours-hint" onChange={(event) => patch({ everyHours: event.target.value })} />
            </label>
          )}
        </div>
        {form.scheduleKind === "weekdays" && (
          <div className="rt__days" role="group" aria-label="Days">
            {DAY_ORDER.map((day) => (
              <button key={day} type="button" className={`pill ${form.days.includes(day) ? "pill--on" : ""}`} aria-pressed={form.days.includes(day)} onClick={() => patch({ days: toggleDay(form.days, day) })}>
                {WEEKDAY_SHORT[day]}
              </button>
            ))}
          </div>
        )}
        {form.scheduleKind === "interval" && (
          <small id="rt-hours-hint" className="hint">
            From {EVERY_HOURS_MIN} to {EVERY_HOURS_MAX} hours. Times are in this computer's local time.
          </small>
        )}
        {next.length > 0 && <p className="hint">Next: {next.map((at) => formatLocalTime(at, now)).join(" · ")}</p>}
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />
          Turned on
        </label>
        {problem !== null && <p className="hint">{problem}</p>}
        <div className="actions">
          <button type="button" className="act act--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="act act--focus" disabled={busy || problem !== null} onClick={submit}>
            {editing ? "Save routine" : "Create routine"}
          </button>
        </div>
      </div>
    </section>
  );
}
