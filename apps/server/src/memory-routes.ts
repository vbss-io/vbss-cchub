import { Router } from "express";
import { DailyConflictError, isValidDailyDate } from "./daily.js";
import { composeDaySummary, writeDaySummary } from "./day-summary.js";
import { isLoopbackAddress } from "./delegation-security.js";
import { getSettings, updateSettings } from "./delegation-store.js";
import { handoffForCwd, handoffPreview } from "./handoff.js";
import { clearHistoryIndex, historyStatus, rebuildHistoryIndex, runHistoryIndex, searchHistory, HISTORY_CLIENTS, type HistoryClient } from "./history-index.js";
import { asString, sendError } from "./route-helpers.js";
import { localDate } from "./second-brain.js";
import { broadcast } from "./sse.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function timeParam(value: unknown, endOfDay: boolean): number | null | undefined {
  const text = asString(value);
  if (!text) return undefined;
  if (DATE_RE.test(text)) {
    const [year, month, day] = text.split("-").map(Number) as [number, number, number];
    return new Date(year, month - 1, endOfDay ? day + 1 : day).getTime();
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

const intParam = (value: unknown): number | undefined => {
  const number = Number(asString(value));
  return Number.isFinite(number) ? number : undefined;
};

export function memoryRouter(): Router {
  const router = Router();

  router.get("/history/status", (_req, res) => {
    res.json(historyStatus());
  });

  router.get("/history/search", (req, res) => {
    const client = asString(req.query.client);
    if (client && !(HISTORY_CLIENTS as readonly string[]).includes(client)) {
      res.status(400).json({ error: `client must be one of: ${HISTORY_CLIENTS.join(", ")}` });
      return;
    }
    const from = timeParam(req.query.from, false);
    const to = timeParam(req.query.to, true);
    if (from === null || to === null) {
      res.status(400).json({ error: "from and to must be YYYY-MM-DD or epoch milliseconds" });
      return;
    }
    const sort = asString(req.query.sort);
    const group = asString(req.query.group);
    try {
      res.json(
        searchHistory({
          q: typeof req.query.q === "string" ? req.query.q : "",
          client: client as HistoryClient | null,
          workspace: asString(req.query.workspace),
          from: from ?? null,
          to: to ?? null,
          limit: intParam(req.query.limit),
          offset: intParam(req.query.offset),
          sort: sort === "recent" ? "recent" : "relevance",
          group: group === "session" ? "session" : "message",
        }),
      );
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/history/run", (_req, res) => {
    if (!getSettings().memory.historyIndex) {
      res.status(409).json({ error: "the history index is turned off" });
      return;
    }
    void runHistoryIndex();
    res.status(202).json(historyStatus());
  });

  router.post("/history/rebuild", (_req, res) => {
    if (!getSettings().memory.historyIndex) {
      res.status(409).json({ error: "the history index is turned off" });
      return;
    }
    void rebuildHistoryIndex();
    res.status(202).json(historyStatus());
  });

  router.delete("/history", async (_req, res) => {
    await clearHistoryIndex();
    res.json(historyStatus());
  });

  router.get("/handoff/hook", (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "loopback only" });
      return;
    }
    try {
      res.json(handoffForCwd(getSettings(), asString(req.query.cwd), asString(req.query.sessionId)));
    } catch {
      res.json({ workspace: null, text: null });
    }
  });

  router.get("/handoff/preview", (req, res) => {
    const workspace = asString(req.query.workspace);
    if (!workspace) {
      res.status(400).json({ error: "workspace required" });
      return;
    }
    try {
      res.json(handoffPreview(getSettings(), workspace));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put("/handoff/workspaces/:name", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be true or false" });
      return;
    }
    const name = req.params.name.trim();
    const current = getSettings().memory.handoffWorkspaces.filter((item) => item !== name);
    const updated = updateSettings({ memory: { handoffWorkspaces: body.enabled ? [...current, name] : current } });
    broadcast("settings", updated);
    res.json(updated.memory);
  });

  router.get("/day-summary", async (req, res) => {
    const date = asString(req.query.date) ?? localDate();
    if (!isValidDailyDate(date)) {
      res.status(400).json({ error: "date must be YYYY-MM-DD" });
      return;
    }
    try {
      res.json(await composeDaySummary(getSettings(), date));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/day-summary/write", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const date = asString(body.date) ?? localDate();
    if (!isValidDailyDate(date)) {
      res.status(400).json({ error: "date must be YYYY-MM-DD" });
      return;
    }
    const baseUpdatedAt = typeof body.baseUpdatedAt === "number" && Number.isFinite(body.baseUpdatedAt) ? body.baseUpdatedAt : undefined;
    try {
      res.json(await writeDaySummary(getSettings(), date, baseUpdatedAt, asString(body.writeId)));
    } catch (err) {
      if (err instanceof DailyConflictError) {
        res.status(409).json({ error: err.message, content: err.content, updatedAt: err.updatedAt });
        return;
      }
      sendError(res, err);
    }
  });

  return router;
}
