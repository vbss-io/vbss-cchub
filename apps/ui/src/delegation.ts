import { hubBase } from "./api";
import { usageResponseState } from "./usage-format";

const base = `${hubBase}/delegation`;

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "attention"
  | "failed"
  | "interrupted"
  | "cancelled";

export type Runner = "claude" | "codex";

export type PermissionMode = "acceptEdits" | "plan" | "dontAsk" | "manual" | "bypassPermissions";

export type ReportKind = "progress" | "result" | "blocked" | "note";

export type OriginClient = "claude-code" | "codex" | "share";

export type Isolation = "shared" | "worktree";

export type IsolationReason = "requested" | "busy-repo" | "default";

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

export interface DailyHeadings {
  focus: string;
  meetings: string;
  sessions: string;
}

export interface DailySettings {
  dir: string | null;
  template: string | null;
  prompt: string | null;
  runner: Runner;
  headings: DailyHeadings;
  closedKey: string;
  wikilinks: boolean;
  projectOrder?: string[];
}

export type TrailDetail = "light" | "medium" | "high";

export interface TrailSettings {
  dir: string | null;
  detail: TrailDetail;
  model: string | null;
  prompt: string | null;
  hubEvents: boolean;
}

export type WidgetEdge = "left" | "right" | "top";

export type WidgetPanel = "sessions" | "usage";

export interface WidgetSettings {
  edge: WidgetEdge;
  rings: { claude: boolean; codex: boolean };
  panel: WidgetPanel;
  autostart: boolean;
}

export interface LimitsSettings {
  claude: boolean;
  codex: boolean;
  codexLive: boolean;
  refreshMinutes: number;
}

export interface UsageSettings {
  days: number;
}

export interface TasksPrefixes {
  blocked: string[];
  hold: string[];
  archived: string[];
}

export interface TasksFeatureSettings {
  root: string | null;
  section: string;
  prefixes: TasksPrefixes;
  separator: string;
  reasonSeparator: string;
  doneSection: string;
  doneStamp: string;
  exclude: string[];
  workspaceKey: string;
  parentKey: string;
  delegatePrompt: string | null;
  markDoingOnDelegate: boolean;
  priorityTag: string;
  priorityLevels: number;
}

export interface DelegationSettings {
  workspacesRoot: string | null;
  editorCommand: string;
  secondBrainRoot: string | null;
  autonomy: Autonomy;
  ownerName: string;
  runTimeoutMinutes: number;
  features: { daily: boolean; trail: boolean; usage: boolean; limits: boolean; tasks: boolean };
  daily: DailySettings;
  tasks: TasksFeatureSettings;
  trail: TrailSettings;
  widget: WidgetSettings;
  limits: LimitsSettings;
  usage: UsageSettings;
}

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
  sandbox: string | null;
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
  portEnd: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  id: string;
  taskId: string;
  seq: number;
  kind: "launch" | "continue";
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

export interface RunEventRecord {
  id: number;
  runId: string;
  taskId: string;
  kind: "text" | "tool" | "status";
  text: string;
  createdAt: number;
}

export interface TaskDetail {
  task: TaskRecord;
  runs: RunRecord[];
  reports: ReportRecord[];
  worktree?: WorktreeInfo | null;
}

export type ShellKind = "bash" | "powershell";
export type McpClient = "claude-code" | "claude-desktop" | "codex";

export interface ShellStatus {
  path: string;
  exists: boolean;
  installed: boolean;
  external: boolean;
}

export interface McpStatus {
  path: string;
  exists: boolean;
  installed: boolean;
  inFile: boolean;
  registeredAt: number | null;
  error: string | null;
}

export interface ConnectStatus {
  mcpEntry: string;
  mcpEntryExists: boolean;
  server: { command: string; args: string[]; env: Record<string, string> };
  shell: Record<ShellKind, ShellStatus>;
  mcp: Record<McpClient, McpStatus>;
}

export class DelegationDisabledError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const isJson = (res.headers.get("content-type") ?? "").includes("application/json");
  const json: unknown = isJson && text.length > 0 ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (json as { error?: string } | null)?.error ?? `request failed (${res.status})`;
    if (res.status === 404 && path === "/settings") throw new DelegationDisabledError(message);
    throw new Error(message);
  }
  return json as T;
}

