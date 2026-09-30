import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "./config.js";

export type UsageProvider = "claude" | "codex";

export interface UsageRecord {
  provider: UsageProvider;
  at: number;
  model: string;
  sessionId: string;
  project: string;
  cwd: string | null;
  read: number;
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
  sidechain: boolean;
}

export interface UsageTotals {
  read: number;
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  messages: number;
}

export interface UsageDay {
  day: string;
  claude: UsageTotals;
  codex: UsageTotals;
}

export interface UsageModelRow extends UsageTotals {
  model: string;
  provider: UsageProvider;
}

export interface UsageProjectRow extends UsageTotals {
  project: string;
  provider: UsageProvider;
  sessions: number;
}

export interface UsageSessionRow extends UsageTotals {
  sessionId: string;
  provider: UsageProvider;
  project: string;
  cwd: string | null;
  title: string | null;
  avgContext: number;
  p50Context: number;
  p90Context: number;
  maxContext: number;
  firstAt: number;
  lastAt: number;
}

export interface UsageContext {
  avgPerMessage: number;
  p50: number;
  p90: number;
  max: number;
  over300k: number;
  over600k: number;
}

export interface UsageAggregate {
  days: number;
  from: number;
  to: number;
  totals: UsageTotals;
  byProvider: Record<UsageProvider, UsageTotals>;
  byDay: UsageDay[];
  byModel: UsageModelRow[];
  byProject: UsageProjectRow[];
  bySession: UsageSessionRow[];
  context: UsageContext;
  sidechainShare: number;
  costs: null;
}

export type UsageTitleResolver = (provider: UsageProvider, sessionId: string) => string | null;

export interface UsageScan {
  records: UsageRecord[];
  files: number;
  parsed: number;
  ms: number;
}

export interface CollectOptions {
  days: number;
  now?: number;
  claudeDir?: string;
  codexDir?: string;
}

type Json = Record<string, unknown>;

const TOP_PROJECTS = 12;
const TOP_SESSIONS = 15;
const CONTEXT_STEPS = { over300k: 300_000, over600k: 600_000 } as const;
const CHUNK_BYTES = 262_144;
const YIELD_AFTER_MS = 8;

const asObject = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function parseObject(text: string): Json | null {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
}

const interned = new Map<string, string>();

function intern(value: string): string {
  const known = interned.get(value);
  if (known !== undefined) return known;
  interned.set(value, value);
  return value;
}

export const emptyTotals = (): UsageTotals => ({ read: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, messages: 0 });

function addRecord(totals: UsageTotals, record: UsageRecord): void {
  totals.read += record.read;
  totals.fresh += record.fresh;
  totals.cacheRead += record.cacheRead;
  totals.cacheWrite += record.cacheWrite;
  totals.output += record.output;
  totals.messages += 1;
}

export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

const sortAscending = (values: number[]): number[] => values.sort((a, b) => a - b);

