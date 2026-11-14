import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HubFeatures } from "./delegation";
import { defaultSidebarPrefs, isPluginEnabled, pluginById, pluginSettingsTabs, sidebarModel } from "./plugins/registry";
import type { PluginId } from "./plugins/types";
import {
  buildSettingsTabs,
  canMoveRow,
  canSetPinned,
  commitSidebar,
  dropRow,
  moveRow,
  pluginHints,
  resolveSettingsTab,
  sameRows,
  setRowPinned,
  sidebarRows,
  type SidebarRow,
} from "./settings-model";

const allOn: Required<HubFeatures> = { daily: true, trail: true, usage: true, limits: true, tasks: true, flow: true, delegated: true, workspaces: true, reports: true, share: true, widget: true };
const coreOnly: Required<HubFeatures> = { daily: false, trail: false, usage: false, limits: false, tasks: false, flow: false, delegated: false, workspaces: false, reports: false, share: false, widget: false };

const keys = (items: { key: string }[]) => items.map((item) => item.key);

const rowsOf = (spec: string): SidebarRow[] =>
  spec.split(" ").map((token) => ({ key: token.replace("*", "") as SidebarRow["key"], label: token, pinned: token.endsWith("*") }));

const spec = (rows: SidebarRow[]): string => rows.map((row) => `${row.key}${row.pinned ? "*" : ""}`).join(" ");

describe("buildSettingsTabs", () => {
  it("puts plugin tabs between Plugins and Connections", () => {
    assert.deepEqual(keys(buildSettingsTabs(pluginSettingsTabs(allOn))), ["general", "appearance", "plugins", "today", "tasks", "usage", "sharing", "trail", "widget", "connections", "notifications", "groups", "about"]);
  });

  it("shows only the core tabs when no plugin has settings", () => {
    assert.deepEqual(keys(buildSettingsTabs(pluginSettingsTabs(coreOnly))), ["general", "appearance", "plugins", "connections", "notifications", "groups", "about"]);
  });

  it("merges usage and limits into one Usage tab", () => {
    const tabs = buildSettingsTabs(pluginSettingsTabs({ ...coreOnly, usage: true, limits: true }));
    assert.equal(tabs.filter((tab) => tab.key === "usage").length, 1);
  });
});

describe("resolveSettingsTab", () => {
  const tabs = buildSettingsTabs(pluginSettingsTabs({ ...coreOnly, daily: true, share: true, widget: true }));

  it("defaults to General", () => {
    assert.equal(resolveSettingsTab(null, tabs), "general");
    assert.equal(resolveSettingsTab(undefined, tabs), "general");
    assert.equal(resolveSettingsTab("", tabs), "general");
  });

  it("maps every old section key to its new tab", () => {
    const expected: Record<string, string> = {
      support: "about",
      general: "general",
      appearance: "appearance",
      paths: "general",
      hooks: "connections",
      connect: "connections",
      sharing: "sharing",
      features: "plugins",
      widget: "widget",
      notifications: "notifications",
      groups: "groups",
      about: "about",
    };
    for (const [old, tab] of Object.entries(expected)) assert.equal(resolveSettingsTab(old, tabs), tab, old);
  });

  it("lands a disabled plugin tab on Plugins and an unknown key on General", () => {
    assert.equal(resolveSettingsTab("tasks", tabs), "plugins");
    assert.equal(resolveSettingsTab("trail", tabs), "plugins");
    assert.equal(resolveSettingsTab("nonsense", tabs), "general");
    assert.equal(resolveSettingsTab("constructor", tabs), "general");
  });

  it("keeps new tab keys", () => {
    assert.equal(resolveSettingsTab("today", tabs), "today");
    assert.equal(resolveSettingsTab("connections", tabs), "connections");
    assert.equal(resolveSettingsTab("plugins", tabs), "plugins");
  });
});

describe("pluginHints", () => {
  const enabledIn = (features: Required<HubFeatures>) => (id: PluginId) => isPluginEnabled(id, features);
  const plugin = (id: PluginId) => {
    const found = pluginById(id);
    if (!found) throw new Error(`missing plugin ${id}`);
    return found;
  };

  it("hints at the Usage dependency of Limits", () => {
    assert.deepEqual(pluginHints(plugin("limits"), enabledIn({ ...allOn, usage: false }), true), ["Needs Usage"]);
    assert.deepEqual(pluginHints(plugin("limits"), enabledIn(allOn), true), []);
  });

  it("hints at the vault folder for vault plugins", () => {
    assert.deepEqual(pluginHints(plugin("today"), enabledIn(allOn), false), ["Needs a vault folder"]);
    assert.deepEqual(pluginHints(plugin("tasks"), enabledIn(allOn), false), ["Needs a vault folder"]);
    assert.deepEqual(pluginHints(plugin("today"), enabledIn(allOn), true), []);
    assert.deepEqual(pluginHints(plugin("flow"), enabledIn(allOn), false), []);
  });
});

