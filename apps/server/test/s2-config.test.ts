import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { serverDir } from "./helpers.js";

const tmp = mkdtempSync(join(tmpdir(), "cch-s2-config-"));
const home = join(tmp, "home");
mkdirSync(home, { recursive: true });
process.env.HUB_DATA_DIR = join(tmp, "data");
process.env.HUB_HOME = home;
delete process.env.HUB_RESOURCE_DIR;

const { claudeConfigDirFrom } = await import("../src/config.js");

after(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

type Printed = Record<string, unknown> & { emptyTtlMs: number; trustedOrigins: string[]; claudeArgsPrefix: string[]; urlOpener: string[]; ngrokArgsPrefix: string[] };

const ENV_KEYS = [
  "HUB_HOME", "HUB_DATA_DIR", "HUB_RESOURCE_DIR", "HUB_EMPTY_TTL_HOURS", "HUB_HOST", "HUB_PORT", "HUB_SHARE_PORT", "HUB_SHARE_HOST", "HUB_NGROK_BIN", "HUB_NGROK_ARGS_PREFIX", "HUB_STATIC_DIR", "HUB_DELEGATION", "HUB_PREVIEW", "HUB_CLAUDE_BIN", "HUB_CLAUDE_ARGS_PREFIX", "HUB_CODEX_BIN", "HUB_CODEX_ARGS_PREFIX", "HUB_URL_OPENER", "HUB_TRUSTED_ORIGINS", "HUB_WORKSPACES_ROOT", "HUB_EDITOR", "HUB_SECOND_BRAIN", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "HUB_CLAUDE_CREDENTIALS", "HUB_CLAUDE_STATE", "HUB_CLAUDE_USAGE_URL", "HUB_CLAUDE_PROJECTS_DIR", "APPDATA", "LOCALAPPDATA",
];

function childEnvFor(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ENV_KEYS) delete childEnv[key];
  Object.assign(childEnv, { HUB_DATA_DIR: join(tmp, "child-data") }, env);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key];
  return childEnv;
}

function printConfig(env: Record<string, string | undefined>): Printed {
  const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "import { config } from './src/config.ts'; process.stdout.write(JSON.stringify(config));"], { cwd: serverDir, env: childEnvFor(env), encoding: "utf8" });
  return JSON.parse(out) as Printed;
}

function printVersion(prelude: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `${prelude} const { appVersion } = await import('./src/config.ts'); process.stdout.write(appVersion);`], { cwd: serverDir, env: childEnvFor({ HUB_HOME: home }), encoding: "utf8" });
}

