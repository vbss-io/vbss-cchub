import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const serverDir = join(here, "..");
export const fixtures = join(here, "fixtures");

export interface Sandbox {
  tmp: string;
  home: string;
  dataDir: string;
  root: string;
  contextDir: string;
  repoA: string;
  repoB: string;
  brain: string;
  codexHome: string;
  claudeCapture: string;
  codexCapture: string;
}

function freshRollout(now: Date): string {
  const sample = readFileSync(join(fixtures, "rollout-sample.jsonl"), "utf8");
  return sample.replace(/"timestamp":"[^"]+"/g, () => `"timestamp":"${new Date(now.getTime() - 60_000).toISOString()}"`);
}

export function makeSandbox(prefix: string): Sandbox {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const home = join(tmp, "home");
  const root = join(tmp, "workspaces");
  const contextDir = join(root, "pilot");
  const repoA = join(tmp, "repo-a");
  const repoB = join(tmp, "repo-b");
  const brain = join(tmp, "brain");
  const codexHome = join(tmp, "codex");
  for (const dir of [home, contextDir, repoA, repoB, join(brain, "diario"), join(brain, "fontes", "sessions")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    join(root, "pilot.code-workspace"),
    `{
      // one workspace, two repos
      "folders": [
        { "name": "(workspace)", "path": "pilot" },
        { "name": "repo-a", "path": "../repo-a" },
        { "name": "repo-b", "path": "../repo-b" },
      ],
    }`,
  );
  const now = new Date();
  const day = join(
    codexHome,
    "sessions",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  );
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-sample.jsonl"), freshRollout(now));
  return {
    tmp,
    home,
    dataDir: join(tmp, "data"),
    root,
    contextDir,
    repoA,
    repoB,
    brain,
    codexHome,
    claudeCapture: join(tmp, "claude-capture.json"),
    codexCapture: join(tmp, "codex-capture.json"),
  };
}

export function sandboxEnv(box: Sandbox, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HUB_HOME: box.home,
    APPDATA: join(box.home, "AppData", "Roaming"),
    CODEX_HOME: box.codexHome,
    HUB_DATA_DIR: box.dataDir,
    HUB_HOST: "127.0.0.1",
    HUB_CLAUDE_BIN: process.execPath,
    HUB_CLAUDE_ARGS_PREFIX: JSON.stringify([join(fixtures, "fake-claude.mjs")]),
    HUB_CODEX_BIN: process.execPath,
    HUB_CODEX_ARGS_PREFIX: JSON.stringify([join(fixtures, "fake-codex.mjs")]),
    HUB_SKIP: "1",
    FAKE_CLAUDE_DELAY_MS: "150",
    FAKE_CLAUDE_CAPTURE: box.claudeCapture,
    FAKE_CODEX_CAPTURE: box.codexCapture,
    HUB_SHARE_FORK_IDLE_MS: "400",
    HUB_SHARE_ENV_PASSTHROUGH: "FAKE_CLAUDE_CAPTURE,FAKE_CLAUDE_DELAY_MS,FAKE_CLAUDE_MODE,FAKE_CODEX_CAPTURE",
    ...extra,
  };
  for (const key of ["HUB_RESOURCE_DIR", "HUB_WORKSPACES_ROOT", "HUB_EDITOR", "HUB_TRUSTED_ORIGINS", "HUB_SECOND_BRAIN"]) {
    delete env[key];
  }
  return env;
}

export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const value = address.port;
        probe.close(() => resolvePort(value));
      } else {
        probe.close(() => reject(new Error("no port")));
      }
    });
    probe.on("error", reject);
  });
}

export async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

export interface RunningServer {
  child: ChildProcess;
  port: number;
  base: string;
}

export async function startServer(box: Sandbox, extra: Record<string, string>): Promise<RunningServer> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", join(serverDir, "src", "index.ts")], {
    cwd: serverDir,
    env: sandboxEnv(box, { HUB_PORT: String(port), ...extra }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[server ${port}] ${chunk.toString()}`));
  await waitFor(async () => {
    try {
      const res = await fetch(`${base}/api/health`);
      return res.ok ? true : null;
    } catch {
      return null;
    }
  }, 20000);
  return { child, port, base };
}
