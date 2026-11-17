import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShowMoreOptions } from "../show-more";
import { ClampScope, ClampText, focusRevealed, ShowMoreButtons, ShowMoreList, useShowMore } from "./ShowMore";

const options: ShowMoreOptions = { initial: 3, step: 2, showAllUnder: 2 };

const range = (count: number): string[] => Array.from({ length: count }, (_, index) => `item ${index}`);

const rows = (): string[] => screen.queryAllByRole("listitem").map((node) => node.textContent ?? "");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useShowMore", () => {
  it("starts with the initial window and grows by step then to all", () => {
    const { result } = renderHook(() => useShowMore(10, "k", options));
    expect(result.current.view.shown).toBe(3);
    expect(result.current.view.hidden).toBe(7);
    act(() => result.current.more());
    expect(result.current.view.shown).toBe(5);
    act(() => result.current.all());
    expect(result.current.view.shown).toBe(10);
    expect(result.current.view.hidden).toBe(0);
  });

  it("resets when the key changes", () => {
    const { result, rerender } = renderHook(({ key }) => useShowMore(10, key, options), { initialProps: { key: "a" } });
    act(() => result.current.more());
    expect(result.current.view.shown).toBe(5);
    rerender({ key: "b" });
    expect(result.current.view.shown).toBe(3);
  });

  it("reveal widens the window to include an index", () => {
    const { result } = renderHook(() => useShowMore(10, "k", options));
    act(() => result.current.reveal?.(7, "start"));
    expect(result.current.view.shown).toBe(8);
    act(() => result.current.reveal?.(1, "start"));
    expect(result.current.view.shown).toBe(8);
  });
});

describe("focusRevealed", () => {
  it("makes a non focusable element temporarily focusable and focuses it", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const scroll = vi.fn();
    element.scrollIntoView = scroll;
    focusRevealed(element);
    expect(element.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(element);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    element.blur();
    element.dispatchEvent(new Event("blur"));
    expect(element.hasAttribute("tabindex")).toBe(false);
    element.remove();
  });

  it("leaves a natively focusable element alone", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    focusRevealed(button);
    expect(button.hasAttribute("tabindex")).toBe(false);
    expect(document.activeElement).toBe(button);
    button.remove();
  });
});

