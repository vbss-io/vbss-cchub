import type { SessionsMode } from "../sessions-mode";

const MODES: readonly { key: SessionsMode; label: string }[] = [
  { key: "list", label: "List" },
  { key: "map", label: "Map" },
];

export function SessionsModeSwitch({ mode, onMode }: { mode: SessionsMode; onMode: (mode: SessionsMode) => void }) {
  return (
    <div className="runs-origin runs-mode" role="group" aria-label="View">
      {MODES.map((item) => (
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
