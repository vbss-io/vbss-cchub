import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

function record(kind, argv) {
  const log = process.env.FAKE_CLI_LOG;
  if (!log) return;
  const env = { HOME: process.env.HOME ?? null, USERPROFILE: process.env.USERPROFILE ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, CODEX_HOME: process.env.CODEX_HOME ?? null };
  appendFileSync(log, `${JSON.stringify({ kind, argv, env })}\n`);
}

function positionals(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-s" || args[index] === "--scope") index += 1;
    else out.push(args[index]);
  }
  return out;
}

function claudeJsonPath() {
  return process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json");
}

function claude(argv) {
  const path = claudeJsonPath();
  const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const servers = state.mcpServers ?? {};
  const [, command, ...rest] = argv;
  const [name, json] = positionals(rest);
  if (command === "add-json") {
    if (name in servers) fail(`MCP server ${name} already exists in user config`);
    servers[name] = JSON.parse(json);
  } else if (command === "remove") {
    if (!(name in servers)) fail(`No user-scoped MCP server found with name: ${name}`);
    delete servers[name];
  } else fail(`unknown command ${command}`);
  state.mcpServers = servers;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

const CODEX_BLOCK = /\n?\[mcp_servers\.cchub\][\s\S]*?(?=\n\[(?!mcp_servers\.cchub)|\s*$)/;

function codex(argv) {
  const path = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const [, command, name, ...rest] = argv;
  if (name !== "cchub") fail(`fake codex only knows cchub, got ${name}`);
  const present = /^\[mcp_servers\.cchub\]/m.test(text);
  if (command === "remove") {
    if (!present) fail(`No MCP server named '${name}' found.`);
    writeFileSync(path, text.replace(CODEX_BLOCK, ""));
    return;
  }
  if (command !== "add") fail(`unknown command ${command}`);
  const split = rest.indexOf("--");
  const flags = rest.slice(0, split);
  const [launcher, ...args] = rest.slice(split + 1);
  const env = [];
  for (let index = 0; index < flags.length; index += 1) if (flags[index] === "--env") env.push(flags[(index += 1)]);
  const lines = [`[mcp_servers.${name}]`, `command = ${JSON.stringify(launcher)}`, `args = [${args.map((arg) => JSON.stringify(arg)).join(", ")}]`];
  if (env.length > 0) {
    lines.push("", `[mcp_servers.${name}.env]`);
    for (const pair of env) {
      const at = pair.indexOf("=");
      lines.push(`${pair.slice(0, at)} = ${JSON.stringify(pair.slice(at + 1))}`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${text.replace(CODEX_BLOCK, "").trimEnd()}\n\n${lines.join("\n")}\n`);
}

export function runMcpCli(kind, argv) {
  record(kind, argv);
  if (process.env.FAKE_CLI_FAIL === "1") fail("simulated failure");
  if (kind === "claude") claude(argv);
  else codex(argv);
}
