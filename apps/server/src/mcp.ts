import { config } from "./config.js";

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const DEFAULT_PROTOCOL = "2025-11-25";
const ANNOTATIONS_SINCE = "2025-03-26";
const TITLE_SINCE = "2025-06-18";
const MAX_TEXT_CHARS = 80_000;
const PLUGINS_TIMEOUT_MS = 1500;

type Json = Record<string, unknown>;

interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations: ToolAnnotations;
  call: (args: Json) => Promise<unknown>;
}

interface PluginState {
  id: string;
  name: string;
  enabled: boolean;
  tools: string[];
}

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Json;
}

const base = (process.env.HUB_URL ?? `http://127.0.0.1:${config.port}`).replace(/\/$/, "");

const originClientHint = (): "claude-code" | "codex" | undefined => {
  if (process.env.CODEX_SANDBOX || process.env.CODEX_SANDBOX_NETWORK_DISABLED) return "codex";
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  return undefined;
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const originFields = (): { originPid: number; originClient?: string; originEnvSessionId?: string } => ({
  originPid: process.ppid,
  originClient: originClientHint(),
  originEnvSessionId: originClientHint() === "codex" ? undefined : asString(process.env.CLAUDE_CODE_SESSION_ID),
});

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

const writes = (destructive: boolean, idempotent: boolean, openWorld = false): ToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: openWorld,
});

async function http(method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
    throw new Error(`hub unreachable at ${base}: ${cause}`);
  }
  const text = await res.text();
  const json: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json;
}

const query = (params: Record<string, unknown>): string => {
  const pairs = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return pairs.length > 0 ? `?${pairs.join("&")}` : "";
};

const taskPath = (args: Json, suffix = ""): string => {
  const id = asString(args.taskId);
  if (!id) throw new Error("taskId is required");
  return `/delegation/tasks/${encodeURIComponent(id)}${suffix}`;
};

