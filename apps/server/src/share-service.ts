import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getSession } from "./db.js";
import { abortRun, brainNote, delegateTask, resolveWorkspaceTarget, type WorkspaceTarget } from "./delegation-launch.js";
import { getSettings, getTask, getTaskDetail, listTasks } from "./delegation-store.js";
import { broadcast } from "./sse.js";
import { killRunners, runnerFor, type RunnerEvent } from "./share-runner.js";
import { redactSecrets } from "./secrets.js";
import {
  countRecentShareRequests,
  createShareRequest,
  finishShareRequest,
  getShareFork,
  getShareRequest,
  hasRunningAsk,
  hasRunningImplement,
  listShareRequests,
  setShareRequestFork,
  touchShare,
  touchShareFork,
} from "./share-store.js";
import {
  SHARE_ASK_TIMEOUT_MS,
  SHARE_CREATED_BY_PREFIX,
  SHARE_FORK_IDLE_MS,
  SHARE_MAX_ARTIFACTS,
  SHARE_MAX_PROMPT_CHARS,
  SHARE_MAX_TITLE_CHARS,
  SHARE_MAX_UPLOAD_BYTES,
  SHARE_SYNC_WAIT_MS,
  TRUST_INFO,
  askGuardrail,
  askProfile,
  implementProfile,
  type ShareLinks,
  type ShareRecord,
  type ShareRequestRecord,
  type ShareView,
} from "./share-types.js";
import { tunnelStatus, type TunnelStatus } from "./tunnel.js";
import { isDirectory, isInside } from "./workspaces.js";

export class ShareError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RemoteMeta {
  remote: string | null;
  agent: string | null;
  asker: string | null;
}

export interface AskHandle {
  request: ShareRequestRecord;
  done: Promise<ShareRequestRecord | null>;
}

const streams = new Map<string, Set<(event: RunnerEvent) => void>>();

export function subscribeShareStream(requestId: string, listener: (event: RunnerEvent) => void): () => void {
  const set = streams.get(requestId) ?? new Set();
  set.add(listener);
  streams.set(requestId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) streams.delete(requestId);
  };
}

function emitStream(requestId: string, shareId: string, event: RunnerEvent): void {
  const safe = event.kind === "text" ? { ...event, text: redactSecrets(event.text) } : event;
  for (const listener of streams.get(requestId) ?? []) listener(safe);
  broadcast("share-stream", { requestId, shareId, kind: safe.kind, text: safe.text });
}

function publishParent(share: ShareRecord): void {
  if (!share.sessionId) return;
  const session = getSession(share.sessionId);
  if (session) broadcast("session", session);
}

export function abortShareAsks(shareId: string, reason: string): number {
  return killRunners(`${shareId}:`, reason);
}

export function abortShareTasks(shareId: string, reason: string): number {
  const prefix = `${SHARE_CREATED_BY_PREFIX}${shareId}:`;
  let count = 0;
  for (const task of listTasks({ limit: 500 })) {
    if (!task.createdBy?.startsWith(prefix) || !["pending", "running"].includes(task.status)) continue;
    if (abortRun(task.id, reason)) count += 1;
  }
  return count;
}

export function abortAllAsks(reason: string): void {
  killRunners("", reason);
}

export function shareState(share: ShareRecord, now = Date.now()): ShareView["state"] {
  if (share.revokedAt) return "revoked";
  if (share.expiresAt && share.expiresAt <= now) return "expired";
  if (share.paused) return "paused";
  return "active";
}

const withKey = (base: string, share: ShareRecord): string => `${base.replace(/\/$/, "")}/share/${share.id}?key=${share.key}`;

export function shareLinks(share: ShareRecord, tunnel: TunnelStatus = tunnelStatus()): ShareLinks {
  return {
    local: withKey(tunnel.localUrl, share),
    lan: tunnel.lanUrl ? withKey(tunnel.lanUrl, share) : null,
    public: tunnel.state === "running" && tunnel.publicUrl ? withKey(tunnel.publicUrl, share) : null,
  };
}

export function toShareView(share: ShareRecord, tunnel: TunnelStatus = tunnelStatus()): ShareView {
  const state = shareState(share);
  return {
    ...share,
    links: shareLinks(share, tunnel),
    active: state === "active",
    state,
    requestsLastHour: countRecentShareRequests(share.id, 3_600_000),
  };
}

