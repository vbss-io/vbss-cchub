import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { WorkspaceRecord, WorkspaceRepo } from "./delegation-types.js";

const WORKSPACE_EXT = ".code-workspace";
const CONTEXT_FOLDER_NAME = "(workspace)";
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

interface WorkspaceFolder {
  path?: string;
  name?: string;
}

interface WorkspaceFile {
  folders?: WorkspaceFolder[];
  settings?: Record<string, unknown>;
}

const isWhitespace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

function rewriteOutsideStrings(source: string, visit: (index: number) => number | null): string {
  let out = "";
  let index = 0;
  let inString = false;
  while (index < source.length) {
    const ch = source[index] ?? "";
    const next = source[index + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        index += 2;
        continue;
      }
      if (ch === '"') inString = false;
      index += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      index += 1;
      continue;
    }
    const skipTo = visit(index);
    if (skipTo !== null) {
      index = skipTo;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

function removeComments(source: string): string {
  return rewriteOutsideStrings(source, (index) => {
    const ch = source[index];
    const next = source[index + 1];
    if (ch === "/" && next === "/") {
      let end = index;
      while (end < source.length && source[end] !== "\n") end += 1;
      return end;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      return end < 0 ? source.length : end + 2;
    }
    return null;
  });
}

function removeTrailingCommas(source: string): string {
  return rewriteOutsideStrings(source, (index) => {
    if (source[index] !== ",") return null;
    let ahead = index + 1;
    while (ahead < source.length && isWhitespace(source[ahead] ?? "")) ahead += 1;
    return source[ahead] === "}" || source[ahead] === "]" ? index + 1 : null;
  });
}

export function stripJsonc(source: string): string {
  return removeTrailingCommas(removeComments(source));
}

export function parseWorkspaceFile(file: string): WorkspaceFile {
  const raw = readFileSync(file, "utf8");
  try {
    return JSON.parse(raw) as WorkspaceFile;
  } catch {
    return JSON.parse(stripJsonc(raw)) as WorkspaceFile;
  }
}

export function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isInside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

const workspaceFile = (root: string, name: string): string => join(root, `${name}${WORKSPACE_EXT}`);

export function readWorkspace(root: string, file: string): WorkspaceRecord {
  const name = basename(file, WORKSPACE_EXT);
  const record: WorkspaceRecord = { name, file, contextPath: null, repos: [], error: null };
  let parsed: WorkspaceFile;
  try {
    parsed = parseWorkspaceFile(file);
  } catch (err) {
    record.error = err instanceof Error ? err.message : "unreadable workspace file";
    return record;
  }
  const baseDir = dirname(file);
  const contextDir = resolve(root, name);
  const repos: WorkspaceRepo[] = [];
  for (const folder of Array.isArray(parsed.folders) ? parsed.folders : []) {
    if (typeof folder.path !== "string" || folder.path.length === 0) continue;
    const path = isAbsolute(folder.path) ? resolve(folder.path) : resolve(baseDir, folder.path);
    if (samePath(path, contextDir)) {
      record.contextPath = path;
      continue;
    }
    repos.push({ name: folder.name ?? basename(path), path });
  }
  record.repos = repos;
  return record;
}

export function discoverWorkspaces(root: string | null): WorkspaceRecord[] {
  if (!root || !isDirectory(root)) return [];
  return readdirSync(root)
    .filter((entry) => entry.endsWith(WORKSPACE_EXT))
    .sort()
    .map((entry) => readWorkspace(root, join(root, entry)));
}

export function findWorkspace(root: string | null, workspace: string): WorkspaceRecord | null {
  return discoverWorkspaces(root).find((item) => item.name === workspace) ?? null;
}

export function findRepo(workspace: WorkspaceRecord, repo: string): WorkspaceRepo | null {
  const wanted = repo.trim().toLowerCase();
  return (
    workspace.repos.find((item) => item.name.toLowerCase() === wanted) ??
    workspace.repos.find((item) => basename(item.path).toLowerCase() === wanted) ??
    null
  );
}

export function workspaceFor(workspaces: WorkspaceRecord[], cwd: string | null): WorkspaceRecord | null {
  if (!cwd) return null;
  const target = resolve(cwd);
  for (const workspace of workspaces) {
    if (workspace.contextPath && isInside(target, workspace.contextPath)) return workspace;
    if (workspace.repos.some((repo) => isInside(target, repo.path))) return workspace;
  }
  return null;
}

export function workspaceBrief(workspace: WorkspaceRecord, cwd: string): string {
  const lines = [
    `You are running inside the "${workspace.name}" workspace, launched by the CC Hub.`,
    `Working directory: ${cwd}`,
    workspace.contextPath
      ? `Workspace context folder (CLAUDE.md, skills, docs): ${workspace.contextPath}`
      : "This workspace has no context folder.",
    "Repositories of this workspace (all accessible; never ask which folder a project lives in, use this map):",
    ...workspace.repos.map((repo) => `- ${repo.name}: ${repo.path}`),
  ];
  return lines.join("\n");
}

function folderEntry(root: string, path: string): WorkspaceFolder {
  const rel = relative(root, path);
  const usable = rel.length === 0 || isAbsolute(rel) ? path : rel;
  return { name: basename(path), path: usable.replace(/\\/g, "/") };
}

function seedContextFolder(root: string, name: string, repos: WorkspaceRepo[]): string {
  const contextDir = join(root, name);
  mkdirSync(join(contextDir, ".claude"), { recursive: true });
  const claudeMd = join(contextDir, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    const lines = [
      `# ${name}`,
      "",
      `Workspace-level context for \`${name}\`. Everything Claude Code or Codex should know when working across these repositories goes here.`,
      "",
      "## Repositories",
      "",
      ...repos.map((repo) => `- \`${repo.name}\` → \`${repo.path}\``),
      "",
    ];
    writeFileSync(claudeMd, lines.join("\n"));
  }
  return contextDir;
}

function writeWorkspaceFile(root: string, name: string, repos: string[], settings: Record<string, unknown>): void {
  const folders: WorkspaceFolder[] = [{ name: CONTEXT_FOLDER_NAME, path: name }];
  for (const repoPath of repos) folders.push(folderEntry(root, resolve(repoPath)));
  writeFileSync(workspaceFile(root, name), `${JSON.stringify({ folders, settings }, null, 2)}\n`);
}

function uniqueExistingDirs(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const path = resolve(raw.trim());
    if (raw.trim().length === 0) continue;
    if (!isDirectory(path)) throw new Error(`repo path is not a directory: ${path}`);
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

export function createWorkspace(root: string, name: string, repos: string[]): WorkspaceRecord {
  if (!NAME_PATTERN.test(name)) throw new Error("workspace name must be letters, digits, dots, dashes or underscores");
  if (!isDirectory(root)) throw new Error(`workspaces root is not a directory: ${root}`);
  const file = workspaceFile(root, name);
  if (existsSync(file)) throw new Error(`workspace "${name}" already exists`);
  const dirs = uniqueExistingDirs(repos);
  seedContextFolder(root, name, dirs.map((path) => ({ name: basename(path), path })));
  writeWorkspaceFile(root, name, dirs, {});
  return readWorkspace(root, file);
}

export function updateWorkspace(root: string, name: string, repos: string[]): WorkspaceRecord {
  const file = workspaceFile(root, name);
  if (!existsSync(file)) throw new Error(`workspace "${name}" not found`);
  const dirs = uniqueExistingDirs(repos);
  const current = parseWorkspaceFile(file);
  seedContextFolder(root, name, dirs.map((path) => ({ name: basename(path), path })));
  writeWorkspaceFile(root, name, dirs, current.settings ?? {});
  return readWorkspace(root, file);
}

export function deleteWorkspace(
  root: string,
  name: string,
  deleteContext: boolean,
): { file: string; contextPath: string | null; contextDeleted: boolean } {
  if (!NAME_PATTERN.test(name)) throw new Error("invalid workspace name");
  const file = workspaceFile(root, name);
  if (!existsSync(file)) throw new Error(`workspace "${name}" not found`);
  const contextPath = join(root, name);
  unlinkSync(file);
  let contextDeleted = false;
  if (deleteContext && isDirectory(contextPath) && isInside(contextPath, root) && !samePath(contextPath, root)) {
    rmSync(contextPath, { recursive: true, force: true });
    contextDeleted = true;
  }
  return { file, contextPath: isDirectory(contextPath) || contextDeleted ? contextPath : null, contextDeleted };
}

const EDITOR_CANDIDATES: Record<string, () => string[]> = {
  code: () => {
    const local = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "";
    return [
      join(local, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
      join(programFiles, "Microsoft VS Code", "bin", "code.cmd"),
    ];
  },
  cursor: () => {
    const local = process.env.LOCALAPPDATA ?? "";
    return [join(local, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd")];
  },
};

export function resolveEditorCommand(command: string): string {
  const trimmed = command.trim();
  if (process.platform !== "win32" || trimmed.includes("\\") || trimmed.includes("/")) return trimmed;
  const candidates = EDITOR_CANDIDATES[trimmed.toLowerCase()]?.() ?? [];
  return candidates.find((candidate) => existsSync(candidate)) ?? trimmed;
}

export function openWorkspace(file: string, editorCommand: string): { ok: boolean; error: string | null; command: string } {
  const command = resolveEditorCommand(editorCommand);
  if (!existsSync(file)) return { ok: false, error: "workspace file not found", command };
  try {
    const child =
      process.platform === "win32"
        ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${command}" "${file}""`], {
            windowsVerbatimArguments: true,
            windowsHide: true,
            detached: true,
            stdio: "ignore",
          })
        : spawn(command, [file], { detached: true, stdio: "ignore" });
    child.on("error", (err) => console.error(`open workspace failed: ${err.message}`));
    child.unref();
    return { ok: true, error: null, command };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "failed to open editor", command };
  }
}
