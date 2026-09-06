import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const home = mkdtempSync(join(tmpdir(), "cch-home-"));
process.env.HUB_HOME = home;
process.env.HUB_DATA_DIR = join(home, ".vbss-cchub");
process.env.APPDATA = join(home, "AppData", "Roaming");
process.env.CODEX_HOME = join(home, ".codex");
process.env.HUB_PORT = "4317";
delete process.env.HUB_RESOURCE_DIR;

type Installers = typeof import("../src/installers.js");
type Config = typeof import("../src/config.js");
let installers: Installers;
let config: Config["config"];
let closeDb: () => void = () => undefined;

before(async () => {
  installers = await import("../src/installers.js");
  ({ config } = await import("../src/config.js"));
  const { db } = await import("../src/db.js");
  closeDb = () => db.close();
});

describe("shell alias", () => {
  it("installs a guarded block in .bashrc and removes it cleanly", async () => {
    const rc = join(home, ".bashrc");
    writeFileSync(rc, "export FOO=1\n");
    const before = await installers.shellStatus("bash");
    assert.equal(before.installed, false);
    assert.equal(before.external, false);
    const installed = await installers.configureShell("bash", "install", "C:\\ws");
    assert.equal(installed.installed, true);
    const text = readFileSync(rc, "utf8");
    assert.match(text, /export FOO=1/);
    assert.match(text, /export WORKSPACES_ROOT="C:\/ws"/);
    assert.match(text, /wk\.sh/);
    await installers.configureShell("bash", "install", "C:\\ws2");
    assert.equal(readFileSync(rc, "utf8").split("# >>> vbss-cchub wk >>>").length, 2);
    const removed = await installers.configureShell("bash", "uninstall", null);
    assert.equal(removed.installed, false);
    assert.equal(readFileSync(rc, "utf8"), "export FOO=1\n");
  });

  it("detects an alias defined by the user outside the hub block", async () => {
    writeFileSync(join(home, ".bashrc"), "workspace() {\n  echo hi\n}\nalias wk='workspace'\n");
    const status = await installers.shellStatus("bash");
    assert.equal(status.external, true);
    assert.equal(status.installed, false);
  });

  it("writes the PowerShell profile under the home fallback when testing", async () => {
    const status = await installers.configureShell("powershell", "install", "C:\\ws");
    assert.equal(status.installed, true);
    assert.equal(status.path, join(home, "Documents", "WindowsPowerShell", "profile.ps1"));
    assert.match(readFileSync(status.path, "utf8"), /\$env:WORKSPACES_ROOT = "C:\\ws"/);
  });
});

describe("mcp registration", () => {
  it("adds the hub server to Claude Code without touching other keys", () => {
    writeFileSync(config.claudeConfigPath, JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "x" } } }));
    const status = installers.configureMcp("claude-code", "install");
    assert.equal(status.installed, true);
    const json = JSON.parse(readFileSync(config.claudeConfigPath, "utf8")) as { numStartups: number; mcpServers: Record<string, { type?: string; command: string; args: string[] }> };
    assert.equal(json.numStartups, 3);
    assert.equal(json.mcpServers.other?.command, "x");
    assert.equal(json.mcpServers.cchub?.type, "stdio");
    assert.equal(json.mcpServers.cchub?.command, config.nodeBin);
    assert.deepEqual(json.mcpServers.cchub?.args, [config.mcpEntry]);
    assert.equal(installers.configureMcp("claude-code", "uninstall").installed, false);
    assert.equal(installers.mcpStatus("claude-code").installed, false);
  });

  it("creates the Claude Desktop config when missing", () => {
    const status = installers.configureMcp("claude-desktop", "install");
    assert.equal(status.installed, true);
    assert.equal(status.path, join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"));
    const json = JSON.parse(readFileSync(status.path, "utf8")) as { mcpServers: Record<string, { command: string }> };
    assert.equal(json.mcpServers.cchub?.command, config.nodeBin);
  });

  it("keeps Claude Desktop connected after the app imports and clears the entry", () => {
    installers.configureMcp("claude-desktop", "install");
    const path = installers.mcpStatus("claude-desktop").path;
    writeFileSync(path, JSON.stringify({ mcpServers: {} }));
    const status = installers.mcpStatus("claude-desktop");
    assert.equal(status.inFile, false);
    assert.equal(status.installed, true);
    assert.ok((status.registeredAt ?? 0) > 0);
    assert.equal(installers.configureMcp("claude-desktop", "uninstall").installed, false);
    assert.equal(installers.mcpStatus("claude-desktop").registeredAt, null);
    installers.configureMcp("claude-desktop", "install");
  });

  it("refuses to rewrite an invalid JSON config", () => {
    writeFileSync(config.claudeConfigPath, "{ nope");
    assert.equal(installers.mcpStatus("claude-code").error, "config file is not valid JSON");
    assert.throws(() => installers.configureMcp("claude-code", "install"), /not valid JSON/);
  });

  it("appends and removes a TOML block in the Codex config, keeping other servers", () => {
    mkdirSync(config.codexHome, { recursive: true });
    writeFileSync(config.codexConfigPath, "model = \"gpt-x\"\n\n[mcp_servers.node_repl]\ncommand = 'C:\\x\\node_repl.exe'\nargs = []\n");
    const status = installers.configureMcp("codex", "install");
    assert.equal(status.installed, true);
    const text = readFileSync(config.codexConfigPath, "utf8");
    assert.match(text, /\[mcp_servers\.node_repl\]/);
    assert.match(text, /\[mcp_servers\.cchub\]\ncommand = '.*'\nargs = \['.*'\]\n\n\[mcp_servers\.cchub\.env\]\nHUB_PORT = "4317"/);
    installers.configureMcp("codex", "install");
    assert.equal(readFileSync(config.codexConfigPath, "utf8").split("[mcp_servers.cchub]").length, 2);
    installers.configureMcp("codex", "uninstall");
    const after = readFileSync(config.codexConfigPath, "utf8");
    assert.ok(!after.includes("cchub"));
    assert.match(after, /\[mcp_servers\.node_repl\]/);
  });

  it("summarizes everything in one status call", async () => {
    const status = await installers.connectStatus();
    assert.equal(status.server.command, config.nodeBin);
    assert.equal(status.mcp["claude-desktop"].installed, true);
    assert.equal(status.mcp.codex.installed, false);
    assert.equal(status.shell.powershell.installed, true);
  });
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
