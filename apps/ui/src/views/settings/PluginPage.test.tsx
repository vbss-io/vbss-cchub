import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import type { TunnelStatus } from "../../delegation";
import type { PluginId } from "../../plugins/types";
import type { SettingsPageEntry } from "../../settings-model";
import { fullSettings } from "../../test-support/u5-fixtures";
import { PluginPage } from "./PluginPage";

const api = vi.hoisted(() => ({ fetchPlugins: vi.fn<() => Promise<unknown>>() }));

vi.mock("../../delegation", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../delegation")>()), fetchPlugins: api.fetchPlugins }));

vi.mock("./SessionsTab", () => ({ SessionsTab: () => <div data-testid="sessions-tab" /> }));
vi.mock("./TodayTab", () => ({ TodayTab: (props: { enabled: boolean }) => <div data-testid="today-tab" data-enabled={String(props.enabled)} /> }));
vi.mock("./TasksTab", () => ({ TasksTab: () => <div data-testid="tasks-tab" /> }));
vi.mock("./TrailTab", () => ({ TrailTab: () => <div data-testid="trail-tab" /> }));
vi.mock("./WidgetTab", () => ({ WidgetTab: () => <div data-testid="widget-tab" /> }));
vi.mock("./UsageTab", () => ({ UsageTab: (props: { usageOn: boolean; limitsOn: boolean }) => <div data-testid="usage-tab" data-usage={String(props.usageOn)} data-limits={String(props.limitsOn)} /> }));
vi.mock("./ShareTab", () => ({ ShareTab: (props: { tunnel: TunnelStatus | null; onTunnelSettings: () => Promise<void> }) => <div data-testid="share-tab" data-tunnel={props.tunnel?.state ?? "none"} /> }));

beforeEach(() => {
  api.fetchPlugins.mockReset().mockResolvedValue(null);
  window.location.hash = "";
});

const page = (key: string, label: string, pluginIds: PluginId[]): SettingsPageEntry => ({ key, label, pluginIds });

const setup = (entry: SettingsPageEntry, features: Parameters<typeof PluginPage>[0]["features"] = fullSettings().features) =>
  render(<PluginPage page={entry} pluginId={entry.pluginIds[0] ?? "sessions"} features={features} enabled settings={fullSettings()} onSaveSettings={async () => undefined} tunnel={null} onTunnelSettings={async () => undefined} />);

test("the header shows the page label as the focused heading and a back link to Plugins", async () => {
  setup(page("plugin-today", "Today", ["today"]));
  const heading = screen.getByRole("heading", { name: "Today" });
  expect(document.activeElement).toBe(heading);
  await userEvent.click(screen.getByRole("button", { name: /Plugins/ }));
  expect(window.location.hash).toBe("#/settings/plugins");
});

test.each([
  ["sessions", "sessions-tab"],
  ["today", "today-tab"],
  ["tasks", "tasks-tab"],
  ["trail", "trail-tab"],
  ["usage", "usage-tab"],
  ["limits", "usage-tab"],
  ["widget", "widget-tab"],
  ["share", "share-tab"],
] as const)("the %s plugin renders its own settings panel", (id, testId) => {
  setup(page(`plugin-${id}`, id, [id]));
  expect(screen.getByTestId(testId)).toBeTruthy();
  expect(document.querySelectorAll("[data-testid$='-tab']")).toHaveLength(1);
  expect(document.querySelector(`[data-plugin-page="${id}"]`)).not.toBeNull();
});

test("the usage panel is told which of usage and limits are on", () => {
  setup(page("plugin-usage", "Usage", ["usage", "limits"]), { daily: true, trail: true, usage: true, limits: false, tasks: true });
  expect(screen.getByTestId("usage-tab").getAttribute("data-usage")).toBe("true");
  expect(screen.getByTestId("usage-tab").getAttribute("data-limits")).toBe("false");
});

test("a page can carry more than one plugin and shows each panel", () => {
  setup(page("plugin-today", "Combined", ["today", "tasks"]));
  expect(screen.getByTestId("today-tab")).toBeTruthy();
  expect(screen.getByTestId("tasks-tab")).toBeTruthy();
});

test("the shared tab props reach the panel", () => {
  setup(page("plugin-today", "Today", ["today"]));
  expect(screen.getByTestId("today-tab").getAttribute("data-enabled")).toBe("true");
});

test("agent tools are listed once the hub answers, including the none case", async () => {
  api.fetchPlugins.mockResolvedValue([
    { id: "tasks", name: "Tasks", enabled: true, tools: ["hub_tasks", "hub_task"] },
    { id: "trail", name: "Trail", enabled: true, tools: [] },
  ]);
  const first = setup(page("plugin-tasks", "Tasks", ["tasks"]));
  expect(document.querySelector(".plugin-page__tools")).toBeNull();
  expect(await screen.findByText("hub_tasks")).toBeTruthy();
  expect(screen.getByText("hub_task")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "About agent tools" }));
  expect(screen.getByRole("status").textContent).toContain("The MCP tools this plugin gives Claude Code and Codex sessions.");
  first.unmount();
  setup(page("plugin-trail", "Session trail", ["trail"]));
  expect(await screen.findByText("None")).toBeTruthy();
});

test("no agent tools row when the hub does not know the plugin or is unreachable", async () => {
  api.fetchPlugins.mockResolvedValue([{ id: "other", name: "Other", enabled: true, tools: ["x"] }]);
  setup(page("plugin-tasks", "Tasks", ["tasks"]));
  await vi.waitFor(() => expect(api.fetchPlugins).toHaveBeenCalled());
  expect(document.querySelector(".plugin-page__tools")).toBeNull();
});

test("a plugin list that arrives after unmount is dropped", async () => {
  let finish: (value: unknown) => void = () => undefined;
  api.fetchPlugins.mockReturnValueOnce(new Promise((done) => (finish = done)));
  const { unmount } = setup(page("plugin-tasks", "Tasks", ["tasks"]));
  unmount();
  finish([{ id: "tasks", name: "Tasks", enabled: true, tools: ["x"] }]);
  await Promise.resolve();
  expect(document.body.textContent).toBe("");
});
