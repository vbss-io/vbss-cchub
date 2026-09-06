import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const prompt = (await readStdin()).trim();
  const resume = argv[0] === "exec" && argv[1] === "resume" ? argv[2] : null;
  const threadId = resume ?? `thread-${randomUUID().slice(0, 8)}`;
  const mode = process.env.FAKE_CODEX_MODE ?? "";
  const capture = process.env.FAKE_CODEX_CAPTURE;
  if (capture) writeFileSync(capture, JSON.stringify({ argv, cwd: process.cwd(), prompt }));
  const sleepDirective = /sleep:(\d+)/.exec(prompt);

  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "turn.started" });
  if (sleepDirective) await sleep(Number(sleepDirective[1]));

  if (mode === "error") {
    emit({ type: "error", message: "usage limit reached" });
    emit({ type: "turn.failed", error: { message: "usage limit reached" } });
    process.exit(1);
  }

  const lastLine = prompt.split(/\r?\n/).filter((line) => line.trim().length > 0).pop() ?? "";
  if (lastLine.startsWith("tool:")) {
    emit({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "ls -la", status: "in_progress" } });
    emit({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "ls -la", exit_code: 0, status: "completed" } });
  }
  emit({
    type: "item.completed",
    item: { id: "item_1", type: "agent_message", text: `${resume ? "resumed" : "codex"}: ${lastLine}` },
  });
  emit({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
}

main();
