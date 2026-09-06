import express, { type ErrorRequestHandler, type Express, type NextFunction, type Request, type Response } from "express";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { BadRequestError, NotFoundError } from "./delegation-launch.js";
import { redactBuffer } from "./secrets.js";
import { getShare } from "./share-store.js";
import {
  artifactPath,
  askShare,
  askShareAndWait,
  authorizeShare,
  implementShare,
  listArtifacts,
  listRemoteTasks,
  openApiSpec,
  remoteRequestView,
  remoteTaskView,
  renderShareDoc,
  saveUpload,
  ShareError,
  subscribeShareStream,
  type RemoteMeta,
} from "./share-service.js";
import { getShareRequest } from "./share-store.js";
import { SHARE_MAX_UPLOAD_BYTES, SHARE_REMOTE_ERROR, SHARE_REMOTE_TASK_ERROR, SHARE_SYNC_WAIT_MS, TRUST_INFO, type ShareRecord, type ShareRequestRecord } from "./share-types.js";

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const DEFAULT_PROTOCOL = "2025-06-18";
const TEXT_FILE = /\.(md|txt|json|ya?ml|toml|csv|log|ts|tsx|js|mjs|cjs|py|cs|java|go|rs|html|css|xml|sql|sh|ps1|ini|env|cfg)$/i;
const MAX_INLINE_FILE = 200_000;

type Json = Record<string, unknown>;

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Json;
}

const asString = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value : null);

