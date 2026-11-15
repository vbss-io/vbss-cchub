import assert from "node:assert/strict";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const tmp = mkdtempSync(join(tmpdir(), "cch-mcpcli-"));
const home = join(tmp, "home");
const bin = join(tmp, "bin");
const log = join(tmp, "cli.log");
mkdirSync(home, { recursive: true });
mkdirSync(bin, { recursive: true });

function fakeExecutable(name: string): string {
  const target = join(bin, process.platform === "win32" ? `${name}.exe` : name);
  try {
    linkSync(process.execPath, target);
  } catch {
    copyFileSync(process.execPath, target);
  }
  return target;
}

const fakeClaude = fakeExecutable("claude");
const fakeCodex = fakeExecutable("codex");

process.env.PATH = bin;
process.env.HUB_HOME = home;
process.env.HUB_DATA_DIR = join(tmp, "data");
process.env.APPDATA = join(home, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(home, "AppData", "Local");
process.env.CODEX_HOME = join(tmp, "codex");
process.env.HUB_PORT = "4317";
process.env.HUB_CLAUDE_ARGS_PREFIX = JSON.stringify([join(fixtures, "fake-claude.mjs")]);
process.env.HUB_CODEX_ARGS_PREFIX = JSON.stringify([join(fixtures, "fake-codex.mjs")]);
process.env.FAKE_CLI_LOG = log;
delete process.env.HUB_CLAUDE_BIN;
delete process.env.HUB_CODEX_BIN;
delete process.env.HUB_RESOURCE_DIR;
delete process.env.CLAUDE_CONFIG_DIR;

type Installers = typeof import("../src/installers.js");
type Config = typeof import("../src/config.js");
let installers: Installers;
let config: Config["config"];
let closeDb: () => void = () => undefined;

interface CliCall {
  kind: string;
  argv: string[];
  env: { HOME: string | null; USERPROFILE: string | null; CLAUDE_CONFIG_DIR: string | null; CODEX_HOME: string | null };
}

const calls = (): CliCall[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as CliCall)
    : [];

before(async () => {
  installers = await import("../src/installers.js");
  ({ config } = await import("../src/config.js"));
  const { db } = await import("../src/db.js");
  closeDb = () => db.close();
});

beforeEach(() => {
  rmSync(log, { force: true });
});

describe("MCP registration through the official CLIs", () => {
  it("registers Claude Code with claude mcp add-json -s user inside the hub home", () => {
    writeFileSync(config.claudeConfigPath, JSON.stringify({ numStartups: 2 }));
    const status = installers.configureMcp("claude-code", "install");
    const [call] = calls();
    assert.equal(calls().length, 1);
    assert.equal(call?.kind, "claude");
    assert.deepEqual(call?.argv.slice(0, 5), ["mcp", "add-json", "-s", "user", "cchub"]);
    assert.deepEqual(JSON.parse(call?.argv[5] ?? "null"), { type: "stdio", command: config.nodeBin, args: [config.mcpEntry], env: { HUB_PORT: "4317" } });
    assert.equal(call?.env.HOME, home);
    assert.equal(call?.env.USERPROFILE, home);
    assert.equal(call?.env.CLAUDE_CONFIG_DIR, null);
    assert.equal(status.cli, fakeClaude);
    assert.equal(status.installed, true);
    assert.equal(status.updateAvailable, false);
    assert.equal(existsSync(`${config.claudeConfigPath}.bak`), false);
    assert.equal((JSON.parse(readFileSync(config.claudeConfigPath, "utf8")) as { numStartups: number }).numStartups, 2);
  });

  it("reports update available when the registered entry differs and re-registers on install", () => {
    const state = JSON.parse(readFileSync(config.claudeConfigPath, "utf8")) as { mcpServers: Record<string, { env: Record<string, string> }> };
    state.mcpServers.cchub!.env = { HUB_PORT: "9999" };
    writeFileSync(config.claudeConfigPath, JSON.stringify(state));
    assert.equal(installers.mcpStatus("claude-code").updateAvailable, true);
    assert.equal(calls().length, 0);
    const status = installers.configureMcp("claude-code", "install");
    assert.deepEqual(
      calls().map((call) => call.argv.slice(0, 3)),
      [
        ["mcp", "remove", "cchub"],
        ["mcp", "add-json", "-s"],
      ],
    );
    assert.equal(status.updateAvailable, false);
  });

  it("removes Claude Code with claude mcp remove cchub -s user", () => {
    const status = installers.configureMcp("claude-code", "uninstall");
    assert.deepEqual(calls().map((call) => call.argv), [["mcp", "remove", "cchub", "-s", "user"]]);
    assert.equal(status.installed, false);
  });

  it("surfaces a CLI failure instead of writing the file", () => {
    const before = JSON.stringify({ mcpServers: { cchub: { command: "x" } } });
    writeFileSync(config.claudeConfigPath, before);
    process.env.FAKE_CLI_FAIL = "1";
    try {
      assert.throws(() => installers.configureMcp("claude-code", "uninstall"), /mcp remove failed: simulated failure/);
    } finally {
      delete process.env.FAKE_CLI_FAIL;
    }
    assert.equal(readFileSync(config.claudeConfigPath, "utf8"), before);
    installers.configureMcp("claude-code", "uninstall");
  });

  it("registers Codex with codex mcp add cchub --env K=V -- <cmd>", () => {
    mkdirSync(config.codexHome, { recursive: true });
    writeFileSync(config.codexConfigPath, 'model = "gpt-x"\n');
    const status = installers.configureMcp("codex", "install");
    const [call] = calls();
    assert.equal(call?.kind, "codex");
    assert.deepEqual(call?.argv, ["mcp", "add", "cchub", "--env", "HUB_PORT=4317", "--", config.nodeBin, config.mcpEntry]);
    assert.equal(call?.env.CODEX_HOME, config.codexHome);
    assert.equal(status.cli, fakeCodex);
    assert.equal(status.installed, true);
    assert.equal(status.updateAvailable, false);
    assert.match(readFileSync(config.codexConfigPath, "utf8"), /^model = "gpt-x"/);
  });

  it("flags an outdated Codex entry and removes it with codex mcp remove cchub", () => {
    writeFileSync(config.codexConfigPath, readFileSync(config.codexConfigPath, "utf8").replace(/HUB_PORT = "4317"/, 'HUB_PORT = "1"'));
    assert.equal(installers.mcpStatus("codex").updateAvailable, true);
    const status = installers.configureMcp("codex", "uninstall");
    assert.deepEqual(calls().map((call) => call.argv), [["mcp", "remove", "cchub"]]);
    assert.equal(status.installed, false);
    assert.doesNotMatch(readFileSync(config.codexConfigPath, "utf8"), /cchub/);
  });

  it("never runs a CLI to read the status", async () => {
    await installers.connectStatus();
    installers.mcpStatus("claude-code");
    installers.mcpStatus("codex");
    assert.equal(calls().length, 0);
  });

  it("keeps writing Claude Desktop directly, with a .bak copy", () => {
    const path = config.claudeDesktopConfigPath;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"keep":true}');
    const status = installers.configureMcp("claude-desktop", "install");
    assert.equal(status.cli, null);
    assert.equal(status.installed, true);
    assert.equal(readFileSync(`${path}.bak`, "utf8"), '{"keep":true}');
    assert.equal(calls().length, 0);
  });
});

