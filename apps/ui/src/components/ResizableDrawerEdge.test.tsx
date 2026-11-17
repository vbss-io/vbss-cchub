import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ResizableDrawerEdge } from "./ResizableDrawerEdge";

const setViewport = (width: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
};

beforeEach(() => {
  setViewport(1400);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
});

afterEach(() => {
  document.body.classList.remove("is-resizing");
});

const props = { width: 500, minWidth: 380, maxWidth: 1000, defaultWidth: 560, ariaLabel: "Resize drawer" };

test("renders a separator reflecting the clamped width and bounds", () => {
  render(<ResizableDrawerEdge {...props} onWidthChange={() => undefined} />);
  const edge = screen.getByRole("separator", { name: "Resize drawer" });
  expect(edge.getAttribute("aria-valuenow")).toBe("500");
  expect(edge.getAttribute("aria-valuemin")).toBe("380");
  expect(edge.getAttribute("aria-valuemax")).toBe("1000");
  expect(edge.className).toBe("rdrawer-edge");
});

test("caps the maximum to leave room in a narrow viewport and clamps the width", () => {
  setViewport(1000);
  render(<ResizableDrawerEdge {...props} width={950} onWidthChange={() => undefined} />);
  const edge = screen.getByRole("separator");
  expect(edge.getAttribute("aria-valuemax")).toBe("904");
  expect(edge.getAttribute("aria-valuenow")).toBe("904");
});

test("renders nothing when the viewport is below the collapse width", () => {
  setViewport(800);
  const { container } = render(<ResizableDrawerEdge {...props} onWidthChange={() => undefined} />);
  expect(container.firstChild).toBeNull();
});

test("honours a custom collapse width", () => {
  setViewport(800);
  render(<ResizableDrawerEdge {...props} collapseBelow={700} onWidthChange={() => undefined} />);
  expect(screen.getByRole("separator")).toBeTruthy();
});

test("dragging toward the start grows the drawer and flags the dragging class", () => {
  const onWidthChange = vi.fn();
  render(<ResizableDrawerEdge {...props} onWidthChange={onWidthChange} />);
  const edge = screen.getByRole("separator");
  fireEvent.pointerDown(edge, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 800 });
  expect(edge.className).toContain("rdrawer-edge--dragging");
  fireEvent.pointerMove(edge, { pointerId: 1, clientX: 750 });
  expect(onWidthChange).toHaveBeenLastCalledWith(550);
  fireEvent.pointerUp(edge, { pointerId: 1 });
  expect(edge.className).not.toContain("rdrawer-edge--dragging");
});

test("keyboard and double click adjust the width", () => {
  const onWidthChange = vi.fn();
  render(<ResizableDrawerEdge {...props} onWidthChange={onWidthChange} />);
  const edge = screen.getByRole("separator");
  fireEvent.keyDown(edge, { key: "ArrowLeft" });
  expect(onWidthChange).toHaveBeenLastCalledWith(516);
  fireEvent.keyDown(edge, { key: "ArrowRight", shiftKey: true });
  expect(onWidthChange).toHaveBeenLastCalledWith(436);
  fireEvent.doubleClick(edge);
  expect(onWidthChange).toHaveBeenLastCalledWith(560);
});
