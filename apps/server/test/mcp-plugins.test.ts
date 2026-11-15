import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { DelegationFeatures } from "../src/delegation-types.js";
import type { PluginView } from "../src/plugins/types.js";
import { freePort, makeSandbox, sandboxEnv, serverDir } from "./helpers.js";

const dataDir = mkdtempSync(join(tmpdir(), "cch-mcp-plugins-"));
process.env.HUB_DATA_DIR = dataDir;

interface RpcReply {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError: boolean;
}

interface Seen {
  method: string;
  path: string;
}

const box = makeSandbox("cch-mcp-plugins-box-");
const allOn: DelegationFeatures = {
  daily: true,
  trail: true,
  usage: true,
  limits: true,
  tasks: true,
  flow: true,
  delegated: true,
  workspaces: true,
  reports: true,
  share: true,
  widget: true,
};

let views: (features: DelegationFeatures) => PluginView[];
let registryTools: string[];
let closeDb: () => void;
let fake: Server;
let fakeUrl: string;
let features: DelegationFeatures = allOn;
let pluginsStatus = 200;
let seen: Seen[] = [];

const runMcp = (hubUrl: string, messages: Record<string, unknown>[]): Promise<RpcReply[]> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(serverDir, "src", "mcp.ts")], {
      cwd: serverDir,
      env: sandboxEnv(box, { HUB_URL: hubUrl }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.on("error", reject);
    child.on("close", () => {
      const replies = out
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as RpcReply);
      resolve(replies.sort((a, b) => a.id - b.id));
    });
    child.stdin.end(messages.map((message, index) => JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...message })).join("\n") + "\n");
  });

