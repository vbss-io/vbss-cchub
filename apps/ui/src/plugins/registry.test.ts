import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HubFeatures } from "../delegation";
import { DEFAULT_PINNED, defaultSidebarPrefs, enabledPlugins, enabledViews, featureOn, isPluginEnabled, isViewEnabled, parseView, PLUGINS, pluginCommandActions, pluginSettingsTabs, sidebarModel } from "./registry";
import { applyUiPrefsPatch, emptyUiPrefs, normalizeUiPrefs } from "./ui-prefs";
import type { PaletteContext } from "./types";

const legacyOn: HubFeatures = { daily: true, trail: true, usage: true, limits: true, tasks: true };

const allOn: Required<HubFeatures> = { ...legacyOn, flow: true, delegated: true, workspaces: true, reports: true, share: true, widget: true };

const keys = (items: { key: string }[]) => items.map((item) => item.key);

describe("plugin catalog", () => {
  it("declares every plugin once, with Sessions as the only core plugin", () => {
    const ids = PLUGINS.map((plugin) => plugin.id);
    assert.deepEqual(ids, ["sessions", "today", "tasks", "flow", "delegated", "usage", "limits", "workspaces", "reports", "share", "trail", "widget"]);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(PLUGINS.filter((plugin) => plugin.core).map((plugin) => plugin.id), ["sessions"]);
    assert.equal(PLUGINS.every((plugin) => plugin.core === (plugin.featureKey === null)), true);
  });

  it("keeps the existing route keys for every view", () => {
    assert.deepEqual(keys(enabledViews(allOn)), ["sessions", "daily", "board", "flow", "tasks", "usage", "workspaces", "reports", "share"]);
  });
});

describe("featureOn", () => {
  it("treats missing plugin flags from an older hub as on and missing legacy flags as off", () => {
    assert.equal(featureOn(legacyOn, "flow"), true);
    assert.equal(featureOn(legacyOn, "widget"), true);
    assert.equal(featureOn({}, "daily"), false);
    assert.equal(featureOn(null, "share"), true);
    assert.equal(featureOn(undefined, "tasks"), false);
  });

  it("uses explicit values", () => {
    assert.equal(featureOn({ ...legacyOn, flow: false }, "flow"), false);
    assert.equal(featureOn({ ...legacyOn, daily: false }, "daily"), false);
  });
});

describe("enabledPlugins", () => {
  it("shows everything an older hub had when the new flags are absent", () => {
    assert.deepEqual(enabledPlugins(legacyOn).map((plugin) => plugin.id), PLUGINS.map((plugin) => plugin.id));
  });

  it("keeps only Sessions when every flag is off", () => {
    const off: Required<HubFeatures> = { daily: false, trail: false, usage: false, limits: false, tasks: false, flow: false, delegated: false, workspaces: false, reports: false, share: false, widget: false };
    assert.deepEqual(enabledPlugins(off).map((plugin) => plugin.id), ["sessions"]);
    assert.deepEqual(keys(enabledViews(off)), ["sessions"]);
  });

  it("keeps Limits on its own flag, independent of Usage", () => {
    const features = { ...allOn, usage: false };
    assert.equal(isPluginEnabled("limits", features), true);
    assert.equal(isPluginEnabled("usage", features), false);
    assert.equal(isPluginEnabled("limits", { ...allOn, limits: false }), false);
    assert.equal(enabledPlugins(features).some((plugin) => plugin.id === "limits"), true);
    assert.equal(PLUGINS.some((plugin) => (plugin.dependsOn ?? []).length > 0), false);
  });
});

