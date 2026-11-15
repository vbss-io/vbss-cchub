import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const REPORT_TIMEOUT_MS = 300;
const HOST = process.env.HUB_HOST_TARGET ?? "127.0.0.1";
const PORT = process.env.HUB_PORT ?? 4317;

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function previousCommand() {
  const encoded = flag("--previous");
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return typeof parsed?.command === "string" && parsed.command.trim().length > 0 ? parsed.command : null;
  } catch {
    return null;
  }
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function report(raw) {
  if (process.env.HUB_SKIP === "1") return;
  let input;
  try {
    input = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  const rateLimits = input?.rate_limits;
  if (!rateLimits || typeof rateLimits !== "object" || Array.isArray(rateLimits)) return;
  try {
    const response = await fetch(`http://${HOST}:${PORT}/delegation/limits/claude-source/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: typeof input.session_id === "string" ? input.session_id : null, rateLimits }),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    await response.body?.cancel();
  } catch {
    return;
  }
}

function gitBash() {
  const configured = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (configured && existsSync(configured)) return configured;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const lower = dir.toLowerCase();
    if (!dir || lower.includes("\\windows\\system32") || lower.includes("\\windowsapps")) continue;
    const candidate = join(dir, "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function shells(command) {
  if (process.platform !== "win32") return [["/bin/sh", ["-c", command]]];
  const bash = gitBash();
  const powershell = ["powershell", ["-NoProfile", "-NonInteractive", "-Command", command]];
  return bash ? [[bash, ["-c", command]], powershell] : [powershell];
}

function runWith(file, shellArgs, raw) {
  return new Promise((resolve) => {
    let started = false;
    const child = spawn(file, shellArgs, { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
    child.on("spawn", () => {
      started = true;
    });
    child.on("error", () => resolve(started ? { started: true, code: 1 } : { started: false, code: 1 }));
    child.on("close", (code) => resolve({ started: true, code: code ?? 1 }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(raw);
  });
}

async function chain(raw) {
  const command = previousCommand();
  if (command === null) return 0;
  for (const [file, shellArgs] of shells(command)) {
    const result = await runWith(file, shellArgs, raw);
    if (result.started) return result.code;
  }
  return 0;
}

const raw = await readInput();
const [code] = await Promise.all([chain(raw), report(raw)]);
process.exit(code);
