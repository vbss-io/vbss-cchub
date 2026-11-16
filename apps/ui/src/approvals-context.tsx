import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { decidePermission, fetchPermissions } from "./api";
import { approvalsOf, decisionBody, reduceApprovals, type ApprovalsState } from "./approvals-model";
import type { PermissionAgent, PermissionRequestRecord, PermissionRequestSummary, PermissionResolved } from "./types";

const TICK_MS = 1_000;

export interface ApprovalsHandlers {
  onPermissionRequest: (record: PermissionRequestSummary) => void;
  onPermissionResolved: (event: PermissionResolved) => void;
  reload: () => void;
}

export interface ApprovalsStore {
  list: ApprovalsState;
  handlers: ApprovalsHandlers;
  settle: (id: string) => void;
}

export function useApprovalsStore(): ApprovalsStore {
  const [list, dispatch] = useReducer(reduceApprovals, [] as ApprovalsState);
  const reload = useCallback(() => {
    void fetchPermissions()
      .then((next) => dispatch({ type: "replace", list: next }))
      .catch(() => undefined);
  }, []);
  const handlers = useMemo<ApprovalsHandlers>(
    () => ({
      onPermissionRequest: (record) => {
        dispatch({ type: "request", record });
        void fetchPermissions()
          .then((list) => dispatch({ type: "details", list }))
          .catch(() => undefined);
      },
      onPermissionResolved: (event) => dispatch({ type: "resolved", id: event.id }),
      reload,
    }),
    [reload],
  );
  const settle = useCallback((id: string) => dispatch({ type: "resolved", id }), []);
  const pending = list.length > 0;
  useEffect(() => {
    if (!pending) return;
    const id = window.setInterval(() => dispatch({ type: "prune", now: Date.now() }), TICK_MS);
    return () => window.clearInterval(id);
  }, [pending]);
  return { list, handlers, settle };
}

export interface ApprovalsValue {
  list: ApprovalsState;
  now: number;
  forSession: (agent: PermissionAgent, sessionId: string) => PermissionRequestRecord[];
  decide: (id: string, behavior: "allow" | "deny", reason: string) => Promise<void>;
}

const EMPTY: ApprovalsValue = { list: [], now: 0, forSession: () => [], decide: () => Promise.resolve() };

const ApprovalsContext = createContext<ApprovalsValue>(EMPTY);

export const useApprovals = (): ApprovalsValue => useContext(ApprovalsContext);

export function ApprovalsProvider({ store, children }: { store: ApprovalsStore; children: ReactNode }) {
  const { list, settle } = store;
  const [now, setNow] = useState(() => Date.now());
  const active = list.length > 0;
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, [active]);
  const decide = useCallback(
    async (id: string, behavior: "allow" | "deny", reason: string) => {
      await decidePermission(id, decisionBody(behavior, reason));
      settle(id);
    },
    [settle],
  );
  const value = useMemo<ApprovalsValue>(() => ({ list, now, forSession: (agent, sessionId) => approvalsOf(list, agent, sessionId), decide }), [list, now, decide]);
  return <ApprovalsContext.Provider value={value}>{children}</ApprovalsContext.Provider>;
}
