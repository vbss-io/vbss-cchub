import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { config } from "./config.js";
import { getSession, getTrailState, listSessions, saveTrailState, type TrailStateRecord } from "./db.js";
import { getSettings } from "./delegation-store.js";
import type { DelegationSettings, TrailDetail, TrailFeatureSettings } from "./delegation-types.js";
import {
  countSessionBlocks,
  hubSection,
  localDate,
  localTime,
  readBlockBullets,
  registerTrailResolver,
  trailFilePath,
  upsertSessionBlock,
  withFileLockSync,
} from "./second-brain.js";
import { broadcast } from "./sse.js";
import type { SessionRecord } from "./types.js";

export type TrailTrigger = "stop" | "session_end";

export interface TrailLevel {
  window: number;
  throttleMinutes: number;
  throttleTurns: number;
  everyStop: boolean;
  minBullets: number;
  maxBullets: number;
  cap: number | null;
  maxWindows: number;
}

export const TRAIL_LEVELS: Record<TrailDetail, TrailLevel> = {
  light: { window: 120, throttleMinutes: 30, throttleTurns: 20, everyStop: false, minBullets: 1, maxBullets: 1, cap: 5, maxWindows: 3 },
  medium: { window: 80, throttleMinutes: 10, throttleTurns: 5, everyStop: false, minBullets: 1, maxBullets: 3, cap: null, maxWindows: 3 },
  high: { window: 60, throttleMinutes: 0, throttleTurns: 0, everyStop: true, minBullets: 1, maxBullets: 6, cap: null, maxWindows: 6 },
};

export const TRAIL_TURN_CLIP = 4000;
export const TRAIL_MODEL_TIMEOUT_MS = 90 * 1000;
export const TRAIL_MAX_BUDGET_USD = "0.10";
const HUB_RUN_CLIENTS = new Set(["hub", "share", "headless"]);

const LANGUAGE_RULE = "Output in the language of the user's prompts.";
const REDACT_RULE = "Mask any secret/credential/token/key/.env value with [REDACTED] and set redacted=true.";
const PATH_RULE = "Do not write absolute paths beyond the basename.";
const JSON_RULE = "Output JSON ONLY, no preamble.";
const VERB_RULE =
  "Start each bullet with a concrete verb (created, fixed, deployed, decided, investigating, exploring...). Direct, no filler.";
const NO_TOOLS_NOTICE = "You have no tools and no file access: summarize only the turns given; never ask questions.";
const REPO_RULE = "Name the repo/project if more than one was touched.";

const numbered = (rules: string[]): string[] => rules.map((rule, index) => `${index + 1}. ${rule}`);

const SYSTEM_PROMPTS: Record<TrailDetail, string> = {
  light: [
    "You summarize the NEW turns of an ongoing Claude Code session into exactly one bullet. Earlier turns are already summarized; yours will be APPENDED to that list.",
    NO_TOOLS_NOTICE,
    "Rules:",
    ...numbered([
      LANGUAGE_RULE,
      "Exactly 1 bullet, <= 100 chars, plain text. Always return exactly ONE bullet: when the window had no concrete outcome, describe what was being worked on, phrased as in-progress (e.g. 'investigando o bug de timezone').",
      "Prefer concrete outcomes: finished fixes, milestones, deliverables, decisions, root causes, deploys.",
      VERB_RULE,
      REPO_RULE,
      REDACT_RULE,
      PATH_RULE,
      JSON_RULE,
    ]),
  ].join("\n"),
  medium: [
    "You summarize the NEW turns of an ongoing Claude Code session into a few bullets. Earlier turns are already summarized; yours will be APPENDED to that list.",
    NO_TOOLS_NOTICE,
    "Rules:",
    ...numbered([
      LANGUAGE_RULE,
      "1-3 bullets, each <= 100 chars, plain text. Always return at least ONE bullet.",
      "Prefer concrete outcomes: finished fixes, milestones, deliverables, decisions, root causes, deploys.",
      "If the window had NO concrete outcome (only reading/exploration/planning/intermediate steps), return exactly ONE bullet describing what was being worked on, phrased as in-progress, e.g. 'investigando o bug de timezone', 'explorando a config do hook'.",
      VERB_RULE,
      REPO_RULE,
      REDACT_RULE,
      PATH_RULE,
      JSON_RULE,
    ]),
  ].join("\n"),
  high: [
    "You summarize the NEW turns of an ongoing Claude Code session into detailed bullets. Earlier turns are already summarized; yours will be APPENDED to that list.",
    NO_TOOLS_NOTICE,
    "Rules:",
    ...numbered([
      LANGUAGE_RULE,
      "3-6 bullets, each <= 140 chars, plain text. Always return at least THREE bullets.",
      "Cover concrete outcomes (fixes, milestones, deliverables, decisions, root causes, deploys), the files and repos touched, and the commands that mattered (tests, builds, git, deploys).",
      "If the window had NO concrete outcome, describe what was being worked on, phrased as in-progress.",
      VERB_RULE,
      REPO_RULE,
      REDACT_RULE,
      "Use basenames for files and paths, never absolute paths.",
      JSON_RULE,
    ]),
  ].join("\n"),
};

