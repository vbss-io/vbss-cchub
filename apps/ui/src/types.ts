export type SessionStatus = "active" | "waiting" | "idle" | "ended";

export type SessionClient = "terminal" | "vscode" | "claude-desktop" | "hub" | "headless" | "wsl" | "share";

export interface GroupRecord {
  id: string;
  name: string;
  match: string;
  position: number;
}

export interface SessionRecord {
  sessionId: string;
  status: SessionStatus;
  cwd: string | null;
  source: string | null;
  hostPid: number | null;
  claudePid?: number | null;
  client?: string | null;
  transcriptPath?: string | null;
  stale?: boolean;
  title: string | null;
  customTitle: string | null;
  lastMessage: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  contextTokens: number | null;
  archivedAt: number | null;
  favoriteAt?: number | null;
  unread?: boolean;
  seenAt?: number | null;
  agentsRunning?: number;
  agentsTotal?: number;
  shareLabel?: string | null;
  forkOf?: string | null;
  forks?: number;
  forksLive?: number;
  remoteAsks?: number;
  delegatedTasks?: number;
  delegatedRunning?: number;
  helperOf?: string | null;
  helpers?: number;
  helpersTotal?: number;
  startedAt: number;
  updatedAt: number;
}

export interface AgentRecord {
  agentId: string;
  sessionId: string;
  agentType: string | null;
  status: "running" | "ended";
  transcriptPath: string | null;
  lastMessage: string | null;
  startedAt: number;
  updatedAt: number;
}

export type TranscriptRole = "user" | "assistant" | "tool" | "result";

export interface TranscriptEntry {
  at: number | null;
  role: TranscriptRole;
  text: string;
  tool: string | null;
}

export interface LiveAgent extends AgentRecord {
  transcript: TranscriptEntry[];
}

export interface SessionLive {
  session: SessionRecord;
  transcript: TranscriptEntry[];
  agents: LiveAgent[];
}

export interface LiveAgentSummary extends AgentRecord {
  turns: number;
  lastMessageTruncated: boolean;
}

export interface SessionLiveSummary {
  session: SessionRecord;
  transcript: TranscriptEntry[];
  agents: LiveAgentSummary[];
  agentCounts: { total: number; running: number };
}

export type CodexSessionStatus = "active" | "waiting" | "idle" | "ended";

export type CodexClient = "codex-app" | "codex-cli" | "codex-exec" | "codex-vscode";

export type CodexOrigin = "hub" | null;

export interface CodexSessionRecord {
  id: string;
  title: string;
  cwd: string | null;
  originator: string | null;
  source: string | null;
  threadSource: string | null;
  client: CodexClient;
  status: CodexSessionStatus;
  turns: number;
  lastMessage: string | null;
  file: string;
  startedAt: number;
  updatedAt: number;
  origin: CodexOrigin;
  hubTaskId: string | null;
  customTitle: string | null;
  archivedAt: number | null;
  hidden: boolean;
}

export interface RuntimeGroup {
  running: boolean;
  count: number;
  pids: number[];
}

export interface RuntimeSnapshot {
  claudeCode: RuntimeGroup & { headless: number };
  claudeDesktop: RuntimeGroup;
  codexApp: RuntimeGroup;
  codexCli: RuntimeGroup;
  scannedAt: number;
  error: string | null;
}

export interface WslHookStatus {
  distro: string;
  installed?: boolean;
  outdated?: boolean;
  error?: string;
}

export interface HooksStatus {
  installed: boolean;
  outdated?: boolean;
  missing?: string[];
  events: string[];
  settingsPath?: string;
  notifyPath?: string;
  permissionTimeout?: number;
  wsl?: WslHookStatus[];
}

export type PermissionAgent = "claude" | "codex";

export type PermissionOutcome = "allow" | "deny" | "expired" | "superseded" | "withdrawn";

export interface PermissionRequestRecord {
  id: string;
  agent: PermissionAgent;
  sessionId: string;
  agentId: string | null;
  toolName: string;
  toolInput: unknown;
  cwd: string | null;
  turnId: string | null;
  title: string | null;
  windowMs: number;
  createdAt: number;
  expiresAt: number;
}

