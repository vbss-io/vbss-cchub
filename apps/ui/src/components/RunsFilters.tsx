import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

export interface RunsFilterOption<K extends string> {
  key: K;
  label: string;
}

interface Props<C extends string, S extends string> {
  clients: readonly RunsFilterOption<C>[];
  client: C;
  onClient: (key: C) => void;
  sorts: readonly RunsFilterOption<S>[];
  sort: S;
  onSort: (key: S) => void;
  active: number;
}

const VIEWPORT_GUTTER = 8;

export function RunsFilters<C extends string, S extends string>({ clients, client, onClient, sorts, sort, onSort, active }: Props<C, S>) {
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
    <div ref={root} className="rf" onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className={`act rf__btn ${active > 0 ? "rf__btn--on" : ""}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {active > 0 ? `Filters (${active})` : "Filters"}
        <span className="rf__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div ref={panel} id={panelId} className="rf__panel" role="group" aria-label="Filters">
          {clients.length > 1 && (
            <label className="rf__field">
              <span>Client</span>
              <select className="select" value={client} onChange={(event) => onClient(event.target.value as C)}>
                {clients.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="rf__field">
            <span>Sort</span>
            <select className="select" value={sort} onChange={(event) => onSort(event.target.value as S)}>
              {sorts.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
