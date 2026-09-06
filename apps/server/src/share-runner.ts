import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { shareEnv, shareSettingsJson } from "./executor.js";
import type { RunProfile } from "./share-types.js";

const MAX_LINE_CHARS = 4_000_000;
const MAX_RESULT_CHARS = 200_000;
const MAX_STALE_RETRIES = 2;
const STALE_SESSION = /no conversation found/i;
const VERSION_LINE = /^\s*v?\d+\.\d+\.\d+/;

export interface RunnerTarget {
  cwd: string;
  addDirs: string[];
  resumeSessionId: string | null;
  forkSession: boolean;
  artifactsRoot: string | null;
  profile: RunProfile;
  systemPrompt: string;
  model: string | null;
  label: string;
}

export interface RunnerEvent {
  kind: "text" | "tool" | "status";
  text: string;
}

export interface RunnerAnswer {
  ok: boolean;
  text: string | null;
  error: string | null;
  sessionId: string | null;
  established: boolean;
  denied: string[];
}

interface Pending {
  question: string;
  text: string;
  denied: string[];
  retries: number;
  onEvent: (event: RunnerEvent) => void;
  resolve: (answer: RunnerAnswer) => void;
  timer: NodeJS.Timeout;
}

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const isString = (value: unknown): value is string => typeof value === "string";

function toolSummary(input: unknown): string {
  const obj = asObject(input);
  if (!obj) return "";
  for (const key of ["command", "file_path", "pattern", "path", "url", "description", "prompt", "query"]) {
    const value = obj[key];
    if (isString(value) && value.trim().length > 0) return value.trim().slice(0, 200);
  }
  return "";
}