const REWRITE_PROMPT = (cap: number): string =>
  [
    "You compress the running bullet list of one Claude Code session. You receive the EXISTING bullets and the NEW bullets from the latest window.",
    NO_TOOLS_NOTICE,
    "Rules:",
    ...numbered([
      LANGUAGE_RULE.replace("user's prompts", "bullets"),
      `Rewrite everything into at most ${cap} bullets, chronological, each <= 100 chars, plain text. Always return at least ONE bullet.`,
      "Merge related bullets and keep the concrete outcomes: finished fixes, milestones, deliverables, decisions, root causes, deploys.",
      REDACT_RULE,
      JSON_RULE,
    ]),
  ].join("\n");

export function systemPromptFor(settings: TrailFeatureSettings): string {
  return settings.prompt ?? SYSTEM_PROMPTS[settings.detail];
}

export function schemaFor(minBullets: number, maxBullets: number): Record<string, unknown> {
  return {
    type: "object",
    required: ["language", "bullets", "redacted"],
    properties: {
      language: { type: "string" },
      bullets: { type: "array", items: { type: "string" }, minItems: minBullets, maxItems: maxBullets },
      redacted: { type: "boolean" },
    },
    additionalProperties: false,
  };
}

export interface TrailTurn {
  role: "user" | "assistant";
  text: string;
  rawIdx: number;
}

export function extractText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as { type?: unknown; text?: unknown; name?: unknown };
    if (part.type === "text" && typeof part.text === "string" && part.text) parts.push(part.text);
    else if (part.type === "tool_use" && typeof part.name === "string" && part.name) parts.push(`[tool ${part.name}]`);
  }
  return parts.join("\n").trim();
}

export function readTurns(raw: string, fromIndex: number): { turns: TrailTurn[]; totalRaw: number } {
  const turns: TrailTurn[] = [];
  let rawIdx = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: { type?: unknown; message?: unknown };
    try {
      entry = JSON.parse(line) as { type?: unknown; message?: unknown };
    } catch {
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const idx = rawIdx++;
    if (idx < fromIndex) continue;
    const text = extractText(entry.message);
    if (!text) continue;
    turns.push({ role: entry.type, text: text.slice(0, TRAIL_TURN_CLIP), rawIdx: idx });
  }
  return { turns, totalRaw: rawIdx };
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bxox[bapors]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{32,42}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /:\/\/[^/:\s]+:[^@\s]+@/g,
  /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|bearer|password|passwd|pwd|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{12,}["']?/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
];

export function redact(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, () => {
      redacted = true;
      return "[REDACTED]";
    });
  }
  return { text: out, redacted };
}

export interface TrailBlockInput {
  sessionId: string;
  cwd: string;
  startedHHMM: string;
  updatedHHMM: string;
  turns: number;
  bullets: string[];
  redacted: boolean;
  partialThrough: number;
}

export function buildBlock(input: TrailBlockInput): string {
  const badge = input.redacted ? " ⚠️ redacted" : "";
  const partial = input.partialThrough ? ` · parcial até turn ${input.partialThrough}` : "";
  const heading = `## \`${input.sessionId.slice(0, 8)}\` · ${input.startedHHMM} → ${input.updatedHHMM} · ${input.turns} turns${partial}${badge}`;
  const list = input.bullets.length > 0 ? input.bullets.map((bullet) => `- ${bullet}`).join("\n") : "_(sem detalhe capturado)_";
  return [
    `<!-- session:${input.sessionId} START -->`,
    "",
    heading,
    "",
    `\`${input.cwd}\``,
    "",
    list,
    "",
    `<!-- session:${input.sessionId} END -->`,
  ].join("\n");
}

