import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const hooksDir = join(here, "..", "..", "hooks");
export const notifyScript = join(hooksDir, "notify.mjs");
export const codexNotifyScript = join(hooksDir, "codex-notify.mjs");
export const guardScript = join(hooksDir, "guard.mjs");
export const statuslineScript = join(hooksDir, "statusline-cchub.mjs");
export const configureScript = join(hooksDir, "configure.mjs");

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
}

export interface FakeAnswer {
  status?: number;
  body?: unknown;
  raw?: string;
  delayMs?: number;
  destroy?: boolean;
}

export type FakeRoutes = (request: FakeRequest) => FakeAnswer | undefined;

export interface FakeHub {
  port: number;
  requests: FakeRequest[];
  routes: FakeRoutes;
  of: (path: string) => FakeRequest[];
  waitFor: (path: string, count?: number, timeoutMs?: number) => Promise<FakeRequest>;
  close: () => Promise<void>;
}

export async function startFakeHub(routes: FakeRoutes = () => undefined): Promise<FakeHub> {
  const requests: FakeRequest[] = [];
  const hub: FakeHub = {
    port: 0,
    requests,
    routes,
    of: (path) => requests.filter((item) => item.path === path),
    waitFor: async (path, count = 1, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = requests.filter((item) => item.path === path);
        if (found.length >= count) return found[count - 1] as FakeRequest;
        if (Date.now() > deadline) throw new Error(`no request to ${path} within ${timeoutMs} ms`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      const request: FakeRequest = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body };
      requests.push(request);
      const answer = hub.routes(request) ?? {};
      const send = (): void => {
        if (answer.destroy) {
          req.socket.destroy();
          return;
        }
        res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
        res.end(answer.raw ?? JSON.stringify(answer.body ?? {}));
      };
      if (answer.delayMs) setTimeout(send, answer.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  hub.port = typeof address === "object" && address ? address.port : 0;
  return hub;
}

export interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

export interface HookOptions {
  args?: string[];
  input?: string | Record<string, unknown> | null;
  env?: Record<string, string | undefined>;
  hub?: FakeHub | null;
  home?: string;
  cwd?: string;
  timeoutMs?: number;
}

const SCRUBBED = ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH", "HUB_DELEGATED", "HUB_TRACK_SDK", "HUB_SHARE_LABEL", "HUB_TASK_ID", "HUB_RUN_ID", "HUB_HOOK_INLINE", "HUB_HOOK_START_PID", "HUB_SOURCE", "HUB_SKIP", "HUB_GUARD_SHELL", "HUB_WRITE_SCOPE", "HUB_PORT", "HUB_HOST_TARGET"];

export function runScript(script: string, options: HookOptions = {}): Promise<HookRun> {
  const home = options.home ?? tmpdir();
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of SCRUBBED) delete env[key];
  env.HUB_SKIP = "0";
  env.HUB_HOST_TARGET = "127.0.0.1";
  env.HUB_PORT = String(options.hub?.port ?? 1);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...(options.args ?? [])], { env, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${script} did not exit within ${options.timeoutMs ?? 30_000} ms`));
    }, options.timeoutMs ?? 30_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.on("error", () => undefined);
    const input = options.input;
    if (input === undefined) child.stdin.end();
    else if (input === null) child.stdin.end("");
    else child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

export function makeFakeHome(prefix = "cch-s2-hook-home-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

export function seedPidCache(home: string, sessionId: string, info: Record<string, unknown>): void {
  const dir = join(home, ".vbss-cchub", "pids");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(info));
}

export function seedSession(home: string, file: string, content: string | Record<string, unknown>): void {
  const dir = join(home, ".claude", "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), typeof content === "string" ? content : JSON.stringify(content));
}

export const parseStdout = (run: HookRun): Record<string, unknown> | null => (run.stdout.trim() ? (JSON.parse(run.stdout) as Record<string, unknown>) : null);

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
