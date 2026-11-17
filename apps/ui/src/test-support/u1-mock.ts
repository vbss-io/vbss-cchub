export function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export interface Bus<T> {
  subscribe: (listener: (event: T) => void) => () => void;
  emit: (event: T) => void;
  listeners: () => number;
}

export function makeBus<T>(): Bus<T> {
  const set = new Set<(event: T) => void>();
  return {
    subscribe: (listener) => {
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    emit: (event) => {
      for (const listener of [...set]) listener(event);
    },
    listeners: () => set.size,
  };
}

export function installResizeObserver(): void {
  class StubObserver {
    observe(): void {
      return;
    }
    unobserve(): void {
      return;
    }
    disconnect(): void {
      return;
    }
  }
  Object.defineProperty(globalThis, "ResizeObserver", { value: StubObserver, configurable: true, writable: true });
}

export interface MediaController {
  setMatches: (matches: boolean) => void;
}

export function installMatchMedia(initial: boolean): MediaController {
  let matches = initial;
  const listeners = new Set<() => void>();
  const stub = (query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  });
  Object.defineProperty(window, "matchMedia", { value: stub, configurable: true, writable: true });
  return {
    setMatches: (next) => {
      matches = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
