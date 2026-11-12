import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const argValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
};

const taskPortBase = Number(process.env.HUB_PORT_BASE) || null;
const HUB_PORT = Number(process.env.PREVIEW_HUB_PORT) || taskPortBase || 14317;
const SHARE_PORT = Number(process.env.PREVIEW_SHARE_PORT) || (taskPortBase ? taskPortBase + 1 : 14318);
const UI_PORT = Number(process.env.PREVIEW_UI_PORT) || (taskPortBase ? taskPortBase + 2 : 15173);
const uiOrigin = `http://localhost:${UI_PORT}`;
const base = `http://127.0.0.1:${HUB_PORT}`;
const fromReal = has("--from-real");
const dataDir = fromReal ? resolve(argValue("--data") ?? join(repoRoot, ".tmp", "dev-preview-real")) : (argValue("--data") ?? join(repoRoot, ".tmp", "dev-preview"));
const seed = has("--seed") && !fromReal;
const realCodex = has("--real-codex");
const realData = resolve(argValue("--real-data") ?? join(homedir(), ".vbss-cchub"));
const MAX_VAULT_BYTES = 500 * 1024 * 1024;
const WORKSPACE_EXT = ".code-workspace";
const SETTING_KEYS = ["secondBrainRoot", "daily.dir", "daily.template", "tasks.root", "trail.dir", "workspacesRoot"];
const VAULT_PATH_KEYS = ["daily.dir", "daily.template", "tasks.root", "trail.dir"];

const isInside = (parent, child) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const isDirectory = (path) => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
const formatBytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const keepEntry = (path) => {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return false;
  return !(stats.isDirectory() && basename(path).startsWith("."));
};
const treeBytes = (path) => {
  if (!keepEntry(path)) return 0;
  const stats = lstatSync(path);
  if (!stats.isDirectory()) return stats.size;
  return readdirSync(path).reduce((total, entry) => total + treeBytes(join(path, entry)), 0);
};
const stringEnd = (text, start) => {
  let index = start + 1;
  while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
  return index;
};

const parseJsonString = (literal) => {
  try {
    return JSON.parse(literal);
  } catch {
    return null;
  }
};

const absolutizeFolderPaths = (text, baseDir, contextName) => {
  const frames = [];
  let out = "";
  let copied = 0;
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const ch = text[index];
    const next = text[index + 1];
    const top = frames[frames.length - 1];
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
    } else if (ch === "{" || ch === "[") {
      frames.push({ array: ch === "[", parentKey: top ? top.key : null, key: null, expectKey: ch === "{" });
      index += 1;
    } else if (ch === "}" || ch === "]") {
      frames.pop();
      index += 1;
    } else if (ch === "," && top) {
      top.key = null;
      top.expectKey = !top.array;
      index += 1;
    } else if (ch === ":" && top) {
      top.expectKey = false;
      index += 1;
    } else if (ch === '"') {
      const end = stringEnd(text, index);
      const value = parseJsonString(text.slice(index, end + 1));
      if (top && !top.array && top.expectKey) {
        top.key = value;
      } else if (frames.length === 3 && frames[1].array && frames[1].parentKey === "folders" && top.key === "path" && typeof value === "string" && value.length > 0 && !isAbsolute(value) && value !== contextName) {
        out += text.slice(copied, index) + JSON.stringify(resolve(baseDir, value).replace(/\\/g, "/"));
        copied = end + 1;
        count += 1;
      }
      index = end + 1;
    } else {
      index += 1;
    }
  }
  return { text: out + text.slice(copied), count };
};
const removeLink = (path) => {
  if (!lstatSync(path, { throwIfNoEntry: false })) return;
  try {
    unlinkSync(path);
  } catch {
    rmSync(path, { recursive: false, force: true });
  }
};
const removeDbFiles = (path) => {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
};

