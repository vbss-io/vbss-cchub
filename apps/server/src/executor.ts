import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import type { CodexSandbox, PermissionMode, Runner } from "./delegation-types.js";
import { portRangeOf } from "./task-ports.js";

const MAX_RESULT_CHARS = 200_000;
const MAX_LINE_CHARS = 4_000_000;
const MAX_STDERR_CHARS = 8_000;
const MAX_TOOL_TEXT = 200;

export type RunOutcomeStatus = "completed" | "attention" | "failed" | "cancelled";

export type RunEventKind = "text" | "tool" | "status";

export interface RunEvent {
  kind: RunEventKind;
  text: string;
}

export interface RunRequest {
  runner: Runner;
  cwd: string;
  addDirs: string[];
  prompt: string;
  taskId?: string;
  runId?: string;
  systemContext: string | null;
  model: string | null;
  permissionMode: PermissionMode | null;
  sandbox: CodexSandbox | null;
  sessionId: string | null;
  resumeSessionId: string | null;
  portBase?: number | null;
  forkSession?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  restricted?: boolean;
  strictMcpConfig?: boolean;
  permissionPrompts?: "host" | "none";
  tools?: string[];
  guard?: "readonly" | "shell";
  shareLabel?: string;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

export interface ExecutorResult {
  status: RunOutcomeStatus;
  result: string | null;
  effectiveModel: string | null;
  sessionId: string | null;
  exitCode: number | null;
  error: string | null;
}

type Json = Record<string, unknown>;

export const BARE_MODE_ERROR = "Claude Code started in bare mode (no login/CLAUDE.md/hooks). Update CC Hub or pass the needed flags.";

const HUB_MCP_NAME = "cchub";
const STARTUP_HOOK_SUBTYPES = new Set(["hook_started", "hook_progress", "hook_response"]);
const TURN_EVENT_TYPES = new Set(["assistant", "user", "stream_event"]);

export interface StartupExpectations {
  hubMcp: boolean;
  sessionStartHook: boolean;
  guardHooks: boolean;
}

export interface StartupGuard {
  expected: StartupExpectations;
  init: Json | null;
  sessionStartHook: boolean;
  checked: boolean;
  error: string | null;
  warning: string | null;
  warningSent: boolean;
}

export interface StartupVerdict {
  error: string | null;
  warning: string | null;
}

interface StreamState {
  effectiveModel: string | null;
  sessionId: string | null;
  result: string | null;
  sawResult: boolean;
  failed: boolean;
  subtype: string | null;
  errors: string[];
  deniedTools: string[];
  guard: StartupGuard | null;
  emit: (event: RunEvent) => void;
}

interface ProcessSpec {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  guard: StartupGuard | null;
  ingest: (event: Record<string, unknown>, state: StreamState) => void;
}

const isString = (value: unknown): value is string => typeof value === "string";
const asObject = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function readJsonFile(path: string): Json | null {
  if (!existsSync(path)) return null;
  try {
    return asObject(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function projectEntry(projects: Json | null, cwd: string): Json | null {
  if (!projects) return null;
  return asObject(projects[cwd]) ?? asObject(projects[cwd.replace(/\\/g, "/")]);
}

function hubMcpRegistered(cwd: string): boolean {
  const state = readJsonFile(config.claudeConfigPath);
  const servers = asObject(state?.mcpServers);
  if (!servers || !(HUB_MCP_NAME in servers)) return false;
  const disabled = projectEntry(asObject(state?.projects), cwd)?.disabledMcpServers;
  return !(Array.isArray(disabled) && disabled.includes(HUB_MCP_NAME));
}

function sessionStartHookConfigured(): boolean {
  const settings = readJsonFile(join(config.claudeHome, "settings.json"));
  if (!settings || settings.disableAllHooks === true) return false;
  const entries = asObject(settings.hooks)?.SessionStart;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    const item = asObject(entry);
    const matcher = item?.matcher;
    if (isString(matcher) && matcher !== "" && matcher !== "*") return false;
    const hooks = item?.hooks;
    return Array.isArray(hooks) && hooks.some((hook) => asObject(hook)?.type === "command");
  });
}

export interface StartupOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  hooksViaSettings: boolean;
  guardHooks?: boolean;
  strictMcpConfig?: boolean;
  restricted?: boolean;
}

export function startupExpectations(options: StartupOptions): StartupExpectations {
  const userConfig = !options.restricted;
  const sessionStartHook = options.env.HUB_TRACK_SDK === "1" && (options.hooksViaSettings || (userConfig && sessionStartHookConfigured()));
  return {
    hubMcp: userConfig && !options.strictMcpConfig && hubMcpRegistered(options.cwd),
    sessionStartHook,
    guardHooks: sessionStartHook && options.guardHooks === true,
  };
}

export function createStartupGuard(expected: StartupExpectations): StartupGuard {
  return { expected, init: null, sessionStartHook: false, checked: false, error: null, warning: null, warningSent: false };
}

const mcpServerNames = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => asObject(item)?.name).filter(isString) : [];

