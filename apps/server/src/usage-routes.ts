import { Router } from "express";
import { listCodexSessions } from "./codex-store.js";
import { getSession } from "./db.js";
import { delegationGuard } from "./delegation-security.js";
import { broadcast } from "./sse.js";
import {
  aggregateUsage,
  collectUsage,
  resetUsageCache,
  type UsageAggregate,
  type UsageProvider,
  type UsageTitleResolver,
} from "./usage.js";

const CACHE_TTL_MS = 60_000;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;

const responseCache = new Map<number, { at: number; value: UsageAggregate }>();

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

async function usageFor(days: number, fresh: boolean): Promise<UsageAggregate> {
  const cached = responseCache.get(days);
  if (!fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const now = Date.now();
  const scan = await collectUsage({ days, now });
  const value = aggregateUsage(scan.records, { days, now, titleOf: titleResolver() });
  responseCache.set(days, { at: Date.now(), value });
  return value;
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
      res.json(await usageFor(days, req.query.fresh === "1"));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "usage scan failed" });
    }
  });

  router.get("/summary", async (req, res) => {
    try {
      res.json(summarize(await usageFor(DEFAULT_DAYS, req.query.fresh === "1")));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "usage scan failed" });
    }
  });

  router.post("/rescan", async (_req, res) => {
    try {
      resetUsageCache();
      responseCache.clear();
      const scan = await collectUsage({ days: DEFAULT_DAYS });
      broadcast("usage", { at: Date.now() });
      res.json({ files: scan.files });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "usage rescan failed" });
    }
  });

  return router;
}
