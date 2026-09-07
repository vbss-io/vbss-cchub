import { hubBase } from "./api";

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

export const getSettings = (): Promise<DelegationSettings> => call("GET", "/settings");

export const updateSettings = (patch: Partial<DelegationSettings>): Promise<DelegationSettings> =>
  call("PUT", "/settings", patch);

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
