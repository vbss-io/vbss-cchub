import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cancelTask, continueTask, getTask, getTaskEvents, type RunEventRecord, type TaskDetail } from "./delegation";
import {
  archiveTask,
  discardTaskWorktree,
  getTaskWorktree,
  mergeTaskWorktree,
  probeArchiveSupport,
  retryTask,
  taskIsolation,
  unarchiveTask,
  type WorktreeStatus,
} from "./delegation-actions";
import { createLatestGate } from "./request-gate";
import type { RunEventMessage } from "./types";

export type RetryMode = "autonomous" | "plain";

export interface LogLine {
  key: string;
  kind: RunEventRecord["kind"];
  text: string;
}

export interface TaskDetailState {
  detail: TaskDetail | null;
  worktree: WorktreeStatus | null;
  logLines: LogLine[];
  busy: boolean;
  archiveSupported: boolean;
  archive: () => void;
  unarchive: () => void;
  cancel: () => void;
  merge: () => void;
  discard: () => void;
  retry: (mode: RetryMode) => void;
  sendContinue: (prompt: string) => Promise<boolean>;
}

export function useArchiveSupport(): boolean {
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    void probeArchiveSupport().then(setSupported);
  }, []);
  return supported;
}

export const retryPermission = (mode: RetryMode) => (mode === "autonomous" ? "bypassPermissions" : null);

export function useTaskDetail(
  taskId: string,
  tick: number,
  subscribeRunEvents: (listener: (event: RunEventMessage) => void) => () => void,
  onRefresh: () => Promise<void>,
  onError: (text: string) => void,
): TaskDetailState {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [events, setEvents] = useState<RunEventRecord[]>([]);
  const [liveText, setLiveText] = useState<{ runId: string; lines: LogLine[] } | null>(null);
  const [worktree, setWorktree] = useState<WorktreeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const archiveSupported = useArchiveSupport();
  const gate = useRef(createLatestGate());

  const loadDetail = useCallback(async (id: string) => {
    const fresh = gate.current.begin(id);
    const [nextDetail, nextEvents] = await Promise.all([getTask(id), getTaskEvents(id)]);
    if (!fresh()) return;
    const nextWorktree = taskIsolation(nextDetail.task) === "worktree" ? await getTaskWorktree(id).catch(() => null) : null;
    if (!fresh()) return;
    setDetail(nextDetail);
    setEvents(nextEvents);
    setWorktree(nextWorktree);
    setLiveText(null);
  }, []);

  useEffect(() => {
    let mounted = true;
    loadDetail(taskId).catch((err: unknown) => {
      if (mounted) onError(err instanceof Error ? err.message : "failed to load task");
    });
    return () => {
      mounted = false;
    };
  }, [taskId, tick, loadDetail, onError]);

  useEffect(() => {
    gate.current.show(taskId);
    setDetail(null);
    setEvents([]);
    setLiveText(null);
    setWorktree(null);
  }, [taskId]);

  useEffect(() => {
    const current = gate.current;
    return () => current.close();
  }, []);

  useEffect(
    () =>
      subscribeRunEvents((event) => {
        if (event.taskId !== taskId) return;
        setLiveText((current) => {
          const lines = current && current.runId === event.runId ? [...current.lines] : [];
          const last = lines[lines.length - 1];
          if (event.kind === "text" && last && last.kind === "text") {
            lines[lines.length - 1] = { ...last, text: last.text + event.text };
          } else {
            lines.push({ key: `${event.runId}-${lines.length}`, kind: event.kind, text: event.text });
          }
          return { runId: event.runId, lines };
        });
      }),
    [taskId, subscribeRunEvents],
  );

  const lastRun = detail?.runs[detail.runs.length - 1] ?? null;
  const logLines = useMemo<LogLine[]>(() => {
    if (liveText && lastRun && liveText.runId === lastRun.id) return liveText.lines;
    if (!lastRun) return [];
    return events.filter((event) => event.runId === lastRun.id).map((event) => ({ key: String(event.id), kind: event.kind, text: event.text }));
  }, [liveText, events, lastRun]);

  const act = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      setBusy(true);
      try {
        await action();
        await onRefresh();
        await loadDetail(taskId);
        return true;
      } catch (err) {
        onError(err instanceof Error ? err.message : "action failed");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onRefresh, taskId, loadDetail, onError],
  );

  return {
    detail,
    worktree,
    logLines,
    busy,
    archiveSupported,
    archive: () => void act(async () => await archiveTask(taskId)),
    unarchive: () => void act(async () => await unarchiveTask(taskId)),
    cancel: () => void act(async () => void (await cancelTask(taskId))),
    merge: () => void act(async () => await mergeTaskWorktree(taskId)),
    discard: () => void act(async () => await discardTaskWorktree(taskId)),
    retry: (mode) => void act(async () => await retryTask(taskId, retryPermission(mode))),
    sendContinue: (prompt) => act(async () => void (await continueTask(taskId, { prompt }))),
  };
}
