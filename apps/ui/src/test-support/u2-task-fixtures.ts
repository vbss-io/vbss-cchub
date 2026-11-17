import type { ReportRecord, RunEventRecord, RunRecord, TaskDetail, TaskRecord, WorktreeInfo } from "../delegation";
import type { SessionRecord } from "../types";

export const NOW = 1_800_000_000_000;

export function makeTaskRecord(id: string, patch: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    title: `Task ${id}`,
    prompt: "Do the thing",
    workspace: "vbss",
    repo: null,
    cwd: "/ws/vbss",
    addDirs: [],
    runner: "claude",
    requestedModel: null,
    permissionMode: null,
    sandbox: null,
    status: "completed",
    sessionId: null,
    createdBy: null,
    originSessionId: null,
    originClient: null,
    lastError: null,
    runsCount: 1,
    archivedAt: null,
    isolation: "shared",
    isolationReason: null,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    mergedAt: null,
    portBase: null,
    portEnd: null,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 600_000,
    ...patch,
  };
}

export function makeRun(id: string, taskId: string, patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    taskId,
    seq: 1,
    kind: "launch",
    runner: "claude",
    prompt: "Run prompt",
    requestedModel: null,
    effectiveModel: null,
    permissionMode: null,
    status: "completed",
    sessionId: null,
    result: null,
    error: null,
    exitCode: 0,
    startedAt: NOW - 3_000_000,
    finishedAt: NOW - 2_000_000,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
    startCommit: null,
    ...patch,
  };
}

export function makeReport(id: string, patch: Partial<ReportRecord> = {}): ReportRecord {
  return { id, taskId: null, sessionId: null, workspace: null, kind: "note", text: "Report body", source: null, createdAt: NOW - 60_000, ...patch };
}

export function makeEvent(id: number, runId: string, taskId: string, kind: RunEventRecord["kind"], text: string): RunEventRecord {
  return { id, runId, taskId, kind, text, createdAt: NOW };
}

export function makeDetail(task: TaskRecord, patch: Partial<TaskDetail> = {}): TaskDetail {
  return { task, runs: [], reports: [], ...patch };
}

export function makeWorktree(patch: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path: "/ws/vbss/.worktrees/t1",
    branch: "task/t1",
    baseBranch: "main",
    exists: true,
    dirty: false,
    commits: [{ sha: "abcdef1234567", subject: "Add feature" }],
    diffStat: "",
    mergedAt: null,
    hint: "",
    ...patch,
  };
}

export function makeSession(id: string, patch: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id,
    status: "idle",
    cwd: "/ws/vbss",
    source: null,
    hostPid: null,
    title: null,
    customTitle: null,
    lastMessage: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    contextTokens: null,
    archivedAt: null,
    startedAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    ...patch,
  };
}