const sameKey = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function authorizeShare(share: ShareRecord | null, key: string | null): ShareRecord {
  if (!share) throw new ShareError(404, "share not found");
  if (!key || !sameKey(key, share.key)) throw new ShareError(401, "invalid or missing key");
  const state = shareState(share);
  if (state === "revoked") throw new ShareError(410, "this share was revoked by its owner");
  if (state === "expired") throw new ShareError(410, "this share expired");
  if (state === "paused") throw new ShareError(423, "this share is paused by its owner; try again later");
  return share;
}

export function sessionInsideWorkspace(cwd: string | null, target: WorkspaceTarget): boolean {
  if (!cwd || !isDirectory(cwd)) return false;
  return isInside(cwd, target.cwd) || target.addDirs.some((dir) => isInside(cwd, dir));
}

export const ownerName = (): string => getSettings().ownerName;

export const askerName = (meta: RemoteMeta, share: ShareRecord): string => (meta.asker && meta.asker.trim().length > 0 ? meta.asker.trim().slice(0, 60) : share.label);

interface ArtifactDirs {
  root: string;
  inbox: string;
}

export function artifactDirs(share: ShareRecord): ArtifactDirs {
  const target = resolveWorkspaceTarget(share.workspace, share.repo);
  const root = join(target.cwd, "share-artifacts", share.id);
  return { root, inbox: join(root, "inbox") };
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()\-]{0,120}$/;
const SECRET_NAME = /(^\.env|\.pem$|\.key$|\.pfx$|^id_rsa|\.mcp\.json$|\.claude\.json$|settings\.local\.json$|credentials)/i;

export function safeArtifactName(name: string): string {
  const trimmed = basename(name.trim());
  if (!SAFE_NAME.test(trimmed) || SECRET_NAME.test(trimmed)) throw new ShareError(400, "file name must be plain (letters, digits, dot, dash, space) and not a secret file");
  return trimmed;
}

export interface ArtifactInfo {
  name: string;
  size: number;
  modifiedAt: number;
  direction: "out" | "in";
}

export function listArtifacts(share: ShareRecord): ArtifactInfo[] {
  const dirs = artifactDirs(share);
  const items: ArtifactInfo[] = [];
  const scan = (dir: string, direction: "out" | "in"): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const stats = statSync(join(dir, entry.name));
      items.push({ name: entry.name, size: stats.size, modifiedAt: stats.mtimeMs, direction });
    }
  };
  scan(dirs.root, "out");
  scan(dirs.inbox, "in");
  return items.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, SHARE_MAX_ARTIFACTS);
}

export function artifactPath(share: ShareRecord, name: string, direction: "out" | "in"): string {
  const safe = safeArtifactName(name);
  const dirs = artifactDirs(share);
  const path = join(direction === "in" ? dirs.inbox : dirs.root, safe);
  if (!existsSync(path) || !statSync(path).isFile()) throw new ShareError(404, "file not found on this share");
  return path;
}

export function saveUpload(share: ShareRecord, name: string, data: Buffer): ArtifactInfo {
  if (data.length === 0) throw new ShareError(400, "empty file");
  if (data.length > SHARE_MAX_UPLOAD_BYTES) throw new ShareError(413, `file too large (max ${Math.round(SHARE_MAX_UPLOAD_BYTES / 1_048_576)} MB)`);
  const safe = safeArtifactName(name);
  const dirs = artifactDirs(share);
  const existing = listArtifacts(share);
  if (existing.length >= SHARE_MAX_ARTIFACTS) throw new ShareError(429, "too many files on this share; ask the owner to clean up");
  const hourAgo = Date.now() - 3_600_000;
  if (existing.filter((item) => item.direction === "in" && item.modifiedAt >= hourAgo).length >= share.maxPerHour) throw new ShareError(429, `rate limit: ${share.maxPerHour} uploads per hour for this share`);
  mkdirSync(dirs.inbox, { recursive: true });
  const path = join(dirs.inbox, safe);
  writeFileSync(path, data);
  const stats = statSync(path);
  broadcast("share-request", { shareId: share.id, kind: "upload", label: share.label, prompt: `file received: ${safe}`, status: "completed" });
  return { name: safe, size: stats.size, modifiedAt: stats.mtimeMs, direction: "in" };
}

