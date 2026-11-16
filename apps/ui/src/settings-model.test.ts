import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HubFeatures } from "./delegation";
import { defaultSidebarPrefs, isPluginEnabled, pluginById, sidebarModel } from "./plugins/registry";
import type { PluginId } from "./plugins/types";
import {
  buildSettingsTabs,
  canMoveRow,
  canSetPinned,
  commitSidebar,
  coreSettingsTabs,
  dropRow,
  isPluginPageSection,
  moveRow,
  pluginHints,
  pluginSettingsPages,
  resolveSettingsLocation,
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
  it("lists the core tabs and the plugin pages between Plugins and Connections for the palette", () => {
    assert.deepEqual(keys(buildSettingsTabs(pluginSettingsPages(allOn))), [
      "general",
      "appearance",
      "plugins",
      "plugin-sessions",
      "plugin-today",
      "plugin-tasks",
      "plugin-usage",
      "plugin-share",
      "plugin-trail",
      "plugin-widget",
      "memory",
      "connections",
      "health",
      "notifications",
      "groups",
      "about",
    ]);
  });

  it("has only the core tabs and the core Sessions page at the top level", () => {
    assert.deepEqual(keys(coreSettingsTabs()), ["general", "appearance", "plugins", "memory", "connections", "health", "notifications", "groups", "about"]);
    assert.deepEqual(keys(buildSettingsTabs(pluginSettingsPages(coreOnly))), ["general", "appearance", "plugins", "plugin-sessions", "memory", "connections", "health", "notifications", "groups", "about"]);
  });

  it("merges usage and limits into one Usage page", () => {
    const pages = pluginSettingsPages({ ...coreOnly, usage: true, limits: true });
    assert.deepEqual(pages.map((page) => [page.key, page.label, page.pluginIds]), [["plugin-sessions", "Sessions", ["sessions"]], ["plugin-usage", "Usage", ["usage", "limits"]]]);
  });

  it("keys the Usage page by Limits when only Limits is on", () => {
    assert.deepEqual(keys(pluginSettingsPages({ ...coreOnly, limits: true })), ["plugin-sessions", "plugin-limits"]);
  });
});

describe("resolveSettingsLocation", () => {
  const features = { ...coreOnly, daily: true, share: true, widget: true, usage: true, limits: true };
  const at = (section: string | null | undefined, flags = features) => {
    const location = resolveSettingsLocation(section, flags);
    return [location.tab, location.page?.key ?? null, location.pluginId];
  };

  it("defaults to General", () => {
    assert.deepEqual(at(null), ["general", null, null]);
    assert.deepEqual(at(undefined), ["general", null, null]);
    assert.deepEqual(at(""), ["general", null, null]);
  });

  it("maps old core section keys to their tab", () => {
    const expected: Record<string, string> = {
      support: "about",
      general: "general",
      appearance: "appearance",
      paths: "general",
      hooks: "connections",
      connect: "connections",
      features: "plugins",
      plugins: "plugins",
      notifications: "notifications",
      groups: "groups",
      about: "about",
      connections: "connections",
    };
    for (const [old, tab] of Object.entries(expected)) assert.deepEqual(at(old), [tab, null, null], old);
  });

  it("lands every old plugin deep link on its plugin page", () => {
    assert.deepEqual(at("today"), ["plugins", "plugin-today", "today"]);
    assert.deepEqual(at("daily"), ["plugins", "plugin-today", "today"]);
    assert.deepEqual(at("sharing"), ["plugins", "plugin-share", "share"]);
    assert.deepEqual(at("share"), ["plugins", "plugin-share", "share"]);
    assert.deepEqual(at("widget"), ["plugins", "plugin-widget", "widget"]);
    assert.deepEqual(at("usage"), ["plugins", "plugin-usage", "usage"]);
    assert.deepEqual(at("limits"), ["plugins", "plugin-usage", "limits"]);
    assert.deepEqual(at("tasks", { ...features, tasks: true }), ["plugins", "plugin-tasks", "tasks"]);
    assert.deepEqual(at("trail", { ...features, trail: true }), ["plugins", "plugin-trail", "trail"]);
  });

  it("opens a plugin page by its single-segment key", () => {
    assert.deepEqual(at("plugin-today"), ["plugins", "plugin-today", "today"]);
    assert.deepEqual(at("plugin-limits"), ["plugins", "plugin-usage", "limits"]);
    assert.deepEqual(at("plugin-share"), ["plugins", "plugin-share", "share"]);
  });

  it("lands a disabled plugin, or a plugin without settings, on the Plugins list", () => {
    assert.deepEqual(at("tasks"), ["plugins", null, null]);
    assert.deepEqual(at("plugin-trail"), ["plugins", null, null]);
    assert.deepEqual(at("plugin-flow"), ["plugins", null, null]);
    assert.deepEqual(at("plugin-nonsense"), ["plugins", null, null]);
    assert.deepEqual(at("today", coreOnly), ["plugins", null, null]);
  });

  it("serves the Usage page for Limits alone and not for the disabled Usage plugin", () => {
    const limitsOnly = { ...coreOnly, limits: true };
    assert.deepEqual(at("plugin-limits", limitsOnly), ["plugins", "plugin-limits", "limits"]);
    assert.deepEqual(at("plugin-usage", limitsOnly), ["plugins", null, null]);
  });

  it("lands an unknown key on General", () => {
    assert.deepEqual(at("nonsense"), ["general", null, null]);
    assert.deepEqual(at("constructor"), ["general", null, null]);
    assert.deepEqual(at("__proto__"), ["general", null, null]);
  });
});

describe("isPluginPageSection", () => {
  it("recognises plugin keys and old plugin links only", () => {
    assert.equal(isPluginPageSection("plugin-tasks"), true);
    assert.equal(isPluginPageSection("sharing"), true);
    assert.equal(isPluginPageSection("plugin-flow"), false);
    assert.equal(isPluginPageSection("plugins"), false);
    assert.equal(isPluginPageSection(null), false);
  });
});

describe("pluginHints", () => {
  const enabledIn = (features: Required<HubFeatures>) => (id: PluginId) => isPluginEnabled(id, features);
  const plugin = (id: PluginId) => {
    const found = pluginById(id);
    if (!found) throw new Error(`missing plugin ${id}`);
    return found;
  };

  it("gives Limits no dependency hint when Usage is off", () => {
    assert.deepEqual(pluginHints(plugin("limits"), enabledIn({ ...allOn, usage: false }), true), []);
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
    assert.equal(rows.length, 8);
    assert.equal(rows.some((row) => row.key === "tasks"), false);
  });

  it("never lists Delegated, even when a saved layout still pins it", () => {
    const rows = sidebarRows(sidebarModel(allOn, { order: ["tasks", "sessions", "daily"], pinned: ["tasks", "daily"] }));
    assert.deepEqual(keys(rows.filter((row) => row.pinned)), ["daily"]);
    assert.equal(rows.some((row) => row.key === "tasks"), false);
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
