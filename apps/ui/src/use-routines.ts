import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./hub-request";
import { fetchInbox, fetchRoutineSettings, fetchRoutines, fetchUnreadCount, type RoutineSubscribe } from "./routines-api";
import type { RoutineRunRecord, RoutineSettings, RoutinesList } from "./types";

const COALESCE_MS = 150;

export interface RoutinesState {
  list: RoutinesList | null;
  inbox: RoutineRunRecord[];
  settings: RoutineSettings | null;
  error: string | null;
  loaded: boolean;
  reload: () => Promise<void>;
  setInbox: (items: RoutineRunRecord[]) => void;
  setSettings: (settings: RoutineSettings) => void;
}

export function useRoutines(subscribe: RoutineSubscribe, enabled: boolean): RoutinesState {
  const [list, setList] = useState<RoutinesList | null>(null);
  const [inbox, setInbox] = useState<RoutineRunRecord[]>([]);
  const [settings, setSettings] = useState<RoutineSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = (seq.current += 1);
    try {
      const [nextList, nextInbox, nextSettings] = await Promise.all([fetchRoutines(), fetchInbox(false, 50), fetchRoutineSettings()]);
      if (mine !== seq.current) return;
      setList(nextList);
      setInbox(nextInbox.items);
      setSettings(nextSettings);
      setError(null);
      setLoaded(true);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(errorText(err, "Could not load the routines."));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void reload();
      }, COALESCE_MS);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled, subscribe, reload]);

  return { list, inbox, settings, error, loaded, reload, setInbox, setSettings };
}

export function useRoutineUnread(subscribe: RoutineSubscribe, enabled: boolean): number {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setUnread(0);
      return;
    }
    let alive = true;
    const refresh = () => {
      void fetchUnreadCount()
        .then((count) => {
          if (alive) setUnread(count);
        })
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = subscribe((event) => {
      if (event.kind === "routines-inbox") setUnread(event.unread);
      else refresh();
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [enabled, subscribe]);

  return unread;
}
