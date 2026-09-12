export const TASK_STATUSES = [
  "pending",
  "running",
  "completed",
  "attention",
  "failed",
  "interrupted",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const RUN_KINDS = ["launch", "continue"] as const;

export type RunKind = (typeof RUN_KINDS)[number];

export const RUNNERS = ["claude", "codex"] as const;

export type Runner = (typeof RUNNERS)[number];

export const PERMISSION_MODES = ["acceptEdits", "plan", "dontAsk", "manual", "bypassPermissions"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const AUTONOMY_LEVELS = ["full", "safe"] as const;

export type Autonomy = (typeof AUTONOMY_LEVELS)[number];

export const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;

export type CodexSandbox = (typeof CODEX_SANDBOXES)[number];

export const REPORT_KINDS = ["progress", "result", "blocked", "note"] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

export const ORIGIN_CLIENTS = ["claude-code", "codex", "share"] as const;

export type OriginClient = (typeof ORIGIN_CLIENTS)[number];

export const ISOLATION_MODES = ["shared", "worktree"] as const;

export type Isolation = (typeof ISOLATION_MODES)[number];

export const ISOLATION_REASONS = ["requested", "busy-repo", "default"] as const;

export type IsolationReason = (typeof ISOLATION_REASONS)[number];

export interface WorktreeCommit {
  sha: string;
  subject: string;
}

export interface WorktreeInfo {
  path: string | null;
  branch: string | null;
  baseBranch: string | null;
  exists: boolean;
  dirty: boolean;
  commits: WorktreeCommit[];
  diffStat: string;
  mergedAt: number | null;
  hint: string;
}

export interface WorkspaceRepo {
  name: string;
  path: string;
}

export interface WorkspaceRecord {
  name: string;
  file: string;
  contextPath: string | null;
  repos: WorkspaceRepo[];
  error: string | null;
}

export interface DelegationSettings {
  workspacesRoot: string | null;
  editorCommand: string;
  secondBrainRoot: string | null;
  autonomy: Autonomy;
  ownerName: string;
  runTimeoutMinutes: number;
}

export const RUN_TIMEOUT_MIN = 5;
export const RUN_TIMEOUT_MAX = 720;
export const RUN_TIMEOUT_DEFAULT = 60;

export interface TaskRecord {
  id: string;
  title: string;
  prompt: string;
  workspace: string;
  repo: string | null;
  cwd: string;
  addDirs: string[];
  runner: Runner;
  requestedModel: string | null;
  permissionMode: PermissionMode | null;
  sandbox: CodexSandbox | null;
  status: TaskStatus;
  sessionId: string | null;
  createdBy: string | null;
  originSessionId: string | null;
  originClient: OriginClient | null;
  lastError: string | null;
  runsCount: number;
  archivedAt: number | null;
  isolation: Isolation;
  isolationReason: IsolationReason | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  mergedAt: number | null;
  portBase: number | null;
  createdAt: number;
  updatedAt: number;
}

export const RUN_EVENT_KINDS = ["text", "tool", "status"] as const;

export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

export interface RunEventRecord {
  id: number;
  runId: string;
  taskId: string;
  kind: RunEventKind;
  text: string;
  createdAt: number;
}

export interface RunRecord {
  id: string;
  taskId: string;
  seq: number;
  kind: RunKind;
  runner: Runner;
  prompt: string;
  requestedModel: string | null;
  effectiveModel: string | null;
  permissionMode: PermissionMode | null;
  status: TaskStatus;
  sessionId: string | null;
  result: string | null;
  error: string | null;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface ReportRecord {
  id: string;
  taskId: string | null;
  sessionId: string | null;
  workspace: string | null;
  kind: ReportKind;
  text: string;
  source: string | null;
  createdAt: number;
}

export interface TaskDetail {
  task: TaskRecord;
  runs: RunRecord[];
  reports: ReportRecord[];
}