describe("configuration from the environment", () => {
  it("takes every setting from its variable", () => {
    const resource = join(tmp, "resources");
    const config = printConfig({
      HUB_HOME: home,
      HUB_DATA_DIR: join(tmp, "custom-data"),
      HUB_RESOURCE_DIR: resource,
      HUB_EMPTY_TTL_HOURS: "2",
      HUB_HOST: "127.0.0.2",
      HUB_PORT: "4999",
      HUB_SHARE_PORT: "4998",
      HUB_SHARE_HOST: "127.0.0.3",
      HUB_NGROK_BIN: "C:/tools/ngrok.exe",
      HUB_NGROK_ARGS_PREFIX: JSON.stringify(["--flag", 5, "x"]),
      HUB_DELEGATION: "1",
      HUB_PREVIEW: "1",
      HUB_CLAUDE_BIN: "claude-custom",
      HUB_CLAUDE_ARGS_PREFIX: JSON.stringify(["a", "b"]),
      HUB_CODEX_BIN: "codex-custom",
      HUB_CODEX_ARGS_PREFIX: JSON.stringify(["c"]),
      HUB_URL_OPENER: JSON.stringify(["opener", "--x"]),
      HUB_TRUSTED_ORIGINS: " http://a.test , ,http://b.test,",
      HUB_WORKSPACES_ROOT: "C:/ws",
      HUB_EDITOR: "vim",
      HUB_SECOND_BRAIN: "C:/brain",
      CODEX_HOME: join(tmp, "codex-home"),
      HUB_CLAUDE_CREDENTIALS: join(tmp, "creds.json"),
      HUB_CLAUDE_STATE: join(tmp, "state.json"),
      HUB_CLAUDE_PROJECTS_DIR: join(tmp, "projects"),
      HUB_CLAUDE_USAGE_URL: "http://localhost:9999/usage",
      APPDATA: join(tmp, "roaming"),
    });
    assert.equal(config.host, "127.0.0.2");
    assert.equal(config.port, 4999);
    assert.equal(config.sharePort, 4998);
    assert.equal(config.shareHost, "127.0.0.3");
    assert.equal(config.homeDir, home);
    assert.equal(config.dataDir, join(tmp, "custom-data"));
    assert.equal(config.emptyTtlMs, 2 * 3_600_000);
    assert.equal(config.ngrokBin, "C:/tools/ngrok.exe");
    assert.deepEqual(config.ngrokArgsPrefix, ["--flag", 5, "x"]);
    assert.equal(config.resourceDir, resource);
    assert.equal(config.staticDir, join(resource, "ui"));
    assert.equal(config.mcpEntry, join(resource, "mcp.cjs"));
    assert.equal(config.shellDir, join(resource, "shell"));
    assert.equal(config.delegationEnabled, true);
    assert.equal(config.previewMode, true);
    assert.equal(config.claudeBin, "claude-custom");
    assert.deepEqual(config.claudeArgsPrefix, ["a", "b"]);
    assert.equal(config.codexBin, "codex-custom");
    assert.deepEqual(config.codexArgsPrefix, ["c"]);
    assert.deepEqual(config.urlOpener, ["opener", "--x"]);
    assert.deepEqual(config.trustedOrigins, ["http://a.test", "http://b.test"]);
    assert.equal(config.workspacesRoot, "C:/ws");
    assert.equal(config.editorCommand, "vim");
    assert.equal(config.secondBrainRoot, "C:/brain");
    assert.equal(config.codexHome, join(tmp, "codex-home"));
    assert.equal(config.claudeCredentialsPath, join(tmp, "creds.json"));
    assert.equal(config.claudeStatePath, join(tmp, "state.json"));
    assert.equal(config.claudeProjectsDir, join(tmp, "projects"));
    assert.equal(config.claudeUsageUrl, "http://localhost:9999/usage");
    if (process.platform === "win32") assert.equal(config.claudeDesktopConfigPath, join(tmp, "roaming", "Claude", "claude_desktop_config.json"));
  });

  it("falls back to safe defaults for blank, malformed or out-of-range values", () => {
    const config = printConfig({
      HUB_HOME: home,
      HUB_EMPTY_TTL_HOURS: "never",
      HUB_CLAUDE_ARGS_PREFIX: "{ not json",
      HUB_CODEX_ARGS_PREFIX: JSON.stringify({ not: "a list" }),
      HUB_URL_OPENER: "",
      HUB_TRUSTED_ORIGINS: "",
      HUB_CLAUDE_USAGE_URL: "https://evil.example.com/usage",
    });
    assert.equal(config.emptyTtlMs, 0);
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 4317);
    assert.equal(config.sharePort, 4318);
    assert.deepEqual(config.claudeArgsPrefix, []);
    assert.deepEqual(config.codexArgsPrefix, []);
    assert.deepEqual(config.urlOpener, []);
    assert.deepEqual(config.trustedOrigins, []);
    assert.equal(config.claudeUsageUrl, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(config.staticDir, null);
    assert.equal(config.resourceDir, null);
    assert.equal(config.delegationEnabled, false);
    assert.equal(config.previewMode, false);
    assert.equal(config.editorCommand, "code");
    assert.equal(config.claudeBin, "claude");
    const negative = printConfig({ HUB_HOME: home, HUB_EMPTY_TTL_HOURS: "-3", HUB_CLAUDE_USAGE_URL: "not a url", HUB_STATIC_DIR: "C:/static" });
    assert.equal(negative.emptyTtlMs, 0);
    assert.equal(negative.claudeUsageUrl, "https://api.anthropic.com/api/oauth/usage");
    assert.equal(negative.staticDir, "C:/static");
    const loopback = printConfig({ HUB_HOME: home, HUB_CLAUDE_USAGE_URL: "http://127.0.0.1:1234/usage" });
    assert.equal(loopback.claudeUsageUrl, "http://127.0.0.1:1234/usage");
  });

  it("picks the newest installed Codex binary under the local app data folder", { skip: process.platform !== "win32" }, () => {
    const local = join(tmp, "local-appdata");
    const bin = join(local, "OpenAI", "Codex", "bin");
    for (const [name, age] of [["old", 3600], ["new", 0], ["broken", 10]] as const) {
      mkdirSync(join(bin, name), { recursive: true });
      if (name === "broken") continue;
      const exe = join(bin, name, "codex.exe");
      writeFileSync(exe, "binary");
      const at = new Date(Date.now() - age * 1000);
      utimesSync(exe, at, at);
    }
    const found = printConfig({ HUB_HOME: home, LOCALAPPDATA: local });
    assert.equal(found.codexBin, join(bin, "new", "codex.exe"));
    const none = printConfig({ HUB_HOME: home, LOCALAPPDATA: join(tmp, "nothing-here") });
    assert.equal(none.codexBin, "codex");
    const emptyLocal = join(tmp, "empty-local");
    mkdirSync(join(emptyLocal, "OpenAI", "Codex", "bin", "no-exe-here"), { recursive: true });
    assert.equal(printConfig({ HUB_HOME: home, LOCALAPPDATA: emptyLocal }).codexBin, "codex");
    const fromHome = printConfig({ HUB_HOME: home });
    assert.equal(fromHome.codexBin, "codex");
  });

  it("uses the real home and the default data folder when nothing overrides them", () => {
    const config = printConfig({ HUB_HOME: undefined, HUB_DATA_DIR: undefined });
    assert.equal(config.homeDir, homedir());
    assert.equal(config.dataDir, join(homedir(), ".vbss-cchub"));
    assert.equal(config.dbPath, join(homedir(), ".vbss-cchub", "hub.db"));
    assert.equal(config.binDir, join(homedir(), ".vbss-cchub", "bin"));
  });

  it("reports the app version from the bundle define or from package.json", () => {
    assert.equal(printVersion("globalThis.__CCH_APP_VERSION__ = '9.8.7';"), "9.8.7");
    assert.match(printVersion(""), /^\d+\.\d+\.\d+/);
  });

  it("ignores the Claude config directory when the hub home is overridden", () => {
    assert.equal(claudeConfigDirFrom({ HUB_HOME: "C:/h", CLAUDE_CONFIG_DIR: "C:/c" }), null);
    assert.equal(claudeConfigDirFrom({ CLAUDE_CONFIG_DIR: "C:/c" }), "C:/c");
    assert.equal(claudeConfigDirFrom({ CLAUDE_CONFIG_DIR: "" }), null);
    assert.equal(claudeConfigDirFrom({}), null);
  });
});
