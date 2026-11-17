import type { DelegationSettings, FirewallStatus, ShareRecord, ShareRequestRecord, TaskRecord, TunnelStatus, UsageReport, UsageSessionRow, UsageTotals } from "../delegation";
import type { CodexSessionRecord, DiffFile, DiffResult, HistoryHit, HistoryIndexStatus, HistorySearchResult, LiveAgent, LiveAgentSummary, PermissionRequestRecord, RuntimeSnapshot, SessionLiveSummary, SessionRecord, TranscriptEntry } from "../types";

export const historyHit = (overrides: Partial<HistoryHit> = {}): HistoryHit => ({
  messageId: 1,
  sessionId: "sess-aaaa-1111",
  client: "claude",
  title: "Refactor auth",
  cwd: "C:/work/api",
  workspace: null,
  role: "user",
  at: new Date(2026, 10, 3, 14, 5).getTime(),
  seq: 1,
  snippet: "we should rotate the token",
  highlights: [[10, 16]],
  matches: 1,
  ...overrides,
});

export const historyResult = (hits: HistoryHit[], overrides: Partial<HistorySearchResult> = {}): HistorySearchResult => ({
  enabled: true,
  engine: "fts",
  query: "token",
  tokens: ["token"],
  hits,
  offset: 0,
  limit: 20,
  hasMore: false,
  ...overrides,
});

export const historyStatus = (overrides: Partial<HistoryIndexStatus> = {}): HistoryIndexStatus => ({
  enabled: true,
  engine: "fts",
  running: false,
  progress: null,
  files: 3,
  sessions: 3,
  rows: 120,
  textBytes: 1000,
  indexBytes: 2048,
  indexBytesEstimated: false,
  lastBuildMs: 1500,
  lastBuildAt: 1,
  lastRun: null,
  lastError: null,
  roots: { claude: "C:/c", codex: "C:/x" },
  ...overrides,
});

export const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime();

export const sessionRecord = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId: "sess-0001-aaaa",
  status: "active",
  cwd: "C:/work/api",
  source: null,
  hostPid: null,
  client: "terminal",
  title: "Refactor auth",
  customTitle: null,
  lastMessage: "working",
  model: "claude-opus-4-7",
  tokensIn: 1500,
  tokensOut: 2_500_000,
  contextTokens: 100_000,
  archivedAt: null,
  startedAt: NOW - 3_600_000,
  updatedAt: NOW - 60_000,
  ...overrides,
});

export const codexRecord = (overrides: Partial<CodexSessionRecord> = {}): CodexSessionRecord => ({
  id: "codex-0001-aaaa",
  title: "Fix build",
  cwd: "C:/work/api",
  originator: null,
  source: null,
  threadSource: null,
  client: "codex-app",
  status: "active",
  turns: 3,
  lastMessage: "done",
  file: "C:/codex/rollout.jsonl",
  startedAt: NOW - 3_600_000,
  updatedAt: NOW - 60_000,
  origin: null,
  hubTaskId: null,
  customTitle: null,
  archivedAt: null,
  hidden: false,
  ...overrides,
});

export const runtimeSnapshot = (overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot => ({
  claudeCode: { running: false, count: 0, pids: [], headless: 0 },
  claudeDesktop: { running: false, count: 0, pids: [] },
  codexApp: { running: false, count: 0, pids: [] },
  codexCli: { running: false, count: 0, pids: [] },
  scannedAt: NOW,
  error: null,
  ...overrides,
});

export const noPermissions: PermissionRequestRecord[] = [];

export const diffFile = (overrides: Partial<DiffFile> = {}): DiffFile => ({
  path: "src/a.ts",
  oldPath: null,
  status: "modified",
  binary: false,
  tooLarge: false,
  additions: 1,
  deletions: 1,
  totalLines: 3,
  shownLines: 3,
  truncated: false,
  hunks: [
    {
      header: "@@ -1,2 +1,2 @@",
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        { kind: "ctx", oldLine: 1, newLine: 1, text: "const a = 1;" },
        { kind: "del", oldLine: 2, newLine: null, text: "const b = 2;" },
        { kind: "add", oldLine: null, newLine: 2, text: "const b = 3;" },
      ],
    },
  ],
  ...overrides,
});

export const diffResult = (files: DiffFile[], overrides: Partial<Extract<DiffResult, { available: true }>> = {}): DiffResult => ({
  available: true,
  root: "C:/work/api",
  base: { kind: "head", ref: "abc123", label: "HEAD" },
  files,
  filesTruncated: false,
  totals: { files: files.length, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0) },
  ...overrides,
});

export const transcriptEntry = (overrides: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  at: NOW - 120_000,
  role: "assistant",
  text: "Here is the plan",
  tool: null,
  ...overrides,
});

export const agentRecord = (overrides: Partial<LiveAgent> = {}): LiveAgent => ({
  agentId: "agent-1",
  sessionId: "sess-0001-aaaa",
  agentType: "explorer",
  status: "running",
  transcriptPath: null,
  lastMessage: "looking around",
  startedAt: NOW - 600_000,
  updatedAt: NOW - 30_000,
  transcript: [],
  ...overrides,
});

export const liveAgentSummary = (overrides: Partial<LiveAgentSummary> = {}): LiveAgentSummary => ({
  agentId: "agent-1",
  sessionId: "sess-0001-aaaa",
  agentType: "explorer",
  status: "running",
  transcriptPath: null,
  lastMessage: "looking around",
  startedAt: NOW - 600_000,
  updatedAt: NOW - 30_000,
  turns: 2,
  lastMessageTruncated: false,
  ...overrides,
});

