import type { BoardPayload, BoardProject, BoardTask, DailyLinkItem, DailyPrepare, DelegationSettings, TodayData, TodayEntry } from "../delegation";
import type { OutlineGroup, OutlineNode } from "../outliner-model";

export const DAY = "2026-11-16";

export const boardTask = (id: string, projectId: string, line: number, patch: Partial<BoardTask> = {}, subtasks: BoardTask[] = []): BoardTask => ({
  id,
  projectId,
  line,
  raw: `- [ ] ${id}`,
  depth: 0,
  checkbox: "todo",
  prefix: null,
  status: "todo",
  title: id,
  reason: null,
  section: "open",
  doneAt: null,
  group: null,
  priority: null,
  notes: [],
  noteItems: [],
  subtasks,
  ...patch,
});

export const boardProject = (id: string, title: string, patch: Partial<BoardProject> = {}): BoardProject => ({
  id,
  name: id,
  title,
  parent: null,
  depth: 0,
  path: `/${id}.md`,
  workspace: null,
  workspaceSource: null,
  ...patch,
});

export const todayEntry = (task: BoardTask, projectTitle: string, parentTitle: string | null = null): TodayEntry => ({
  task,
  project: { id: task.projectId, title: projectTitle, name: task.projectId },
  parentTitle,
});

export const todayData = (patch: Partial<TodayData> = {}): TodayData => ({
  date: DAY,
  focusSource: "scheduled",
  focus: [],
  carriedOver: [],
  meetings: [],
  captures: [],
  unlinked: [],
  summary: null,
  dailyExists: true,
  dailyUpdatedAt: 1,
  ...patch,
});

export const outlineNode = (id: string, patch: Partial<OutlineNode> = {}): OutlineNode => ({
  id,
  projectId: "alpha",
  line: 1,
  raw: `- [ ] ${id}`,
  title: id,
  status: "todo",
  priority: null,
  due: null,
  notes: [],
  children: [],
  depth: 0,
  ...patch,
});

export const outlineGroup = (projectId: string, title: string, items: OutlineNode[]): OutlineGroup => ({ project: { id: projectId, title }, items });

export const linkItem = (patch: Partial<DailyLinkItem> = {}): DailyLinkItem => ({
  line: 4,
  raw: "- [ ] Task",
  checkbox: "todo",
  label: null,
  projectId: null,
  text: "Task",
  taskId: null,
  candidates: [],
  taskStatus: null,
  taskPriority: null,
  mismatch: false,
  ...patch,
});

export const prepareOf = (patch: Partial<DailyPrepare> = {}): DailyPrepare => ({
  date: DAY,
  yesterday: null,
  yesterdayTrail: null,
  sessionsToday: [],
  headings: { focus: "Focus", meetings: "Meetings", sessions: "Sessions" },
  wikilinks: false,
  templatePath: null,
  ...patch,
});

export const settingsOf = (patch: { daily?: boolean; tasks?: boolean; projectOrder?: string[]; priorityLevels?: number } = {}): DelegationSettings =>
  ({
    features: { daily: patch.daily ?? true, trail: false, usage: false, limits: false, tasks: patch.tasks ?? true },
    daily: { projectOrder: patch.projectOrder ?? [], headings: { focus: "Focus", meetings: "Meetings", sessions: "Sessions" } },
    tasks: { priorityLevels: patch.priorityLevels ?? 3 },
  }) as unknown as DelegationSettings;

export const boardPayload = (patch: Partial<BoardPayload> = {}): BoardPayload => ({
  enabled: true,
  root: "/tasks",
  configured: true,
  delegatePrompt: "",
  projects: [],
  tasks: [],
  errors: [],
  today: null,
  ...patch,
});
