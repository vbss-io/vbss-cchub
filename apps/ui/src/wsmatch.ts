import type { WorkspaceRecord } from "./delegation";

const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const isInside = (path: string, parent: string): boolean => path === parent || path.startsWith(`${parent}/`);

export function workspaceOf(workspaces: WorkspaceRecord[], cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const target = normalize(cwd);
  for (const workspace of workspaces) {
    if (workspace.contextPath && isInside(target, normalize(workspace.contextPath))) return workspace.name;
    if (workspace.repos.some((repo) => isInside(target, normalize(repo.path)))) return workspace.name;
  }
  return null;
}

export function repoOf(workspaces: WorkspaceRecord[], cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const target = normalize(cwd);
  for (const workspace of workspaces) {
    const repo = workspace.repos.find((item) => isInside(target, normalize(item.path)));
    if (repo) return repo.name;
  }
  return null;
}
