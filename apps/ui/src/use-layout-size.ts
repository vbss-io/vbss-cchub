import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useViewportWidth } from "./components/ResizableSplit";
import { clampSize, DEFAULT_COLLAPSE_BELOW, drawerReserve, effectiveMax, isStacked } from "./resize-model";
import { layoutSize, withLayoutSize } from "./ui-prefs-layout";
import { useUiPrefs } from "./ui-prefs-context";
import { useDebouncedCallback } from "./use-debounced";

const SAVE_DELAY = 400;

export const DRAWER_WIDTH = { default: 560, min: 380, max: 1000 } as const;
const PANEL_LAYOUT_ABOVE = 1100;

export function useLayoutSize(screen: string, key: string, fallback: number): [number, (size: number) => void] {
  const { uiPrefs, updateUiPrefs } = useUiPrefs();
  const stored = layoutSize(uiPrefs.layout, screen, key, fallback);
  const [size, setSize] = useState(stored);
  const layoutRef = useRef(uiPrefs.layout);
  layoutRef.current = uiPrefs.layout;
  const dirty = useRef(false);

  const save = useDebouncedCallback((next: number) => {
    dirty.current = false;
    void updateUiPrefs(withLayoutSize(layoutRef.current, screen, key, next));
  }, SAVE_DELAY);

  useEffect(() => {
    if (!dirty.current) setSize(stored);
  }, [stored]);

  const change = useCallback(
    (next: number) => {
      dirty.current = true;
      setSize(next);
      save(next);
    },
    [save],
  );

  return [size, change];
}

export function useNavWidth(): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const nav = document.querySelector<HTMLElement>(".shell > .nav");
    if (!nav) return undefined;
    const measure = () => setWidth(Math.round(nav.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);
  return width;
}

export interface DrawerWidth {
  width: number;
  maxWidth: number;
  setWidth: (width: number) => void;
  style: CSSProperties | undefined;
  resizable: boolean;
}

export function useDrawerWidth(key: string, full: boolean, publishToRoot = false): DrawerWidth {
  const [stored, setWidth] = useLayoutSize("drawers", key, DRAWER_WIDTH.default);
  const viewport = useViewportWidth();
  const navWidth = useNavWidth();
  const resizable = !full && !isStacked(viewport, DEFAULT_COLLAPSE_BELOW);
  const inGrid = publishToRoot && viewport > PANEL_LAYOUT_ABOVE;
  const reserve = drawerReserve(inGrid, navWidth);
  const maxWidth = effectiveMax(DRAWER_WIDTH.min, DRAWER_WIDTH.max, viewport, reserve);
  const width = clampSize(stored, DRAWER_WIDTH.min, maxWidth);
  const style = resizable ? ({ "--drawer-w": `${width}px` } as CSSProperties) : undefined;

  useEffect(() => {
    if (!publishToRoot || !resizable) return undefined;
    const root = document.documentElement;
    root.style.setProperty("--drawer-w", `${width}px`);
    return () => {
      root.style.removeProperty("--drawer-w");
    };
  }, [publishToRoot, resizable, width]);

  return { width, maxWidth, setWidth, style, resizable };
}
