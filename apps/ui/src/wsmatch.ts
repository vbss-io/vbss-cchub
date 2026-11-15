import type { WorkspaceRecord } from "./delegation";

const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const isInside = (path: string, parent: string): boolean => path === parent || path.startsWith(`${parent}/`);

interface WorkspaceIndex {
  entries: { name: string; contextPath: string | null; repos: { name: string; path: string }[] }[];
  workspaceByCwd: Map<string, string | null>;
  repoByCwd: Map<string, string | null>;
}

const indexes = new WeakMap<WorkspaceRecord[], WorkspaceIndex>();

function indexOf(workspaces: WorkspaceRecord[]): WorkspaceIndex {
  const cached = indexes.get(workspaces);
  if (cached) return cached;
  const index: WorkspaceIndex = {
    entries: workspaces.map((workspace) => ({
      name: workspace.name,
      contextPath: workspace.contextPath ? normalize(workspace.contextPath) : null,
      repos: workspace.repos.map((repo) => ({ name: repo.name, path: normalize(repo.path) })),
    })),
    workspaceByCwd: new Map(),
    repoByCwd: new Map(),
  };
  indexes.set(workspaces, index);
  return index;
}

export function workspaceOf(workspaces: WorkspaceRecord[], cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const index = indexOf(workspaces);
  const known = index.workspaceByCwd.get(cwd);
  if (known !== undefined) return known;
  const target = normalize(cwd);
  const match = index.entries.find(
    (entry) => (entry.contextPath !== null && isInside(target, entry.contextPath)) || entry.repos.some((repo) => isInside(target, repo.path)),
  );
  const name = match ? match.name : null;
  index.workspaceByCwd.set(cwd, name);
  return name;
}

export function repoOf(workspaces: WorkspaceRecord[], cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const index = indexOf(workspaces);
  const known = index.repoByCwd.get(cwd);
  if (known !== undefined) return known;
  const target = normalize(cwd);
  let name: string | null = null;
  for (const entry of index.entries) {
    const repo = entry.repos.find((item) => isInside(target, item.path));
    if (repo) {
      name = repo.name;
      break;
    }
  }
  index.repoByCwd.set(cwd, name);
  return name;
}

export function shortFolder(cwd: string | null | undefined): string {
  if (!cwd) return "—";
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  const anchor = parts.findIndex((part) => part.toLowerCase() === ".workspaces");
  if (anchor >= 0 && anchor < parts.length - 1) return parts.slice(anchor + 1).join("/");
  return parts.slice(-2).join("/");
}
