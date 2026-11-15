import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  LIST_WINDOW,
  clampOverflows,
  newItemIndex,
  revealedOffset,
  showMoreAll,
  showMoreLabels,
  showMoreNext,
  showMoreReveal,
  showMoreStart,
  showMoreSync,
  showMoreView,
  toggleKey,
  visibleRange,
  type ShowMoreFrom,
  type ShowMoreOptions,
  type RowRange,
  type ShowMoreView,
} from "../show-more";
import "../show-more.css";

export interface ShowMoreWindow {
  view: ShowMoreView;
  more: () => void;
  all: () => void;
  reveal?: (index: number, from: ShowMoreFrom) => void;
}

export function useShowMore(total: number, resetKey: string, options: ShowMoreOptions = LIST_WINDOW): ShowMoreWindow {
  const [state, setState] = useState(() => showMoreStart(resetKey, options));
  const current = showMoreSync(state, resetKey, options);
  const view = showMoreView(current, total, options);
  const more = () => setState((value) => showMoreNext(showMoreSync(value, resetKey, options), total, options));
  const all = () => setState((value) => showMoreAll(showMoreSync(value, resetKey, options)));
  const reveal = (index: number, from: ShowMoreFrom) => setState((value) => showMoreReveal(showMoreSync(value, resetKey, options), index, total, from));
  return { view, more, all, reveal };
}

const NATIVE_FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";

export function focusRevealed(element: HTMLElement): void {
  if (!element.matches(NATIVE_FOCUSABLE)) {
    element.setAttribute("tabindex", "-1");
    element.addEventListener("blur", () => element.removeAttribute("tabindex"), { once: true });
  }
  element.focus({ preventScroll: true });
  element.scrollIntoView?.({ block: "nearest" });
}

interface ButtonsProps {
  paging: ShowMoreWindow;
  from: ShowMoreFrom;
  unit?: string;
  noun?: string;
  focusTarget?: () => HTMLElement | null;
}

export function ShowMoreButtons({ paging, from, unit, noun, focusTarget }: ButtonsProps) {
  const pending = useRef(false);
  const group = useRef<HTMLDivElement>(null);
  const target = useRef(focusTarget);
  target.current = focusTarget;
  useLayoutEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    const next = target.current?.() ?? group.current?.querySelector<HTMLElement>(".show-more__btn") ?? null;
    if (next) focusRevealed(next);
  });
  const labels = showMoreLabels(paging.view, from, unit);
  if (labels.length === 0) return null;
  const hiddenText = `${paging.view.hidden} ${unit ?? noun ?? "items"} hidden`;
  const run = (action: () => void) => () => {
    pending.current = true;
    action();
  };
  return (
    <div ref={group} className={`show-more show-more--${from}`} role="group" aria-label={hiddenText}>
      {labels.map((item) => (
        <button key={item.action} type="button" className="show-more__btn" onClick={run(item.action === "more" ? paging.more : paging.all)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

interface ListProps<T> {
  items: readonly T[];
  resetKey: string;
  render: (item: T, index: number) => ReactNode;
  from?: ShowMoreFrom;
  options?: ShowMoreOptions;
  noun?: string;
  wrap?: (children: ReactNode) => ReactNode;
  itemKey?: (item: T) => string;
}

export function ShowMoreList<T>({ items, resetKey, render, from = "start", options = LIST_WINDOW, noun, wrap, itemKey }: ListProps<T>) {
  const paging = useShowMore(items.length, resetKey, options);
  const range = visibleRange(items.length, paging.view.shown, from);
  const rows = items.slice(range.start, range.end).map((item, index) => render(item, range.start + index));
  const anchor = useRef<HTMLSpanElement>(null);
  const before = useRef<RowRange | null>(null);
  const lastKeys = useRef<{ resetKey: string; keys: string[] } | null>(null);
  const keys = itemKey ? items.map(itemKey) : null;
  const reveal = paging.reveal;
  useLayoutEffect(() => {
    if (!keys) return;
    const last = lastKeys.current;
    lastKeys.current = { resetKey, keys };
    if (!last || last.resetKey !== resetKey) return;
    const index = newItemIndex(last.keys, keys);
    if (index >= 0) reveal?.(index, from);
  });
  const rowAt = (offset: number): HTMLElement | null => {
    const marker = anchor.current;
    let element = wrap ? (marker?.nextElementSibling?.firstElementChild ?? null) : (marker?.nextElementSibling ?? null);
    for (let step = 0; step < offset && element; step += 1) element = element.nextElementSibling;
    return element instanceof HTMLElement ? element : null;
  };
  const focusTarget = (): HTMLElement | null => {
    const previous = before.current;
    before.current = null;
    if (!previous) return null;
    const offset = revealedOffset(previous, range, from);
    return offset === null ? null : rowAt(offset);
  };
  const remember = (action: () => void) => () => {
    before.current = range;
    action();
  };
  const buttons = <ShowMoreButtons paging={{ ...paging, more: remember(paging.more), all: remember(paging.all) }} from={from} noun={noun} focusTarget={focusTarget} />;
  return (
    <>
      {from === "end" && buttons}
      <span ref={anchor} hidden />
      {wrap ? wrap(rows) : rows}
      {from === "start" && buttons}
    </>
  );
}

interface ClampScopeValue {
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
}

const ClampScopeContext = createContext<ClampScopeValue | null>(null);

export function ClampScope({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  const [state, setState] = useState<{ key: string; open: ReadonlySet<string> }>(() => ({ key: resetKey, open: new Set() }));
  const open = state.key === resetKey ? state.open : null;
  const toggle = useCallback((key: string) => setState((value) => ({ key: resetKey, open: toggleKey(value.key === resetKey ? value.open : new Set(), key) })), [resetKey]);
  const value = useMemo<ClampScopeValue>(() => ({ isOpen: (key) => open?.has(key) ?? false, toggle }), [open, toggle]);
  return <ClampScopeContext.Provider value={value}>{children}</ClampScopeContext.Provider>;
}

interface ClampTextProps {
  children: ReactNode;
  lines?: number;
  markdown?: boolean;
  className?: string;
  scopeKey?: string;
}

export function ClampText({ children, lines = 6, markdown = false, className, scopeKey }: ClampTextProps) {
  const scope = useContext(ClampScopeContext);
  const [localOpen, setLocalOpen] = useState(false);
  const scoped = scope !== null && scopeKey !== undefined;
  const expanded = scoped ? scope.isOpen(scopeKey) : localOpen;
  const [overflowing, setOverflowing] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const bodyId = useId();

  useLayoutEffect(() => {
    const element = body.current;
    if (!element || expanded) return;
    setOverflowing(clampOverflows(element.scrollHeight, element.clientHeight));
  });

  useEffect(() => {
    const element = body.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!expandedRef.current) setOverflowing(clampOverflows(element.scrollHeight, element.clientHeight));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const toggle = () => {
    if (scoped) scope.toggle(scopeKey);
    else setLocalOpen((value) => !value);
  };
  const style = { "--clamp-lines": String(lines) } as CSSProperties;
  const classes = ["clamp__body", markdown ? "clamp__body--md" : "clamp__body--text", expanded ? "" : "clamp__body--collapsed", overflowing && !expanded ? "clamp__body--overflowing" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className="clamp">
      <div ref={body} id={bodyId} className={classes} style={style}>
        {children}
      </div>
      {(overflowing || expanded) && (
        <button
          type="button"
          className="show-more__btn clamp__toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
