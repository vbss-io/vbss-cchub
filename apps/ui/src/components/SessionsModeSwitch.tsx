import { sessionsModeOptions, type SessionsMode } from "../sessions-mode";

interface Props {
  mode: SessionsMode;
  flowOn: boolean;
  delegatedOn?: boolean;
  routineUnread?: number;
  onMode: (mode: SessionsMode) => void;
}

export function SessionsModeSwitch({ mode, flowOn, delegatedOn = false, routineUnread = 0, onMode }: Props) {
  return (
    <div className="runs-origin runs-mode" role="group" aria-label="View">
      {sessionsModeOptions(flowOn, delegatedOn).map((item) => (
        <button
          key={item.key}
          type="button"
          className={`runs-origin__btn ${mode === item.key ? "runs-origin__btn--on" : ""}`}
          aria-pressed={mode === item.key}
          onClick={() => onMode(item.key)}
        >
          {item.label}
          {item.key === "routines" && routineUnread > 0 && <span className="pill__count">{routineUnread}</span>}
        </button>
      ))}
    </div>
  );
}
