import { hubBase } from "./api";

export class HubRequestError extends Error {
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

export async function hubRequest<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${hubBase}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const json = parseBody(await res.text());
  if (!res.ok) {
    const message = (json as { error?: string } | null)?.error ?? `request failed (${res.status})`;
    throw new HubRequestError(message, res.status, json);
  }
  return json as T;
}

export const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message.length > 0 ? err.message : fallback);
