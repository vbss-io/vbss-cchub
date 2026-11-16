import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { DelegationFeatures } from "../src/delegation-types.js";
import type { ServerPlugin } from "../src/plugins/types.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-plugin-registry-"));
process.env.HUB_DATA_DIR = dataDir;

type Registry = typeof import("../src/plugins/registry.js");
let registry: Registry;
let plugins: readonly ServerPlugin[];
let closeDb: () => void;

const ALL_TOOLS = [
  "hub_overview",
  "hub_workspaces",
  "hub_delegate",
  "hub_task",
  "hub_tasks",
  "hub_continue",
  "hub_cancel",
  "hub_task_archive",
  "hub_task_merge",
  "hub_report",
  "hub_reports",
  "hub_sessions",
  "hub_focus",
  "hub_open_workspace",
  "hub_create_workspace",
  "hub_session_live",
  "hub_task_events",
  "hub_delete_workspace",
  "hub_brain_today",
  "hub_shares",
  "hub_share_create",
  "hub_share_update",
  "hub_share_activity",
  "hub_claim",
  "hub_tunnel",
];

const allOn: DelegationFeatures = {
  daily: true,
  trail: true,
  usage: true,
  limits: true,
  tasks: true,
  flow: true,
  delegated: true,
  workspaces: true,
  reports: true,
  share: true,
  widget: true,
};

before(async () => {
  registry = await import("../src/plugins/registry.js");
  ({ SERVER_PLUGINS: plugins } = await import("../src/plugins/index.js"));
  const { db } = await import("../src/db.js");
  closeDb = () => db.close();
});

after(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("server plugin registry", () => {
  it("maps each of the 25 MCP tools to exactly one plugin", () => {
    const mapped = plugins.flatMap((plugin) => [...plugin.tools]);
    assert.equal(ALL_TOOLS.length, 25);
    assert.equal(mapped.length, 25);
    assert.deepEqual([...mapped].sort(), [...ALL_TOOLS].sort());
    for (const tool of ALL_TOOLS) assert.equal(mapped.filter((name) => name === tool).length, 1, tool);
  });

  it("keeps the LEAD tool map per plugin", () => {
    const toolsOf = (id: string): string[] => [...(plugins.find((plugin) => plugin.id === id)?.tools ?? [])];
    assert.deepEqual(toolsOf("core"), ["hub_overview", "hub_workspaces", "hub_sessions", "hub_session_live", "hub_focus", "hub_claim"]);
    assert.deepEqual(toolsOf("delegated"), ["hub_delegate", "hub_task", "hub_tasks", "hub_continue", "hub_cancel", "hub_task_archive", "hub_task_merge", "hub_task_events"]);
    assert.deepEqual(toolsOf("reports"), ["hub_report", "hub_reports"]);
    assert.deepEqual(toolsOf("share"), ["hub_shares", "hub_share_create", "hub_share_update", "hub_share_activity", "hub_tunnel"]);
    assert.deepEqual(toolsOf("workspaces"), ["hub_open_workspace", "hub_create_workspace", "hub_delete_workspace"]);
    assert.deepEqual(toolsOf("today"), ["hub_brain_today"]);
    const counts = Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.tools.length]));
    assert.deepEqual(counts, { core: 6, today: 1, tasks: 0, delegated: 8, usage: 0, limits: 0, workspaces: 3, reports: 2, share: 5, trail: 0 });
  });

  it("mirrors the UI plugin ids, names and feature keys", () => {
    assert.deepEqual(
      plugins.map((plugin) => [plugin.id, plugin.name, plugin.featureKey]),
      [
        ["core", "Core", null],
        ["today", "Today", "daily"],
        ["tasks", "Tasks", "tasks"],
        ["delegated", "Delegated", "delegated"],
        ["usage", "Usage", "usage"],
        ["limits", "Limits", "limits"],
        ["workspaces", "Workspaces", "workspaces"],
        ["reports", "Reports", "reports"],
        ["share", "Share", "share"],
        ["trail", "Session trail", "trail"],
      ],
    );
  });

  it("orders the plugin routes with unique slots and keeps the guard ahead of every /delegation router", () => {
    const routes = registry.orderedRoutes(plugins);
    const orders = routes.map((route) => route.order);
    assert.equal(new Set(orders).size, orders.length);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
    assert.deepEqual(
      routes.map((route) => route.mount),
      [
        "/delegation/ui-prefs",
        ...Array.from({ length: 17 }, () => "/delegation"),
        "/delegation/usage",
        "/delegation/limits",
        "/delegation/backups",
        "/delegation/memory",
        "/delegation/today",
      ],
    );
    assert.equal(routes[1]?.order, 20);
    assert.equal(plugins.find((plugin) => plugin.id === "core")?.routes.find((route) => route.order === 20)?.mount, "/delegation");
  });

  it("derives enabled plugins and allowed tools from settings.features", () => {
    assert.equal(registry.allowedTools(plugins, allOn).length, 25);
    const noneOn = Object.fromEntries(Object.keys(allOn).map((key) => [key, false])) as unknown as DelegationFeatures;
    assert.deepEqual(registry.enabledPlugins(plugins, noneOn).map((plugin) => plugin.id), ["core"]);
    assert.deepEqual(registry.allowedTools(plugins, noneOn), ["hub_overview", "hub_workspaces", "hub_sessions", "hub_session_live", "hub_focus", "hub_claim"]);
    const lean = registry.allowedTools(plugins, { ...allOn, share: false, workspaces: false });
    assert.equal(lean.length, 17);
    for (const tool of ["hub_shares", "hub_share_create", "hub_share_update", "hub_share_activity", "hub_tunnel", "hub_open_workspace", "hub_create_workspace", "hub_delete_workspace"]) {
      assert.equal(lean.includes(tool), false, tool);
    }
    assert.equal(registry.allowedTools(plugins, { ...allOn, daily: false }).includes("hub_brain_today"), false);
  });

  it("finds the owner of a tool and builds the public view", () => {
    assert.equal(registry.pluginOfTool(plugins, "hub_share_create")?.id, "share");
    assert.equal(registry.pluginOfTool(plugins, "hub_claim")?.id, "core");
    assert.equal(registry.pluginOfTool(plugins, "hub_nope"), undefined);
    const views = registry.pluginViews(plugins, { ...allOn, share: false });
    assert.deepEqual(views.find((view) => view.id === "share"), {
      id: "share",
      name: "Share",
      enabled: false,
      tools: ["hub_shares", "hub_share_create", "hub_share_update", "hub_share_activity", "hub_tunnel"],
    });
    assert.equal(views.find((view) => view.id === "core")?.enabled, true);
    assert.deepEqual(Object.keys(views[0] ?? {}), ["id", "name", "enabled", "tools"]);
  });
});
