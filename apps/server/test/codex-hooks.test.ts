import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const root = mkdtempSync(join(tmpdir(), "cchub-g1-codex-hooks-"));
process.env.CODEX_HOME = join(root, "codex-default");
delete process.env.HUB_RESOURCE_DIR;

const hooks = await import("../src/codex-hooks.js");

interface Handler {
  type: string;
  command: string;
  commandWindows?: string;
  timeout?: number;
  async?: boolean;
}

interface Group {
  matcher?: string;
  hooks: Handler[];
}

interface HooksFile {
  description?: string;
  hooks: Record<string, Group[]>;
}

let counter = 0;
const fresh = (): string => {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "hooks.json");
};

const read = (path: string): HooksFile => JSON.parse(readFileSync(path, "utf8")) as HooksFile;
const ours = (groups: Group[] | undefined): Group[] => (groups ?? []).filter((group) => group.hooks.some((handler) => handler.command.includes("codex-notify.mjs")));

const userGuard: Group = { matcher: "Bash", hooks: [{ type: "command", command: "python3 ~/.codex/hooks/guard.py", timeout: 30 }] };
const userStop: Group = { hooks: [{ type: "command", command: "say done" }] };
const original = `{\r\n    "description": "mine",\r\n    "hooks": {\r\n        "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "python3 ~/.codex/hooks/guard.py", "timeout": 30 } ] } ],\r\n        "Stop": [ { "hooks": [ { "type": "command", "command": "say done" } ] } ]\r\n    }\r\n}\r\n`;

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Codex hooks installer", () => {
  it("installs into a missing hooks.json and uninstall removes the file again", () => {
    const path = fresh();
    const before = hooks.codexHooksStatus(20, path);
    assert.equal(before.exists, false);
    assert.equal(before.installed, false);
    assert.equal(before.updateAvailable, false);
    const status = hooks.installCodexHooks(20, path);
    assert.equal(status.installed, true);
    assert.deepEqual(status.missing, []);
    assert.match(status.trustNote, /review and trust/);
    const file = read(path);
    for (const event of hooks.CODEX_HOOK_INSTALL_EVENTS) assert.equal(ours(file.hooks[event]).length, 1, event);
    const permission = ours(file.hooks.PermissionRequest)[0]?.hooks[0];
    assert.equal(permission?.timeout, 30);
    assert.ok(permission?.commandWindows?.includes("codex-notify.mjs"));
    assert.equal(ours(file.hooks.PostToolUse)[0]?.hooks[0]?.async, true);
    assert.equal(existsSync(`${path}.bak`), false);
    const removed = hooks.uninstallCodexHooks(20, path);
    assert.equal(removed.installed, false);
    assert.equal(existsSync(path), false);
  });

  it("merges into an existing hooks.json, keeps the user's hooks, backs up and restores it byte for byte", () => {
    const path = fresh();
    writeFileSync(path, original);
    hooks.installCodexHooks(20, path);
    assert.equal(readFileSync(`${path}.bak`, "utf8"), original);
    const file = read(path);
    assert.equal(file.description, "mine");
    assert.deepEqual(file.hooks.PreToolUse, [userGuard]);
    assert.deepEqual(file.hooks.Stop?.[0], userStop);
    assert.equal(ours(file.hooks.Stop).length, 1);
    const once = readFileSync(path, "utf8");
    hooks.installCodexHooks(20, path);
    assert.equal(readFileSync(path, "utf8"), once);
    assert.equal(readFileSync(`${path}.bak`, "utf8"), original);
    hooks.uninstallCodexHooks(20, path);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(existsSync(`${path}.bak`), false);
  });

  it("flags update available when the approval window changed and updates in place", () => {
    const path = fresh();
    writeFileSync(path, original);
    hooks.installCodexHooks(20, path);
    const changed = hooks.codexHooksStatus(45, path);
    assert.equal(changed.installed, false);
    assert.equal(changed.updateAvailable, true);
    assert.deepEqual(changed.missing, ["PermissionRequest"]);
    const updated = hooks.installCodexHooks(45, path);
    assert.equal(updated.installed, true);
    assert.equal(ours(read(path).hooks.PermissionRequest)[0]?.hooks[0]?.timeout, 55);
    assert.equal(readFileSync(`${path}.bak`, "utf8"), original);
    hooks.uninstallCodexHooks(45, path);
    assert.equal(readFileSync(path, "utf8"), original);
  });

  it("keeps a later user edit on uninstall instead of restoring the old backup", () => {
    const path = fresh();
    writeFileSync(path, original);
    hooks.installCodexHooks(20, path);
    const edited = read(path);
    edited.hooks.SessionStart = [...(edited.hooks.SessionStart ?? []), { hooks: [{ type: "command", command: "echo hi" }] }];
    writeFileSync(path, JSON.stringify(edited));
    hooks.uninstallCodexHooks(20, path);
    const after = read(path);
    assert.deepEqual(after.hooks.SessionStart, [{ hooks: [{ type: "command", command: "echo hi" }] }]);
    assert.deepEqual(after.hooks.PreToolUse, [userGuard]);
    for (const event of Object.keys(after.hooks)) assert.equal(ours(after.hooks[event]).length, 0, event);
  });

  it("leaves an invalid hooks.json untouched", () => {
    const path = fresh();
    writeFileSync(path, "{ not json");
    assert.throws(() => hooks.installCodexHooks(20, path), /not valid JSON/);
    assert.equal(readFileSync(path, "utf8"), "{ not json");
    assert.match(hooks.codexHooksStatus(20, path).error ?? "", /not valid JSON/);
  });

  it("uses the configured CODEX_HOME by default", () => {
    assert.equal(hooks.codexHooksPath(), join(root, "codex-default", "hooks.json"));
  });
});
