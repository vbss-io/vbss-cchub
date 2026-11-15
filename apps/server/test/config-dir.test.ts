import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fixtures, serverDir } from "./helpers.js";

const tmp = mkdtempSync(join(tmpdir(), "cch-cfgdir-"));
const home = join(tmp, "home");
const configDir = join(tmp, "claude-alt");
mkdirSync(home, { recursive: true });
process.env.HUB_HOME = home;
process.env.HUB_DATA_DIR = join(tmp, "data");
delete process.env.HUB_RESOURCE_DIR;

interface PrintedConfig {
  homeDir: string;
  claudeHome: string;
  claudeConfigPath: string;
  claudeStatePath: string;
  claudeCredentialsPath: string;
  claudeProjectsDir: string;
}

function printedConfig(extra: Record<string, string>): PrintedConfig {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  for (const key of ["HUB_HOME", "CLAUDE_CONFIG_DIR", "HUB_CLAUDE_CREDENTIALS", "HUB_CLAUDE_STATE", "HUB_CLAUDE_PROJECTS_DIR"]) if (!(key in extra)) delete env[key];
  const out = execFileSync(process.execPath, ["--import", "tsx", join(fixtures, "print-config.ts")], { cwd: serverDir, env, encoding: "utf8" });
  return JSON.parse(out) as PrintedConfig;
}

describe("CLAUDE_CONFIG_DIR", () => {
  it("resolves the Claude home, .claude.json, credentials and projects from it", () => {
    const config = printedConfig({ CLAUDE_CONFIG_DIR: configDir });
    assert.equal(config.homeDir, home);
    assert.equal(config.claudeHome, configDir);
    assert.equal(config.claudeConfigPath, join(configDir, ".claude.json"));
    assert.equal(config.claudeStatePath, join(configDir, ".claude.json"));
    assert.equal(config.claudeCredentialsPath, join(configDir, ".credentials.json"));
    assert.equal(config.claudeProjectsDir, join(configDir, "projects"));
  });

  it("keeps ~/.claude and ~/.claude.json without it", () => {
    const config = printedConfig({});
    assert.equal(config.claudeHome, join(home, ".claude"));
    assert.equal(config.claudeConfigPath, join(home, ".claude.json"));
    assert.equal(config.claudeProjectsDir, join(home, ".claude", "projects"));
  });

  it("lets the HUB_* overrides win over it", () => {
    const hubHome = join(tmp, "hub-home");
    const pinned = printedConfig({ CLAUDE_CONFIG_DIR: configDir, HUB_HOME: hubHome });
    assert.equal(pinned.claudeHome, join(hubHome, ".claude"));
    assert.equal(pinned.claudeConfigPath, join(hubHome, ".claude.json"));
    const explicit = printedConfig({
      CLAUDE_CONFIG_DIR: configDir,
      HUB_CLAUDE_CREDENTIALS: join(tmp, "creds.json"),
      HUB_CLAUDE_STATE: join(tmp, "state.json"),
      HUB_CLAUDE_PROJECTS_DIR: join(tmp, "projects"),
    });
    assert.equal(explicit.claudeCredentialsPath, join(tmp, "creds.json"));
    assert.equal(explicit.claudeStatePath, join(tmp, "state.json"));
    assert.equal(explicit.claudeProjectsDir, join(tmp, "projects"));
    assert.equal(explicit.claudeConfigPath, join(configDir, ".claude.json"));
  });
});

describe("live transcript lookup", () => {
  it("guesses the transcript inside the configured projects dir", async () => {
    const { guessTranscriptIn } = await import("../src/live.js");
    const projects = join(configDir, "projects");
    const cwd = "C:\\Users\\me\\Repo";
    const dir = join(projects, "C--Users-me-Repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), "{}\n");
    assert.equal(guessTranscriptIn(projects, cwd, "s1"), join(dir, "s1.jsonl"));
    assert.equal(guessTranscriptIn(join(home, ".claude", "projects"), cwd, "s1"), null);
  });
});

after(async () => {
  const { db } = await import("../src/db.js");
  db.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
