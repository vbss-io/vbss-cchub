import { costLabel, costTitle } from "../cost-model";
import { RUN_STATUS_LABEL, runDetail, runOpens, runTone, runWhen, TRIGGER_LABEL } from "../routine-model";
import type { RoutineRunRecord } from "../types";
import { ClampText } from "./ShowMore";

interface Props {
  run: RoutineRunRecord;
  now: number;
  showName: boolean;
  onOpen: (run: RoutineRunRecord) => void;
  onToggleRead?: (run: RoutineRunRecord) => void;
}

export function RoutineRunRow({ run, now, showName, onOpen, onToggleRead }: Props) {
  const cost = costLabel(run.cost);
  const detail = runDetail(run);
  const finished = run.status !== "running";
  return (
    <li className={`rt__run ${finished && !run.read ? "rt__run--unread" : ""}`}>
      <div className="rt__runhead">
        <span className={`tag tag--${runTone(run.status)}`} data-status={run.status}>
          {RUN_STATUS_LABEL[run.status]}
        </span>
        {showName && <span className="rt__runname">{run.routineName ?? "Routine"}</span>}
        <span className="muted small">
          {TRIGGER_LABEL[run.trigger]} · {runWhen(run, now)}
        </span>
        {cost !== null && (
          <span className="muted small" title={costTitle(run.cost)}>
            {cost}
          </span>
        )}
        <span className="spacer" />
        {runOpens(run) && (
          <button type="button" className="act" onClick={() => onOpen(run)}>
            Open run
          </button>
        )}
        {onToggleRead && finished && (
          <button type="button" className="act act--ghost" onClick={() => onToggleRead(run)}>
            {run.read ? "Mark unread" : "Mark read"}
          </button>
        )}
      </div>
      {detail !== null && <p className="rt__detail">{detail}</p>}
      {run.summary && (
        <ClampText className="rt__summary" lines={3} scopeKey={`rt-run:${run.id}`}>
          {run.summary}
        </ClampText>
      )}
    </li>
  );
}
