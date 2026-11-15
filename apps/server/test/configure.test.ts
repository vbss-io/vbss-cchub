import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const configure = join(here, "..", "hooks", "configure.mjs");
const home = mkdtempSync(join(tmpdir(), "cch-configure-"));
const notifyPath = "C:/hub/hooks/notify.mjs";

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

interface Settings {
  model?: string;
  hooks: Record<string, HookEntry[]>;
}

interface Status {
  installed: boolean;
  outdated: boolean;
  missing: string[];
  events: string[];
}

const OLD_EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd", "SubagentStart", "SubagentStop"];
const hubEntry = (): HookEntry => ({ hooks: [{ type: "command", command: `node "${notifyPath}"` }] });
const userStop: HookEntry = { hooks: [{ type: "command", command: "say done" }] };
const userGuard: HookEntry = { matcher: "Bash", hooks: [{ type: "command", command: "my-guard.sh" }] };

function run(settingsPath: string, action: string): Status {
  const out = spawnSync(process.execPath, [configure, action, "--settings", settingsPath, "--notify", notifyPath], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
  });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim().split(/\r?\n/).pop() ?? "{}") as Status;
}

function oldInstall(name: string): string {
  const path = join(home, `${name}.json`);
  const hooks: Record<string, HookEntry[]> = {};
  for (const event of OLD_EVENTS) hooks[event] = [hubEntry()];
  hooks.Stop = [userStop, hubEntry()];
  hooks.PreToolUse = [userGuard];
  writeFileSync(path, JSON.stringify({ model: "opus", hooks }, null, 2));
  return path;
}

const read = (path: string): Settings => JSON.parse(readFileSync(path, "utf8")) as Settings;
const ours = (entries: HookEntry[] | undefined): HookEntry[] => (entries ?? []).filter((entry) => entry.hooks.some((hook) => hook.command.includes("notify.mjs")));

after(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("hook configuration", () => {
  it("flags an install made before StopFailure as outdated", () => {
    const status = run(oldInstall("old"), "status");
    assert.equal(status.installed, false);
    assert.equal(status.outdated, true);
    assert.deepEqual(status.missing.sort(), ["SessionEnd", "StopFailure"]);
  });

  it("does not call a settings file without hub hooks outdated", () => {
    const path = join(home, "fresh.json");
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [userGuard] } }));
    const status = run(path, "status");
    assert.equal(status.installed, false);
    assert.equal(status.outdated, false);
  });

  it("adds StopFailure once, times SessionEnd and keeps the user's own hooks", () => {
    const path = oldInstall("upgrade");
    const first = run(path, "install");
    assert.equal(first.installed, true);
    assert.equal(first.outdated, false);
    assert.deepEqual(first.missing, []);
    const once = read(path);
    run(path, "install");
    const twice = read(path);
    assert.deepEqual(twice, once);
    for (const event of [...OLD_EVENTS, "StopFailure"]) assert.equal(ours(twice.hooks[event]).length, 1, event);
    assert.ok((ours(twice.hooks.SessionEnd)[0]?.hooks[0]?.timeout ?? 0) > 1.5);
    assert.deepEqual(twice.hooks.Stop?.[0], userStop);
    assert.deepEqual(twice.hooks.PreToolUse, [userGuard]);
    assert.equal(twice.model, "opus");
    assert.ok(existsSync(`${path}.bak`));
  });

  it("uninstall removes every hub hook including the new events and leaves the user's hooks", () => {
    const path = oldInstall("remove");
    run(path, "install");
    const status = run(path, "uninstall");
    assert.equal(status.installed, false);
    const settings = read(path);
    for (const event of Object.keys(settings.hooks)) assert.equal(ours(settings.hooks[event]).length, 0, event);
    assert.equal(settings.hooks.StopFailure, undefined);
    assert.equal(settings.hooks.PermissionRequest, undefined);
    assert.deepEqual(settings.hooks.Stop, [userStop]);
    assert.deepEqual(settings.hooks.PreToolUse, [userGuard]);
  });
});
