export interface SubtaskQueueHandlers {
  send: (id: string, planned: boolean) => Promise<void>;
  onFailed: (id: string, error: unknown) => void;
  onDrained: () => void;
}

export interface SubtaskQueue {
  request: (id: string, planned: boolean, current: boolean) => void;
}

interface Entry {
  desired: boolean;
  known: boolean;
}

export function createSubtaskQueue(handlers: SubtaskQueueHandlers, settleMs: number): SubtaskQueue {
  const entries = new Map<string, Entry>();
  const order: string[] = [];
  let flying: string | null = null;
  let active = false;
  let attempted = false;

  const run = async (): Promise<void> => {
    for (let id = order.shift(); id !== undefined; id = order.shift()) {
      const entry = entries.get(id) as Entry;
      const planned = entry.desired;
      flying = id;
      attempted = true;
      try {
        await handlers.send(id, planned);
        entry.known = planned;
        if (entry.desired !== planned) order.push(id);
      } catch (err) {
        entry.desired = entry.known;
        handlers.onFailed(id, err);
      }
      flying = null;
    }
    entries.clear();
    active = false;
    const drained = attempted;
    attempted = false;
    if (drained) handlers.onDrained();
  };

  const request = (id: string, planned: boolean, current: boolean): void => {
    const entry = entries.get(id) ?? { desired: current, known: current };
    entries.set(id, entry);
    entry.desired = planned;
    const at = order.indexOf(id);
    if (entry.desired === entry.known) {
      if (at >= 0) order.splice(at, 1);
    } else if (at < 0 && flying !== id) {
      order.push(id);
    }
    if (!active && order.length > 0) {
      active = true;
      setTimeout(() => void run(), settleMs);
    }
  };

  return { request };
}
