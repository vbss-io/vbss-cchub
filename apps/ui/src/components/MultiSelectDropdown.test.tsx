import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MultiSelectDropdown, type MultiSelectOption } from "./MultiSelectDropdown";

const options: MultiSelectOption[] = [
  { id: "a", label: "Alpha", checked: true, count: 3 },
  { id: "b", label: "Beta", checked: false, title: "Second option" },
  { id: "c", label: "Gamma", checked: false, disabled: true },
];

const renderDropdown = (props: Partial<Parameters<typeof MultiSelectDropdown>[0]> = {}) => {
  const onToggle = vi.fn();
  render(<MultiSelectDropdown label="Statuses" summary="1 of 3" options={options} onToggle={onToggle} {...props} />);
  return { onToggle, trigger: screen.getByRole("button", { name: /1 of 3/ }) };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MultiSelectDropdown", () => {
  it("renders the summary closed and opens the option list on click", async () => {
    const user = userEvent.setup();
    const { trigger } = renderDropdown();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Statuses" })).toBeNull();
    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByRole("group", { name: "Statuses" });
    expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByText("3").className).toBe("pill__count");
    expect((screen.getByRole("checkbox", { name: /Alpha/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("Beta").closest("label")?.getAttribute("title")).toBe("Second option");
  });

  it("calls onToggle with the option id and ignores disabled options", async () => {
    const user = userEvent.setup();
    const { trigger, onToggle } = renderDropdown();
    await user.click(trigger);
    await user.click(screen.getByRole("checkbox", { name: /Beta/ }));
    expect(onToggle).toHaveBeenCalledWith("b");
    await user.click(screen.getByRole("checkbox", { name: /Gamma/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Gamma").closest("label")?.className).toContain("msd__item--disabled");
  });

  it("runs shortcuts and honours their disabled state", async () => {
    const user = userEvent.setup();
    const onAll = vi.fn();
    const onNone = vi.fn();
    const { trigger } = renderDropdown({
      shortcuts: [
        { label: "All", onClick: onAll },
        { label: "None", onClick: onNone, disabled: true },
      ],
    });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "All" }));
    await user.click(screen.getByRole("button", { name: "None" }));
    expect(onAll).toHaveBeenCalledTimes(1);
    expect(onNone).not.toHaveBeenCalled();
  });

  it("opens with ArrowDown and focuses the first enabled checkbox", async () => {
    const { trigger } = renderDropdown();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("group", { name: "Statuses" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: /Alpha/ })));
  });

  it("ignores other keys on the trigger", () => {
    const { trigger } = renderDropdown();
    fireEvent.keyDown(trigger, { key: "a" });
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const { trigger } = renderDropdown();
    await user.click(trigger);
    await user.click(screen.getByRole("checkbox", { name: /Beta/ }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not swallow Escape while closed", () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <MultiSelectDropdown label="Statuses" summary="x" options={options} onToggle={() => undefined} />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole("button"), { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("closes on a pointer down outside but not inside", async () => {
    const user = userEvent.setup();
    const { trigger } = renderDropdown();
    await user.click(trigger);
    fireEvent.pointerDown(screen.getByRole("checkbox", { name: /Alpha/ }));
    expect(screen.getByRole("group")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("closes when focus leaves the control", async () => {
    const user = userEvent.setup();
    const { trigger } = renderDropdown();
    await user.click(trigger);
    fireEvent.blur(screen.getByRole("group"), { relatedTarget: screen.getByRole("checkbox", { name: /Alpha/ }) });
    expect(screen.getByRole("group")).toBeTruthy();
    fireEvent.blur(screen.getByRole("group"), { relatedTarget: document.body });
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("ignores blur while closed", () => {
    const { trigger } = renderDropdown();
    fireEvent.blur(trigger, { relatedTarget: document.body });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("marks the trigger as highlighted and exposes the title", () => {
    const { trigger } = renderDropdown({ highlighted: true, title: "Pick statuses" });
    expect(trigger.className).toContain("msd__btn--on");
    expect(trigger.getAttribute("title")).toBe("Pick statuses");
  });

  it("keeps the panel inside the viewport by shifting it", async () => {
    const user = userEvent.setup();
    const { trigger } = renderDropdown();
    const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 0, width: right - left, height: 0, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    spy.mockReturnValue(rect(100, 300));
    await user.click(trigger);
    expect((screen.getByRole("group") as HTMLElement).style.transform).toBe("");
    await user.click(trigger);
    spy.mockReturnValue(rect(900, window.innerWidth + 200));
    await user.click(trigger);
    expect((screen.getByRole("group") as HTMLElement).style.transform).toBe(`translateX(${window.innerWidth - 8 - (window.innerWidth + 200)}px)`);
    await user.click(trigger);
    spy.mockReturnValue(rect(-50, 100));
    await user.click(trigger);
    expect((screen.getByRole("group") as HTMLElement).style.transform).toBe("translateX(58px)");
  });
});
