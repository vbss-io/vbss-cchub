import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  LIST_WINDOW,
  clampOverflows,
  showMoreAll,
  showMoreLabels,
  showMoreNext,
  showMoreStart,
  showMoreSync,
  showMoreView,
  toggleKey,
  visibleRange,
  type ShowMoreFrom,
  type ShowMoreOptions,
  type ShowMoreView,
} from "../show-more";
import "../show-more.css";

export interface ShowMoreWindow {
  view: ShowMoreView;
  more: () => void;
  all: () => void;
}

export function useShowMore(total: number, resetKey: string, options: ShowMoreOptions = LIST_WINDOW): ShowMoreWindow {
  const [state, setState] = useState(() => showMoreStart(resetKey, options));
  const current = showMoreSync(state, resetKey, options);
  const view = showMoreView(current, total, options);
  const more = () => setState((value) => showMoreNext(showMoreSync(value, resetKey, options), total, options));
  const all = () => setState((value) => showMoreAll(showMoreSync(value, resetKey, options)));
  return { view, more, all };
}

interface ButtonsProps {
  paging: ShowMoreWindow;
  from: ShowMoreFrom;
  unit?: string;
  noun?: string;
}

export function ShowMoreButtons({ paging, from, unit, noun }: ButtonsProps) {
  const labels = showMoreLabels(paging.view, from, unit);
  if (labels.length === 0) return null;
  const hiddenText = `${paging.view.hidden} ${unit ?? noun ?? "items"} hidden`;
  return (
    <div className={`show-more show-more--${from}`} role="group" aria-label={hiddenText}>
      {labels.map((item) => (
        <button key={item.action} type="button" className="show-more__btn" onClick={item.action === "more" ? paging.more : paging.all}>
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
}

export function ShowMoreList<T>({ items, resetKey, render, from = "start", options = LIST_WINDOW, noun, wrap }: ListProps<T>) {
  const paging = useShowMore(items.length, resetKey, options);
  const range = visibleRange(items.length, paging.view.shown, from);
  const rows = items.slice(range.start, range.end).map((item, index) => render(item, range.start + index));
  const buttons = <ShowMoreButtons paging={paging} from={from} noun={noun} />;
  return (
    <>
      {from === "end" && buttons}
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
