import type { WorkspaceRecord } from "./delegation";

type Searchable = Pick<WorkspaceRecord, "name">;

export const filterWorkspaces = <T extends Searchable>(workspaces: readonly T[], query: string): T[] => {
  const needle = query.trim().toLowerCase();
  return needle ? workspaces.filter((workspace) => workspace.name.toLowerCase().includes(needle)) : [...workspaces];
};

export const splitRepoLines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

export const decodeWorkspaceParam = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const repoCountLabel = (count: number): string => `${count} ${count === 1 ? "repo" : "repos"}`;

export const contextLabel = (workspace: Pick<WorkspaceRecord, "contextPath">): string => workspace.contextPath ?? "no context folder";

export type WorkspaceMenuKey = "edit" | "context" | "delete";

export interface WorkspaceMenuEntry {
  key: WorkspaceMenuKey;
  label: string;
  danger?: boolean;
}

export const workspaceMenuEntries = (editing: boolean, contextOpen = false): WorkspaceMenuEntry[] => [
  { key: "edit", label: editing ? "Close repos editor" : "Edit repos" },
  { key: "context", label: contextOpen ? "Close session context" : "Session context" },
  { key: "delete", label: "Delete", danger: true },
];
