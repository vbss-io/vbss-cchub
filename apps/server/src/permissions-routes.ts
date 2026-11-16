import { Router, type NextFunction, type Request, type Response } from "express";
import { getSession } from "./db.js";
import { getSettings, listCodexRunLinks } from "./delegation-store.js";
import { isLoopbackAddress, isTrustedOrigin } from "./delegation-security.js";
import { listCodexSessions } from "./codex-store.js";
import {
  PERMISSION_AGENTS,
  decidePermission,
  getPermissionRequest,
  listPermissionRequests,
  openPermissionRequest,
  waitForDecision,
  windowMsFor,
  withdrawPermission,
  type PermissionAgent,
  type PermissionBehavior,
} from "./permissions.js";

const DELEGATED_CLIENTS: ReadonlySet<string> = new Set(["hub", "headless", "share"]);
const TOOL_NAME_MAX = 200;

const text = (value: unknown, max = 4000): string | null => (typeof value === "string" && value.length > 0 ? value.slice(0, max) : null);

export const WAIT_TOKEN_HEADER = "x-hub-wait-token";

function waitTokenOf(req: Request): string | null {
  const header = req.header(WAIT_TOKEN_HEADER);
  if (typeof header === "string" && header.length > 0) return header;
  return typeof req.query.token === "string" && req.query.token.length > 0 ? req.query.token : null;
}

export function permissionGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({ error: "permission requests and decisions accept loopback connections only" });
    return;
  }
  if (!isTrustedOrigin(req.header("origin"))) {
    res.status(403).json({ error: "origin not allowed" });
    return;
  }
  next();
}

function isDelegated(agent: PermissionAgent, sessionId: string): boolean {
  if (agent === "codex") return listCodexRunLinks().some((link) => link.threadId === sessionId);
  const client = getSession(sessionId)?.client ?? null;
  return client !== null && DELEGATED_CLIENTS.has(client);
}

function titleOf(agent: PermissionAgent, sessionId: string): string | null {
  if (agent === "claude") {
    const session = getSession(sessionId);
    return session?.customTitle ?? session?.title ?? null;
  }
  const thread = listCodexSessions().find((session) => session.id === sessionId);
  return thread ? (thread.customTitle ?? thread.title) : null;
}

export function permissionsRouter(): Router {
  const router = Router();
  router.use(permissionGuard);

  router.get("/", (_req, res) => {
    res.json(listPermissionRequests());
  });

  router.post("/request", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const agent = PERMISSION_AGENTS.find((item) => item === body.agent) ?? null;
    const sessionId = text(body.sessionId, 200);
    const toolName = text(body.toolName, TOOL_NAME_MAX);
    if (!agent || !sessionId || !toolName) {
      res.status(400).json({ error: "agent, sessionId and toolName required" });
      return;
    }
    const agentId = text(body.agentId, 200);
    const approvals = getSettings().approvals;
    const windowSec = agent === "claude" ? approvals.claudeWindowSec : approvals.codexWindowSec;
    const delegated = body.delegated === true || isDelegated(agent, sessionId);
    const windowMs = delegated ? 0 : windowMsFor(windowSec, agentId);
    const opened = openPermissionRequest(
      {
        agent,
        sessionId,
        agentId,
        toolName,
        toolInput: body.toolInput ?? null,
        cwd: text(body.cwd, 1000),
        turnId: text(body.turnId, 200),
        title: titleOf(agent, sessionId),
      },
      windowMs,
    );
    if (!opened) {
      res.json({ id: null, windowMs: 0, expiresAt: null });
      return;
    }
    res.json({ id: opened.record.id, windowMs: opened.record.windowMs, expiresAt: opened.record.expiresAt, waitToken: opened.waitToken });
  });

  router.get("/:id/wait", (req, res) => {
    const id = req.params.id;
    let answered = false;
    const attached = waitForDecision(id, waitTokenOf(req), (decision) => {
      answered = true;
      res.json({ decision });
    });
    if (attached.status === "gone") {
      res.json({ decision: null });
      return;
    }
    if (attached.status === "forbidden") {
      res.status(403).json({ error: "wait token missing or wrong" });
      return;
    }
    res.on("close", () => {
      attached.stop();
      if (!answered) withdrawPermission(id);
    });
  });

  router.post("/:id/decision", (req, res) => {
    const body = req.body as Record<string, unknown>;
    const behavior: PermissionBehavior | null = body.behavior === "allow" || body.behavior === "deny" ? body.behavior : null;
    if (!behavior) {
      res.status(400).json({ error: "behavior must be allow or deny" });
      return;
    }
    if (!getPermissionRequest(req.params.id)) {
      res.status(404).json({ error: "no pending permission request with this id (answered, expired or withdrawn)" });
      return;
    }
    const message = behavior === "deny" ? text(typeof body.message === "string" ? body.message.trim() : null) : null;
    const record = decidePermission(req.params.id, { behavior, message });
    res.json({ ok: record !== null, request: record });
  });

  return router;
}
