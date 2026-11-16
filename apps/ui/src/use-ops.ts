import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./hub-request";
import { mergeCostMaps } from "./cost-model";
import { fetchForecast, fetchHealthReport } from "./ops-api";
import { fetchTaskCosts } from "./review-api";
import type { CostTotals, HealthReport, LimitsForecast } from "./types";

const MAX_IDS = 500;

export function useTaskCosts(ids: readonly string[], refreshKey: number, enabled: boolean): Record<string, CostTotals> {
  const [costs, setCosts] = useState<Record<string, CostTotals>>({});
  const key = ids.slice(0, MAX_IDS).join(",");

  useEffect(() => {
    if (!enabled || key.length === 0) return;
    let alive = true;
    void fetchTaskCosts(key.split(","))
      .then((next) => {
        if (alive) setCosts((previous) => mergeCostMaps(previous, next));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [enabled, key, refreshKey]);

  return costs;
}

export function useLimitsForecast(enabled: boolean, refreshKey: number): LimitsForecast | null {
  const [forecast, setForecast] = useState<LimitsForecast | null>(null);

  useEffect(() => {
    if (!enabled) {
      setForecast(null);
      return;
    }
    let alive = true;
    void fetchForecast()
      .then((next) => {
        if (alive) setForecast(next);
      })
      .catch(() => {
        if (alive) setForecast(null);
      });
    return () => {
      alive = false;
    };
  }, [enabled, refreshKey]);

  return forecast;
}

export interface HealthState {
  report: HealthReport | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useHealth(enabled: boolean): HealthState {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = (seq.current += 1);
    setLoading(true);
    try {
      const next = await fetchHealthReport();
      if (mine !== seq.current) return;
      setReport(next);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(errorText(err, "Could not check the health of the hub."));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  return { report, error, loading, refresh };
}