describe("isViewEnabled", () => {
  it("routes disabled plugin views away and keeps Settings always reachable", () => {
    const features = { ...allOn, flow: false, tasks: false };
    assert.equal(isViewEnabled("flow", features), false);
    assert.equal(isViewEnabled("board", features), false);
    assert.equal(isViewEnabled("tasks", features), true);
    assert.equal(isViewEnabled("settings", { daily: false, trail: false, usage: false, limits: false, tasks: false }), true);
    assert.equal(isViewEnabled("nope", allOn), false);
  });

  it("parses only known route keys", () => {
    assert.equal(parseView("board"), "board");
    assert.equal(parseView("settings"), "settings");
    assert.equal(parseView("nope"), null);
    assert.equal(parseView(undefined), null);
  });
});

describe("sidebarModel", () => {
  it("defaults to the F1 layout", () => {
    const model = sidebarModel(legacyOn, null);
    assert.deepEqual(keys(model.pinned), ["sessions", "daily", "board", "flow"]);
    assert.deepEqual(keys(model.more), ["tasks", "usage", "workspaces", "reports", "share"]);
    assert.deepEqual(defaultSidebarPrefs().pinned, [...DEFAULT_PINNED]);
  });

  it("drops disabled plugins from the default layout", () => {
    const model = sidebarModel({ ...allOn, daily: false, flow: false, share: false }, null);
    assert.deepEqual(keys(model.pinned), ["sessions", "board"]);
    assert.deepEqual(keys(model.more), ["tasks", "usage", "workspaces", "reports"]);
  });

  it("follows the saved order and pinned set", () => {
    const model = sidebarModel(allOn, { order: ["board", "sessions", "share", "tasks", "flow", "daily", "usage", "workspaces", "reports"], pinned: ["sessions", "share", "board"] });
    assert.deepEqual(keys(model.pinned), ["board", "sessions", "share"]);
    assert.deepEqual(keys(model.more), ["tasks", "flow", "daily", "usage", "workspaces", "reports"]);
  });

  it("ignores unknown and disabled keys and appends new views to More", () => {
    const model = sidebarModel({ ...allOn, flow: false }, { order: ["ghost", "flow", "share", "sessions", "share"], pinned: ["share", "flow", "ghost"] });
    assert.deepEqual(keys(model.pinned), ["share"]);
    assert.deepEqual(keys(model.more), ["sessions", "daily", "board", "tasks", "usage", "workspaces", "reports"]);
  });

  it("falls back to pinning Sessions when nothing resolved is pinned", () => {
    const onlyTasks = sidebarModel({ ...allOn, tasks: false }, { order: ["board", "sessions", "tasks", "flow"], pinned: ["board"] });
    assert.deepEqual(keys(onlyTasks.pinned), ["sessions"]);
    assert.equal(keys(onlyTasks.more).includes("sessions"), false);
    assert.equal(keys(onlyTasks.more).includes("board"), false);
    assert.equal(keys(onlyTasks.more).includes("flow"), true);
    const empty = sidebarModel(allOn, { order: ["flow", "daily"], pinned: [] });
    assert.deepEqual(keys(empty.pinned), ["sessions"]);
    assert.deepEqual(keys(empty.more), ["flow", "daily", "board", "tasks", "usage", "workspaces", "reports", "share"]);
    const unplaced = sidebarModel(allOn, { order: ["daily"], pinned: ["ghost"] });
    assert.deepEqual(keys(unplaced.pinned), ["sessions"]);
    assert.equal(keys(unplaced.more)[0], "daily");
  });

  it("places pinned keys missing from the order after the ordered ones", () => {
    const model = sidebarModel(allOn, { order: ["flow"], pinned: ["reports", "flow"] });
    assert.deepEqual(keys(model.pinned), ["flow", "reports"]);
    assert.equal(model.more[0]?.key, "sessions");
  });
});

