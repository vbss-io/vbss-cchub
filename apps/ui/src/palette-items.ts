import type { BoardProject, BoardTask, WorkspaceRecord } from "./delegation";
import type { PaletteItem } from "./palette-model";
import { hitDetail, hitHeadline } from "./memory-model";
import type { CodexSessionRecord, HistoryHit, SessionRecord } from "./types";
import { SETTINGS_TAB_KEYWORDS, type SettingsTabEntry } from "./settings-model";
import { settingsTabs } from "./settings-sections";
import { shortFolder, workspaceOf } from "./wsmatch";

export const PALETTE_SESSION_CAP = 80;
export const PALETTE_TASK_CAP = 300;

export interface PaletteViewSource {
  key: string;
  label: string;
  subtitle: string;
  enabled: boolean;
}

export const buildViewItems = (views: PaletteViewSource[], go: (view: string, param?: string | null) => void, tabs: SettingsTabEntry[] = settingsTabs(null)): PaletteItem[] => {
  const items: PaletteItem[] = [];
  for (const view of views) {
    if (!view.enabled) continue;
    items.push({
      id: `view:${view.key}`,
      kind: "view",
      title: view.label,
      subtitle: view.subtitle,
      keywords: [`go to ${view.label}`, `open ${view.label}`],
      run: () => go(view.key),
    });
  }
  for (const tab of tabs) {
    items.push({
      id: `settings:${tab.key}`,
      kind: "view",
      title: `Settings › ${tab.label}`,
      keywords: ["settings", "preferences", "options", tab.label, ...(SETTINGS_TAB_KEYWORDS[tab.key] ?? [])],
      run: () => go("settings", tab.key),
    });
  }
  return items;
};

export type SessionClass = "live" | "recent" | null;

export interface SessionActions {
  classify: (session: SessionRecord) => SessionClass;
  focus: (sessionId: string) => void;
  open: (sessionId: string) => void;
  focusCodex: () => void;
  openCodex: (threadId: string) => void;
}

const folderName = (cwd: string | null): string | null => {
  if (!cwd) return null;
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || null;
};

const joinSubtitle = (parts: (string | null | undefined)[]): string => parts.filter((part): part is string => Boolean(part)).join(" · ");

export const buildSessionItems = (sessions: SessionRecord[], codex: CodexSessionRecord[], workspaces: WorkspaceRecord[], actions: SessionActions): PaletteItem[] => {
  const entries: { at: number; item: PaletteItem }[] = [];
  for (const session of sessions) {
    const mode = actions.classify(session);
    if (mode === null) continue;
    const workspace = workspaceOf(workspaces, session.cwd);
    const title = session.customTitle ?? session.title ?? folderName(session.cwd) ?? session.sessionId.slice(0, 8);
    entries.push({
      at: session.updatedAt,
      item: {
        id: `session:${session.sessionId}`,
        kind: "session",
        title,
        subtitle: joinSubtitle([workspace ?? shortFolder(session.cwd), mode === "live" ? session.status : "recent"]),
        keywords: [session.cwd ?? "", workspace ?? "", "claude"],
        run: () => (mode === "live" ? actions.focus(session.sessionId) : actions.open(session.sessionId)),
      },
    });
  }
  for (const thread of codex) {
    if (thread.hidden || thread.archivedAt != null) continue;
    const workspace = workspaceOf(workspaces, thread.cwd);
    const live = thread.status !== "ended";
    entries.push({
      at: thread.updatedAt,
      item: {
        id: `codex:${thread.id}`,
        kind: "session",
        title: thread.customTitle ?? thread.title,
        subtitle: joinSubtitle(["Codex", workspace ?? shortFolder(thread.cwd), live ? thread.status : "recent"]),
        keywords: [thread.cwd ?? "", workspace ?? "", "codex"],
        run: () => (live ? actions.focusCodex() : actions.openCodex(thread.id)),
      },
    });
  }
  return entries
    .sort((a, b) => b.at - a.at)
    .slice(0, PALETTE_SESSION_CAP)
    .map((entry) => entry.item);
};

export interface WorkspaceActions {
  open: (name: string) => void;
  show: (name: string) => void;
}

export const buildWorkspaceItems = (workspaces: WorkspaceRecord[], actions: WorkspaceActions): PaletteItem[] => {
  const items: PaletteItem[] = [];
  for (const workspace of workspaces) {
    const repos = workspace.repos.map((repo) => repo.name);
    items.push({
      id: `workspace-open:${workspace.name}`,
      kind: "workspace",
      title: `Open ${workspace.name} in editor`,
      subtitle: `${workspace.repos.length} repo${workspace.repos.length === 1 ? "" : "s"}`,
      keywords: [workspace.name, "workspace", "editor", "code", ...repos],
      run: () => actions.open(workspace.name),
    });
    items.push({
      id: `workspace-show:${workspace.name}`,
      kind: "workspace",
      title: `Show ${workspace.name}`,
      subtitle: "Workspaces",
      keywords: [workspace.name, "workspace", ...repos],
      run: () => actions.show(workspace.name),
    });
  }
  return items;
};

const CLOSED_STATUSES = new Set(["done", "archived"]);

const flattenTasks = (tasks: BoardTask[], into: BoardTask[]): BoardTask[] => {
  for (const task of tasks) {
    into.push(task);
    flattenTasks(task.subtasks, into);
  }
  return into;
};

