import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { fullSettings } from "../test-support/u5-fixtures";
import { SettingsView } from "./SettingsView";

const calls = vi.hoisted(() => ({ plugins: [] as { restoreFocus: string | null; onFocusRestored: () => void }[] }));

vi.mock("./settings/GeneralTab", () => ({ GeneralTab: (props: { autostart: unknown }) => <div data-testid="general" data-autostart={props.autostart === null ? "none" : "set"} /> }));
vi.mock("./settings/AppearanceTab", () => ({ AppearanceTab: (props: { theme: string }) => <div data-testid="appearance" data-theme={props.theme} /> }));
vi.mock("./settings/PluginsTab", () => ({
  PluginsTab: (props: { restoreFocus: string | null; onFocusRestored: () => void }) => {
    calls.plugins.push({ restoreFocus: props.restoreFocus, onFocusRestored: props.onFocusRestored });
    return <div data-testid="plugins" data-restore={props.restoreFocus ?? "none"} />;
  },
}));
vi.mock("./settings/PluginPage", () => ({ PluginPage: (props: { pluginId: string; page: { key: string } }) => <div data-testid="plugin-page" data-plugin={props.pluginId} data-page={props.page.key} /> }));
vi.mock("./settings/MemoryTab", () => ({ MemoryTab: () => <div data-testid="memory" /> }));
vi.mock("./settings/ConnectionsTab", () => ({ ConnectionsTab: (props: { hubUrl: string }) => <div data-testid="connections" data-hub={props.hubUrl} /> }));
vi.mock("./settings/HealthTab", () => ({ HealthTab: () => <div data-testid="health" /> }));
vi.mock("./settings/NotificationsTab", () => ({ NotificationsTab: () => <div data-testid="notifications" /> }));
vi.mock("./settings/GroupsTab", () => ({ GroupsTab: () => <div data-testid="groups" /> }));
vi.mock("./settings/AboutTab", () => ({ AboutTab: (props: { version: string }) => <div data-testid="about" data-version={props.version} /> }));

beforeEach(() => {
  calls.plugins.length = 0;
  Element.prototype.scrollIntoView = vi.fn();
});

type Props = Parameters<typeof SettingsView>[0];

const props = (overrides: Partial<Props> = {}): Props => ({
  enabled: true,
  hubUrl: "http://127.0.0.1:4317",
  version: "1.4.0",
  section: null,
  settings: fullSettings(),
  connect: null,
  hooks: null,
  hooksBusy: false,
  notif: {} as Props["notif"],
  groups: [],
  subscribeHistory: () => () => undefined,
  onToggleHooks: () => undefined,
  onSaveSettings: async () => undefined,
  onShell: async () => undefined,
  onMcp: async () => undefined,
  onCodexHooks: async () => undefined,
  tunnel: null,
  onTunnelSettings: async () => undefined,
  autostart: null,
  onAutostart: async () => undefined,
  theme: "dracula",
  onTheme: () => undefined,
  onNotif: () => undefined,
  onWhatsNew: () => undefined,
  onCreateGroup: () => undefined,
  onUpdateGroup: () => undefined,
  onDeleteGroup: () => undefined,
  onMoveGroup: () => undefined,
  ...overrides,
});

const panelTabs = (): string[] => [...document.querySelectorAll("[data-testid]")].map((node) => node.getAttribute("data-testid") ?? "");

test("the navigation lists every core settings tab as a link, the active one marked as the current page", () => {
  render(<SettingsView {...props({ section: "memory" })} />);
  const links = [...screen.getByRole("navigation", { name: "Settings sections" }).querySelectorAll("a")];
  expect(links.map((link) => link.textContent)).toEqual(["General", "Appearance", "Plugins", "Memory", "Connections", "Health", "Notifications", "Groups", "About"]);
  expect(links.map((link) => link.getAttribute("href"))).toContain("#/settings/memory");
  expect(links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent)).toEqual(["Memory"]);
});

test("no section opens General and scrolls the active link into view", () => {
  render(<SettingsView {...props()} />);
  expect(panelTabs()).toEqual(["general"]);
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "center" });
  expect(document.querySelector(".settings-panel")?.getAttribute("data-tab")).toBe("general");
});