const objectSchema = (properties: Json, required: string[] = []): Json => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const TOOLS: ToolDefinition[] = [
  {
    name: "hub_overview",
    title: "Hub overview",
    annotations: READ_ONLY,
    description:
      "One-call picture of everything running on this machine: Claude Code sessions (with subagents), Claude Desktop, Codex app and CLI sessions, delegated tasks in flight or needing attention, latest reports and the known workspaces. Start here.",
    inputSchema: objectSchema({}),
    call: () => http("GET", "/delegation/overview"),
  },
  {
    name: "hub_workspaces",
    title: "List workspaces",
    annotations: READ_ONLY,
    description:
      "List the workspaces the hub knows (from the .code-workspace folder) with the local path of every repository. Use it to resolve where a project lives instead of asking.",
    inputSchema: objectSchema({}),
    call: () => http("GET", "/delegation/workspaces"),
  },
  {
    name: "hub_delegate",
    title: "Delegate a task",
    annotations: writes(false, false, true),
    description:
      "Delegate work to a headless Claude Code (default) or Codex run inside a workspace. The run starts in the workspace context folder with every repo of that workspace attached, so the agent sees the workspace CLAUDE.md, skills and all repos. Runs follow the hub's Autonomy setting (full by default: no permission prompts, full shell; auto: Claude auto mode with permission prompts off), so do NOT pass permissionMode or sandbox unless you want plan mode; any other mode follows that setting. Each task gets a reserved port range (env HUB_PORT_BASE..HUB_PORT_END) for any dev server it starts. Returns the task id to follow with hub_task.",
    inputSchema: objectSchema(
      {
        workspace: { type: "string", description: "Workspace name as listed by hub_workspaces" },
        prompt: { type: "string", description: "What to do. Be explicit about the repo and the definition of done." },
        repo: { type: "string", description: "Optional repo name of that workspace to focus the task on" },
        runner: { type: "string", enum: ["claude", "codex"], description: "Executor, default claude" },
        model: { type: "string", description: "Optional model override; omit to keep the runner default" },
        permissionMode: {
          type: "string",
          enum: ["acceptEdits", "plan", "dontAsk", "manual"],
          description: "Only plan is honoured; with the hub autonomy at full every other value runs as bypassPermissions, at auto as auto mode. Omit it.",
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Codex sandbox, default workspace-write",
        },
        isolation: {
          type: "string",
          enum: ["shared", "worktree"],
          description:
            "Omit to let the hub decide: worktree when the repo already has a task running in the shared checkout, shared otherwise. Pass repo so the hub can isolate. worktree = the task commits on its own branch and you merge with hub_task_merge.",
        },
        title: { type: "string", description: "Optional short title; defaults to the first prompt line" },
      },
      ["workspace", "prompt"],
    ),
    call: (args) => http("POST", "/delegation/tasks", { ...args, ...originFields(), source: "mcp" }),
  },
  {
    name: "hub_task",
    title: "Get a delegated task",
    annotations: READ_ONLY,
    description:
      "Get a delegated task with all its runs (results, errors, session id) and reports. Worktree tasks include worktree.hint telling you whether to merge or discard.",
    inputSchema: objectSchema({ taskId: { type: "string", description: "Full task id or a unique prefix (8 chars is enough)" } }, ["taskId"]),
    call: (args) => http("GET", taskPath(args)),
  },
  {
    name: "hub_tasks",
    title: "List delegated tasks",
    annotations: READ_ONLY,
    description: "List delegated tasks, most recent first. Filter by status: pending, running, completed, attention, failed, interrupted, cancelled.",
    inputSchema: objectSchema({ status: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }),
    call: (args) => http("GET", `/delegation/tasks${query({ status: args.status, limit: args.limit })}`),
  },
  {
    name: "hub_continue",
    title: "Continue a delegated task",
    annotations: writes(false, false, true),
    description: "Send a follow-up prompt to a delegated task; it resumes the same Claude/Codex session.",
    inputSchema: objectSchema(
      { taskId: { type: "string", description: "Full task id or a unique prefix (8 chars is enough)" }, prompt: { type: "string" }, model: { type: "string" } },
      ["taskId", "prompt"],
    ),
    call: (args) => http("POST", taskPath(args, "/continue"), { prompt: args.prompt, model: args.model, ...originFields() }),
  },
  {
    name: "hub_cancel",
    title: "Cancel a delegated run",
    annotations: writes(true, true),
    description: "Cancel the in-flight run of a delegated task.",
    inputSchema: objectSchema({ taskId: { type: "string", description: "Full task id or a unique prefix (8 chars is enough)" } }, ["taskId"]),
    call: (args) => http("POST", taskPath(args, "/cancel")),
  },
  {
    name: "hub_task_archive",
    title: "Archive a delegated task",
    annotations: writes(false, true),
    description: "Archive a settled delegated task so it drops out of the default task lists and overview; pass unarchive to bring it back. Running or pending tasks cannot be archived.",
    inputSchema: objectSchema({ taskId: { type: "string", description: "Full task id or a unique prefix (8 chars is enough)" }, unarchive: { type: "boolean" } }, ["taskId"]),
    call: (args) => http("POST", taskPath(args, args.unarchive === true ? "/unarchive" : "/archive")),
  },
  {
    name: "hub_task_merge",
    title: "Merge or discard a task worktree",
    annotations: writes(true, false),
    description:
      "Merge a worktree task's branch into its base branch inside the original checkout (git merge --no-ff). Answers a conflict without touching the checkout. Pass discard: true to remove the worktree and its branch instead (do this after a successful merge, or to throw the work away).",
    inputSchema: objectSchema(
      {
        taskId: { type: "string", description: "Full task id or a unique prefix (8 chars is enough)" },
        discard: { type: "boolean", description: "Remove the worktree and its branch instead of merging" },
      },
      ["taskId"],
    ),
    call: (args) => http("POST", taskPath(args, args.discard === true ? "/worktree/discard" : "/merge")),
  },
  {
    name: "hub_report",
    title: "Report to the hub",
    annotations: writes(false, false),
    description:
      "Report progress, a result, a blocker or a note to the hub so any other conversation (or the human) can see it. Attach it to a task or a session when you have the id. When you omit taskId, it defaults to the HUB_TASK_ID of the delegated run you are in, so your report lands on the right task.",
    inputSchema: objectSchema(
      {
        text: { type: "string" },
        kind: { type: "string", enum: ["progress", "result", "blocked", "note"] },
        taskId: { type: "string", description: "Defaults to HUB_TASK_ID when omitted inside a delegated run" },
        sessionId: { type: "string" },
        workspace: { type: "string" },
        source: { type: "string", description: "Who is reporting, e.g. claude-code, codex, gpt-live" },
      },
      ["text"],
    ),
    call: (args) => {
      const taskId = asString(args.taskId) ?? asString(process.env.HUB_TASK_ID);
      return http("POST", "/delegation/reports", { source: "mcp", ...args, taskId });
    },
  },
  {
    name: "hub_reports",
    title: "Read reports",
    annotations: READ_ONLY,
    description: "Read the latest reports (all, or the ones attached to a task).",
    inputSchema: objectSchema({ taskId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }),
    call: (args) => http("GET", `/delegation/reports${query({ taskId: args.taskId, limit: args.limit })}`),
  },
  {
    name: "hub_sessions",
    title: "List sessions",
    annotations: READ_ONLY,
    description:
      "List Claude Code sessions tracked by the hub (status, cwd, model, running subagents) and Codex sessions found on this machine.",
    inputSchema: objectSchema({}),
    call: async () => ({
      claudeCode: await http("GET", "/api/sessions"),
      codex: await http("GET", "/api/codex/sessions"),
    }),
  },
  {
    name: "hub_focus",
    title: "Focus a session window",
    annotations: writes(false, true),
    description: "Bring the window of a Claude Code session to the front on the desktop.",
    inputSchema: objectSchema({ sessionId: { type: "string" } }, ["sessionId"]),
    call: (args) => {
      const id = asString(args.sessionId);
      if (!id) throw new Error("sessionId is required");
      return http("POST", `/api/sessions/${encodeURIComponent(id)}/focus`);
    },
  },
  {
    name: "hub_open_workspace",
    title: "Open a workspace in the editor",
    annotations: writes(false, true),
    description: "Open a workspace in the configured editor on the desktop.",
    inputSchema: objectSchema({ workspace: { type: "string" } }, ["workspace"]),
    call: (args) => {
      const name = asString(args.workspace);
      if (!name) throw new Error("workspace is required");
      return http("POST", `/delegation/workspaces/${encodeURIComponent(name)}/open`);
    },
  },
  {
    name: "hub_create_workspace",
    title: "Create a workspace",
    annotations: writes(false, false),
    description: "Create a workspace: writes <name>.code-workspace in the workspaces root with the given repo folders and seeds a context folder with a CLAUDE.md.",
    inputSchema: objectSchema(
      { name: { type: "string" }, repos: { type: "array", items: { type: "string" }, description: "Absolute repo paths" } },
      ["name", "repos"],
    ),
    call: (args) => http("POST", "/delegation/workspaces", { name: args.name, repos: args.repos }),
  },
  {
    name: "hub_session_live",
    title: "Look inside a session",
    annotations: READ_ONLY,
    description:
      "Look inside a Claude Code session tracked by the hub: the tail of its transcript (user prompts, assistant text, tool calls) and every subagent with what it is doing right now.",
    inputSchema: objectSchema({ sessionId: { type: "string" }, limit: { type: "integer", minimum: 5, maximum: 200 } }, ["sessionId"]),
    call: (args) => {
      const id = asString(args.sessionId);
      if (!id) throw new Error("sessionId is required");
      return http("GET", `/api/sessions/${encodeURIComponent(id)}/live${query({ limit: args.limit })}`);
    },
  },
  {
    name: "hub_task_events",
    title: "Delegated task log",
    annotations: READ_ONLY,
    description: "Streamed log of a delegated task: assistant text, tool calls and status changes for every run, in order.",
    inputSchema: objectSchema({ taskId: { type: "string", description: "Full task id or a unique prefix (8 chars is enough)" } }, ["taskId"]),
    call: (args) => http("GET", taskPath(args, "/events")),
  },
  {
    name: "hub_delete_workspace",
    title: "Delete a workspace",
    annotations: writes(true, true),
    description: "Delete a workspace: removes <name>.code-workspace from the workspaces root; deleteContext also removes the <name>/ context folder.",
    inputSchema: objectSchema({ workspace: { type: "string" }, deleteContext: { type: "boolean" } }, ["workspace"]),
    call: (args) => {
      const name = asString(args.workspace);
      if (!name) throw new Error("workspace is required");
      return http("DELETE", `/delegation/workspaces/${encodeURIComponent(name)}${args.deleteContext === true ? "?context=1" : ""}`);
    },
  },
  {
    name: "hub_brain_today",
    title: "Today's second brain",
    annotations: READ_ONLY,
    description:
      "Read today's second-brain context when the hub is linked to a vault: today's diary, the hub source (delegations and reports of the day) and the Claude session trail.",
    inputSchema: objectSchema({}),
    call: () => http("GET", "/delegation/brain/today"),
  },
  {
    name: "hub_shares",
    title: "List share links",
    annotations: READ_ONLY,
    description:
      "List the share links of this hub (external collaborators asking the owner Claude): label, scope, workspace, state, usage and links (local, LAN, public through the tunnel).",
    inputSchema: objectSchema({}),
    call: () => http("GET", "/delegation/shares"),
  },
  {
    name: "hub_share_create",
    title: "Create a share link",
    annotations: writes(false, false, true),
    description:
      "Create a share link so another person and their assistant can ask the owner Claude and delegate work inside a workspace of this hub, at a chosen trust level. Returns the links; send the LAN or public link (it carries the key) to the collaborator. Optionally pin a session so answers continue it (forked).",
    inputSchema: objectSchema(
      {
        label: { type: "string", description: "Who or what this share is for, e.g. Will · nexus doubts" },
        workspace: { type: "string" },
        repo: { type: "string" },
        trust: { type: "string", enum: ["low", "medium", "high", "total"], description: "low = read-only answers and plans; medium = edits files, no shell; high = edits and runs commands except destructive/publish/deploy; total = no blocks" },
        sessionId: { type: "string", description: "Answers continue this session (forked)" },
        note: { type: "string", description: "Shown to the collaborator assistant" },
        expiresInHours: { type: "number", description: "Default 24; 0 for no expiry" },
        maxPerHour: { type: "number" },
      },
      ["workspace"],
    ),
    call: (args) => http("POST", "/delegation/shares", { ...args, expiresInHours: args.expiresInHours === 0 ? null : args.expiresInHours }),
  },
  {
    name: "hub_share_update",
    title: "Pause, resume or revoke a share",
    annotations: writes(true, true),
    description: "Pause, resume, revoke or relabel a share.",
    inputSchema: objectSchema(
      { shareId: { type: "string" }, paused: { type: "boolean" }, revoke: { type: "boolean" }, label: { type: "string" }, note: { type: "string" } },
      ["shareId"],
    ),
    call: (args) => {
      const { shareId, ...patch } = args;
      return http("PATCH", `/delegation/shares/${encodeURIComponent(String(shareId))}`, patch);
    },
  },
  {
    name: "hub_share_activity",
    title: "Share activity",
    annotations: READ_ONLY,
    description: "Recent questions and implementation requests that arrived through shares, with answers and status.",
    inputSchema: objectSchema({ limit: { type: "number" } }),
    call: (args) => http("GET", `/delegation/shares/activity${query({ limit: args.limit })}`),
  },
  {
    name: "hub_claim",
    title: "Claim files you are editing",
    annotations: writes(false, false),
    description:
      "Tell the hub which files you are editing in a repo so delegated tasks and other agents keep off them. Advisory only; expires after ttlMinutes (default 240). Pass release: true with claimId to drop a claim early.",
    inputSchema: objectSchema({
      workspace: { type: "string", description: "Workspace name as listed by hub_workspaces" },
      repo: { type: "string", description: "Repo name of that workspace" },
      paths: { type: "array", items: { type: "string" }, description: "Repo-relative paths or globs you are editing" },
      note: { type: "string" },
      ttlMinutes: { type: "number", description: "Default 240, max 1440" },
      release: { type: "boolean", description: "Pass true with claimId to drop a claim early instead of creating one" },
      claimId: { type: "string" },
    }),
    call: (args) => {
      if (args.release === true) {
        const id = asString(args.claimId);
        if (!id) throw new Error("claimId is required to release a claim");
        return http("DELETE", `/api/claims/${encodeURIComponent(id)}`);
      }
      return http("POST", "/api/claims", { ...args, ...originFields() });
    },
  },
  {
    name: "hub_tunnel",
    title: "Share endpoint and tunnel",
    annotations: writes(false, true, true),
    description:
      "The share endpoint (LAN url) and the ngrok tunnel: action status, start (installs ngrok on first use and returns the public url) or stop.",
    inputSchema: objectSchema({ action: { type: "string", enum: ["status", "start", "stop"] } }),
    call: (args) =>
      args.action === "start"
        ? http("POST", "/delegation/tunnel/start")
        : args.action === "stop"
          ? http("POST", "/delegation/tunnel/stop")
          : http("GET", "/delegation/tunnel"),
  },
];

