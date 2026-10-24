import { useCallback, useEffect, useReducer, useRef } from "react";
import { probeHealth } from "./api";
import { initialOfflineState, isProbing, justRecovered, reduceOffline, type OfflineEvent, type OfflineState } from "./hub-offline";

const PROBE_INTERVAL_MS = 1500;

const reducer = (state: OfflineState, event: OfflineEvent): OfflineState => {
  const next = reduceOffline(state, event);
  const same = next.since === state.since && next.streamDown === state.streamDown && next.healthFailed === state.healthFailed && next.offline === state.offline;
  return same ? state : next;
};

export interface HubConnection {
  offline: boolean;
  streamError: () => void;
  streamOpen: () => void;
}

export function useHubConnection(onRecovered: () => void): HubConnection {
  const [state, dispatch] = useReducer(reducer, initialOfflineState);
  const previous = useRef(state);
  const recovered = useRef(onRecovered);

  useEffect(() => {
    recovered.current = onRecovered;
  }, [onRecovered]);

  useEffect(() => {
    if (justRecovered(previous.current, state)) recovered.current();
    previous.current = state;
  }, [state]);

  const probing = isProbing(state);

  useEffect(() => {
    if (!probing) return;
    let cancelled = false;
    const probe = () => {
      dispatch({ type: "tick", at: Date.now() });
      void probeHealth().then((ok) => {
        if (!cancelled) dispatch({ type: ok ? "health-ok" : "health-failed", at: Date.now() });
      });
    };
    probe();
    const id = window.setInterval(probe, PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [probing]);

  const streamError = useCallback(() => dispatch({ type: "stream-error", at: Date.now() }), []);
  const streamOpen = useCallback(() => dispatch({ type: "stream-open", at: Date.now() }), []);

  return { offline: state.offline, streamError, streamOpen };
}
