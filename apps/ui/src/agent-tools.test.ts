import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentToolsFor, type HubPluginInfo } from "./agent-tools";

const hubPlugins: HubPluginInfo[] = [
  { id: "core", name: "Core", enabled: true, tools: ["hub_overview", "hub_workspaces"] },
  { id: "today", name: "Today", enabled: true, tools: ["hub_brain_today"] },
  { id: "usage", name: "Usage", enabled: true, tools: [] },
  { id: "limits", name: "Limits", enabled: false, tools: [] },
  { id: "share", name: "Share", enabled: false, tools: ["hub_shares", "hub_share_create", "hub_tunnel"] },
];

describe("agentToolsFor", () => {
  it("lists the MCP tools of the plugins on a settings page, in hub order, on or off", () => {
    assert.deepEqual(agentToolsFor(["share"], hubPlugins), ["hub_shares", "hub_share_create", "hub_tunnel"]);
    assert.deepEqual(agentToolsFor(["today"], hubPlugins), ["hub_brain_today"]);
  });

  it("returns an empty list when the hub knows the plugins but they add no tools", () => {
    assert.deepEqual(agentToolsFor(["usage", "limits"], hubPlugins), []);
  });

  it("merges the tools of every plugin sharing a page without repeating names", () => {
    assert.deepEqual(agentToolsFor(["today", "share", "today"], hubPlugins), ["hub_brain_today", "hub_shares", "hub_share_create", "hub_tunnel"]);
  });

  it("returns null to hide the line when the hub has no list or does not know the page plugins", () => {
    assert.equal(agentToolsFor(["share"], null), null);
    assert.equal(agentToolsFor(["sessions", "widget"], hubPlugins), null);
    assert.equal(agentToolsFor([], hubPlugins), null);
  });
});
