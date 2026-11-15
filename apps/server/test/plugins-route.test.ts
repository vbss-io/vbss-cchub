import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { makeSandbox, startServer, type RunningServer } from "./helpers.js";

interface PluginView {
  id: string;
  name: string;
  enabled: boolean;
  tools: string[];
}

const box = makeSandbox("cch-plugins-route-");
let hub: RunningServer;

const plugins = async (): Promise<PluginView[]> => {
  const res = await fetch(`${hub.base}/delegation/plugins`);
  assert.equal(res.status, 200);
  return (await res.json()) as PluginView[];
};

const putFeatures = async (features: Record<string, boolean>): Promise<void> => {
  const res = await fetch(`${hub.base}/delegation/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ features }),
  });
  assert.equal(res.status, 200);
};

before(async () => {
  hub = await startServer(box, { HUB_DELEGATION: "1" });
});

after(async () => {
  hub.child.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("GET /delegation/plugins", () => {
  it("lists every server plugin with its name, state and MCP tools", async () => {
    const list = await plugins();
    assert.deepEqual(list.map((plugin) => plugin.id), ["core", "today", "tasks", "delegated", "usage", "limits", "workspaces", "reports", "share", "trail"]);
    for (const plugin of list) assert.deepEqual(Object.keys(plugin), ["id", "name", "enabled", "tools"]);
    assert.equal(list.flatMap((plugin) => plugin.tools).length, 25);
    assert.deepEqual(list.find((plugin) => plugin.id === "share")?.tools, ["hub_shares", "hub_share_create", "hub_share_update", "hub_share_activity", "hub_tunnel"]);
    assert.deepEqual(list.filter((plugin) => plugin.enabled).map((plugin) => plugin.id), ["core"]);
  });

  it("follows settings.features as plugins are switched on and off", async () => {
    await putFeatures({ daily: true, delegated: true, workspaces: true, reports: true, share: true });
    const on = await plugins();
    assert.deepEqual(on.filter((plugin) => plugin.enabled).map((plugin) => plugin.id), ["core", "today", "delegated", "workspaces", "reports", "share"]);
    await putFeatures({ share: false, workspaces: false });
    const off = await plugins();
    assert.equal(off.find((plugin) => plugin.id === "share")?.enabled, false);
    assert.equal(off.find((plugin) => plugin.id === "workspaces")?.enabled, false);
    assert.equal(off.filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.tools).length, 17);
  });

  it("sits behind the same guard as the other /delegation routes", async () => {
    const res = await fetch(`${hub.base}/delegation/plugins`, { headers: { origin: "http://evil.example" } });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "origin not allowed" });
  });

  it("keeps the routes of a plugin answering while it is off", async () => {
    await putFeatures({ share: false, workspaces: false, reports: false, delegated: false });
    for (const path of ["/delegation/shares", "/delegation/workspaces", "/delegation/reports", "/delegation/tasks"]) {
      const res = await fetch(`${hub.base}${path}`);
      assert.equal(res.status, 200, path);
    }
  });
});

describe("GET /delegation/plugins without delegation", () => {
  const offBox = makeSandbox("cch-plugins-route-off-");
  let offHub: RunningServer;

  before(async () => {
    offHub = await startServer(offBox, {});
  });

  after(async () => {
    offHub.child.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(offBox.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("answers 404 like every other /delegation route", async () => {
    const res = await fetch(`${offHub.base}/delegation/plugins`);
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { error: string }).error, /delegation disabled/);
  });
});
