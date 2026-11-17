import { expect, test } from "vitest";
import { coreSettingsTabs, settingsTabs } from "./settings-sections";

const labels = (tabs: { label: string }[]): string[] => tabs.map((tab) => tab.label);

test("the core tabs are the fixed settings pages without any plugin page", () => {
  expect(labels(coreSettingsTabs())).toEqual(["General", "Appearance", "Plugins", "Memory", "Connections", "Health", "Notifications", "Groups", "About"]);
});

test("with every feature on, each plugin with settings adds its page between Plugins and Memory", () => {
  const tabs = settingsTabs({ daily: true, trail: true, usage: true, limits: true, tasks: true, flow: true, delegated: true, workspaces: true, reports: true, share: true, widget: true });
  expect(labels(tabs)).toEqual(["General", "Appearance", "Plugins", "Sessions", "Today", "Tasks", "Usage", "Sharing", "Session trail", "Widget", "Memory", "Connections", "Health", "Notifications", "Groups", "About"]);
  expect(tabs.filter((tab) => tab.key.startsWith("plugin-")).map((tab) => tab.key)).toEqual(["plugin-sessions", "plugin-today", "plugin-tasks", "plugin-usage", "plugin-share", "plugin-trail", "plugin-widget"]);
});

test("a plugin that is off does not get a settings page, and usage and limits share one", () => {
  const off = settingsTabs({ daily: false, trail: false, usage: false, limits: true, tasks: false, share: false, widget: false });
  expect(labels(off)).toEqual(["General", "Appearance", "Plugins", "Sessions", "Usage", "Memory", "Connections", "Health", "Notifications", "Groups", "About"]);
  const usageOnly = settingsTabs({ daily: false, trail: false, usage: true, limits: false, tasks: false, share: false, widget: false });
  expect(labels(usageOnly)).toContain("Usage");
});

test("without feature flags only the defaults that are on by default add a page", () => {
  expect(labels(settingsTabs(null))).toEqual(["General", "Appearance", "Plugins", "Sessions", "Sharing", "Widget", "Memory", "Connections", "Health", "Notifications", "Groups", "About"]);
});