test.each([
  ["general", "general"],
  ["appearance", "appearance"],
  ["memory", "memory"],
  ["connections", "connections"],
  ["health", "health"],
  ["notifications", "notifications"],
  ["groups", "groups"],
  ["about", "about"],
  ["plugins", "plugins"],
  ["hooks", "connections"],
  ["paths", "general"],
  ["support", "about"],
  ["unknown-tab", "general"],
])("section %s shows the %s panel", (section, testId) => {
  render(<SettingsView {...props({ section })} />);
  expect(panelTabs()).toEqual([testId]);
});

test("the shell state is passed to the panels that need it", () => {
  render(<SettingsView {...props({ section: "about", version: "9.9.9" })} />);
  expect(screen.getByTestId("about").getAttribute("data-version")).toBe("9.9.9");
});

test("the connections panel gets the hub address", () => {
  render(<SettingsView {...props({ section: "connections", hubUrl: "http://hub:1" })} />);
  expect(screen.getByTestId("connections").getAttribute("data-hub")).toBe("http://hub:1");
});

test("the appearance and general panels receive the theme and autostart state", () => {
  const first = render(<SettingsView {...props({ section: "appearance", theme: "midnight" })} />);
  expect(screen.getByTestId("appearance").getAttribute("data-theme")).toBe("midnight");
  first.unmount();
  render(<SettingsView {...props({ autostart: { supported: true, enabled: true, exe: "x", error: null } })} />);
  expect(screen.getByTestId("general").getAttribute("data-autostart")).toBe("set");
});

test("a plugin page shows its own panel with the page key and plugin", () => {
  render(<SettingsView {...props({ section: "plugin-tasks" })} />);
  expect(panelTabs()).toEqual(["plugin-page"]);
  expect(screen.getByTestId("plugin-page").getAttribute("data-plugin")).toBe("tasks");
  expect(document.querySelector(".settings-panel")?.getAttribute("data-tab")).toBe("plugin-tasks");
  expect(screen.getByRole("link", { name: "Plugins" }).getAttribute("aria-current")).toBe("page");
});

test("a legacy plugin section opens the plugin's page", () => {
  render(<SettingsView {...props({ section: "daily" })} />);
  expect(screen.getByTestId("plugin-page").getAttribute("data-plugin")).toBe("today");
});

test("a plugin page for a plugin that is off falls back to the plugins list", () => {
  render(<SettingsView {...props({ section: "plugin-tasks", settings: fullSettings({ features: { daily: true, trail: true, usage: true, limits: true, tasks: false } }) })} />);
  expect(panelTabs()).toEqual(["plugins"]);
});

test("while the settings load, a plugin page shows a loading note instead of a page or the list", () => {
  render(<SettingsView {...props({ section: "plugin-tasks", settings: null })} />);
  expect(screen.getByRole("status").textContent).toBe("Loading your plugin settings...");
  expect(panelTabs()).toEqual([]);
});

test("while the hub is off, a plugin page does not wait for settings", () => {
  render(<SettingsView {...props({ section: "plugin-tasks", settings: null, enabled: false })} />);
  expect(screen.queryByRole("status")).toBeNull();
  expect(panelTabs()).toEqual(["plugins"]);
});

test("coming back from a plugin page to the list restores focus to that plugin once", async () => {
  const { rerender } = render(<SettingsView {...props({ section: "plugin-tasks" })} />);
  rerender(<SettingsView {...props({ section: "plugins" })} />);
  expect(screen.getByTestId("plugins").getAttribute("data-restore")).toBe("tasks");
  const last = calls.plugins[calls.plugins.length - 1];
  last?.onFocusRestored();
  rerender(<SettingsView {...props({ section: "plugins" })} />);
  expect(screen.getByTestId("plugins").getAttribute("data-restore")).toBe("none");
});

test("leaving the plugins area forgets which plugin to restore", () => {
  const { rerender } = render(<SettingsView {...props({ section: "plugin-tasks" })} />);
  rerender(<SettingsView {...props({ section: "about" })} />);
  rerender(<SettingsView {...props({ section: "plugins" })} />);
  expect(screen.getByTestId("plugins").getAttribute("data-restore")).toBe("none");
});

test("the tab links are real anchors that navigate through the hash", async () => {
  render(<SettingsView {...props()} />);
  const link = screen.getByRole("link", { name: "Health" }) as HTMLAnchorElement;
  await userEvent.click(link);
  expect(window.location.hash).toBe("#/settings/health");
  window.location.hash = "";
});
