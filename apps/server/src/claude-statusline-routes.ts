import { Router, type Response } from "express";
import { installStatusline, statuslineStatus, uninstallStatusline, type StatuslineStatus } from "./claude-statusline.js";
import { config } from "./config.js";
import { getSetting, setSetting } from "./delegation-store.js";
import {
  CLAUDE_STATUSLINE_FRESH_DEFAULT,
  CLAUDE_STATUSLINE_FRESH_MAX,
  CLAUDE_STATUSLINE_FRESH_MIN,
  acceptClaudeStatusline,
  currentClaudeSourcePrefs,
  latestClaudeStatusline,
  parseStatuslineRateLimits,
  setClaudeSourcePrefs,
  type ClaudeSourcePrefs,
} from "./limits.js";

const FALLBACK_KEY = "limits.claudePrivateFallback";
const FRESH_KEY = "limits.claudeStatuslineFreshMinutes";
const LAST_KEY = "limits.claudeStatuslineLast";
const MAX_SESSION_ID = 200;

export interface ClaudeSourceView {
  statusline: StatuslineStatus;
  privateFallback: boolean;
  freshMinutes: number;
  lastReportAt: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function storedFresh(): number {
  const value = Number(getSetting(FRESH_KEY));
  return Number.isInteger(value) && value >= CLAUDE_STATUSLINE_FRESH_MIN && value <= CLAUDE_STATUSLINE_FRESH_MAX ? value : CLAUDE_STATUSLINE_FRESH_DEFAULT;
}

export function loadClaudeSourcePrefs(): ClaudeSourcePrefs {
  const prefs = { freshMinutes: storedFresh(), privateFallback: getSetting(FALLBACK_KEY) !== "0" };
  setClaudeSourcePrefs(prefs);
  return prefs;
}

function restoreLastReport(): void {
  const raw = getSetting(LAST_KEY);
  if (raw === null) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.at !== "number") return;
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : null;
    const report = parseStatuslineRateLimits(parsed.rateLimits, sessionId, parsed.at);
    if (report) acceptClaudeStatusline(report);
  } catch {
    return;
  }
}

function storedWindows(rateLimits: unknown): Record<string, unknown> {
  const stored: Record<string, unknown> = {};
  if (!isRecord(rateLimits)) return stored;
  for (const key of ["five_hour", "seven_day"] as const) {
    const window = rateLimits[key];
    if (isRecord(window)) stored[key] = { used_percentage: window.used_percentage, resets_at: window.resets_at };
  }
  return stored;
}

function view(statusline: StatuslineStatus = statuslineStatus()): ClaudeSourceView {
  const prefs = currentClaudeSourcePrefs();
  return { statusline, privateFallback: prefs.privateFallback, freshMinutes: prefs.freshMinutes, lastReportAt: latestClaudeStatusline()?.at ?? null };
}

function fail(res: Response, error: unknown, fallback: string): void {
  res.status(500).json({ error: error instanceof Error ? error.message : fallback });
}

export function claudeSourceRouter(): Router {
  loadClaudeSourcePrefs();
  restoreLastReport();
  const router = Router();

  router.get("/", (_req, res) => {
    try {
      res.json(view());
    } catch (error) {
      fail(res, error, "statusline status failed");
    }
  });

  router.put("/", (req, res) => {
    const body: unknown = req.body;
    if (!isRecord(body)) {
      res.status(400).json({ error: "body must be an object" });
      return;
    }
    if ("privateFallback" in body && typeof body.privateFallback !== "boolean") {
      res.status(400).json({ error: "privateFallback must be a boolean" });
      return;
    }
    const fresh = body.freshMinutes;
    if (fresh !== undefined && (typeof fresh !== "number" || !Number.isInteger(fresh) || fresh < CLAUDE_STATUSLINE_FRESH_MIN || fresh > CLAUDE_STATUSLINE_FRESH_MAX)) {
      res.status(400).json({ error: `freshMinutes must be an integer between ${CLAUDE_STATUSLINE_FRESH_MIN} and ${CLAUDE_STATUSLINE_FRESH_MAX}` });
      return;
    }
    if (typeof body.privateFallback === "boolean") setSetting(FALLBACK_KEY, body.privateFallback ? "1" : "0");
    if (typeof fresh === "number") setSetting(FRESH_KEY, String(fresh));
    loadClaudeSourcePrefs();
    res.json(view());
  });

  router.post("/report", (req, res) => {
    const body: unknown = req.body;
    if (!isRecord(body)) {
      res.status(400).json({ error: "body must be an object" });
      return;
    }
    const sessionId = typeof body.sessionId === "string" && body.sessionId.length > 0 ? body.sessionId.slice(0, MAX_SESSION_ID) : null;
    const at = Date.now();
    const report = parseStatuslineRateLimits(body.rateLimits, sessionId, at);
    if (!report) {
      res.status(400).json({ error: "rateLimits needs five_hour or seven_day with used_percentage" });
      return;
    }
    acceptClaudeStatusline(report);
    setSetting(LAST_KEY, JSON.stringify({ at, sessionId, rateLimits: storedWindows(body.rateLimits) }));
    res.status(204).end();
  });

  const change = (action: "install" | "uninstall") => (_req: unknown, res: Response) => {
    if (config.previewMode) {
      res.status(403).json({ error: "statusline changes are disabled in preview mode" });
      return;
    }
    try {
      res.json(view(action === "install" ? installStatusline() : uninstallStatusline()));
    } catch (error) {
      fail(res, error, `statusline ${action} failed`);
    }
  };

  router.post("/install", change("install"));
  router.post("/uninstall", change("uninstall"));

  return router;
}