function keyFrom(req: Request): string | null {
  const auth = req.header("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  const header = req.header("x-hub-key");
  if (header) return header.trim();
  if (req.method !== "GET") return null;
  const query = req.query.key;
  return typeof query === "string" && query.length > 0 ? query : null;
}

const isLoopback = (address: string | undefined): boolean => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

function metaFrom(req: Request, bodyAsker?: unknown): RemoteMeta {
  const forwarded = req.header("x-forwarded-for");
  const hops = forwarded ? forwarded.split(",").map((item) => item.trim()).filter(Boolean) : [];
  const socketAddress = req.socket.remoteAddress ?? undefined;
  const raw = isLoopback(socketAddress) && hops.length > 0 ? (hops[hops.length - 1] ?? null) : (socketAddress ?? null);
  const remote = raw ? raw.replace(/^::ffff:/, "") : null;
  const agent = req.header("user-agent");
  const askerRaw = asString(bodyAsker) ?? asString(req.header("x-asker")) ?? (typeof req.query.asker === "string" ? req.query.asker : null);
  const asker = askerRaw ? askerRaw.replace(/[\r\n\t]/g, " ").trim().slice(0, 60) : null;
  return { remote, agent: agent ? agent.slice(0, 200) : null, asker: asker && asker.length > 0 ? asker : null };
}

function baseUrl(req: Request): string {
  const proto = req.header("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  const host = req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host") || "localhost";
  return `${proto}://${host}`;
}

const shareOf = (res: Response): ShareRecord => res.locals.share as ShareRecord;

const OWNER_FACING = /^(this share|another question|another implementation|rate limit|timed out)/i;

const remoteError = (error: string | null, fallback: string): string | null => (error ? (OWNER_FACING.test(error) ? error : fallback) : null);

const requestView = (record: ShareRequestRecord): Json => ({
  requestId: record.id,
  status: record.status,
  answer: record.answer,
  error: remoteError(record.error, SHARE_REMOTE_ERROR),
  asker: record.asker,
  createdAt: record.createdAt,
  finishedAt: record.finishedAt,
});

function aboutView(share: ShareRecord, base: string): Json {
  return {
    label: share.label,
    trust: share.trust,
    rules: TRUST_INFO[share.trust],
    workspace: share.workspace,
    repo: share.repo,
    continuesSession: share.sessionId !== null,
    note: share.note,
    maxPerHour: share.maxPerHour,
    expiresAt: share.expiresAt,
    doc: `${base}/share/${share.id}`,
    openapi: `${base}/share/${share.id}/openapi.json`,
  };
}

const objectSchema = (properties: Json, required: string[] = []): Json => ({ type: "object", properties, required, additionalProperties: false });

function remoteTools(share: ShareRecord): Json[] {
  const info = TRUST_INFO[share.trust];
  const asker = { type: "string", description: "Name of the person you work for; the owner sees it with every question" };
  return [
    {
      name: "ask",
      description: `Ask the owner's Claude a question about the "${share.workspace}" workspace (${info.ask}). Each asker keeps a persistent session that remembers earlier questions. One question at a time.`,
      inputSchema: objectSchema({ question: { type: "string", description: "The question, with enough context to be answered without follow-ups" }, asker }, ["question"]),
    },
    {
      name: "request_status",
      description: "Status and answer of a previous ask, by requestId (use when ask returned status running).",
      inputSchema: objectSchema({ requestId: { type: "string" } }, ["requestId"]),
    },
    {
      name: "implement",
      description: `Delegate an implementation task into the owner's "${share.workspace}" workspace (${info.implement}). Returns a taskId to follow with task_status.`,
      inputSchema: objectSchema({ prompt: { type: "string", description: "What to implement, with acceptance criteria" }, title: { type: "string" }, asker }, ["prompt"]),
    },
    { name: "task_status", description: "Status and result of a delegated task.", inputSchema: objectSchema({ taskId: { type: "string" } }, ["taskId"]) },
    { name: "tasks", description: "Every task delegated through this share, newest first, with status and result.", inputSchema: objectSchema({ limit: { type: "number" } }) },
    { name: "files", description: "Files on this share: what the owner's Claude wrote for you (out) and what you sent (in).", inputSchema: objectSchema({}) },
    {
      name: "file",
      description: "Read a file from this share: text files come back inline (up to 200 KB), others as a download url.",
      inputSchema: objectSchema({ name: { type: "string" } }, ["name"]),
    },
    {
      name: "upload",
      description: "Send a file to the share inbox so the owner's Claude can read it (base64 content, up to 25 MB).",
      inputSchema: objectSchema({ name: { type: "string" }, contentBase64: { type: "string" } }, ["name", "contentBase64"]),
    },
    { name: "about", description: "What this share gives access to, its trust level and rules.", inputSchema: objectSchema({}) },
  ];
}

async function callRemoteTool(share: ShareRecord, name: string, args: Json, meta: RemoteMeta, base: string): Promise<unknown> {
  const withAsker: RemoteMeta = { ...meta, asker: asString(args.asker) ?? meta.asker };
  if (name === "ask") {
    const question = asString(args.question);
    if (!question) throw new ShareError(400, "question required");
    const record = await askShareAndWait(share, question, withAsker, SHARE_SYNC_WAIT_MS);
    return record.status === "running"
      ? { requestId: record.id, status: "running", hint: "the answer is still being produced; call request_status with this requestId in ~30 s" }
      : requestView(record);
  }
  if (name === "request_status") {
    const requestId = asString(args.requestId);
    if (!requestId) throw new ShareError(400, "requestId required");
    return requestView(remoteRequestView(share, requestId));
  }
  if (name === "about") return aboutView(share, base);
  if (name === "implement") {
    const prompt = asString(args.prompt);
    if (!prompt) throw new ShareError(400, "prompt required");
    const record = implementShare(share, prompt, asString(args.title), withAsker);
    return { taskId: record.taskId, status: "running", hint: "follow with task_status" };
  }
  if (name === "task_status") {
    const taskId = asString(args.taskId);
    if (!taskId) throw new ShareError(400, "taskId required");
    const view = remoteTaskView(share, taskId);
    return { ...view, error: remoteError(view.error, SHARE_REMOTE_TASK_ERROR) };
  }
  if (name === "tasks") {
    const limit = Number(args.limit ?? 50);
    return listRemoteTasks(share, Number.isFinite(limit) ? limit : 50).map((view) => ({ ...view, error: remoteError(view.error, SHARE_REMOTE_TASK_ERROR) }));
  }
  if (name === "files") return listArtifacts(share).map((item) => ({ ...item, url: `${base}/share/${share.id}/files/${encodeURIComponent(item.name)}` }));
  if (name === "file") {
    const fileName = asString(args.name);
    if (!fileName) throw new ShareError(400, "name required");
    const path = artifactPathAny(share, fileName);
    const url = `${base}/share/${share.id}/files/${encodeURIComponent(fileName)}`;
    if (!TEXT_FILE.test(fileName)) return { name: fileName, url, note: "binary file: download it from url" };
    const content = readFileSync(path, "utf8");
    return content.length > MAX_INLINE_FILE ? { name: fileName, url, note: "large file: download it from url", preview: content.slice(0, MAX_INLINE_FILE) } : { name: fileName, url, content };
  }
  if (name === "upload") {
    const fileName = asString(args.name);
    const encoded = asString(args.contentBase64);
    if (!fileName || !encoded) throw new ShareError(400, "name and contentBase64 required");
    return saveUpload(share, fileName, Buffer.from(encoded, "base64"));
  }
  throw new ShareError(404, `unknown tool "${name}"`);
}

function artifactPathAny(share: ShareRecord, name: string): string {
  try {
    return artifactPath(share, name, "out");
  } catch (err) {
    if (err instanceof ShareError && err.status === 404) return artifactPath(share, name, "in");
    throw err;
  }
}

async function rpc(share: ShareRecord, message: RpcMessage, meta: RemoteMeta, base: string): Promise<Json | null> {
  const id = message.id ?? null;
  const reply = (result: unknown): Json => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string): Json => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  if (message.method === "initialize") {
    const requested = asString(message.params?.protocolVersion);
    return reply({
      protocolVersion: requested && PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "vbss-cchub-share", version: "1" },
      instructions: `Share "${share.label}" of a CC Hub (trust ${TRUST_INFO[share.trust].label}): ask questions about or delegate implementation into the "${share.workspace}" workspace. Always pass the asker (the person you work for). Call about for the rules.`,
    });
  }
  if (message.method === "notifications/initialized" || message.method?.startsWith("notifications/")) return null;
  if (message.method === "ping") return reply({});
  if (message.method === "tools/list") return reply({ tools: remoteTools(share) });
  if (message.method === "tools/call") {
    const name = asString(message.params?.name);
    if (!name) return fail(-32602, "tool name required");
    const args = (message.params?.arguments ?? {}) as Json;
    try {
      const result = await callRemoteTool(share, name, args, meta, base);
      return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result });
    } catch (err) {
      const text = err instanceof Error ? err.message : "tool failed";
      return reply({ content: [{ type: "text", text }], isError: true });
    }
  }
  return fail(-32601, `method not found: ${message.method ?? "?"}`);
}