export const liveSummary = (session: SessionRecord, transcript: TranscriptEntry[], agents: LiveAgentSummary[] = []): SessionLiveSummary => ({
  session,
  transcript,
  agents,
  agentCounts: { total: agents.length, running: agents.filter((agent) => agent.status === "running").length },
});

export const taskRecord = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
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
  createdAt: NOW - 120_000,
  updatedAt: NOW - 1_000,
  ...overrides,
});

export const shareRequest = (overrides: Partial<ShareRequestRecord> = {}): ShareRequestRecord => ({
  id: "req-1",
  shareId: "share-1",
  label: "Ana",
  kind: "ask",
  prompt: "How does auth work?",
  status: "completed",
  answer: "With tokens.",
  error: null,
  taskId: null,
  sessionId: null,
  remote: null,
  agent: null,
  asker: "Ana",
  forkSessionId: null,
  parentSessionId: null,
  createdAt: NOW - 300_000,
  finishedAt: NOW - 200_000,
  ...overrides,
});

export const shareRecord = (overrides: Partial<ShareRecord> = {}): ShareRecord => ({
  id: "share-1",
  key: "k-secret",
  label: "Ana doubts",
  workspace: "api-ws",
  repo: null,
  sessionId: null,
  trust: "low",
  note: null,
  model: null,
  maxPerHour: 20,
  createdAt: NOW - 3_600_000,
  expiresAt: NOW + 7_200_000,
  revokedAt: null,
  paused: false,
  lastUsedAt: null,
  uses: 0,
  links: { local: "http://127.0.0.1:4318/s/share-1?key=k-secret", lan: null, public: null },
  active: true,
  state: "active",
  requestsLastHour: 0,
  ...overrides,
});

export const tunnelStatus = (overrides: Partial<TunnelStatus> = {}): TunnelStatus => ({
  state: "stopped",
  publicUrl: null,
  error: null,
  startedAt: null,
  binary: null,
  installed: true,
  authtokenSet: true,
  domain: null,
  lanUrl: "http://192.168.0.5:4318",
  localUrl: "http://127.0.0.1:4318",
  sharePort: 4318,
  endpointError: null,
  notice: null,
  ...overrides,
});

export const firewallStatus = (overrides: Partial<FirewallStatus> = {}): FirewallStatus => ({
  supported: true,
  allowed: true,
  ruleName: "cchub-share",
  port: 4318,
  error: null,
  ...overrides,
});

export const usageTotals = (overrides: Partial<UsageTotals> = {}): UsageTotals => ({
  read: 1_000_000,
  fresh: 50_000,
  cacheRead: 900_000,
  cacheWrite: 10_000,
  output: 40_000,
  messages: 120,
  ...overrides,
});

export const usageSession = (overrides: Partial<UsageSessionRow> = {}): UsageSessionRow => ({
  ...usageTotals(),
  sessionId: "sess-0001-aaaa",
  provider: "claude",
  project: "C--Users-me-Projetos-api",
  cwd: "C:/work/api",
  title: "Refactor auth",
  avgContext: 100_000,
  p50Context: 90_000,
  p90Context: 250_000,
  maxContext: 320_000,
  firstAt: new Date(2026, 10, 10, 9, 5).getTime(),
  lastAt: new Date(2026, 10, 15, 18, 30).getTime(),
  ...overrides,
});

export const usageReport = (overrides: Partial<UsageReport> = {}): UsageReport => ({
  days: 7,
  from: NOW - 7 * 86_400_000,
  to: NOW - 5 * 60_000,
  totals: usageTotals({ read: 3_000_000, output: 120_000, fresh: 150_000, messages: 360 }),
  byProvider: { claude: usageTotals({ read: 2_000_000 }), codex: usageTotals({ read: 1_000_000 }) },
  byDay: [
    { day: "2026-11-14", claude: usageTotals({ read: 500_000, messages: 10 }), codex: usageTotals({ read: 250_000, messages: 5 }) },
    { day: "2026-11-15", claude: usageTotals({ read: 1_000_000, messages: 20 }), codex: usageTotals({ read: 0, messages: 0 }) },
  ],
  byModel: [
    { ...usageTotals({ read: 2_000_000 }), model: "claude-opus-4-7", provider: "claude" },
    { ...usageTotals({ read: 1_000_000 }), model: "gpt-5", provider: "codex" },
  ],
  byProject: [
    { ...usageTotals({ read: 2_000_000 }), project: "C--Users-me-Projetos-api", provider: "claude", sessions: 4 },
    { ...usageTotals({ read: 1_000_000 }), project: "web", provider: "codex", sessions: 2 },
  ],
  bySession: [usageSession(), usageSession({ sessionId: "codex-9999", provider: "codex", title: null, cwd: null, project: "C--Users-me-Obsidian-notes", p90Context: 700_000 })],
  context: { avgPerMessage: 100_000, p50: 90_000, p90: 400_000, max: 800_000, over300k: 12, over600k: 3 },
  sidechainShare: 0.25,
  costs: null,
  ...overrides,
});

export const usageSettings = (overrides: { limits?: boolean; days?: number } = {}): DelegationSettings =>
  ({ features: { limits: overrides.limits ?? false }, usage: { days: overrides.days ?? 7 } }) as unknown as DelegationSettings;
