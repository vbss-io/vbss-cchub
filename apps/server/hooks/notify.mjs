import { execFileSync, spawn } from "node:child_process";
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

function sessionTitle(sessionId, transcriptTitle, customTitle) {
  const meta = readSessionMeta(join(homedir(), ".claude", "sessions"), sessionId);
  const userName = meta.nameSource !== "derived" ? meta.name : null;
  return customTitle ?? userName ?? transcriptTitle ?? meta.name ?? null;
}

if (process.env.HUB_SKIP === "1") process.exit(0);

const isHeadless = (process.env.CLAUDE_CODE_ENTRYPOINT ?? "").startsWith("sdk");
if (isHeadless && process.env.HUB_TRACK_SDK !== "1") process.exit(0);

const here = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HUB_HOST_TARGET ?? "127.0.0.1";
const PORT = process.env.HUB_PORT ?? 4317;
const SOURCE = process.env.HUB_SOURCE ?? hostname();

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const envClaudePid = Number(process.env.CLAUDE_PID) > 0 ? Number(process.env.CLAUDE_PID) : null;
const startPid = envClaudePid ?? (Number(process.env.HUB_HOOK_START_PID) > 0 ? Number(process.env.HUB_HOOK_START_PID) : process.pid);

function cachedHostInfo(sessionId) {
  if (process.platform !== "win32") return null;
  const cache = join(homedir(), ".vbss-cchub", "pids", `${sessionId}.json`);
  try {
    if (!existsSync(cache)) return null;
    const cached = JSON.parse(readFileSync(cache, "utf8"));
    const shellOk = cached.shellPid == null || alive(cached.shellPid);
    if (Number.isInteger(cached.hostPid) && cached.hostPid > 0 && alive(cached.hostPid) && shellOk) {
      return { claudePid: null, host: null, ...cached };
    }
  } catch {
    return null;
  }
  return null;
}

function resolveHostInfo(sessionId) {
  const empty = { hostPid: null, shellPid: null, claudePid: null, host: null };
  if (process.platform !== "win32") return empty;
  const dir = join(homedir(), ".vbss-cchub", "pids");
  const cache = join(dir, `${sessionId}.json`);
  try {
    if (existsSync(cache)) {
      const cached = JSON.parse(readFileSync(cache, "utf8"));
      const shellOk = cached.shellPid == null || alive(cached.shellPid);
      if (Number.isInteger(cached.hostPid) && cached.hostPid > 0 && alive(cached.hostPid) && shellOk) {
        return { claudePid: null, host: null, ...cached };
      }
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
        String(startPid),
      ],
      { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    ).trim();
    const parsed = JSON.parse(out);
    const hostPid = Number(parsed.windowPid);
    const claude = Number(parsed.claudePid);
    const claudePid = Number.isInteger(claude) && claude > 0 ? claude : null;
    const host = typeof parsed.host === "string" ? parsed.host : null;
    if (Number.isInteger(hostPid) && hostPid > 0) {
      const shell = Number(parsed.shellPid);
      const shellPid = parsed.isCode && Number.isInteger(shell) && shell > 0 ? shell : null;
      const info = { hostPid, shellPid, claudePid, host };
      mkdirSync(dir, { recursive: true });
      writeFileSync(cache, JSON.stringify(info));
      return info;
    }
    if (claudePid) return { hostPid: null, shellPid: null, claudePid, host };
  } catch {
    /* powershell unavailable or nothing found */
  }
  return empty;
}

function readTranscript(path) {
  const out = { title: null, customTitle: null, model: null, tokensIn: null, tokensOut: null, contextTokens: null };
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
  let aiTitle = null;
  let customTitle = null;
  for (const line of lines) {
    if (!line.includes('"ai-title"') && !line.includes('"custom-title"') && !line.includes('"assistant"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") aiTitle = entry.aiTitle;
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") customTitle = entry.customTitle;
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
  out.title = customTitle ?? aiTitle;
  out.customTitle = customTitle;
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
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  SessionEnd: "session_end",
};

async function readStdin() {
  let raw = "";
  for await (const chunk of stdin) raw += chunk;
  return raw;
}

const WORKER_FLAG = "--worker";
const isWorker = process.argv.includes(WORKER_FLAG);
const inline = process.env.HUB_HOOK_INLINE === "1";
const raw = await readStdin();
let input = {};
try {
  input = JSON.parse(raw || "{}");
} catch {
  input = {};
}

const explicitKind = process.argv.slice(2).find((arg) => arg !== WORKER_FLAG);
const kind = explicitKind ?? kindByEvent[input.hook_event_name] ?? "notification";
const sessionId = input.session_id ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
if (!sessionId) process.exit(0);
const lastAssistant =
  typeof input.last_assistant_message === "string" ? input.last_assistant_message.slice(0, 400) : null;
const shareLabel = process.env.HUB_SHARE_LABEL ?? null;
const clientFor = (host) => (shareLabel ? "share" : isHeadless ? (process.env.HUB_DELEGATED === "1" ? "hub" : "headless") : (host ?? "terminal"));

function buildBody(eventKind, hostInfo, transcript, withMessage) {
  return {
    kind: eventKind,
    sessionId,
    cwd: input.cwd ?? null,
    source: SOURCE,
    hostPid: hostInfo.hostPid,
    shellPid: hostInfo.shellPid,
    message: withMessage ? (input.message ?? (input.agent_id ? null : lastAssistant)) : null,
    title: transcript ? sessionTitle(sessionId, transcript.title, transcript.customTitle) : null,
    model: transcript ? transcript.model : null,
    tokensIn: transcript ? transcript.tokensIn : null,
    tokensOut: transcript ? transcript.tokensOut : null,
    contextTokens: transcript ? transcript.contextTokens : null,
    agentId: input.agent_id ?? null,
    agentType: input.agent_type ?? null,
    client: hostInfo.host || hostInfo.cached ? clientFor(hostInfo.host) : shareLabel || isHeadless ? clientFor(null) : null,
    claudePid: hostInfo.claudePid ?? envClaudePid,
    transcriptPath: input.transcript_path ?? null,
    agentMessage: withMessage && input.agent_id ? lastAssistant : null,
    shareLabel,
  };
}

async function post(body) {
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
}

if (isWorker) {
  await post(buildBody("meta", resolveHostInfo(sessionId), readTranscript(input.transcript_path), false));
  process.exit(0);
}

if (inline) {
  await post(buildBody(kind, resolveHostInfo(sessionId), readTranscript(input.transcript_path), true));
  process.exit(0);
}

const cached = cachedHostInfo(sessionId);
await post(buildBody(kind, cached ? { ...cached, cached: true } : { hostPid: null, shellPid: null, claudePid: null, host: null }, null, true));
const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2), WORKER_FLAG], {
  detached: true,
  stdio: ["pipe", "ignore", "ignore"],
  windowsHide: true,
  env: { ...process.env, HUB_HOOK_START_PID: String(process.ppid) },
});
child.stdin.end(raw);
child.unref();
process.exit(0);