export type PermissionRequestSummary = Omit<PermissionRequestRecord, "toolInput" | "cwd" | "turnId">;

export interface PermissionResolved {
  id: string;
  agent: PermissionAgent;
  sessionId: string;
  outcome: PermissionOutcome;
  at: number;
}

export interface PermissionDecisionResult {
  ok: boolean;
  request: PermissionRequestRecord | null;
}

export interface ApprovalsSettings {
  claudeWindowSec: number;
  codexWindowSec: number;
}

export interface CodexHooksStatus {
  path: string;
  exists: boolean;
  installed: boolean;
  updateAvailable: boolean;
  events: string[];
  missing: string[];
  backupPath: string;
  hasBackup: boolean;
  error: string | null;
  trustNote: string;
}

export interface OpenSessionResult {
  ok: boolean;
  method: "deep-link" | "focus";
  url?: string;
  reason?: string;
  focused?: boolean;
}

export interface RunEventMessage {
  taskId: string;
  runId: string;
  kind: "text" | "tool" | "status";
  text: string;
}

export interface MemorySettings {
  historyIndex: boolean;
  handoffWorkspaces: string[];
  summaryHeading: string;
}

export type HistoryClient = "claude" | "codex";

export type HistoryRole = "user" | "assistant";

export type HistoryEngine = "fts" | "like";

export interface HistoryHit {
  messageId: number;
  sessionId: string | null;
  client: HistoryClient;
  title: string | null;
  cwd: string | null;
  workspace: string | null;
  role: HistoryRole;
  at: number | null;
  seq: number;
  snippet: string;
  highlights: [number, number][];
  matches: number;
}

export interface HistorySearchResult {
  enabled: boolean;
  engine: HistoryEngine;
  query: string;
  tokens: string[];
  hits: HistoryHit[];
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface HistoryRunSummary {
  files: number;
  indexed: number;
  reset: number;
  skipped: number;
  removed: number;
  rows: number;
  bytes: number;
  ms: number;
  stopped: boolean;
}

export interface HistoryIndexStatus {
  enabled: boolean;
  engine: HistoryEngine;
  running: boolean;
  progress: { done: number; total: number } | null;
  files: number;
  sessions: number;
  rows: number;
  textBytes: number;
  indexBytes: number;
  indexBytesEstimated: boolean;
  lastBuildMs: number | null;
  lastBuildAt: number | null;
  lastRun: HistoryRunSummary | null;
  lastError: string | null;
  roots: { claude: string; codex: string };
}

export interface HandoffSession {
  sessionId: string;
  client: "claude" | "codex";
  title: string;
  updatedAt: number;
  keyPoints: string[];
}

export interface HandoffOpenLoop {
  project: string;
  status: string;
  title: string;
}

export interface HandoffPreview {
  workspace: string | null;
  enabled: boolean;
  sessions: HandoffSession[];
  openLoops: HandoffOpenLoop[];
  text: string | null;
  chars: number;
}

export interface DaySummarySession {
  sessionId: string;
  client: "claude" | "codex";
  workspace: string | null;
  time: string | null;
  title: string;
  keyPoints: string[];
}

export interface DaySummaryTask {
  project: string | null;
  title: string;
  source: "project" | "daily";
}

export interface DaySummaryReport {
  time: string;
  workspace: string | null;
  kind: string;
  text: string;
}

export interface DaySummaryCommit {
  workspace: string;
  repo: string;
  hash: string;
  subject: string;
}

export interface DaySummary {
  date: string;
  heading: string;
  sessions: DaySummarySession[];
  tasks: DaySummaryTask[];
  reports: DaySummaryReport[];
  commits: DaySummaryCommit[];
  empty: boolean;
  block: string;
  digest: string;
  markdown: string;
}

export interface DaySummaryWriteResult {
  date: string;
  path: string;
  updatedAt: number;
  changed: boolean;
  summary: DaySummary;
}
