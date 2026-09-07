import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "cch-launch-"));
process.env.HUB_DATA_DIR = dataDir;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.HUB_DELEGATION_TIMEOUT_MIN;

type Launch = typeof import("../src/delegation-launch.js");
type Store = typeof import("../src/delegation-store.js");
type Db = typeof import("../src/db.js");
let launch: Launch;
let store: Store;
let db: Db["db"];

before(async () => {
  launch = await import("../src/delegation-launch.js");
  store = await import("../src/delegation-store.js");
  ({ db } = await import("../src/db.js"));
});

describe("run timeout resolution", () => {
  it("uses the store setting by default and lets the env override win", () => {
    delete process.env.HUB_DELEGATION_TIMEOUT_MIN;
    store.updateSettings({ runTimeoutMinutes: 45 });
    assert.equal(launch.resolveRunTimeoutMs(), 45 * 60_000);
    process.env.HUB_DELEGATION_TIMEOUT_MIN = "10";
    assert.equal(launch.resolveRunTimeoutMs(), 10 * 60_000);
    process.env.HUB_DELEGATION_TIMEOUT_MIN = "0";
    assert.equal(launch.resolveRunTimeoutMs(), 0);
    delete process.env.HUB_DELEGATION_TIMEOUT_MIN;
    store.updateSettings({ runTimeoutMinutes: 60 });
    assert.equal(launch.resolveRunTimeoutMs(), 60 * 60_000);
  });
});

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