export const buildTaskItems = (tasks: BoardTask[], projects: BoardProject[], open: (taskId: string) => void): PaletteItem[] => {
  const projectTitle = new Map(projects.map((project) => [project.id, project.title]));
  const items: PaletteItem[] = [];
  for (const task of flattenTasks(tasks, [])) {
    if (CLOSED_STATUSES.has(task.status)) continue;
    const project = projectTitle.get(task.projectId) ?? task.projectId;
    items.push({
      id: `task:${task.id}`,
      kind: "task",
      title: task.title,
      subtitle: joinSubtitle([project, task.status]),
      keywords: [project, task.status],
      run: () => open(task.id),
    });
    if (items.length >= PALETTE_TASK_CAP) break;
  }
  return items;
};

export interface SidebarCommand {
  toggle: () => void;
  collapsed: boolean;
}

export const SIDEBAR_SHORTCUT_LABEL = "Ctrl+B";

export interface CommandActions {
  newTask?: () => void;
  startDay?: () => void;
  planToday?: () => void;
  refreshDaily?: () => void;
  startCapture?: () => void;
  backupNow: () => void;
  toggleTheme: () => void;
  themeHint: string;
  installHooks: () => void;
  toggleWidget?: () => void;
  openDelegated?: () => void;
  sidebar?: SidebarCommand;
}

export const buildCommandItems = (actions: CommandActions): PaletteItem[] => {
  const items: PaletteItem[] = [];
  if (actions.newTask) items.push({ id: "command:new-task", kind: "command", title: "New task", subtitle: "Tasks", keywords: ["add", "create", "todo"], run: actions.newTask });
  if (actions.startDay) items.push({ id: "command:start-day", kind: "command", title: "Start the day", subtitle: "Today", keywords: ["plan", "daily", "today", "morning", "yesterday", "carry"], run: actions.startDay });
  if (actions.planToday) items.push({ id: "command:plan-today", kind: "command", title: "Plan today (classic)", subtitle: "Today", keywords: ["daily", "today", "focus", "organize", "wizard", "planner"], run: actions.planToday });
  if (actions.refreshDaily) items.push({ id: "command:refresh-daily", kind: "command", title: "Refresh Today", subtitle: "Today", keywords: ["reload", "daily", "today", "sync"], run: actions.refreshDaily });
  if (actions.startCapture) items.push({ id: "command:capture", kind: "command", title: "Capture…", subtitle: "Today", keywords: ["capture", "note", "inbox", "quick", "idea"], run: actions.startCapture });
  if (actions.openDelegated) items.push({ id: "command:delegated-work", kind: "command", title: "Delegated work", subtitle: "Sessions › Delegated", keywords: ["delegated", "tasks", "agents", "hub", "runs"], run: actions.openDelegated });
  items.push({ id: "command:backup-now", kind: "command", title: "Back up now", subtitle: "Hub data", keywords: ["backup", "snapshot", "save"], run: actions.backupNow });
  items.push({ id: "command:toggle-theme", kind: "command", title: "Toggle theme", subtitle: actions.themeHint, keywords: ["dark", "midnight", "dracula", "appearance", "color"], run: actions.toggleTheme });
  if (actions.sidebar) {
    const { toggle, collapsed } = actions.sidebar;
    items.push({ id: "command:toggle-sidebar", kind: "command", title: "Toggle sidebar", subtitle: `${collapsed ? "Expand" : "Collapse"} · ${SIDEBAR_SHORTCUT_LABEL}`, keywords: ["collapse", "expand", "rail", "navigation", "menu", "ctrl+b"], run: toggle });
  }
  if (actions.toggleWidget) items.push({ id: "command:toggle-widget", kind: "command", title: "Show/hide widget", subtitle: "Desktop", keywords: ["tray", "overlay"], run: actions.toggleWidget });
  items.push({ id: "command:install-hooks", kind: "command", title: "Install hooks…", subtitle: "Opens Settings › Connections", keywords: ["hooks", "claude", "setup", "settings"], run: actions.installHooks });
  return items;
};

export const CAPTURE_PREFILL = "capture ";

const CAPTURE_PATTERN = /^\s*(?:capture\s+|c:\s*)(\S[\s\S]*)$/i;

export const parseCaptureQuery = (query: string): string | null => {
  const match = CAPTURE_PATTERN.exec(query);
  const text = match?.[1]?.trim();
  return text ? text : null;
};

export const buildCaptureItems = (query: string, capture: (text: string) => void): PaletteItem[] => {
  const text = parseCaptureQuery(query);
  if (!text) return [];
  return [{ id: "capture:new", kind: "command", title: `Capture: ${text}`, subtitle: "Adds to today's captures", run: () => capture(text) }];
};

export const buildHistoryItems = (hits: HistoryHit[], workspaces: WorkspaceRecord[], open: (hit: HistoryHit) => void): PaletteItem[] =>
  hits.map((hit) => ({
    id: `history:${hit.messageId}`,
    kind: "history",
    title: hit.snippet,
    titleRanges: hit.highlights,
    subtitle: `${hitHeadline(hit, workspaceOf(workspaces, hit.cwd))} · ${hitDetail(hit)}`,
    run: () => open(hit),
  }));
