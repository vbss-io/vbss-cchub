import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import { s1Listen, s1Request, s1Sandbox, type S1Listening } from "./helpers/s1-env.js";

const box = s1Sandbox("cch-s1-resource-", { HUB_DELEGATION: "1", HUB_PREVIEW: "1" });
const resources = join(box.tmp, "app", "resources");
mkdirSync(resources, { recursive: true });
process.env.HUB_RESOURCE_DIR = resources;
delete process.env.HUB_APP_EXE;

mkdirSync(box.dataDir, { recursive: true });
const seed = new Database(join(box.dataDir, "hub.db"));
seed.exec("CREATE TABLE IF NOT EXISTS seed (id INTEGER PRIMARY KEY)");
seed.close();

const logged: string[] = [];
mock.method(console, "log", (...args: unknown[]) => {
  logged.push(args.map(String).join(" "));
});
await import("../src/upgrade-backup.js");
const upgradeLogs = [...logged];
mock.restoreAll();

const { ensureExtension } = await import("../src/ensure-extension.js");
const { focusWindow } = await import("../src/focus.js");
const { windowsHooks } = await import("../src/hooks-control.js");
const { appExecutable } = await import("../src/autostart.js");
const { createApp, defaultAppDeps } = await import("../src/app.js");
const { db } = await import("../src/db.js");

let web: S1Listening;

before(async () => {
  web = await s1Listen(createApp({ dataDir: box.dataDir, staticDir: null, previewMode: true, devSeed: false }, defaultAppDeps));
});

after(async () => {
  await web.close();
  db.close();
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

describe("upgrade backup at startup", () => {
  it("backs up an existing database before a new version runs", () => {
    assert.equal(upgradeLogs.length, 1);
    assert.match(upgradeLogs[0] ?? "", /^upgrade backup written: /);
    const backups = readdirSync(join(box.dataDir, "backups"));
    assert.ok(backups.some((name) => name.includes("upgrade")), backups.join(","));
  });
});

describe("resource dir paths", () => {
  it("runs the focus script shipped in the resources", async () => {
    let script = "";
    await focusWindow(
      5,
      null,
      async (_file, args) => {
        script = args[args.indexOf("-File") + 1] ?? "";
      },
      "win32",
    );
    assert.equal(script, join(resources, "scripts", "focus.ps1"));
  });

  it("runs the shipped configure script with the bundled node as runner", async () => {
    let seen: string[] = [];
    await windowsHooks("status", async (_file, args) => {
      seen = args;
      return { stdout: "{}" };
    });
    assert.equal(seen[0], join(resources, "hooks", "configure.mjs"));
    assert.deepEqual(seen.slice(2, 4), ["--runner", process.execPath]);
  });

  it("finds the app executable beside the resources folder", () => {
    assert.equal(appExecutable(), null);
    const exe = join(box.tmp, "app", "vbss-cchub.exe");
    writeFileSync(exe, "");
    assert.equal(appExecutable(), exe);
  });
});

describe("ensureExtension", () => {
  const extRoot = join(box.home, ".vscode", "extensions");
  const source = join(resources, "vscode-ext");
  const pkg = { publisher: "vbss", name: "cchub", version: "1.2.0" };

  it("does nothing without the shipped extension or a VS Code extensions folder", () => {
    ensureExtension();
    assert.equal(existsSync(extRoot), false);
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(source, "extension.js"), "module.exports = {};");
    ensureExtension();
    assert.equal(existsSync(extRoot), false);
  });

  it("replaces older copies with the shipped version", () => {
    mkdirSync(join(extRoot, "vbss.cchub-1.0.0"), { recursive: true });
    mkdirSync(join(extRoot, "someone.else-1.0.0"), { recursive: true });
    ensureExtension();
    assert.deepEqual(readdirSync(extRoot).sort(), ["someone.else-1.0.0", "vbss.cchub-1.2.0"]);
    assert.equal(readFileSync(join(extRoot, "vbss.cchub-1.2.0", "extension.js"), "utf8"), "module.exports = {};");
  });

  it("keeps an installed copy of the same version untouched", () => {
    writeFileSync(join(extRoot, "vbss.cchub-1.2.0", "marker"), "kept");
    writeFileSync(join(source, "extension.js"), "changed");
    ensureExtension();
    assert.equal(readFileSync(join(extRoot, "vbss.cchub-1.2.0", "extension.js"), "utf8"), "module.exports = {};");
    assert.equal(readFileSync(join(extRoot, "vbss.cchub-1.2.0", "marker"), "utf8"), "kept");
  });

  it("swallows a broken extension manifest", () => {
    writeFileSync(join(source, "package.json"), "{broken");
    assert.doesNotThrow(() => ensureExtension());
    assert.deepEqual(readdirSync(extRoot).sort(), ["someone.else-1.0.0", "vbss.cchub-1.2.0"]);
  });
});

describe("preview mode", () => {
  it("refuses codex hook and statusline changes", async () => {
    const codex = await s1Request(web.base, "POST", "/delegation/connect/codex-hooks", { action: "install" });
    assert.equal(codex.status, 403);
    assert.match((codex.json as { error: string }).error, /preview mode/);
    const install = await s1Request(web.base, "POST", "/delegation/limits/claude-source/install");
    assert.equal(install.status, 403);
    const uninstall = await s1Request(web.base, "POST", "/delegation/limits/claude-source/uninstall");
    assert.equal(uninstall.status, 403);
    assert.match((uninstall.json as { error: string }).error, /statusline changes are disabled/);
  });
});
