import { useEffect, useState } from "react";

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  checkbox?: { label: string; initial?: boolean };
  onCancel: () => void;
  onConfirm: (checked: boolean) => void;
}

export function ConfirmDialog({ title, body, confirmLabel, danger = false, checkbox, onCancel, onConfirm }: Props) {
  const [checked, setChecked] = useState(checkbox?.initial ?? false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal__overlay" onClick={onCancel}>
      <div className="modal modal--small" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header className="modal__header">
          <h2>{title}</h2>
        </header>
        <div className="modal__body">
          <p className="hint">{body}</p>
          {checkbox && (
            <label className="check">
              <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
              {checkbox.label}
            </label>
          )}
        </div>
        <footer className="modal__footer">
          <button className="act act--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className={`act ${danger ? "act--danger" : "act--focus"}`} onClick={() => onConfirm(checked)}>
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
