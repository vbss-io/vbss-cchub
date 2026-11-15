export interface TurnOnIntent {
  open: () => void;
  revert: () => void;
}

export type TurnOnResult<T> = { ok: true; value: T } | { ok: false; message: string };

export async function turnOnOptimistically<T>(intent: TurnOnIntent, request: () => Promise<T>): Promise<TurnOnResult<T>> {
  intent.open();
  try {
    return { ok: true, value: await request() };
  } catch (err) {
    intent.revert();
    return { ok: false, message: err instanceof Error ? err.message : "could not turn the widget on" };
  }
}
