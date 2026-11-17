import type { ConnectStatus, DelegationSettings, McpStatus, ShellStatus } from "../delegation";
import type { CostTotals, RoutineRecord, RoutineRunRecord } from "../types";

export const fullSettings = (overrides: Partial<DelegationSettings> = {}): DelegationSettings => ({
  workspacesRoot: "C:/work/workspaces",
  editorCommand: "code",
  secondBrainRoot: "D:/vault",
  autonomy: "full",
  ownerName: "Vitor",
  runTimeoutMinutes: 60,
  features: { daily: true, trail: true, usage: true, limits: true, tasks: true, flow: true, delegated: true, workspaces: true, reports: true, share: true, widget: true },
  daily: {
    dir: "daily",
    template: null,
    prompt: null,
    runner: "claude",
    headings: { focus: "Focus", meetings: "Meetings", sessions: "Sessions" },
    closedKey: "closed",
    wikilinks: true,
    projectOrder: [],
    focusSource: "scheduled",
  },
  tasks: {
    root: "projetos",
    section: "Open loops",
    prefixes: { blocked: ["BLOCK"], hold: ["HOLD"], archived: ["ARCHIVED"] },
    separator: " - ",
    reasonSeparator: " - ",
    doneSection: "Done loops",
    doneStamp: " ✅ {{date}}",
    exclude: ["arquivo"],
    workspaceKey: "workspace",
    parentKey: "parent",
    delegatePrompt: null,
    markDoingOnDelegate: true,
    priorityTag: "p",
    priorityLevels: 4,
  },
  trail: { dir: "trail", detail: "medium", model: null, prompt: null, hubEvents: true },
  widget: { edge: "right", rings: { claude: true, codex: false }, panel: "sessions", autostart: false },
  limits: { claude: true, codex: true, codexLive: false, refreshMinutes: 5 },
  usage: { days: 30 },
  approvals: { claudeWindowSec: 120, codexWindowSec: 90 },
  memory: { historyIndex: true, handoffWorkspaces: [], summaryHeading: "Summary" },
  ...overrides,
});

export const shellStatus = (overrides: Partial<ShellStatus> = {}): ShellStatus => ({ path: "C:/Users/x/profile.ps1", exists: true, installed: false, external: false, ...overrides });

export const mcpStatus = (overrides: Partial<McpStatus> = {}): McpStatus => ({
  path: "C:/Users/x/.claude.json",
  exists: true,
  installed: false,
  inFile: false,
  registeredAt: null,
  error: null,
  updateAvailable: false,
  cli: null,
  ...overrides,
});

export const connectStatus = (overrides: Partial<ConnectStatus> = {}): ConnectStatus => ({
  mcpEntry: "C:/app/mcp.js",
  mcpEntryExists: true,
  server: { command: "node", args: ["C:/app/mcp.js"], env: { HUB_URL: "http://127.0.0.1:4317" } },
  shell: { bash: shellStatus(), powershell: shellStatus() },
  mcp: { "claude-code": mcpStatus(), "claude-desktop": mcpStatus(), codex: mcpStatus() },
  ...overrides,
});

export const noCost = (): CostTotals => ({ costUsd: null, tokensIn: null, tokensOut: null, runs: 0, pricedRuns: 0 });

export const routineRun = (overrides: Partial<RoutineRunRecord> = {}): RoutineRunRecord => ({
  id: "run1",
  routineId: "r1",
  routineName: "Morning triage",
  taskId: "t1",
  trigger: "schedule",
  status: "completed",
  dueAt: null,
  startedAt: Date.now() - 3_600_000,
  finishedAt: Date.now() - 3_000_000,
  summary: "All clear",
  error: null,
  note: null,
  missedSlots: null,
  read: false,
  readAt: null,
  cost: noCost(),
  ...overrides,
});

export const routineRecord = (overrides: Partial<RoutineRecord> = {}): RoutineRecord => ({
  id: "r1",
  name: "Morning triage",
  prompt: "Read the board",
  workspace: "vbss",
  repo: null,
  cwd: null,
  runner: "claude",
  model: null,
  schedule: { kind: "daily", time: "09:00" },
  enabled: true,
  anchorAt: 0,
  nextFireAt: null,
  lastFiredAt: null,
  createdAt: 0,
  updatedAt: 0,
  running: false,
  lastRun: null,
  cost: noCost(),
  ...overrides,
});
