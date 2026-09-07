import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const argValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
};

const HUB_PORT = 14317;
const SHARE_PORT = 14318;
const UI_PORT = 15173;
const uiOrigin = `http://localhost:${UI_PORT}`;
const base = `http://127.0.0.1:${HUB_PORT}`;
const dataDir = argValue("--data") ?? join(repoRoot, ".tmp", "dev-preview");
const seed = has("--seed");
const realCodex = has("--real-codex");

mkdirSync(dataDir, { recursive: true });
const codexHome = realCodex ? null : mkdtempSync(join(tmpdir(), "cchub-preview-codex-"));

const serverEnv = {
  ...process.env,
  HUB_HOST: "127.0.0.1",
  HUB_PORT: String(HUB_PORT),
  HUB_SHARE_PORT: String(SHARE_PORT),
  HUB_DATA_DIR: dataDir,
  HUB_DELEGATION: "1",
  HUB_SKIP: "1",
  HUB_EMPTY_TTL_HOURS: "0",
  HUB_DEV_SEED: "1",
  HUB_TRUSTED_ORIGINS: `${uiOrigin},http://127.0.0.1:${UI_PORT}`,
};
if (codexHome) serverEnv.CODEX_HOME = codexHome;

const children = [];
const spawnChild = (name, bin, argv, cwd, env) => {
  const child = spawn(bin, argv, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => console.log(`[${name}] exited (${code})`));
  children.push(child);
  return child;
};

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  if (codexHome) {
    try {
      rmSync(codexHome, { recursive: true, force: true });
    } catch {
      /* temp codex home is disposable */
    }
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const waitForHub = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("hub did not come up on time");
};

const post = (path, body) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const seedData = async () => {
  const now = Date.now();
  const minute = 60_000;
  const hour = 3_600_000;
  const sessions = [
    { sessionId: "preview-active", kind: "user_prompt", client: "terminal", cwd: repoRoot, model: "claude-opus-4-8", title: "Refactor the executor", claudePid: process.pid, updatedAt: now - 2 * minute },
    { sessionId: "preview-waiting", kind: "notification", client: "vscode", cwd: repoRoot, model: "claude-sonnet-5", title: "Waiting on approval", claudePid: process.pid, updatedAt: now - 20 * minute },
    { sessionId: "preview-old", kind: "session_start", client: "claude-desktop", cwd: repoRoot, model: "claude-opus-4-8", title: "Yesterday's session", updatedAt: now - 26 * hour },
  ];
  for (const session of sessions) await post("/hook", session);
  await post("/delegation/reports", { text: "Preview seeded: three sessions and a couple of reports.", kind: "note", source: "dev-preview" });
  await post("/delegation/reports", { text: "Everything is green on the preview.", kind: "progress", source: "dev-preview" });
  console.log("[seed] posted 3 sessions + 2 reports");
};

const nodeBin = process.execPath;
spawnChild("server", nodeBin, ["--import", "tsx", join(repoRoot, "apps", "server", "src", "index.ts")], join(repoRoot, "apps", "server"), serverEnv);
await waitForHub();
console.log(`[server] up on ${base} (share ${SHARE_PORT}); data ${dataDir}; codexHome ${codexHome ?? "(real ~/.codex)"}`);
if (seed) await seedData();

const viteBin = [join(repoRoot, "node_modules", "vite", "bin", "vite.js"), join(repoRoot, "apps", "ui", "node_modules", "vite", "bin", "vite.js")].find(existsSync);
if (!viteBin) {
  console.error("[ui] vite not found; run npm install first");
  shutdown();
}
spawnChild("ui", nodeBin, [viteBin, "--host", "127.0.0.1", "--port", String(UI_PORT), "--strictPort"], join(repoRoot, "apps", "ui"), { ...process.env, VITE_HUB_URL: base });
console.log(`[ui] starting on ${uiOrigin} (VITE_HUB_URL=${base}); Ctrl+C to stop both`);