const listTools = async (hubUrl: string): Promise<{ names: string[]; instructions: string }> => {
  const [init, list] = await runMcp(hubUrl, [
    { method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { method: "tools/list" },
  ]);
  const instructions = String((init?.result as { instructions?: unknown } | undefined)?.instructions ?? "");
  const names = ((list?.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((tool) => tool.name);
  return { names, instructions };
};

const callTool = async (hubUrl: string, name: string, args: Record<string, unknown>): Promise<ToolResult> => {
  const [reply] = await runMcp(hubUrl, [{ method: "tools/call", params: { name, arguments: args } }]);
  return reply?.result as unknown as ToolResult;
};

const citedTools = (instructions: string): string[] => [...new Set(instructions.match(/hub_[a-z_]+/g) ?? [])];

const ORIGINAL_INSTRUCTIONS = [
  "CC Hub is the machine-local hub where every agent arrives and reports.",
  "Call hub_overview first to see what is running. Use hub_workspaces to resolve repo paths; never ask the user where a project lives.",
  "Delegate long work with hub_delegate (workspace + prompt), follow it with hub_task, steer it with hub_continue, and leave a trail with hub_report so other conversations can pick it up.",
].join(" ");

const SHARE_AND_WORKSPACE_TOOLS = ["hub_shares", "hub_share_create", "hub_share_update", "hub_share_activity", "hub_tunnel", "hub_open_workspace", "hub_create_workspace", "hub_delete_workspace"];

before(async () => {
  const { SERVER_PLUGINS } = await import("../src/plugins/index.js");
  const { pluginViews } = await import("../src/plugins/registry.js");
  const { db } = await import("../src/db.js");
  closeDb = () => db.close();
  views = (flags) => pluginViews(SERVER_PLUGINS, flags);
  registryTools = SERVER_PLUGINS.flatMap((plugin) => [...plugin.tools]);
  const port = await freePort();
  fakeUrl = `http://127.0.0.1:${port}`;
  fake = createServer((req, res) => {
    const path = req.url ?? "/";
    seen.push({ method: req.method ?? "GET", path });
    res.setHeader("content-type", "application/json");
    if (path === "/delegation/plugins") {
      res.statusCode = pluginsStatus;
      res.end(pluginsStatus === 200 ? JSON.stringify(views(features)) : JSON.stringify({ error: "boom" }));
      return;
    }
    res.end(JSON.stringify({ ok: true, path }));
  });
  await new Promise<void>((resolve) => fake.listen(port, "127.0.0.1", resolve));
});

beforeEach(() => {
  features = allOn;
  pluginsStatus = 200;
  seen = [];
});

after(async () => {
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  closeDb();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(box.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("mcp tools follow the hub plugins", () => {
  it("lists all 25 tools, the same set as the registry, with every plugin on", async () => {
    const { names, instructions } = await listTools(fakeUrl);
    assert.equal(names.length, 25);
    assert.deepEqual([...names].sort(), [...registryTools].sort());
    assert.equal(instructions, ORIGINAL_INSTRUCTIONS);
  });

  it("drops the Share and Workspaces tools when those plugins are off", async () => {
    features = { ...allOn, share: false, workspaces: false };
    const { names, instructions } = await listTools(fakeUrl);
    assert.equal(names.length, 17);
    for (const tool of SHARE_AND_WORKSPACE_TOOLS) assert.equal(names.includes(tool), false, tool);
    for (const tool of citedTools(instructions)) assert.ok(names.includes(tool), `instructions cite ${tool}`);
    assert.doesNotMatch(instructions, /hub_share|hub_tunnel|hub_(open|create|delete)_workspace/);
  });

  it("only cites available tools in the instructions", async () => {
    features = { ...allOn, delegated: false };
    const withoutDelegated = await listTools(fakeUrl);
    assert.doesNotMatch(withoutDelegated.instructions, /hub_delegate|hub_task|hub_continue/);
    assert.match(withoutDelegated.instructions, /hub_report/);
    features = { ...allOn, reports: false };
    const withoutReports = await listTools(fakeUrl);
    assert.doesNotMatch(withoutReports.instructions, /hub_report/);
    assert.match(withoutReports.instructions, /hub_delegate/);
    features = { ...allOn, delegated: false, reports: false };
    const coreOnly = await listTools(fakeUrl);
    assert.deepEqual(citedTools(coreOnly.instructions), ["hub_overview", "hub_workspaces"]);
    for (const result of [withoutDelegated, withoutReports, coreOnly]) {
      for (const tool of citedTools(result.instructions)) assert.ok(result.names.includes(tool), `instructions cite ${tool}`);
    }
  });

  it("fails open with all tools when the hub does not answer /delegation/plugins", async () => {
    pluginsStatus = 500;
    const broken = await listTools(fakeUrl);
    assert.equal(broken.names.length, 25);
    assert.equal(broken.instructions, ORIGINAL_INSTRUCTIONS);
    const closedPort = await freePort();
    const unreachable = await listTools(`http://127.0.0.1:${closedPort}`);
    assert.equal(unreachable.names.length, 25);
    assert.deepEqual([...unreachable.names].sort(), [...registryTools].sort());
    assert.equal(unreachable.instructions, ORIGINAL_INSTRUCTIONS);
  });

  it("refuses a tool of a plugin that is off without calling its route", async () => {
    features = { ...allOn, share: false };
    const result = await callTool(fakeUrl, "hub_share_create", { workspace: "pilot" });
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "The Share plugin is off in CC Hub (Settings > Plugins)");
    assert.deepEqual(seen, [{ method: "GET", path: "/delegation/plugins" }]);
    features = { ...allOn, daily: false };
    seen = [];
    const brain = await callTool(fakeUrl, "hub_brain_today", {});
    assert.equal(brain.content[0]?.text, "The Today plugin is off in CC Hub (Settings > Plugins)");
    assert.deepEqual(seen, [{ method: "GET", path: "/delegation/plugins" }]);
  });

  it("calls the route of a plugin that is on", async () => {
    const result = await callTool(fakeUrl, "hub_shares", {});
    assert.equal(result.isError, false);
    assert.deepEqual(seen, [
      { method: "GET", path: "/delegation/plugins" },
      { method: "GET", path: "/delegation/shares" },
    ]);
  });

  it("still calls the route when the plugin list is unavailable", async () => {
    pluginsStatus = 500;
    const result = await callTool(fakeUrl, "hub_share_create", { workspace: "pilot" });
    assert.equal(result.isError, false);
    assert.deepEqual(seen, [
      { method: "GET", path: "/delegation/plugins" },
      { method: "POST", path: "/delegation/shares" },
    ]);
  });
});
