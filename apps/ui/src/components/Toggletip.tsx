import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "../usage.css";

const VIEWPORT_GUTTER = 8;

interface Props {
  label: string;
  children: ReactNode;
  align?: "start" | "end";
}

export function Toggletip({ label, children, align = "start" }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLSpanElement>(null);
  const popId = useId();

  useLayoutEffect(() => {
    const element = pop.current;
    if (!open || !element) return;
    element.style.transform = "";
    const rect = element.getBoundingClientRect();
    const overflowLeft = VIEWPORT_GUTTER - rect.left;
    const overflowRight = rect.right - (window.innerWidth - VIEWPORT_GUTTER);
    if (overflowLeft > 0) element.style.transform = `translateX(${overflowLeft}px)`;
    else if (overflowRight > 0) element.style.transform = `translateX(-${overflowRight}px)`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <span ref={root} className="toggletip">
      <button
        ref={trigger}
        type="button"
        className="toggletip__btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        title={label}
        onClick={() => setOpen((current) => !current)}
      >
        ?
      </button>
      {open && (
        <span ref={pop} id={popId} role="status" className={`toggletip__pop toggletip__pop--${align}`}>
          {children}
        </span>
      )}
    </span>
  );
}
