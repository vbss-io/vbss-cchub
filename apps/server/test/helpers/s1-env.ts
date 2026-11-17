import type { Server } from "node:http";
import { join } from "node:path";
import type { Express } from "express";
import { makeSandbox, sandboxEnv, type Sandbox } from "../helpers.js";

export const S1_AUTOSTART_KEY = "HKCU:\\Software\\vbss-cchub-g0b-s1-missing-key";

export function s1Sandbox(prefix: string, extra: Record<string, string> = {}): Sandbox {
  const box = makeSandbox(prefix);
  const env = sandboxEnv(box, {
    USERPROFILE: box.home,
    HOME: box.home,
    LOCALAPPDATA: join(box.home, "AppData", "Local"),
    HUB_AUTOSTART_KEY: S1_AUTOSTART_KEY,
    HUB_SHARE_PORT: "0",
    HUB_SHARE_HOST: "127.0.0.1",
    ...extra,
  });
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  return box;
}

export interface S1Response {
  status: number;
  text: string;
  json: unknown;
  headers: Headers;
}

export async function s1Request(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<S1Response> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "content-type": "application/json", ...headers };
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json, headers: res.headers };
}

export interface S1Listening {
  base: string;
  server: Server;
  close: () => Promise<void>;
}

export function s1Listen(app: Express): Promise<S1Listening> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}`,
        server,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

export function s1Wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
