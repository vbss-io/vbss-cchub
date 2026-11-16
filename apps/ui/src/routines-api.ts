import { hubRequest } from "./hub-request";
import type { RoutineDetail, RoutineInput, RoutineRecord, RoutineRunEvent, RoutineRunRecord, RoutineSchedule, RoutineSettings, RoutinesInbox, RoutinesList } from "./types";

const root = "/delegation/routines";

export type RoutineStreamEvent = { kind: "routines" } | { kind: "routine-run"; run: RoutineRunEvent } | { kind: "routines-inbox"; unread: number };

export type RoutineSubscribe = (listener: (event: RoutineStreamEvent) => void) => () => void;

export const fetchRoutines = (): Promise<RoutinesList> => hubRequest("GET", root);

export const fetchRoutineDetail = (id: string): Promise<RoutineDetail> => hubRequest("GET", `${root}/${encodeURIComponent(id)}`);

export const createRoutine = (input: RoutineInput): Promise<RoutineRecord> => hubRequest("POST", root, input);

export const updateRoutine = (id: string, patch: Partial<RoutineInput>): Promise<RoutineRecord> => hubRequest("PATCH", `${root}/${encodeURIComponent(id)}`, patch);

export const setRoutineEnabled = (id: string, enabled: boolean): Promise<RoutineRecord> => updateRoutine(id, { enabled });

export const deleteRoutine = (id: string): Promise<{ ok: boolean }> => hubRequest("DELETE", `${root}/${encodeURIComponent(id)}`);

export const runRoutineNow = (id: string): Promise<RoutineRunRecord> => hubRequest("POST", `${root}/${encodeURIComponent(id)}/run`);

export const previewSchedule = (schedule: RoutineSchedule): Promise<{ next: number[] }> => hubRequest("POST", `${root}/schedule/preview`, { schedule });

export const fetchRoutineSettings = (): Promise<RoutineSettings> => hubRequest("GET", `${root}/settings`);

export const saveRoutineSettings = (settings: RoutineSettings): Promise<RoutineSettings> => hubRequest("PUT", `${root}/settings`, settings);

export const fetchInbox = (unreadOnly: boolean, limit = 50): Promise<RoutinesInbox> => hubRequest("GET", `${root}/inbox?${unreadOnly ? "unread=1&" : ""}limit=${limit}`);

export const fetchUnreadCount = async (): Promise<number> => (await fetchInbox(true, 1)).unread;

export const markInboxRead = (id: string): Promise<{ item: RoutineRunRecord; unread: number }> => hubRequest("POST", `${root}/inbox/${encodeURIComponent(id)}/read`);

export const markInboxUnread = (id: string): Promise<{ item: RoutineRunRecord; unread: number }> => hubRequest("POST", `${root}/inbox/${encodeURIComponent(id)}/unread`);

export const markInboxAllRead = (): Promise<{ changed: number; unread: number }> => hubRequest("POST", `${root}/inbox/read-all`);