export function startupVerdict(guard: StartupGuard): StartupVerdict {
  const init = guard.init;
  if (!init) return { error: `${BARE_MODE_ERROR} No system/init event arrived before the first turn.`, warning: null };
  const mcpMissing = guard.expected.hubMcp && !mcpServerNames(init.mcp_servers).includes(HUB_MCP_NAME);
  const hookMissing = guard.expected.sessionStartHook && !guard.sessionStartHook;
  const missing = [...(mcpMissing ? [`${HUB_MCP_NAME} MCP server`] : []), ...(hookMissing ? ["SessionStart hooks"] : [])];
  if (missing.length === 0) return { error: null, warning: null };
  if ((mcpMissing && hookMissing) || (hookMissing && guard.expected.guardHooks)) {
    return { error: `${BARE_MODE_ERROR} Missing: ${missing.join(", ")}.`, warning: null };
  }
  return { error: null, warning: `startup check: the ${missing.join(", ")} did not load; the run continues without it` };
}

export function takeStartupWarning(guard: StartupGuard): string | null {
  if (!guard.checked || guard.warningSent || guard.warning === null) return null;
  guard.warningSent = true;
  return guard.warning;
}

export function observeStartup(guard: StartupGuard, event: Json): string | null {
  if (guard.checked) return guard.error;
  if (event.type === "system" && isString(event.subtype) && STARTUP_HOOK_SUBTYPES.has(event.subtype) && event.hook_event === "SessionStart") {
    guard.sessionStartHook = true;
    return null;
  }
  const isInit = event.type === "system" && event.subtype === "init";
  if (!isInit && !(isString(event.type) && TURN_EVENT_TYPES.has(event.type))) return null;
  if (isInit) guard.init = event;
  guard.checked = true;
  const verdict = startupVerdict(guard);
  guard.error = verdict.error;
  guard.warning = verdict.warning;
  return guard.error;
}

const SHARE_ENV_KEYS = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|HOME|HOMEDRIVE|HOMEPATH|USERPROFILE|USERNAME|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|PUBLIC|ALLUSERSPROFILE|COMPUTERNAME|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|LANG|LC_ALL|TZ|SHELL|TERM|CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|NVM_[A-Z_]+|NODE_PATH|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/i;

const BEDROCK_ENV_KEYS = /^(AWS_[A-Z_]+|ANTHROPIC_BEDROCK_BASE_URL)$/i;
const VERTEX_ENV_KEYS = /^(GOOGLE_[A-Z_]+|ANTHROPIC_VERTEX_[A-Z_]+|CLOUD_ML_REGION)$/i;

function providerKey(key: string): boolean {
  if (process.env.CLAUDE_CODE_USE_BEDROCK && BEDROCK_ENV_KEYS.test(key)) return true;
  return Boolean(process.env.CLAUDE_CODE_USE_VERTEX) && VERTEX_ENV_KEYS.test(key);
}

export function shareEnv(shell: boolean, label = "share", total = false, writeScope: string | null = null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const passthrough = new Set((process.env.HUB_SHARE_ENV_PASSTHROUGH ?? "").split(",").map((key) => key.trim()).filter(Boolean));
  for (const [key, value] of Object.entries(process.env)) if ((SHARE_ENV_KEYS.test(key) || passthrough.has(key) || providerKey(key)) && value !== undefined) env[key] = value;
  env.HUB_GUARD_SHELL = shell || total ? "1" : "0";
  env.HUB_TRACK_SDK = "1";
  env.HUB_DELEGATED = "1";
  env.HUB_SHARE_LABEL = label;
  if (writeScope) env.HUB_WRITE_SCOPE = writeScope;
  env.HUB_PORT = String(config.port);
  env.HUB_HOST_TARGET = "127.0.0.1";
  delete env.HUB_SKIP;
  return env;
}

function hubEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HUB_TRACK_SDK: "1",
    HUB_DELEGATED: "1",
    HUB_PORT: String(config.port),
    HUB_HOST_TARGET: "127.0.0.1",
  };
  delete env.HUB_SKIP;
  delete env.CLAUDE_CODE_SIMPLE;
  return env;
}

function withRunIds(env: NodeJS.ProcessEnv, req: RunRequest): NodeJS.ProcessEnv {
  if (req.taskId) env.HUB_TASK_ID = req.taskId;
  if (req.runId) env.HUB_RUN_ID = req.runId;
  if (req.portBase != null) {
    const range = portRangeOf(req.portBase);
    env.HUB_PORT_BASE = String(range.base);
    env.HUB_PORT_END = String(range.end);
  }
  return env;
}

function deniedToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value.map((item) => asObject(item)?.tool_name).filter(isString);
  return [...new Set(names)];
}

function toolSummary(input: unknown): string {
  const obj = asObject(input);
  if (!obj) return "";
  for (const key of ["command", "file_path", "pattern", "path", "url", "description", "prompt", "query"]) {
    const value = obj[key];
    if (isString(value) && value.trim().length > 0) return clip(value.trim(), MAX_TOOL_TEXT);
  }
  return "";
}

function ingestClaude(event: Json, state: StreamState): void {
  if (state.guard && observeStartup(state.guard, event) !== null) return;
  if (isString(event.session_id)) state.sessionId = event.session_id;
  if (isString(event.model)) state.effectiveModel = event.model;
  const message = asObject(event.message);
  if (message && isString(message.model)) state.effectiveModel = message.model;
  if (event.type === "system" && event.subtype === "init") state.emit({ kind: "status", text: "session started" });
  if (event.type === "stream_event") {
    const inner = asObject(event.event);
    const delta = inner ? asObject(inner.delta) : null;
    if (inner?.type === "content_block_delta" && delta?.type === "text_delta" && isString(delta.text)) {
      state.emit({ kind: "text", text: delta.text });
    }
    return;
  }
  if (event.type === "assistant" && message && Array.isArray(message.content)) {
    for (const part of message.content) {
      const block = asObject(part);
      if (block?.type === "tool_use" && isString(block.name)) {
        const summary = toolSummary(block.input);
        state.emit({ kind: "tool", text: summary ? `${block.name} ${summary}` : block.name });
      }
    }
    return;
  }
  if (event.type !== "result") return;
  state.sawResult = true;
  state.subtype = isString(event.subtype) ? event.subtype : null;
  state.errors = Array.isArray(event.errors) ? event.errors.filter(isString) : [];
  state.deniedTools = deniedToolNames(event.permission_denials);
  state.failed = state.subtype !== "success" || state.errors.length > 0;
  if (isString(event.result)) state.result = event.result.slice(0, MAX_RESULT_CHARS);
  state.emit({ kind: "status", text: state.failed ? `finished: ${state.subtype ?? "error"}` : "finished" });
}

function ingestCodex(event: Json, state: StreamState): void {
  const type = isString(event.type) ? event.type : "";
  if (type === "thread.started" && isString(event.thread_id)) {
    state.sessionId = event.thread_id;
    state.emit({ kind: "status", text: "thread started" });
  }
  const item = asObject(event.item);
  if (type === "item.started" && item) {
    if (item.type === "command_execution" && isString(item.command)) {
      state.emit({ kind: "tool", text: `$ ${clip(item.command, MAX_TOOL_TEXT)}` });
    }
    if (item.type === "file_change") state.emit({ kind: "tool", text: "editing files" });
  }
  if (type === "item.completed" && item) {
    if (item.type === "agent_message" && isString(item.text)) {
      state.result = item.text.slice(0, MAX_RESULT_CHARS);
      state.emit({ kind: "text", text: item.text });
    }
  }
  if (type === "turn.completed") {
    state.sawResult = true;
    state.subtype = "success";
    state.emit({ kind: "status", text: "finished" });
  }
  if (type === "error" && isString(event.message)) {
    state.errors.push(event.message);
    state.emit({ kind: "status", text: `error: ${clip(event.message, MAX_TOOL_TEXT)}` });
  }
  if (type === "turn.failed") {
    const error = asObject(event.error);
    state.errors.push(error && isString(error.message) ? error.message : "turn failed");
    state.sawResult = true;
    state.subtype = "turn.failed";
    state.failed = true;
  }
}

