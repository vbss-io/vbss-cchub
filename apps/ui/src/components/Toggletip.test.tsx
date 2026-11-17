import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { Toggletip } from "./Toggletip";

afterEach(() => {
  vi.restoreAllMocks();
});

const trigger = (): HTMLButtonElement => screen.getByRole("button", { name: "About this" });

test("the trigger starts collapsed with an accessible label", () => {
  render(<Toggletip label="About this">Hello</Toggletip>);
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(trigger().getAttribute("aria-controls")).toBeNull();
  expect(trigger().title).toBe("About this");
  expect(screen.queryByRole("status")).toBeNull();
});

test("clicking toggles the popover and links it to the trigger", async () => {
  render(<Toggletip label="About this">Hello</Toggletip>);
  await userEvent.click(trigger());
  const pop = screen.getByRole("status");
  expect(pop.textContent).toBe("Hello");
  expect(pop.className).toContain("toggletip__pop--start");
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(trigger().getAttribute("aria-controls")).toBe(pop.id);
  await userEvent.click(trigger());
  expect(screen.queryByRole("status")).toBeNull();
});

test("the end alignment is reflected in the popover class", async () => {
  render(
    <Toggletip label="About this" align="end">
      Hello
    </Toggletip>,
  );
  await userEvent.click(trigger());
  expect(screen.getByRole("status").className).toContain("toggletip__pop--end");
});

test("clicking outside closes it but clicking inside keeps it open", async () => {
  render(
    <div>
      <Toggletip label="About this">Hello</Toggletip>
      <button>elsewhere</button>
    </div>,
  );
  await userEvent.click(trigger());
  await userEvent.click(screen.getByRole("status"));
  expect(screen.getByRole("status")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "elsewhere" }));
  expect(screen.queryByRole("status")).toBeNull();
});

test("Escape closes it, returns focus to the trigger and does not reach other key listeners", async () => {
  const outer = vi.fn();
  document.addEventListener("keydown", outer);
  render(<Toggletip label="About this">Hello</Toggletip>);
  await userEvent.click(trigger());
  fireEvent.keyDown(document.body, { key: "a" });
  expect(screen.getByRole("status")).toBeTruthy();
  outer.mockClear();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByRole("status")).toBeNull();
  expect(document.activeElement).toBe(trigger());
  expect(outer).not.toHaveBeenCalled();
  document.removeEventListener("keydown", outer);
});

test("a popover that overflows the left edge is shifted into the viewport", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: -30, right: 120, top: 0, bottom: 10, width: 150, height: 10, x: -30, y: 0, toJSON: () => ({}) });
  render(<Toggletip label="About this">Hello</Toggletip>);
  await userEvent.click(trigger());
  expect(screen.getByRole("status").style.transform).toBe("translateX(38px)");
});

test("a popover that overflows the right edge is shifted back", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 900, right: window.innerWidth + 40, top: 0, bottom: 10, width: 200, height: 10, x: 900, y: 0, toJSON: () => ({}) });
  render(<Toggletip label="About this">Hello</Toggletip>);
  await userEvent.click(trigger());
  expect(screen.getByRole("status").style.transform).toBe("translateX(-48px)");
});

test("a popover inside the viewport is not moved", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 100, right: 200, top: 0, bottom: 10, width: 100, height: 10, x: 100, y: 0, toJSON: () => ({}) });
  render(<Toggletip label="About this">Hello</Toggletip>);
  await userEvent.click(trigger());
  expect(screen.getByRole("status").style.transform).toBe("");
});