function userMessage(question: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: question }] } })}\n`;
}

export class ShareRunner {
  private child: ChildProcess | null = null;
  private buffer = "";
  private stderr = "";
  private pending: Pending | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private initSeen = false;
  private ownerStale = false;
  sessionId: string | null;
  spawns = 0;
  lastUsedAt = Date.now();

  constructor(
    readonly key: string,
    private readonly target: RunnerTarget,
    private readonly idleMs: number,
    private readonly questionTimeoutMs: number,
    private readonly onIdle: (runner: ShareRunner) => void,
  ) {
    this.sessionId = null;
  }

  get busy(): boolean {
    return this.pending !== null;
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  adopt(sessionId: string): void {
    this.sessionId = sessionId;
  }

  ask(question: string, onEvent: (event: RunnerEvent) => void): Promise<RunnerAnswer> {
    if (this.pending) return Promise.resolve(this.failure("another question is being answered"));
    this.lastUsedAt = Date.now();
    this.clearIdle();
    if (!this.alive) this.spawnProcess();
    const stdin = this.child?.stdin ?? null;
    if (!stdin) return Promise.resolve(this.failure("the answer process could not start"));
    return new Promise<RunnerAnswer>((resolve) => {
      const timer = setTimeout(() => this.finish(this.failure(`timed out after ${Math.round(this.questionTimeoutMs / 60_000)} min`), true), this.questionTimeoutMs);
      this.pending = { question, text: "", denied: [], retries: 0, onEvent, resolve, timer };
      this.send(question);
    });
  }

  kill(reason: string): void {
    this.clearIdle();
    const child = this.child;
    this.child = null;
    if (this.pending) this.finish(this.failure(reason), false);
    if (child && child.exitCode === null) child.kill();
  }

  private failure(error: string): RunnerAnswer {
    return { ok: false, text: null, error, sessionId: this.sessionId, established: this.initSeen, denied: [] };
  }

  private send(question: string): void {
    const stdin = this.child?.stdin ?? null;
    if (!stdin) {
      this.finish(this.failure("the answer process could not start"), true);
      return;
    }
    stdin.write(userMessage(question), (err) => {
      if (err) this.finish(this.failure(`could not send the question: ${err.message}`), true);
    });
  }

  private spawnProcess(): void {
    const { target } = this;
    const args = [...config.claudeArgsPrefix, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    if (this.sessionId) args.push("--resume", this.sessionId);
    else if (target.resumeSessionId && !this.ownerStale) args.push("--resume", target.resumeSessionId, "--fork-session");
    else args.push("--session-id", randomUUID());
    if (target.model) args.push("--model", target.model);
    args.push("--permission-mode", target.profile.permissionMode);
    args.push("--append-system-prompt", target.systemPrompt);
    if (target.profile.restricted) args.push("--restricted");
    if (target.profile.strictMcpConfig) args.push("--strict-mcp-config");
    if (target.profile.permissionPrompts) args.push("--permission-prompts", target.profile.permissionPrompts);
    if (target.profile.maxTurns) args.push("--max-turns", String(target.profile.maxTurns));
    if (target.profile.tools && target.profile.tools.length > 0) args.push("--tools", ...target.profile.tools);
    if (target.profile.allowedTools && target.profile.allowedTools.length > 0) args.push("--allowedTools", ...target.profile.allowedTools);
    if (target.profile.disallowedTools && target.profile.disallowedTools.length > 0) args.push("--disallowedTools", ...target.profile.disallowedTools);
    args.push("--settings", shareSettingsJson(target.profile.guard !== null));
    for (const dir of target.addDirs) args.push("--add-dir", dir);
    const child = spawn(config.claudeBin, args, {
      cwd: target.cwd,
      env: shareEnv(target.profile.guard === "shell", target.label, target.profile.guard === null, target.profile.artifactWrites ? target.artifactsRoot : null),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    this.buffer = "";
    this.stderr = "";
    this.initSeen = false;
    this.spawns += 1;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.consume(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    child.on("error", (err) => {
      if (this.child !== child) return;
      this.child = null;
      this.finish(this.failure(`could not start claude: ${err.message}`), false);
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.pending) return;
      if (!this.initSeen && STALE_SESSION.test(this.stderr) && this.restartStale()) return;
      const detail = this.stderr.trim().split(/\r?\n/).filter((line) => line.trim().length > 0 && !VERSION_LINE.test(line)).pop();
      this.finish(this.failure(detail ? `claude exited (${code ?? "?"}): ${detail}` : `claude exited with code ${code ?? "?"}`), false);
    });
    child.stdin?.on("error", () => undefined);
  }

  private restartStale(): boolean {
    const pending = this.pending;
    if (!pending || pending.retries >= MAX_STALE_RETRIES) return false;
    pending.retries += 1;
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill();
    if (this.sessionId) this.sessionId = null;
    else this.ownerStale = true;
    pending.text = "";
    pending.onEvent({ kind: "status", text: "session restarted" });
    this.spawnProcess();
    if (!this.alive) return false;
    this.send(pending.question);
    return true;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_CHARS) this.buffer = this.buffer.slice(-MAX_LINE_CHARS);
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let event: Json;
      try {
        event = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      this.handle(event);
    }
  }

  private staleResult(event: Json): boolean {
    if (event.type !== "result") return false;
    const errors = Array.isArray(event.errors) ? event.errors.filter(isString) : [];
    if (errors.some((item) => STALE_SESSION.test(item))) return true;
    return !this.initSeen && event.subtype === "error_during_execution" && event.num_turns === 0;
  }

  private handle(event: Json): void {
    if (this.staleResult(event)) {
      if (this.restartStale()) return;
      this.finish({ ...this.failure("the conversation to continue no longer exists"), sessionId: null, established: false }, true);
      return;
    }
    if (isString(event.session_id) && event.session_id.length > 0) this.sessionId = event.session_id;
    const pending = this.pending;
    if (event.type === "system" && event.subtype === "init") {
      this.initSeen = true;
      pending?.onEvent({ kind: "status", text: this.spawns > 1 ? "session resumed" : "session started" });
      return;
    }
    if (!pending) return;
    if (event.type === "stream_event") {
      if (isString(event.parent_tool_use_id) && event.parent_tool_use_id.length > 0) return;
      const inner = asObject(event.event);
      const delta = inner ? asObject(inner.delta) : null;
      if (inner?.type === "content_block_delta" && delta?.type === "text_delta" && isString(delta.text)) {
        pending.text += delta.text;
        pending.onEvent({ kind: "text", text: delta.text });
      }
      return;
    }
    const message = asObject(event.message);
    if (event.type === "assistant" && message && Array.isArray(message.content)) {
      for (const part of message.content) {
        const block = asObject(part);
        if (block?.type === "tool_use" && isString(block.name)) {
          const summary = toolSummary(block.input);
          pending.onEvent({ kind: "tool", text: summary ? `${block.name} ${summary}` : block.name });
        }
      }
      return;
    }
    if (event.type !== "result") return;
    const denied = Array.isArray(event.permission_denials)
      ? [...new Set(event.permission_denials.map((item) => asObject(item)?.tool_name).filter(isString))]
      : [];
    const errors = Array.isArray(event.errors) ? event.errors.filter(isString) : [];
    const failed = (isString(event.subtype) && event.subtype !== "success") || event.is_error === true || errors.length > 0;
    const text = isString(event.result) && event.result.length > 0 ? event.result : pending.text;
    this.finish(
      {
        ok: !failed,
        text: failed ? null : text.slice(0, MAX_RESULT_CHARS),
        error: failed ? (errors[0] ?? (isString(event.subtype) ? event.subtype : "the answer failed")) : null,
        sessionId: this.sessionId,
        established: this.initSeen,
        denied,
      },
      false,
    );
  }

  private finish(answer: RunnerAnswer, killProcess: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.onEvent({ kind: "status", text: answer.ok ? "finished" : `error: ${answer.error ?? "failed"}` });
    pending.resolve(answer);
    if (killProcess) {
      const child = this.child;
      this.child = null;
      if (child && child.exitCode === null) child.kill();
    }
    this.armIdle();
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      const child = this.child;
      this.child = null;
      if (child && child.exitCode === null) child.kill();
      this.onIdle(this);
    }, this.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

const runners = new Map<string, ShareRunner>();

export function runnerFor(key: string, target: RunnerTarget, adoptSessionId: string | null, idleMs: number, questionTimeoutMs: number): ShareRunner {
  const existing = runners.get(key);
  if (existing) return existing;
  const runner = new ShareRunner(key, target, idleMs, questionTimeoutMs, (idle) => {
    if (runners.get(key) === idle) runners.delete(key);
  });
  if (adoptSessionId) runner.adopt(adoptSessionId);
  runners.set(key, runner);
  return runner;
}

export function killRunners(prefix: string, reason: string): number {
  let count = 0;
  for (const [key, runner] of runners) {
    if (!key.startsWith(prefix)) continue;
    runner.kill(reason);
    runners.delete(key);
    count += 1;
  }
  return count;
}

export function killAllRunners(reason: string): void {
  for (const runner of runners.values()) runner.kill(reason);
  runners.clear();
}

export function liveRunners(): { key: string; sessionId: string | null; busy: boolean; alive: boolean; lastUsedAt: number }[] {
  return [...runners.values()].map((runner) => ({ key: runner.key, sessionId: runner.sessionId, busy: runner.busy, alive: runner.alive, lastUsedAt: runner.lastUsedAt }));
}
