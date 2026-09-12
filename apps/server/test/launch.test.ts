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
type TaskPorts = typeof import("../src/task-ports.js");
let launch: Launch;
let store: Store;
let db: Db["db"];
let taskPorts: TaskPorts;

before(async () => {
  launch = await import("../src/delegation-launch.js");
  store = await import("../src/delegation-store.js");
  ({ db } = await import("../src/db.js"));
  taskPorts = await import("../src/task-ports.js");
});

describe("permission mode resolution", () => {
  it("runs every delegation autonomously under full autonomy, honouring only plan", () => {
    assert.equal(launch.resolvePermissionMode(null, true), "bypassPermissions");
    assert.equal(launch.resolvePermissionMode("acceptEdits", true), "bypassPermissions");
    assert.equal(launch.resolvePermissionMode("dontAsk", true), "bypassPermissions");
    assert.equal(launch.resolvePermissionMode("plan", true), "plan");
    assert.equal(launch.resolvePermissionMode(null, false), "acceptEdits");
    assert.equal(launch.resolvePermissionMode("acceptEdits", false), "acceptEdits");
  });
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

describe("task port allocation", () => {
  it("gives a delegated task a reserved port block and the next task a different one", () => {
    const usedBefore = store
      .listTasks({ limit: 500 })
      .filter((task) => task.status === "running" || task.status === "pending")
      .map((task) => task.portBase)
      .filter((base): base is number => base != null);
    const firstBase = taskPorts.allocatePortBase(usedBefore);
    const first = store.createTask({
      title: "first",
      prompt: "do first",
      workspace: "pilot",
      repo: null,
      cwd: dataDir,
      addDirs: [],
      runner: "claude",
      model: null,
      permissionMode: null,
      sandbox: null,
      createdBy: "test",
      originSessionId: null,
      originClient: null,
      portBase: firstBase,
    });
    assert.equal(first.portBase, firstBase);

    const usedAfterFirst = store
      .listTasks({ limit: 500 })
      .filter((task) => task.status === "running" || task.status === "pending")
      .map((task) => task.portBase)
      .filter((base): base is number => base != null);
    const secondBase = taskPorts.allocatePortBase(usedAfterFirst);
    const second = store.createTask({
      title: "second",
      prompt: "do second",
      workspace: "pilot",
      repo: null,
      cwd: dataDir,
      addDirs: [],
      runner: "claude",
      model: null,
      permissionMode: null,
      sandbox: null,
      createdBy: "test",
      originSessionId: null,
      originClient: null,
      portBase: secondBase,
    });
    assert.equal(second.portBase, secondBase);
    assert.notEqual(second.portBase, first.portBase);
  });
});

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
