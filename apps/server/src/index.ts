import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import {
  applyHook,
  archiveSession,
  createGroup,
  deleteGroup,
  deleteSession,
  getSession,
  listGroups,
  listSessions,
  renameSession,
  reorderGroups,
  updateGroup,
} from "./db.js";
import { focusTerminal, focusWindow } from "./focus.js";
import { controlHooks } from "./hooks-control.js";
import { readSessionName, readTranscript } from "./transcript.js";
import { addClient, broadcast } from "./sse.js";
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
  SubagentStop: "stop",
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
app.use(express.json());

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
    model: asString(body.model),
    tokensIn: asNumber(body.tokensIn),
    tokensOut: asNumber(body.tokensOut),
    contextTokens: asNumber(body.contextTokens),
  };
  const session = applyHook(payload);
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
    message: asString(body.message),
    model: transcript.model,
    tokensIn: transcript.tokensIn,
    tokensOut: transcript.tokensOut,
    contextTokens: transcript.contextTokens,
  };
  const session = applyHook(payload);
  broadcast("session", session);
  res.json(session);
});

app.get("/api/sessions", (_req, res) => {
  res.json(listSessions());
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
  if (session.shellPid) void focusTerminal(session.shellPid);
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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/hooks", async (_req, res) => {
  res.json(await controlHooks("status"));
});

app.post("/api/hooks/install", async (_req, res) => {
  res.json(await controlHooks("install"));
});

app.post("/api/hooks/uninstall", async (_req, res) => {
  res.json(await controlHooks("uninstall"));
});

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

app.listen(config.port, config.host, () => {
  console.log(`vbss-cchub server on http://${config.host}:${config.port}`);
});
