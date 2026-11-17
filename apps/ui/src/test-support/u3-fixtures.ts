import type { DelegationSettings, LimitsSnapshot, TaskRecord } from "../delegation";
import type { PermissionRequestRecord, RuntimeSnapshot, SessionRecord } from "../types";

export const session = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: "sess-0001-aaaa",
  status: "active",
  cwd: "C:/work/api",
  source: null,
  hostPid: null,
  client: "terminal",
  title: "Refactor auth",
  customTitle: null,
  lastMessage: "working",
  model: "claude-opus",
  tokensIn: 10,
  tokensOut: 5,
  contextTokens: 100,
  archivedAt: null,
  startedAt: Date.now() - 60_000,
  updatedAt: Date.now(),
  ...overrides,
});

export const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "task-1",
  title: "Ship it",
  prompt: "do the thing",
  workspace: "api",
  repo: null,
  cwd: "C:/work/api",
  addDirs: [],
  runner: "claude",
  requestedModel: null,
  permissionMode: null,
  sandbox: null,
  status: "running",
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
  createdAt: Date.now() - 120_000,
  updatedAt: Date.now() - 1_000,
  ...overrides,
});

export const permission = (overrides: Partial<PermissionRequestRecord> = {}): PermissionRequestRecord => ({
  id: "perm-1",
  agent: "claude",
  sessionId: "sess-0001-aaaa",
  agentId: null,
  toolName: "Bash",
  toolInput: { command: "npm test" },
  cwd: "C:/work/api",
  turnId: null,
  title: "Refactor auth",
  windowMs: 60_000,
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

export const settings = (features: Partial<DelegationSettings["features"]> = {}, overrides: Partial<DelegationSettings> = {}): DelegationSettings =>
  ({
    workspacesRoot: null,
    editorCommand: "code",
    secondBrainRoot: null,
    autonomy: "ask",
    ownerName: "Vitor",
    runTimeoutMinutes: 30,
    features: { daily: true, trail: true, usage: true, limits: true, tasks: true, flow: true, delegated: true, workspaces: true, reports: true, share: true, widget: true, ...features },
    widget: { edge: "right", rings: { claude: false, codex: false }, panel: "sessions", autostart: true },
    limits: { claude: true, codex: true, codexLive: false, refreshMinutes: 5 },
    ...overrides,
  }) as unknown as DelegationSettings;

export const limitsSnapshot = (): LimitsSnapshot => ({
  updatedAt: 1,
  claude: {
    source: "api",
    fiveHour: { utilization: 42, resetsAt: Date.now() + 3_600_000 },
    sevenDay: { utilization: 85, resetsAt: Date.now() + 86_400_000 },
    models: [{ name: "Opus", utilization: 30, resetsAt: Date.now() + 86_400_000 }],
  },
  codex: {
    source: "rollout",
    primary: { usedPercent: 10, resetsAt: Date.now() + 3_600_000 },
    secondary: { usedPercent: 20, resetsAt: Date.now() + 86_400_000 },
  },
});

const group = { running: false, count: 0, pids: [] as number[] };

export const runtimeSnapshot = (): RuntimeSnapshot =>
  ({
    claudeCode: { ...group, headless: 0 },
    claudeDesktop: group,
    codexApp: group,
    codexCli: group,
    scannedAt: 1,
    error: null,
  });