describe("ShowMoreButtons", () => {
  it("renders nothing when everything is shown", () => {
    const paging = { view: { shown: 3, hidden: 0, next: 0, all: 0 }, more: vi.fn(), all: vi.fn() };
    const { container } = render(<ShowMoreButtons paging={paging} from="start" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the more and all buttons with the unit and runs the actions", () => {
    const more = vi.fn();
    const all = vi.fn();
    const paging = { view: { shown: 3, hidden: 60, next: 50, all: 60 }, more, all };
    render(<ShowMoreButtons paging={paging} from="end" unit="lines" />);
    expect(screen.getByRole("group", { name: "60 lines hidden" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show earlier (+50 lines)" }));
    expect(more).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Show all (+60 lines)" }));
    expect(all).toHaveBeenCalledTimes(1);
  });

  it("names the hidden group after the noun and focuses the custom target after an action", () => {
    const target = document.createElement("button");
    document.body.appendChild(target);
    const Harness = () => {
      const paging = useShowMore(40, "k", options);
      return <ShowMoreButtons paging={paging} from="start" noun="sessions" focusTarget={() => target} />;
    };
    try {
      render(<Harness />);
      expect(screen.getByRole("group", { name: "37 sessions hidden" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Show more (+2)" }));
      expect(document.activeElement).toBe(target);
    } finally {
      target.remove();
    }
  });

  it("falls back to the first button and defaults the noun to items", () => {
    const Harness = () => <ShowMoreButtons paging={useShowMore(40, "k", options)} from="start" />;
    render(<Harness />);
    expect(screen.getByRole("group", { name: "37 items hidden" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show more (+2)" }));
    expect(document.activeElement?.textContent).toBe("Show more (+2)");
  });
});

describe("ShowMoreList", () => {
  const renderItem = (item: string) => <li key={item}>{item}</li>;

  it("shows the initial window and pages forward", () => {
    render(<ul><ShowMoreList items={range(10)} resetKey="a" options={options} render={renderItem} /></ul>);
    expect(rows()).toEqual(["item 0", "item 1", "item 2"]);
    fireEvent.click(screen.getByRole("button", { name: "Show more (+2)" }));
    expect(rows()).toHaveLength(5);
    expect(document.activeElement?.textContent).toBe("item 3");
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    expect(rows()).toHaveLength(10);
    expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
  });

  it("pages from the end, newest last, with the button on top", () => {
    render(<ul><ShowMoreList items={range(10)} resetKey="a" options={options} from="end" render={renderItem} /></ul>);
    expect(rows()).toEqual(["item 7", "item 8", "item 9"]);
    fireEvent.click(screen.getByRole("button", { name: "Show earlier (+2)" }));
    expect(rows()[0]).toBe("item 5");
    expect(document.activeElement?.textContent).toBe("item 5");
  });

  it("wraps the rows and focuses the first revealed row inside the wrapper", () => {
    render(
      <ShowMoreList items={range(10)} resetKey="a" options={options} render={renderItem} wrap={(children) => <ul data-testid="wrap">{children}</ul>} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show more (+2)" }));
    expect(screen.getByTestId("wrap").children).toHaveLength(5);
    expect(document.activeElement?.textContent).toBe("item 3");
  });

  it("reveals a newly added item hidden beyond the window", () => {
    const { rerender } = render(<ul><ShowMoreList items={range(8)} resetKey="a" options={options} render={renderItem} itemKey={(item) => item} /></ul>);
    expect(rows()).toHaveLength(3);
    rerender(<ul><ShowMoreList items={[...range(8), "fresh"]} resetKey="a" options={options} render={renderItem} itemKey={(item) => item} /></ul>);
    expect(rows()).toContain("fresh");
  });

  it("does not reveal on a reset key change or the first render", () => {
    const { rerender } = render(<ul><ShowMoreList items={range(8)} resetKey="a" options={options} render={renderItem} itemKey={(item) => item} /></ul>);
    rerender(<ul><ShowMoreList items={[...range(8), "fresh"]} resetKey="b" options={options} render={renderItem} itemKey={(item) => item} /></ul>);
    expect(rows()).toHaveLength(3);
    expect(rows()).not.toContain("fresh");
  });
});

describe("ClampText", () => {
  const withOverflow = (scrollHeight: number, clientHeight: number, run: () => void): void => {
    const sh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const ch = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => clientHeight });
    try {
      run();
    } finally {
      if (sh) Object.defineProperty(HTMLElement.prototype, "scrollHeight", sh);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
      if (ch) Object.defineProperty(HTMLElement.prototype, "clientHeight", ch);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    }
  };

  it("shows no toggle when the text fits", () => {
    withOverflow(10, 10, () => {
      render(<ClampText>short</ClampText>);
      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByText("short").className).toContain("clamp__body--collapsed");
    });
  });

  it("toggles locally between Show more and Show less when it overflows", () => {
    withOverflow(200, 50, () => {
      render(<ClampText lines={3} markdown className="extra">long text</ClampText>);
      const body = screen.getByText("long text");
      expect(body.className).toContain("clamp__body--md");
      expect(body.className).toContain("clamp__body--overflowing");
      expect(body.className).toContain("extra");
      expect(body.style.getPropertyValue("--clamp-lines")).toBe("3");
      const toggle = screen.getByRole("button", { name: "Show more" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(toggle);
      expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
      expect(body.className).not.toContain("clamp__body--collapsed");
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
    });
  });

  it("shares open state through a ClampScope and resets with its key", () => {
    withOverflow(200, 50, () => {
      const view = (key: string) => (
        <ClampScope resetKey={key}>
          <ClampText scopeKey="a">first</ClampText>
          <ClampText scopeKey="b">second</ClampText>
        </ClampScope>
      );
      const { rerender } = render(view("one"));
      const toggles = screen.getAllByRole("button", { name: "Show more" });
      fireEvent.click(toggles[0] as HTMLElement);
      expect(screen.getAllByRole("button", { name: "Show less" })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "Show more" })).toHaveLength(1);
      rerender(view("two"));
      expect(screen.queryByRole("button", { name: "Show less" })).toBeNull();
      fireEvent.click(screen.getAllByRole("button", { name: "Show more" })[1] as HTMLElement);
      fireEvent.click(screen.getByRole("button", { name: "Show less" }));
      expect(screen.queryByRole("button", { name: "Show less" })).toBeNull();
    });
  });

  it("recomputes overflow when the observed size changes", () => {
    const callbacks: (() => void)[] = [];
    class Observer {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe(): void {
        return;
      }
      disconnect(): void {
        return;
      }
    }
    const original = globalThis.ResizeObserver;
    Object.defineProperty(globalThis, "ResizeObserver", { value: Observer, configurable: true, writable: true });
    let height = 10;
    const sh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const ch = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 10 });
    try {
      render(<ClampText>resizing</ClampText>);
      expect(screen.queryByRole("button")).toBeNull();
      height = 300;
      act(() => callbacks.forEach((callback) => callback()));
      expect(screen.getByRole("button", { name: "Show more" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Show more" }));
      act(() => callbacks.forEach((callback) => callback()));
      expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
    } finally {
      Object.defineProperty(globalThis, "ResizeObserver", { value: original, configurable: true, writable: true });
      if (sh) Object.defineProperty(HTMLElement.prototype, "scrollHeight", sh);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
      if (ch) Object.defineProperty(HTMLElement.prototype, "clientHeight", ch);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
    }
  });
});
