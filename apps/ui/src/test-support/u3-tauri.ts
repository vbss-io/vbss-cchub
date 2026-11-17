import { vi, type Mock } from "vitest";

type Handler = (args: Record<string, unknown>) => unknown;

export interface TauriFake {
  invoke: Mock<(command: string, args?: Record<string, unknown>) => Promise<unknown>>;
  handlers: Map<string, Handler>;
  on: (command: string, handler: Handler) => void;
  calls: (command: string) => Record<string, unknown>[];
  names: () => string[];
  emitEvent: (event: string, payload: unknown) => void;
  listenerCount: (event: string) => number;
  remove: () => void;
}

export interface MonitorFake {
  name?: string;
  scaleFactor: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
  workArea: { position: { x: number; y: number }; size: { width: number; height: number } };
}

interface TauriHost {
  __TAURI_INTERNALS__?: unknown;
  __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown;
}

const hostWindow = (): TauriHost => window as unknown as TauriHost;

export function installTauri(label: string): TauriFake {
  const handlers = new Map<string, Handler>();
  const callbacks = new Map<number, (event: unknown) => void>();
  const listeners = new Map<string, number[]>();
  let nextCallback = 1;
  let nextEvent = 1;
  const invoke = vi.fn(async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    if (command === "plugin:event|listen") {
      const event = String(args.event);
      listeners.set(event, [...(listeners.get(event) ?? []), Number(args.handler)]);
      const id = nextEvent;
      nextEvent += 1;
      return id;
    }
    const handler = handlers.get(command);
    return handler ? handler(args) : undefined;
  });
  const target = hostWindow();
  target.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (callback: (event: unknown) => void) => {
      const id = nextCallback;
      nextCallback += 1;
      callbacks.set(id, callback);
      return id;
    },
    convertFileSrc: (path: string) => path,
    metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
  };
  target.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
  return {
    invoke,
    handlers,
    on: (command, handler) => {
      handlers.set(command, handler);
    },
    calls: (command) => invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown>),
    names: () => invoke.mock.calls.map(([name]) => name),
    emitEvent: (event, payload) => {
      for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
    },
    listenerCount: (event) => listeners.get(event)?.length ?? 0,
    remove: () => {
      delete target.__TAURI_INTERNALS__;
      delete target.__TAURI_EVENT_PLUGIN_INTERNALS__;
    },
  };
}

export const removeTauri = (): void => {
  const target = hostWindow();
  delete target.__TAURI_INTERNALS__;
  delete target.__TAURI_EVENT_PLUGIN_INTERNALS__;
};
