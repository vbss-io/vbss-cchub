import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const APP_ORIGINS = [
  "http://tauri.localhost",
  "tauri://localhost",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
];

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

export function trustedOrigins(): Set<string> {
  const own = [`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`];
  return new Set([...own, ...APP_ORIGINS, ...config.trustedOrigins].map((origin) => origin.toLowerCase()));
}

export function isTrustedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  return trustedOrigins().has(origin.trim().toLowerCase());
}

export function delegationGuard(req: Request, res: Response, next: NextFunction): void {
  if (!config.delegationEnabled) {
    res.status(404).json({ error: "delegation disabled: start the hub with HUB_DELEGATION=1" });
    return;
  }
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({ error: "delegation accepts loopback connections only" });
    return;
  }
  if (!isTrustedOrigin(req.header("origin"))) {
    res.status(403).json({ error: "origin not allowed" });
    return;
  }
  next();
}
