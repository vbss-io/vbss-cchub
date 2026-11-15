import { flattenNodes, type OutlineGroup, type OutlineNode } from "./outliner-model";

export interface FocusCollapse {
  projects: readonly string[];
  tasks: readonly string[];
}

export const FOCUS_COLLAPSE_KEY = "hub.today.collapsed";

export const FOCUS_COLLAPSE_LIMIT = 300;

export const EXPANDED: FocusCollapse = { projects: [], tasks: [] };

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

const capped = (items: readonly string[]): string[] => [...new Set(items)].slice(-FOCUS_COLLAPSE_LIMIT);

export function parseFocusCollapse(raw: string): FocusCollapse {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return EXPANDED;
    const record = value as Record<string, unknown>;
    return { projects: capped(strings(record.projects)), tasks: capped(strings(record.tasks)) };
  } catch {
    return EXPANDED;
  }
}

export const serializeFocusCollapse = (state: FocusCollapse): string => JSON.stringify({ projects: capped(state.projects), tasks: capped(state.tasks) });

export const taskCollapseKey = (node: Pick<OutlineNode, "projectId" | "title">): string => `${node.projectId}\u0000${node.title}`;

export const isProjectCollapsed = (state: FocusCollapse, projectId: string): boolean => state.projects.includes(projectId);

export const hasHiddenContent = (node: Pick<OutlineNode, "children" | "notes">): boolean => node.children.length > 0 || node.notes.length > 0;

export const isTaskCollapsed = (state: FocusCollapse, node: Pick<OutlineNode, "projectId" | "title" | "children" | "notes">): boolean =>
  hasHiddenContent(node) && state.tasks.includes(taskCollapseKey(node));

const withItem = (items: readonly string[], item: string, on: boolean): string[] => (on ? capped([...items.filter((value) => value !== item), item]) : items.filter((value) => value !== item));

export const setProjectCollapsed = (state: FocusCollapse, projectId: string, collapsed: boolean): FocusCollapse => ({ ...state, projects: withItem(state.projects, projectId, collapsed) });

export const setTaskCollapsed = (state: FocusCollapse, node: Pick<OutlineNode, "projectId" | "title">, collapsed: boolean): FocusCollapse => ({
  ...state,
  tasks: withItem(state.tasks, taskCollapseKey(node), collapsed),
});

export const toggleProject = (state: FocusCollapse, projectId: string): FocusCollapse => setProjectCollapsed(state, projectId, !isProjectCollapsed(state, projectId));

export const toggleTask = (state: FocusCollapse, node: Pick<OutlineNode, "projectId" | "title" | "children" | "notes">): FocusCollapse =>
  setTaskCollapsed(state, node, !isTaskCollapsed(state, node));

export function collapseAllFocus(state: FocusCollapse, groups: readonly OutlineGroup[]): FocusCollapse {
  const tasks = groups.flatMap((group) => flattenNodes(group.items).filter(hasHiddenContent).map(taskCollapseKey));
  return { projects: capped([...state.projects, ...groups.map((group) => group.project.id)]), tasks: capped([...state.tasks, ...tasks]) };
}

export function expandAllFocus(state: FocusCollapse, groups: readonly OutlineGroup[]): FocusCollapse {
  const projects = new Set(groups.map((group) => group.project.id));
  const tasks = new Set(groups.flatMap((group) => flattenNodes(group.items).map(taskCollapseKey)));
  return { projects: state.projects.filter((id) => !projects.has(id)), tasks: state.tasks.filter((key) => !tasks.has(key)) };
}

export function isAllExpanded(state: FocusCollapse, groups: readonly OutlineGroup[]): boolean {
  return groups.every((group) => !isProjectCollapsed(state, group.project.id) && flattenNodes(group.items).every((node) => !isTaskCollapsed(state, node)));
}

export function isAllCollapsed(state: FocusCollapse, groups: readonly OutlineGroup[]): boolean {
  return groups.every((group) => isProjectCollapsed(state, group.project.id) && flattenNodes(group.items).every((node) => !hasHiddenContent(node) || isTaskCollapsed(state, node)));
}

function pruneNode(node: OutlineNode, state: FocusCollapse): OutlineNode {
  if (isTaskCollapsed(state, node)) return { ...node, children: [], notes: [] };
  return { ...node, children: node.children.map((child) => pruneNode(child, state)) };
}

export function visibleFocusGroups(groups: readonly OutlineGroup[], state: FocusCollapse): OutlineGroup[] {
  return groups.map((group) => (isProjectCollapsed(state, group.project.id) ? { ...group, items: [] } : { ...group, items: group.items.map((node) => pruneNode(node, state)) }));
}

export interface GroupCounts {
  tasks: number;
  done: number;
}

export function focusGroupCounts(group: OutlineGroup): GroupCounts {
  const nodes = flattenNodes(group.items);
  return { tasks: nodes.length, done: nodes.filter((node) => node.status === "done").length };
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

export function hiddenSummary(node: Pick<OutlineNode, "children" | "notes">): string {
  const subtasks = flattenNodes(node.children).length;
  const parts = [...(subtasks > 0 ? [plural(subtasks, "subtask")] : []), ...(node.notes.length > 0 ? [plural(node.notes.length, "note")] : [])];
  return parts.join(", ");
}

export type HeaderKeyAction = "toggle" | "collapse" | "expand" | "first" | null;

export function headerKeyAction(key: string): HeaderKeyAction {
  if (key === "Enter" || key === " ") return "toggle";
  if (key === "ArrowLeft") return "collapse";
  if (key === "ArrowRight") return "expand";
  if (key === "ArrowDown") return "first";
  return null;
}

export function rowCollapseKey(key: string, collapsed: boolean, expandable: boolean): "collapse" | "expand" | null {
  if (!expandable) return null;
  if (key === "ArrowRight" && collapsed) return "expand";
  if (key === "ArrowLeft" && !collapsed) return "collapse";
  return null;
}
