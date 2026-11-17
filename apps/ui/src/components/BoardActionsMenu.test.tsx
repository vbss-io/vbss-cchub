import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardActionsMenu, type BoardMenuItem } from "./BoardActionsMenu";

const makeItems = (): { items: BoardMenuItem[]; onA: () => void; onB: () => void; onC: () => void } => {
  const onA = vi.fn();
  const onB = vi.fn();
  const onC = vi.fn();
  return {
    onA,
    onB,
    onC,
    items: [
      { id: "a", label: "First", onSelect: onA },
      { id: "b", label: "Second", title: "Second hint", separator: true, onSelect: onB },
      { id: "c", label: "Third", disabled: true, onSelect: onC },
    ],
  };
};

const trigger = () => screen.getByRole("button", { name: "More" });
const panel = () => screen.getByRole("menu", { name: "More" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BoardActionsMenu", () => {
  it("renders a closed trigger and opens the panel with the items", async () => {
    const user = userEvent.setup();
    render(<BoardActionsMenu label="More" items={makeItems().items} />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await user.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(panel().id);
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["First", "Second", "Third"]);
    expect(items[1]?.className).toContain("board-menu__item--sep");
    expect(items[1]?.getAttribute("title")).toBe("Second hint");
    expect((items[2] as HTMLButtonElement).disabled).toBe(true);
  });

  it("focuses the first enabled item on open", async () => {
    const user = userEvent.setup();
    render(<BoardActionsMenu label="More" items={makeItems().items} />);
    await user.click(trigger());
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "First" }));
  });

  it("selecting an item runs it and closes the menu", async () => {
    const user = userEvent.setup();
    const { items, onB } = makeItems();
    render(<BoardActionsMenu label="More" items={items} />);
    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: "Second" }));
    expect(onB).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not run disabled items", async () => {
    const user = userEvent.setup();
    const { items, onC } = makeItems();
    render(<BoardActionsMenu label="More" items={items} />);
    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: "Third" }));
    expect(onC).not.toHaveBeenCalled();
  });

  it("cycles focus with ArrowDown and ArrowUp over the enabled items only", async () => {
    const user = userEvent.setup();
    render(<BoardActionsMenu label="More" items={makeItems().items} />);
    await user.click(trigger());
    const first = screen.getByRole("menuitem", { name: "First" });
    const second = screen.getByRole("menuitem", { name: "Second" });
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(second);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(first);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(second);
  });

  it("starts from the last enabled item on ArrowUp when nothing inside has focus", async () => {
    const user = userEvent.setup();
    render(<BoardActionsMenu label="More" items={makeItems().items} />);
    await user.click(trigger());
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Second" }));
    trigger().focus();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "First" }));
  });

  it("does nothing on arrows when every item is disabled", async () => {
    const user = userEvent.setup();
    render(<BoardActionsMenu label="More" items={[{ id: "x", label: "Only", disabled: true, onSelect: () => undefined }]} />);
    await user.click(trigger());
    fireEvent.keyDown(panel(), { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes on Escape and refocuses the trigger, ignoring keys while closed", async () => {
    const user = userEvent.setup();
    render(<BoardActionsMenu label="More" items={makeItems().items} />);
    fireEvent.keyDown(trigger(), { key: "Escape" });
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(trigger());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("ignores other keys while open", async () => {
    const user = userEvent.setup();
    render(<BoardActionsMenu label="More" items={makeItems().items} />);
    await user.click(trigger());
    fireEvent.keyDown(panel(), { key: "x" });
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes on an outside pointer down, a resize, and an outside scroll but not an inner scroll", async () => {
    const user = userEvent.setup();
    render(<BoardActionsMenu label="More" items={makeItems().items} />);
    await user.click(trigger());
    fireEvent.pointerDown(panel());
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(trigger());
    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(trigger());
    fireEvent.scroll(panel());
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.scroll(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes when focus leaves and stays open when it moves inside", async () => {
    const user = userEvent.setup();
    render(<BoardActionsMenu label="More" items={makeItems().items} />);
    await user.click(trigger());
    fireEvent.blur(panel(), { relatedTarget: screen.getByRole("menuitem", { name: "First" }) });
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.blur(panel(), { relatedTarget: document.body });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ignores blur while closed", () => {
    render(<BoardActionsMenu label="More" items={makeItems().items} />);
    fireEvent.blur(trigger(), { relatedTarget: document.body });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("disables the trigger", async () => {
    const user = userEvent.setup();
    render(<BoardActionsMenu label="More" items={makeItems().items} disabled />);
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
    await user.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("places the panel below the trigger aligned to its right edge", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 500, right: 540, top: 100, bottom: 130, width: 40, height: 30, x: 500, y: 100, toJSON: () => ({}) } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
    render(<BoardActionsMenu label="More" items={makeItems().items} />);
    await user.click(trigger());
    expect(panel().style.left).toBe("340px");
    expect(panel().style.top).toBe("134px");
  });

  it("flips the panel above the trigger when it would overflow the bottom, and clamps to the gutter", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, right: 30, top: 700, bottom: 730, width: 30, height: 30, x: 0, y: 700, toJSON: () => ({}) } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
    render(<BoardActionsMenu label="More" items={makeItems().items} />);
    await user.click(trigger());
    expect(panel().style.left).toBe("8px");
    expect(panel().style.top).toBe("596px");
  });
});
