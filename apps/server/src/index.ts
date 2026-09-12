import { join } from "node:path";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { config } from "./config.js";
import {
  applyHook,
  archiveSession,
  createClaim,
  endDeadSessions,
  listAgents,
  createGroup,
  deleteGroup,
  deleteSession,
  getSession,
  listClaims,
  listGroups,
  listSessions,
  purgeEmptySessions,
  purgeExpiredClaims,
  releaseClaim,
  renameSession,
  reorderGroups,
  sessionByPid,
  setSessionFavorite,
  updateGroup,
  applyMeta,
} from "./db.js";
import { focusWindow } from "./focus.js";
import { desktopNotifier } from "./desktop-notify.js";
import { codexLiveEntries, findCodexRollout } from "./codex-sessions.js";
import {
  archiveCodexThread,
  hideCodexThread,
  listCodexSessions,
  setCodexTitle,
  unarchiveCodexThread,
} from "./codex-store.js";
import { sessionLive } from "./live.js";
import { runtimeSnapshot } from "./runtimes.js";
import { ensureExtension } from "./ensure-extension.js";
import { abortActiveRuns, delegationRouter } from "./delegation-routes.js";
import { resolveWorkspaceTarget } from "./delegation-launch.js";
import { markRunningAsInterrupted } from "./delegation-store.js";
import { createShareApp } from "./share-server.js";
import { deleteOrphanShareForks, limitOf, listAsksForSession, listForksForSession, markInterruptedShareRequests } from "./share-store.js";
import { markShareEndpoint, stopTunnel } from "./tunnel.js";
import { abortAllAsks } from "./share-service.js";
import { mergeHooks, windowsHooks, wslHooks } from "./hooks-control.js";
import { readSessionName, readTranscript } from "./transcript.js";
import { addClient, broadcast, clientCount } from "./sse.js";
import { HOOK_KINDS, type HookKind, type HookPayload } from "./types.js";

const isHookKind = (value: unknown): value is HookKind =>
  typeof value === "string" && (HOOK_KINDS as readonly string[]).includes(value);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const kindByEvent: Record<string, HookKind> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt",
  Notification: "notification",
  Stop: "stop",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  SessionEnd: "session_end",
};

function transcriptPathFor(path: string | null, source: string | null): string | null {
  if (!path) return null;
  if (source && source.startsWith("wsl-") && path.startsWith("/")) {
    const distro = source.slice(4);
    return `\\\\wsl$\\${distro}${path.replace(/\//g, "\\")}`;
  }
  return path;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.post("/hook", (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!isHookKind(body.kind) || typeof body.sessionId !== "string") {
    res.status(400).json({ error: "invalid payload" });
    return;
  }
  const payload: HookPayload = {
    kind: body.kind,
    sessionId: body.sessionId,
    cwd: asString(body.cwd),
    source: asString(body.source),
    hostPid: asNumber(body.hostPid),
    shellPid: asNumber(body.shellPid),
    title: asString(body.title),
    message: asString(body.message),
    notificationType: asString(body.notificationType),
    model: asString(body.model),
    tokensIn: asNumber(body.tokensIn),
    tokensOut: asNumber(body.tokensOut),
    contextTokens: asNumber(body.contextTokens),
    agentId: asString(body.agentId),
    agentType: asString(body.agentType),
    client: asString(body.client),
    claudePid: asNumber(body.claudePid),
    transcriptPath: asString(body.transcriptPath),
    agentMessage: asString(body.agentMessage),
    shareLabel: asString(body.shareLabel),
  };
  const seededAt = process.env.HUB_DEV_SEED === "1" ? asNumber(body.updatedAt) : null;
  const session = payload.kind === "meta" ? (applyMeta(payload) ?? applyHook(payload, seededAt ?? undefined)) : applyHook(payload, seededAt ?? undefined);
  broadcast("session", session);
  res.json(session);
});

