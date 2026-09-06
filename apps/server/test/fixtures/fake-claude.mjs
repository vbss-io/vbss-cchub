import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function respond(prompt, sessionId, model, resume, mode, delay) {
  const sleepDirective = /^sleep:(\d+)$/.exec(prompt);
  const wait = sleepDirective ? Number(sleepDirective[1]) : delay;
  if (wait > 0) await sleep(wait);
  const verb = resume ? "continued" : "handled";
  const text = `${verb}: ${prompt}`;
  const half = Math.ceil(text.length / 2);
  for (const piece of [text.slice(0, half), text.slice(half)]) {
    emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } });
  }
  emit({ type: "assistant", session_id: sessionId, message: { model, content: [{ type: "text", text }] } });
  emit({ type: "result", subtype: mode === "error" ? "error_max_turns" : "success", is_error: mode === "error", session_id: sessionId, result: text, permission_denials: [], duration_ms: wait });
}

async function streamingMain() {
  const resume = flag("--resume");
  const fork = process.argv.includes("--fork-session");
  if (resume && resume.startsWith("stale-")) {
    emit({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: resume, errors: [`No conversation found with session ID: ${resume}`], result: "" });
    process.exit(1);
  }
  const sessionId = resume && !fork ? resume : flag("--session-id") ?? randomUUID();
  const model = flag("--model") ?? "fake-default-model";
  const mode = process.env.FAKE_CLAUDE_MODE ?? "";
  const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0);
  const capture = process.env.FAKE_CLAUDE_CAPTURE;
  let turns = 0;
  emit({ type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd() });
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
      turns += 1;
      if (capture) {
        writeFileSync(capture, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), prompt, turns, pid: process.pid, env: { HUB_TRACK_SDK: process.env.HUB_TRACK_SDK ?? null, HUB_DELEGATED: process.env.HUB_DELEGATED ?? null, HUB_SKIP: process.env.HUB_SKIP ?? null, HUB_PORT: process.env.HUB_PORT ?? null, HUB_GUARD_SHELL: process.env.HUB_GUARD_SHELL ?? null, HUB_SHARE_LABEL: process.env.HUB_SHARE_LABEL ?? null, HUB_WRITE_SCOPE: process.env.HUB_WRITE_SCOPE ?? null } }));
      }
      if (prompt === "die") process.exit(3);
      await respond(prompt, sessionId, model, resume !== null && turns === 1 && !fork ? true : resume !== null, mode, delay);
    }
  }
}

async function main() {
  if (process.argv.includes("stream-json") && process.argv.indexOf("--input-format") >= 0) {
    await streamingMain();
    return;
  }
  const prompt = (await readStdin()).trim();
  const resume = flag("--resume");
  const sessionId = resume ?? flag("--session-id") ?? randomUUID();
  const model = flag("--model") ?? "fake-default-model";
  const mode = process.env.FAKE_CLAUDE_MODE ?? "";
  const sleepDirective = /^sleep:(\d+)$/.exec(prompt);
  const delay = sleepDirective ? Number(sleepDirective[1]) : Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0);
  const capture = process.env.FAKE_CLAUDE_CAPTURE;
  if (capture) {
    writeFileSync(
      capture,
      JSON.stringify({
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        prompt,
        env: {
          HUB_TRACK_SDK: process.env.HUB_TRACK_SDK ?? null,
          HUB_DELEGATED: process.env.HUB_DELEGATED ?? null,
          HUB_SKIP: process.env.HUB_SKIP ?? null,
          HUB_PORT: process.env.HUB_PORT ?? null,
          HUB_GUARD_SHELL: process.env.HUB_GUARD_SHELL ?? null,
        },
      }),
    );
  }

  if (mode === "exit") {
    process.stderr.write("Not logged in. Run `claude login` first.\n");
    process.exit(2);
  }

  emit({ type: "system", subtype: "init", session_id: sessionId, model, cwd: process.cwd() });
  if (mode === "noresult") return;
  if (delay > 0) await sleep(delay);

  if (prompt.startsWith("tool:")) {
    emit({
      type: "assistant",
      session_id: sessionId,
      message: { model, content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } }] },
    });
    emit({
      type: "user",
      session_id: sessionId,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi" }] },
    });
  }

  const verb = resume ? "continued" : "handled";
  const text = `${verb}: ${prompt}`;
  const half = Math.ceil(text.length / 2);
  for (const piece of [text.slice(0, half), text.slice(half)]) {
    emit({
      type: "stream_event",
      session_id: sessionId,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } },
    });
  }
  const assistant = { type: "assistant", session_id: sessionId, message: { model, content: [{ type: "text", text }] } };
  if (mode === "split") {
    const line = `${JSON.stringify(assistant)}\n`;
    process.stdout.write(line.slice(0, 20));
    await sleep(50);
    process.stdout.write(line.slice(20));
  } else {
    emit(assistant);
  }

  if (mode === "error") {
    emit({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      session_id: sessionId,
      errors: ["Reached maximum number of turns (3)"],
    });
    return;
  }

  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    result: mode === "big" ? "x".repeat(300_000) : text,
    permission_denials: mode === "denied" ? [{ tool_name: "Edit", tool_use_id: "t1", tool_input: {} }] : [],
    duration_ms: delay,
  });
}

main();
