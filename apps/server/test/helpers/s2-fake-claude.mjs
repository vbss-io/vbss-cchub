import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.env.S2_ARGV_CAPTURE) writeFileSync(process.env.S2_ARGV_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), label: process.env.HUB_SHARE_LABEL ?? null }));

const resume = flag("--resume");
const sessionId = resume ?? flag("--session-id") ?? randomUUID();
const model = flag("--model") ?? "fake-model";

function startup() {
  emit({ type: "system", subtype: "hook_started", hook_id: "h1", hook_name: "SessionStart:startup", hook_event: "SessionStart", session_id: sessionId });
  emit({ type: "system", subtype: "hook_response", hook_id: "h1", hook_name: "SessionStart:startup", hook_event: "SessionStart", output: "", stdout: "", stderr: "", exit_code: 0, outcome: "success", session_id: sessionId });
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model,
    cwd: process.cwd(),
    apiKeySource: "none",
    tools: ["Bash", "Read", "Edit", "Glob", "Grep", "mcp__cchub__hub_overview"],
    mcp_servers: [{ name: "cchub", status: "connected" }],
    permissionMode: flag("--permission-mode") ?? "default",
  });
}

const toolBlock = (name, input) => ({ type: "tool_use", id: randomUUID(), name, input });

async function answer(prompt) {
  if (prompt === "hang") return;
  if (prompt === "crash") {
    process.stderr.write("claude 2.1.0\nfatal: the model exploded\n");
    process.exit(5);
  }
  if (prompt === "crash-bare") process.exit(1);
  if (prompt === "stale") {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 1, session_id: sessionId, errors: ["No conversation found with session ID: gone"], result: "" });
    return;
  }
  if (prompt === "fail") {
    emit({ type: "result", subtype: "error_max_turns", is_error: true, session_id: sessionId, errors: ["boom"], result: "" });
    return;
  }
  if (prompt === "fail-subtype") {
    emit({ type: "result", subtype: "error_max_turns", session_id: sessionId, result: "" });
    return;
  }
  if (prompt === "fail-flag") {
    emit({ type: "result", subtype: "success", is_error: true, session_id: sessionId, result: "" });
    return;
  }
  if (prompt === "fail-unknown") {
    emit({ type: "result", is_error: true, session_id: sessionId, result: "" });
    return;
  }
  if (prompt === "tools") {
    emit({
      type: "assistant",
      session_id: sessionId,
      message: {
        model,
        content: [
          { type: "text", text: "thinking" },
          toolBlock("Bash", { command: "  ls -la  " }),
          toolBlock("Read", { file_path: "C:/x/a.txt" }),
          toolBlock("Grep", { pattern: "needle" }),
          toolBlock("Glob", { path: "C:/x" }),
          toolBlock("WebFetch", { url: "https://example.com" }),
          toolBlock("Task", { description: "sub work" }),
          toolBlock("Agent", { prompt: "do it" }),
          toolBlock("Search", { query: "q" }),
          toolBlock("Empty", { command: "   " }),
          toolBlock("NoInput", null),
          toolBlock("ArrayInput", ["x"]),
          { type: "tool_use", id: "x", name: 7, input: {} },
          null,
        ],
      },
    });
    emit({ type: "assistant", session_id: sessionId, message: { model, content: "plain string content" } });
    emit({ type: "stream_event", session_id: sessionId, parent_tool_use_id: "toolu_1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "from a subagent" } } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_start" } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: "streamed " } } });
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: "text" } } });
    emit({ type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", content: "ok" }] } });
    emit({ type: "result", subtype: "success", session_id: sessionId, result: "", permission_denials: [{ tool_name: "Bash" }, { tool_name: "Bash" }, { tool_name: "Edit" }, {}, 5] });
    return;
  }
  if (prompt === "result-text") {
    emit({ type: "result", subtype: "success", session_id: sessionId, result: "explicit result", permission_denials: "not a list" });
    return;
  }
  emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: "text_delta", text: `echo: ${prompt}` } } });
  emit({ type: "result", subtype: "success", session_id: sessionId, result: `echo: ${prompt}`, permission_denials: [] });
}

startup();
let buffer = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const content = message?.message?.content;
    const prompt = Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : String(content ?? "");
    await answer(prompt);
  }
}
await sleep(0);
