import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { FilterChip, FilterChipId } from "../board-model";
import { IconClose } from "../icons";
import type { MultiSelectOption } from "./MultiSelectDropdown";

export interface BoardFilterGroup {
  title: string;
  options: MultiSelectOption[];
  shortcuts?: { label: string; onClick: () => void }[];
  onToggle: (id: string) => void;
}

interface FiltersProps {
  count: number;
  groups: BoardFilterGroup[];
  subprojects: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void };
  canReset: boolean;
  onReset: () => void;
}

const VIEWPORT_GUTTER = 8;

export function BoardFilters({ count, groups, subprojects, canReset, onReset }: FiltersProps) {
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
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div
      ref={root}
      className="bf"
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (open && !root.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={`act bf__btn ${count > 0 ? "bf__btn--on" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {count > 0 ? `Filters (${count})` : "Filters"}
        <span className="bf__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div ref={panel} id={panelId} className="bf__panel" role="group" aria-label="Filters" tabIndex={-1}>
          {groups.map((group) => (
            <section key={group.title} className="bf__group" aria-label={group.title}>
              <header className="bf__head">
                <h4>{group.title}</h4>
                {group.shortcuts && (
                  <span className="bf__shortcuts">
                    {group.shortcuts.map((shortcut) => (
                      <button key={shortcut.label} type="button" className="bf__link" onClick={shortcut.onClick}>
                        {shortcut.label}
                      </button>
                    ))}
                  </span>
                )}
              </header>
              {group.options.map((option) => (
                <label key={option.id} className={`msd__item ${option.disabled ? "msd__item--disabled" : ""}`} title={option.title}>
                  <input type="checkbox" checked={option.checked} disabled={option.disabled} onChange={() => group.onToggle(option.id)} />
                  <span className="msd__label">{option.label}</span>
                  {option.count !== undefined && <span className="pill__count">{option.count}</span>}
                </label>
              ))}
            </section>
          ))}
          <label className={`msd__item ${subprojects.disabled ? "msd__item--disabled" : ""}`} title="Include the tasks of the subprojects of the selected project">
            <input type="checkbox" checked={subprojects.checked} disabled={subprojects.disabled} onChange={(event) => subprojects.onChange(event.target.checked)} />
            <span className="msd__label">Include subprojects</span>
          </label>
          <footer className="bf__foot">
            <button type="button" className="act" disabled={!canReset} title={canReset ? "Reset filters and view options to their defaults" : "Filters and view options are already at their defaults"} onClick={onReset}>
              Reset
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

interface ChipsProps {
  chips: FilterChip[];
  onRemove: (id: FilterChipId) => void;
}

export function BoardFilterChips({ chips, onRemove }: ChipsProps) {
  if (chips.length === 0) return null;
  return (
    <ul className="bf-chips plainlist" aria-label="Active filters">
      {chips.map((chip) => (
        <li key={chip.id}>
          <button type="button" className="bf-chip" aria-label={`Remove filter ${chip.label}`} title="Remove this filter" onClick={() => onRemove(chip.id)}>
            <span className="bf-chip__label">{chip.label}</span>
            <IconClose size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}
