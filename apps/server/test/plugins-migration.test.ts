import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";
import { makeSandbox, startServer, type RunningServer, type Sandbox } from "./helpers.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-plugins-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.HUB_WORKSPACES_ROOT;
delete process.env.HUB_EDITOR;
delete process.env.HUB_SECOND_BRAIN;

type Store = typeof import("../src/delegation-store.js");
let store: Store;
let db: Database.Database;

const PLUGIN_FLAGS = ["flow", "delegated", "workspaces", "reports", "share", "widget"] as const;
const LEGACY_FLAGS = ["daily", "trail", "usage", "limits", "tasks"] as const;

before(async () => {
  store = await import("../src/delegation-store.js");
  ({ db } = await import("../src/db.js"));
});

beforeEach(() => {
  db.exec(`DELETE FROM hub_settings; DELETE FROM sessions;`);
});

function insertSession(target: Database.Database, id: string): void {
  target.prepare(`INSERT INTO sessions (session_id, status, started_at, updated_at) VALUES (?, 'idle', 1, 1)`).run(id);
}

const pluginFlags = (): boolean[] => PLUGIN_FLAGS.map((key) => store.getSettings().features[key]);

describe("plugin flags migration", () => {
  it("turns the six plugin flags on when the hub already had sessions", () => {
    insertSession(db, "s-1");
    assert.equal(store.migratePluginFlags(), true);
    assert.deepEqual(pluginFlags(), [true, true, true, true, true, true]);
    assert.equal(store.getSetting("plugins.migrated"), "1");
  });

  it("turns the six plugin flags on when hub_settings already had rows", () => {
    store.setSetting("ownerName", "someone");
    assert.equal(store.migratePluginFlags(), true);
    assert.deepEqual(pluginFlags(), [true, true, true, true, true, true]);
  });

  it("leaves the flags off and absent on an empty database but records the migration", () => {
    assert.equal(store.migratePluginFlags(), false);
    assert.deepEqual(pluginFlags(), [false, false, false, false, false, false]);
    for (const key of PLUGIN_FLAGS) assert.equal(store.getSetting(`features.${key}`), null);
    assert.equal(store.getSetting("plugins.migrated"), "1");
  });

  it("does not run twice: data that arrives after the first run does not flip the flags", () => {
    store.migratePluginFlags();
    insertSession(db, "s-late");
    store.setSetting("ownerName", "late");
    assert.equal(store.migratePluginFlags(), false);
    assert.deepEqual(pluginFlags(), [false, false, false, false, false, false]);
  });

  it("never overrides a choice made after the migration", () => {
    insertSession(db, "s-1");
    store.migratePluginFlags();
    store.updateSettings({ features: { flow: false, share: false } });
    assert.equal(store.migratePluginFlags(), false);
    const features = store.getSettings().features;
    assert.equal(features.flow, false);
    assert.equal(features.share, false);
    assert.equal(features.reports, true);
  });

  it("leaves the existing flags untouched", () => {
    insertSession(db, "s-1");
    store.updateSettings({ features: { daily: true, usage: true } });
    db.prepare(`DELETE FROM hub_settings WHERE key = 'plugins.migrated'`).run();
    store.migratePluginFlags();
    const features = store.getSettings().features;
    assert.deepEqual(LEGACY_FLAGS.map((key) => features[key]), [true, false, true, false, false]);
  });

  it("ignores its own keys when deciding whether the hub had data", () => {
    store.setSetting("features.flow", "0");
    assert.equal(store.migratePluginFlags(), false);
    assert.equal(store.getSettings().features.flow, false);
  });
});

describe("plugin flags at boot", () => {
  const box: Sandbox = makeSandbox("cch-plugins-boot-");
  const running: RunningServer[] = [];

  const boot = async (): Promise<RunningServer> => {
    const hub = await startServer(box, { HUB_DELEGATION: "1" });
    running.push(hub);
    return hub;
  };

  const stop = (hub: RunningServer): Promise<void> =>
    new Promise((resolve) => {
      if (hub.child.exitCode != null || hub.child.signalCode != null) {
        resolve();
        return;
      }
      hub.child.once("exit", () => resolve());
      hub.child.kill();
    });

  const features = async (hub: RunningServer): Promise<Record<string, boolean>> => {
    const res = await fetch(`${hub.base}/delegation/settings`);
    return ((await res.json()) as { features: Record<string, boolean> }).features;
  };

  const withDb = (run: (conn: Database.Database) => void): void => {
    const conn = new Database(join(box.dataDir, "hub.db"));
    try {
      run(conn);
    } finally {
      conn.close();
    }
  };

  after(async () => {
    await Promise.all(running.map(stop));
  });

  it("boots a new install with only the core, then keeps it on a second boot even with sessions", async () => {
    const first = await boot();
    const initial = await features(first);
    for (const key of PLUGIN_FLAGS) assert.equal(initial[key], false, key);
    await stop(first);
    withDb((conn) => insertSession(conn, "late-session"));
    const second = await boot();
    const kept = await features(second);
    for (const key of PLUGIN_FLAGS) assert.equal(kept[key], false, key);
    await stop(second);
  });

  it("migrates a hub that had data before this version and serves the flags on the first settings read", async () => {
    withDb((conn) => {
      conn.prepare(`DELETE FROM hub_settings WHERE key = 'plugins.migrated'`).run();
      conn.prepare(`INSERT INTO hub_settings (key, value) VALUES ('ownerName', 'before-upgrade') ON CONFLICT(key) DO NOTHING`).run();
      insertSession(conn, "before-upgrade");
    });
    const hub = await boot();
    const migrated = await features(hub);
    for (const key of PLUGIN_FLAGS) assert.equal(migrated[key], true, key);
    for (const key of LEGACY_FLAGS) assert.equal(migrated[key], false, key);
    const put = await fetch(`${hub.base}/delegation/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ features: { flow: false, delegated: false, workspaces: false, reports: false, share: false, widget: false } }),
    });
    assert.equal(put.status, 200);
    await stop(hub);
    const again = await boot();
    const kept = await features(again);
    for (const key of PLUGIN_FLAGS) assert.equal(kept[key], false, key);
  });
});

describe("plugin flags validation", () => {
  const box: Sandbox = makeSandbox("cch-plugins-put-");
  let hub: RunningServer;

  before(async () => {
    hub = await startServer(box, { HUB_DELEGATION: "1" });
  });

  after(() => {
    hub.child.kill();
  });

  const put = (body: unknown): Promise<Response> =>
    fetch(`${hub.base}/delegation/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("patches each plugin flag independently through PUT /delegation/settings", async () => {
    for (const key of PLUGIN_FLAGS) {
      const res = await put({ features: { [key]: true } });
      assert.equal(res.status, 200, key);
      const features = ((await res.json()) as { features: Record<string, boolean> }).features;
      assert.equal(features[key], true, key);
    }
    const off = ((await (await put({ features: { flow: false } })).json()) as { features: Record<string, boolean> }).features;
    assert.equal(off.flow, false);
    assert.equal(off.delegated, true);
  });

  it("rejects a non-boolean plugin flag with 400", async () => {
    for (const key of PLUGIN_FLAGS) assert.equal((await put({ features: { [key]: "yes" } })).status, 400, key);
  });
});
