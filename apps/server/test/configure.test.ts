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
const G1_EVENTS = ["PermissionRequest", "PostToolUse", "PostToolUseFailure"];
const NEW_MISSING = ["PermissionRequest", "PostToolUse", "PostToolUseFailure", "SessionEnd", "StopFailure"];
const hubEntry = (): HookEntry => ({ hooks: [{ type: "command", command: `node "${notifyPath}"` }] });
const userStop: HookEntry = { hooks: [{ type: "command", command: "say done" }] };
const userGuard: HookEntry = { matcher: "Bash", hooks: [{ type: "command", command: "my-guard.sh" }] };

function run(settingsPath: string, action: string, extra: string[] = []): Status {
  const out = spawnSync(process.execPath, [configure, action, "--settings", settingsPath, "--notify", notifyPath, ...extra], {
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
    assert.deepEqual(status.missing.sort(), NEW_MISSING);
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
    for (const event of [...OLD_EVENTS, "StopFailure", ...G1_EVENTS]) assert.equal(ours(twice.hooks[event]).length, 1, event);
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

  const userSay: HookCommand = { type: "command", command: "say done" };
  const userPing: HookCommand = { type: "command", command: "ping-me.sh", timeout: 9 };
  const sharedInstall = (name: string): string => {
    const path = join(home, `${name}.json`);
    const hooks: Record<string, HookEntry[]> = {};
    for (const event of OLD_EVENTS) hooks[event] = [hubEntry()];
    hooks.Stop = [{ hooks: [userSay, ...hubEntry().hooks] }];
    hooks.SessionEnd = [{ matcher: "clear", hooks: [...hubEntry().hooks, userPing] }];
    writeFileSync(path, JSON.stringify({ hooks }, null, 2));
    return path;
  };
  const userCommands = (entries: HookEntry[] | undefined): string[] =>
    (entries ?? []).flatMap((entry) => entry.hooks.filter((hook) => !hook.command.includes("notify.mjs")).map((hook) => `${entry.matcher ?? ""}|${hook.command}`));

  it("install keeps a user's hook that shares an entry with the hub hook", () => {
    const path = sharedInstall("shared-install");
    const status = run(path, "install");
    assert.equal(status.installed, true);
    const settings = read(path);
    assert.deepEqual(userCommands(settings.hooks.Stop), ["|say done"]);
    assert.deepEqual(userCommands(settings.hooks.SessionEnd), ["clear|ping-me.sh"]);
    assert.deepEqual(settings.hooks.Stop?.[0], { hooks: [userSay] });
    assert.deepEqual(settings.hooks.SessionEnd?.[0], { matcher: "clear", hooks: [userPing] });
    for (const event of [...OLD_EVENTS, "StopFailure", ...G1_EVENTS]) assert.equal(ours(settings.hooks[event]).length, 1, event);
  });

  it("an update of an outdated install keeps the shared user hooks and is stable", () => {
    const path = sharedInstall("shared-update");
    const before = run(path, "status");
    assert.equal(before.outdated, true);
    assert.deepEqual(before.missing.sort(), NEW_MISSING);
    run(path, "install");
    const once = read(path);
    run(path, "install");
    assert.deepEqual(read(path), once);
    assert.deepEqual(userCommands(once.hooks.Stop), ["|say done"]);
    assert.deepEqual(userCommands(once.hooks.SessionEnd), ["clear|ping-me.sh"]);
    assert.ok((ours(once.hooks.SessionEnd)[0]?.hooks[0]?.timeout ?? 0) > 1.5);
  });

  it("registers PermissionRequest with the approval timeout and the tool events as async", () => {
    const path = join(home, "g1.json");
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [userGuard] } }));
    run(path, "install", ["--permission-timeout", "330"]);
    const settings = read(path);
    assert.equal(ours(settings.hooks.PermissionRequest)[0]?.hooks[0]?.timeout, 330);
    for (const event of ["PostToolUse", "PostToolUseFailure"]) {
      const hook = ours(settings.hooks[event])[0]?.hooks[0] as HookCommand & { async?: boolean };
      assert.equal(hook.async, true, event);
    }
    assert.equal(run(path, "status", ["--permission-timeout", "330"]).installed, true);
    const changed = run(path, "status", ["--permission-timeout", "50"]);
    assert.equal(changed.outdated, true);
    assert.deepEqual(changed.missing, ["PermissionRequest"]);
    run(path, "install", ["--permission-timeout", "50"]);
    assert.equal(ours(read(path).hooks.PermissionRequest)[0]?.hooks[0]?.timeout, 50);
    assert.deepEqual(read(path).hooks.PreToolUse, [userGuard]);
  });

  it("uninstall removes only the hub hook from a shared entry and keeps its matcher", () => {
    const path = sharedInstall("shared-remove");
    const status = run(path, "uninstall");
    assert.equal(status.installed, false);
    const settings = read(path);
    assert.deepEqual(settings.hooks.Stop, [{ hooks: [userSay] }]);
    assert.deepEqual(settings.hooks.SessionEnd, [{ matcher: "clear", hooks: [userPing] }]);
    assert.equal(settings.hooks.Notification, undefined);
    for (const event of Object.keys(settings.hooks)) assert.equal(ours(settings.hooks[event]).length, 0, event);
  });
});
