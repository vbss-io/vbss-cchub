import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { UiPrefs } from "./delegation";
import { UiPrefsProvider, useUiPrefs } from "./ui-prefs-context";

function Probe() {
  const { uiPrefs, loaded, updateUiPrefs } = useUiPrefs();
  return (
    <div>
      <span data-testid="state">{JSON.stringify({ uiPrefs, loaded })}</span>
      <button type="button" onClick={() => void updateUiPrefs({ sidebar: null })}>
        save
      </button>
    </div>
  );
}

test("without a provider the defaults are empty prefs, loaded, and a no-op save", async () => {
  render(<Probe />);
  expect(JSON.parse(screen.getByTestId("state").textContent ?? "")).toEqual({ uiPrefs: { sidebar: null, layout: {} }, loaded: true });
  await userEvent.click(screen.getByRole("button", { name: "save" }));
  expect(screen.getByTestId("state")).toBeTruthy();
});

test("the provider supplies prefs and the save callback to its children", async () => {
  const uiPrefs: UiPrefs = { sidebar: { order: ["a"], pinned: ["a"] }, layout: { board: { w: 1 } } };
  const updateUiPrefs = vi.fn(async () => undefined);
  render(
    <UiPrefsProvider value={{ uiPrefs, loaded: false, updateUiPrefs }}>
      <Probe />
    </UiPrefsProvider>,
  );
  expect(JSON.parse(screen.getByTestId("state").textContent ?? "")).toEqual({ uiPrefs, loaded: false });
  await userEvent.click(screen.getByRole("button", { name: "save" }));
  expect(updateUiPrefs).toHaveBeenCalledWith({ sidebar: null });
});
