import { Router, type Request, type Response } from "express";
import { getSession } from "./db.js";
import { BadRequestError, NotFoundError, resolveWorkspaceTarget } from "./delegation-launch.js";
import { abortShareAsks, abortShareTasks, artifactPath, listArtifacts, renderShareDoc, sessionInsideWorkspace, ShareError, shareLinks, toShareView } from "./share-service.js";
import { createShare, deleteShare, getShare, listShareRequests, listShares, rotateShareKey, updateShare, limitOf } from "./share-store.js";
import { SHARE_DEFAULT_MAX_PER_HOUR, TRUST_LEVELS, normalizeTrust } from "./share-types.js";
import { allowFirewall, firewallStatus, startTunnel, stopTunnel, installNgrok, tunnelStatus, updateTunnelSettings } from "./tunnel.js";

const asString = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);

function hoursToExpiry(value: unknown, fallbackHours: number | null): number | null {
  if (value === null) return null;
  if (value === undefined) return fallbackHours === null ? null : Date.now() + fallbackHours * 3_600_000;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) throw new BadRequestError("expiresInHours must be a positive number of hours (or null for no expiry)");
  return Date.now() + hours * 3_600_000;
}

function perHour(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > 500) throw new BadRequestError("maxPerHour must be between 1 and 500");
  return n;
}

function sendError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : "request failed";
  const status =
    err instanceof ShareError ? err.status : err instanceof BadRequestError ? 400 : err instanceof NotFoundError ? 404 : 500;
  res.status(status).json({ error: message });
}

const guarded =
  (handler: (req: Request, res: Response) => Promise<void> | void) =>
  (req: Request, res: Response): void => {
    void (async () => {
      try {
        await handler(req, res);
      } catch (err) {
        sendError(res, err);
      }
    })();
  };

