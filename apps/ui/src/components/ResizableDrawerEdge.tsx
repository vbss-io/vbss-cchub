import { useCallback } from "react";
import "../resizable.css";
import { clampSize, DEFAULT_COLLAPSE_BELOW, effectiveMax, isStacked } from "../resize-model";
import { useSplitterHandle, useViewportWidth } from "./ResizableSplit";

const VIEWPORT_RESERVE = 96;

export interface ResizableDrawerEdgeProps {
  width: number;
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
  onWidthChange: (width: number) => void;
  ariaLabel: string;
  collapseBelow?: number;
}

export function ResizableDrawerEdge({
  width,
  minWidth,
  maxWidth,
  defaultWidth,
  onWidthChange,
  ariaLabel,
  collapseBelow = DEFAULT_COLLAPSE_BELOW,
}: ResizableDrawerEdgeProps) {
  const viewport = useViewportWidth();
  const max = effectiveMax(minWidth, maxWidth, viewport, VIEWPORT_RESERVE);
  const current = clampSize(width, minWidth, max);

  const change = useCallback((next: number) => onWidthChange(next), [onWidthChange]);

  const { dragging, separatorProps } = useSplitterHandle({
    size: current,
    min: minWidth,
    max,
    defaultSize: defaultWidth,
    side: "end",
    onChange: change,
  });

  if (isStacked(viewport, collapseBelow)) return null;

  return (
    <div
      {...separatorProps}
      className={`rdrawer-edge${dragging ? " rdrawer-edge--dragging" : ""}`}
      aria-label={ariaLabel}
    />
  );
}