export type SettingsPatch = Partial<Omit<DelegationSettings, "features" | "daily" | "tasks" | "trail" | "widget" | "limits" | "usage">> & {
  features?: Partial<DelegationSettings["features"]>;
  tasks?: Partial<Omit<TasksFeatureSettings, "prefixes">> & { prefixes?: Partial<TasksPrefixes> };
  daily?: Partial<Omit<DailySettings, "headings">> & { headings?: Partial<DailyHeadings> };
  trail?: Partial<TrailSettings>;
  widget?: Partial<Omit<WidgetSettings, "rings">> & { rings?: Partial<WidgetSettings["rings"]> };
  limits?: Partial<LimitsSettings>;
  usage?: Partial<UsageSettings>;
};

export interface ClaudeLimitWindow {
  utilization: number;
  resetsAt: number | null;
  reset?: boolean;
}

export interface CodexLimitWindow {
  usedPercent: number;
  resetsAt: number | null;
  reset?: boolean;
}

export interface ClaudeLimits {
  source?: "api" | "cache" | "none";
  fetchedAt?: number | null;
  stale?: boolean;
  fiveHour: ClaudeLimitWindow;
  sevenDay: ClaudeLimitWindow;
  models: { name: string; utilization: number; resetsAt: number | null }[];
  extra?: { enabled: boolean; utilization: number | null } | null;
  error?: string | null;
}

export interface CodexLimits {
  source?: "rollout" | "live" | "none";
  fetchedAt?: number | null;
  stale?: boolean;
  primary: CodexLimitWindow;
  secondary: CodexLimitWindow;
  planType?: string | null;
  error?: string | null;
}

export interface LimitsSnapshot {
  updatedAt: number | null;
  claude: ClaudeLimits | null;
  codex: CodexLimits | null;
}

export interface TokenTotals {
  read: number;
  output: number;
}

export interface ProviderUsage {
  today: TokenTotals & { messages: number };
  week: TokenTotals;
}

export interface UsageSummary {
  days: number;
  providers: { claude: ProviderUsage | null; codex: ProviderUsage | null } | null;
}

async function optionalJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const fetchLimits = (): Promise<LimitsSnapshot | null> => optionalJson("/limits");

export const refreshLimits = (): Promise<LimitsSnapshot> => call("POST", "/limits/refresh");

export interface UsageScanning {
  scanning: true;
  startedAt: number | null;
  files: number | null;
}

export const isScanning = (value: unknown): value is UsageScanning =>
  typeof value === "object" && value !== null && (value as { scanning?: unknown }).scanning === true;

const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const scanningOf = (body: unknown): UsageScanning => {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  return { scanning: true, startedAt: numberOrNull(record.startedAt), files: numberOrNull(record.files) };
};

async function usageJson(path: string): Promise<{ state: "scanning" | "ready" | "unavailable"; body: unknown; status: number }> {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { state: usageResponseState(res.status, body), body, status: res.status };
}

export async function fetchUsageSummary(): Promise<UsageSummary | UsageScanning | null> {
  try {
    const { state, body } = await usageJson("/usage/summary");
    if (state === "scanning") return scanningOf(body);
    if (state !== "ready") return null;
    const summary = body as UsageSummary;
    return summary.providers == null ? scanningOf(null) : summary;
  } catch {
    return null;
  }
}

export interface UsageTotals {
  read: number;
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  messages: number;
}

export type UsageProvider = "claude" | "codex";

export interface UsageDay {
  day: string;
  claude: UsageTotals;
  codex: UsageTotals;
}

export interface UsageModelRow extends UsageTotals {
  model: string;
  provider: UsageProvider;
}

export interface UsageProjectRow extends UsageTotals {
  project: string;
  provider: UsageProvider;
  sessions: number;
}

export interface UsageSessionRow extends UsageTotals {
  sessionId: string;
  provider: UsageProvider;
  project: string;
  cwd: string | null;
  title: string | null;
  avgContext: number;
  p50Context: number;
  p90Context: number;
  maxContext: number;
  firstAt: number;
  lastAt: number;
}

export interface UsageContext {
  avgPerMessage: number;
  p50: number;
  p90: number;
  max: number;
  over300k: number;
  over600k: number;
}

export interface UsageReport {
  days: number;
  from: number;
  to: number;
  totals: UsageTotals;
  byProvider: Record<UsageProvider, UsageTotals>;
  byDay: UsageDay[];
  byModel: UsageModelRow[];
  byProject: UsageProjectRow[];
  bySession: UsageSessionRow[];
  context: UsageContext;
  sidechainShare: number;
  costs: null;
}