const guardScript = (): string => (config.resourceDir ? join(config.resourceDir, "hooks", "guard.mjs") : join(config.serverDir, "hooks", "guard.mjs"));

const hooksDir = (): string => (config.resourceDir ? join(config.resourceDir, "hooks") : join(config.serverDir, "hooks"));

const HUB_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "StopFailure", "SessionEnd", "SubagentStart", "SubagentStop"];

export function shareSettingsJson(guard: boolean): string {
  const notify = `"${config.nodeBin}" "${join(hooksDir(), "notify.mjs")}"`;
  const hooks: Record<string, unknown[]> = {};
  for (const event of HUB_HOOK_EVENTS) hooks[event] = [{ hooks: [{ type: "command", command: notify, timeout: 10 }] }];
  if (guard) hooks.PreToolUse = [{ hooks: [{ type: "command", command: `"${config.nodeBin}" "${guardScript()}"`, timeout: 15 }] }];
  return JSON.stringify({ hooks });
}

function guardSettings(): string {
  return shareSettingsJson(true);
}

function claudeSpec(req: RunRequest): ProcessSpec {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (req.resumeSessionId) {
    args.push("--resume", req.resumeSessionId);
    if (req.forkSession) args.push("--fork-session");
  } else if (req.sessionId) args.push("--session-id", req.sessionId);
  if (req.model) args.push("--model", req.model);
  if (req.permissionMode) args.push("--permission-mode", req.permissionMode);
  if (req.systemContext) args.push("--append-system-prompt", req.systemContext);
  if (req.maxTurns) args.push("--max-turns", String(req.maxTurns));
  if (req.restricted) args.push("--restricted");
  if (req.strictMcpConfig) args.push("--strict-mcp-config");
  if (req.permissionPrompts) args.push("--permission-prompts", req.permissionPrompts);
  if (req.tools && req.tools.length > 0) args.push("--tools", ...req.tools);
  if (req.guard) args.push("--settings", guardSettings());
  if (req.allowedTools && req.allowedTools.length > 0) args.push("--allowedTools", ...req.allowedTools);
  if (req.disallowedTools && req.disallowedTools.length > 0) args.push("--disallowedTools", ...req.disallowedTools);
  for (const dir of req.addDirs) args.push("--add-dir", dir);
  const env = withRunIds(req.guard ? shareEnv(req.guard === "shell", req.shareLabel ?? "share") : hubEnv(), req);
  const expected = startupExpectations({
    cwd: req.cwd,
    env,
    hooksViaSettings: Boolean(req.guard),
    guardHooks: Boolean(req.guard),
    strictMcpConfig: req.strictMcpConfig,
    restricted: req.restricted,
  });
  return {
    bin: config.claudeBin,
    args: [...config.claudeArgsPrefix, ...args],
    cwd: req.cwd,
    env,
    stdin: req.prompt,
    guard: createStartupGuard(expected),
    ingest: ingestClaude,
  };
}

function codexSpec(req: RunRequest): ProcessSpec {
  const args = req.resumeSessionId
    ? ["exec", "resume", req.resumeSessionId, "--json", "--skip-git-repo-check"]
    : ["exec", "--json", "--skip-git-repo-check", "-C", req.cwd];
  const bypass = req.sandbox === "danger-full-access";
  if (!req.resumeSessionId) {
    for (const dir of req.addDirs) args.push("--add-dir", dir);
    if (req.sandbox && !bypass) args.push("-s", req.sandbox);
  }
  if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
  else if (req.resumeSessionId && req.sandbox) args.push("-c", `sandbox_mode="${req.sandbox}"`);
  if (req.model) args.push("-m", req.model);
  args.push("-");
  const stdin = req.systemContext ? `${req.systemContext}\n\n---\n\n${req.prompt}` : req.prompt;
  return {
    bin: config.codexBin,
    args: [...config.codexArgsPrefix, ...args],
    cwd: req.cwd,
    env: withRunIds({ ...process.env }, req),
    stdin,
    guard: null,
    ingest: ingestCodex,
  };
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason.message;
  return isString(reason) ? reason : "cancelled";
}