app.post("/hook/raw", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const source = typeof req.query.source === "string" ? req.query.source : null;
  const eventName = typeof body.hook_event_name === "string" ? body.hook_event_name : "";
  const kind = kindByEvent[eventName];
  if (!kind || typeof body.session_id !== "string") {
    res.status(400).json({ error: "invalid hook payload" });
    return;
  }
  const transcriptPath = asString(body.transcript_path);
  const transcript = readTranscript(transcriptPathFor(transcriptPath, source));
  let title = transcript.title;
  if (transcriptPath) {
    const sessionsDir = transcriptPath.replace(/(\.claude)[\\/]projects[\\/].*$/, "$1/sessions");
    const meta = readSessionName(transcriptPathFor(sessionsDir, source) ?? "", body.session_id);
    const userName = meta.nameSource !== "derived" ? meta.name : null;
    title = userName ?? transcript.title ?? meta.name;
  }
  const payload: HookPayload = {
    kind,
    sessionId: body.session_id,
    cwd: asString(body.cwd),
    source,
    hostPid: null,
    shellPid: null,
    title,
    message: asString(body.message) ?? asString(body.last_assistant_message)?.slice(0, 400) ?? null,
    notificationType: asString(body.notification_type),
    model: transcript.model,
    tokensIn: transcript.tokensIn,
    tokensOut: transcript.tokensOut,
    contextTokens: transcript.contextTokens,
    agentId: asString(body.agent_id),
    agentType: asString(body.agent_type),
    client: source && source.startsWith("wsl") ? "wsl" : "terminal",
    claudePid: null,
    transcriptPath,
    agentMessage: asString(body.agent_id) ? (asString(body.last_assistant_message)?.slice(0, 400) ?? null) : null,
    shareLabel: asString(body.share_label) ?? null,
  };
  const session = applyHook(payload);
  broadcast("session", session);
  res.json(session);
});

app.get("/api/sessions", (_req, res) => {
  res.json(listSessions());
});

app.get("/api/sessions/:id/agents", (req, res) => {
  res.json(listAgents(req.params.id));
});

app.get("/api/sessions/:id/asks", (req, res) => {
  res.json({ forks: listForksForSession(req.params.id), asks: listAsksForSession(req.params.id, limitOf(req.query.limit)) });
});

app.get("/api/sessions/:id/live", (req, res) => {
  void sessionLive(req.params.id).then((live) => {
    if (!live) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    res.json(live);
  });
});

app.get("/api/runtimes", (_req, res) => {
  void runtimeSnapshot().then((snapshot) => res.json(snapshot));
});

app.post("/api/ui/navigate", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const hash = typeof body.hash === "string" && body.hash.startsWith("#/") ? body.hash.slice(0, 200) : "#/sessions";
  broadcast("ui-navigate", { hash });
  res.status(204).end();
});

const TOAST_KINDS = new Set(["sessionNeedsYou", "sessionIdle", "sessionFinished", "taskCompleted", "taskFailed", "taskNeedsYou", "shareAsk", "shareImplement"]);

app.post("/api/toast", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const kind = typeof body.kind === "string" && TOAST_KINDS.has(body.kind) ? body.kind : null;
  const id = typeof body.id === "string" && body.id ? body.id.slice(0, 200) : null;
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : null;
  if (!kind || !id || !title) {
    res.status(400).json({ error: "kind, id and title required" });
    return;
  }
  broadcast("toast", { kind, id, title, body: typeof body.body === "string" ? body.body.slice(0, 600) : "", at: Date.now() });
  res.status(204).end();
});

const uiDiag = new Map<string, Record<string, unknown>>();

app.post("/api/ui/diag", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const window = typeof body.window === "string" ? body.window.slice(0, 40) : "unknown";
  const previous = uiDiag.get(window) ?? {};
  uiDiag.set(window, { ...previous, ...body, at: new Date().toISOString() });
  res.status(204).end();
});

app.get("/api/ui/diag", (_req, res) => {
  res.json({ sseClients: clientCount(), windows: Object.fromEntries(uiDiag) });
});

app.get("/api/sse/clients", (_req, res) => {
  res.json({ count: clientCount() });
});

app.get("/api/notify/status", (req, res) => {
  void desktopNotifier.status(req.query.force === "1").then((status) => res.json(status));
});

app.post("/api/notify", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "VBSS CCHUB";
  const text = typeof body.body === "string" ? body.body : "";
  void desktopNotifier.show(title, text).then((result) => res.status(result.ok ? 200 : 501).json(result));
});

const uiErrorLog = join(config.dataDir, "ui-errors.log");

app.post("/api/ui-error", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const entry = {
    at: new Date().toISOString(),
    view: typeof body.view === "string" ? body.view.slice(0, 40) : "unknown",
    message: typeof body.message === "string" ? body.message.slice(0, 500) : "",
    stack: typeof body.stack === "string" ? body.stack.slice(0, 4000) : "",
    componentStack: typeof body.componentStack === "string" ? body.componentStack.slice(0, 2000) : "",
  };
  appendFileSync(uiErrorLog, `${JSON.stringify(entry)}\n`);
  console.error(`ui error in ${entry.view}: ${entry.message}`);
  res.status(204).end();
});