function withFailing<T>(match: string, run: () => T): T {
  process.env.FAKE_CLI_FAIL_MATCH = match;
  try {
    return run();
  } finally {
    delete process.env.FAKE_CLI_FAIL_MATCH;
  }
}

const claudeEntry = (): unknown => (JSON.parse(readFileSync(config.claudeConfigPath, "utf8")) as { mcpServers?: Record<string, unknown> }).mcpServers?.cchub ?? null;

const OLD_CLAUDE = { type: "stdio", command: "old-node", args: ["old-mcp.cjs"], env: { HUB_PORT: "9999" }, timeout: 5 };

const OLD_CODEX_CLI = ['[mcp_servers.cchub]', 'command = "old-node"', 'args = ["old-mcp.cjs"]', "", "[mcp_servers.cchub.env]", 'HUB_PORT = "1"'].join("\n");

const OLD_CODEX_HAND = ["[mcp_servers.cchub]", "command = 'old-node'", "args = ['old-mcp.cjs']", "startup_timeout_sec = 30", "", "[mcp_servers.cchub.env]", 'HUB_PORT = "1"'].join("\n");

describe("a failed MCP update never leaves the user without the cchub entry", () => {
  beforeEach(() => {
    rmSync(`${config.claudeConfigPath}.bak`, { force: true });
    rmSync(`${config.codexConfigPath}.bak`, { force: true });
  });

  it("re-adds the previous Claude Code entry through the CLI when add-json fails", () => {
    writeFileSync(config.claudeConfigPath, JSON.stringify({ numStartups: 3, mcpServers: { cchub: OLD_CLAUDE, other: { command: "o" } } }));
    assert.throws(() => withFailing("4317", () => installers.configureMcp("claude-code", "install")), /mcp add-json failed: simulated failure.*restored through the CLI/s);
    assert.deepEqual(claudeEntry(), OLD_CLAUDE);
    assert.deepEqual(
      calls().map((call) => call.argv.slice(0, 2).join(" ")),
      ["mcp remove", "mcp add-json", "mcp add-json"],
    );
    assert.deepEqual(JSON.parse(calls()[2]?.argv[5] ?? "null"), OLD_CLAUDE);
    assert.equal((JSON.parse(readFileSync(config.claudeConfigPath, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers.other !== undefined, true);
  });

  it("writes the previous Claude Code entry back to the file, with a .bak, when the CLI cannot re-add it", () => {
    writeFileSync(config.claudeConfigPath, JSON.stringify({ numStartups: 3, mcpServers: { cchub: OLD_CLAUDE } }));
    assert.throws(() => withFailing("add-json", () => installers.configureMcp("claude-code", "install")), /mcp add-json failed: simulated failure.*written back to .*\.bak/s);
    assert.deepEqual(claudeEntry(), OLD_CLAUDE);
    assert.equal(existsSync(`${config.claudeConfigPath}.bak`), true);
    assert.equal((JSON.parse(readFileSync(config.claudeConfigPath, "utf8")) as { numStartups: number }).numStartups, 3);
    assert.equal(installers.mcpStatus("claude-code").installed, true);
  });

  it("keeps the previous Claude Code entry untouched when remove fails, without trying to add", () => {
    const before = JSON.stringify({ mcpServers: { cchub: OLD_CLAUDE } });
    writeFileSync(config.claudeConfigPath, before);
    assert.throws(() => withFailing("remove", () => installers.configureMcp("claude-code", "install")), /mcp remove failed: simulated failure.*previous cchub entry was kept/s);
    assert.equal(readFileSync(config.claudeConfigPath, "utf8"), before);
    assert.deepEqual(calls().map((call) => call.argv.slice(0, 2).join(" ")), ["mcp remove"]);
  });

  it("surfaces a failed first install without inventing an entry", () => {
    writeFileSync(config.claudeConfigPath, JSON.stringify({ numStartups: 1 }));
    assert.throws(() => withFailing("add-json", () => installers.configureMcp("claude-code", "install")), /^Error: mcp add-json failed: simulated failure/);
    assert.equal(claudeEntry(), null);
  });

  it("re-adds the previous Codex entry through the CLI when codex mcp add fails", () => {
    mkdirSync(config.codexHome, { recursive: true });
    writeFileSync(config.codexConfigPath, `model = "gpt-x"\n\n${OLD_CODEX_CLI}\n`);
    assert.throws(() => withFailing("4317", () => installers.configureMcp("codex", "install")), /mcp add failed: simulated failure.*restored through the CLI/s);
    const text = readFileSync(config.codexConfigPath, "utf8");
    assert.match(text, /^model = "gpt-x"/);
    assert.ok(text.includes(OLD_CODEX_CLI));
    assert.deepEqual(installers.codexRegisteredEntry(text), { command: "old-node", args: ["old-mcp.cjs"], env: { HUB_PORT: "1" } });
    assert.deepEqual(calls().map((call) => call.argv.slice(0, 2).join(" ")), ["mcp remove", "mcp add", "mcp add"]);
  });

  it("writes the exact previous Codex block back when the CLI cannot re-add it", () => {
    writeFileSync(config.codexConfigPath, `model = "gpt-x"\n\n${OLD_CODEX_HAND}\n\n[profiles.fast]\nmodel = "y"\n`);
    assert.throws(() => withFailing("mcp add", () => installers.configureMcp("codex", "install")), /mcp add failed: simulated failure.*written back to .*\.bak/s);
    const text = readFileSync(config.codexConfigPath, "utf8");
    assert.ok(text.includes(OLD_CODEX_HAND));
    assert.match(text, /^model = "gpt-x"/);
    assert.match(text, /\[profiles\.fast\]\nmodel = "y"/);
    assert.equal(existsSync(`${config.codexConfigPath}.bak`), true);
    assert.equal(installers.mcpStatus("codex").installed, true);
  });

  it("replaces the Codex entry when the update succeeds", () => {
    const status = installers.configureMcp("codex", "install");
    assert.equal(status.updateAvailable, false);
    assert.deepEqual(installers.codexRegisteredEntry(readFileSync(config.codexConfigPath, "utf8")), { command: config.nodeBin, args: [config.mcpEntry], env: { HUB_PORT: "4317" } });
  });
});

describe("Codex config parsing", () => {
  it("reads basic and literal strings, inline env tables, multi-line arrays and comments", () => {
    const text = [
      "[mcp_servers.other]",
      'command = "x"',
      "",
      "[mcp_servers.cchub]",
      "command = 'C:\\Program Files\\node.exe'",
      "args = [",
      '  "C:\\\\hub\\\\mcp.cjs", # entry',
      "]",
      'env = { HUB_PORT = "4317", "X" = "a\\"b" }',
      "",
      "[profiles.fast]",
      'model = "y"',
    ].join("\n");
    assert.deepEqual(installers.codexRegisteredEntry(text), { command: "C:\\Program Files\\node.exe", args: ["C:\\hub\\mcp.cjs"], env: { HUB_PORT: "4317", X: 'a"b' } });
    assert.equal(installers.codexRegisteredEntry("[mcp_servers.other]\ncommand = 'x'\n"), null);
    assert.equal(installers.codexRegisteredEntry("[mcp_servers.cchub]\ncommand = \"broken\n"), null);
  });
});

after(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
