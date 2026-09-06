import { config } from "./config.js";

interface Command {
  action: string;
  [key: string]: unknown;
}

interface Endpoint {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

function hubBase(): string {
  const override = process.env.HUB_URL;
  if (override && override.trim().length > 0) return override.trim().replace(/\/$/, "");
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  const hostPart = host.includes(":") ? `[${host}]` : host;
  return `http://${hostPart}:${config.port}`;
}

function pickString(command: Command, key: string): string {
  const value = command[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`missing "${key}"`);
  return value;
}

function optionalString(command: Command, key: string): string | undefined {
  const value = command[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const query = (params: Record<string, unknown>): string => {
  const pairs = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return pairs.length > 0 ? `?${pairs.join("&")}` : "";
};

const taskPath = (command: Command, suffix = ""): string =>
  `/delegation/tasks/${encodeURIComponent(pickString(command, "taskId"))}${suffix}`;

const workspacePath = (command: Command, suffix = ""): string =>
  `/delegation/workspaces/${encodeURIComponent(pickString(command, "workspace"))}${suffix}`;

function route(command: Command): Endpoint {
  switch (command.action) {
    case "overview":
      return { method: "GET", path: "/delegation/overview" };
    case "settings":
      return { method: "GET", path: "/delegation/settings" };
    case "set-settings":
      return {
        method: "PUT",
        path: "/delegation/settings",
        body: {
          ...("workspacesRoot" in command ? { workspacesRoot: command.workspacesRoot } : {}),
          ...("editorCommand" in command ? { editorCommand: command.editorCommand } : {}),
          ...("secondBrainRoot" in command ? { secondBrainRoot: command.secondBrainRoot } : {}),
        },
      };
    case "workspaces":
      return { method: "GET", path: "/delegation/workspaces" };
    case "create-workspace":
      return { method: "POST", path: "/delegation/workspaces", body: { name: pickString(command, "name"), repos: command.repos } };
    case "update-workspace":
      return { method: "PUT", path: workspacePath(command), body: { repos: command.repos } };
    case "open":
      return { method: "POST", path: workspacePath(command, "/open") };
    case "connect":
      return { method: "GET", path: "/delegation/connect" };
    case "connect-shell":
      return { method: "POST", path: "/delegation/connect/shell", body: { shell: pickString(command, "shell"), action: optionalString(command, "do") } };
    case "connect-mcp":
      return { method: "POST", path: "/delegation/connect/mcp", body: { client: pickString(command, "client"), action: optionalString(command, "do") } };
    case "list":
      return { method: "GET", path: `/delegation/tasks${query({ status: command.status, limit: command.limit })}` };
    case "get":
      return { method: "GET", path: taskPath(command) };
    case "delegate":
    case "create":
      return {
        method: "POST",
        path: "/delegation/tasks",
        body: {
          title: optionalString(command, "title"),
          prompt: pickString(command, "prompt"),
          workspace: pickString(command, "workspace"),
          repo: optionalString(command, "repo"),
          runner: optionalString(command, "runner"),
          model: optionalString(command, "model"),
          permissionMode: optionalString(command, "permissionMode"),
          sandbox: optionalString(command, "sandbox"),
          source: optionalString(command, "source") ?? "cli",
        },
      };
    case "continue":
      return {
        method: "POST",
        path: taskPath(command, "/continue"),
        body: {
          prompt: pickString(command, "prompt"),
          model: optionalString(command, "model"),
          permissionMode: optionalString(command, "permissionMode"),
        },
      };
    case "cancel":
      return { method: "POST", path: taskPath(command, "/cancel") };
    case "report":
      return {
        method: "POST",
        path: "/delegation/reports",
        body: {
          text: pickString(command, "text"),
          kind: optionalString(command, "kind"),
          taskId: optionalString(command, "taskId"),
          sessionId: optionalString(command, "sessionId"),
          workspace: optionalString(command, "workspace"),
          source: optionalString(command, "source") ?? "cli",
        },
      };
    case "reports":
      return { method: "GET", path: `/delegation/reports${query({ taskId: command.taskId, limit: command.limit })}` };
    case "brain":
      return { method: "GET", path: "/delegation/brain/today" };
    case "sessions":
      return { method: "GET", path: "/api/sessions" };
    case "codex-sessions":
      return { method: "GET", path: "/api/codex/sessions" };
    case "runtimes":
      return { method: "GET", path: "/api/runtimes" };
    case "focus":
      return { method: "POST", path: `/api/sessions/${encodeURIComponent(pickString(command, "sessionId"))}/focus` };
    default:
      throw new Error(`unknown action "${command.action}"`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const raw = (await readStdin()).trim();
  if (raw.length === 0) throw new Error("empty stdin: pipe a JSON command");
  const command = JSON.parse(raw) as Command;
  if (typeof command.action !== "string") throw new Error('missing "action"');
  const endpoint = route(command);
  const url = `${hubBase()}${endpoint.path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: endpoint.method,
      headers: { "content-type": "application/json" },
      body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
    });
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
    throw new Error(`cannot reach the hub at ${url}: ${cause}`);
  }
  const text = await res.text();
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  if (!res.ok) process.exitCode = 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
