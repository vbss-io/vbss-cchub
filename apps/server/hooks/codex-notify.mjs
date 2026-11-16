import { stdin } from "node:process";

if (process.env.HUB_SKIP === "1") process.exit(0);

const HOST = process.env.HUB_HOST_TARGET ?? "127.0.0.1";
const PORT = process.env.HUB_PORT ?? 4317;
const HANDSHAKE_TIMEOUT_MS = 800;
const WAIT_MARGIN_MS = 5000;
const EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "Interrupt", "SessionEnd"]);

async function readStdin() {
  let raw = "";
  for await (const chunk of stdin) raw += chunk;
  return raw;
}

let input = {};
try {
  input = JSON.parse((await readStdin()) || "{}");
} catch {
  input = {};
}

const event = typeof input.hook_event_name === "string" ? input.hook_event_name : null;
const sessionId = typeof input.session_id === "string" && input.session_id.length > 0 ? input.session_id : null;
if (!event || !EVENTS.has(event) || !sessionId) process.exit(0);

const delegated = process.env.HUB_DELEGATED === "1" || Boolean(process.env.HUB_TASK_ID) || Boolean(process.env.HUB_RUN_ID);
const text = (value) => (typeof value === "string" && value.length > 0 ? value : null);

async function postJson(path, body, timeoutMs) {
  try {
    const res = await fetch(`http://${HOST}:${PORT}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function askHub() {
  const opened = await postJson(
    "/api/permissions/request",
    {
      agent: "codex",
      sessionId,
      agentId: null,
      toolName: text(input.tool_name),
      toolInput: input.tool_input ?? null,
      cwd: text(input.cwd),
      turnId: text(input.turn_id),
      delegated,
    },
    HANDSHAKE_TIMEOUT_MS,
  );
  if (!opened || typeof opened.id !== "string" || !(Number(opened.windowMs) > 0)) return null;
  try {
    const res = await fetch(`http://${HOST}:${PORT}/api/permissions/${encodeURIComponent(opened.id)}/wait`, {
      signal: AbortSignal.timeout(Number(opened.windowMs) + WAIT_MARGIN_MS),
    });
    if (!res.ok) return null;
    const out = await res.json();
    return out && typeof out.decision === "object" ? out.decision : null;
  } catch {
    return null;
  }
}

function officialDecision(decision) {
  if (!decision) return null;
  if (decision.behavior === "allow") return { behavior: "allow" };
  if (decision.behavior !== "deny") return null;
  return typeof decision.message === "string" && decision.message.length > 0 ? { behavior: "deny", message: decision.message } : { behavior: "deny" };
}

const observed = await postJson(
  "/api/codex/hook",
  {
    event,
    sessionId,
    cwd: text(input.cwd),
    transcriptPath: text(input.transcript_path),
    model: text(input.model),
    turnId: text(input.turn_id),
    toolName: text(input.tool_name),
    toolInput: input.tool_input,
    lastAssistantMessage: text(input.last_assistant_message),
    delegated,
  },
  HANDSHAKE_TIMEOUT_MS,
);

if (event === "PermissionRequest" && observed && !delegated) {
  const decision = officialDecision(await askHub());
  if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
}
process.exit(0);