describe("sidebar rows", () => {
  it("lists pinned items first, then the ones in More", () => {
    const rows = sidebarRows(sidebarModel(allOn, null));
    const pinned = rows.filter((row) => row.pinned).length;
    assert.equal(pinned, defaultSidebarPrefs().pinned.length);
    assert.equal(rows.slice(0, pinned).every((row) => row.pinned), true);
    assert.equal(rows.slice(pinned).every((row) => !row.pinned), true);
    assert.equal(rows.length, 9);
  });

  it("only lists the views of enabled plugins", () => {
    assert.deepEqual(keys(sidebarRows(sidebarModel(coreOnly, null))), ["sessions"]);
  });
});

describe("moveRow", () => {
  it("swaps with the neighbour inside the same group", () => {
    assert.equal(spec(moveRow(rowsOf("sessions* daily* flow* tasks"), "daily", 1)), "sessions* flow* daily* tasks");
    assert.equal(spec(moveRow(rowsOf("sessions* daily* flow* tasks usage"), "usage", -1)), "sessions* daily* flow* usage tasks");
  });

  it("does not cross the pinned boundary", () => {
    const rows = rowsOf("sessions* daily* tasks usage");
    assert.equal(canMoveRow(rows, "daily", 1), false);
    assert.equal(canMoveRow(rows, "tasks", -1), false);
    assert.equal(spec(moveRow(rows, "daily", 1)), "sessions* daily* tasks usage");
    assert.equal(canMoveRow(rows, "sessions", -1), false);
    assert.equal(canMoveRow(rows, "usage", 1), false);
  });

  it("ignores unknown keys", () => {
    assert.equal(spec(moveRow(rowsOf("sessions* tasks"), "reports", 1)), "sessions* tasks");
  });
});

describe("setRowPinned", () => {
  it("moves a pinned item to the top of More", () => {
    assert.equal(spec(setRowPinned(rowsOf("sessions* daily* flow* tasks usage"), "daily", false)), "sessions* flow* daily tasks usage");
  });

  it("moves an item from More to the end of the pinned group", () => {
    assert.equal(spec(setRowPinned(rowsOf("sessions* daily* tasks usage"), "usage", true)), "sessions* daily* usage* tasks");
  });

  it("keeps at least one item pinned", () => {
    const rows = rowsOf("sessions* tasks");
    assert.equal(canSetPinned(rows, "sessions", false), false);
    assert.equal(spec(setRowPinned(rows, "sessions", false)), "sessions* tasks");
    assert.equal(canSetPinned(rowsOf("sessions* daily* tasks"), "daily", false), true);
  });

  it("is a no-op when the state already matches", () => {
    assert.equal(canSetPinned(rowsOf("sessions* tasks"), "tasks", false), false);
  });
});

describe("dropRow", () => {
  it("moves down after the target and up before it", () => {
    const rows = rowsOf("sessions* daily* flow* tasks");
    assert.equal(spec(dropRow(rows, "sessions", "flow")), "daily* flow* sessions* tasks");
    assert.equal(spec(dropRow(rows, "flow", "sessions")), "flow* sessions* daily* tasks");
  });

  it("adopts the pinned state of the target group", () => {
    const rows = rowsOf("sessions* daily* tasks usage");
    assert.equal(spec(dropRow(rows, "usage", "sessions")), "usage* sessions* daily* tasks");
    assert.equal(spec(dropRow(rows, "daily", "usage")), "sessions* tasks usage daily");
  });

  it("refuses to drop the last pinned item into More", () => {
    const rows = rowsOf("sessions* tasks usage");
    assert.equal(spec(dropRow(rows, "sessions", "usage")), "sessions* tasks usage");
  });

  it("ignores a drop on itself", () => {
    assert.equal(spec(dropRow(rowsOf("sessions* daily*"), "daily", "daily")), "sessions* daily*");
  });
});

describe("commitSidebar", () => {
  it("writes the visible order and pinned keys", () => {
    const rows = rowsOf("sessions* flow* daily tasks");
    const prefs = commitSidebar(rows, { order: ["sessions", "daily", "tasks", "flow"], pinned: ["sessions", "daily"] });
    assert.deepEqual(prefs, { order: ["sessions", "flow", "daily", "tasks"], pinned: ["sessions", "flow"] });
  });

  it("keeps the place of views whose plugin is off", () => {
    const rows = rowsOf("sessions* tasks");
    const prefs = commitSidebar(rows, { order: ["sessions", "reports", "tasks"], pinned: ["sessions", "reports"] });
    assert.deepEqual(prefs, { order: ["sessions", "tasks", "reports"], pinned: ["sessions", "reports"] });
  });

  it("round trips through the sidebar model", () => {
    const rows = setRowPinned(moveRow(sidebarRows(sidebarModel(allOn, null)), "flow", -1), "usage", true);
    const prefs = commitSidebar(rows, defaultSidebarPrefs());
    assert.equal(sameRows(sidebarRows(sidebarModel(allOn, prefs)), rows), true);
  });

  it("reports differing rows", () => {
    assert.equal(sameRows(rowsOf("a* b"), rowsOf("a* b")), true);
    assert.equal(sameRows(rowsOf("a* b"), rowsOf("a b*")), false);
    assert.equal(sameRows(rowsOf("a*"), rowsOf("a* b")), false);
  });
});