const prepareFromReal = async () => {
  if (isInside(realData, dataDir) || isInside(dataDir, realData)) {
    console.error(`[from-real] refusing to run: --data (${dataDir}) overlaps --real-data (${realData})`);
    process.exit(1);
  }
  const realDb = join(realData, "hub.db");
  if (!existsSync(realDb)) {
    console.error(`[from-real] no hub.db in ${realData}`);
    process.exit(1);
  }
  const Database = createRequire(join(repoRoot, "apps", "server", "package.json"))("better-sqlite3");
  const copyDb = join(dataDir, "hub.db");
  const partialDb = join(dataDir, "hub.db.partial");
  const vaultDir = join(dataDir, "vault");
  const workspacesDir = join(dataDir, "workspaces");
  const homeDir = join(dataDir, "home");
  const codexHomeCopy = join(homeDir, ".codex");
  const sessionsLink = join(codexHomeCopy, "sessions");
  const summary = { reused: false, vaultBytes: 0, remapped: [], warnings: [], workspaceFiles: 0, absolutizedFolders: 0 };

  mkdirSync(dataDir, { recursive: true });
  removeDbFiles(partialDb);
  if (has("--refresh")) {
    removeLink(sessionsLink);
    removeDbFiles(copyDb);
    for (const target of [vaultDir, workspacesDir]) rmSync(target, { recursive: true, force: true });
  }

  if (existsSync(copyDb)) {
    summary.reused = true;
  } else {
    const source = new Database(realDb, { readonly: true, fileMustExist: true });
    try {
      await source.backup(partialDb);
    } finally {
      source.close();
    }
    const db = new Database(partialDb);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS hub_settings (key TEXT PRIMARY KEY, value TEXT)");
      const read = (key) => {
        const value = db.prepare("SELECT value FROM hub_settings WHERE key = ?").get(key)?.value;
        return typeof value === "string" && value.trim().length > 0 ? value : null;
      };
      const write = (key, value) => {
        if (value === null) db.prepare("DELETE FROM hub_settings WHERE key = ?").run(key);
        else db.prepare("INSERT INTO hub_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
      };
      const settings = Object.fromEntries(SETTING_KEYS.map((key) => [key, read(key)]));
      const realRoot = settings.secondBrainRoot ? resolve(settings.secondBrainRoot) : null;

      if (realRoot && isDirectory(realRoot)) {
        const against = (value) => (isAbsolute(value) ? resolve(value) : resolve(realRoot, value));
        const templatePath = against(settings["daily.template"] ?? join("_templates", "daily.md"));
        const templateDir = dirname(templatePath);
        const candidates = [
          against(settings["daily.dir"] ?? "daily"),
          against(settings["tasks.root"] ?? "projects"),
          against(settings["trail.dir"] ?? "trail"),
          join(realRoot, "fontes", "hub"),
          templatePath,
          ...(templateDir === realRoot ? [] : [templateDir]),
        ];
        const picked = [];
        for (const candidate of candidates) {
          if (!isInside(realRoot, candidate) || candidate === realRoot) {
            summary.warnings.push(`not copied (outside the vault root, or the root itself): ${candidate}`);
            continue;
          }
          if (!lstatSync(candidate, { throwIfNoEntry: false }) || !keepEntry(candidate)) continue;
          if (picked.some((other) => isInside(other, candidate))) continue;
          for (let index = picked.length - 1; index >= 0; index -= 1) if (isInside(candidate, picked[index])) picked.splice(index, 1);
          picked.push(candidate);
        }
        summary.vaultBytes = picked.reduce((total, path) => total + treeBytes(path), 0);
        console.log(`[from-real] vault selection: ${picked.length} path(s), ${formatBytes(summary.vaultBytes)} (limit ${formatBytes(MAX_VAULT_BYTES)})`);
        if (summary.vaultBytes > MAX_VAULT_BYTES) {
          db.close();
          removeDbFiles(partialDb);
          console.error(`[from-real] vault selection is ${formatBytes(summary.vaultBytes)}, above the limit; aborted before copying`);
          process.exit(1);
        }
        mkdirSync(vaultDir, { recursive: true });
        for (const path of picked) {
          const target = join(vaultDir, relative(realRoot, path));
          mkdirSync(dirname(target), { recursive: true });
          cpSync(path, target, { recursive: true, filter: (entry) => entry === path || keepEntry(entry) });
        }
        write("secondBrainRoot", vaultDir);
        summary.remapped.push(`secondBrainRoot -> ${vaultDir}`);
        for (const key of VAULT_PATH_KEYS) {
          const value = settings[key];
          if (value === null) continue;
          const abs = against(value);
          if (!isInside(realRoot, abs)) {
            write(key, null);
            summary.warnings.push(`${key} (${value}) is outside the vault root; cleared in the copy`);
          } else if (isAbsolute(value)) {
            const mapped = join(vaultDir, relative(realRoot, abs));
            write(key, mapped);
            summary.remapped.push(`${key} -> ${mapped}`);
          }
        }
      } else {
        for (const key of ["secondBrainRoot", ...VAULT_PATH_KEYS]) write(key, null);
        summary.warnings.push(settings.secondBrainRoot ? `secondBrainRoot ${settings.secondBrainRoot} is not a directory; vault not copied, vault paths cleared` : "no secondBrainRoot in the hub settings; vault not copied");
      }

      mkdirSync(workspacesDir, { recursive: true });
      const realWorkspaces = settings.workspacesRoot ? resolve(settings.workspacesRoot) : null;
      if (realWorkspaces && isDirectory(realWorkspaces)) {
        for (const entry of readdirSync(realWorkspaces)) {
          const file = join(realWorkspaces, entry);
          if (!entry.endsWith(WORKSPACE_EXT) || !lstatSync(file).isFile()) continue;
          const contextName = entry.slice(0, -WORKSPACE_EXT.length);
          const rewritten = absolutizeFolderPaths(readFileSync(file, "utf8"), realWorkspaces, contextName);
          writeFileSync(join(workspacesDir, entry), rewritten.text);
          mkdirSync(join(workspacesDir, contextName), { recursive: true });
          summary.workspaceFiles += 1;
          summary.absolutizedFolders += rewritten.count;
        }
      } else if (settings.workspacesRoot) {
        summary.warnings.push(`workspacesRoot ${settings.workspacesRoot} is not a directory; workspaces copy is empty`);
      }
      write("workspacesRoot", workspacesDir);
      summary.remapped.push(`workspacesRoot -> ${workspacesDir} (${summary.workspaceFiles} ${WORKSPACE_EXT} file(s))`);
    } finally {
      db.close();
    }
    for (const sidecar of [`${partialDb}-wal`, `${partialDb}-shm`]) rmSync(sidecar, { force: true });
    renameSync(partialDb, copyDb);
  }

  mkdirSync(codexHomeCopy, { recursive: true });
  mkdirSync(join(homeDir, "AppData", "Roaming"), { recursive: true });
  const realCodexSessions = join(homedir(), ".codex", "sessions");
  if (!lstatSync(sessionsLink, { throwIfNoEntry: false })) {
    if (isDirectory(realCodexSessions)) {
      try {
        symlinkSync(realCodexSessions, sessionsLink, "junction");
      } catch (err) {
        mkdirSync(sessionsLink, { recursive: true });
        summary.warnings.push(`could not link ${realCodexSessions} (${err instanceof Error ? err.message : "error"}); Codex sessions will be empty`);
      }
    } else {
      mkdirSync(sessionsLink, { recursive: true });
    }
  }

  const fixtures = join(repoRoot, "apps", "server", "test", "fixtures");
  const env = {
    HUB_HOME: homeDir,
    APPDATA: join(homeDir, "AppData", "Roaming"),
    CODEX_HOME: codexHomeCopy,
    HUB_CLAUDE_PROJECTS_DIR: join(homedir(), ".claude", "projects"),
    HUB_CLAUDE_CREDENTIALS: join(homeDir, ".claude", ".credentials.json"),
    HUB_CLAUDE_STATE: join(homeDir, ".claude.json"),
    HUB_CLAUDE_BIN: process.execPath,
    HUB_CLAUDE_ARGS_PREFIX: JSON.stringify([join(fixtures, "fake-claude.mjs")]),
    HUB_CODEX_BIN: process.execPath,
    HUB_CODEX_ARGS_PREFIX: JSON.stringify([join(fixtures, "fake-codex.mjs")]),
    HUB_NGROK_BIN: process.execPath,
    HUB_NGROK_ARGS_PREFIX: JSON.stringify([join(fixtures, "fake-ngrok.mjs")]),
    HUB_AUTOSTART_KEY: "HKCU:\\Software\\vbss-cchub-preview\\Run",
    FAKE_CLAUDE_DELAY_MS: "400",
    HUB_SHARE_ENV_PASSTHROUGH: "FAKE_CLAUDE_DELAY_MS",
  };
  return { env, summary, vaultDir, homeDir };
};

