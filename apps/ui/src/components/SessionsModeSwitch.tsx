import { sessionsModeOptions, type SessionsMode } from "../sessions-mode";

export function SessionsModeSwitch({ mode, flowOn, onMode }: { mode: SessionsMode; flowOn: boolean; onMode: (mode: SessionsMode) => void }) {
  return (
    <div className="runs-origin runs-mode" role="group" aria-label="View">
      {sessionsModeOptions(flowOn).map((item) => (
        <button
          key={item.key}
          type="button"
          className={`runs-origin__btn ${mode === item.key ? "runs-origin__btn--on" : ""}`}
          aria-pressed={mode === item.key}
          onClick={() => onMode(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