export function readBlockStart(content: string, sessionId: string): string | null {
  const startIdx = content.indexOf(`<!-- session:${sessionId} START -->`);
  if (startIdx === -1) return null;
  const match = /^## `[^`]*` · (\d{2}:\d{2}) →/m.exec(content.slice(startIdx));
  return match?.[1] ?? null;
}

export function shouldSummarize(
  state: Pick<TrailStateRecord, "lastTurns" | "lastUpdate"> | null,
  now: number,
  turns: number,
  kind: TrailTrigger,
  level: TrailDetail,
): boolean {
  if (!state) return turns > 0;
  const turnsDiff = turns - state.lastTurns;
  if (turnsDiff <= 0) return false;
  if (kind === "session_end") return true;
  const rules = TRAIL_LEVELS[level];
  if (rules.everyStop) return true;
  const minutesSince = (now - state.lastUpdate) / 60_000;
  return minutesSince >= rules.throttleMinutes || turnsDiff >= rules.throttleTurns;
}

export function trailDirFor(root: string, trail: Pick<TrailFeatureSettings, "dir">): string {
  if (!trail.dir) return join(root, "trail");
  return isAbsolute(trail.dir) ? trail.dir : join(root, trail.dir);
}

export function trailDir(settings: DelegationSettings): string | null {
  return settings.secondBrainRoot ? trailDirFor(settings.secondBrainRoot, settings.trail) : null;
}

registerTrailResolver((root) => {
  const settings = getSettings();
  if (!settings.features.trail) return null;
  return { dir: trailDirFor(root, settings.trail), unified: settings.trail.hubEvents };
});

export function isHubRun(session: SessionRecord): boolean {
  return (
    (session.client !== null && HUB_RUN_CLIENTS.has(session.client)) ||
    session.shareLabel !== null ||
    session.forkOf !== null
  );
}

function modelEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_HOOK_BYPASS: "1", HUB_SKIP: "1" };
  for (const key of ["HUB_TASK_ID", "HUB_RUN_ID", "HUB_DELEGATED", "HUB_TRACK_SDK"]) delete env[key];
  return env;
}

interface ModelOutcome {
  out: string | null;
  error: string | null;
}

function runClaude(args: string[], stdin: string): Promise<ModelOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ModelOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const child = spawn(config.claudeBin, [...config.claudeArgsPrefix, ...args], {
      cwd: config.dataDir,
      env: modelEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ out: null, error: "model call timed out" });
    }, TRAIL_MODEL_TIMEOUT_MS);
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      err = `${err}${chunk}`.slice(-400);
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (spawnErr) => finish({ out: null, error: `model spawn failed: ${spawnErr.message}` }));
    child.on("close", (code) =>
      finish(code === 0 ? { out, error: null } : { out: null, error: `model exited ${code}${err ? `: ${err.trim()}` : ""}` }),
    );
    child.stdin.end(stdin);
  });
}

interface ModelPayload {
  language: string;
  bullets: string[];
  redacted: boolean;
}

export function parseModelOutput(raw: string): ModelPayload | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  let payload: unknown = parsed.structured_output;
  if (!payload && typeof parsed.result === "string") {
    try {
      payload = JSON.parse(parsed.result);
    } catch {
      payload = null;
    }
  }
  if (!payload && parsed.bullets) payload = parsed;
  const value = payload as { language?: unknown; bullets?: unknown; redacted?: unknown } | null;
  if (!value || !Array.isArray(value.bullets)) return null;
  return {
    language: String(value.language ?? "en"),
    bullets: value.bullets.map((bullet) => String(bullet)),
    redacted: Boolean(value.redacted),
  };
}

let lastError: string | null = null;

function noteError(message: string): void {
  if (lastError !== message) console.error(`session trail: ${message}`);
  lastError = message;
}

async function callModel(
  system: string,
  user: string,
  schema: Record<string, unknown>,
  model: string | null,
): Promise<ModelPayload | null> {
  const args = ["--print"];
  if (model) args.push("--model", model);
  args.push(
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--tools",
    "",
    "--effort",
    "low",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(schema),
    "--system-prompt",
    system,
    "--max-budget-usd",
    TRAIL_MAX_BUDGET_USD,
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await runClaude(args, user);
    if (outcome.out === null) {
      noteError(outcome.error ?? "model call failed");
      continue;
    }
    const payload = parseModelOutput(outcome.out);
    if (!payload) {
      noteError("model output was not usable");
      continue;
    }
    if (payload.bullets.some((bullet) => bullet.trim().length > 0)) return payload;
    noteError("model returned no bullets");
  }
  return null;
}