function execute(spec: ProcessSpec, req: RunRequest): Promise<ExecutorResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(spec.bin, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      signal: req.signal,
    });

    const state: StreamState = {
      effectiveModel: null,
      sessionId: null,
      result: null,
      sawResult: false,
      failed: false,
      subtype: null,
      errors: [],
      deniedTools: [],
      guard: spec.guard,
      emit: (event) => {
        try {
          req.onEvent?.(event);
        } catch {
          return;
        }
      },
    };
    let droppedOutput = false;
    let stdoutBuffer = "";
    let stderr = "";
    let spawnError: string | null = null;
    let settled = false;
    let guardKilled = false;

    const stopOnGuard = (): void => {
      const error = state.guard?.error;
      if (!error || guardKilled) return;
      guardKilled = true;
      state.emit({ kind: "status", text: `error: ${clip(error, MAX_TOOL_TEXT)}` });
      if (child.exitCode === null) child.kill();
    };

    const consumeLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || state.guard?.error) return;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const event = asObject(parsed);
        if (event) spec.ingest(event, state);
      } catch {
        droppedOutput = true;
      }
      const warning = state.guard ? takeStartupWarning(state.guard) : null;
      if (warning) state.emit({ kind: "status", text: `warning: ${clip(warning, MAX_TOOL_TEXT)}` });
      stopOnGuard();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let index = stdoutBuffer.indexOf("\n");
      while (index >= 0) {
        consumeLine(stdoutBuffer.slice(0, index));
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        index = stdoutBuffer.indexOf("\n");
      }
      if (stdoutBuffer.length > MAX_LINE_CHARS) {
        stdoutBuffer = "";
        droppedOutput = true;
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr = (stderr + chunk).slice(0, MAX_STDERR_CHARS);
    });

    child.on("error", (err: Error) => {
      spawnError = err.message;
    });

    const failure = (exitCode: number | null): string => {
      if (spawnError) return spawnError;
      if (state.sawResult && state.failed) {
        const detail = state.errors.join("; ") || state.result || "no detail";
        return `${state.subtype ?? "error"}: ${detail}`;
      }
      if (state.errors.length > 0) return state.errors.join("; ");
      const stderrText = stderr.trim();
      if (stderrText.length > 0) return stderrText;
      if (!state.sawResult) {
        const suffix = droppedOutput ? " (oversized or malformed output was dropped)" : "";
        return `no result produced, exit code ${exitCode ?? "unknown"}${suffix}`;
      }
      return `exited with code ${exitCode ?? "unknown"}`;
    };

    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (stdoutBuffer.length > 0) consumeLine(stdoutBuffer);
      let status: RunOutcomeStatus;
      let error: string | null = null;
      if (req.signal?.aborted) {
        status = "cancelled";
        error = abortReason(req.signal);
      } else if (state.guard?.error) {
        status = "failed";
        error = state.guard.error;
      } else if (spawnError !== null || !state.sawResult || state.failed || exitCode !== 0) {
        status = "failed";
        error = failure(exitCode);
      } else if (state.deniedTools.length > 0) {
        status = "attention";
        error = `permission denied for: ${state.deniedTools.join(", ")}`;
      } else {
        status = "completed";
      }
      resolvePromise({
        status,
        result: state.result,
        effectiveModel: state.effectiveModel,
        sessionId: state.sessionId,
        exitCode,
        error,
      });
    };

    child.on("close", (code) => settle(code));
    child.stdin.on("error", () => undefined);
    child.stdin.end(spec.stdin);
  });
}

export function runTask(req: RunRequest): Promise<ExecutorResult> {
  const spec = req.runner === "codex" ? codexSpec(req) : claudeSpec(req);
  return execute(spec, req);
}
