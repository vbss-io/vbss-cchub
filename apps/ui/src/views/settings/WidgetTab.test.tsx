import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { fullSettings } from "../../test-support/u5-fixtures";
import { WidgetTab } from "./WidgetTab";

const setup = (props: Partial<Parameters<typeof WidgetTab>[0]> = {}) => {
  const onSaveSettings = vi.fn(async () => undefined);
  render(<WidgetTab enabled settings={fullSettings()} onSaveSettings={onSaveSettings} {...props} />);
  return { onSaveSettings };
};

const group = (name: string) => within(screen.getByRole("radiogroup", { name }));

test("shows the saved edge, startup, rings and panel", () => {
  setup();
  expect(group("Widget edge").getByRole("radio", { name: "Right" }).getAttribute("aria-checked")).toBe("true");
  expect(group("Widget edge").getByRole("radio", { name: "Left" }).getAttribute("aria-checked")).toBe("false");
  expect((screen.getByRole("checkbox", { name: "Show at startup" }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("checkbox", { name: "Claude" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("checkbox", { name: "Codex" }) as HTMLInputElement).checked).toBe(false);
  expect(group("Default widget panel").getByRole("radio", { name: "Sessions" }).getAttribute("aria-checked")).toBe("true");
});

test("without settings the defaults are right edge, shown at startup, no rings and the sessions panel", () => {
  setup({ settings: null });
  expect(group("Widget edge").getByRole("radio", { name: "Right" }).getAttribute("aria-checked")).toBe("true");
  expect((screen.getByRole("checkbox", { name: "Show at startup" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("checkbox", { name: "Claude" }) as HTMLInputElement).checked).toBe(false);
  expect(group("Default widget panel").getByRole("radio", { name: "Sessions" }).getAttribute("aria-checked")).toBe("true");
});

test("every control saves its own slice of the widget settings", async () => {
  const { onSaveSettings } = setup();
  await userEvent.click(group("Widget edge").getByRole("radio", { name: "Top" }));
  expect(onSaveSettings).toHaveBeenLastCalledWith({ widget: { edge: "top" } });
  await userEvent.click(group("Widget edge").getByRole("radio", { name: "Left" }));
  expect(onSaveSettings).toHaveBeenLastCalledWith({ widget: { edge: "left" } });
  await userEvent.click(screen.getByRole("checkbox", { name: "Show at startup" }));
  expect(onSaveSettings).toHaveBeenLastCalledWith({ widget: { autostart: true } });
  await userEvent.click(screen.getByRole("checkbox", { name: "Claude" }));
  expect(onSaveSettings).toHaveBeenLastCalledWith({ widget: { rings: { claude: false } } });
  await userEvent.click(screen.getByRole("checkbox", { name: "Codex" }));
  expect(onSaveSettings).toHaveBeenLastCalledWith({ widget: { rings: { codex: true } } });
  await userEvent.click(group("Default widget panel").getByRole("radio", { name: "Usage" }));
  expect(onSaveSettings).toHaveBeenLastCalledWith({ widget: { panel: "usage" } });
});

test("all controls are disabled while the hub surface is off", () => {
  setup({ enabled: false });
  for (const radio of screen.getAllByRole("radio")) expect((radio as HTMLButtonElement).disabled).toBe(true);
  for (const box of screen.getAllByRole("checkbox")) expect((box as HTMLInputElement).disabled).toBe(true);
});