app.get("/api/ui-errors", (req, res) => {
  const limit = limitOf(req.query.limit, 20, 200);
  if (!existsSync(uiErrorLog)) {
    res.json([]);
    return;
  }
  const lines = readFileSync(uiErrorLog, "utf8").trim().split("\n").filter(Boolean).slice(-limit);
  res.json(lines.map((line) => JSON.parse(line) as Record<string, unknown>));
});

app.get("/api/codex/sessions", (_req, res) => {
  res.json(listCodexSessions());
});

app.post("/api/codex/focus", async (_req, res) => {
  const snapshot = await runtimeSnapshot();
  const pid = snapshot.codexApp.pids[0] ?? null;
  if (!pid) {
    res.status(409).json({ ok: false, reason: "the Codex app is not running" });
    return;
  }
  res.json(await focusWindow(pid, null));
});

app.get("/api/codex/:id/live", (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 500);
  const file = findCodexRollout(req.params.id);
  if (!file) {
    res.status(404).json({ error: "thread not found" });
    return;
  }
  res.json({ entries: codexLiveEntries(file, limit) });
});

const codexThreadFor = (id: string) => listCodexSessions().find((session) => session.id === id) ?? null;

app.patch("/api/codex/:id", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title : null;
  setCodexTitle(req.params.id, title);
  broadcast("codex", listCodexSessions());
  res.json(codexThreadFor(req.params.id) ?? { id: req.params.id });
});

app.post("/api/codex/:id/archive", (req, res) => {
  archiveCodexThread(req.params.id);
  broadcast("codex", listCodexSessions());
  res.json(codexThreadFor(req.params.id) ?? { id: req.params.id });
});

app.post("/api/codex/:id/unarchive", (req, res) => {
  unarchiveCodexThread(req.params.id);
  broadcast("codex", listCodexSessions());
  res.json(codexThreadFor(req.params.id) ?? { id: req.params.id });
});

app.delete("/api/codex/:id", (req, res) => {
  hideCodexThread(req.params.id);
  broadcast("codex", listCodexSessions());
  res.json({ ok: true });
});

app.patch("/api/sessions/:id", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title : null;
  const session = renameSession(req.params.id, title);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  broadcast("session", session);
  res.json(session);
});

app.post("/api/sessions/:id/focus", async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  const result = await focusWindow(session.hostPid, session.cwd);
  if (session.shellPid) broadcast("focus-terminal", { shellPid: session.shellPid });
  res.json(result);
});

app.post("/api/sessions/:id/archive", (req, res) => {
  const session = archiveSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  broadcast("session", session);
  res.json(session);
});

app.post("/api/sessions/:id/favorite", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const favorite = body.favorite === true;
  const session = setSessionFavorite(req.params.id, favorite);
  if (!session) {
    res.status(404).json({ error: "not found" });
    return;
  }
  broadcast("session", session);
  res.json(session);
});

app.delete("/api/sessions/:id", (req, res) => {
  const removed = deleteSession(req.params.id);
  if (removed) broadcast("removed", { sessionId: req.params.id });
  res.json({ ok: removed });
});

app.get("/api/groups", (_req, res) => {
  res.json(listGroups());
});

app.post("/api/groups", (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    res.status(400).json({ error: "name required" });
    return;
  }
  const group = createGroup(body.name.trim(), typeof body.match === "string" ? body.match : "");
  broadcast("groups", listGroups());
  res.json(group);
});

app.patch("/api/groups/:id", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const fields: { name?: string; match?: string } = {};
  if (typeof body.name === "string") fields.name = body.name;
  if (typeof body.match === "string") fields.match = body.match;
  const group = updateGroup(req.params.id, fields);
  if (!group) {
    res.status(404).json({ error: "not found" });
    return;
  }
  broadcast("groups", listGroups());
  res.json(group);
});

app.delete("/api/groups/:id", (req, res) => {
  const ok = deleteGroup(req.params.id);
  if (ok) broadcast("groups", listGroups());
  res.json({ ok });
});

app.post("/api/groups/reorder", (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string")) {
    res.status(400).json({ error: "ids required" });
    return;
  }
  const groups = reorderGroups(body.ids as string[]);
  broadcast("groups", groups);
  res.json(groups);
});

app.get("/api/claims", (req, res) => {
  const repoPath = asString(req.query.repoPath);
  res.json(listClaims(repoPath ? { repoPath } : {}));
});

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