mkdirSync(dataDir, { recursive: true });
const realPrep = fromReal ? await prepareFromReal() : null;
const codexHome = realCodex || fromReal ? null : mkdtempSync(join(tmpdir(), "cchub-preview-codex-"));

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
if (realPrep) {
  for (const key of ["HUB_DEV_SEED", "HUB_SECOND_BRAIN", "HUB_WORKSPACES_ROOT", "HUB_EDITOR", "HUB_RESOURCE_DIR", "HUB_STATIC_DIR", "HUB_APP_EXE", "HUB_PARENT_PID", "HUB_URL"]) delete serverEnv[key];
  Object.assign(serverEnv, realPrep.env);
  serverEnv.HUB_PREVIEW = "1";
}

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
    { sessionId: "preview-ended", kind: "session_start", client: "terminal", cwd: repoRoot, model: "claude-opus-4-8", title: "Finished cleanup", updatedAt: now - 3 * hour },
    { sessionId: "preview-ended", kind: "session_end", client: "terminal", cwd: repoRoot, model: "claude-opus-4-8", title: "Finished cleanup", updatedAt: now - 2 * hour },
  ];
  for (const session of sessions) await post("/hook", session);
  const workspacesRoot = join(dataDir, "workspaces");
  mkdirSync(workspacesRoot, { recursive: true });
  await fetch(`${base}/delegation/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspacesRoot }) });
  const workspace = await post("/delegation/workspaces", { name: "preview", repos: [repoRoot] });
  await post("/delegation/reports", { text: "Preview seeded: four sessions (one ended), the preview workspace and a couple of reports.", kind: "note", source: "dev-preview" });
  await post("/delegation/reports", { text: "Everything is green on the preview.", kind: "progress", source: "dev-preview" });
  console.log(`[seed] posted 4 sessions (1 ended) + workspace "preview" (${workspace.status}) + 2 reports`);
};

const nodeBin = process.execPath;
const systemCaArgs = spawnSync(nodeBin, ["--use-system-ca", "-e", "0"], { stdio: "ignore" }).status === 0 ? ["--use-system-ca"] : [];
spawnChild("server", nodeBin, [...systemCaArgs, "--import", "tsx", join(repoRoot, "apps", "server", "src", "index.ts")], join(repoRoot, "apps", "server"), serverEnv);
await waitForHub();
console.log(`[server] up on ${base} (share ${SHARE_PORT}); data ${dataDir}; codexHome ${realPrep ? realPrep.env.CODEX_HOME : (codexHome ?? "(real ~/.codex)")}`);
if (realPrep) {
  const { summary } = realPrep;
  console.log("[from-real] ----------------------------------------------");
  console.log(`[from-real] source:     ${realData} (opened read-only, online backup)`);
  console.log(`[from-real] copy dir:   ${dataDir}${summary.reused ? " (existing copy kept; pass --refresh to rebuild)" : ""}`);
  console.log(`[from-real] vault copy: ${realPrep.vaultDir} (${formatBytes(summary.vaultBytes)})`);
  for (const item of summary.remapped) console.log(`[from-real] remapped:   ${item}`);
  for (const warning of summary.warnings) console.log(`[from-real] WARNING:    ${warning}`);
  console.log(`[from-real] isolation:  HUB_HOME ${realPrep.homeDir}; fake claude/codex/ngrok runners; no Claude credentials; Claude projects and Codex sessions are read-only`);
  console.log(`[from-real] open:       ${uiOrigin}`);
  console.log(`[from-real] workspaces: ${summary.workspaceFiles} ${WORKSPACE_EXT} file(s) copied, ${summary.absolutizedFolders} folder path(s) rewritten to absolute paths of your real repos`);
  console.log("[from-real] real hub db, vault and home are untouched; git writes to your repos are disabled in this preview (merge, discard and worktree creation are refused)");
  console.log("[from-real] ----------------------------------------------");
}
if (seed) await seedData();

const viteBin = [join(repoRoot, "node_modules", "vite", "bin", "vite.js"), join(repoRoot, "apps", "ui", "node_modules", "vite", "bin", "vite.js")].find(existsSync);
if (!viteBin) {
  console.error("[ui] vite not found; run npm install first");
  shutdown();
}
spawnChild("ui", nodeBin, [viteBin, "--host", "127.0.0.1", "--port", String(UI_PORT), "--strictPort"], join(repoRoot, "apps", "ui"), { ...process.env, VITE_HUB_URL: base });
console.log(`[ui] starting on ${uiOrigin} (VITE_HUB_URL=${base}); Ctrl+C to stop both`);