export function windowStart(days: number, now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

export function localDay(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

interface FileParser {
  markers: Buffer[];
  feed(line: string): void;
  records(): UsageRecord[];
}

function claudeParser(project: string, fallbackSession: string, sidechainFile: boolean): FileParser {
  const byMessage = new Map<string, UsageRecord>();
  let anonymous = 0;
  return {
    markers: [Buffer.from('"usage"')],
    feed(line) {
      const entry = parseObject(line);
      if (!entry || entry.type !== "assistant") return;
      const message = asObject(entry.message);
      const usage = message ? asObject(message.usage) : null;
      if (!message || !usage) return;
      const model = asString(message.model);
      if (!model || model === "<synthetic>") return;
      const at = Date.parse(asString(entry.timestamp) ?? "");
      if (Number.isNaN(at)) return;
      const input = asNumber(usage.input_tokens);
      const cacheRead = asNumber(usage.cache_read_input_tokens);
      const cacheWrite = asNumber(usage.cache_creation_input_tokens);
      const output = asNumber(usage.output_tokens);
      if (input + cacheRead + cacheWrite + output === 0) return;
      const details = asObject(usage.output_tokens_details);
      const key = asString(message.id) ?? asString(entry.uuid) ?? `anonymous-${anonymous++}`;
      const cwd = asString(entry.cwd);
      byMessage.set(key, {
        provider: "claude",
        at,
        model: intern(model),
        sessionId: intern(asString(entry.sessionId) ?? fallbackSession),
        project,
        cwd: cwd === null ? null : intern(cwd),
        read: input + cacheRead + cacheWrite,
        fresh: input,
        cacheRead,
        cacheWrite,
        output,
        thinking: details ? asNumber(details.thinking_tokens) : 0,
        sidechain: sidechainFile || entry.isSidechain === true,
      });
    },
    records: () => Array.from(byMessage.values()),
  };
}

interface CodexTurn {
  at: number;
  model: string;
  read: number;
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  thinking: number;
}

function codexParser(fallbackSession: string): FileParser {
  const turns: CodexTurn[] = [];
  let sessionId: string | null = null;
  let metaSeen = false;
  let cwd: string | null = null;
  let model = "unknown";
  let previousTotal: number | null = null;
  return {
    markers: [Buffer.from('"token_count"'), Buffer.from('"turn_context"'), Buffer.from('"session_meta"')],
    feed(line) {
      const entry = parseObject(line);
      const payload = entry ? asObject(entry.payload) : null;
      if (!entry || !payload) return;
      if (entry.type === "session_meta") {
        if (metaSeen) return;
        metaSeen = true;
        sessionId = asString(payload.id) ?? asString(payload.session_id);
        cwd = asString(payload.cwd) ?? cwd;
        return;
      }
      if (entry.type === "turn_context") {
        model = asString(payload.model) ?? model;
        cwd = cwd ?? asString(payload.cwd);
        return;
      }
      if (entry.type !== "event_msg" || payload.type !== "token_count") return;
      const info = asObject(payload.info);
      const last = info ? asObject(info.last_token_usage) : null;
      if (!info || !last) return;
      const total = asObject(info.total_token_usage);
      const totalTokens = total ? asNumber(total.total_tokens) : null;
      if (totalTokens !== null && totalTokens === previousTotal) return;
      previousTotal = totalTokens;
      const at = Date.parse(asString(entry.timestamp) ?? "");
      if (Number.isNaN(at)) return;
      const input = asNumber(last.input_tokens);
      const cacheRead = asNumber(last.cached_input_tokens);
      const cacheWrite = asNumber(last.cache_write_input_tokens);
      const output = asNumber(last.output_tokens);
      if (input + output === 0) return;
      turns.push({
        at,
        model: intern(model),
        read: input,
        fresh: Math.max(0, input - cacheRead - cacheWrite),
        cacheRead,
        cacheWrite,
        output,
        thinking: asNumber(last.reasoning_output_tokens),
      });
    },
    records() {
      const session = intern(sessionId ?? fallbackSession);
      const path = cwd === null ? null : intern(cwd);
      const project = intern(path === null ? "unknown" : (basename(path.replace(/[\\/]+$/, "").replace(/\\/g, "/")) || path));
      return turns.map((turn) => ({
        provider: "codex" as const,
        at: turn.at,
        model: turn.model,
        sessionId: session,
        project,
        cwd: path,
        read: turn.read,
        fresh: turn.fresh,
        cacheRead: turn.cacheRead,
        cacheWrite: turn.cacheWrite,
        output: turn.output,
        thinking: turn.thinking,
        sidechain: false,
      }));
    },
  };
}

interface SourceFile {
  path: string;
  provider: UsageProvider;
  project: string;
  fallbackSession: string;
  sidechain: boolean;
  size: number;
  mtimeMs: number;
}

type Listing = Omit<SourceFile, "size" | "mtimeMs">;

interface CacheEntry {
  size: number;
  mtimeMs: number;
  offset: number;
  parser: FileParser;
  records: UsageRecord[];
}

const fileCache = new Map<string, CacheEntry>();
const scanStats = { parses: 0, generation: 0, lastScan: null as { files: number; parsed: number; ms: number } | null };

export function usageScanStats(): { parses: number; cachedFiles: number; lastScan: { files: number; parsed: number; ms: number } | null } {
  return { parses: scanStats.parses, cachedFiles: fileCache.size, lastScan: scanStats.lastScan };
}

export function resetUsageCache(): void {
  scanStats.generation += 1;
  fileCache.clear();
  interned.clear();
}

async function entriesOf(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function walkJsonl(dir: string, accept: (name: string) => boolean, out: string[]): Promise<void> {
  for (const entry of await entriesOf(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonl(path, accept, out);
    else if (entry.isFile() && accept(entry.name)) out.push(path);
  }
}

async function listClaude(root: string): Promise<Listing[]> {
  const out: Listing[] = [];
  for (const projectEntry of await entriesOf(root)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = join(root, projectEntry.name);
    const project = intern(projectEntry.name);
    for (const entry of await entriesOf(projectDir)) {
      const path = join(projectDir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push({ path, provider: "claude", project, fallbackSession: entry.name.slice(0, -".jsonl".length), sidechain: false });
      } else if (entry.isDirectory()) {
        const subagents: string[] = [];
        await walkJsonl(join(path, "subagents"), (name) => name.endsWith(".jsonl"), subagents);
        for (const file of subagents) {
          out.push({ path: file, provider: "claude", project, fallbackSession: entry.name, sidechain: true });
        }
      }
    }
  }
  return out;
}

async function listCodex(root: string): Promise<Listing[]> {
  const files: string[] = [];
  await walkJsonl(root, (name) => name.endsWith(".jsonl"), files);
  return files.map((path) => ({
    path,
    provider: "codex" as const,
    project: "",
    fallbackSession: basename(path, ".jsonl"),
    sidechain: false,
  }));
}

async function statAll(listing: Listing[]): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (let index = 0; index < listing.length; index += 64) {
    const batch = listing.slice(index, index + 64);
    const stats = await Promise.all(
      batch.map(async (item) => {
        try {
          const info = await stat(item.path);
          return { ...item, size: info.size, mtimeMs: info.mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    for (const item of stats) if (item) out.push(item);
  }
  return out;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function firstMarkerAt(line: Buffer, markers: readonly Buffer[]): boolean {
  for (const marker of markers) if (line.includes(marker)) return true;
  return false;
}

async function feedFile(path: string, from: number, parser: FileParser): Promise<number> {
  const stream = createReadStream(path, { start: from, highWaterMark: CHUNK_BYTES });
  let carry: Buffer = Buffer.alloc(0);
  let read = 0;
  let sliceStart = performance.now();
  for await (const chunk of stream) {
    const data = chunk as Buffer;
    read += data.length;
    const buffer = carry.length > 0 ? Buffer.concat([carry, data]) : data;
    let position = 0;
    for (;;) {
      const newline = buffer.indexOf(10, position);
      if (newline === -1) break;
      const line = buffer.subarray(position, newline);
      if (line.length > 0 && firstMarkerAt(line, parser.markers)) parser.feed(line.toString("utf8"));
      position = newline + 1;
    }
    carry = position === buffer.length ? Buffer.alloc(0) : Buffer.from(buffer.subarray(position));
    if (performance.now() - sliceStart > YIELD_AFTER_MS) {
      await yieldToLoop();
      sliceStart = performance.now();
    }
  }
  if (carry.length > 0) {
    const tail = carry.toString("utf8").trim();
    if (tail.length > 0 && parseObject(tail) !== null) {
      if (firstMarkerAt(carry, parser.markers)) parser.feed(tail);
      carry = Buffer.alloc(0);
    }
  }
  return from + read - carry.length;
}

function parserFor(file: SourceFile): FileParser {
  return file.provider === "claude"
    ? claudeParser(file.project, file.fallbackSession, file.sidechain)
    : codexParser(file.fallbackSession);
}

async function refresh(file: SourceFile): Promise<boolean> {
  const cached = fileCache.get(file.path);
  if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) return false;
  const generation = scanStats.generation;
  const resume = cached !== undefined && file.size > cached.size;
  const parser = resume ? cached.parser : parserFor(file);
  scanStats.parses += 1;
  const offset = await feedFile(file.path, resume ? cached.offset : 0, parser);
  if (generation !== scanStats.generation) return true;
  fileCache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, offset, parser, records: parser.records() });
  return true;
}

async function scan(options: CollectOptions): Promise<UsageScan> {
  const started = performance.now();
  const now = options.now ?? Date.now();
  const from = windowStart(options.days, now);
  const listing = [
    ...(await listClaude(options.claudeDir ?? config.claudeProjectsDir)),
    ...(await listCodex(options.codexDir ?? config.codexSessionsDir)),
  ];
  const files = await statAll(listing);
  const seen = new Set<string>();
  const records: UsageRecord[] = [];
  let considered = 0;
  let parsed = 0;
  for (const file of files) {
    seen.add(file.path);
    if (file.mtimeMs < from) continue;
    considered += 1;
    try {
      if (await refresh(file)) parsed += 1;
    } catch {
      continue;
    }
    const entry = fileCache.get(file.path);
    if (!entry) continue;
    for (const record of entry.records) if (record.at >= from) records.push(record);
  }
  for (const path of fileCache.keys()) if (!seen.has(path)) fileCache.delete(path);
  const ms = Math.round(performance.now() - started);
  if (parsed > 0) {
    scanStats.lastScan = { files: considered, parsed, ms };
    console.log(`[usage] scanned ${considered} files (${parsed} parsed) in ${ms}ms`);
  }
  return { records, files: considered, parsed, ms };
}

const inflight = new Map<string, Promise<UsageScan>>();
let queue: Promise<unknown> = Promise.resolve();

export function collectUsage(options: CollectOptions): Promise<UsageScan> {
  const key = `${options.days}|${options.claudeDir ?? ""}|${options.codexDir ?? ""}`;
  const running = inflight.get(key);
  if (running) return running;
  const next = queue.then(() => scan(options));
  queue = next.catch(() => undefined);
  const tracked = next.finally(() => {
    if (inflight.get(key) === tracked) inflight.delete(key);
  });
  inflight.set(key, tracked);
  return tracked;
}

interface SessionAccumulator {
  totals: UsageTotals;
  contexts: number[];
  project: string;
  cwd: string | null;
  sessionId: string;
  provider: UsageProvider;
  firstAt: number;
  lastAt: number;
}

function emptyDays(days: number, now: number): Map<string, UsageDay> {
  const map = new Map<string, UsageDay>();
  const cursor = new Date(windowStart(days, now));
  for (let index = 0; index < days; index += 1) {
    const day = localDay(cursor.getTime());
    map.set(day, { day, claude: emptyTotals(), codex: emptyTotals() });
    cursor.setDate(cursor.getDate() + 1);
  }
  return map;
}

export function aggregateUsage(
  records: readonly UsageRecord[],
  options: { days: number; now?: number; titleOf?: UsageTitleResolver },
): UsageAggregate {
  const now = options.now ?? Date.now();
  const from = windowStart(options.days, now);
  const totals = emptyTotals();
  const byProvider: Record<UsageProvider, UsageTotals> = { claude: emptyTotals(), codex: emptyTotals() };
  const byDay = emptyDays(options.days, now);
  const byModel = new Map<string, UsageModelRow>();
  const byProject = new Map<string, UsageProjectRow & { sessionIds: Set<string> }>();
  const bySession = new Map<string, SessionAccumulator>();
  const contexts: number[] = [];
  let over300k = 0;
  let over600k = 0;
  let sidechainRead = 0;

  for (const record of records) {
    if (record.at < from) continue;
    addRecord(totals, record);
    addRecord(byProvider[record.provider], record);
    const dayKey = localDay(record.at);
    let day = byDay.get(dayKey);
    if (!day) {
      day = { day: dayKey, claude: emptyTotals(), codex: emptyTotals() };
      byDay.set(dayKey, day);
    }
    addRecord(day[record.provider], record);

    const modelKey = `${record.provider}|${record.model}`;
    let model = byModel.get(modelKey);
    if (!model) {
      model = { model: record.model, provider: record.provider, ...emptyTotals() };
      byModel.set(modelKey, model);
    }
    addRecord(model, record);

    const projectKey = `${record.provider}|${record.project}`;
    let project = byProject.get(projectKey);
    if (!project) {
      project = { project: record.project, provider: record.provider, sessions: 0, sessionIds: new Set(), ...emptyTotals() };
      byProject.set(projectKey, project);
    }
    addRecord(project, record);
    project.sessionIds.add(record.sessionId);

    const sessionKey = `${record.provider}|${record.sessionId}`;
    let session = bySession.get(sessionKey);
    if (!session) {
      session = {
        totals: emptyTotals(),
        contexts: [],
        project: record.project,
        cwd: record.cwd,
        sessionId: record.sessionId,
        provider: record.provider,
        firstAt: record.at,
        lastAt: record.at,
      };
      bySession.set(sessionKey, session);
    }
    addRecord(session.totals, record);
    session.contexts.push(record.read);
    session.cwd = record.cwd ?? session.cwd;
    session.firstAt = Math.min(session.firstAt, record.at);
    session.lastAt = Math.max(session.lastAt, record.at);

    contexts.push(record.read);
    if (record.read > CONTEXT_STEPS.over300k) over300k += 1;
    if (record.read > CONTEXT_STEPS.over600k) over600k += 1;
    if (record.sidechain) sidechainRead += record.read;
  }

  const sortedContexts = sortAscending(contexts);
  const titleOf = options.titleOf;

  const sessions = Array.from(bySession.values())
    .sort((a, b) => b.totals.read - a.totals.read)
    .slice(0, TOP_SESSIONS)
    .map((session): UsageSessionRow => {
      const sorted = sortAscending(session.contexts);
      let title: string | null = null;
      if (titleOf) {
        try {
          title = titleOf(session.provider, session.sessionId);
        } catch {
          title = null;
        }
      }
      return {
        sessionId: session.sessionId,
        provider: session.provider,
        project: session.project,
        cwd: session.cwd,
        title,
        ...session.totals,
        avgContext: Math.round(session.totals.read / Math.max(1, session.totals.messages)),
        p50Context: percentile(sorted, 0.5),
        p90Context: percentile(sorted, 0.9),
        maxContext: sorted[sorted.length - 1] ?? 0,
        firstAt: session.firstAt,
        lastAt: session.lastAt,
      };
    });

  return {
    days: options.days,
    from,
    to: now,
    totals,
    byProvider,
    byDay: Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)),
    byModel: Array.from(byModel.values()).sort((a, b) => b.read - a.read),
    byProject: Array.from(byProject.values())
      .sort((a, b) => b.read - a.read)
      .slice(0, TOP_PROJECTS)
      .map(({ sessionIds, ...row }) => ({ ...row, sessions: sessionIds.size })),
    bySession: sessions,
    context: {
      avgPerMessage: Math.round(totals.read / Math.max(1, totals.messages)),
      p50: percentile(sortedContexts, 0.5),
      p90: percentile(sortedContexts, 0.9),
      max: sortedContexts[sortedContexts.length - 1] ?? 0,
      over300k,
      over600k,
    },
    sidechainShare: totals.read > 0 ? sidechainRead / totals.read : 0,
    costs: null,
  };
}
