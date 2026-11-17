import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ResizableSplit, useSplitterHandle, useViewportWidth } from "./ResizableSplit";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly callback: ResizeObserverCallback;
  disconnected = false;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  emit(width: number): void {
    this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

const setViewport = (width: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
};

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  setViewport(1400);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1000, height: 100, x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 100, toJSON: () => ({}) });
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.classList.remove("is-resizing");
});

const separator = () => screen.getByRole("separator");

test("useViewportWidth follows window resize events", () => {
  const { result } = renderHook(() => useViewportWidth());
  expect(result.current).toBe(1400);
  act(() => {
    setViewport(700);
    window.dispatchEvent(new Event("resize"));
  });
  expect(result.current).toBe(700);
});

test("renders both panes with an accessible divider sized to the default", () => {
  render(
    <ResizableSplit id="demo" side="start" defaultSize={300} minSize={200} maxSize={600} ariaLabel="Resize panes">
      <div>left</div>
      <div>right</div>
    </ResizableSplit>,
  );
  const divider = screen.getByRole("separator", { name: "Resize panes" });
  expect(divider.getAttribute("aria-valuenow")).toBe("300");
  expect(divider.getAttribute("aria-valuemin")).toBe("200");
  expect(divider.getAttribute("aria-valuemax")).toBe("600");
  expect(screen.getByText("left").parentElement?.style.flex).toBe("0 0 300px");
  expect(screen.getByText("right").parentElement?.className).toContain("rsplit__pane--fill");
});

test("puts the sized pane second when the side is end", () => {
  render(
    <ResizableSplit id="demo" side="end" defaultSize={300} minSize={200} maxSize={600} ariaLabel="Resize panes">
      <div>left</div>
      <div>right</div>
    </ResizableSplit>,
  );
  expect(screen.getByText("right").parentElement?.style.flex).toBe("0 0 300px");
  expect(screen.getByText("left").parentElement?.className).toContain("rsplit__pane--fill");
});

test("stacks without a divider below the collapse width", () => {
  setViewport(600);
  const { container } = render(
    <ResizableSplit id="demo" side="start" defaultSize={300} minSize={200} maxSize={600} ariaLabel="Resize panes">
      <div>left</div>
      <div>right</div>
    </ResizableSplit>,
  );
  expect(screen.queryByRole("separator")).toBeNull();
  expect(container.querySelector(".rsplit--stacked")).not.toBeNull();
  expect(screen.getByText("left").parentElement?.style.flex).toBe("");
});

test("keyboard arrows change the size and report it", () => {
  const onSizeChange = vi.fn();
  render(
    <ResizableSplit id="demo" side="start" defaultSize={300} minSize={200} maxSize={600} onSizeChange={onSizeChange} ariaLabel="Resize panes">
      <div>left</div>
      <div>right</div>
    </ResizableSplit>,
  );
  fireEvent.keyDown(separator(), { key: "ArrowRight" });
  expect(onSizeChange).toHaveBeenLastCalledWith(316);
  expect(separator().getAttribute("aria-valuenow")).toBe("316");
  fireEvent.keyDown(separator(), { key: "ArrowLeft", shiftKey: true });
  expect(onSizeChange).toHaveBeenLastCalledWith(252);
  fireEvent.keyDown(separator(), { key: "End" });
  expect(onSizeChange).toHaveBeenLastCalledWith(600);
  fireEvent.keyDown(separator(), { key: "Home" });
  expect(onSizeChange).toHaveBeenLastCalledWith(200);
  onSizeChange.mockClear();
  fireEvent.keyDown(separator(), { key: "Home" });
  expect(onSizeChange).not.toHaveBeenCalled();
  fireEvent.keyDown(separator(), { key: "a" });
  expect(onSizeChange).not.toHaveBeenCalled();
});

test("double click resets to the default size", () => {
  const onSizeChange = vi.fn();
  render(
    <ResizableSplit id="demo" side="start" defaultSize={300} minSize={200} maxSize={600} onSizeChange={onSizeChange} ariaLabel="Resize panes">
      <div>left</div>
      <div>right</div>
    </ResizableSplit>,
  );
  fireEvent.keyDown(separator(), { key: "End" });
  fireEvent.doubleClick(separator());
  expect(onSizeChange).toHaveBeenLastCalledWith(300);
});

