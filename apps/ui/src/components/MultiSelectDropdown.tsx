import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

export interface MultiSelectOption {
  id: string;
  label: string;
  checked: boolean;
  count?: number;
  disabled?: boolean;
  title?: string;
}

export interface MultiSelectShortcut {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

interface Props {
  label: string;
  summary: string;
  options: MultiSelectOption[];
  onToggle: (id: string) => void;
  shortcuts?: MultiSelectShortcut[];
  highlighted?: boolean;
  title?: string;
}

const VIEWPORT_GUTTER = 8;

export function MultiSelectDropdown({ label, summary, options, onToggle, shortcuts = [], highlighted = false, title }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!open || !element) return;
    element.style.transform = "";
    const rect = element.getBoundingClientRect();
    const overflowRight = Math.min(0, window.innerWidth - VIEWPORT_GUTTER - rect.right);
    const shift = Math.max(overflowRight, VIEWPORT_GUTTER - rect.left);
    if (shift !== 0) element.style.transform = `translateX(${shift}px)`;
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    setOpen(true);
    window.setTimeout(() => panel.current?.querySelector<HTMLElement>("input:not(:disabled)")?.focus(), 0);
  };

  return (
    <div
      ref={root}
      className="msd"
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (open && !root.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={`select msd__btn ${highlighted ? "msd__btn--on" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={title}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="msd__summary">{summary}</span>
        <span className="msd__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div ref={panel} id={panelId} className="msd__panel" role="group" aria-label={label} tabIndex={-1}>
          {shortcuts.length > 0 && (
            <div className="msd__shortcuts">
              {shortcuts.map((shortcut) => (
                <button key={shortcut.label} type="button" className="act" disabled={shortcut.disabled} onClick={shortcut.onClick}>
                  {shortcut.label}
                </button>
              ))}
            </div>
          )}
          {options.map((option) => (
            <label key={option.id} className={`msd__item ${option.disabled ? "msd__item--disabled" : ""}`} title={option.title}>
              <input type="checkbox" checked={option.checked} disabled={option.disabled} onChange={() => onToggle(option.id)} />
              <span className="msd__label">{option.label}</span>
              {option.count !== undefined && <span className="pill__count">{option.count}</span>}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
