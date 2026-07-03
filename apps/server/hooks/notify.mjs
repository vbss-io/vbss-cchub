import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { dirname, join } from "node:path";
import { stdin } from "node:process";
import { fileURLToPath } from "node:url";

function readSessionMeta(dir, sessionId) {
  let best = null;
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const entry = JSON.parse(readFileSync(join(dir, file), "utf8"));
        if (entry.sessionId === sessionId && (!best || (entry.updatedAt ?? 0) > (best.updatedAt ?? 0))) {
          best = entry;
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no sessions dir */
  }
  return { name: best?.name ?? null, nameSource: best?.nameSource ?? null };
}

function sessionTitle(sessionId, aiTitle) {
  const meta = readSessionMeta(join(homedir(), ".claude", "sessions"), sessionId);
  const userName = meta.nameSource !== "derived" ? meta.name : null;
  return userName ?? aiTitle ?? meta.name ?? null;
}

const here = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HUB_HOST_TARGET ?? "127.0.0.1";
const PORT = process.env.HUB_PORT ?? 4317;
const SOURCE = process.env.HUB_SOURCE ?? hostname();

function resolveHostInfo(sessionId) {
  const empty = { hostPid: null, shellPid: null };
  if (process.platform !== "win32") return empty;
  const dir = join(homedir(), ".claude-code-hub", "pids");
  const cache = join(dir, `${sessionId}.json`);
  try {
    if (existsSync(cache)) {
      const cached = JSON.parse(readFileSync(cache, "utf8"));
      if (Number.isInteger(cached.hostPid) && cached.hostPid > 0) return cached;
    }
  } catch {
    /* ignore */
  }
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(here, "find-host-window.ps1"),
        "-StartPid",
        String(process.pid),
      ],
      { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const parsed = JSON.parse(out);
    const hostPid = Number(parsed.windowPid);
    if (Number.isInteger(hostPid) && hostPid > 0) {
      const shell = Number(parsed.shellPid);
      const shellPid = parsed.isCode && Number.isInteger(shell) && shell > 0 ? shell : null;
      const info = { hostPid, shellPid };
      mkdirSync(dir, { recursive: true });
      writeFileSync(cache, JSON.stringify(info));
      return info;
    }
  } catch {
    /* powershell unavailable or nothing found */
  }
  return empty;
}

function readTranscript(path) {
  const out = { title: null, model: null, tokensIn: null, tokensOut: null, contextTokens: null };
  if (!path) return out;
  let lines;
  try {
    lines = readFileSync(path, "utf8").trim().split("\n");
  } catch {
    return out;
  }
  let tokensIn = 0;
  let tokensOut = 0;
  let lastUsage = null;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") out.title = entry.aiTitle;
    if (entry.type === "assistant" && entry.message) {
      if (typeof entry.message.model === "string") out.model = entry.message.model;
      const usage = entry.message.usage;
      if (usage) {
        tokensIn += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        tokensOut += usage.output_tokens ?? 0;
        lastUsage = usage;
      }
    }
  }
  if (lastUsage) {
    out.contextTokens =
      (lastUsage.input_tokens ?? 0) +
      (lastUsage.cache_read_input_tokens ?? 0) +
      (lastUsage.cache_creation_input_tokens ?? 0);
    out.tokensIn = tokensIn;
    out.tokensOut = tokensOut;
  }
  return out;
}

const kindByEvent = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt",
  Notification: "notification",
  Stop: "stop",
  SubagentStop: "stop",
  SessionEnd: "session_end",
};

async function readStdin() {
  let raw = "";
  for await (const chunk of stdin) raw += chunk;
  return raw;
}

const raw = await readStdin();
let input = {};
try {
  input = JSON.parse(raw || "{}");
} catch {
  input = {};
}

const kind = process.argv[2] ?? kindByEvent[input.hook_event_name] ?? "notification";
const sessionId = input.session_id ?? "unknown";
const transcript = readTranscript(input.transcript_path);
const { hostPid, shellPid } = resolveHostInfo(sessionId);

const body = {
  kind,
  sessionId,
  cwd: input.cwd ?? null,
  source: SOURCE,
  hostPid,
  shellPid,
  message: input.message ?? null,
  title: sessionTitle(sessionId, transcript.title),
  model: transcript.model,
  tokensIn: transcript.tokensIn,
  tokensOut: transcript.tokensOut,
  contextTokens: transcript.contextTokens,
};

try {
  await fetch(`http://${HOST}:${PORT}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
} catch {
  // hub offline: never block Claude Code
}

process.exit(0);
