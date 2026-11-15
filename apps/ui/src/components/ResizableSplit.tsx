import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import "../resizable.css";
import {
  clampSize,
  DEFAULT_COLLAPSE_BELOW,
  effectiveMax,
  isStacked,
  keyboardSize,
  resetSize,
  sharedSplitBounds,
  sizeFromDelta,
  type PanelSide,
} from "../resize-model";

const MIN_REST = 240;

function subscribeViewport(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function viewportSnapshot(): number {
  return window.innerWidth;
}

export function useViewportWidth(): number {
  return useSyncExternalStore(subscribeViewport, viewportSnapshot);
}

export interface SplitterOptions {
  size: number;
  min: number;
  max: number;
  defaultSize: number;
  side: PanelSide;
  onChange: (size: number) => void;
}

export interface SplitterHandle {
  dragging: boolean;
  separatorProps: HTMLAttributes<HTMLDivElement>;
}

interface DragState {
  pointerId: number;
  startX: number;
  startSize: number;
}

export function useSplitterHandle(options: SplitterOptions): SplitterHandle {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<DragState | null>(null);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!dragging) return undefined;
    document.body.classList.add("is-resizing");
    return () => document.body.classList.remove("is-resizing");
  }, [dragging]);

  const commit = useCallback((next: number) => {
    if (next !== latest.current.size) latest.current.onChange(next);
  }, []);

  const finish = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startSize: latest.current.size };
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const { side, min, max } = latest.current;
      commit(sizeFromDelta(state.startSize, event.clientX - state.startX, side, min, max));
    },
    [commit],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const { size, side, min, max } = latest.current;
      const next = keyboardSize(size, event.key, event.shiftKey, side, min, max);
      if (next === null) return;
      event.preventDefault();
      commit(next);
    },
    [commit],
  );

  const onDoubleClick = useCallback(() => {
    const { defaultSize, min, max } = latest.current;
    commit(resetSize(defaultSize, min, max));
  }, [commit]);

  return {
    dragging,
    separatorProps: {
      role: "separator",
      tabIndex: 0,
      "aria-orientation": "vertical",
      "aria-valuenow": options.size,
      "aria-valuemin": options.min,
      "aria-valuemax": options.max,
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
      onKeyDown,
      onDoubleClick,
    },
  };
}

export interface ResizableSplitProps {
  id: string;
  side: PanelSide;
  defaultSize: number;
  minSize?: number;
  maxSize?: number;
  size?: number;
  onSizeChange?: (size: number) => void;
  collapseBelow?: number;
  children: [ReactNode, ReactNode];
  ariaLabel: string;
  className?: string;
}

export function ResizableSplit({
  id,
  side,
  defaultSize,
  minSize,
  maxSize,
  size,
  onSizeChange,
  collapseBelow = DEFAULT_COLLAPSE_BELOW,
  children,
  ariaLabel,
  className,
}: ResizableSplitProps) {
  const viewport = useViewportWidth();
  const stacked = isStacked(viewport, collapseBelow);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [inner, setInner] = useState(defaultSize);
  const sizedPaneId = useId();

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    setContainerWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const shared = minSize === undefined || maxSize === undefined ? sharedSplitBounds(containerWidth) : null;
  const min = shared?.min ?? minSize ?? 0;
  const max = shared?.max ?? effectiveMax(min, maxSize ?? min, containerWidth, MIN_REST);
  const current = clampSize(size ?? inner, min, max);

  const change = useCallback(
    (next: number) => {
      setInner(next);
      onSizeChange?.(next);
    },
    [onSizeChange],
  );

  const { dragging, separatorProps } = useSplitterHandle({
    size: current,
    min,
    max,
    defaultSize,
    side,
    onChange: change,
  });

  const rootClass = ["rsplit", stacked ? "rsplit--stacked" : "", dragging ? "rsplit--dragging" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  const sizedStyle = stacked ? undefined : { flex: `0 0 ${current}px` };
  const startSized = side === "start";

  return (
    <div ref={containerRef} className={rootClass} data-resizable={id}>
      <div
        id={startSized ? sizedPaneId : undefined}
        className={`rsplit__pane ${startSized ? "rsplit__pane--sized" : "rsplit__pane--fill"}`}
        style={startSized ? sizedStyle : undefined}
      >
        {children[0]}
      </div>
      {stacked ? null : (
        <div
          {...separatorProps}
          id={`${id}-divider`}
          className="rsplit__divider"
          aria-label={ariaLabel}
          aria-controls={sizedPaneId}
        />
      )}
      <div
        id={startSized ? undefined : sizedPaneId}
        className={`rsplit__pane ${startSized ? "rsplit__pane--fill" : "rsplit__pane--sized"}`}
        style={startSized ? undefined : sizedStyle}
      >
        {children[1]}
      </div>
    </div>
  );
}
