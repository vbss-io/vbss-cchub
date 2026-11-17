import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardMenu, useCardMenu, type CardMenuItem } from "./CardMenu";

interface HarnessProps {
  items: CardMenuItem[];
}

function Harness({ items }: HarnessProps) {
  const menu = useCardMenu();
  return (
    <div>
      <button type="button" onClick={(event) => menu.openAt(event.clientX || 10, event.clientY || 20)}>
        context
      </button>
      <span data-testid="state">{menu.open ? "open" : "closed"}</span>
      <CardMenu menu={menu} items={items} label="Task actions" />
    </div>
  );
}

const makeItems = () => {
  const onOpen = vi.fn();
  const onDelete = vi.fn();
  const onDisabled = vi.fn();
  const items: CardMenuItem[] = [
    { key: "open", label: "Open", onSelect: onOpen },
    { key: "off", label: "Unavailable", disabled: true, onSelect: onDisabled },
    { key: "delete", label: "Delete", danger: true, onSelect: onDelete },
  ];
  return { items, onOpen, onDelete, onDisabled };
};

const menuEl = () => screen.getByRole("menu", { name: "Task actions" });
const trigger = () => screen.getByRole("button", { name: "Task actions" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CardMenu", () => {
  it("is closed until the trigger is clicked, then shows the items in a portal", async () => {
    const user = userEvent.setup();
    const { items } = makeItems();
    render(<Harness items={items} />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await user.click(trigger());
    expect(menuEl().parentElement).toBe(document.body);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(menuEl().id);
    expect(within(menuEl()).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open", "Unavailable", "Delete"]);
    expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain("card-menu__item--danger");
    expect((screen.getByRole("menuitem", { name: "Unavailable" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("focuses the first enabled item and reveals the popup after positioning", async () => {
    const user = userEvent.setup();
    render(<Harness items={makeItems().items} />);
    await user.click(trigger());
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Open" }));
    expect(menuEl().style.visibility).toBe("visible");
  });

  it("closes when the trigger is clicked again", async () => {
    const user = userEvent.setup();
    render(<Harness items={makeItems().items} />);
    await user.click(trigger());
    await user.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("runs the selected item and closes", async () => {
    const user = userEvent.setup();
    const { items, onOpen } = makeItems();
    render(<Harness items={items} />);
    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not run a disabled item", async () => {
    const user = userEvent.setup();
    const { items, onDisabled } = makeItems();
    render(<Harness items={items} />);
    await user.click(trigger());
    fireEvent.click(screen.getByRole("menuitem", { name: "Unavailable" }));
    expect(onDisabled).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("moves focus with the arrow keys, wrapping around, and with Home and End", async () => {
    const user = userEvent.setup();
    render(<Harness items={makeItems().items} />);
    await user.click(trigger());
    const open = screen.getByRole("menuitem", { name: "Open" });
    const del = screen.getByRole("menuitem", { name: "Delete" });
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(del);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(open);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(del);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(open);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(del);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(open);
  });

  it("closes on Escape returning focus to the trigger, and on Tab", async () => {
    const user = userEvent.setup();
    render(<Harness items={makeItems().items} />);
    await user.click(trigger());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await user.click(trigger());
    fireEvent.keyDown(menuEl(), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ignores unrelated keys inside the popup and stops them from bubbling", async () => {
    const outer = vi.fn();
    const user = userEvent.setup();
    const { items } = makeItems();
    render(
      <div onKeyDown={outer}>
        <Harness items={items} />
      </div>,
    );
    await user.click(trigger());
    outer.mockClear();
    fireEvent.keyDown(menuEl(), { key: "x" });
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(outer).not.toHaveBeenCalled();
  });

  it("opens from the trigger with ArrowDown and ArrowUp but not other keys", () => {
    render(<Harness items={makeItems().items} />);
    fireEvent.keyDown(trigger(), { key: "x" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("opens at the pointer position clamped into the viewport", async () => {
    const user = userEvent.setup();
    render(<Harness items={makeItems().items} />);
    await user.click(screen.getByRole("button", { name: "context" }));
    expect(menuEl().style.left).toBe("10px");
    expect(menuEl().style.top).toBe("20px");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    const click = screen.getByRole("button", { name: "context" });
    fireEvent.click(click, { clientX: 5000, clientY: 5000 });
    expect(menuEl().style.left).toBe(`${window.innerWidth - 8}px`);
    expect(menuEl().style.top).toBe(`${window.innerHeight - 8}px`);
  });

  it("anchors to the trigger when opened from the button, aligned to its right edge", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, right: 300, top: 100, bottom: 130, width: 300, height: 30, x: 0, y: 100, toJSON: () => ({}) } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(90);
    render(<Harness items={makeItems().items} />);
    await user.click(trigger());
    expect(menuEl().style.left).toBe("180px");
    expect(menuEl().style.top).toBe("134px");
  });

  it("dismisses on outside mouse down, resize, scroll and window blur but not on inside mouse down", async () => {
    const user = userEvent.setup();
    render(<Harness items={makeItems().items} />);
    for (const dismiss of [() => fireEvent.mouseDown(document.body), () => fireEvent(window, new Event("resize")), () => fireEvent.scroll(document), () => fireEvent.blur(window)]) {
      await user.click(trigger());
      fireEvent.mouseDown(menuEl());
      fireEvent.mouseDown(trigger());
      expect(screen.getByRole("menu")).toBeTruthy();
      dismiss();
      expect(screen.queryByRole("menu")).toBeNull();
    }
  });

  it("suppresses the native context menu on the popup", async () => {
    const user = userEvent.setup();
    render(<Harness items={makeItems().items} />);
    await user.click(trigger());
    const notPrevented = fireEvent.contextMenu(menuEl());
    expect(notPrevented).toBe(false);
    expect(screen.getByTestId("state").textContent).toBe("open");
  });
});
