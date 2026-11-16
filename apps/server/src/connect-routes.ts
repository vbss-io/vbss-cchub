import { Router } from "express";
import { getSettings } from "./delegation-store.js";
import { BadRequestError } from "./delegation-launch.js";
import { configureMcp, configureShell, connectStatus, MCP_CLIENTS, SHELL_KINDS, type ConnectAction, type McpClient, type ShellKind } from "./installers.js";
import { oneOf, sendError } from "./route-helpers.js";
import { codexHooksStatus, installCodexHooks, uninstallCodexHooks } from "./codex-hooks.js";
import { config } from "./config.js";

const codexWindowSec = (): number => getSettings().approvals.codexWindowSec;

export function connectRouter(): Router {
  const router = Router();

  router.get("/connect", (_req, res) => {
    connectStatus()
      .then((status) => res.json({ ...status, codexHooks: codexHooksStatus(codexWindowSec()) }))
      .catch((err: unknown) => sendError(res, err));
  });

  router.post("/connect/shell", (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      const shell = oneOf<ShellKind>(body.shell, SHELL_KINDS, "shell");
      if (!shell) throw new BadRequestError("shell required");
      const action = oneOf<ConnectAction>(body.action, ["install", "uninstall"], "action") ?? "install";
      configureShell(shell, action, getSettings().workspacesRoot)
        .then((status) => res.json(status))
        .catch((err: unknown) => sendError(res, err));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/connect/mcp", (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      const client = oneOf<McpClient>(body.client, MCP_CLIENTS, "client");
      if (!client) throw new BadRequestError("client required");
      const action = oneOf<ConnectAction>(body.action, ["install", "uninstall"], "action") ?? "install";
      res.json(configureMcp(client, action));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/connect/codex-hooks", (_req, res) => {
    res.json(codexHooksStatus(codexWindowSec()));
  });

  router.post("/connect/codex-hooks", (req, res) => {
    if (config.previewMode) {
      res.status(403).json({ error: "hook changes are disabled in preview mode" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    try {
      const action = oneOf<ConnectAction>(body.action, ["install", "uninstall"], "action") ?? "install";
      const windowSec = codexWindowSec();
      res.json(action === "install" ? installCodexHooks(windowSec) : uninstallCodexHooks(windowSec));
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