export async function fetchUsage(days: number): Promise<UsageReport | UsageScanning> {
  const { state, body, status } = await usageJson(`/usage?days=${days}`);
  if (state === "scanning") return scanningOf(body);
  if (state === "unavailable") {
    const message = (body as { error?: string } | null)?.error ?? `request failed (${status})`;
    throw new Error(message);
  }
  return body as UsageReport;
}

export const rescanUsage = (): Promise<{ files: number }> => call("POST", "/usage/rescan");

export const getSettings = (): Promise<DelegationSettings> => call("GET", "/settings");

export const updateSettings = (patch: SettingsPatch): Promise<DelegationSettings> => call("PUT", "/settings", patch);

export const listWorkspaces = (): Promise<WorkspaceRecord[]> => call("GET", "/workspaces");

export const createWorkspace = (name: string, repos: string[]): Promise<WorkspaceRecord> =>
  call("POST", "/workspaces", { name, repos });

export const updateWorkspace = (name: string, repos: string[]): Promise<WorkspaceRecord> =>
  call("PUT", `/workspaces/${encodeURIComponent(name)}`, { repos });

export const deleteWorkspace = (
  name: string,
  deleteContext: boolean,
): Promise<{ file: string; contextPath: string | null; contextDeleted: boolean }> =>
  call("DELETE", `/workspaces/${encodeURIComponent(name)}${deleteContext ? "?context=1" : ""}`);

export const openWorkspace = (name: string): Promise<{ ok: boolean; error: string | null; command: string }> =>
  call("POST", `/workspaces/${encodeURIComponent(name)}/open`);

export const getConnect = (): Promise<ConnectStatus> => call("GET", "/connect");

export const configureShell = (shell: ShellKind, action: "install" | "uninstall"): Promise<ShellStatus> =>
  call("POST", "/connect/shell", { shell, action });

export const configureMcp = (client: McpClient, action: "install" | "uninstall"): Promise<McpStatus> =>
  call("POST", "/connect/mcp", { client, action });

export const listTasks = (limit = 100, includeArchived = false): Promise<TaskRecord[]> =>
  call("GET", `/tasks?limit=${limit}${includeArchived ? "&archived=1" : ""}`);

export const listTasksByOrigin = (sessionId: string, limit = 100): Promise<TaskRecord[]> =>
  call("GET", `/tasks?origin=${encodeURIComponent(sessionId)}&limit=${limit}`);

export const getTask = (id: string): Promise<TaskDetail> => call("GET", `/tasks/${encodeURIComponent(id)}`);

export const getTaskEvents = (id: string): Promise<RunEventRecord[]> =>
  call("GET", `/tasks/${encodeURIComponent(id)}/events`);

export const continueTask = (id: string, input: { prompt: string; model?: string }): Promise<TaskDetail> =>
  call("POST", `/tasks/${encodeURIComponent(id)}/continue`, input);

export const cancelTask = (id: string): Promise<{ ok: boolean }> =>
  call("POST", `/tasks/${encodeURIComponent(id)}/cancel`);

export const getWorktree = (id: string): Promise<WorktreeInfo> =>
  call("GET", `/tasks/${encodeURIComponent(id)}/worktree`);

export const mergeWorktree = (id: string): Promise<TaskRecord> =>
  call("POST", `/tasks/${encodeURIComponent(id)}/merge`);

export const discardWorktree = (id: string): Promise<TaskRecord> =>
  call("POST", `/tasks/${encodeURIComponent(id)}/worktree/discard`);

export const archiveTask = (id: string): Promise<TaskRecord> =>
  call("POST", `/tasks/${encodeURIComponent(id)}/archive`);

export const unarchiveTask = (id: string): Promise<TaskRecord> =>
  call("POST", `/tasks/${encodeURIComponent(id)}/unarchive`);

export const listReports = (limit = 50): Promise<ReportRecord[]> => call("GET", `/reports?limit=${limit}`);

export const createReport = (input: {
  text: string;
  kind?: ReportKind;
  taskId?: string;
  workspace?: string;
}): Promise<ReportRecord> => call("POST", "/reports", { ...input, source: "hub-ui" });

export type TrustLevel = "low" | "medium" | "high" | "total";
export type Autonomy = "full" | "safe";
export type ShareState = "active" | "paused" | "expired" | "revoked";
export type ShareRequestStatus = "running" | "completed" | "failed" | "rejected";

