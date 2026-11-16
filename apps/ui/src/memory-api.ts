import { hubBase } from "./api";
import type { DaySummary, DaySummaryWriteResult, HandoffPreview, HistoryIndexStatus, HistorySearchResult, MemorySettings } from "./types";

const base = `${hubBase}/delegation/memory`;

export class MemoryApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const parseBody = (text: string): unknown => {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const json = parseBody(await res.text());
  if (!res.ok) {
    const message = (json as { error?: string } | null)?.error ?? `request failed (${res.status})`;
    throw new MemoryApiError(message, res.status, json);
  }
  return json as T;
}

export const fetchHistoryStatus = (): Promise<HistoryIndexStatus> => request("GET", "/history/status");

export const searchHistory = (query: string, signal?: AbortSignal): Promise<HistorySearchResult> => request("GET", `/history/search?${query}`, undefined, signal);

export const runHistoryIndex = (): Promise<HistoryIndexStatus> => request("POST", "/history/run");

export const rebuildHistoryIndex = (): Promise<HistoryIndexStatus> => request("POST", "/history/rebuild");

export const clearHistoryIndex = (): Promise<HistoryIndexStatus> => request("DELETE", "/history");

export const fetchHandoffPreview = (workspace: string): Promise<HandoffPreview> => request("GET", `/handoff/preview?workspace=${encodeURIComponent(workspace)}`);

export const setHandoffWorkspace = (workspace: string, enabled: boolean): Promise<MemorySettings> =>
  request("PUT", `/handoff/workspaces/${encodeURIComponent(workspace)}`, { enabled });

export const fetchDaySummary = (date: string): Promise<DaySummary> => request("GET", `/day-summary?date=${encodeURIComponent(date)}`);

export const writeDaySummary = (date: string, digest: string, baseUpdatedAt: number | null, writeId: string): Promise<DaySummaryWriteResult> =>
  request("POST", "/day-summary/write", { date, digest, writeId, ...(baseUpdatedAt === null ? {} : { baseUpdatedAt }) });
