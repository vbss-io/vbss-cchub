import { act, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { UiPrefs, UiPrefsPatch } from "./delegation";
import { DRAWER_WIDTH, useDrawerWidth, useLayoutSize, useNavWidth } from "./use-layout-size";
import { UiPrefsProvider } from "./ui-prefs-context";

const setViewport = (width: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
};

const providerFor = (prefs: UiPrefs, updateUiPrefs: (patch: UiPrefsPatch) => Promise<void>) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <UiPrefsProvider value={{ uiPrefs: prefs, loaded: true, updateUiPrefs }}>{children}</UiPrefsProvider>;
  };

const prefs = (layout: UiPrefs["layout"] = {}): UiPrefs => ({ sidebar: null, layout });

class FakeResizeObserver {
  static last: FakeResizeObserver | null = null;
  disconnected = false;
  readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    FakeResizeObserver.last = this;
  }
  observe(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  setViewport(1400);
  FakeResizeObserver.last = null;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty("--drawer-w");
});

test("useLayoutSize starts from the stored size and falls back when none is stored", () => {
  const update = vi.fn(async () => undefined);
  const stored = renderHook(() => useLayoutSize("drawers", "task", 500), { wrapper: providerFor(prefs({ drawers: { task: 640 } }), update) });
  expect(stored.result.current[0]).toBe(640);
  const fallback = renderHook(() => useLayoutSize("drawers", "task", 500), { wrapper: providerFor(prefs(), update) });
  expect(fallback.result.current[0]).toBe(500);
});

test("a size change updates immediately and saves once after the debounce", () => {
  const update = vi.fn<(patch: UiPrefsPatch) => Promise<void>>(async () => undefined);
  const { result } = renderHook(() => useLayoutSize("drawers", "task", 500), { wrapper: providerFor(prefs({ drawers: { other: 300 } }), update) });
  act(() => result.current[1](610));
  act(() => result.current[1](620));
  expect(result.current[0]).toBe(620);
  expect(update).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(400);
  });
  expect(update).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith({ layout: { drawers: { other: 300, task: 620 } } });
});

test("a stored size arriving from the server replaces the local one only when nothing is pending", () => {
  const update = vi.fn<(patch: UiPrefsPatch) => Promise<void>>(async () => undefined);
  let current = prefs({ drawers: { task: 500 } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <UiPrefsProvider value={{ uiPrefs: current, loaded: true, updateUiPrefs: update }}>{children}</UiPrefsProvider>
  );
  const { result, rerender } = renderHook(() => useLayoutSize("drawers", "task", 400), { wrapper: Wrapper });
  expect(result.current[0]).toBe(500);
  current = prefs({ drawers: { task: 700 } });
  rerender();
  expect(result.current[0]).toBe(700);
  act(() => result.current[1](720));
  current = prefs({ drawers: { task: 800 } });
  rerender();
  expect(result.current[0]).toBe(720);
  act(() => {
    vi.advanceTimersByTime(400);
  });
  expect(update).toHaveBeenCalledWith({ layout: { drawers: { task: 720 } } });
});

test("useNavWidth is null without a nav, then measures and follows the nav", () => {
  const none = renderHook(() => useNavWidth());
  expect(none.result.current).toBeNull();
  none.unmount();
  document.body.innerHTML = '<div class="shell"><nav class="nav"></nav></div>';
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const nav = document.querySelector<HTMLElement>(".shell > .nav");
  expect(nav).not.toBeNull();
  const rect = vi.spyOn(nav as HTMLElement, "getBoundingClientRect");
  rect.mockReturnValue({ width: 231.6, height: 10, x: 0, y: 0, top: 0, left: 0, right: 231.6, bottom: 10, toJSON: () => ({}) });
  const measured = renderHook(() => useNavWidth());
  expect(measured.result.current).toBe(232);
  rect.mockReturnValue({ width: 64, height: 10, x: 0, y: 0, top: 0, left: 0, right: 64, bottom: 10, toJSON: () => ({}) });
  act(() => FakeResizeObserver.last?.callback());
  expect(measured.result.current).toBe(64);
  measured.unmount();
  expect(FakeResizeObserver.last?.disconnected).toBe(true);
});

test("useNavWidth measures once when ResizeObserver is unavailable", () => {
  document.body.innerHTML = '<div class="shell"><nav class="nav"></nav></div>';
  vi.stubGlobal("ResizeObserver", undefined);
  const nav = document.querySelector<HTMLElement>(".shell > .nav");
  vi.spyOn(nav as HTMLElement, "getBoundingClientRect").mockReturnValue({ width: 200, height: 10, x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 10, toJSON: () => ({}) });
  const { result } = renderHook(() => useNavWidth());
  expect(result.current).toBe(200);
});

test("useDrawerWidth clamps the stored width to the viewport and exposes it as a css variable", () => {
  const update = vi.fn(async () => undefined);
  const { result } = renderHook(() => useDrawerWidth("task", false), { wrapper: providerFor(prefs({ drawers: { task: 5000 } }), update) });
  expect(result.current.resizable).toBe(true);
  expect(result.current.maxWidth).toBe(DRAWER_WIDTH.max);
  expect(result.current.width).toBe(DRAWER_WIDTH.max);
  expect(result.current.style).toEqual({ "--drawer-w": `${DRAWER_WIDTH.max}px` });
});

test("useDrawerWidth is not resizable when full or stacked", () => {
  const update = vi.fn(async () => undefined);
  const full = renderHook(() => useDrawerWidth("task", true), { wrapper: providerFor(prefs(), update) });
  expect(full.result.current.resizable).toBe(false);
  expect(full.result.current.style).toBeUndefined();
  setViewport(700);
  const stacked = renderHook(() => useDrawerWidth("task", false), { wrapper: providerFor(prefs(), update) });
  expect(stacked.result.current.resizable).toBe(false);
});

test("useDrawerWidth publishes the width on the root element and removes it on unmount", () => {
  const update = vi.fn(async () => undefined);
  const view = renderHook(() => useDrawerWidth("task", false, true), { wrapper: providerFor(prefs({ drawers: { task: 600 } }), update) });
  expect(document.documentElement.style.getPropertyValue("--drawer-w")).toBe("600px");
  act(() => view.result.current.setWidth(700));
  expect(document.documentElement.style.getPropertyValue("--drawer-w")).toBe("700px");
  view.unmount();
  expect(document.documentElement.style.getPropertyValue("--drawer-w")).toBe("");
});

test("useDrawerWidth reserves the grid nav width when the viewport is wide enough for the panel layout", () => {
  setViewport(1300);
  document.body.innerHTML = '<div class="shell"><nav class="nav"></nav></div>';
  const nav = document.querySelector<HTMLElement>(".shell > .nav");
  vi.spyOn(nav as HTMLElement, "getBoundingClientRect").mockReturnValue({ width: 300, height: 10, x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 10, toJSON: () => ({}) });
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const update = vi.fn(async () => undefined);
  const { result } = renderHook(() => useDrawerWidth("task", false, true), { wrapper: providerFor(prefs(), update) });
  expect(result.current.maxWidth).toBe(1300 - (300 + 240));
});

test("renders inside the default provider without crashing", () => {
  function Probe() {
    const [size] = useLayoutSize("drawers", "task", 321);
    return <span data-testid="size">{size}</span>;
  }
  const { getByTestId } = render(<Probe />);
  expect(getByTestId("size").textContent).toBe("321");
});