export interface ShareLinks {
  local: string;
  lan: string | null;
  public: string | null;
}

export interface ShareRecord {
  id: string;
  key: string;
  label: string;
  workspace: string;
  repo: string | null;
  sessionId: string | null;
  trust: TrustLevel;
  note: string | null;
  model: string | null;
  maxPerHour: number;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  paused: boolean;
  lastUsedAt: number | null;
  uses: number;
  links: ShareLinks;
  active: boolean;
  state: ShareState;
  requestsLastHour: number;
}

export interface ShareRequestRecord {
  id: string;
  shareId: string;
  label: string;
  kind: "ask" | "implement";
  prompt: string;
  status: ShareRequestStatus;
  answer: string | null;
  error: string | null;
  taskId: string | null;
  sessionId: string | null;
  remote: string | null;
  agent: string | null;
  asker: string | null;
  forkSessionId: string | null;
  parentSessionId: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export type TunnelState = "stopped" | "installing" | "starting" | "running" | "error";

export interface TunnelStatus {
  state: TunnelState;
  publicUrl: string | null;
  error: string | null;
  startedAt: number | null;
  binary: string | null;
  installed: boolean;
  authtokenSet: boolean;
  domain: string | null;
  lanUrl: string | null;
  localUrl: string;
  sharePort: number;
  endpointError: string | null;
  notice: string | null;
}

export interface CreateShareInput {
  label: string;
  workspace: string;
  repo?: string | null;
  trust: TrustLevel;
  sessionId?: string | null;
  note?: string | null;
  expiresInHours: number | null;
  maxPerHour?: number;
}

export const listShares = (): Promise<ShareRecord[]> => call("GET", "/shares");

export const createShare = (input: CreateShareInput): Promise<ShareRecord> => call("POST", "/shares", input);

export const updateShare = (
  id: string,
  patch: { label?: string; note?: string | null; paused?: boolean; revoke?: boolean; rotate?: boolean; expiresInHours?: number | null },
): Promise<ShareRecord> => call("PATCH", `/shares/${encodeURIComponent(id)}`, patch);

export const deleteShare = (id: string): Promise<{ ok: boolean }> => call("DELETE", `/shares/${encodeURIComponent(id)}`);

export async function getShareDoc(id: string, base: "auto" | "public" | "lan" | "local" = "auto"): Promise<string> {
  const res = await fetch(`${hubBase}/delegation/shares/${encodeURIComponent(id)}/doc?base=${base}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: "handoff unavailable" }))).error ?? "handoff unavailable");
  return res.text();
}

export const listShareActivity = (limit = 40): Promise<ShareRequestRecord[]> => call("GET", `/shares/activity?limit=${limit}`);

export const listShareRequests = (shareId: string, limit = 40): Promise<ShareRequestRecord[]> =>
  call("GET", `/shares/${encodeURIComponent(shareId)}/requests?limit=${limit}`);

export const getTunnel = (): Promise<TunnelStatus> => call("GET", "/tunnel");

export const startTunnel = (): Promise<TunnelStatus> => call("POST", "/tunnel/start");

export const stopTunnel = (): Promise<TunnelStatus> => call("POST", "/tunnel/stop");

export const updateTunnelSettings = (patch: { authtoken?: string | null; domain?: string | null }): Promise<TunnelStatus> =>
  call("PUT", "/tunnel/settings", patch);

export interface FirewallStatus {
  supported: boolean;
  allowed: boolean | null;
  ruleName: string;
  port: number;
  error: string | null;
}

export const getFirewall = (force = false): Promise<FirewallStatus> => call("GET", `/tunnel/firewall${force ? "?force=1" : ""}`);

export const allowFirewall = (): Promise<FirewallStatus> => call("POST", "/tunnel/firewall");

export interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  exe: string | null;
  error: string | null;
}

export const getAutostart = (): Promise<AutostartStatus> => call("GET", "/system/autostart");

export const setAutostart = (enabled: boolean): Promise<AutostartStatus> => call("PUT", "/system/autostart", { enabled });

export interface ShareFile {
  name: string;
  size: number;
  modifiedAt: number;
  direction: "out" | "in";
}

export const listShareFiles = (id: string): Promise<ShareFile[]> => call("GET", `/shares/${encodeURIComponent(id)}/files`);

export const shareFileUrl = (id: string, file: ShareFile): string =>
  `${base}/shares/${encodeURIComponent(id)}/files/${encodeURIComponent(file.name)}${file.direction === "in" ? "?direction=in" : ""}`;

export interface DailyRunning {
  taskId: string;
  date: string;
  startedAt: number;
}

export interface DailyOverview {
  enabled: boolean;
  root: string | null;
  dir: string | null;
  today: string;
  dates: string[];
  running: DailyRunning | null;
  templatePath: string | null;
}

export interface DailyEntry {
  date: string;
  path: string;
  exists: boolean;
  content: string;
  updatedAt: number | null;
}

export interface DailySession {
  sessionId: string;
  title: string | null;
  client: string | null;
  cwd: string | null;
  status: string;
  startedAt: number;
  updatedAt: number;
}

export class DailyConflictError extends Error {
  content: string;
  updatedAt: number | null;

  constructor(message: string, content: string, updatedAt: number | null) {
    super(message);
    this.content = content;
    this.updatedAt = updatedAt;
  }
}

export class DailyExistsError extends Error {
  updatedAt: number | null;

  constructor(message: string, updatedAt: number | null) {
    super(message);
    this.updatedAt = updatedAt;
  }
}

export type DailyTaskState = "todo" | "doing" | "done";

export interface DailyYesterdayTask {
  line: number;
  depth: number;
  state: DailyTaskState;
  checked: boolean;
  text: string;
  raw: string;
  block?: string;
}

export interface DailyYesterday {
  date: string;
  path: string;
  closed: boolean;
  tasks: DailyYesterdayTask[];
}

export interface DailyYesterdayTrail {
  path: string;
  bullets: string[];
}

export interface DailyPrepare {
  date: string;
  yesterday: DailyYesterday | null;
  yesterdayTrail: DailyYesterdayTrail | null;
  sessionsToday: DailySession[];
  headings: DailyHeadings;
  wikilinks: boolean;
  templatePath: string | null;
}

export interface DailyCloseYesterdayInput {
  yesterday: string;
  tasks: { line: number; checked: boolean }[];
}

export interface DailyFocusItem {
  project: string | null;
  text: string;
  block?: string;
}

export interface DailyComposeInput {
  briefing?: string;
  focus: DailyFocusItem[];
  meetings: string[];
  overwrite?: boolean;
}

export const getDaily = (): Promise<DailyOverview> => call("GET", "/daily");

export const prepareDaily = (date: string): Promise<DailyPrepare> =>
  call("GET", `/daily/${encodeURIComponent(date)}/prepare`);

export const closeYesterday = (
  date: string,
  body: DailyCloseYesterdayInput,
): Promise<{ date: string; updatedAt: number; closed: true }> =>
  call("POST", `/daily/${encodeURIComponent(date)}/close-yesterday`, body);

export async function composeDaily(date: string, body: DailyComposeInput): Promise<DailyEntry> {
  const res = await fetch(`${base}/daily/${encodeURIComponent(date)}/compose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (res.status === 409) {
    const errBody = json as { error?: string; updatedAt?: number | null } | null;
    throw new DailyExistsError(errBody?.error ?? "diary exists", errBody?.updatedAt ?? null);
  }
  if (!res.ok) throw new Error((json as { error?: string } | null)?.error ?? `request failed (${res.status})`);
  return json as DailyEntry;
}

export const getDailyEntry = (date: string): Promise<DailyEntry> => call("GET", `/daily/${encodeURIComponent(date)}`);

export async function saveDailyEntry(
  date: string,
  content: string,
  baseUpdatedAt: number | null | undefined,
  writeId: string,
): Promise<{ date: string; path: string; updatedAt: number }> {
  const res = await fetch(`${base}/daily/${encodeURIComponent(date)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(baseUpdatedAt === undefined ? { content, writeId } : { content, baseUpdatedAt, writeId }),
  });
  const text = await res.text();
  const json: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (res.status === 409) {
    const body = json as { error?: string; content?: string; updatedAt?: number | null } | null;
    throw new DailyConflictError(body?.error ?? "changed on disk", body?.content ?? "", body?.updatedAt ?? null);
  }
  if (!res.ok) throw new Error((json as { error?: string } | null)?.error ?? `request failed (${res.status})`);
  return json as { date: string; path: string; updatedAt: number };
}

export interface DailyOrganizeResult {
  date: string;
  path: string;
  updatedAt: number | null;
  changed: boolean;
  groups: number;
}

export async function organizeDailyFocus(date: string, baseUpdatedAt: number | null): Promise<DailyOrganizeResult> {
  const res = await fetch(`${base}/daily/${encodeURIComponent(date)}/organize-focus`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(baseUpdatedAt === null ? {} : { baseUpdatedAt }),
  });
  const text = await res.text();
  const json: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (res.status === 409) {
    const body = json as { error?: string; content?: string; updatedAt?: number | null } | null;
    throw new DailyConflictError(body?.error ?? "changed on disk", body?.content ?? "", body?.updatedAt ?? null);
  }
  if (!res.ok) throw new Error((json as { error?: string } | null)?.error ?? `request failed (${res.status})`);
  return json as DailyOrganizeResult;
}

export const generateDaily = (date: string, focus?: string, context?: string): Promise<{ taskId: string }> =>
  call("POST", `/daily/${encodeURIComponent(date)}/generate`, {
    ...(focus?.trim() ? { focus: focus.trim() } : {}),
    ...(context?.trim() ? { context: context.trim() } : {}),
  });

export const listDailySessions = (date: string): Promise<DailySession[]> =>
  call("GET", `/daily/sessions?date=${encodeURIComponent(date)}`);

export type BoardStatus = "blocked" | "hold" | "todo" | "doing" | "done" | "archived";

export type BoardCheckbox = "todo" | "doing" | "done";

export type BoardSection = "open" | "done";

export interface BoardNoteItem {
  line: number;
  raw: string;
  text: string;
}

export interface BoardTask {
  id: string;
  projectId: string;
  line: number;
  raw: string;
  depth: number;
  checkbox: BoardCheckbox;
  prefix: string | null;
  status: BoardStatus;
  title: string;
  reason: string | null;
  section: BoardSection;
  doneAt: string | null;
  group: string | null;
  priority: number | null;
  start?: string | null;
  scheduled?: string | null;
  due?: string | null;
  repeat?: string | null;
  notes: string[];
  noteItems: BoardNoteItem[];
  subtasks: BoardTask[];
}

export interface BoardProject {
  id: string;
  name: string;
  title: string;
  parent: string | null;
  depth: number;
  path: string;
  workspace: string | null;
  workspaceSource: "own" | "inherited" | null;
}

export interface BoardToday {
  date: string;
  exists: boolean;
  taskIds: string[];
  states: Record<string, BoardCheckbox>;
  mismatch?: string[];
}

export interface BoardPayload {
  enabled: boolean;
  root: string | null;
  configured: boolean;
  delegatePrompt: string;
  projects: BoardProject[];
  tasks: BoardTask[];
  errors: { path: string; error: string }[];
  today: BoardToday | null;
}

export interface BoardTarget {
  projectId: string;
  line: number;
  raw: string;
}

export interface BoardDelegateInput extends BoardTarget {
  workspace: string;
  prompt: string;
  repo?: string;
  runner?: Runner;
}

export class BoardConflictError extends Error {
  current: BoardTask | null;

  constructor(message: string, current: BoardTask | null) {
    super(message);
    this.current = current;
  }
}

async function callBoard<T>(method: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (res.status === 409) {
    const conflict = json as { error?: string; current?: BoardTask | null } | null;
    throw new BoardConflictError(conflict?.error ?? "changed on disk", conflict?.current ?? null);
  }
  if (!res.ok) throw new Error((json as { error?: string } | null)?.error ?? `request failed (${res.status})`);
  return json as T;
}

export const getTasksBoard = (): Promise<BoardPayload> => call("GET", "/tasks-board");

export interface BoardChange {
  status?: BoardStatus;
  title?: string;
  reason?: string | null;
  priority?: number | null;
  start?: string | null;
  scheduled?: string | null;
  due?: string | null;
  repeat?: string | null;
}

export const patchBoardItem = (
  target: BoardTarget,
  change: BoardChange,
): Promise<{ task: BoardTask; updatedAt: number; moved: boolean; dailySynced?: boolean; recurred?: boolean }> =>
  callBoard("PATCH", "/tasks-board/item", { ...target, ...change });

export interface BoardCreateInput {
  projectId: string;
  title: string;
  status?: BoardStatus;
  reason?: string;
  priority?: number;
  start?: string;
  scheduled?: string;
  due?: string;
  repeat?: string;
  parentLine?: number;
  parentRaw?: string;
}

export const createBoardItem = (input: BoardCreateInput): Promise<{ task: BoardTask; updatedAt: number }> =>
  callBoard("POST", "/tasks-board/item", input);

export const addBoardNote = (target: BoardTarget, text: string): Promise<{ task: BoardTask }> =>
  callBoard("POST", "/tasks-board/note", { ...target, text });

export const editBoardNote = (note: BoardTarget, text: string): Promise<{ task: BoardTask }> =>
  callBoard("PATCH", "/tasks-board/note", { ...note, text });

export const deleteBoardNote = (note: BoardTarget): Promise<{ task: BoardTask }> => callBoard("DELETE", "/tasks-board/note", note);

export const openBoardProjectInEditor = (projectId: string): Promise<{ ok: boolean; error: string | null; command: string }> =>
  callBoard("POST", "/tasks-board/open", { projectId });

export const sweepBoardDone = (projectId?: string): Promise<{ moved: number; projects: string[] }> =>
  callBoard("POST", "/tasks-board/sweep-done", projectId ? { projectId } : {});

export interface DailyLinkChild {
  line: number;
  raw: string;
  checkbox: BoardCheckbox;
  text: string;
  taskId: string | null;
  taskStatus: BoardStatus | null;
  mismatch: boolean;
}

export interface DailyLinkItem {
  line: number;
  raw: string;
  checkbox: BoardCheckbox;
  label: string | null;
  projectId: string | null;
  text: string;
  taskId: string | null;
  candidates: string[];
  taskStatus: BoardStatus | null;
  taskPriority: number | null;
  mismatch: boolean;
  recurredToday?: boolean;
  children?: DailyLinkChild[];
}

export interface DailyLinks {
  date: string;
  exists: boolean;
  path: string;
  items: DailyLinkItem[];
  taskIds: string[];
}

export const getDailyLinks = (date: string): Promise<DailyLinks> => call("GET", `/tasks-board/daily-links?date=${encodeURIComponent(date)}`);

export const addBoardTaskToDaily = (target: BoardTarget, date?: string): Promise<{ date: string; line: number; raw: string }> =>
  callBoard("POST", "/tasks-board/add-to-daily", { ...target, ...(date ? { date } : {}) });

export const syncBoardTaskToDaily = (target: BoardTarget, date?: string): Promise<{ date: string; updated: number }> =>
  callBoard("POST", "/tasks-board/sync-daily", { ...target, ...(date ? { date } : {}) });

export interface DailySyncFailure {
  taskId: string;
  error: string;
}

export interface DailySyncResult {
  date: string;
  updated: number;
  failed?: DailySyncFailure[];
}

export const syncBoardFromDaily = (line: number, date?: string): Promise<DailySyncResult> =>
  callBoard("POST", "/tasks-board/sync-from-daily", { line, ...(date ? { date } : {}) });

export const delegateBoardTask = (input: BoardDelegateInput): Promise<{ taskId: string; task: BoardTask; warning?: string }> =>
  callBoard("POST", "/tasks-board/delegate", input);

export type BoardMoveDirection = "up" | "down";

export interface BoardParentRef {
  line: number;
  raw: string;
}

export const moveBoardItem = (target: BoardTarget, direction: BoardMoveDirection): Promise<{ task: BoardTask }> =>
  callBoard("POST", "/tasks-board/move", { ...target, direction });

export const reparentBoardTask = (target: BoardTarget, parent: BoardParentRef | null): Promise<{ task: BoardTask }> =>
  callBoard("POST", "/tasks-board/reparent", { ...target, parent });

export const moveBoardTaskToProject = (target: BoardTarget, targetProjectId: string, parent: BoardParentRef | null): Promise<{ task: BoardTask }> =>
  callBoard("POST", "/tasks-board/move-to-project", { ...target, targetProjectId, ...(parent ? { parent } : {}) });

export interface TrailStatus {
  enabled: boolean;
  dir: string | null;
  detail: TrailDetail;
  model: string | null;
  hubEvents: boolean;
  today: { path: string; exists: boolean; sessions: number; hubLines: number };
  queue: number;
  running: { sessionId: string; since: number } | null;
  lastError: string | null;
}

export const getTrail = (): Promise<TrailStatus> => call("GET", "/trail");

export const flushTrail = (sessionId?: string): Promise<{ scheduled: number }> =>
  call("POST", "/trail/flush", sessionId ? { sessionId } : {});
