import { Router } from "express";
import { listCodexSessions } from "./codex-store.js";
import { getSession } from "./db.js";
import { delegationGuard } from "./delegation-security.js";
import { broadcast } from "./sse.js";
import {
  aggregateUsage,
  collectUsage,
  rescanUsage,
  type UsageAggregate,
  type UsageProvider,
  type UsageTitleResolver,
  usageGeneration,
  usageScanProgress,
} from "./usage.js";

const CACHE_TTL_MS = 60_000;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;

const responseCache = new Map<number, { at: number; generation: number; value: UsageAggregate }>();

export interface ProviderSummary {
  today: { read: number; output: number; messages: number };
  week: { read: number; output: number };
}

export interface UsageSummary {
  days: 7;
  providers: Record<UsageProvider, ProviderSummary | null>;
}

function titleResolver(): UsageTitleResolver {
  let codexTitles: Map<string, string | null> | null = null;
  return (provider, sessionId) => {
    if (provider === "claude") {
      const session = getSession(sessionId);
      return session ? (session.customTitle ?? session.title) : null;
    }
    if (codexTitles === null) {
      codexTitles = new Map(listCodexSessions().map((record) => [record.id, record.customTitle ?? record.title ?? null]));
    }
    return codexTitles.get(sessionId) ?? null;
  };
}

async function compute(days: number): Promise<UsageAggregate> {
  const now = Date.now();
  const scan = await collectUsage({ days, now });
  const value = aggregateUsage(scan.records, { days, now, titleOf: titleResolver() });
  if (scan.generation === usageGeneration()) responseCache.set(days, { at: Date.now(), generation: scan.generation, value });
  return value;
}

interface BackgroundScan {
  startedAt: number;
}

const background = new Map<number, BackgroundScan>();
const failures = new Map<number, string>();

function startBackground(days: number): BackgroundScan {
  const running = background.get(days);
  if (running) return running;
  const scan: BackgroundScan = { startedAt: Date.now() };
  background.set(days, scan);
  failures.delete(days);
  compute(days)
    .then(
      () => undefined,
      (error: unknown) => {
        failures.set(days, error instanceof Error ? error.message : "usage scan failed");
      },
    )
    .finally(() => {
      if (background.get(days) === scan) background.delete(days);
      broadcast("usage", { at: Date.now() });
    });
  return scan;
}

export function warmUsage(): void {
  startBackground(DEFAULT_DAYS);
}

type Lookup = { value: UsageAggregate } | { value: null; startedAt: number };

async function resolve(days: number, fresh: boolean): Promise<Lookup> {
  const failure = failures.get(days);
  if (failure !== undefined) {
    failures.delete(days);
    throw new Error(failure);
  }
  if (fresh) return { value: await compute(days) };
  const cached = responseCache.get(days);
  const usable = cached && cached.generation === usageGeneration() ? cached : null;
  if (usable && Date.now() - usable.at < CACHE_TTL_MS) return { value: usable.value };
  const scan = startBackground(days);
  return usable ? { value: usable.value } : { value: null, startedAt: scan.startedAt };
}

export function summarize(aggregate: UsageAggregate): UsageSummary {
  const today = aggregate.byDay[aggregate.byDay.length - 1];
  const provider = (name: UsageProvider): ProviderSummary | null => {
    const week = aggregate.byProvider[name];
    if (week.messages === 0) return null;
    const day = today ? today[name] : null;
    return {
      today: { read: day?.read ?? 0, output: day?.output ?? 0, messages: day?.messages ?? 0 },
      week: { read: week.read, output: week.output },
    };
  };
  return { days: 7, providers: { claude: provider("claude"), codex: provider("codex") } };
}

function parseDays(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_DAYS;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return days >= 1 && days <= MAX_DAYS ? days : null;
}

export function usageRouter(): Router {
  const router = Router();
  router.use(delegationGuard);

  router.get("/", async (req, res) => {
    const days = parseDays(req.query.days);
    if (days === null) {
      res.status(400).json({ error: `days must be an integer between 1 and ${MAX_DAYS}` });
      return;
    }
    try {
      const found = await resolve(days, req.query.fresh === "1");
      if (found.value) res.json(found.value);
      else res.status(202).json({ scanning: true, startedAt: found.startedAt, files: usageScanProgress()?.files ?? null });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "usage scan failed" });
    }
  });

  router.get("/summary", async (req, res) => {
    try {
      const found = await resolve(DEFAULT_DAYS, req.query.fresh === "1");
      if (found.value) res.json(summarize(found.value));
      else res.status(202).json({ days: DEFAULT_DAYS, scanning: true, providers: null });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "usage scan failed" });
    }
  });

  router.post("/rescan", async (_req, res) => {
    try {
      const started = Date.now();
      const scan = await rescanUsage({ days: DEFAULT_DAYS });
      responseCache.clear();
      await compute(DEFAULT_DAYS).catch(() => undefined);
      broadcast("usage", { at: Date.now() });
      res.json({ files: scan.files, elapsedMs: Date.now() - started });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "usage rescan failed" });
    }
  });

  return router;
}