export function shareRouter(): Router {
  const router = Router();

  router.get("/shares", (_req, res) => {
    const tunnel = tunnelStatus();
    res.json(listShares().map((share) => toShareView(share, tunnel)));
  });

  router.get("/shares/activity", (req, res) => {
    const limit = limitOf(req.query.limit);
    const labels = new Map(listShares().map((share) => [share.id, share.label]));
    res.json(listShareRequests({ limit }).map((item) => ({ ...item, label: labels.get(item.shareId) ?? item.shareId })));
  });

  router.post(
    "/shares",
    guarded((req, res) => {
      const body = req.body as Record<string, unknown>;
      const workspace = asString(body.workspace);
      if (!workspace) throw new BadRequestError("workspace required");
      const requested = asString(body.trust) ?? asString(body.scope);
      const trust = requested ? normalizeTrust(requested) : "low";
      if (!trust) throw new BadRequestError(`trust must be one of: ${TRUST_LEVELS.join(", ")}`);
      const target = resolveWorkspaceTarget(workspace, asString(body.repo));
      const sessionId = asString(body.sessionId);
      if (sessionId) {
        const session = getSession(sessionId);
        if (!session) throw new NotFoundError(`session "${sessionId}" not found`);
        if (!sessionInsideWorkspace(session.cwd, target)) {
          throw new BadRequestError(`session "${session.customTitle ?? session.title ?? sessionId}" runs outside the "${target.workspace}" workspace; pick a session of that workspace or share without a session`);
        }
      }
      const share = createShare({
        label: asString(body.label) ?? `${target.workspace} · ${new Date().toISOString().slice(0, 10)}`,
        workspace: target.workspace,
        repo: target.repo,
        sessionId,
        trust,
        note: asString(body.note),
        model: asString(body.model),
        maxPerHour: perHour(body.maxPerHour) ?? SHARE_DEFAULT_MAX_PER_HOUR,
        expiresAt: hoursToExpiry(body.expiresInHours, 24),
      });
      res.status(201).json(toShareView(share));
    }),
  );

  router.patch(
    "/shares/:id",
    guarded((req, res) => {
      const body = req.body as Record<string, unknown>;
      const current = getShare(String(req.params.id));
      if (!current) throw new NotFoundError("share not found");
      const patch: Parameters<typeof updateShare>[1] = {};
      if (body.label !== undefined) patch.label = asString(body.label) ?? current.label;
      if (body.note !== undefined) patch.note = asString(body.note);
      if (body.paused !== undefined) patch.paused = body.paused === true;
      if (body.revoke === true) patch.revoked = true;
      if (body.expiresInHours !== undefined) patch.expiresAt = hoursToExpiry(body.expiresInHours, null);
      const limit = perHour(body.maxPerHour);
      if (limit !== null) patch.maxPerHour = limit;
      let updated = updateShare(current.id, patch);
      if (body.rotate === true) updated = rotateShareKey(current.id);
      if (patch.revoked) {
        abortShareAsks(current.id, "this share was revoked by its owner");
        abortShareTasks(current.id, "this share was revoked by its owner");
      } else if (patch.paused === true) {
        abortShareAsks(current.id, "this share is paused by its owner; try again later");
        abortShareTasks(current.id, "this share is paused by its owner");
      }
      res.json(updated ? toShareView(updated) : null);
    }),
  );

  router.delete("/shares/:id", (req, res) => {
    abortShareAsks(req.params.id, "this share was removed by its owner while answering");
    abortShareTasks(req.params.id, "this share was removed by its owner");
    if (!deleteShare(req.params.id)) {
      res.status(404).json({ error: "share not found" });
      return;
    }
    res.json({ ok: true });
  });

  router.get("/shares/:id/doc", (req, res) => {
    const share = getShare(req.params.id);
    if (!share) {
      res.status(404).json({ error: "share not found" });
      return;
    }
    const links = shareLinks(share);
    const wanted = asString(req.query.base) ?? "auto";
    const link = wanted === "public" ? links.public : wanted === "lan" ? links.lan : wanted === "local" ? links.local : (links.public ?? links.lan ?? links.local);
    if (!link) {
      res.status(409).json({ error: `no ${wanted} link available` });
      return;
    }
    const base = link.slice(0, link.indexOf("/share/"));
    res.type("text/markdown; charset=utf-8").send(renderShareDoc(share, base));
  });

  router.get("/shares/:id/files", (req, res) => {
    const share = getShare(req.params.id);
    if (!share) {
      res.status(404).json({ error: "share not found" });
      return;
    }
    res.json(listArtifacts(share));
  });

  router.get("/shares/:id/files/:name", (req, res) => {
    const share = getShare(req.params.id);
    if (!share) {
      res.status(404).json({ error: "share not found" });
      return;
    }
    try {
      res.sendFile(artifactPath(share, req.params.name, req.query.direction === "in" ? "in" : "out"), { dotfiles: "allow" });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/shares/:id/requests", (req, res) => {
    if (!getShare(req.params.id)) {
      res.status(404).json({ error: "share not found" });
      return;
    }
    res.json(listShareRequests({ shareId: req.params.id, limit: limitOf(req.query.limit) }));
  });

  router.get("/tunnel", (_req, res) => {
    res.json(tunnelStatus());
  });

  router.post(
    "/tunnel/start",
    guarded(async (_req, res) => {
      res.json(await startTunnel());
    }),
  );

  router.post("/tunnel/stop", (_req, res) => {
    res.json(stopTunnel());
  });

  router.post(
    "/tunnel/install",
    guarded(async (_req, res) => {
      const binary = await installNgrok();
      res.json({ ...tunnelStatus(), binary });
    }),
  );

  router.get(
    "/tunnel/firewall",
    guarded(async (req, res) => {
      res.json(await firewallStatus(req.query.force === "1"));
    }),
  );

  router.post(
    "/tunnel/firewall",
    guarded(async (_req, res) => {
      res.json(await allowFirewall());
    }),
  );

  router.put("/tunnel/settings", (req, res) => {
    const body = req.body as Record<string, unknown>;
    updateTunnelSettings({
      authtoken: body.authtoken === undefined ? undefined : (asString(body.authtoken) ?? null),
      domain: body.domain === undefined ? undefined : (asString(body.domain) ?? null),
    });
    res.json(tunnelStatus());
  });

  return router;
}
