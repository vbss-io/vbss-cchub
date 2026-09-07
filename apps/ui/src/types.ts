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
  agentsRunning?: number;
  agentsTotal?: number;
  shareLabel?: string | null;
  forkOf?: string | null;
  forks?: number;
  remoteAsks?: number;
  delegatedTasks?: number;
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

export type CodexSessionStatus = "active" | "idle" | "ended";

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
  error?: string;
}

export interface HooksStatus {
  installed: boolean;
  events: string[];
  settingsPath?: string;
  notifyPath?: string;
  wsl?: WslHookStatus[];
}

export interface RunEventMessage {
  taskId: string;
  runId: string;
  kind: "text" | "tool" | "status";
  text: string;
}