describe("pluginSettingsTabs", () => {
  it("lists one tab per enabled plugin with settings and merges Usage and Limits", () => {
    assert.deepEqual(pluginSettingsTabs(allOn), [
      { key: "today", label: "Today", pluginIds: ["today"] },
      { key: "tasks", label: "Tasks", pluginIds: ["tasks"] },
      { key: "usage", label: "Usage", pluginIds: ["usage", "limits"] },
      { key: "sharing", label: "Sharing", pluginIds: ["share"] },
      { key: "trail", label: "Session trail", pluginIds: ["trail"] },
      { key: "widget", label: "Widget", pluginIds: ["widget"] },
    ]);
  });

  it("keeps the Usage tab reachable when only Limits is on, and drops it when both are off", () => {
    assert.deepEqual(pluginSettingsTabs({ ...allOn, usage: false }).find((tab) => tab.key === "usage"), { key: "usage", label: "Usage", pluginIds: ["limits"] });
    assert.deepEqual(pluginSettingsTabs({ ...allOn, limits: false }).find((tab) => tab.key === "usage"), { key: "usage", label: "Usage", pluginIds: ["usage"] });
    assert.equal(pluginSettingsTabs({ ...allOn, usage: false, limits: false }).some((tab) => tab.key === "usage"), false);
  });

  it("hides the tabs of disabled plugins", () => {
    const tabs = pluginSettingsTabs({ ...allOn, usage: false, limits: false, share: false, daily: false });
    assert.deepEqual(keys(tabs), ["tasks", "trail", "widget"]);
  });
});

describe("pluginCommandActions", () => {
  const context = (calls: string[], widget: boolean): PaletteContext => ({
    dispatch: (view, event) => calls.push(`${view}:${event}`),
    startCapture: () => calls.push("capture"),
    toggleWidget: widget ? () => calls.push("widget") : null,
  });

  it("collects commands from enabled plugins", () => {
    const calls: string[] = [];
    const actions = pluginCommandActions(allOn, context(calls, true));
    assert.deepEqual(Object.keys(actions).sort(), ["newTask", "planToday", "refreshDaily", "startCapture", "startDay", "toggleWidget"]);
    actions.newTask?.();
    actions.startDay?.();
    actions.planToday?.();
    actions.refreshDaily?.();
    actions.startCapture?.();
    actions.toggleWidget?.();
    assert.deepEqual(calls, ["board:cchub:board-new-task", "daily:cchub:daily-start-day", "daily:cchub:daily-plan-today", "daily:cchub:daily-refresh", "capture", "widget"]);
  });

  it("drops commands of disabled plugins and the widget toggle when unavailable", () => {
    assert.deepEqual(Object.keys(pluginCommandActions({ ...allOn, daily: false, tasks: false }, context([], false))), []);
    assert.equal(Object.keys(pluginCommandActions({ ...allOn, widget: false }, context([], true))).includes("toggleWidget"), false);
  });
});

describe("ui prefs", () => {
  it("normalizes server payloads and drops junk", () => {
    assert.deepEqual(normalizeUiPrefs(null), emptyUiPrefs());
    assert.deepEqual(normalizeUiPrefs({ sidebar: { order: ["a"], pinned: "x" }, layout: { today: { focus: 400, bad: "1" }, junk: 3 } }), { sidebar: null, layout: { today: { focus: 400 } } });
    assert.deepEqual(normalizeUiPrefs({ sidebar: { order: ["sessions"], pinned: ["sessions"] }, layout: {} }), { sidebar: { order: ["sessions"], pinned: ["sessions"] }, layout: {} });
  });

  it("applies a patch like the server: sidebar replaced, layout merged per screen", () => {
    const prefs = { sidebar: { order: ["a"], pinned: [] }, layout: { today: { focus: 400, backlog: 300 } } };
    assert.deepEqual(applyUiPrefsPatch(prefs, { layout: { today: { focus: 500 }, note: { side: 280 } } }), {
      sidebar: { order: ["a"], pinned: [] },
      layout: { today: { focus: 500, backlog: 300 }, note: { side: 280 } },
    });
    assert.equal(applyUiPrefsPatch(prefs, { sidebar: null }).sidebar, null);
  });
});
