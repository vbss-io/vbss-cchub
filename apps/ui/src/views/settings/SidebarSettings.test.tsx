import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { expect, test, vi } from "vitest";
import type { DelegationSettings, SidebarPrefs, UiPrefsPatch } from "../../delegation";
import { fullSettings } from "../../test-support/u5-fixtures";
import { UiPrefsProvider } from "../../ui-prefs-context";
import { SidebarSettings } from "./SidebarSettings";

const features = { daily: true, trail: false, usage: true, limits: false, tasks: true, flow: false, delegated: false, workspaces: true, reports: false, share: false, widget: false };

const settings = (): DelegationSettings => fullSettings({ features });

const prefs: SidebarPrefs = { order: ["sessions", "daily", "board", "usage", "workspaces"], pinned: ["sessions", "daily"] };

const Harness = ({ initial, loaded = true, onSave, children }: { initial: SidebarPrefs | null; loaded?: boolean; onSave: (patch: UiPrefsPatch) => void; children: ReactNode }) => {
  const [sidebar, setSidebar] = useState<SidebarPrefs | null>(initial);
  return (
    <UiPrefsProvider
      value={{
        uiPrefs: { sidebar, layout: {} },
        loaded,
        updateUiPrefs: async (patch) => {
          onSave(patch);
          if (patch.sidebar !== undefined) setSidebar(patch.sidebar);
        },
      }}
    >
      {children}
    </UiPrefsProvider>
  );
};

const setup = (initial: SidebarPrefs | null = prefs, options: { loaded?: boolean; settings?: DelegationSettings | null } = {}) => {
  const onSave = vi.fn();
  const view = render(
    <Harness initial={initial} loaded={options.loaded} onSave={onSave}>
      <SidebarSettings settings={options.settings === undefined ? settings() : options.settings} />
    </Harness>,
  );
  return { onSave, ...view };
};

const labels = (): string[] => [...document.querySelectorAll(".sidebar-row__label")].map((node) => node.textContent ?? "");

const row = (name: string): HTMLElement => {
  const node = [...document.querySelectorAll<HTMLElement>(".sidebar-row")].find((candidate) => candidate.querySelector(".sidebar-row__label")?.textContent === name);
  if (!node) throw new Error(`no row ${name}`);
  return node;
};

const transfer = () => ({ effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: vi.fn() });

test("lists the pinned rows first, then the ones under More, with their group headings", () => {
  setup();
  expect(labels()).toEqual(["Sessions", "Today", "Tasks", "Usage", "Workspaces"]);
  const groups = [...document.querySelectorAll(".sidebar-list__group")].map((node) => node.textContent);
  expect(groups).toEqual(["In the sidebar", "In More"]);
  expect(within(row("Sessions")).getByRole("radio", { name: "Pinned" }).getAttribute("aria-checked")).toBe("true");
  expect(within(row("Tasks")).getByRole("radio", { name: "In More" }).getAttribute("aria-checked")).toBe("true");
});

test("without saved prefs the default placement is used and Reset to default is disabled", () => {
  setup(null);
  expect(labels()[0]).toBe("Sessions");
  expect((screen.getByRole("button", { name: "Reset to default" }) as HTMLButtonElement).disabled).toBe(true);
});

test("Reset to default clears the saved sidebar", async () => {
  const { onSave } = setup();
  await userEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  expect(onSave).toHaveBeenCalledWith({ sidebar: null });
});

test("pinning a row under More saves the new order and moves keyboard focus to its grip", async () => {
  const { onSave } = setup();
  await userEvent.click(within(row("Tasks")).getByRole("radio", { name: "Pinned" }));
  expect(onSave).toHaveBeenCalledWith({ sidebar: { order: ["sessions", "daily", "board", "usage", "workspaces"], pinned: ["sessions", "daily", "board"] } });
  expect(document.activeElement).toBe(within(row("Tasks")).getByRole("button", { name: /^Move Tasks\./ }));
});

test("moving a pinned row under More saves it, but the last pinned row cannot leave the sidebar", async () => {
  const { onSave } = setup();
  await userEvent.click(within(row("Today")).getByRole("radio", { name: "In More" }));
  expect(onSave).toHaveBeenCalledWith({ sidebar: { order: ["sessions", "daily", "board", "usage", "workspaces"], pinned: ["sessions"] } });
  const lastPinned = within(row("Sessions")).getByRole("radio", { name: "In More" }) as HTMLButtonElement;
  expect(lastPinned.disabled).toBe(true);
  expect(lastPinned.title).toBe("Keep at least one item pinned");
});

test("the arrows move a row within its group and are disabled at the group edges", async () => {
  const { onSave } = setup();
  const up = (name: string) => within(row(name)).getByRole("button", { name: `Move ${name} up` }) as HTMLButtonElement;
  const down = (name: string) => within(row(name)).getByRole("button", { name: `Move ${name} down` }) as HTMLButtonElement;
  expect(up("Sessions").disabled).toBe(true);
  expect(down("Today").disabled).toBe(true);
  expect(up("Tasks").disabled).toBe(true);
  expect(down("Workspaces").disabled).toBe(true);
  await userEvent.click(down("Sessions"));
  expect(onSave).toHaveBeenLastCalledWith({ sidebar: { order: ["daily", "sessions", "board", "usage", "workspaces"], pinned: ["daily", "sessions"] } });
  expect(labels().slice(0, 2)).toEqual(["Today", "Sessions"]);
});

