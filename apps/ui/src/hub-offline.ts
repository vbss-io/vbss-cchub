export const OFFLINE_THRESHOLD_MS = 5000;

export interface OfflineState {
  since: number | null;
  streamDown: boolean;
  healthFailed: boolean;
  offline: boolean;
}

export type OfflineEvent =
  | { type: "stream-error"; at: number }
  | { type: "health-failed"; at: number }
  | { type: "stream-open"; at: number }
  | { type: "health-ok"; at: number }
  | { type: "tick"; at: number };

export const initialOfflineState: OfflineState = { since: null, streamDown: false, healthFailed: false, offline: false };

function withOffline(state: Omit<OfflineState, "offline">, at: number, thresholdMs: number): OfflineState {
  const offline = state.streamDown && state.healthFailed && state.since !== null && at - state.since >= thresholdMs;
  return { ...state, offline };
}

export function reduceOffline(state: OfflineState, event: OfflineEvent, thresholdMs = OFFLINE_THRESHOLD_MS): OfflineState {
  switch (event.type) {
    case "stream-open":
    case "health-ok":
      return initialOfflineState;
    case "stream-error":
      return withOffline({ ...state, streamDown: true, since: state.since ?? event.at }, event.at, thresholdMs);
    case "health-failed":
      return withOffline({ ...state, healthFailed: true, since: state.since ?? event.at }, event.at, thresholdMs);
    case "tick":
      return withOffline(state, event.at, thresholdMs);
  }
}

export function justRecovered(previous: OfflineState, next: OfflineState): boolean {
  return previous.offline && !next.offline;
}

export function isProbing(state: OfflineState): boolean {
  return state.streamDown;
}