const isPluginState = (value: unknown): value is PluginState => {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.enabled === "boolean" &&
    Array.isArray(item.tools) &&
    item.tools.every((tool) => typeof tool === "string")
  );
};

async function pluginStates(): Promise<PluginState[] | null> {
  try {
    const res = await fetch(`${base}/delegation/plugins`, { signal: AbortSignal.timeout(PLUGINS_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    return Array.isArray(json) && json.every(isPluginState) ? json : null;
  } catch {
    return null;
  }
}

const offPluginOf = (states: PluginState[] | null, tool: string): PluginState | null => {
  const owner = states?.find((plugin) => plugin.tools.includes(tool));
  return owner && !owner.enabled ? owner : null;
};

const availableTools = (states: PluginState[] | null): ToolDefinition[] => TOOLS.filter((tool) => offPluginOf(states, tool.name) === null);

const pluginOffMessage = (plugin: PluginState): string => `The ${plugin.name} plugin is off in CC Hub (Settings > Plugins)`;

const instructionsFor = (tools: readonly ToolDefinition[]): string => {
  const has = (name: string): boolean => tools.some((tool) => tool.name === name);
  const parts = [
    "CC Hub is the machine-local hub where every agent arrives and reports.",
    "Call hub_overview first to see what is running. Use hub_workspaces to resolve repo paths; never ask the user where a project lives.",
  ];
  if (has("hub_delegate") && has("hub_report")) {
    parts.push("Delegate long work with hub_delegate (workspace + prompt), follow it with hub_task, steer it with hub_continue, and leave a trail with hub_report so other conversations can pick it up.");
  } else if (has("hub_delegate")) {
    parts.push("Delegate long work with hub_delegate (workspace + prompt), follow it with hub_task and steer it with hub_continue.");
  } else if (has("hub_report")) {
    parts.push("Leave a trail with hub_report so other conversations can pick it up.");
  }
  return parts.join(" ");
};

let negotiatedProtocol = DEFAULT_PROTOCOL;

const toolListing = (tool: ToolDefinition, protocol: string): Json => {
  const listed: Json = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  if (protocol >= TITLE_SINCE) listed.title = tool.title;
  if (protocol >= ANNOTATIONS_SINCE) listed.annotations = { title: tool.title, ...tool.annotations };
  return listed;
};

const respond = (id: RpcRequest["id"], result: unknown): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

const fail = (id: RpcRequest["id"], code: number, message: string): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
};

const asText = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n…(truncated)` : text;
};

async function handle(message: RpcRequest): Promise<void> {
  const { id, method, params } = message;
  if (method === undefined) return;
  if (id === undefined || id === null) return;
  switch (method) {
    case "initialize": {
      const requested = asString(params?.protocolVersion);
      negotiatedProtocol = requested && PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL;
      respond(id, {
        protocolVersion: negotiatedProtocol,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "vbss-cchub", version: "1" },
        instructions: instructionsFor(availableTools(await pluginStates())),
      });
      return;
    }
    case "ping":
      respond(id, {});
      return;
    case "tools/list":
      respond(id, {
        tools: availableTools(await pluginStates()).map((tool) => toolListing(tool, negotiatedProtocol)),
      });
      return;
    case "tools/call": {
      const name = asString(params?.name);
      const tool = TOOLS.find((item) => item.name === name);
      if (!tool) {
        fail(id, -32602, `unknown tool: ${name ?? "(none)"}`);
        return;
      }
      const offPlugin = offPluginOf(await pluginStates(), tool.name);
      if (offPlugin) {
        respond(id, { content: [{ type: "text", text: pluginOffMessage(offPlugin) }], isError: true });
        return;
      }
      const args = (params?.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Json;
      try {
        const value = await tool.call(args);
        respond(id, { content: [{ type: "text", text: asText(value) }], isError: false });
      } catch (err) {
        respond(id, {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
      return;
    }
    case "resources/list":
      respond(id, { resources: [] });
      return;
    case "prompts/list":
      respond(id, { prompts: [] });
      return;
    default:
      fail(id, -32601, `method not found: ${method}`);
  }
}

let buffer = "";
let inFlight = 0;
let stdinClosed = false;

const exitWhenDrained = (): void => {
  if (stdinClosed && inFlight === 0) process.exit(0);
};

const dispatch = (line: string): void => {
  let message: RpcRequest;
  try {
    message = JSON.parse(line) as RpcRequest;
  } catch {
    fail(null, -32700, "parse error");
    return;
  }
  inFlight += 1;
  void handle(message)
    .catch((err: unknown) => {
      fail(message.id ?? null, -32603, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      inFlight -= 1;
      exitWhenDrained();
    });
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (line.length > 0) dispatch(line);
  }
});
process.stdin.on("end", () => {
  if (buffer.trim().length > 0) dispatch(buffer.trim());
  buffer = "";
  stdinClosed = true;
  exitWhenDrained();
});
