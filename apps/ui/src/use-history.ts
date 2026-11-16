import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { fetchHistoryStatus, searchHistory } from "./memory-api";
import { buildSearchQuery, canSearch, HISTORY_DEBOUNCE_MS, historyKey, historyReducer, INITIAL_HISTORY_STATE, nextOffset, type HistoryFilters, type HistoryState } from "./memory-model";
import type { HistoryIndexStatus } from "./types";

export interface HistorySearch {
  state: HistoryState;
  more: () => void;
}

interface Options {
  limit: number;
  enabled?: boolean;
  delay?: number;
}

export function useHistorySearch(filters: HistoryFilters, { limit, enabled = true, delay = HISTORY_DEBOUNCE_MS }: Options): HistorySearch {
  const [state, dispatch] = useReducer(historyReducer, INITIAL_HISTORY_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const controller = useRef<AbortController | null>(null);
  const key = historyKey(filters, limit);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const searchable = enabled && canSearch(filters.q);

  const run = useCallback(
    (runKey: string, offset: number) => {
      controller.current?.abort();
      const next = new AbortController();
      controller.current = next;
      const append = offset > 0;
      dispatch({ type: "start", key: runKey, append });
      searchHistory(buildSearchQuery(filtersRef.current, offset, limit), next.signal)
        .then((result) => dispatch({ type: "done", key: runKey, result, append }))
        .catch((err: unknown) => {
          if (next.signal.aborted) return;
          dispatch({ type: "fail", key: runKey, message: err instanceof Error ? err.message : "The search failed. Try again." });
        });
    },
    [limit],
  );

  useEffect(() => {
    if (!searchable) {
      controller.current?.abort();
      dispatch({ type: "reset" });
      return;
    }
    const timer = setTimeout(() => run(key, 0), delay);
    return () => clearTimeout(timer);
  }, [searchable, key, delay, run]);

  useEffect(() => () => controller.current?.abort(), []);

  const more = useCallback(() => {
    const current = stateRef.current;
    if (current.key === null || !current.hasMore || current.loadingMore) return;
    run(current.key, nextOffset(current));
  }, [run]);

  return { state, more };
}

export function useHistoryStatus(subscribe: (listener: (status: HistoryIndexStatus) => void) => () => void): HistoryIndexStatus | null {
  const [status, setStatus] = useState<HistoryIndexStatus | null>(null);
  useEffect(() => {
    let alive = true;
    fetchHistoryStatus()
      .then((value) => {
        if (alive) setStatus((previous) => previous ?? value);
      })
      .catch(() => undefined);
    const unsubscribe = subscribe((value) => {
      if (alive) setStatus(value);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [subscribe]);
  return status;
}