test("moving a row up inside More keeps focus on the same arrow while it can still move", async () => {
  setup();
  await userEvent.click(within(row("Workspaces")).getByRole("button", { name: "Move Workspaces up" }));
  expect(labels()).toEqual(["Sessions", "Today", "Tasks", "Workspaces", "Usage"]);
  expect(document.activeElement).toBe(within(row("Workspaces")).getByRole("button", { name: "Move Workspaces up" }));
});

test("Alt plus the arrow keys on the grip reorder a row, other keys do nothing", () => {
  const { onSave } = setup();
  const grip = (name: string) => within(row(name)).getByRole("button", { name: new RegExp(`^Move ${name}\\.`) });
  fireEvent.keyDown(grip("Sessions"), { key: "ArrowDown" });
  fireEvent.keyDown(grip("Sessions"), { key: "Enter", altKey: true });
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.keyDown(grip("Sessions"), { key: "ArrowDown", altKey: true });
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(labels().slice(0, 2)).toEqual(["Today", "Sessions"]);
  fireEvent.keyDown(grip("Sessions"), { key: "ArrowUp", altKey: true });
  expect(onSave).toHaveBeenCalledTimes(2);
  expect(labels().slice(0, 2)).toEqual(["Sessions", "Today"]);
});

test("Alt arrow on a row already at its group edge changes nothing", () => {
  const { onSave } = setup();
  fireEvent.keyDown(within(row("Sessions")).getByRole("button", { name: /^Move Sessions\./ }), { key: "ArrowUp", altKey: true });
  expect(onSave).not.toHaveBeenCalled();
});

test("dragging a row onto another reorders and regroups the list", () => {
  const { onSave } = setup();
  const dataTransfer = transfer();
  fireEvent.dragStart(row("Sessions"), { dataTransfer });
  expect(dataTransfer.effectAllowed).toBe("move");
  expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "sessions");
  expect(row("Sessions").className).toContain("sidebar-row--drag");
  fireEvent.dragOver(row("Tasks"), { dataTransfer });
  expect(row("Tasks").className).toContain("sidebar-row--over");
  expect(dataTransfer.dropEffect).toBe("move");
  fireEvent.drop(row("Tasks"), { dataTransfer });
  expect(onSave).toHaveBeenCalledWith({ sidebar: { order: ["daily", "board", "sessions", "usage", "workspaces"], pinned: ["daily"] } });
  expect(labels().slice(0, 3)).toEqual(["Today", "Tasks", "Sessions"]);
  expect(document.querySelector(".sidebar-row--drag")).toBeNull();
  expect(document.querySelector(".sidebar-row--over")).toBeNull();
});

test("a drag that ends without a drop clears the highlight and a stray dragOver is ignored", () => {
  const { onSave } = setup();
  const dataTransfer = transfer();
  fireEvent.dragOver(row("Tasks"), { dataTransfer });
  expect(row("Tasks").className).not.toContain("sidebar-row--over");
  fireEvent.dragStart(row("Today"), { dataTransfer });
  fireEvent.dragOver(row("Tasks"), { dataTransfer });
  fireEvent.dragOver(row("Tasks"), { dataTransfer });
  expect(row("Tasks").className).toContain("sidebar-row--over");
  fireEvent.dragEnd(row("Today"));
  expect(document.querySelector(".sidebar-row--drag")).toBeNull();
  expect(document.querySelector(".sidebar-row--over")).toBeNull();
  fireEvent.drop(row("Tasks"), { dataTransfer });
  expect(onSave).not.toHaveBeenCalled();
});

test("dropping a row on itself changes nothing", () => {
  const { onSave } = setup();
  const dataTransfer = transfer();
  fireEvent.dragStart(row("Today"), { dataTransfer });
  fireEvent.drop(row("Today"), { dataTransfer });
  expect(onSave).not.toHaveBeenCalled();
});

test("nothing is editable until the settings and the prefs have loaded", () => {
  const { onSave } = setup(null, { settings: null });
  expect(document.querySelector(".sidebar-list")?.getAttribute("aria-busy")).toBe("true");
  expect((screen.getByRole("button", { name: "Reset to default" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(row("Workspaces")).getByRole("radio", { name: "Pinned" }) as HTMLButtonElement).disabled).toBe(true);
  expect(row("Workspaces").getAttribute("draggable")).toBe("false");
  const dataTransfer = transfer();
  fireEvent.keyDown(within(row("Sessions")).getByRole("button", { name: /^Move Sessions\./ }), { key: "ArrowDown", altKey: true });
  fireEvent.dragStart(row("Sessions"), { dataTransfer });
  fireEvent.dragOver(row("Workspaces"), { dataTransfer });
  fireEvent.drop(row("Workspaces"), { dataTransfer });
  expect(onSave).not.toHaveBeenCalled();
});

test("prefs still loading keep the list read-only even with settings present", () => {
  setup(prefs, { loaded: false });
  expect(document.querySelector(".sidebar-list")?.getAttribute("aria-busy")).toBe("true");
  act(() => undefined);
  expect((within(row("Today")).getByRole("button", { name: "Move Today up" }) as HTMLButtonElement).disabled).toBe(true);
});