const wrap =
  (handler: (req: Request, res: Response) => Promise<void> | void) =>
  (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      try {
        await handler(req, res);
      } catch (err) {
        next(err);
      }
    })();
  };

const wantsStream = (req: Request): boolean => req.query.stream === "1" || (req.header("accept") ?? "").includes("text/event-stream");

function streamAnswer(req: Request, res: Response, share: ShareRecord, requestId: string, onDone: () => void): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("start", { requestId, shareId: share.id });
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
  const finish = (): void => {
    clearInterval(keepAlive);
    unsubscribe();
    const record = getShareRequest(requestId);
    send("done", record ? requestView(record) : { requestId, status: "failed", error: "request vanished" });
    res.end();
    onDone();
  };
  const unsubscribe = subscribeShareStream(requestId, (event) => {
    if (event.kind === "text") send("delta", { text: event.text });
    else if (event.kind === "tool") send("tool", { text: event.text });
    else if (event.kind === "status" && (event.text === "finished" || event.text.startsWith("error"))) finish();
    else send("status", { text: event.text });
  });
  res.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
  const already = getShareRequest(requestId);
  if (already && already.status !== "running") finish();
}

const contentTypeFor = (name: string): string => {
  const ext = extname(name).toLowerCase();
  const map: Record<string, string> = {
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json",
    ".csv": "text/csv; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
};

export function createShareApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  app.get("/", (_req, res) => {
    res.type("text/plain").send("VBSS CCHUB share endpoint. Open the exact link you were given (it carries the key).\n");
  });

  app.use("/share/:id", (req, res, next) => {
    try {
      const id = req.params.id.replace(/\.md$/, "");
      res.locals.share = authorizeShare(getShare(id), keyFrom(req));
      next();
    } catch (err) {
      next(err);
    }
  });

  app.use("/share/:id/upload", express.raw({ limit: SHARE_MAX_UPLOAD_BYTES, type: (req) => !(req.headers["content-type"] ?? "").includes("application/json") }));
  app.use("/share/:id/upload", express.json({ limit: "40mb" }));
  app.use(express.json({ limit: "256kb" }));

  app.get(["/share/:id", "/share/:id.md"], (req, res) => {
    res.type("text/plain; charset=utf-8").send(renderShareDoc(shareOf(res), baseUrl(req)));
  });

  app.get("/share/:id/about", (req, res) => {
    res.json(aboutView(shareOf(res), baseUrl(req)));
  });

  app.get("/share/:id/openapi.json", (req, res) => {
    res.json(openApiSpec(shareOf(res), baseUrl(req)));
  });

  app.get(
    "/share/:id/ask",
    wrap(async (req, res) => {
      const question = typeof req.query.q === "string" ? req.query.q : typeof req.query.question === "string" ? req.query.question : null;
      if (!question) throw new ShareError(400, "q required");
      const record = await askShareAndWait(shareOf(res), question, metaFrom(req));
      res.type("text/plain; charset=utf-8");
      if (record.status === "running") {
        res.status(202).send(`Still answering. Poll: ${baseUrl(req)}/share/${shareOf(res).id}/requests/${record.id}?key=${shareOf(res).key}\n`);
        return;
      }
      res.send(record.status === "completed" ? `${record.answer ?? ""}\n` : `Error: ${remoteError(record.error, SHARE_REMOTE_ERROR) ?? "failed"}\n`);
    }),
  );

  app.post(
    "/share/:id/ask",
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Json;
      const question = asString(body.question) ?? asString(body.prompt);
      if (!question) throw new ShareError(400, "question required");
      const share = shareOf(res);
      const meta = metaFrom(req, body.asker);
      if (wantsStream(req)) {
        const handle = askShare(share, question, meta);
        streamAnswer(req, res, share, handle.request.id, () => undefined);
        return;
      }
      const record = await askShareAndWait(share, question, meta);
      res.status(record.status === "running" ? 202 : 200).json(requestView(record));
    }),
  );

  app.get("/share/:id/requests/:requestId/stream", (req, res) => {
    const share = shareOf(res);
    const record = remoteRequestView(share, req.params.requestId);
    if (record.kind !== "ask") throw new ShareError(409, `streaming is only available for questions; follow GET /share/${share.id}/tasks/${record.taskId ?? ""}`);
    streamAnswer(req, res, share, record.id, () => undefined);
  });

  app.get("/share/:id/requests/:requestId", (req, res) => {
    res.json(requestView(remoteRequestView(shareOf(res), req.params.requestId)));
  });

  app.post("/share/:id/implement", (req, res) => {
    const body = (req.body ?? {}) as Json;
    const prompt = asString(body.prompt);
    if (!prompt) throw new ShareError(400, "prompt required");
    const record = implementShare(shareOf(res), prompt, asString(body.title), metaFrom(req, body.asker));
    res.status(201).json({ taskId: record.taskId, requestId: record.id, status: "running" });
  });

  app.get("/share/:id/tasks", (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    res.json(listRemoteTasks(shareOf(res), Number.isFinite(limit) ? limit : 50).map((view) => ({ ...view, error: remoteError(view.error, SHARE_REMOTE_TASK_ERROR) })));
  });

  app.get("/share/:id/tasks/:taskId", (req, res) => {
    const view = remoteTaskView(shareOf(res), req.params.taskId);
    res.json({ ...view, error: remoteError(view.error, SHARE_REMOTE_TASK_ERROR) });
  });

  app.get("/share/:id/files", (req, res) => {
    const share = shareOf(res);
    res.json(listArtifacts(share).map((item) => ({ ...item, url: `${baseUrl(req)}/share/${share.id}/files/${encodeURIComponent(item.name)}` })));
  });

  app.get("/share/:id/files/:name", (req, res) => {
    const share = shareOf(res);
    const path = artifactPathAny(share, req.params.name);
    res.setHeader("Content-Type", contentTypeFor(req.params.name));
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(req.params.name)}"`);
    if (statSync(path).size > SHARE_MAX_UPLOAD_BYTES * 2) throw new ShareError(413, "file too large to serve through the share; ask the owner");
    res.send(redactBuffer(readFileSync(path)));
  });

  app.post("/share/:id/upload", (req, res) => {
    const share = shareOf(res);
    if (Buffer.isBuffer(req.body)) {
      const fileName = typeof req.query.name === "string" ? req.query.name : (req.header("x-file-name") ?? "");
      res.status(201).json(saveUpload(share, fileName, req.body));
      return;
    }
    const body = (req.body ?? {}) as Json;
    const fileName = asString(body.name);
    const encoded = asString(body.contentBase64);
    if (!fileName || !encoded) throw new ShareError(400, "send raw bytes with ?name= or JSON {name, contentBase64}");
    res.status(201).json(saveUpload(share, fileName, Buffer.from(encoded, "base64")));
  });

  app.post(
    "/share/:id/mcp",
    wrap(async (req, res) => {
      const share = shareOf(res);
      const meta = metaFrom(req);
      const base = baseUrl(req);
      const payload: unknown = req.body;
      if (Array.isArray(payload)) {
        const replies = (await Promise.all(payload.map((message) => rpc(share, message as RpcMessage, meta, base)))).filter((item) => item !== null);
        if (replies.length === 0) res.status(202).end();
        else res.json(replies);
        return;
      }
      const reply = await rpc(share, (payload ?? {}) as RpcMessage, meta, base);
      if (reply === null) res.status(202).end();
      else res.json(reply);
    }),
  );
  app.get("/share/:id/mcp", (_req, res) => {
    res.status(405).json({ error: "this MCP endpoint is stateless: POST JSON-RPC messages here" });
  });
  app.delete("/share/:id/mcp", (_req, res) => {
    res.status(204).end();
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  const onError: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
    if (err instanceof ShareError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    if (err instanceof BadRequestError || err instanceof NotFoundError) {
      console.error(`share target unavailable: ${err.message}`);
      res.status(409).json({ error: "share target unavailable; ask the owner" });
      return;
    }
    const status = typeof (err as { status?: unknown }).status === "number" ? (err as { status: number }).status : 500;
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: status === 413 ? "body too large" : "invalid request body" });
      return;
    }
    console.error(`share server error: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: "internal error" });
  };
  app.use(onError);
  return app;
}
