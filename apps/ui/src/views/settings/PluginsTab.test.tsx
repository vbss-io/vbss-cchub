import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { fullSettings } from "../../test-support/u5-fixtures";
import { PluginsTab } from "./PluginsTab";

const api = vi.hoisted(() => ({ fetchPlugins: vi.fn<() => Promise<unknown>>() }));

vi.mock("../../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../delegation")>()), fetchPlugins: api.fetchPlugins }));

beforeEach(() => {
  api.fetchPlugins.mockReset().mockResolvedValue(null);
  window.location.hash = "";
});

const setup = (props: Partial<Parameters<typeof PluginsTab>[0]> = {}) => {
  const onSaveSettings = vi.fn(async () => undefined);
  const onFocusRestored = vi.fn();
  const view = render(<PluginsTab enabled settings={fullSettings()} onSaveSettings={onSaveSettings} restoreFocus={null} onFocusRestored={onFocusRestored} {...props} />);
  return { onSaveSettings, onFocusRestored, ...view };
};

const row = (name: string): HTMLElement => {
  const node = [...document.querySelectorAll<HTMLElement>(".plugin-row")].find((candidate) => candidate.querySelector(".plugin-row__name")?.textContent === name);
  if (!node) throw new Error(`no row ${name}`);
  return node;
};

test("lists every plugin with its description, marking the core one", () => {
  setup();
  const names = [...document.querySelectorAll(".plugin-row__name")].map((node) => node.textContent);
  expect(names).toEqual(["Sessions", "Today", "Tasks", "Flow", "Delegated", "Usage", "Limits", "Workspaces", "Reports", "Share", "Session trail", "Widget"]);
  expect(within(row("Sessions")).getByText("Core")).toBeTruthy();
  expect(within(row("Sessions")).queryByRole("switch")).toBeNull();
  expect(within(row("Today")).getByText(/Your daily note as a plan/)).toBeTruthy();
});

test("each switch reflects its feature and saves the flipped value", async () => {
  const { onSaveSettings } = setup({ settings: fullSettings({ features: { daily: true, trail: false, usage: true, limits: true, tasks: true, flow: false, delegated: true, workspaces: true, reports: true, share: true, widget: true } }) });
  expect((within(row("Today")).getByRole("switch") as HTMLInputElement).checked).toBe(true);
  expect((within(row("Flow")).getByRole("switch") as HTMLInputElement).checked).toBe(false);
  await userEvent.click(within(row("Today")).getByRole("switch"));
  expect(onSaveSettings).toHaveBeenLastCalledWith({ features: { daily: false } });
  await userEvent.click(within(row("Flow")).getByRole("switch"));
  expect(onSaveSettings).toHaveBeenLastCalledWith({ features: { flow: true } });
  expect(within(row("Flow")).getByTitle("Turn on Flow")).toBeTruthy();
  expect(within(row("Today")).getByTitle("Turn off Today")).toBeTruthy();
});

test("the options gear opens the plugin page when on and is disabled when off", async () => {
  setup({ settings: fullSettings({ features: { daily: false, trail: true, usage: true, limits: true, tasks: true } }) });
  const off = within(row("Today")).getByRole("button", { name: "Today settings" }) as HTMLButtonElement;
  expect(off.disabled).toBe(true);
  expect(off.parentElement?.title).toBe("Turn it on to configure");
  const on = within(row("Tasks")).getByRole("button", { name: "Tasks settings" }) as HTMLButtonElement;
  expect(on.parentElement?.title).toBe("Tasks settings");
  await userEvent.click(on);
  expect(window.location.hash).toBe("#/settings/plugin-tasks");
  await userEvent.click(within(row("Sessions")).getByRole("button", { name: "Sessions settings" }));
  expect(window.location.hash).toBe("#/settings/plugin-sessions");
  expect(within(row("Flow")).queryByRole("button")).toBeNull();
});

test("plugins that need a vault say so until a second brain is set", () => {
  const first = setup({ settings: fullSettings({ secondBrainRoot: "  " }) });
  for (const name of ["Today", "Tasks", "Session trail"]) expect(within(row(name)).getByText("Needs a vault folder")).toBeTruthy();
  expect(within(row("Flow")).queryByText("Needs a vault folder")).toBeNull();
  first.unmount();
  setup();
  expect(document.querySelector(".plugin-row__hint")).toBeNull();
});

test("before the settings arrive the list is busy, switches are disabled and a loading note shows", () => {
  setup({ settings: null });
  expect(screen.getByRole("status").textContent).toBe("Loading your plugin settings...");
  expect(document.querySelector(".plugin-list")?.getAttribute("aria-busy")).toBe("true");
  expect((within(row("Today")).getByRole("switch") as HTMLInputElement).disabled).toBe(true);
  expect((within(row("Today")).getByRole("switch") as HTMLInputElement).checked).toBe(false);
  expect((within(row("Tasks")).getByRole("button", { name: "Tasks settings" }) as HTMLButtonElement).disabled).toBe(true);
  expect(document.querySelector(".plugin-row__hint")).toBeNull();
});

test("with the hub off the switches are locked and no loading note shows", () => {
  setup({ enabled: false, settings: null });
  expect(screen.queryByRole("status")).toBeNull();
  expect((within(row("Today")).getByRole("switch") as HTMLInputElement).disabled).toBe(true);
});

test("plugins show how many agent tools they bring and the toggletip lists them", async () => {
  api.fetchPlugins.mockResolvedValue([
    { id: "core", name: "Core", enabled: true, tools: ["hub_overview", "hub_workspaces"] },
    { id: "tasks", name: "Tasks", enabled: true, tools: ["hub_tasks"] },
    { id: "share", name: "Share", enabled: true, tools: [] },
  ]);
  setup();
  expect(await within(row("Sessions")).findByText("2 agent tools")).toBeTruthy();
  expect(within(row("Tasks")).getByText("1 agent tool")).toBeTruthy();
  expect(within(row("Share")).queryByText(/agent tool/)).toBeNull();
  expect(within(row("Flow")).queryByText(/agent tool/)).toBeNull();
  await userEvent.click(within(row("Sessions")).getByRole("button", { name: "Sessions agent tools" }));
  expect([...document.querySelectorAll(".plugin-row__tools-list code")].map((node) => node.textContent)).toEqual(["hub_overview", "hub_workspaces"]);
});

test("a failing plugin list leaves the rows without tool counts", async () => {
  api.fetchPlugins.mockRejectedValue(new Error("down"));
  setup();
  await vi.waitFor(() => expect(api.fetchPlugins).toHaveBeenCalled());
  expect(document.querySelector(".plugin-row__tools")).toBeNull();
});

test("a plugin list that arrives after unmount is dropped", async () => {
  let finish: (value: unknown) => void = () => undefined;
  api.fetchPlugins.mockReturnValueOnce(new Promise((done) => (finish = done)));
  const { unmount } = setup();
  unmount();
  finish([{ id: "core", name: "Core", enabled: true, tools: ["x"] }]);
  await Promise.resolve();
  expect(document.body.textContent).toBe("");
});

test("returning from a plugin page puts focus back on that plugin's gear and reports it", () => {
  const { onFocusRestored } = setup({ restoreFocus: "tasks" });
  expect(document.activeElement).toBe(within(row("Tasks")).getByRole("button", { name: "Tasks settings" }));
  expect(onFocusRestored).toHaveBeenCalledTimes(1);
});

test("restoring focus for a plugin without a gear still reports completion", () => {
  const { onFocusRestored } = setup({ restoreFocus: "flow" });
  expect(onFocusRestored).toHaveBeenCalledTimes(1);
});