test("dragging with the pointer resizes, marks the body and stops on release", () => {
  const onSizeChange = vi.fn();
  render(
    <ResizableSplit id="demo" side="start" defaultSize={300} minSize={200} maxSize={600} onSizeChange={onSizeChange} ariaLabel="Resize panes">
      <div>left</div>
      <div>right</div>
    </ResizableSplit>,
  );
  const divider = separator();
  fireEvent.pointerDown(divider, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 100 });
  expect(document.body.classList.contains("is-resizing")).toBe(true);
  expect(divider.setPointerCapture).toHaveBeenCalledWith(1);
  fireEvent.pointerMove(divider, { pointerId: 1, clientX: 180 });
  expect(onSizeChange).toHaveBeenLastCalledWith(380);
  fireEvent.pointerMove(divider, { pointerId: 2, clientX: 400 });
  expect(onSizeChange).toHaveBeenCalledTimes(1);
  fireEvent.pointerUp(divider, { pointerId: 1 });
  expect(document.body.classList.contains("is-resizing")).toBe(false);
  expect(divider.releasePointerCapture).toHaveBeenCalledWith(1);
  fireEvent.pointerMove(divider, { pointerId: 1, clientX: 500 });
  expect(onSizeChange).toHaveBeenCalledTimes(1);
});

test("ignores non-primary mouse buttons and cancels a drag on pointercancel", () => {
  const onSizeChange = vi.fn();
  render(
    <ResizableSplit id="demo" side="end" defaultSize={300} minSize={200} maxSize={600} onSizeChange={onSizeChange} ariaLabel="Resize panes">
      <div>left</div>
      <div>right</div>
    </ResizableSplit>,
  );
  const divider = separator();
  fireEvent.pointerDown(divider, { pointerId: 1, pointerType: "mouse", button: 2, clientX: 100 });
  expect(document.body.classList.contains("is-resizing")).toBe(false);
  fireEvent.pointerDown(divider, { pointerId: 3, pointerType: "touch", button: 0, clientX: 100 });
  expect(document.body.classList.contains("is-resizing")).toBe(true);
  fireEvent.pointerMove(divider, { pointerId: 3, clientX: 140 });
  expect(onSizeChange).toHaveBeenLastCalledWith(260);
  fireEvent.pointerCancel(divider, { pointerId: 3 });
  expect(document.body.classList.contains("is-resizing")).toBe(false);
});

test("a controlled size overrides the internal one and measures from the observer", () => {
  const { rerender } = render(
    <ResizableSplit id="demo" side="start" defaultSize={300} size={450} ariaLabel="Resize panes">
      <div>left</div>
      <div>right</div>
    </ResizableSplit>,
  );
  expect(separator().getAttribute("aria-valuenow")).toBe("450");
  const observer = FakeResizeObserver.instances[0];
  expect(observer).toBeDefined();
  act(() => observer?.emit(500));
  expect(Number(separator().getAttribute("aria-valuemax"))).toBeLessThan(500);
  rerender(
    <ResizableSplit id="demo" side="start" defaultSize={300} size={900} ariaLabel="Resize panes" className="extra">
      <div>left</div>
      <div>right</div>
    </ResizableSplit>,
  );
  expect(Number(separator().getAttribute("aria-valuenow"))).toBeLessThanOrEqual(Number(separator().getAttribute("aria-valuemax")));
  expect(document.querySelector(".rsplit.extra")).not.toBeNull();
});

test("disconnects the resize observer on unmount", () => {
  const view = render(
    <ResizableSplit id="demo" side="start" defaultSize={300} ariaLabel="Resize panes">
      <div>left</div>
      <div>right</div>
    </ResizableSplit>,
  );
  const observer = FakeResizeObserver.instances[0];
  view.unmount();
  expect(observer?.disconnected).toBe(true);
});

test("useSplitterHandle exposes a vertical separator and commits only changed sizes", () => {
  const onChange = vi.fn();
  const { result } = renderHook(() => useSplitterHandle({ size: 100, min: 50, max: 150, defaultSize: 100, side: "start", onChange }));
  expect(result.current.separatorProps.role).toBe("separator");
  expect(result.current.separatorProps["aria-orientation"]).toBe("vertical");
  expect(result.current.dragging).toBe(false);
  act(() => {
    result.current.separatorProps.onDoubleClick?.({} as never);
  });
  expect(onChange).not.toHaveBeenCalled();
});
