import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { IconMore } from "../icons";

export interface BoardMenuItem {
  id: string;
  label: string;
  title?: string;
  disabled?: boolean;
  separator?: boolean;
  onSelect: () => void;
}

interface Props {
  label: string;
  items: BoardMenuItem[];
  disabled?: boolean;
}

const VIEWPORT_GUTTER = 8;
const PANEL_OFFSET = 4;

export function BoardActionsMenu({ label, items, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onScroll = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useLayoutEffect(() => {
    const element = panel.current;
    const anchor = trigger.current;
    if (!open || !element || !anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const left = Math.max(VIEWPORT_GUTTER, Math.min(anchorRect.right - width, window.innerWidth - VIEWPORT_GUTTER - width));
    const below = anchorRect.bottom + PANEL_OFFSET;
    const top = below + height > window.innerHeight - VIEWPORT_GUTTER ? Math.max(VIEWPORT_GUTTER, anchorRect.top - height - PANEL_OFFSET) : below;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
  }, [open]);

  const focusStep = (step: 1 | -1) => {
    const enabled = Array.from(panel.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? []);
    if (enabled.length === 0) return;
    const index = enabled.indexOf(document.activeElement as HTMLElement);
    const next = index < 0 ? (step === 1 ? 0 : enabled.length - 1) : (index + step + enabled.length) % enabled.length;
    enabled[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusStep(event.key === "ArrowDown" ? 1 : -1);
    }
  };

  return (
    <div
      ref={root}
      className="board-menu"
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (open && !root.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="act act--icon board-menu__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <IconMore />
      </button>
      {open && (
        <div ref={panel} id={panelId} className="board-menu__panel" role="menu" aria-label={label}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`board-menu__item ${item.separator ? "board-menu__item--sep" : ""}`}
              title={item.title}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