const baseName = (path: string | null): string => (path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

export function windowPrompt(turns: TrailTurn[], cwd: string | null): string {
  const compact = turns.map((turn) => `<${turn.role}>\n${turn.text}\n</${turn.role}>`).join("\n\n");
  return [`Session cwd: ${baseName(cwd)}`, "", "New turns:", compact].join("\n");
}

export function rewritePrompt(existing: string[], added: string[]): string {
  return [
    "Existing bullets:",
    ...existing.map((bullet) => `- ${bullet}`),
    "",
    "New bullets:",
    ...added.map((bullet) => `- ${bullet}`),
  ].join("\n");
}

interface CleanBullets {
  bullets: string[];
  redacted: boolean;
}

function cleanBullets(payload: ModelPayload, limit: number): CleanBullets {
  let redacted = payload.redacted;
  const bullets: string[] = [];
  for (const bullet of payload.bullets) {
    const result = redact(bullet.replace(/\s*\n\s*/g, " "));
    if (result.redacted) redacted = true;
    const text = result.text.trim();
    if (text.length > 0) bullets.push(text);
  }
  return { bullets: bullets.slice(0, limit), redacted };
}

interface TrailJob {
  sessionId: string;
  kind: TrailTrigger;
  force: boolean;
}

const queue = new Map<string, TrailJob>();
let running: { sessionId: string; since: number } | null = null;
let draining = false;
let idleWaiters: (() => void)[] = [];

function trailEnabled(): { settings: DelegationSettings; root: string } | null {
  const settings = getSettings();
  const root = settings.secondBrainRoot;
  return settings.features.trail && root ? { settings, root } : null;
}

async function summarizeSession(job: TrailJob): Promise<void> {
  const enabled = trailEnabled();
  if (!enabled) return;
  const { settings } = enabled;
  const dir = trailDir(settings);
  const session = getSession(job.sessionId);
  if (!dir || !session?.transcriptPath || isHubRun(session)) return;
  let raw: string;
  try {
    raw = await readFile(session.transcriptPath, "utf8");
  } catch {
    return;
  }
  const state = getTrailState(job.sessionId);
  const level = settings.trail.detail;
  const rules = TRAIL_LEVELS[level];
  const startFrom = state ? state.lastTurns : Math.max(0, readTurns(raw, Number.MAX_SAFE_INTEGER).totalRaw - rules.window);
  const { turns: delta, totalRaw } = readTurns(raw, startFrom);
  const now = Date.now();
  const due = job.force ? !state || totalRaw > state.lastTurns : shouldSummarize(state, now, totalRaw, job.kind, level);
  if (!due) return;
  const today = localDate(new Date(now));
  const firstStarted = state?.firstStarted ?? session.startedAt ?? now;
  const checkpoint = (lastTurns: number, bullets: number): void =>
    saveTrailState({
      sessionId: job.sessionId,
      lastTurns: Math.max(state?.lastTurns ?? 0, lastTurns),
      firstStarted,
      lastUpdate: Date.now(),
      bulletsToday: bullets,
      day: today,
    });
  const file = trailFilePath(dir, today);
  const existingContent = existsSync(file) ? readFileSync(file, "utf8") : "";
  let working = readBlockBullets(existingContent, job.sessionId);
  if (delta.length === 0) {
    checkpoint(totalRaw, working.length);
    return;
  }
  let anyRedacted = working.some((bullet) => bullet.includes("[REDACTED]"));
  const system = systemPromptFor(settings.trail);
  const schema = schemaFor(rules.minBullets, rules.maxBullets);
  let processedThrough = startFrom;
  let successfulWindows = 0;
  let brokeEarly = false;
  let capped = false;
  for (let index = 0; index < delta.length; index += rules.window) {
    if (successfulWindows >= rules.maxWindows) {
      capped = true;
      break;
    }
    const windowTurns = delta.slice(index, index + rules.window);
    const payload = await callModel(system, windowPrompt(windowTurns, session.cwd), schema, settings.trail.model);
    if (!payload) {
      brokeEarly = true;
      break;
    }
    const added = cleanBullets(payload, rules.maxBullets);
    let next = working.concat(added.bullets);
    let redactedNow = added.redacted;
    if (rules.cap !== null && next.length > rules.cap) {
      const rewritten = await callModel(REWRITE_PROMPT(rules.cap), rewritePrompt(working, added.bullets), schemaFor(1, rules.cap), settings.trail.model);
      if (!rewritten) {
        brokeEarly = true;
        break;
      }
      const compact = cleanBullets(rewritten, rules.cap);
      next = compact.bullets.length > 0 ? compact.bullets : next.slice(-rules.cap);
      redactedNow = redactedNow || compact.redacted;
    }
    working = next;
    if (redactedNow) anyRedacted = true;
    successfulWindows++;
    processedThrough = (windowTurns[windowTurns.length - 1]?.rawIdx ?? processedThrough) + 1;
  }
  const incomplete = brokeEarly || capped;
  if (!incomplete) processedThrough = totalRaw;
  if (successfulWindows === 0) return;
  if (!incomplete) lastError = null;
  if (working.length > 0 || existingContent.includes(`<!-- session:${job.sessionId} START -->`)) {
    const startedHHMM =
      readBlockStart(existingContent, job.sessionId) ??
      (localDate(new Date(firstStarted)) === today ? localTime(new Date(firstStarted)) : localTime(new Date(now)));
    const block = buildBlock({
      sessionId: job.sessionId,
      cwd: session.cwd ?? "",
      startedHHMM,
      updatedHHMM: localTime(new Date()),
      turns: totalRaw,
      bullets: working,
      redacted: anyRedacted,
      partialThrough: incomplete ? processedThrough : 0,
    });
    mkdirSync(dirname(file), { recursive: true });
    withFileLockSync(file, () => upsertSessionBlock(file, job.sessionId, today, block));
  }
  checkpoint(processedThrough, working.length);
  broadcast("trail", { date: today, sessionId: job.sessionId, bullets: working.length });
}

function releaseIdle(): void {
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const resolve of waiters) resolve();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      const next = queue.values().next();
      if (next.done) break;
      const job = next.value;
      queue.delete(job.sessionId);
      running = { sessionId: job.sessionId, since: Date.now() };
      try {
        await summarizeSession(job);
      } catch (err) {
        noteError(err instanceof Error ? err.message : String(err));
      } finally {
        running = null;
      }
    }
  } finally {
    draining = false;
    releaseIdle();
  }
}

