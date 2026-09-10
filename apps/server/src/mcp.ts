import { config } from "./config.js";

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const DEFAULT_PROTOCOL = "2025-06-18";
const MAX_TEXT_CHARS = 80_000;

type Json = Record<string, unknown>;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Json;
  call: (args: Json) => Promise<unknown>;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Json;
}

const base = (process.env.HUB_URL ?? `http://127.0.0.1:${config.port}`).replace(/\/$/, "");

const originClientHint = (): "claude-code" | "codex" | undefined => {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (process.env.CODEX_SANDBOX || process.env.CODEX_SANDBOX_NETWORK_DISABLED) return "codex";
  return undefined;
};

const originFields = (): { originPid: number; originClient?: string } => ({
  originPid: process.ppid,
  originClient: originClientHint(),
});

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

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
    description:
      "One-call picture of everything running on this machine: Claude Code sessions (with subagents), Claude Desktop, Codex app and CLI sessions, delegated tasks in flight or needing attention, latest reports and the known workspaces. Start here.",
    inputSchema: objectSchema({}),
    call: () => http("GET", "/delegation/overview"),
  },
  {
    name: "hub_workspaces",
    description:
      "List the workspaces the hub knows (from the .code-workspace folder) with the local path of every repository. Use it to resolve where a project lives instead of asking.",
    inputSchema: objectSchema({}),
    call: () => http("GET", "/delegation/workspaces"),
  },
  {
    name: "hub_delegate",
    description:
      "Delegate work to a headless Claude Code (default) or Codex run inside a workspace. The run starts in the workspace context folder with every repo of that workspace attached, so the agent sees the workspace CLAUDE.md, skills and all repos. Runs are autonomous by default (the hub's Autonomy setting is full: no permission prompts, full shell), so do NOT pass permissionMode or sandbox unless you want plan mode; a restrictive mode is upgraded to autonomous anyway. Returns the task id to follow with hub_task.",
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
          description: "Only plan is honoured; with the hub autonomy at full every other value runs as bypassPermissions. Omit it.",
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
            "use worktree when other agents may be editing the same repo; the task commits on its own branch and you merge with hub_task_merge",
        },
        title: { type: "string", description: "Optional short title; defaults to the first prompt line" },
      },
      ["workspace", "prompt"],
    ),
    call: (args) => http("POST", "/delegation/tasks", { ...args, ...originFields(), source: "mcp" }),
  },
  {
    name: "hub_task",
    description: "Get a delegated task with all its runs (results, errors, session id) and reports.",
    inputSchema: objectSchema({ taskId: { type: "string", description: "Full task id or a unique prefix (8 chars is enough)" } }, ["taskId"]),
    call: (args) => http("GET", taskPath(args)),
  },
  {
    name: "hub_tasks",
    description: "List delegated tasks, most recent first. Filter by status: pending, running, completed, attention, failed, interrupted, cancelled.",
    inputSchema: objectSchema({ status: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }),
    call: (args) => http("GET", `/delegation/tasks${query({ status: args.status, limit: args.limit })}`),
  },
  {
    name: "hub_continue",
    description: "Send a follow-up prompt to a delegated task; it resumes the same Claude/Codex session.",
    inputSchema: objectSchema(
      { taskId: { type: "string", description: "Full task id or a unique prefix (8 chars is enough)" }, prompt: { type: "string" }, model: { type: "string" } },
      ["taskId", "prompt"],
    ),
    call: (args) => http("POST", taskPath(args, "/continue"), { prompt: args.prompt, model: args.model, ...originFields() }),
  },
  {
    name: "hub_cancel",
    description: "Cancel the in-flight run of a delegated task.",
    inputSchema: objectSchema({ taskId: { type: "string", description: "Full task id or a unique prefix (8 chars is enough)" } }, ["taskId"]),
    call: (args) => http("POST", taskPath(args, "/cancel")),
  },
  {
    name: "hub_task_archive",
    description: "Archive a settled delegated task so it drops out of the default task lists and overview; pass unarchive to bring it back. Running or pending tasks cannot be archived.",
    inputSchema: objectSchema({ taskId: { type: "string", description: "Full task id or a unique prefix (8 chars is enough)" }, unarchive: { type: "boolean" } }, ["taskId"]),
    call: (args) => http("POST", taskPath(args, args.unarchive === true ? "/unarchive" : "/archive")),
  },
  {
    name: "hub_task_merge",
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
    description: "Read the latest reports (all, or the ones attached to a task).",
    inputSchema: objectSchema({ taskId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }),
    call: (args) => http("GET", `/delegation/reports${query({ taskId: args.taskId, limit: args.limit })}`),
  },
  {
    name: "hub_sessions",
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
    description: "Create a workspace: writes <name>.code-workspace in the workspaces root with the given repo folders and seeds a context folder with a CLAUDE.md.",
    inputSchema: objectSchema(
      { name: { type: "string" }, repos: { type: "array", items: { type: "string" }, description: "Absolute repo paths" } },
      ["name", "repos"],
    ),
    call: (args) => http("POST", "/delegation/workspaces", { name: args.name, repos: args.repos }),
  },
  {
    name: "hub_session_live",
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
    description: "Streamed log of a delegated task: assistant text, tool calls and status changes for every run, in order.",
    inputSchema: objectSchema({ taskId: { type: "string", description: "Full task id or a unique prefix (8 chars is enough)" } }, ["taskId"]),
    call: (args) => http("GET", taskPath(args, "/events")),
  },
  {
    name: "hub_delete_workspace",
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
    description:
      "Read today's second-brain context when the hub is linked to a vault: today's diary, the hub source (delegations and reports of the day) and the Claude session trail.",
    inputSchema: objectSchema({}),
    call: () => http("GET", "/delegation/brain/today"),
  },
  {
    name: "hub_shares",
    description:
      "List the share links of this hub (external collaborators asking the owner Claude): label, scope, workspace, state, usage and links (local, LAN, public through the tunnel).",
    inputSchema: objectSchema({}),
    call: () => http("GET", "/delegation/shares"),
  },
  {
    name: "hub_share_create",
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
    description: "Recent questions and implementation requests that arrived through shares, with answers and status.",
    inputSchema: objectSchema({ limit: { type: "number" } }),
    call: (args) => http("GET", `/delegation/shares/activity${query({ limit: args.limit })}`),
  },
  {
    name: "hub_tunnel",
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

const INSTRUCTIONS = [
  "CC Hub is the machine-local hub where every agent arrives and reports.",
  "Call hub_overview first to see what is running. Use hub_workspaces to resolve repo paths; never ask the user where a project lives.",
  "Delegate long work with hub_delegate (workspace + prompt), follow it with hub_task, steer it with hub_continue, and leave a trail with hub_report so other conversations can pick it up.",
].join(" ");

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
      respond(id, {
        protocolVersion: requested && PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "vbss-cchub", version: "1" },
        instructions: INSTRUCTIONS,
      });
      return;
    }
    case "ping":
      respond(id, {});
      return;
    case "tools/list":
      respond(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      return;
    case "tools/call": {
      const name = asString(params?.name);
      const tool = TOOLS.find((item) => item.name === name);
      if (!tool) {
        fail(id, -32602, `unknown tool: ${name ?? "(none)"}`);
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
