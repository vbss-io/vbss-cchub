import type { Response } from "express";

const clients = new Set<Response>();

export function addClient(res: Response): void {
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

export const clientCount = (): number => clients.size;

type BroadcastListener = (event: string, data: unknown) => void;
const listeners = new Set<BroadcastListener>();

export function onBroadcast(listener: BroadcastListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function broadcast(event: string, data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
  for (const listener of listeners) listener(event, data);
}

setInterval(() => {
  for (const res of clients) res.write(`event: ping\ndata: {}\n\n`);
}, 25000).unref();