export function scheduleTrail(sessionId: string, kind: TrailTrigger, force = false): boolean {
  if (!trailEnabled()) return false;
  const pending = queue.get(sessionId);
  queue.set(sessionId, {
    sessionId,
    kind: pending?.kind === "session_end" || kind === "session_end" ? "session_end" : "stop",
    force: (pending?.force ?? false) || force,
  });
  setImmediate(() => void drain());
  return true;
}

export function whenTrailIdle(): Promise<void> {
  if (!draining && queue.size === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

export function flushTrail(sessionId: string | null): number {
  if (!trailEnabled()) return 0;
  const targets = sessionId
    ? [getSession(sessionId)]
    : listSessions().filter((session) => session.status !== "ended");
  let scheduled = 0;
  for (const session of targets) {
    if (!session?.transcriptPath || isHubRun(session)) continue;
    if (scheduleTrail(session.sessionId, "stop", true)) scheduled++;
  }
  return scheduled;
}

export interface TrailStatus {
  enabled: boolean;
  dir: string | null;
  detail: TrailDetail;
  model: string | null;
  hubEvents: boolean;
  today: { path: string | null; exists: boolean; sessions: number; hubLines: number };
  queue: number;
  running: { sessionId: string; since: number } | null;
  lastError: string | null;
}

export function trailStatus(now = new Date()): TrailStatus {
  const settings = getSettings();
  const dir = trailDir(settings);
  const path = dir ? trailFilePath(dir, localDate(now)) : null;
  const exists = path !== null && existsSync(path);
  const content = exists && path ? readFileSync(path, "utf8") : "";
  const hub = hubSection(content);
  return {
    enabled: settings.features.trail,
    dir,
    detail: settings.trail.detail,
    model: settings.trail.model,
    hubEvents: settings.trail.hubEvents,
    today: {
      path,
      exists,
      sessions: countSessionBlocks(content),
      hubLines: hub ? hub.split("\n").filter((line) => line.startsWith("- ")).length : 0,
    },
    queue: queue.size,
    running,
    lastError,
  };
}