app.post("/api/claims", (req, res) => {
  const body = req.body as Record<string, unknown>;
  const paths = asStringArray(body.paths);
  let repoPath = asString(body.repoPath);
  if (!repoPath) {
    const workspace = asString(body.workspace);
    if (workspace) {
      try {
        repoPath = resolveWorkspaceTarget(workspace, asString(body.repo)).repoPath;
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "could not resolve workspace" });
        return;
      }
    }
  }
  if (!repoPath || paths.length === 0) {
    res.status(400).json({ error: "repoPath (or workspace/repo) and paths required" });
    return;
  }
  const originPid = asNumber(body.originPid);
  const sessionId = asString(body.sessionId) ?? (originPid ? (sessionByPid(originPid)?.sessionId ?? null) : null);
  const ttlMinutes = asNumber(body.ttlMinutes);
  const claim = createClaim({
    sessionId,
    repoPath,
    paths,
    note: asString(body.note),
    ttlMs: ttlMinutes != null ? ttlMinutes * 60_000 : null,
  });
  broadcast("claims", listClaims());
  res.status(201).json(claim);
});

app.delete("/api/claims/:id", (req, res) => {
  releaseClaim(req.params.id);
  broadcast("claims", listClaims());
  res.status(204).end();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hostname: hostname() });
});

app.get("/api/hooks", async (_req, res) => {
  const windows = await windowsHooks("status");
  res.json({ ...windows, wsl: null });
  void wslHooks("status").then((wsl) => broadcast("hooks", mergeHooks(windows, wsl)));
});

app.post("/api/hooks/install", async (_req, res) => {
  const windows = await windowsHooks("install");
  res.json({ ...windows, wsl: null });
  void wslHooks("install").then((wsl) => broadcast("hooks", mergeHooks(windows, wsl)));
});

app.post("/api/hooks/uninstall", async (_req, res) => {
  const windows = await windowsHooks("uninstall");
  res.json({ ...windows, wsl: null });
  void wslHooks("uninstall").then((wsl) => broadcast("hooks", mergeHooks(windows, wsl)));
});

app.use("/delegation", delegationRouter());

app.get("/api/events", (_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: ready\ndata: {}\n\n`);
  addClient(res);
});

if (config.staticDir && existsSync(config.staticDir)) {
  app.use(express.static(config.staticDir));
}

const jsonErrors: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  const status =
    err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : 500;
  res.status(status).json({ error: err instanceof Error ? err.message : "request failed" });
};
app.use(jsonErrors);

app.listen(config.port, config.host, () => {
  console.log(`vbss-cchub server on http://${config.host}:${config.port}`);
  if (config.delegationEnabled) {
    markInterruptedShareRequests();
    deleteOrphanShareForks();
    createShareApp()
      .listen(config.sharePort, config.shareHost, () => {
        markShareEndpoint(null);
        console.log(`share endpoint on http://${config.shareHost}:${config.sharePort} (share links only)`);
      })
      .on("error", (err: Error) => {
        markShareEndpoint(err.message);
        console.error(`share endpoint could not listen on ${config.sharePort}: ${err.message}`);
      });
    const interrupted = markRunningAsInterrupted();
    if (interrupted > 0) console.log(`marked ${interrupted} delegation runs interrupted on restart`);
    console.log("delegation enabled (loopback callers only)");
  }
});

function shutdown(reason: string): void {
  stopTunnel();
  abortAllAsks(reason);
  abortActiveRuns(reason);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("hub stopped"));
process.on("SIGTERM", () => shutdown("hub stopped"));

const PURGE_INTERVAL_MS = 3_600_000;

function purgeEmpty(): void {
  const removed = purgeEmptySessions(config.emptyTtlMs);
  for (const sessionId of removed) broadcast("removed", { sessionId });
  if (removed.length > 0) console.log(`purged ${removed.length} empty sessions`);
}

purgeEmpty();
setInterval(purgeEmpty, PURGE_INTERVAL_MS).unref();

function sweepDead(): void {
  for (const session of endDeadSessions()) broadcast("session", session);
  if (purgeExpiredClaims() > 0) broadcast("claims", listClaims());
}

sweepDead();
setInterval(sweepDead, 30_000).unref();

ensureExtension();

const parentPid = Number(process.env.HUB_PARENT_PID);
if (Number.isInteger(parentPid) && parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      shutdown("hub host exited");
    }
  }, 3000).unref();
}
