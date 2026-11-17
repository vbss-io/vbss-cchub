import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FilterChip } from "../board-model";
import { BoardFilterChips, BoardFilters, type BoardFilterGroup } from "./BoardFilters";

const makeGroups = () => {
  const onStatus = vi.fn();
  const onPriority = vi.fn();
  const onAll = vi.fn();
  const groups: BoardFilterGroup[] = [
    {
      title: "Status",
      options: [
        { id: "todo", label: "To-Do", checked: true, count: 4 },
        { id: "done", label: "Done", checked: false, disabled: true, title: "Locked" },
      ],
      shortcuts: [{ label: "All", onClick: onAll }],
      onToggle: onStatus,
    },
    { title: "Priority", options: [{ id: "1", label: "P1", checked: true }], onToggle: onPriority },
  ];
  return { groups, onStatus, onPriority, onAll };
};

const baseProps = { count: 0, canReset: false, onReset: () => undefined };
const trigger = () => screen.getByRole("button", { name: /^Filters/ });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BoardFilters", () => {
  it("shows the plain label with no active filters and the count when some are active", () => {
    const { rerender } = render(<BoardFilters {...baseProps} groups={makeGroups().groups} />);
    expect(trigger().textContent).toContain("Filters");
    expect(trigger().textContent).not.toContain("(");
    expect(trigger().className).not.toContain("bf__btn--on");
    rerender(<BoardFilters {...baseProps} count={2} groups={makeGroups().groups} />);
    expect(trigger().textContent).toContain("Filters (2)");
    expect(trigger().className).toContain("bf__btn--on");
  });

  it("opens the panel with one section per group and toggles options through the group handler", async () => {
    const user = userEvent.setup();
    const { groups, onStatus, onPriority, onAll } = makeGroups();
    render(<BoardFilters {...baseProps} groups={groups} />);
    expect(screen.queryByRole("group", { name: "Filters" })).toBeNull();
    await user.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const status = screen.getByRole("region", { name: "Status" });
    expect(within(status).getByText("4").className).toBe("pill__count");
    await user.click(within(status).getByRole("checkbox", { name: /To-Do/ }));
    expect(onStatus).toHaveBeenCalledWith("todo");
    await user.click(within(status).getByRole("checkbox", { name: /Done/ }));
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(within(status).getByText("Done").closest("label")?.getAttribute("title")).toBe("Locked");
    await user.click(within(status).getByRole("button", { name: "All" }));
    expect(onAll).toHaveBeenCalledTimes(1);
    await user.click(within(screen.getByRole("region", { name: "Priority" })).getByRole("checkbox", { name: /P1/ }));
    expect(onPriority).toHaveBeenCalledWith("1");
    expect(within(screen.getByRole("region", { name: "Priority" })).queryByRole("button")).toBeNull();
  });

  it("renders the subprojects toggle and reports its checked state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<BoardFilters {...baseProps} groups={makeGroups().groups} subprojects={{ checked: false, disabled: false, onChange }} />);
    await user.click(trigger());
    await user.click(screen.getByRole("checkbox", { name: "Include subprojects" }));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<BoardFilters {...baseProps} groups={makeGroups().groups} subprojects={{ checked: true, disabled: true, onChange }} />);
    const box = screen.getByRole("checkbox", { name: "Include subprojects" }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(true);
    expect(box.closest("label")?.className).toContain("msd__item--disabled");
  });

  it("omits the subprojects toggle when not provided", async () => {
    const user = userEvent.setup();
    render(<BoardFilters {...baseProps} groups={makeGroups().groups} />);
    await user.click(trigger());
    expect(screen.queryByRole("checkbox", { name: "Include subprojects" })).toBeNull();
  });

  it("enables Reset only when it can reset and calls onReset", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    const { rerender } = render(<BoardFilters {...baseProps} groups={makeGroups().groups} onReset={onReset} />);
    await user.click(trigger());
    const reset = screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    expect(reset.title).toContain("already at their defaults");
    rerender(<BoardFilters {...baseProps} canReset groups={makeGroups().groups} onReset={onReset} />);
    const active = screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement;
    expect(active.title).toContain("Reset filters");
    await user.click(active);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape with focus back on the trigger and ignores other keys", async () => {
    const user = userEvent.setup();
    render(<BoardFilters {...baseProps} groups={makeGroups().groups} />);
    fireEvent.keyDown(trigger(), { key: "Escape" });
    await user.click(trigger());
    fireEvent.keyDown(screen.getByRole("group", { name: "Filters" }), { key: "x" });
    expect(screen.getByRole("group", { name: "Filters" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Filters" })).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on an outside pointer down and when focus leaves", async () => {
    const user = userEvent.setup();
    render(<BoardFilters {...baseProps} groups={makeGroups().groups} />);
    await user.click(trigger());
    fireEvent.pointerDown(screen.getByRole("group", { name: "Filters" }));
    expect(screen.getByRole("group", { name: "Filters" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("group", { name: "Filters" })).toBeNull();
    await user.click(trigger());
    fireEvent.blur(screen.getByRole("group", { name: "Filters" }), { relatedTarget: screen.getByRole("button", { name: "Reset" }) });
    expect(screen.getByRole("group", { name: "Filters" })).toBeTruthy();
    fireEvent.blur(screen.getByRole("group", { name: "Filters" }), { relatedTarget: document.body });
    expect(screen.queryByRole("group", { name: "Filters" })).toBeNull();
    fireEvent.blur(trigger(), { relatedTarget: document.body });
    expect(screen.queryByRole("group", { name: "Filters" })).toBeNull();
  });

  it("aligns to the end when asked", () => {
    const { container } = render(<BoardFilters {...baseProps} groups={makeGroups().groups} align="end" />);
    expect(container.firstElementChild?.className).toContain("bf--end");
  });

  it("shifts the panel back into the viewport", async () => {
    const user = userEvent.setup();
    const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 0, width: right - left, height: 0, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    const width = 1000;
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(width);
    render(<BoardFilters {...baseProps} groups={makeGroups().groups} />);
    spy.mockReturnValue(rect(50, 250));
    await user.click(trigger());
    expect((screen.getByRole("group", { name: "Filters" }) as HTMLElement).style.transform).toBe("");
    await user.click(trigger());
    spy.mockReturnValue(rect(width - 100, width + 100));
    await user.click(trigger());
    expect((screen.getByRole("group", { name: "Filters" }) as HTMLElement).style.transform).toBe("translateX(-108px)");
    await user.click(trigger());
    spy.mockReturnValue(rect(-20, 180));
    await user.click(trigger());
    expect((screen.getByRole("group", { name: "Filters" }) as HTMLElement).style.transform).toBe("translateX(28px)");
  });
});

describe("BoardFilterChips", () => {
  const chips: FilterChip[] = [
    { id: "status", label: "Status: To-Do" },
    { id: "today", label: "In today's daily" },
  ];

  it("renders nothing without chips", () => {
    const { container } = render(<BoardFilterChips chips={[]} onRemove={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("lists the active filters and removes one by id", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<BoardFilterChips chips={chips} onRemove={onRemove} />);
    expect(within(screen.getByRole("list", { name: "Active filters" })).getAllByRole("listitem")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Remove filter In today's daily" }));
    expect(onRemove).toHaveBeenCalledWith("today");
  });
});