function filesNote(share: ShareRecord, asker: string): string {
  const dirs = artifactDirs(share);
  const lines = [`The person asking identifies as "${asker}".`, `Files sent by "${asker}" are in ${dirs.inbox} (read them when relevant).`];
  if (share.trust !== "low") lines.push(`To hand a file back to "${asker}", write it in ${dirs.root} and mention its file name in the answer; they download it from there.`);
  return lines.join("\n");
}

interface AskTarget {
  cwd: string;
  addDirs: string[];
  resumeSessionId: string | null;
  scopeNote: string;
}

function resolveAskTarget(share: ShareRecord): AskTarget {
  const target = resolveWorkspaceTarget(share.workspace, share.repo);
  const session = share.sessionId ? getSession(share.sessionId) : null;
  if (session?.cwd && sessionInsideWorkspace(session.cwd, target)) {
    const sessionCwd = session.cwd;
    return {
      cwd: sessionCwd,
      addDirs: [target.cwd, ...target.addDirs].filter((dir) => dir !== sessionCwd),
      resumeSessionId: session.sessionId,
      scopeNote: `You continue the owner's session "${session.customTitle ?? session.title ?? session.sessionId}" (forked, the original stays untouched) inside the "${share.workspace}" workspace${share.repo ? `, repository "${share.repo}"` : ""}.`,
    };
  }
  return {
    cwd: target.cwd,
    addDirs: target.addDirs,
    resumeSessionId: null,
    scopeNote: `You answer from the "${share.workspace}" workspace${share.repo ? `, repository "${share.repo}"` : ""}: its context folder, notes and every repository in your working directory map.`,
  };
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function publish(share: ShareRecord, request: ShareRequestRecord | null): void {
  if (!request) return;
  broadcast("share-request", { ...request, prompt: clip(request.prompt, 160), answer: null, label: share.label, workspace: share.workspace });
}

function checkQuota(share: ShareRecord, prompt: string): void {
  if (prompt.trim().length === 0) throw new ShareError(400, "question required");
  if (prompt.length > SHARE_MAX_PROMPT_CHARS) throw new ShareError(413, `question too long (max ${SHARE_MAX_PROMPT_CHARS} characters)`);
  if (countRecentShareRequests(share.id, 3_600_000) >= share.maxPerHour) {
    throw new ShareError(429, `rate limit: ${share.maxPerHour} requests per hour for this share`);
  }
}

export function askShare(share: ShareRecord, question: string, meta: RemoteMeta): AskHandle {
  checkQuota(share, question);
  if (hasRunningAsk(share.id)) throw new ShareError(409, "another question is being answered on this share; wait for it and retry");
  const asker = askerName(meta, share);
  const target = resolveAskTarget(share);
  const profile = askProfile(share.trust);
  const fork = getShareFork(share.id, asker);
  const request = createShareRequest({
    shareId: share.id,
    kind: "ask",
    prompt: question,
    status: "running",
    taskId: null,
    remote: meta.remote,
    agent: meta.agent,
    asker,
    parentSessionId: share.sessionId,
  });
  touchShare(share.id);
  publish(share, request);
  publishParent(share);
  const runner = runnerFor(
    `${share.id}:${asker}`,
    {
      cwd: target.cwd,
      addDirs: target.addDirs,
      resumeSessionId: target.resumeSessionId,
      forkSession: target.resumeSessionId !== null,
      artifactsRoot: artifactDirs(share).root,
      profile,
      systemPrompt: `${askGuardrail(share.label, share.trust, target.scopeNote)}\n${filesNote(share, asker)}`,
      model: share.model,
      label: `${share.label} · ${asker}`,
    },
    fork?.sessionId ?? null,
    SHARE_FORK_IDLE_MS,
    SHARE_ASK_TIMEOUT_MS,
  );
  const done = runner
    .ask(question, (event) => {
      if (event.kind === "status" && (event.text === "finished" || event.text.startsWith("error"))) return;
      emitStream(request.id, share.id, event);
    })
    .then((answer) => {
      if (answer.sessionId && answer.established && getShareRequest(request.id)) {
        setShareRequestFork(request.id, answer.sessionId);
        touchShareFork({ shareId: share.id, asker, sessionId: answer.sessionId, parentSessionId: share.sessionId });
      }
      const finished = finishShareRequest({
        id: request.id,
        status: answer.ok ? "completed" : "failed",
        answer: answer.ok && answer.text !== null ? redactSecrets(answer.text) : null,
        error: answer.ok ? null : (answer.error ?? "the answer could not be produced"),
        sessionId: answer.sessionId,
      });
      brainNote(`share ask · ${share.label} · ${asker} · ${clip(question, 120)} → ${answer.ok ? clip(answer.text ?? "", 160) : `failed: ${answer.error ?? ""}`}`);
      publish(share, finished);
      publishParent(share);
      emitStream(request.id, share.id, { kind: "status", text: answer.ok ? "finished" : `error: ${answer.error ?? "failed"}` });
      streams.delete(request.id);
      return finished;
    });
  return { request, done };
}

const after = (ms: number): Promise<null> => new Promise((resolve) => setTimeout(() => resolve(null), ms).unref());

export async function askShareAndWait(share: ShareRecord, question: string, meta: RemoteMeta, waitMs = SHARE_SYNC_WAIT_MS): Promise<ShareRequestRecord> {
  const handle = askShare(share, question, meta);
  const settled = await Promise.race([handle.done, after(waitMs)]);
  const record = settled ?? getShareRequest(handle.request.id);
  if (!record) throw new ShareError(410, "this share was removed by its owner while answering");
  return record;
}

export function implementShare(share: ShareRecord, prompt: string, title: string | null, meta: RemoteMeta): ShareRequestRecord {
  checkQuota(share, prompt);
  if (hasRunningImplement(share.id)) throw new ShareError(409, "another implementation is running on this share; wait for it and retry");
  const asker = askerName(meta, share);
  const detail = delegateTask({
    prompt,
    workspace: share.workspace,
    repo: share.repo,
    runner: "claude",
    model: share.model,
    permissionMode: implementProfile(share.trust).permissionMode,
    sandbox: null,
    title: title ? title.trim().slice(0, SHARE_MAX_TITLE_CHARS) : null,
    source: `${SHARE_CREATED_BY_PREFIX}${share.id}:${share.label} · ${asker}`,
  });
  const request = createShareRequest({
    shareId: share.id,
    kind: "implement",
    prompt,
    status: "running",
    taskId: detail.task.id,
    remote: meta.remote,
    agent: meta.agent,
    asker,
    parentSessionId: share.sessionId,
  });
  touchShare(share.id);
  publish(share, request);
  publishParent(share);
  return request;
}

export interface RemoteTaskView {
  taskId: string;
  title: string;
  status: string;
  result: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export function remoteTaskView(share: ShareRecord, taskId: string): RemoteTaskView {
  const task = getTask(taskId);
  if (!task || !task.createdBy?.startsWith(`${SHARE_CREATED_BY_PREFIX}${share.id}:`)) throw new ShareError(404, "task not found for this share");
  const finished = !["pending", "running"].includes(task.status);
  const request = listShareRequests({ shareId: share.id, limit: 200 }).find((item) => item.taskId === taskId);
  if (request && request.status === "running" && finished) {
    publish(
      share,
      finishShareRequest({
        id: request.id,
        status: task.status === "completed" || task.status === "attention" ? "completed" : "failed",
        answer: null,
        error: task.lastError,
        sessionId: task.sessionId,
      }),
    );
  }
  const detail = getTaskDetail(taskId);
  const lastRun = detail?.runs[detail.runs.length - 1];
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    result: finished ? (lastRun?.result ?? null) : null,
    error: task.lastError,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function listRemoteTasks(share: ShareRecord, limit = 50): RemoteTaskView[] {
  const prefix = `${SHARE_CREATED_BY_PREFIX}${share.id}:`;
  return listTasks({ limit: 500 })
    .filter((task) => task.createdBy?.startsWith(prefix))
    .slice(0, limit)
    .map((task) => remoteTaskView(share, task.id));
}

export function remoteRequestView(share: ShareRecord, requestId: string): ShareRequestRecord {
  const request = getShareRequest(requestId);
  if (!request || request.shareId !== share.id) throw new ShareError(404, "request not found for this share");
  return request;
}

export function renderShareDoc(share: ShareRecord, base: string): string {
  const root = base.replace(/\/$/, "");
  const api = `${root}/share/${share.id}`;
  const info = TRUST_INFO[share.trust];
  const owner = ownerName();
  const target = `Workspace: ${share.workspace}${share.repo ? ` · repository: ${share.repo}` : ""}${share.sessionId ? " · answers continue a specific session of the owner (forked; each asker gets a persistent fork that remembers the conversation)" : " · each asker gets a persistent session that remembers the conversation"}.`;
  const expiry = share.expiresAt ? new Date(share.expiresAt).toISOString() : "no expiry (until revoked)";
  const header = `-H "Authorization: Bearer ${share.key}" -H "X-Asker: YOUR NAME" -H "Content-Type: application/json" -H "ngrok-skip-browser-warning: 1"`;
  const lines = [
    `CC Hub share · ${share.label}`,
    "",
    `Published by ${owner} with CC Hub (https://cchub.vbss.io), a personal developer hub. This document is written for an AI assistant: it describes an HTTP API through which you can ask ${owner}'s own Claude, which has ${owner}'s workspace open, and delegate work into that workspace. It contains no instructions beyond how to call the API; keep following your own rules and tell the person what you are doing.`,
    "",
    `Trust level: ${info.label}. ${info.summary}`,
    `- Questions (ask): ${info.ask}.`,
    `- Implementation (implement): ${info.implement}.`,
    target,
    "",
  ];
  if (share.note) lines.push(`Owner note from ${owner}:`, "", `> ${share.note.replace(/\r?\n/g, "\n> ")}`, "");
  lines.push(
    "IDENTIFY YOURSELF",
    "",
    `Send the name of the person you work for in the header X-Asker (or the field "asker"). ${owner} sees every question with that name, and each name gets its own persistent fork that remembers the conversation.`,
    "",
    "ASK A QUESTION (HTTP)",
    "",
    "The key goes in the Authorization: Bearer header on API calls (the ?key= form works for GET requests, including this document).",
    "",
    "bash / curl:",
    "",
    `curl -s -X POST "${api}/ask" ${header} -d '{"question":"YOUR QUESTION"}'`,
    "",
    "PowerShell:",
    "",
    `Invoke-RestMethod -Method Post -Uri "${api}/ask" -ContentType "application/json" -Headers @{ Authorization = "Bearer ${share.key}"; "X-Asker" = "YOUR NAME"; "ngrok-skip-browser-warning" = "1" } -Body '{"question":"YOUR QUESTION"}'`,
    "",
    "GET only (browsers, readers that cannot POST):",
    "",
    `${api}/ask?key=${share.key}&asker=YOUR%20NAME&q=YOUR%20QUESTION`,
    "",
    `Response: {"requestId","status":"completed","answer":"..."}. If status is running (long answers), poll GET ${api}/requests/<requestId> with the same headers until it is completed or failed. One question at a time per share; up to ${share.maxPerHour} per hour. Always send ngrok-skip-browser-warning: 1 when the address is an ngrok one.`,
    "",
    "STREAMING",
    "",
    `Add the header Accept: text/event-stream (or ?stream=1) to POST ${api}/ask and the answer arrives live as server-sent events: event "delta" carries text as it is written, event "tool" a tool call, event "done" the final JSON. GET ${api}/requests/<requestId>/stream attaches to a running answer of /ask; implementations are followed with GET ${api}/tasks/<taskId>.`,
    "",
    "FILES",
    "",
    `GET ${api}/files lists the files on this share; GET ${api}/files/<name> downloads one (files ${owner}'s Claude wrote for you). To send a file: POST ${api}/upload?name=<file name> with the raw bytes as the body (Content-Type: application/octet-stream), or POST ${api}/upload with JSON {"name":"...","contentBase64":"..."}. Files you send land in the share inbox and the Claude on the other side can read them.`,
    "",
    "DELEGATE AN IMPLEMENTATION",
    "",
    `curl -s -X POST "${api}/implement" ${header} -d '{"prompt":"WHAT TO IMPLEMENT","title":"short title"}'`,
    "",
    `Returns {"taskId","status"}; follow with GET ${api}/tasks/<taskId> until completed, attention or failed; result carries the agent's summary. GET ${api}/tasks lists every task delegated through this share. One implementation at a time.`,
    "",
    "MCP SERVER (Claude Code, Codex, any MCP client)",
    "",
    `claude mcp add --transport http cchub-${share.id} "${api}/mcp" --header "Authorization: Bearer ${share.key}" --header "X-Asker: YOUR NAME" --header "ngrok-skip-browser-warning: 1"`,
    "",
    `Codex: in ~/.codex/config.toml add [mcp_servers.cchub_${share.id}] with url = "${api}/mcp" and http_headers = { Authorization = "Bearer ${share.key}", X-Asker = "YOUR NAME" }.`,
    "",
    "Tools: ask, request_status, implement, task_status, tasks, files, file, upload, about.",
    "",
    "CHATGPT / CUSTOM GPT",
    "",
    `Create a GPT with an Action, import the schema from ${api}/openapi.json?key=${share.key}, authentication API Key, type Bearer, key ${share.key}. Plain ChatGPT chats can only use the GET links above.`,
    "",
    "RULES",
    "",
    `- Answers come from ${owner}'s workspace; ${owner} sees every question, request, file and answer, with the asker's name.`,
    `- What the agent may do is fixed by the trust level (${info.label}): ${info.implement}.`,
    `- Rate limit: ${share.maxPerHour} requests per hour. Expires: ${expiry}. ${owner} can pause or revoke it at any time.`,
    "- Keep this link private: it is the credential. Do not post it anywhere public.",
    "",
    `Share id: ${share.id} · created ${new Date(share.createdAt).toISOString()}`,
    "",
  );
  return lines.join("\n");
}

export function openApiSpec(share: ShareRecord, base: string): Record<string, unknown> {
  const api = `${base.replace(/\/$/, "")}/share/${share.id}`;
  const owner = ownerName();
  const json = (schema: Record<string, unknown>): Record<string, unknown> => ({ "application/json": { schema } });
  const answer = { type: "object", properties: { requestId: { type: "string" }, status: { type: "string" }, answer: { type: "string", nullable: true }, error: { type: "string", nullable: true } } };
  const task = { type: "object", properties: { taskId: { type: "string" }, title: { type: "string" }, status: { type: "string" }, result: { type: "string", nullable: true }, error: { type: "string", nullable: true } } };
  return {
    openapi: "3.1.0",
    info: { title: `CC Hub share · ${share.label}`, version: "1.2.0", description: `Ask ${owner}'s Claude about the "${share.workspace}" workspace and delegate work into it. Trust level: ${TRUST_INFO[share.trust].label}. Send the person's name as the asker field.` },
    servers: [{ url: api }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    security: [{ bearer: [] }],
    paths: {
      "/ask": {
        post: {
          operationId: "ask",
          summary: "Ask a question; waits for the answer (up to ~2 min)",
          requestBody: { required: true, content: json({ type: "object", required: ["question"], properties: { question: { type: "string" }, asker: { type: "string", description: "Name of the person asking" } } }) },
          responses: { "200": { description: "Answer", content: json(answer) }, "202": { description: "Still running; poll /requests/{requestId}", content: json(answer) } },
        },
      },
      "/requests/{requestId}": {
        get: { operationId: "requestStatus", summary: "Status and answer of a question", parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Answer", content: json(answer) } } },
      },
      "/implement": {
        post: {
          operationId: "implement",
          summary: "Delegate an implementation task into the workspace",
          requestBody: { required: true, content: json({ type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, title: { type: "string" }, asker: { type: "string" } } }) },
          responses: { "201": { description: "Task created", content: json({ type: "object", properties: { taskId: { type: "string" }, status: { type: "string" } } }) } },
        },
      },
      "/tasks": { get: { operationId: "listTasks", summary: "Tasks delegated through this share", responses: { "200": { description: "Tasks", content: json({ type: "array", items: task }) } } } },
      "/tasks/{taskId}": {
        get: { operationId: "taskStatus", summary: "Status and result of a task", parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Task", content: json(task) } } },
      },
      "/files": { get: { operationId: "listFiles", summary: "Files on this share (inbox and files written for you)", responses: { "200": { description: "Files", content: json({ type: "array", items: { type: "object", properties: { name: { type: "string" }, size: { type: "integer" }, direction: { type: "string" } } } }) } } } },
      "/files/{name}": {
        get: { operationId: "downloadFile", summary: "Download a file", parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "File bytes" } } },
      },
      "/upload": {
        post: {
          operationId: "uploadFile",
          summary: "Send a file to the share inbox",
          requestBody: { required: true, content: json({ type: "object", required: ["name", "contentBase64"], properties: { name: { type: "string" }, contentBase64: { type: "string" } } }) },
          responses: { "201": { description: "Stored" } },
        },
      },
    },
  };
}
