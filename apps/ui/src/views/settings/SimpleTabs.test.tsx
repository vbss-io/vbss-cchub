import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { GroupRecord } from "../../types";
import { UiPrefsProvider } from "../../ui-prefs-context";
import { fullSettings } from "../../test-support/u5-fixtures";
import { AppearanceTab } from "./AppearanceTab";
import { GroupsTab } from "./GroupsTab";
import { SessionsTab } from "./SessionsTab";

vi.mock("../../components/GroupManager", () => ({
  GroupManager: (props: { groups: GroupRecord[]; onCreate: (name: string, match: string) => void; onUpdate: (id: string, fields: { name?: string }) => void; onDelete: (id: string) => void; onMove: (id: string, direction: -1 | 1) => void }) => (
    <div data-testid="group-manager">
      <span>{props.groups.map((group) => group.name).join(",")}</span>
      <button onClick={() => props.onCreate("N", "m")}>create</button>
      <button onClick={() => props.onUpdate("g1", { name: "R" })}>update</button>
      <button onClick={() => props.onDelete("g1")}>delete</button>
      <button onClick={() => props.onMove("g1", 1)}>move</button>
    </div>
  ),
}));

vi.mock("./SidebarSettings", () => ({ SidebarSettings: ({ settings }: { settings: unknown }) => <div data-testid="sidebar-settings">{settings === null ? "no settings" : "settings"}</div> }));

test("AppearanceTab lists the themes, shows the current one and reports a change", async () => {
  const onTheme = vi.fn();
  render(<AppearanceTab settings={fullSettings()} theme="dracula" onTheme={onTheme} />);
  const select = screen.getByRole("combobox") as HTMLSelectElement;
  expect(select.value).toBe("dracula");
  expect([...select.options].map((option) => option.value)).toEqual(["dracula", "midnight"]);
  await userEvent.selectOptions(select, "midnight");
  expect(onTheme).toHaveBeenCalledWith("midnight");
  expect(screen.getByTestId("sidebar-settings").textContent).toBe("settings");
});

test("AppearanceTab passes missing settings through to the sidebar section", () => {
  render(<AppearanceTab settings={null} theme="midnight" onTheme={() => undefined} />);
  expect(screen.getByTestId("sidebar-settings").textContent).toBe("no settings");
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("midnight");
});

test("GroupsTab hands the groups and the four callbacks to the manager", async () => {
  const handlers = { onCreateGroup: vi.fn(), onUpdateGroup: vi.fn(), onDeleteGroup: vi.fn(), onMoveGroup: vi.fn() };
  const groups = [{ id: "g1", name: "API", match: "api", position: 0 }] as GroupRecord[];
  render(<GroupsTab groups={groups} {...handlers} />);
  expect(screen.getByTestId("group-manager").textContent).toContain("API");
  await userEvent.click(screen.getByRole("button", { name: "create" }));
  await userEvent.click(screen.getByRole("button", { name: "update" }));
  await userEvent.click(screen.getByRole("button", { name: "delete" }));
  await userEvent.click(screen.getByRole("button", { name: "move" }));
  expect(handlers.onCreateGroup).toHaveBeenCalledWith("N", "m");
  expect(handlers.onUpdateGroup).toHaveBeenCalledWith("g1", { name: "R" });
  expect(handlers.onDeleteGroup).toHaveBeenCalledWith("g1");
  expect(handlers.onMoveGroup).toHaveBeenCalledWith("g1", 1);
});

test("SessionsTab shows Needs you on top as on by default and saves the toggle through the prefs context", async () => {
  const updateUiPrefs = vi.fn(async () => undefined);
  render(
    <UiPrefsProvider value={{ uiPrefs: { sidebar: null, layout: {} }, loaded: true, updateUiPrefs }}>
      <SessionsTab />
    </UiPrefsProvider>,
  );
  const box = screen.getByRole("checkbox", { name: "Needs you on top" }) as HTMLInputElement;
  expect(box.checked).toBe(true);
  await userEvent.click(box);
  expect(updateUiPrefs).toHaveBeenCalledTimes(1);
  const patch = (updateUiPrefs.mock.calls[0] as unknown as [{ layout: Record<string, Record<string, number>> }])[0];
  const values = Object.values(patch.layout).flatMap((screenPrefs) => Object.values(screenPrefs));
  expect(values).toEqual([0]);
});

test("SessionsTab reflects a saved off state and stays disabled until the prefs are loaded", async () => {
  const updateUiPrefs = vi.fn(async () => undefined);
  const off = { layout: { sessions: { needsYouTop: 0 } } };
  const { rerender } = render(
    <UiPrefsProvider value={{ uiPrefs: { sidebar: null, layout: {} }, loaded: false, updateUiPrefs }}>
      <SessionsTab />
    </UiPrefsProvider>,
  );
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  rerender(
    <UiPrefsProvider value={{ uiPrefs: { sidebar: null, ...off }, loaded: true, updateUiPrefs }}>
      <SessionsTab />
    </UiPrefsProvider>,
  );
  const box = screen.getByRole("checkbox") as HTMLInputElement;
  expect(box.disabled).toBe(false);
  expect(box.checked).toBe(false);
  await userEvent.click(box);
  expect(updateUiPrefs).toHaveBeenCalledWith({ layout: { sessions: { needsYouTop: 1 } } });
});
