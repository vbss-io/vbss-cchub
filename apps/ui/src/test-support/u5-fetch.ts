import { vi, type Mock } from "vitest";

export interface FetchCall {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string> | undefined;
  body: unknown;
  signal: AbortSignal | undefined;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  contentType?: string | null;
}

export type FetchResponder = (call: FetchCall) => FakeReply | Promise<FakeReply> | Error;

export interface FetchStub {
  fetch: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
  calls: FetchCall[];
  last: () => FetchCall;
  restore: () => void;
}

const toCall = (input: RequestInfo | URL, init: RequestInit | undefined): FetchCall => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const raw = init?.body;
  let body: unknown;
  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  const headers = init?.headers ? { ...(init.headers as Record<string, string>) } : undefined;
  const parsed = new URL(url);
  return { url, path: `${parsed.pathname}${parsed.search}`, method: init?.method ?? "GET", headers, body, signal: init?.signal ?? undefined };
};

const toResponse = (reply: FakeReply): Response => {
  const status = reply.status ?? 200;
  const text = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
  const contentType = reply.contentType === undefined ? (reply.json === undefined ? null : "application/json") : reply.contentType;
  const headers = contentType === null ? undefined : { "content-type": contentType };
  const nullBody = status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : text, { status, headers });
};

export function stubFetch(responder: FetchResponder = () => ({ json: {} })): FetchStub {
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = toCall(input, init);
    calls.push(call);
    const reply = await responder(call);
    if (reply instanceof Error) throw reply;
    return toResponse(reply);
  });
  vi.stubGlobal("fetch", mock);
  return {
    fetch: mock,
    calls,
    last: () => {
      const call = calls[calls.length - 1];
      if (!call) throw new Error("fetch was not called");
      return call;
    },
    restore: () => vi.unstubAllGlobals(),
  };
}

export const json = (body: unknown, status = 200): FakeReply => ({ status, json: body });
