import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunsFilters } from "./RunsFilters";

const clients = [
  { key: "all", label: "All" },
  { key: "claude", label: "Claude" },
] as const;
const sorts = [
  { key: "recent", label: "Recent" },
  { key: "name", label: "Name" },
] as const;

const withPanelRect = (rect: { left: number; right: number }, run: () => void): void => {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function patched(this: HTMLElement) {
    return this.classList.contains("rf__panel") ? ({ ...rect } as DOMRect) : original.call(this);
  };
  try {
    run();
  } finally {
    HTMLElement.prototype.getBoundingClientRect = original;
  }
};

describe("RunsFilters", () => {
  it("labels the trigger with the active count", () => {
    const { rerender } = render(<RunsFilters clients={clients} client="all" onClient={vi.fn()} active={0} />);
    expect(screen.getByRole("button", { name: /^Filters/ }).className).not.toContain("rf__btn--on");
    rerender(<RunsFilters clients={clients} client="all" onClient={vi.fn()} active={2} />);
    expect(screen.getByRole("button", { name: /Filters \(2\)/ }).className).toContain("rf__btn--on");
  });

  it("opens the panel, changes client and sort, and renders children", () => {
    const onClient = vi.fn();
    const onSort = vi.fn();
    render(
      <RunsFilters clients={clients} client="all" onClient={onClient} sorts={sorts} sort="recent" onSort={onSort} active={0}>
        <span>extra control</span>
      </RunsFilters>,
    );
    expect(screen.queryByRole("group", { name: "Filters" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    expect(screen.getByRole("group", { name: "Filters" })).toBeTruthy();
    expect(screen.getByText("extra control")).toBeTruthy();
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0] as HTMLElement, { target: { value: "claude" } });
    expect(onClient).toHaveBeenCalledWith("claude");
    fireEvent.change(selects[1] as HTMLElement, { target: { value: "name" } });
    expect(onSort).toHaveBeenCalledWith("name");
  });

  it("hides the client select with a single client and the sort select without a handler", () => {
    render(<RunsFilters clients={[clients[0]]} client="all" onClient={vi.fn()} sorts={sorts} sort="recent" active={0} />);
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("closes on Escape and returns focus to the trigger", () => {
    render(<RunsFilters clients={clients} client="all" onClient={vi.fn()} active={0} />);
    const trigger = screen.getByRole("button", { name: /Filters/ });
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("group", { name: "Filters" }), { key: "a" });
    expect(screen.getByRole("group", { name: "Filters" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("group", { name: "Filters" }), { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Filters" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on an outside pointer down but not an inside one", () => {
    render(<RunsFilters clients={clients} client="all" onClient={vi.fn()} active={0} />);
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.pointerDown(screen.getByRole("group", { name: "Filters" }));
    expect(screen.getByRole("group", { name: "Filters" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("group", { name: "Filters" })).toBeNull();
  });

  it("shifts the panel back inside the viewport when it overflows on the right", () => {
    withPanelRect({ left: 100, right: window.innerWidth + 50 }, () => {
      render(<RunsFilters clients={clients} client="all" onClient={vi.fn()} active={0} />);
      fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
      expect(screen.getByRole("group", { name: "Filters" }).style.transform).toBe("translateX(-58px)");
    });
  });

  it("shifts the panel right when it overflows on the left", () => {
    withPanelRect({ left: -20, right: 100 }, () => {
      render(<RunsFilters clients={clients} client="all" onClient={vi.fn()} active={0} />);
      fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
      expect(screen.getByRole("group", { name: "Filters" }).style.transform).toBe("translateX(28px)");
    });
  });
});
